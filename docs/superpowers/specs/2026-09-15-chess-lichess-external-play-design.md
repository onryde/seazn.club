# Chess external play (Lichess) — design

Date: 2026-09-15 (revised 2026-09-16)
Status: revised after PR #788 review — for owner review
Approach: fixture bridge (Seazn owns the competition; Lichess is the board)

## 0. Revision note (2026-09-16)

The first build minted a **direct** Lichess challenge only after both players
clicked Ready in a Seazn lobby, because a direct realtime challenge expires
20 seconds after creation. Review of PR #788 found that design produced most of
the blockers: an accepted game lost when the lobby cleared an "expired"
challenge, a Lichess HTTP call inside a DB transaction, a lobby realtime token
that opened the paid score channel, and player OAuth tokens stored in plaintext.

Owner decision 2026-09-16: use a Lichess **open challenge restricted to the two
players**, created when the play window opens. The Ready lobby, the 20-second
countdown, the lobby realtime channel and stored player tokens are removed.

## 1. Problem

Chess competitions in Seazn already pair fixtures, assign colours, and fold
win/draw/loss into standings via the `boardgame` module. Players who enrol need
somewhere to play online. Seazn should put both players on the right Lichess
board at the right time and write the finished result back into the normal
scoring pipeline.

## 2. Goals (v1)

- Organiser runs an **online Lichess** chess division; Seazn pairings and
  standings stay authoritative.
- Players **link a Lichess account** on their profile; enrollment into an
  online-Lichess division **requires** that link.
- At **T−15** Seazn emails both players a **Seazn fixture link** saying when the
  board opens. The email never contains a Lichess URL.
- The **play window opens at T−10**. From then until the **deadline (T+20)** the
  Seazn fixture page shows each signed-in player **their own** Play link. Before
  T−10 the Lichess challenge does not exist, so the game cannot be played early.
  At the deadline Lichess itself expires the challenge.
- When Lichess reports the game started → fixture becomes live in Seazn.
- When Lichess reports a clean finish → Seazn appends the normal boardgame
  `result` score event.
- Messy outcomes (no-show, abort, mismatch) → organiser **needs-result** queue.
  No invented auto-forfeit.
- Chess.com is a later adapter behind the same interface; not built in v1.

## 3. Non-goals (v1)

- Chess.com adapter
- Team chess / multi-board ties; KO mini-match chains driven by Lichess
- In-Seazn clock UI (clock is Lichess's job)
- Auto-forfeit without organiser confirmation
- Rated Lichess games; delay/Bronstein clocks
- PGN as scoring authority
- Any change to OTB / pad / manual chess scoring when online play is off
- Configurable window/deadline per division (constants in v1)

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
4. The game is created when the second of the two players joins.
5. Lichess OAuth is authorization-code **with PKCE (S256)**, public client, no
   client secret; tokens are long-lived and have no refresh.
6. A direct challenge (`POST /api/challenge/{username}`) expires after 20s — the
   reason it is not used.

## 5. End-to-end flow

1. Player links Lichess on the Seazn profile (OAuth PKCE). Seazn reads
   `/api/account`, stores Lichess id + username, then revokes the token.
2. Enrollment into an online-Lichess division fails without a link.
3. Organiser sets the division **online play = Lichess**. Saving requires a
   boardgame clock with `base` and no `delay`.
4. Seazn pairs the round as today (Swiss, colours; home = White).
5. **T−15** (cron): email each player once — Seazn fixture URL + "board opens at
   HH:MM".
6. **T−10 → T+20**: the challenge is minted by whichever comes first — a matched
   player opening the fixture page, or the cron. `users = whiteUsername,
   blackUsername`, `expiresAt = T+20`, `rated = false`, `rules = noRematch`.
   Exactly one challenge is kept per fixture (§8.2).
7. The fixture page shows the signed-in White player `urlWhite` and the Black
   player `urlBlack`. Spectators and other users see status only. The page
   re-reads status every 15s while the window is open.
8. Lichess game starts (cron poll, or the signed workflow poke) → fixture `live`,
   `core.start` appended.
9. Clean finish → boardgame `result` through the existing score-event usecase →
   standings.
10. Deadline passes with no started game, abort, account mismatch →
    `needs_organiser`.

## 6. Architecture

```
[Profile OAuth PKCE] ─► lichess id + username on user (no token kept)
[Division cfg]       ─► onlinePlay: lichess | off   (+ clock required)
[Pairing]            ─► fixtures (unchanged)
[Cron T−15]          ─► email Seazn fixture link, once per player
[Page open | Cron]   ─► window open? claim row ─► adapter.createOpenChallenge
                        (HTTP outside any transaction) ─► store urls, status ready
[Cron poll | poke]   ─► adapter.fetchGame(challengeId) ─► live / finished /
                        needs_organiser ─► scoreEvent(result)
[Organiser queue]    ─► manual result / reschedule (resets bridge to pending)
```

Every entry point (page read, mint, cron sweeps, poke, resolve) goes through one
guard, `loadOnlinePlayFixture`, which requires: division `onlinePlay = lichess`,
sport `boardgame`, fixture has `scheduled_at` and both entrants, fixture not
finished or void. Anything else is refused (page: no panel; API: 404/409; cron:
skipped).

## 7. Data model

Migrations V405–V407 are unmerged, so they are **amended**, not corrected
forward: V405 is rewritten, V406 is folded into it, V407 is deleted.

### 7.1 `user_external_accounts`

`id, user_id, provider ('lichess'), external_user_id, username, created_at,
updated_at`; unique `(user_id, provider)` and `(provider, external_user_id)`.
**No token columns.** Relink replaces the row.

### 7.2 `fixture_external_play`

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
| `last_error`, `needs_reason` | Diagnostics / queue reason |
| `started_at` / `finished_at` | From Lichess |

The bridge row is created lazily by the first guarded entry point.

## 8. Behaviour

### 8.1 Time constants

`EMAIL_LEAD = 15 min`, `WINDOW_OPEN_LEAD = 10 min`, `DEADLINE_AFTER = 20 min`,
all relative to `fixtures.scheduled_at`, defined once and imported by code and
tests.

### 8.2 Mint (no transaction around HTTP)

1. Guard passes; `now ∈ [T−10, T+20)`; both players linked.
2. Claim: `update … set mint_claimed_at = now() where fixture_id = $1 and
   status = 'pending' and challenge_id is null and (mint_claimed_at is null or
   mint_claimed_at < now() − 30s) returning`. No row → someone else is minting
   or already minted; return current view.
3. Call Lichess (request timeout 10s).
4. Success: `update … set status='ready', challenge_id, url_white, url_black,
   white/black_lichess_id, expires_at, mint_claimed_at = null where fixture_id =
   $1 and status = 'pending'`. Failure: clear `mint_claimed_at`, record
   `last_error`; next page read or cron retries.

A started game never re-mints: mint requires `status = 'pending'`.

### 8.3 Poll / poke

- Cron selects `status in ('ready','live')` guarded rows, ordered by
  `last_polled_at nulls first`, limit 50, and stamps `last_polled_at` on every
  row it looks at, whatever the outcome.
- Started is decided from the **Lichess game status** (exists and not
  `created`), not from Seazn's score-event sequence.
- Every status write is conditional on the expected prior status (`ready → live`,
  `live → finished`, `ready|live → needs_organiser`).
- Result mapping: Lichess player ids must equal the stored
  `white/black_lichess_id`, else `needs_organiser (mismatch)`. White → home.
- Result is appended through the existing score-event usecase. If the fixture
  already has a result, the provider result is ignored.
- Provenance: `challenge_id` + `finished_at` on the bridge row identify the
  Lichess game behind the result.
- The workflow poke (`POST /api/webhooks/lichess`, HMAC `x-lichess-signature`)
  only triggers a poll of the named fixture; it never carries a result.

### 8.4 Deadline

At/after `expires_at`, a `pending` or `ready` row gets one final poll; if no game
started → `needs_organiser (no_show)`. `live` rows are never escalated by the
deadline.

### 8.5 Leaving `needs_organiser`

- Organiser enters a result (existing path) → `finished`.
- Organiser reschedules the fixture → bridge reset to `pending` (challenge,
  urls, identities, email stamps, claim and reason cleared).

## 9. Jobs & notifications

| When | Action |
|---|---|
| now ≥ T−15, player not yet emailed | Email that player the Seazn fixture URL and window time; stamp that player only |
| now ≥ T−10, `pending` | Mint (§8.2) if no page open did it first |
| `ready` / `live` | Poll (§8.3) |
| now ≥ T+20, not started | `needs_organiser (no_show)` |

Cron `POST /api/cron/external-play` (`x-cron-secret`) runs every 5 minutes from
the scheduled-workflow repo. Page-open minting makes the window exact to the
second regardless of cron cadence.

## 10. Scoring integration

- Existing score-event usecase only; no parallel standings writer.
- First result wins; late provider results ignored.
- Organiser void/correct uses existing undo/void.

## 11. UI surfaces

- **Profile:** link / unlink Lichess.
- **Enrollment:** block with a link CTA when the division is online-Lichess and
  the user has no link.
- **Division settings:** online play Off / Lichess; Lichess requires a clock
  without delay.
- **Fixture page (players):** one panel with states — *Opens at HH:MM* (before
  T−10), *Play as White/Black on Lichess* (window open), *Game in progress*,
  *Finished*, *Waiting for organiser*, *Window closed*. At least two layout
  options are shown to the owner before building; verified at 320 / 768 / 1280.
- **Organiser:** needs-result queue with reason; manual result; resend email.
- No realtime channel for this feature.

All strings in en/es/fr/nl; email interpolations HTML-escaped.

## 12. Failure matrix

| Case | Behaviour |
|---|---|
| Unlinked at enrollment | Block |
| Division online play on, no clock / delay clock | Settings save refused |
| Page opened before T−10 | "Opens at HH:MM"; no challenge exists |
| Two mints at once | One claim wins; the other returns the stored view |
| Lichess create fails / times out | Stay `pending`, `last_error`; retried on next read/cron |
| One player joins, other never does | Challenge expires at T+20 → `needs_organiser (no_show)` |
| Game started, cron slow | Stays `ready` until polled; never re-minted |
| Clean finish | Auto `result` |
| Abort / unfinished at deadline | `needs_organiser` |
| Account mismatch | `needs_organiser (mismatch)` |
| Result already present | Ignore provider |
| Online play turned off mid-round | Guard refuses; no further mint/poll |
| Fixture rescheduled | Bridge reset to `pending` |
| Lichess outage mid-game | Stays `live` until poll recovers or organiser acts |

## 13. Testing

- **Unit:** clock mapping (units: Lichess wants seconds — pin against the
  boardgame schema's declared unit); window maths at T−10/T+20 boundaries;
  adapter request body (`users` order = White first, `expiresAt`, `rated=false`);
  PKCE parameters and verifier round-trip; email escaping. Each guard mutated
  and killed.
- **DB usecase:** concurrent mint keeps one challenge; online play off refuses
  every entry point; `live` never re-mints; poll stamps skipped rows (no
  starvation); result through the real score-event usecase; deadline escalation;
  reschedule reset.
- **E2E walkthrough:** drive the real fixture page — hidden before window, own
  colour link only for the signed-in player, spectator sees none; organiser
  queue resolve. Registered in `WALKTHROUGH_SPECS`.
- **Smoke:** cron sweep path with a recorded Lichess payload.
- **Regression:** online play off — pairings + manual/pad result unchanged;
  division settings page renders and saves for a non-chess sport.
- **CI:** recorded Lichess payloads only; no live network.

## 14. Open follow-ups (not v1)

- Chess.com adapter
- Per-division window / deadline
- Rated games option; delay clock mapping
- Bulk pairing (`pairAt` / `startClocksAt`) as an option for clubs wanting
  auto-started clocks — needs stored player tokens and `challenge:bulk`
- PGN attach via `core.note`

## 15. Success criteria

- A paired fixture in an online-Lichess division gets a playable Lichess game
  with no organiser action, playable only between T−10 and T+20.
- The only way to the Play link is the Seazn fixture page, per player.
- A decisive Lichess finish appears in standings without manual entry.
- No-shows and aborts land in the organiser queue and never corrupt the table.
- Turning online play off leaves today's chess behaviour intact.
