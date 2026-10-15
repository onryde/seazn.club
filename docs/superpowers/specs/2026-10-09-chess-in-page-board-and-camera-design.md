# Chess: in-page board and camera — design

**Date:** 2026-10-09
**Status:** awaiting owner review
**Supersedes:** `2026-09-15-chess-lichess-external-play-design.md` (the "players leave for
lichess.org" shape). That document's Tasks 1–8 are built and largely survive; its
venue, transport and result-detection sections are replaced wholesale by this one.
**Branch:** `feat/chess-lichess-external-play`, worktree
`.claude/worktrees/chess-lichess-external-play`, rebased onto main `8afdd8b42`.

---

## 0. What changed and why

The old product was a lobby: both players check in, we create a Lichess challenge, the
players leave for lichess.org, and we poll the game export for a result.

The new product is a venue. **The match is played on our page** — a chessground board
beside the player's own camera tile — with moves submitted through the Lichess Board API
using each player's own OAuth token. Lichess remains the authority on legality, clocks
and results. It stops being the place the game happens.

Owner decisions taken 2026-10-09, in order:

| # | Decision |
|---|---|
| D1 | Ship 1 is board **and** camera together, not board first |
| D2 | Camera is **mandatory**, pulling preflight, policy, arbiter and penalties into scope |
| D3 | The old "leave for lichess.org" mode is **deleted**. One venue |
| D4 | Two boards: Chess Quest keeps its own; live play uses **chessground**, GPL-3.0 accepted |
| D5 | Camera policy is the **org's** choice per division/stage: `Off` / `Optional` / `Required` |
| D6 | **One camera** per player is enough for ship 1; model it as N participants |
| D7 | Players do **not** see each other. Each sees only their own tile. Since 2026-10-14 this is enforced by **one meeting per player** (§5.6), not by the client |
| D8 | Deterrent only — no mandatory observer; an arbiter **may** be assigned when available |
| D9 | Policy changes after a round opens are **downgrade-only, with an audit row** |
| D10 | Camera failure mid-game = **flag; the organiser decides**. The board never freezes |
| D11 | RealtimeKit outage under `Required` = **organiser override with an audit row** |
| D12 | **Pairing is automatic; inviting is not.** Swiss pairs the next round by itself once the previous round is complete. The organiser then opens the round, which sends the invites and starts the window. The schedule is the time shown to players, not the trigger |

---

## 1. Global constraints

- Lichess is the authority on legality, clocks and results. We never adjudicate chess.
- Our board is the only **supported** venue. We cannot technically prevent the same
  accounts playing on lichess.org, so out-of-band play is **detected, not blocked**.
- No long-lived connection to Lichess anywhere. No always-on service.
- Every user-facing string ships in en/es/fr/nl. This surface is **not** under
  `apps/web/src/games/**`, so the games English-only exemption does not apply to it.
- Full mobile bar: 320, 768, 1280, no horizontal page scroll. No exemption.
- Colour is **read from the pairing**, never assigned here. W3 owns colour allocation.
- Names resolve through `entrantDisplayName`, never raw entrant text.
- Unrated games only.
- chessground stays **isolated and unmodified** — its own chunk, loaded as a library,
  with a thin wrapper of ours above it. See §9.

---

## 2. Measured facts

Everything in this section was measured against live lichess.org on 2026-10-09, not
inferred. The raw logs are committed beside this spec at
`docs/superpowers/specs/evidence/2026-10-09-chess-spikes/` — `flag-spike.log`,
`spike-battery2.log`, `tc-boundary.log`, `b3-spike.log`, plus `spike-battery-v1-invalid.log`, which is
kept deliberately: its run was wrecked by two bugs of mine (a logging function writing to
stdout inside a command substitution, and an illegal stalemate FEN that put the side not
to move in check), and the 429 wall it hit is the evidence for M3.
Each line that follows is a design input; several contradict the brainstorming document.

| # | Fact | Evidence |
|---|---|---|
| M1 | **Lichess ends a game on time with no client connected.** Game `PbxONnd6`: poll at 10:02:05Z `status=started`; poll at 10:02:21Z `status=outoftime winner=black`, after white's 180s expired ~10:02:15Z, with no stream open | flag spike |
| M2 | **Caveat on M1:** this cannot distinguish "Lichess auto-flags" from "our export read finalises it". The flag appeared on the first poll after expiry, consistent with both. The spec therefore says *a read settles the flag*, never *Lichess pushes it to us* | flag spike |
| M3 | **Challenge creation is limited to 5 per minute per challenger**, plus 500 per 10 minutes per IP. Corrected 2026-10-09 by the Task 3-5 review: the v1 log shows FIVE creates in ~4s (four section-A challenges and game B) before the first `{"error":"Too many requests. Try again later."}`, and lila's `Limiters.scala:61-71` / `Challenge.scala:298-309` state both limits. The earlier wording here ("four creates in ~1s", "roughly four a second") misread the log as a burst rate | battery v1 + lila source |
| M4 | **Moves are not rate-limited** at speed — 8 back-to-back posts, all 200 | battery v2 §F |
| M5 | **A malformed UCI is played, not rejected.** `move e7e6xx` → `200 {"ok":true}`, export `moves=e4 e6`. Lichess truncated the suffix | battery v2 §D |
| M6 | **Out-of-turn and game-over share one error:** `400 {"error":"Not your turn, or game already over"}` | battery v2 §D |
| M7 | **Promotion works plainly:** `e7e8q` → 200, export `e8=Q` | battery v2 §B |
| M8 | **Stalemate** → `status=stalemate winner=None` | battery v2 §C |
| M9 | **An early resign is an abort.** Resigning after one move gave `status=aborted winner=None`; after two moves, `status=resign winner=black` | battery v2 §B, §D |
| M10 | **A pending draw offer is invisible in the export.** Full body dumped while an offer stood: no draw-offer field, `status` still `started` | battery v2 §E |
| M11 | **The export carries authoritative clocks:** `"clocks":[60000,60000]` centiseconds plus `"clock":{initial,increment,totalTime}` | battery v2 §E |
| M12 | **The Board API refuses play on fast clocks, but the challenge is accepted at creation.** 0+1 and 1+0 created fine, then every move `400 {"error":"This game cannot be played with the Board API."}` | battery v2 §A |
| M13 | **The cutoff is blitz or slower.** 120+1 (est 160s) → `speed=bullet` → refused; 180+0 (est 180s) → `speed=blitz` → played. Estimated duration = `limit + 40 × increment`. Two points tested, not the whole curve | tc-boundary |
| M14 | **`clock.limit` is an enumerated set, not a free integer.** 170+0 and 140+1 were refused at creation with `{"clock.limit":["Invalid value"]}` | tc-boundary |
| M15 | `claim-victory` is for an opponent who **left**, not for flagging: "Claim victory when the opponent has left the game for a while". The board stream carries an `opponentGone` event | Lichess OpenAPI |
| M16 | **The game export STALLS mid-game; it does not trail by a fixed lag.** Live 10+5 game `Cq2oQ5C7`, player-authenticated `/game/export` read after each ply: plies 1–8 returned 1, 2, 3, 4, 5, 5, 5, 5 moves, and still 5 a further 5s after ply 8. The Board API stream (`gameFull` `state.moves`) was exact at every ply (1–8). The unauthenticated export read errored at every probe. So the export is **never mid-game truth**: moves come from our ledger plus the board stream, and the export is trusted only for a terminal status | b3-spike (1) |
| M17 | **Per-challenger creation limit confirmed live (M3):** seven rapid creates, each cancelled — five `200`, then `429 {"error":"Too many requests. Try again later."}` on the sixth and seventh, all within ~2s (18:01:45Z–18:01:47Z) | b3-spike (2) |
| M18 | **10+0 and 15+0 are playable through the Board API:** each was created (`t2NsZaZR`, `a03eINh0`) and a move by each side returned `200`. Basis for adding both to the ship-1 list (§3.7) | b3-spike (3) |

Premises from the brainstorming document that these falsify or qualify:
- §6 "never poll, keep one connection per game" — **reversed**. See §4.
- §10 "Board API excludes the fastest time controls" — **true for play, false for
  creation** (M12). The dangerous half is that creation succeeds.
- §11's implied promotion support in chessground — chessground ships **no** promotion UI.

---

## 3. Architecture

Seven components. Nothing long-lived.

### 3.1 Link
Lichess OAuth (PKCE, built) now requests **`board:play` + `challenge:write` +
`challenge:read`** instead of no scopes. `challenge:read` exists for one reason: after a
crash between Lichess creating White's challenge and our commit, recovery lists White's
outgoing challenges before deciding whether to re-create (Task 9, I2) — without it that
lookup is a measured 403 and every such recovery would park on the organiser. The token is **stored encrypted at rest**, reusing the sealed-secret pattern
the device link uses (V417), and revoked on unlink.

This reverses the earlier identity-only decision, which revoked the token immediately
after reading the account. Players already linked under that flow get a **re-consent
screen** before their first online fixture. The copy states plainly that the scope lets
us submit moves in their games — including games that are not ours.

### 3.2 Round lifecycle, window and seat

**Pairing happens by itself; opening does not** (D12). Once the previous round is
complete, Swiss pairs the next round and the fixtures exist — unopened and uninvited.
Nothing is sent. **The organiser then opens the round**, and that action stamps
`round_opened_at`, sends every pairing's invite, and starts the window.

The split matters: pairing is a computation and can be trusted to a scheduler, but an
invite starts a clock against real people who have to be at a screen. The organiser is
the only one who knows the room is ready. A Swiss round almost never begins exactly when
the timetable said, and a system that opens windows on a stale schedule marks people
no-shows for a round that had not started.

**T−10 and T+20 are therefore relative to `round_opened_at`**, not to the fixture's
scheduled time. The scheduled time is what players are *shown*; it is not the trigger.
A fixture with no `round_opened_at` is not yet playable and says so.

Check-in stamps the fixture. Under policy `Required`, the seat is granted only after
camera preflight passes (§5).

**Round N+1 cannot be paired until Round N's results are all in** — which is why the
abandoned-board sweep in §3.5 matters operationally, not just tidily. One unresolved
board blocks the next round.

### 3.3 Creation
Claim-then-call, already built: claim the mint with a conditional UPDATE, call Lichess
outside any transaction, then conditionally record. One claimant per fixture.

- **White's token challenges Black's username; Black's token accepts.** Colour comes
  from the pairing. This removes the `urlWhite`/`urlBlack` hand-off entirely.
- Creation respects Lichess's two real limits (M3). **Per challenger, 5 creates per
  minute** — and since White's token creates the challenge, a round asks each White for
  ONE create, so a normal round never approaches it; it bites only on retries for the
  same player. **Per IP, 500 creates per 10 minutes** — every create leaves our servers,
  so this is the true ceiling on how many boards can start together. A 429 waits out a
  full window (at least 60s), never a short ladder that cannot outlast it.
- The time control comes from a **curated list verified playable** (§3.7).
- The fixture records `pending` before the HTTP call, and a unique index on the challenge
  id makes a double-create impossible.

### 3.4 Play loop
1. The client posts an intended move to our server — never to Lichess.
2. The server **validates the UCI strictly** against `^[a-h][1-8][a-h][1-8][qrbn]?$`
   (M5 — a malformed string is not rejected by Lichess, it moves a piece), checks that
   it is that player's turn and that the caller is that player, and submits it with that
   player's token.
3. On acceptance the server records the move and broadcasts position, last move and
   clocks to both players and to spectators over the realtime channel we already own.

We submit both sides, so we own the move stream without asking Lichess for it.

### 3.5 Reconcile
One **board-stream read** — open `GET /api/board/game/stream/{id}` with a player's token,
take the first line (`gameFull`: `state.moves`, `wtime`, `btime`, `status`, `winner`), close —
on exactly five triggers:
- a rejected move (M6 — the message covers two states, so reconcile, never assume);
- a local clock reaching zero;
- game end;
- an organiser pressing resync;
- **the cron sweep**, for a live game past its expected end.

The fifth exists because the other four all require a client to be open. If both
players close their tabs mid-game the game stays live on Lichess, flags eventually, and
nobody reads the result — the fixture would sit unresolved forever. The sweep is what
closes a game nobody is watching.

The read returns moves, status, winner **and authoritative clocks**, so every reconcile
corrects our locally-derived clocks instead of letting them drift to the flag. It is the
board stream and **not the export** because the export STALLS mid-game (M16): measured, it
froze at 5 plies while the game went on to 8, and so cannot be mid-game truth for moves,
clocks or status. The board stream's `gameFull` line was exact at every ply.

The export is a **fallback for a terminal status only** — used when neither player's
token can be opened (`LICHESS_TOKEN_UNAVAILABLE`), and trusted only when it reports a
status other than `created`/`started`. M11's export clocks are not used.

Measured by Task 11 (2026-10-11, `__fixtures__/lichess/README.md`): a board-stream read,
like the export read in M2, makes Lichess finalise a flag on an expired clock — visible on
the NEXT read. A read ~3.5 min after the last move returned `started` with White's clock
at 0; the read 3 s later returned `outoftime`. So the local-clock-zero trigger retries the
read once after **3 s** (`FLAG_REREAD_MS`) before concluding the game is still live.
(Ruling 2026-10-09; the measured 3 s replaces the 2 s guessed before the measurement.)

### 3.6 Result
Terminal status maps to our events, written **under organiser authority**
(`mintOrgOwnerAuth`), because W2a makes `core.forfeit`, `core.settle` and `core.abandon`
organiser-only.

| Lichess | Our outcome |
|---|---|
| `mate`, `resign`, `outoftime` | decided result, winner as reported |
| `draw`, `stalemate` | draw. In a knockout it is **held, never written as decided** — see the note below |
| `aborted` | no result. Note M9: an early resign lands here with no winner |
| no-show at T+20 | `core.forfeit {by, reason: "walkover"}` |
| both absent | `core.forfeit {by: "both", reason: "walkover"}`; refused `DOUBLE_WALKOVER_NO_NEXT_MATCH` on a final, last rung or third-place match, where the fixture stays open for the organiser |

A Lichess **timeout is a normal win, not a forfeit**. Only a no-show is a forfeit.

**How a knockout draw is held, today.** `needs_decision` and a division phase `tiebreak`
do **not exist** in this repo — `DIVISION_PHASES` is `setting_up | scheduled | match_day
| finished` (`apps/web/src/lib/division-phase.ts:26`), verified 2026-10-09. They are
W2a/W2b's future work, not ours to invent. Until they land, a knockout draw is held as
`fixture_external_play.needs_organiser` with the reason `tiebreak_owed`. The invariant
is what matters and it holds either way: **a drawn game is never written as decided.**

**A token revoked or rejected mid-match** is not a no-show and must not be recorded as
one. It produces a distinct reason value and sends the fixture to the organiser queue.

**T+20 is the deadline to be seated and have the game created** — not a cap on the game.
Once a game exists it runs on its own clock, past the window if it must. Nothing in our
system ends a live game early.

**Out-of-band play with no camera** — moves advancing while the policy is `Required` and
no live publisher is present is logged as a fair-play flag for the organiser. It is
never an automatic sanction.

### 3.7 Time controls
The organiser picks from a curated list, validated at **tournament setup** — creation
succeeding proves nothing about playability (M12). Permitted entries must satisfy both
`limit + 40 × increment ≥ 180` (M13) and a `clock.limit` value Lichess accepts (M14).
Ship-1 list: **3+0, 3+2, 5+0, 5+3, 10+0, 10+5, 15+0, 15+10** (10+0 and 15+0 added by owner
ruling 2026-10-09; both measured playable, `b3-spike`). Each is verified by the test in §8.

---

## 4. Transport: why there is no streaming service

The brainstorming document specified one long-lived NDJSON connection per live game. That
is removed. Our server submits both players' moves, so the only things a stream would
tell us that our own writes do not are: a flag, a Lichess-declared terminal state, and a
move made out of band. Each has a cheaper answer — M1 for the flag, the end-of-game
reconcile for terminal states, and a rejected submission for out-of-band play.

The 5-minute cron stays what it is and does not become a live service, but it is NOT
optional. Under D12 the invite is sent by the organiser's own action, so the cron owns
four jobs, every one of which happens when no page is open: the T+20 no-show, the mint
retry for a creation that hit the 429 wall, meeting teardown when nobody came, and the
reconcile sweep for a live game nobody is watching.

**Known blind spot, accepted:** a draw offer made on lichess.org is invisible to us
(M10). Offers made on our page are fine — our server sends them, so our server
broadcasts them.

**Known cost, accepted:** with us as the only mover, our downtime stops play. Deleting
the lichess.org mode did not delete the escape hatch, because the game is a real Lichess
game: `lichess.org/<gameId>` works with no code from us. The break-glass is a runbook
line — the organiser tells both players to finish there, and our reconcile records the
result when we return. It is not a second mode to build or test.

---

## 5. Camera

### 5.1 Policy
`Off` / `Optional` / `Required`, set per division/stage, defaulting from the competition,
`Off` for all existing data.

- `Off` — no meeting is created. Zero video spend.
- `Optional` — tile shown if the player grants camera; never blocks a seat.
- `Required` — preflight gates the seat.

**Changes after the first check-in window opens are downgrade-only and write an audit
row** (D9). Otherwise an org could flip `Required`→`Off` to erase a flag, or
`Off`→`Required` at T−5 and strand the field.

### 5.2 Preflight is server-verified
A player is seated only when the meeting itself reports a **live video publisher** for
that participant. The POC gated check-in on a client-sent `cameraOk` boolean; that is
forgeable and is on the do-not-copy list (§10).

Consequence: the meeting is created when the **first** player arrives in the window, not
after both check in, because preflight needs something to join. Torn down at the result,
or at T+20 if nobody comes. *(Amended 2026-10-14, §5.6: each player's OWN meeting is created
when that player arrives; both are torn down together.)*

**What RealtimeKit can and cannot prove (measured 2026-10-09 against Cloudflare's live
OpenAPI spec).** There is **no synchronous per-participant publishing signal**: the
meeting, participant, active-session and webhook surfaces give joined/left and a count,
never media state. `videoEnabled` exists only in the client SDK, which is the forgeable
surface this section rejects. So the **preflight gate** proves exactly two things — the
participant joined a live session and has not left — and **camera-on is enforced by the
preset**, which is why presets are env-pinned with no defaults and why a RealtimeKit
outage must THROW rather than read as "camera off".

**But there IS video evidence, after the fact.**
`GET /accounts/{account_id}/realtime/kit/{app_id}/sessions/peer-report/{peer_id}`
("participant details ... along with call statistics") carries per-sample
`video_producer` stats (`frames_encoded`, `frames_per_second`, `bytes_sent`, a timestamp)
and `metadata.events` (`video_on`, `video_off`, `disconnect`, `media_permission`). These
are **SDK telemetry**: encoder-side numbers the RealtimeKit client uploads. They are
harder to fake than the POC's `cameraOk` boolean, because a forger has to keep a real
encoder running, but they are not an independent server observation. That is enough for
a deterrent product with no mandatory observer, and no more.

**Measured 2026-10-09** (`evidence/…/rtk-peer-report.log`, one participant, synthetic
camera, 4 min on / 3 min off / 2 min on):
- **Not live** (superseded by the 2026-10-14 amendment below, which measured it live on stg).
  During the session the report stayed frozen at its join snapshot for all nine minutes: one
  sample, `duration` 0, and no `video_off` event even 2.5 minutes into the camera being off.
  It cannot be an in-match signal.
- **Final about 70 s after the player leaves:** 51 samples at a ~7 s cadence, `left_at`,
  `duration`, and every event.
- **Camera-off shows as a GAP, not as `no_video_fraction`.** The three minutes off were a
  189 s gap in `video_producer` timestamps, exactly matching the off phase, with
  `video_off`/`video_on` events at its edges. `video_producer_cumulative.issues.no_video_fraction`
  stayed **0**: it measures a publishing-but-blank feed, not a camera turned off.

So the organiser's camera evidence is **video-off coverage**: gaps longer than 3× the
sample cadence over `[joined_at, left_at]`, cross-checked against the `video_off`/`video_on`
events. It is fetched once, at least 2 minutes after the player leaves or the match ends,
retrying until `left_at` is set and `duration` > 0. It is never `no_video_fraction` alone,
never an input to the seat gate, and never automatic.

**Amended 2026-10-14 (T17B fix 2, measured live on stg).** Two readings above were wrong.
The preset does **not** enforce camera-on: a player whose browser DENIED the camera joined
on the player preset, was seated, and a game was created. And the peer report is **not**
frozen during a session: `media_permission` was on it 1.4 s after PEER_JOINING, while the
`video_producer` samples arrived late and in batches (none in 90 s from a peer publishing
6 MB). So the seat now reads the player's **current peer's** report — the latest
PEER_JOINING with no PEER_LEAVING — and seats only on `media_permission{VIDEO, ACCEPTED}`
with the latest `video_on`/`video_off` being `video_on`; a denial is `camera_blocked`, and
no evidence yet is `camera_starting` (the room re-asks on a 1, 2, 4, 8 s back-off, D21, with
the server answering the claims in between from a cache; the server waits 15 s from the
peer's join, then refuses). Samples are never required.
**Residual, accepted:** the report is client-uploaded SDK telemetry, so a tampered client
could forge it; this closes the honest-browser gap, not a determined forger.

**Amended 2026-10-15 (D21 and D21-fix-3: the seat inside the vendor's call budget).** Four
rules change what the gate spends and how a claim that the budget cut short recovers: the first
two live in `preflight.ts`, the stranded-board arm in `sweep.ts`, and the optional camera's retry
in `room.ts` (the route) and `use-room.ts` (the timer). None of them changes what the gate proves. Find each by its symbol.
- **Cache first, token last.** A claim asks the evidence cache (`judgeSeat`,
  `claimEvidenceRead`) before it spends anything, and refreshes the participant's token only
  when its answer must carry one. A `camera_starting` answer to a browser that sent the
  participant it already holds (`heldParticipantId`) carries no token; a seat, a refused
  camera, and an answer to a browser that holds none do carry one. The id is a hint about
  what to save, never an authority: it is compared with the caller's own participant on file,
  so naming another one changes nothing for the caller. The minting claim carries the token
  it minted and reads nothing.
- **The game creation step (T9) trusts a recent pass.** Before it creates the game,
  `createGameIfReady` asks the seat again for both players (`recheck`). Nobody joins with that
  answer, so no token is minted or refreshed for it, and a pass read ON within
  `SEAT_RECHECK_TRUST_MS` (10 s) stands without a vendor call, provided no later read has
  left a not-yet verdict outstanding (`seat_reads = 0`). The cost, accepted: a camera that
  goes dark inside those 10 s is seated into a game it should not have started. The sweep's
  camera evidence catches it afterwards from the peer reports (`camera_lost`, a flag the
  organiser decides on), exactly as it catches a camera that goes dark one second after the
  game is created, which no re-verify can prevent. That evidence is judged over the match,
  which starts at the first move, so a camera that is dark only before the first move is not
  judged, here or anywhere.
- **A stranded board is created by the sweep.** A re-verify the budget cannot afford answers
  "not ready" and writes nothing: no `last_error`, no claim. Both players are then seated and
  no game exists, and a seated player never claims again. The mint-retry job has a second arm
  for exactly that board (`retryCandidates` and `mintRetry` in `sweep.ts`): pending, no error
  on file, no live claim, both check-ins counted, the later one at least
  `STRANDED_CREATE_AFTER_MS` (10 s) old. It creates the game on its next pass, so the recovery
  is bounded by the five-minute cadence, not immediate. Two creates racing are safe: the claim
  is one conditional statement and the loser is told it lost.
- **An optional camera asks again for its token** (owner decision, 2026-10-15: an Optional
  player the budget deferred gets the tile later, without a reload). Under `optional`, a
  player whose meeting, participant or token the budget deferred is seated with no tile, and
  the seat answer says so explicitly (`cameraRetry: true`). The room then asks the camera route,
  `POST /fixtures/{id}/external-play/room/camera` (`requestRoomCamera` in `room.ts`, which
  calls `cameraTokenForSeat` in `preflight.ts`), on a 2, 4, 8 and 16 second back-off and then
  every 30 seconds, until it holds a token, the policy leaves `optional`, or the game is over
  (`cameraRetryDue`). The route answers the token and nothing else: it stamps no check-in,
  publishes no lobby and asks for no game, because those belong to the seat claim. It judges
  the seat by the seat's own rules (`seatPlayer`), so a stranger, a closed window and an
  abandoned board are refused, and a refusal is final. The server says whether to ask again
  (`retry`); the room never infers it from a missing token. Only an `optional` camera that met
  a budget deferral ever retries. `off` has no camera, the D11 override is the way round a
  vendor that may be broken, a vendor outage is final (every tab retrying would hammer a
  vendor that is down), and `required` has its own door, since its camera refusals carry the
  token. A per-seat rate limit on this route and on the seat claim is owed by the D22 review
  (its I2) and is built before D16's code; this section does not give its number.

### 5.3 What each person sees
- **A player sees their own tile only** (D7). Local preview; no subscription to the
  opponent. Since 2026-10-14 the opponent is not in the player's meeting at all (§5.6).
- A **presence pill** shows "opponent camera: live / off / unknown" — compliance without a
  face. Since 2026-10-14 it is the opponent's own client's report, relayed by our server with
  no vendor call (§5.6.3); "unknown" is what it says when that report has gone quiet.
- An **arbiter**, when assigned, joins receive-only and sees the players' tiles for a
  chosen fixture, plus that fixture's flags. Since 2026-10-14 that is two meetings, one per
  player, shown ONE AT A TIME with a switch between them (§5.6.4).
- Mic muted by default. Chess needs no audio.

Rationale for D7: chess events are full of under-18s, and showing a child's face to a
stranger they were paired with is a safeguarding problem that self-view avoids.

### 5.4 Honesty of the copy
There is no mandatory observer (D8). Player-facing copy must therefore say **"your
camera may be reviewed by an organiser"** — never "you are being monitored", which would
be a false statement inside a consent flow on an unstaffed round. Registration states the
camera requirement **before** signup, not at T−10.

### 5.5 Failure
Camera loss mid-game never freezes the board — Lichess clocks cannot pause. We log it
with timestamps, flip the presence pill, and surface it on the run sheet. **The organiser
decides the consequence** (D10).

If RealtimeKit is unavailable under `Required`, the organiser may **override and proceed
without video, writing an audit row** (D11). A video vendor outage must not cancel a
tournament.

The audit row (`online_chess_audit`: who overrode, when, and their note) is a **staff record
read by SQL only**; no screen shows it (ruling, final review M-8, 2026-10-14).

### 5.6 One meeting per player (amended 2026-10-14, owner ruling "1 per-player", T17B fix 2 D16; revised after the 10-14 review and the 10-15 re-reviews 1 and 2)

**This replaces the shared meeting.** Each board now has TWO RealtimeKit meetings, one per
player. A player's meeting holds that player and, when one is watching, an arbiter. Nobody
else. The opponent is never a participant in it.

**Why. D7 was enforced only by the client, and a client can be tampered with.**
- The player preset carries no receive or subscribe permission at all. RealtimeKit presets
  gate what a participant may PRODUCE (video ALLOWED, audio and screenshare NOT_ALLOWED on
  the stg "player" preset), not what it may receive.
- `max_video_streams` (0/0 on that preset) is documented by Cloudflare as the number of
  streams "visible on a device", which makes it a UI limit, not a permission.
- The SDK does not honour 0 either (measured on 2.0.2, 2026-10-12). Its active-peer
  selection keeps one remote peer subscribed at cap 0, which is why the room needed MANUAL
  view mode plus a watchdog that unsubscribes every kind (video, screenshare, audio).
- That watchdog runs in the player's own browser. In a shared meeting, a player who disables
  it, or calls `subscribe` from the console, very likely receives the opponent's camera.
  Chess events are full of under-18s (§5.3's rationale), so "the honest client does not
  look" is not a safeguarding guarantee.
- In a per-player meeting there is no opponent stream to subscribe to. The guarantee then
  holds on the vendor's side, whatever the client does. The client watchdog stays as
  defence in depth: arbiters publish nothing, but it costs nothing.

#### 5.6.1 The one rule every statement follows

**A meeting is `(fixture_id, side)`.** The side is the player's ENTRANT side, `home` or
`away` (the fixture's seat). It is fixed for a pairing. The colour is not: it is read from
the ledger (home unless a `boardgame.pairing` card records Black on home, `whiteSideOf`), so
an organiser's card can swap it after a player has arrived. Nothing reads a meeting by
colour; the colour only LABELS (`arbiter.ts:283-286` and `:539-542` map white/black from
`whiteSide` for the label alone).

- Every fixture-keyed reference in a statement on `fixture_video_meetings`,
  `fixture_video_participants` and `fixture_video_guard_faults` names the side (the one
  exemption is stated next), and every `RETURNING` consumer iterates over its rows. No
  `const [row]` / `[m]` / `gone[0]` destructuring on a meeting query.
- One kind of REFERENCE names the side without saying it: a reference to
  `fixture_video_participants` keyed by `participant_id`. Those are the seat gate's evidence
  stamp and its V446 read cache (`judgeSeat`'s `last_publisher_seen_at` update, and
  `claimEvidenceRead`, `recordEvidence` and `cachedEvidence`, all in `preflight.ts`; the
  `seat_read_*` columns). The vendor issues a participant id inside exactly one meeting, and
  `unique (fixture_id, participant_id)` (V439) already says so, so the id identifies the
  participant row. Those columns stay per participant and do not change.
- **That exemption stops at the participant row.** A statement keyed by `participant_id` that
  also joins `fixture_video_meetings` or `fixture_video_guard_faults` is not exempt for that
  join: the id picks the participant row and says nothing about which of the fixture's two
  meeting rows the join lands on. Two statements do exactly this today: `leaveAsArbiter`'s
  lookup (its join to the meeting is on `fixture_id` alone) and `reportCameraFault`'s
  ownership check (the same join). With two rows per fixture each returns two rows per
  participant, and the `const [row]` after it takes either one. Each such join carries
  `side` in its own `on` (the participant row gains `side`, so the join is on
  `(fixture_id, side)`).
- **A source-guard test** walks the server tree and judges each TABLE REFERENCE that reaches
  `fixture_video_meetings`, `fixture_video_participants` or `fixture_video_guard_faults` by
  `fixture_id` (a `from`, `join`, `update`, `insert into` or `delete from` naming one of
  them), not each statement. A reference passes when its own predicate or `on` names `side`,
  or names `participant_id` (a participants reference only). A key elsewhere in the same
  statement does not count for it. Rows reached some other way, by a meeting's unique
  `meeting_id` or a participant row's own primary key (the arbiter revoke's `where id = …`),
  are not fixture-keyed reads and are not counted. It reports how many references it checked
  and how many passed on each key. Zero checked is a failure, and so is zero passed on either
  key: a guard that has stopped seeing one kind of reference has gone vacuous on it.
  A reference that means BOTH sides on purpose does not name one, so the test lists each such
  statement with its reason, and a listed entry that no longer matches a statement fails.
  Today's are `fixturesSeating` (`seated.ts`: a player seated on either side), the stale-meeting
  deletes in `openRound` and `retireStaleMeeting` (both rows go), and `endRoomAtResult` (ends
  every unended row, each in its own try).

**Schema** (a new delta after V446, D21's call-budget delta; numbered at the time):
- `fixture_video_meetings` gains `side text not null check (side in ('home','away'))`. Its
  key becomes `(fixture_id, side)`; `meeting_id` stays unique.
- `fixture_video_participants` and `fixture_video_guard_faults` gain `side` and reference
  `(fixture_id, side)` instead of `fixture_id`.
- The pairing stamp (`home_entrant_id`/`away_entrant_id`, R2-2) stays on each row, and each
  row is judged by BOTH entrants, in order, exactly as today (m1). A re-pair therefore
  retires BOTH rows, the stayer's included. The stayer's meeting held no opponent, so this
  is not about a leak; it keeps R2-2 and R3-1 working unchanged.
- `camera_evidence_at` stays per row, and V442's check (evidence requires `ended_at`)
  stays per row.
- New on the player participant row: `camera_reported text null check (camera_reported in
  ('live','off'))` and `camera_reported_at timestamptz null`, for the pill (§5.6.3).
- **The vendor title carries the side**: `seazn-fixture-<fixtureId>-<side>`
  (`realtimekit.ts:385` today builds `seazn-fixture-${fixtureId}`), so the two rooms of one
  board can be told apart in the vendor's dashboard and logs. It still names no person. The
  privacy test that pins the title (`online-chess-privacy.test.tsx:74-79`, "created with a
  title alone, and no recording API is called") changes to the new literal in the same
  commit; what it guards, title only and no recording, is unchanged.
- Greenfield (RULES.md): the delta drops the existing shared-meeting rows, which cascade.
  It does not try to split them, and nothing is backfilled. See §5.6.7 for the deploy step
  that must run BEFORE the drop, and for the guard the delta carries itself.

#### 5.6.2 The call sites, each once (the review's I1, re-pinned on 6faa729c0)

Find each site by its symbol. The line numbers below are at `6faa729c0` and are only a hint:
D20, D21 and D21-fix-3 (the sweep work, the call budget, and the seat's token and re-verify
changes) have moved them twice since the first pin (`124ff0b0f`, then `66102c507`), most of
all in `preflight.ts`, `room.ts` and `sweep.ts`. The build re-pins each site before it edits
it.

| Site | Today | Per side |
|---|---|---|
| `realtimekit.ts:361` `ensureMeeting(fixtureId)` | creates THE meeting | `ensureMeeting(fixtureId, side)`: creates that side's meeting on that player's first arrival; the vendor title carries the side (§5.6.1) |
| `realtimekit.ts:316-325` `meetingOnFile` | one row by fixture | by `(fixture_id, side)` |
| `realtimekit.ts:393-420` the insert (`on conflict (fixture_id)`) and the lost-race re-read | one row per fixture | `on conflict (fixture_id, side)`; the re-read is by side too |
| `realtimekit.ts:333-351` `retireStaleMeeting` | ends `gone[0]` only (`:341`) | iterates: ends every retired row at the vendor |
| `realtimekit.ts:721-743` `endMeeting` | stamps `removed_at` on every arbiter row of the FIXTURE | stamps only the arbiter rows of ITS `(fixture_id, side)` |
| `preflight.ts` `seatPlayer`'s optional branch (`:223`) and `verifyRequiredSeat` (`:334`) → `ensureMeeting` | the board's meeting | the CALLER's side (`player.side`, from `loadSides` at `:173-174`) |
| `preflight.ts` `playerParticipant`'s R2-2 locked mint check (`:535-548`, the `in (…)` at `:544`). D21-fix-3 moved it here from `issuePlayerToken`, which now only wraps it (`:560-563`) | `em.entrant_id in (home, away)`, any side | pinned to the row's OWN side (§5.6.5, the review's I3) |
| `preflight.ts` `judgeSeat`'s evidence stamp `last_publisher_seen_at` (`:420-423`); `claimEvidenceRead`, `recordEvidence` and `cachedEvidence`, the V446 seat-read cache (`:448-502`) | by participant id | unchanged (a participant id is one meeting's; §5.6.1) |
| `preflight.ts` `storedPlayerParticipant` (`:575-585`), and `room.ts` `ownParticipantId` in `compose` (`:432`) | by fixture + person | by `(fixture_id, side)` + person |
| `preflight.ts` `cameraTokenForSeat` (`:277-285`), called by `room.ts` `requestRoomCamera` (`:584-587`) behind `POST …/room/camera` (D21-fix-3, §5.2) | the optional camera's token door; it reaches the meeting only through `seatPlayer` | unchanged in shape. It takes the caller's side from `seatPlayer` and has no statement of its own to key; a test drives it once per side |
| `create-game.ts` the two `seatPlayer(… recheck: true)` calls (`:220-223`) | re-verify each player against the board's meeting | each player against their OWN side's meeting, through `seatPlayer`. A player with no participant on file answers `camera_required` and nothing is minted |
| `sweep.ts` `retryCandidates` arm 2 and `mintRetry` (`:547-614`; the stranded board, §5.2) | reads no video table | unchanged. The create it calls reaches both meetings through the row above |
| `room.ts` `opponentParticipant` (`:296-306`) → the pill's `opponentPresence` in `compose` (`:421-429`) | names the opponent's participant in the shared meeting | REMOVED: the snapshot carries `opponentCamera` (§5.6.3) |
| `room.ts` `reportCameraFault` (`:677-707`; its select `:685-690`, joined to the meeting on `fixture_id` alone at `:688`) | joins by fixture | the caller's own `(fixture_id, side)`; the join carries `side` (§5.6.1) |
| the new `camera-report` usecase (§5.6.3), and the snapshot's read of it | does not exist | stamps the caller's `storedPlayerParticipant` row, and reads the opponent's the same way, both by `(fixture_id, side)` + person |
| `room-end.ts:28-48` `endRoomAtResult` | `const [room]` (`:30`): ends ONE meeting | ends every unended row of the fixture, each in its own try |
| `open-round.ts:348-358,379-385` stale-meeting delete on a fresh window / D17 re-arm; the vendor ends at `:405-419` | deletes by fixture | unchanged as a delete (both rows go), but the vendor ends iterate every returned row |
| `seated.ts:45-47` `fixturesSeating` | any player participant on the fixture | unchanged (keyed by person, true on either side) |
| `guard-faults.ts:34-79` | keyed `(fixture_id, person_id)` | `(fixture_id, side, person_id)` |
| `sweep.ts` `teardownCandidates` (`:638-650`) | per row | unchanged: already per row, so each side is retried on its own |
| `sweep.ts` `cameraCandidates` (`:963-980`) | per row | per row = per `(fixture, side)` (§5.6.6) |
| `sweep.ts` `readCameraEvidence`'s player lookup (`:998-1010`) | both sides' players over ONE meeting | only THIS row's side's player (§5.6.6) |
| `sweep.ts` `settleCamera` (`:1092-1111`; the stamp at `:1094-1097`) | stamps `where fixture_id` (both rows) | stamps `(fixture_id, side)` |
| `sweep.ts` `arbiterCandidates` (`:1227-1240`) | joins meetings by fixture (2 × 2 rows) | joins `(fixture_id, side)` |
| `sweep.ts` `arbiterRevoke` (`:1249-1257`) | may remove from the WRONG meeting | removes from its own row's meeting |
| `arbiter.ts:237-259` `boardRows` | `left join … on m.fixture_id = f.id` (`:253`): lists each board TWICE | a per-board aggregate (§5.6.4) |
| `arbiter.ts:346-351` `cameraReport`; `:324` and `:390` `flagView` → `cameraMatchWindow` | read the board's one `evidenceAt` and `meetingEndedAt` | follow the aggregate's rules (§5.6.4): no vacuous "settled", and a flag's window is its own player's row |
| `arbiter.ts:486-537` `joinAsArbiter` → `ensureMeeting` (`:524`) | creates the meeting if missing | joins only an EXISTING side's meeting and names the side in its request; an arbiter never creates one (§5.6.4) |
| `arbiter.ts:539-557` the players query and the `white` / `black` lists | both players' participant ids, by fixture and person | the joined side's players only, as one list; the response shape changes (§5.6.4) |
| `arbiter.ts:563-594` `mintArbiter` + its rollback (`:576-592`) | one meeting | one `(fixture_id, side)` per mint |
| `arbiter.ts:607-644` `leaveAsArbiter` (its join at `:616-622`, on `fixture_id` alone at `:620`) | the join can pick the other meeting's id, then 404 → stamped removed while still live | joins `(fixture_id, side)`; the source guard (§5.6.1) fails on the old join |

`lib/arbiter-view.ts`, `match-window.ts` and `match-camera-off.ts` only NAME the tables in
comments. `match-window.ts`'s `meetingEndedAt` is a single value: correct per meeting once the
sweep's candidate is `(fixture, side)`, and correct in the panel only once the panel hands it
the flagged player's own row (§5.6.4).

#### 5.6.3 The opponent's presence pill: the opponent's own report, relayed (the review's C1)

**The source.** The pill ("opponent camera: live / off / unknown") can no longer be read from
the player's own meeting: the opponent is not in it. It is NOT read from the vendor either:
- RealtimeKit's REST API makes no server-side observation of whether a participant is
  publishing. The nearest thing is the peer report's `video_on` / `video_off` events (§5.2 as
  amended 2026-10-14: the report does accumulate during a session, and the seat gate reads
  those events). But they are SDK telemetry that the opponent's browser uploads, in batches.
  A vendor read would be the opponent's browser's word too, no more truthful than the report
  we relay ourselves, and it would cost calls.
- Per room poll, that read would cost 50 boards × 2 viewers × 20 polls × 3 calls ≈ 6,000
  calls per 5 minutes against the account's GLOBAL 1,200. Past that, every call is refused
  for 5 minutes, seat gates included, for every club. (D21's call budget now holds this
  process to 900 per 5 minutes and defers the rest, so the price of such a read would be
  seats deferred instead, which is no better.)

So the pill comes from the opponent's OWN client, which already knows its camera state
(`useOwnCamera`; `CameraStatus` has seven values, and "The client" below maps each). The heartbeat that carries it belongs
to D16, built together with its one consumer, this pill; no seam ships without a consumer.

**The route.** A new `POST /fixtures/{id}/external-play/room/camera-report`, beside
`camera-fault`, with the body `{ state: "live" | "off", heartbeat: boolean }`.
- **Identity** is `camera-fault`'s: the caller must be one of the board's two players, and
  the row stamped is the caller's `storedPlayerParticipant` on their own side, in a meeting
  still open (`storedPlayerParticipant` in `preflight.ts`, `:575-585`). That function is the
  one rule for which participant is a person's, and it matters here: `(fixture_id,
  person_id)` is deliberately not unique (V439), so the stamp and the snapshot's read of the
  same row must go through it. Anything else is the room's one 404. The server stamps `camera_reported` and `camera_reported_at` on
  that row, on the server's clock.
- **A change writes; a heartbeat mostly refreshes.** A report with `heartbeat: false` always
  writes its state and pings the opponent's room (rate-limited per seat, as `camera-fault`
  does). A report with `heartbeat: true` is judged against the stored row, in four cases:
  - it names the state already stored: it refreshes `camera_reported_at` and pings nobody;
  - nothing is stored yet: it writes the state and the stamp, and pings nobody;
  - it names a different state and the stored row is still fresh (younger than
    `CAMERA_REPORT_STALE_MS`): it is ignored, and the stamp is untouched. That is what makes a
    reordered pair harmless: a `live` heartbeat that was in flight when the camera went off
    lands after the `off` change, finds a row the change has just made fresh, and is dropped,
    so a stale "live" cannot be stranded;
  - it names a different state and the stored row is no longer fresh: it is applied as a change
    is. "No longer fresh" is the pill's own test for "unknown", one definition for both. Without
    this case, when the tab that made the deciding change closes, the surviving tab's
    heartbeats would be ignored for ever, the stored state would go stale at 75 s, and the pill
    would read "unknown" until the camera next changed.
- **Its own rate limit.** `CAMERA_FAULT_PING_LIMIT` (`rate-limit.ts:142`) throttles the
  lobby ping only. The route gets its own, `CAMERA_REPORT_LIMIT`: 12 a minute per fixture and
  person (a tab sends about two a minute, and a flapping camera a burst of changes), fail-open
  like its neighbours so a Redis blip never blanks the pill. Past it the answer is 429, and the
  client drops a heartbeat (the next comes in 30 s) or retries a change after its wait.
- **Registered where its neighbours are**: `NEVER_KEY_ROUTES` in `key-scopes.ts` (beside the
  `camera-fault` entry, `:364`, which D21-fix-3's `room/camera` entry at `:365` also sits
  beside), so no API key reaches it, and `openapi.ts` (the `camera-fault` entry at `:213` is
  the pattern).

**The client.** A tab reports its camera's CURRENT state on every change, and again every
`CAMERA_REPORT_HEARTBEAT_MS` (30 s) in BOTH states, so a camera that stays off stays fresh
exactly as one that stays live does.
- All reports go through one serial queue, one request at a time, of the shape the stamp
  queue has (`camera-session.ts`, the "Delivering a stamp" header and `:90-112`): a failed
  change is sent again after a wait and then dropped.
- A report is a change until the server has acknowledged that state, and a heartbeat after.
  A lost change is therefore resent as a change; leaving it to the heartbeat would not
  deliver it in time, because a heartbeat flips a stored state only once the row is no longer
  fresh (the last case above), by which time the pill already reads "unknown".
- `CameraStatus` (`camera-session.ts:46`) maps: `live` → `live`; `off`, `failed` and
  `gave_up` → `off`; `joining`, `recovering` and `idle` send nothing, because they are
  transitions, and `recovering` is OUR guard's re-join, which is never the player's "off".
- **Two tabs of one player** share one row: the most recent CHANGE from either tab decides
  what is stored, and while the row is fresh the other tab's heartbeats agree with it or are
  ignored, so the pill does not flap between two tabs. The price is that a player with one tab
  live and another off reads as whichever changed last. When the tab that made the deciding
  change closes, its heartbeats stop: the row goes stale 75 s after its last one, the pill
  reads "unknown", and the surviving tab's next heartbeat (at most 30 s later) is applied. So
  the pill shows the closed tab's last state for up to 75 s after the close, which is wrong
  while the surviving tab disagrees, and "unknown" for at most one heartbeat after that. That
  is accepted for a pill that only informs; an "any tab live wins" rule would need a row per
  tab.

**The snapshot.** `opponentPresence: { participantId } | null` (`room-snapshot.ts:143`)
becomes `opponentCamera: "live" | "off" | "unknown" | null`.
- **`null` (no pill) keeps every condition the pill has today**, in the order of the
  `opponentPresence` expression in `room.ts`'s `compose` (`:421-429`) and ahead of the new
  reading: the camera policy is `off`; an organiser has let the
  board play without video (D11); the game is over; the viewer cannot act (`!canAct`: no
  playable game, a frozen seat, a linked account that is not the game's); the opponent has no
  person on file; and OUR guard holds an open fault on the opponent's seat (our re-join, never
  their "off"). All of these stay; a build that rewrites the expression owes a test per
  condition (§5.6.8).
- Past those conditions:
  - `"live"`: the opponent's stored report is `live` and younger than
    `CAMERA_REPORT_STALE_MS` (75 s, two and a half heartbeats);
  - `"off"`: it is `off` and fresh;
  - `"unknown"`: there is no fresh report. That means none yet, a stale one (a closed or
    crashed browser, a lost connection, a report path that is failing), or no participant row
    for the opponent on file.
- **A stale report is "unknown", never hidden and never "off".** Hiding it would read as
  "the policy is off", and "off" would claim a fact we do not have. One signal is lost and the
  loss is accepted: in a shared meeting an opponent who had left the meeting read "camera off"
  (`opponent-presence.ts:25-26`); now a vanished opponent browser reads "unknown". The pill
  draws it neutrally (not the green of live, not the colour of off), under a new copy key,
  `externalPlay.room.presence.unknown` ("{name} · camera status unknown"), in all four
  locales, with `data-state="unknown"`.
- Staleness is judged on the server when the snapshot is composed; the room's own poll (15 s
  when idle, `use-room.ts` `IDLE_POLL_MS`) carries it, so a vanished browser reads "unknown"
  within 75 s plus one poll.
- The client's `opponent-presence.ts` and `useOpponentPresence` (`use-own-camera.ts:79-99`)
  are rewritten to read `opponentCamera`, and the 1 s local presence tick
  (`PRESENCE_TICK_MS`, `opponent-presence.ts:15`) goes away; `presence-pill.tsx` gains its
  third state. Openapi follows.

**The budget.** Zero vendor calls: the route writes one row. On our side that is one
single-row update per player per 30 s, plus one per change, and the room's existing reads.
Because it makes no RealtimeKit call it spends nothing from the platform's call budget
(§5.6.8).

**Review I8 — its rule is KEPT, its mechanism is replaced.** "A room read never calls the
vendor" still holds. What changes is where the answer comes from: the opponent's own
report, not this client's view of a shared meeting.

**What the pill is not.** It is the opponent's browser's word, so a tampered client could
send `live` with no camera, and a closed one sends nothing. The pill only informs the
player. **Nothing else reads it**: not the seat gate (§5.2), not `camera_lost`, not the
evidence read, the teardown or any flag. Those stay on vendor-side sources: the seat gate's
peer-report evidence before play, the arbiter's live view, and the sweep's peer-report
evidence after the match (`camera_lost`). A client-claimed signal is exactly what §5.2 and
§10 reject as a safeguard. A **source-guard test** pins it: `camera_reported` and
`camera_reported_at` are named in exactly two files, the report's usecase (which writes them)
and `usecases/external-play/room.ts` (whose snapshot composer reads them). Its scope is every
non-test `.ts` and `.tsx` file under `apps/web/src`, except generated files and the OpenAPI
document with the files that build it (they describe the wire, not the column); the migration
deltas live under `db/`, outside the tree it walks. The two allowed files are named in the
test. It reports how many files it scanned, and zero is a failure. It also checks that each
of the two allowed files really names one of the columns, so a rename that leaves the
allow-list pointing at files that no longer hold them cannot pass by finding nothing.

#### 5.6.4 The arbiter: one player's camera at a time (the review's C2)

**The SDK supports one meeting per page.** RealtimeKit 2.0.2 keeps a module-level context
registry (`dist/index.es.js:5377`, `const qr = new AC()`) with a `mostRecentPeerId`, and its
own comment (`:5367-5372`) says multiple ongoing meetings per page are not supported and "a
lot more components will fail" if tried. READ, not run: in 2.0.2 the registry keys contexts
per peer, `mostRecentPeerId` is used only to route a `ClientError` to the latest meeting's
`onError` (`:5508`), and a reconnect sets the `tracing-id` header on the client
`vt()` returns (`:24422`). What else fails is unmeasured.

**Not measured here.** Two meetings in one page cannot be measured in this worktree. A join
needs the live vendor: there is no RealtimeKit API token locally, and the SDK refuses the
fixture server's token offline, so no local join happens at all, fake camera or not.

**OWNER RULING (2026-10-14): (b), one pane at a time, with a white/black switch. Shape (a),
iframe-both, is DROPPED** — not deferred, and no stg measurement is owed for it.

**Ship shape: (b), one pane at a time.**
- The panel joins ONE of the board's two meetings, labelled by player (name and colour), with
  a two-way switch to the other. A switch leaves one meeting, then joins the other, and the
  leave is awaited (below).
- Trade-off: the arbiter sees one player at a time, never both at the same instant.
- A pairing card can swap the colours after a player has arrived. The meeting is the SIDE's,
  so the pane stays on the same meeting and only its colour label changes; the switch maps
  colour to side again at each press.

**The wire (the re-review's N4).** Today `POST …/external-play/arbiter` takes no body and
answers `{ authToken, participantId, white[], black[] }` (`ArbiterJoinOut`,
`schemas.ts:1372-1377`), and an arbiter who arrives first CREATES the meeting (`arbiter.ts:524`
→ `ensureMeeting`). Per player it becomes:
- **The request names a side.** The body is `{ side: "home" | "away" }` (a strict
  `ArbiterJoinInput` beside `ArbiterJoinOut`); a missing or other value is a 400. It is the
  ENTRANT side, because nothing reads a meeting by colour (§5.6.1). The panel's White/Black
  switch maps colour to side through the board's `whiteSide` (`arbiter.ts:355`,
  `lib/arbiter-view.ts:156`).
- **It joins an existing meeting or refuses; it never creates one.** The usecase looks up that
  side's row (`(fixture_id, side)`, the board's current pairing, not ended) instead of calling
  `ensureMeeting`. With no such row, which also covers a row left by an earlier pairing, the
  answer is a 409 `VIDEO_MEETING_NOT_STARTED` ("This player hasn't checked in yet"). An ended
  meeting keeps its 409 `VIDEO_MEETING_ENDED`. The panel maps the new code to a tile state of
  its own, with its sentence in all four locales (`arbiterJoinStateFromError`,
  `arbiter-panel.tsx:114-133`). An arbiter who arrives before a player therefore no longer
  makes the room that player will join, and spends no create call.
- **The answer** is `{ authToken, participantId, side, players: string[] }`: the arbiter's own
  token and participant id, the side joined, and the participant ids of the PLAYERS in that
  meeting (the peers' `userId`; usually one, though the model allows N). `white` and `black`
  are removed: a meeting holds one player, so the two lists would be one empty and one a
  repeat. The client's guard `seatOf` (`arbiter-camera.ts:85-86`) becomes "is this peer in
  `players`" and keeps refusing every other peer; `JoinArbiter` (`:49`) takes
  `{ authToken, players }`; `ArbiterCameras.tile(seat)` (`:40`) becomes one tile; and the
  watching view (`arbiter-panel.tsx:60`, built at `:764`) becomes one tile for the side shown
  plus the switch.
- **The board list says which sides can be watched**, so the switch is never blind. The
  aggregate below carries each side's state (`none`, `open` or `ended`), and the switch to a
  side that is not `open` is disabled and says why. The list is a poll, so the join's own
  refusal stays the authority. A switch that loses that race has already left the first
  meeting; it shows the refusal on the tile it asked for, with the way back one press away.

**A switch is leave, THEN join, awaited at each step (the re-review's N5).** Today the
board-switch cleanup is not awaited (`arbiter-panel.tsx:788-793`): it is `void mine.leave()`
and then `watch.close()`, whose DELETE is `void send(…).catch(() => undefined)` (`:148`), and
the effect POSTs the next join at once. The two participants overlap, and a DELETE that fails
leaves the first one live until the sweep removes it. A side switch also changes nothing in
today's `joinKey` (`:739`, fixture and attempt), so it would not re-run the effect at all.
D16 changes both:
1. The join key carries the side (`${fixtureId}:${side}#${attempt}`).
2. A switch awaits the SDK `leave()` (`arbiter-camera.ts:238`), then awaits the server DELETE
   of the participant it minted (`leaveAsArbiter`), and only then POSTs the new join. The
   order is explicit in the panel, a serial chain, not left to effect cleanup, which React
   does not await.
3. **A failed DELETE does not block the join.** The arbiter's view is not held hostage to a
   vendor error. The leftover participant is receive-only; the sweep removes it
   (`arbiterRevoke`, `sweep.ts:1249`) and the teardown kicks it with the room.

So the claim is exactly this: **on the happy path an arbiter holds at most ONE live
participant.** The test proves that order and nothing more; a second test proves a failed
DELETE does not stop the join. The claim is not made for the failure path.
- Each mint keeps today's per-open participant id (`${userId}:${uuid}`, one `randomUUID()` per
  mint) and its own `removed_at` row, on its own `(fixture_id, side)`. A join that fails rolls
  back as `mintArbiter`'s catch does for any (`arbiter.ts:576-592`): the minted participant is
  removed at the vendor, best effort, and the row stamped removed. The arbiter then holds
  nothing, the tile says why, and a retry or the way back is one press away.
- **The join gets a rate limit.** It has none today (`ARBITER_RESYNC_LIMIT`,
  `rate-limit.ts:151`, throttles the resync only), and every flip mints a participant row and
  spends vendor calls. `ARBITER_JOIN_LIMIT` is 12 a minute per fixture and organiser,
  fail-open like its neighbours: more than any person flips, and a stuck loop stops. Past it
  the answer is a 429 and the panel shows its generic error tile with a retry. It is proved
  as the resync's limit is (`route.test.ts:343`, with `__setRateLimitCounterForTests`).
- **It is a consumer of the call budget** (§5.6.8). A pane costs up to three vendor calls (add
  the participant; kick and delete it on the way out, `realtimekit.ts:436-458`, `:498-514`),
  and a pane watched until the result costs one, because the teardown's kick-all ends it with
  the room. Over budget the call is DEFERRED, never refused: the join already answers a
  deferral as the same 503 `VIDEO_UNAVAILABLE` ("try again"), not reported as an outage
  (`arbiter.ts:526-537`), and a deferred leave leaves the watch open for the sweep
  (`arbiter.ts:625-639`).

**Shape (a), DROPPED by the owner (2026-10-14): one same-origin iframe per pane.** Kept as a
record of what was considered, never to be built without a new ruling.
- Each pane would be its own document, so its own realm with its own SDK registry.
- It would have needed a stg measurement with the fake camera (two panes joined receive-only
  for 10 minutes, both tracks rendering, each pane's `ClientError` reaching its own pane, a
  reconnect in one pane leaving the other playing) and a both-or-neither mint of two
  participants. None of that is owed now.

**The board list (the re-review's N6).** `boardRows` lists a board ONCE (today's left join
lists it once per row, `arbiter.ts:253`), and keeps the facts of its rows apart instead of
folding them into one board-wide value.
- **The empty case first.** A board has 0, 1 or 2 meeting rows. 0 happens before anyone
  arrives, and on a board whose rows the delta dropped; 1 is a half-arrived board. An
  aggregate written as "set only when every row is ended" or "stamped" is vacuously true
  over 0 rows (`bool_and` of nothing), which is how an empty set reads as done. So every
  board-level value below states its 0-row and 1-row answers.
- **`sides`**: `{ home, away }`, each `{ state: "none" | "open" | "ended", endedAt,
  evidenceAt }`, read from that side's row. `none` is no row, or a row left by an earlier
  pairing. This replaces `hasMeeting` (`arbiter.ts:82` and `:247`), which says only "any
  row", is read by nothing (no other reader in `src` or `e2e`), and cannot tell the switch
  which side exists.
- **`cameraReport`** (`arbiter.ts:346-351`; Required, started and not overridden) is
  - `"settled"` ONLY when there are two rows and both are stamped;
  - `"pending"` when a row on file is unstamped;
  - `null` with no row at all: nothing is on file to report and nothing to wait for, so the
    boards a drop left behind read nothing, not "pending" for ever.

  A started Required board with exactly ONE row is an anomaly, because a game needs both
  players seated and so both rows. It reads `"pending"` and logs a warning naming the
  fixture. The aggregate does not assume two rows; it checks.
- **A flag's window is its own player's row.** `flagView` (`arbiter.ts:367`) hands
  `cameraMatchWindow` (`arbiter.ts:390`) a `meetingEndedAt`. `match-window.ts` requires the
  panel and the sweep to share ONE window, and the sweep judged each player over their OWN
  row's end (`cameraCandidates`, `sweep.ts:963`). So the panel passes the flagged person's
  side's `endedAt` (found through `loadSides`, as `nameOf` is), never "the later of both". A
  flag whose player's row is gone is judged on the game's end alone.

**What the pane and its switch owe (the re-review's M9).** The arbiter panel is
`/o/<org>/c/<comp>/d/<div>/arbiter`
(`app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/arbiter/page.tsx`), an organiser surface and NOT
`/admin`, so it keeps the full bar:
- screenshots at 1280, 320 and 768 with no horizontal page scroll, in these states: watching
  White, watching Black, the other side not arrived, a switch in flight, a join refused
  (outage; meeting ended), and after a pairing card has swapped the colours;
- every new string (the switch's labels, the waiting-for-player sentence, the in-flight
  state, the new refusal's sentence) in all four dictionaries;
- the switch has an accessible name that says the colour AND the player, never "White" alone;
  it works from the keyboard; its target is at least 44 px, hit-tested rather than measured;
  it shows which side is shown and which is unavailable and why; and a completed switch is
  announced to assistive technology;
- the build brief invokes the frontend-design skill, and `arbiter-panel.spec.ts` drives the
  switch at those widths.

#### 5.6.5 The seat claim, and the invariant the mint's lock holds (the review's I3)

- The seat claim mints the player into THEIR side's meeting, creating it on that player's
  first arrival. The opponent's claim touches the other row only.
- The seat evidence (§5.2 amended: the current peer's `media_permission` and `video_on`)
  is read from the player's own meeting. Nothing else about the gate changes.
- **The invariant.** The mint's locked statement (in `playerParticipant`, `preflight.ts`
  `:535-548`; the refusal at `:548`) pins the person to THIS row's side entrant:
  `em.entrant_id = case m.side when 'home' then f.home_entrant_id else f.away_entrant_id end`.
  Today's `in (f.home_entrant_id, f.away_entrant_id)` (`:544`) accepts either side.
- **Two guards, two different races; neither covers the other** (the re-review's N3, which
  corrects the first draft of this section, and re-review 2's F1, which corrects the next).
  - The ordered `samePair` compare (`:542`) refuses any change of pairing between the mint and
    the lock, because the row's stamp no longer equals the fixture's entrants. It is the only
    guard that refuses a re-pair that leaves the claimant's own entrant on their own side and
    changes the OTHER side's entrant: the claimant is still on the board under the same
    label, so the side pin passes, and only the stamp differs.
  - The side pin refuses a person who has moved to the OTHER entrant by a roster edit, with
    the pairing untouched, so the stamp is unchanged and `samePair` is true. The pin is the
    only guard that refuses it.
  - A swapped-sides re-pair (the same two entrants, home and away exchanged) is refused by
    BOTH, so it proves neither. The claim holds the side it read before the swap, and the lock
    selects that side's row, which still carries the pre-swap stamp, so `samePair` is false.
    After the swap `case m.side` resolves that same side to the OTHER entrant, whom the
    claimant does not belong to, so the pin refuses too. The previous draft said the pin
    passes there; it does not.

  So a swapped-sides test cannot kill either guard: a mutant that drops `samePair` and one
  that restores `in (home, away)` both stay green under it. The tests owed (§5.6.8) are one
  per race, each asserting WHICH predicate refused rather than only the shared
  `VIDEO_MEETING_REPLACED` code: at the moment of the edit the test reads the lock's inputs
  in SQL and asserts that the other guard would have passed, so a refusal can only be the
  guard under test. One mutant per guard is run, taken one at a time: drop `samePair`;
  restore `in (home, away)`; flip the `case` arms. Both edits are made from inside the fake
  `addParticipant`, which runs between the side read and the lock.
- A player's meeting id or token never reaches the opponent's browser. Tokens are minted per
  participant with the API key. The snapshot carries only the viewer's own
  `seat.participant` and, after §5.6.3, no opponent participant id at all.

#### 5.6.6 Teardown, camera evidence and flags, per meeting (the review's I2 and I4)

**Teardown is per row, and it ends both.** It runs everywhere a meeting is ended today:
- at the result: the room's own end (`room-end.ts`), plus the sweep's backstop;
- at T+20 if nobody came;
- on a re-pair: openRound's fresh window deletes both rows of a game-less board;
- on `ensureMeeting`'s replace of another pairing's meeting.

Each row is ended in its own try. A vendor failure on one leaves that row unended, and the
sweep's per-row teardown (`teardownCandidates` in `sweep.ts`, `:638-650`) retries it alone.
`endMeeting` stamps `removed_at` only on the arbiter rows of ITS `(fixture_id, side)`, so an
arbiter still watching the other meeting is never recorded as removed while it is live. A board's camera
room is over only when both rows are ended.

**What a half-ended board shows.** This happens only at a result or at T+20, and it is
accepted:
- the player whose meeting ended sees their camera end;
- `ownParticipantId` stays on file, so there is no R3-1 re-claim;
- the opponent's pill reads "unknown" once that player's report is stale (§5.6.3).

**Camera evidence and flags** run per `(fixture, side)`:
- The sweep's candidate is a row. It reads only that row's side's player, so the other
  player's participants are not "absent" and the read is not stuck at `not_ready`.
- It stamps `camera_evidence_at` on `(fixture_id, side)`. Stamping both rows at once would
  break V442's check while the other meeting is still live, and abort the settle on every
  pass.
- Each meeting's peer reports belong to one player, so `camera_lost` is that player's, and
  the arbiter panel shows a flag over that player's own row (§5.6.4).
- The multiple-devices flag (`concurrentConnections`) is computed per meeting, i.e. per
  player, which is what it always meant.
- The guard-fault intervals are per meeting.

**The organiser's video override** (D11) covers the board: both meetings, or neither.

#### 5.6.7 The deploy step, and the copy

**The step BEFORE the delta drops the shared rows (m3, the re-review's M6).** Every shared
meeting row with `ended_at is null` is ACTIVE at the vendor, and its tokens stay valid
until they expire. Dropping the rows would orphan them, and nothing would ever end them.
How many there are is whatever is unended on the day of the deploy. This paragraph first
quoted a stg version (V442) and a row count (four, three of them unended); stg moves, so
those figures are stale by construction and none is written now.
- **A runnable, with an owner.** `scripts/chess-end-shared-meetings.ts`, written with D16
  beside the other one-off operations in `scripts/` (`reconcile-stranded-wallets.ts` is the
  pattern), and run once by the controller against the stg environment. It needs that
  environment's RealtimeKit credentials, because `endMeeting` (`realtimekit.ts:721`) calls
  the vendor. It ends every row with `ended_at is null`: kick-all, then INACTIVE, one row at
  a time, each in its own try. It prints how many it ended and how many failed, exits
  non-zero if any failed, and is safe to run twice.
- **The check lives IN the delta, not before it.** A separate "confirm zero, then apply"
  leaves a gap: a seat claim that lands between them inserts a row and adds a participant,
  and the drop then orphans a LIVE meeting with a player's token in it. So the delta's first
  two statements are `lock table fixture_video_meetings in access exclusive mode` and a guard
  that raises if any row has `ended_at is null`. A claim that committed first is seen: the
  delta aborts (it runs in one transaction) with nothing dropped, and the script runs again.
  A claim that arrives after waits on the lock and then meets the new schema.
- **The gap between migrate and deploy.** Flyway applies the delta first and the deploy
  follows, so for those minutes the OLD code runs against the NEW schema: its meeting insert
  (`realtimekit.ts:393-397`) has no `side`, and its `on conflict (fixture_id)` has lost the
  constraint it names, so a check-in fails with a database error until the deploy lands. The
  branch is unmerged and this is stg only, so it is accepted on one condition: migrate and
  deploy back to back with no round open. A vendor meeting created by a claim that then
  failed at that insert has no participant and no token (the participant is added after
  the insert), so it orphans an empty room and nothing more.
- Prod has no rows: the branch is unmerged.

**Copy.** The privacy line may now state the guarantee: **"Your opponent can't see your
camera."**
- That is true only once no shared meeting exists anywhere, which is why the step above
  runs first.
- It replaces the hedged first sentence ruled for D5 ("Your opponent's room isn't set up to
  show your camera."). The second sentence, "Your organiser can watch it live; it isn't
  recorded.", stays.
- The check-in copy test's ABSOLUTES guard keeps refusing "can't" everywhere else. This one
  line is excepted, citing this section.
- The arbiter's watch-only line and the privacy page say the same thing. The privacy page's
  test pins the hedged sentence and forbids the absolutes in the camera bullet
  (`online-chess-privacy.test.tsx:57-66`), so it changes in the same commit as the copy, to
  the new sentence, and excepts that one sentence from the absolutes check (as the check-in
  copy test does), citing this section, so the rest of the bullet is still held to it.
- An organiser who plays on the board cannot watch it: `arbiter.ts:497-499` refuses with
  `ARBITER_PLAYS_THIS_BOARD`, and the sweep revokes such a watch.

#### 5.6.8 The RealtimeKit budget (m2, the re-review's M5; restated after D21-fix-3 and D22)

These are vendor calls per board per round, counted from the call sites at `6faa729c0`
(find them by symbol; the line numbers are a hint). Every RealtimeKit REST call, the new ones
included, spends from the platform's call budget (D21, `video/budget.ts`): a token bucket of
900 calls per five minutes (a burst of 300 plus 2 a second, 75% of the account's 1,200). Over
budget a call is DEFERRED, never refused: it is not made, and each caller reads that as "ask
again", never as "no camera" and never as an outage. D16 adds calls, so it consumes that
budget, and each new call site keeps the deferral rule:
- the second meeting's create and its participant (a seat claim): under `required` the seat
  answers `camera_starting` and the room asks again (`verifyRequiredSeat`'s deferral catch,
  `preflight.ts:359-366`); under `optional` the player is seated with no tile for now, and the
  room asks the camera route for the token on its back-off (`seatPlayer`'s optional branch,
  `:228-235`, and §5.2);
- the second teardown: `endMeeting` throws, the row stays unended, and the sweep retries that
  row alone (§5.6.6);
- the second evidence read: a deferred read leaves the row unsettled for the next pass, and is
  not a failure (`cameraEvidence`'s rethrow, `sweep.ts:1144-1148`, which `each` counts as
  deferred, `:242-249`);
- the stranded-board create (§5.2): its re-verify spends from the same bucket, and a deferral
  writes nothing, so the board stays a candidate for the next pass;
- the arbiter's join, switch and leave: §5.6.4.

**What one seat claim costs the vendor** (policy `required`; `verifyRequiredSeat`,
`playerParticipant` and `judgeSeat` in `preflight.ts`):
- The minting claim, a player's first (no participant on file): 1 call to add the participant,
  which returns its token, plus 1 if it also creates the meeting it joins. It reads nothing,
  because nobody can have joined with a token that did not exist yet.
- A later claim the back-off lets through to the vendor (a reading claim): 3 calls, the live
  session, its participants and the peer report (fewer when there is no session or the
  participant is not in it). Plus 1 to refresh the participant's token when the answer must
  carry one: the claim that seats the player, a refused camera, or a browser that holds no
  token. A `camera_starting` answer to a browser that holds its token carries none, so the
  polling claims on the way cost the 3.
- A later claim inside the back-off (1, 2, 4, 8 s, `CAMERA_EVIDENCE_BACKOFF_MS`): 0 for a browser
  that holds its token, answered from the cache (the V446 `seat_read_*` columns). A browser that
  holds none (a reload, a second tab) is handed a refreshed token on every answer, so its claim in
  the back-off costs 1.
- T9's re-verify before creating the game: 0 when the player's pass was read within
  `SEAT_RECHECK_TRUST_MS`; otherwise up to 3 reads, and never a token.

`k` is the number of a player's claims that READ the vendor (the minting claim is not one);
the last of them seats the player.

| | Shared meeting (today) | One per player |
|---|---|---|
| Meeting create | 1 (the first arrival's claim) | 2 (each player's minting claim, inside the check-in burst) |
| Per player: the mint 1, `k` reads of 3, and the token handed with the seat 1 | 2 × (3k + 2) | 2 × (3k + 2), unchanged |
| Teardown (kick-all + INACTIVE, per meeting) | 2 | 4 |
| Evidence after the match: per meeting the sessions list, then per player the peer ids and one peer report | 1 + 2 × 2 = 5 | 2 × (1 + 2) = 6 |
| Arbiter pane: add 1, kick 1, delete 1 (a pane watched to the result costs 1) | up to 3 | up to 3 per pane shown; a switch is a leave (2) and a join (1) |
| The pill and its heartbeat | 0 (client signalling) | 0 (our own database) |

- At k = 2, no arbiter, and T9's re-verify inside the trust window, that is 1 + 16 + 2 + 5 = 24
  calls per board today and 2 + 16 + 4 + 6 = 28 with a meeting per player: **+4 per board**
  (create +1, teardown +2, evidence +1). The 24 is not a guess: D22's clean 20-board run made
  486 calls, 24.3 a board. At 30 boards the delta is +120, and at 50 boards +200. The create's
  +1 lands in the check-in burst, the stretch where the bucket is busiest; the teardown's +2
  and the evidence's +1 come after the games.
- The baseline 24 holds only for a board whose second check-in lands inside the 10 s trust window
  (`SEAT_RECHECK_TRUST_MS`), so T9's re-verify costs nothing. Outside a burst, where the second
  player arrives later, the re-verify reads both cameras again (up to 3 calls each) and a board
  costs 24 to 30, with the same +4 on top. A claim inside the back-off costs 0 only for a browser
  holding its token (above); a reload or a second tab pays 1.
- The dominant term is NOT this change: it is the players' own claims, 16 of the 24, and the
  table's player row does not move. Before D21 a `camera_starting` wait that re-asked once a
  second could reach `k ≈ 20`, which D21's own figure puts at about 6,000 calls in five
  minutes with 50 boards checking in at once. D21 bounded it (the back-off above, the cache,
  and `CAMERA_EVIDENCE_MAX_POLLS`, 5 reads) and put every call under the bucket. D21-fix-3
  then stopped spending the token before the cache (D22 found 75% of the calls were token
  refreshes) and stopped T9's re-verify spending a token, and the three reads per player whenever
  the pass it trusts is under ten seconds old (outside that window it still reads). The seat
  gate's spend is D21's to own; this table counts what D16 changes.

**What the budget can carry: OWNER-OPEN, and not fixed.** D21 bounds what the platform
spends; it does not make the platform carry any number of boards. A board that the bucket
cannot afford is created late, not refused. D22's load test (`e2e/load/chess-30-boards.load.ts`:
node-fetch players against the production build and the fixture servers, metered, a fresh
database per run, a 60 s arrival) measured, after D21-fix-3 (`6faa729c0`):
- 20 Required boards: 486 calls, 0 deferrals, arrival-to-seated p95 7.9 s, every board
  created its game, none stranded.
- 30 Required boards arriving in 60 s: 873 and 898 calls in the busiest five minutes (the cap
  is 900), 454 and 591 seat deferrals in the two runs, arrival-to-seated p95 223 s and 274 s.
  Every game was created, but late: up to about 290 s after both players were seated, once
  the bucket had recovered (the sweep that creates a stranded board runs every five minutes
  in production). 0 wrong refusals.
- 10 Required + 10 Optional + 10 Off: 311 calls, 0 deferrals. 30 Required + 10 Optional: 7 of
  the 20 optional seats were seated with no token, all 7 got their tile without a reload, from
  14.1 s (median) to 60.1 s (longest) after the seat.

So about 24 Required boards arriving within a minute is the clean ceiling the runs support.
That figure is read between two measured points (20 clean, 30 not), not measured as a
number. Two things make it worse than the bucket's arithmetic: under starvation a player's
cost rises (14.6 and 16.1 calls a player in the two 30-board runs against 8.7 clean, partly
because a deferral that lands between a read's three calls throws away the ones already
made), and the sweep's stranded-board create loses the race for tokens to the players' polls.
It also re-reads both cameras in effect, up to six calls, because the grace before it acts
and the trust window are both 10 s.

D22's proposals, none built or decided: reserve a lane so a create for a board with both
players seated may take tokens the players' reads may not; take a read's three tokens all at
once, so a deferral cannot land mid-read; and have a seated player whose game has not
appeared re-claim on a back-off, so a stranded board waits for a player's next ask and not
for the cron. The owner's choice is to accept the ceiling, build some of those, raise the
budget, or stagger a round's opening. This spec does not claim the ceiling is closed.

D16 puts 4 more calls on a board of about 24. Where it bites is the check-in ceiling: the
create's +1 lands in the burst, about 17 to 20 more calls (one per board) on D22's busiest minute
of 342 calls for 20 boards, 5 to 6%. The teardown's +2 and the evidence's +1 come after the games
and do not touch the burst. The ceiling can only fall; by how much is for the load re-run to say,
not for this arithmetic, because the cost per player is not constant near the cap.

**Tests owed** (with the build), each against the RealtimeKit fixture server
(`e2e/realtimekit-fixture-server.ts`, which models several meetings and counts calls), each
counted:
- The two players' participants are in DIFFERENT meeting ids. Drive the real seat claim
  twice. A player's meeting never contains the opponent, whichever player arrives first.
- I3's invariant (§5.6.5), as two tests that each kill one guard, one extra that kills
  neither, and three mutants, because the two guards cover different races:
  - a re-pair that replaces the OTHER side's entrant while the claimant's own entrant stays
    on their own side, landing during the mint, is refused (`VIDEO_MEETING_REPLACED`) and
    stores nothing. At the moment of the edit the test asserts in SQL that the row's stamp now
    differs from the fixture's entrants and that the claimant still belongs to the entrant on
    their side, so the pin would pass. It kills a mutant that drops `samePair`;
  - a roster edit that moves the person to the OTHER entrant, with the pairing untouched,
    during the mint, is refused and stores nothing. At the moment of the edit the test asserts
    in SQL that the stamp equals the fixture's entrants (`samePair` would pass) and that the
    claimant no longer belongs to the entrant on their side. It kills a mutant that restores
    `in (home, away)`, and one that flips the `case` arms;
  - a re-pair with the same two entrants and the SIDES SWAPPED, landing during the mint, is
    refused and stores nothing, as an extra. Both guards refuse it (§5.6.5), so it earns no
    kill credit and is not counted in the mutants below;
  - each test shows it reached the guard: the fake `addParticipant` was called once, and the
    refusal is the lock's. Three mutants are run one at a time, and the count killed is
    reported (3 of 3).
- Evidence settles per meeting, while the other meeting is still live (no V442 abort).
- A half-ended board: one of the two teardowns fails at the vendor and the other ends; the
  sweep retries only the failed row; an arbiter in the still-live meeting is not stamped
  removed and one in the ended meeting is; the player of the failed row keeps their camera.
- The arbiter board list lists each board ONCE, with 0, 1 and 2 meeting rows (§5.6.4):
  - 0 rows: both sides `none`, and `cameraReport` null on a started Required board;
  - 1 row: `pending`, with the warning logged;
  - 2 rows: one stamped is `pending`, both stamped is `settled`; each side's `open` / `ended`
    state is right when one side has ended and the other has not;
  - a flag's window is its own player's row: two rows ended at different times, and each
    player's flag shows the window the sweep judged for that player.
- The arbiter join names a side. A side with no meeting yet is a 409
  `VIDEO_MEETING_NOT_STARTED` and makes ZERO create calls (counted at the fixture server); an
  ended one keeps `VIDEO_MEETING_ENDED`; the answer lists only that meeting's players; past
  `ARBITER_JOIN_LIMIT` the answer is a 429.
- Leave and revoke act on the right meeting; `endMeeting` stamps only its own meeting's
  arbiters.
- A pairing card that swaps the colours after a player has arrived relabels the pane and
  leaves the meeting alone.
- The pill:
  - each state from the opponent's reports: live, off, "unknown" for none and for stale;
  - a test per inherited `null` condition (§5.6.3): policy off, a video override, the game
    over, `!canAct`, no person on file, and an open guard fault, six checked and zero is a
    failure;
  - `off` held by heartbeats for three times `CAMERA_REPORT_STALE_MS` still reads `off`;
  - a reordered pair, a late `live` heartbeat landing after an `off` change, leaves `off`;
  - a heartbeat is judged against the stored row, in four cases (§5.6.3): it agrees with the
    stored state, so it refreshes the stamp and pings nobody; nothing is stored, so it writes
    the state and the stamp and pings nobody; it differs and the row is fresh, so nothing is
    written and the stamp is untouched; it differs and the row is no longer fresh, so it is
    applied as a change (the state flips, the stamp moves, the opponent's room is pinged);
  - the tab that made the deciding `off` is gone and a `live` tab remains: its `live`
    heartbeat is ignored while the stored `off` is fresh, and applied once the row is no longer
    fresh, with the instants either side of the pill's own staleness boundary both checked, so
    the heartbeat and the pill cannot disagree about when a row went stale;
  - a change pings and a heartbeat that only refreshes does not;
  - each of the seven `CameraStatus` values sends what §5.6.3 says (seven checked);
  - someone else's seat is refused with the room's one 404;
  - the real producer through the real consumer: a camera session's report queue, the real
    route, the opponent's real snapshot and the pill, not a fixture at either end;
  - a room read makes zero vendor calls (counted at the fixture server).
- The source guards report their counts: §5.6.1's (two mutants, each run alone: one that
  drops `side` from a statement, and one that reverts `leaveAsArbiter`'s join, or
  `reportCameraFault`'s, to `fixture_id` alone while its `participant_id` condition stays; both
  go red) and §5.6.3's (a mutant that reads `camera_reported` from the seat gate goes red).
- A mutant that collapses the two meetings back into one goes red.
- Shape (b): a switch sends its DELETE and gets the answer BEFORE the next join is sent, and
  holds one participant at a time on that path; a failed DELETE does not stop the join.
- The delta's guard (§5.6.7): against a database with an unended row it raises and drops
  nothing; with only ended rows it applies.
- The budget: one board's whole life is driven against the fixture server and its call count
  is compared with this section's formula for the board's actual `k`. The expected number
  comes from the table and the actual from the fixture server's own counter, so neither is
  read off the code under test. D22's load run (`e2e/load/chess-30-boards.load.ts`) is then
  re-run with a meeting per player, and reports the busiest five minutes against the bucket,
  the deferrals and any stranded board. At 20 Required boards it must again show 0 deferrals
  and no stranded board, at about 566 calls: the measured 486 plus 4 a board. The fixture
  server's counter against the table's formula for each board's actual `k` is the check; a
  count off by more than the claims the back-off let through means the table is wrong, and it
  is corrected here before the build is called done. At 30 Required boards the run is
  RECORDED and no fix is claimed: the run is red there at HEAD already (D22; §5.6.8, "What
  the budget can carry"), and the number goes to the owner.
- The vendor title carries the side, and `online-chess-privacy.test.tsx` pins the new
  literal.

---

## 6. The match room

One page, one DOM, phone-first; everything below `md` is `max-md:*`.

**States:** before the window → window open, not seated (preflight + Check in) → seated,
waiting → game live → over → needs organiser.

**Always visible during play:** both clocks, both names, whose move it is, the board, your
own tile, the opponent presence pill.

**Phone composition at 320** (owner chose A over a picture-in-picture overlay, because an
overlaid tile covers a board corner and that is where a rook lives):

```
┌──────────────────────┐
│ Ada 10:00 · you 9:42 │  clocks + names
├──────────────────────┤
│        BOARD         │  full width
├──────────────────────┤
│ [you] 🎥  opp ● live │  own tile + presence pill
├──────────────────────┤
│  Draw   Resign       │
└──────────────────────┘
```

Desktop keeps the board central with the tile and controls in a side rail.

**Controls:** draw offer, resign, abort before the first move, and **our own promotion
picker** — chessground ships none. No takeback: it is a dispute magnet with a camera
pointed at it.

**Clocks** render locally from accepted-move timestamps and are corrected on every
reconcile (M11). We never declare a flag from our own arithmetic.

---

## 7. Public and organiser surfaces

- **Public match centre** watches on our page, view-only board. No lichess.org link.
- **Run sheet** shows camera flags, held fixtures and the organiser's Settle action.
- A knockout draw shows as held — "winner to be decided" — never as a decided result.

---

## 8. Testing

House rules apply in full: every change ships a test that fails without it; every guard
added is mutated once; anti-vacuity — a sweep reports how many items it checked and zero
is a failure; expected values derive from the rulebook or the engine's declarations,
never from the code under test.

Specific to this design:

1. **The UCI validator is mutated** — delete the pattern, confirm a test fails. M5 is the
   reason it exists: garbage does not error, it moves a piece.
2. **The time-control list is driven, not asserted.** A test walks every entry in the
   ship-1 list and checks `limit + 40 × increment ≥ 180`, and reports the count checked.
3. **Result mapping enumerates every terminal status** — `mate`, `resign`, `outoftime`,
   `draw`, `stalemate`, `aborted` — including M9's early-resign-is-an-abort case, where
   the wrong answer differs from the right one by having a winner at all.
4. **The no-show sweep is tested in phase `pre`**, which is where a game that never began
   sits. Today no test anywhere covers a chess forfeit; the only Swiss withdrawal test
   that drives an unstarted board is badminton, whose engine tolerates `pre`.
5. **Preflight is tested against a forged client claim** — a request asserting
   `cameraOk` with no live publisher must be refused.
6. **E2E covers the seven widths**, with the match room driven at 320 and 1280.
7. A Lichess **stub** stands in for e2e; the recorded real payloads in
   `__fixtures__/lichess/` stay the contract check.

---

## 9. Licensing

chessground is **GPL-3.0** and we ship it to every visitor's browser, which is
distribution of a combined work. It is not AGPL, so server use alone triggers nothing.
The owner accepted this on 2026-10-09 after being told; no legal advice was given or
implied, and a lawyer is the right answer if the question is ever pressed.

Mitigation, which the design requires: chessground is **isolated and unmodified** — its
own chunk, loaded as a library, never vendored or patched, with a thin wrapper of ours
above it. This narrows the argument; it does not remove it.

chess.js (BSD-2) supplies client-side legality hints. If Chess Quest's piece artwork is
ever reused here, it is Cburnett **CC BY-SA 3.0 / GFDL** and the attribution travels with
it.

---

## 10. Do not copy from the POC

The sample is a mechanism reference, not a code source. Specifically rejected:

- player tokens pasted into a form, held in plaintext memory and never revoked;
- a client-supplied `cameraOk` boolean as the check-in gate;
- an unauthenticated `/ws` upgrade whose `game_ready` frame broadcasts **both** seats'
  video tokens;
- `ARBITER_KEY` defaulting to `'arbiter'` and pre-filled in the HTML;
- an unauthenticated `/api/reset`.

---

## 11. Sequencing and dependencies

- **This programme cannot ship its no-show path before W2b merges.** Until then a
  pre-start chess forfeit returns 422 `WRONG_PHASE`. W2b accepts phase `pre` and makes
  `core.forfeit` strict: `{by: <entrant> | "both", reason: "walkover" | "retired" |
  "disqualified" | "withdrew"}`; free text is refused. Contract supplied by session
  f-w2b, signed by their owner 2026-10-08 — **information to us, not a ruling**.
- **W2a is NOT merged.** `apps/web/src/lib/organiser-only-events.ts` and
  `isOrganiserOnlyEvent` do not exist on this branch or on `origin/main` (verified
  2026-10-09); W2a lives on `feat/format-matrix-w2a`. So the organiser-only gate is a
  **future** constraint, not a present one. We write results under organiser authority
  regardless — that is correct before the gate exists and required after it — and the
  implementer re-checks the gate as merged rather than coding against this paragraph.
- **W3 owns Swiss colour alternation.** We read colour; we do not fix allocation.
- Migrations: V405/V407 sit below main's high-water mark (V431) and `flyway.toml` sets no
  `outOfOrder`, so they are refused on any DB past V431. **Amend them to V439/V440 as
  part of this design's schema work** — do not enable `outOfOrder`. (Renumbered at the
  2026-10-13 rebase onto W2b: main took V437 capture records and V438 W2b, so the branch's
  four deltas V433–V436 became V439–V442 with their DDL unchanged.)

---

## 12. Out of scope for ship 1

Recording and retention. A second camera angle (the model allows N participants per
player, so it is config later, not a migration). Takeback. Rated games. A new arbiter
role — the existing organiser/admin role is used, one migration after `scorer` was
retired. Variants other than standard.

---

## 13. Open items

- Penalty wording for a camera that goes dark: ruled as **flag, organiser decides** (D10);
  the player-facing sentence still needs writing in four locales.
- W2b's merge date, which gates the no-show path.
- ~~The arbiter's simultaneous two-pane view~~ — CLOSED by owner ruling (2026-10-14): the
  arbiter sees ONE player's camera at a time with a white/black switch (§5.6.4 shape (b)); the
  iframe-per-pane shape (a) is dropped, so no stg measurement is owed for it.
- The seat gate's RealtimeKit spend — BOUNDED by D21; capacity OWNER-OPEN (D22). A
  `camera_starting` wait that re-asked once a second could reach about 6,000 calls per 5
  minutes at 50 boards, against the global 1,200. The re-ask now backs off (1, 2, 4, 8 s), a
  cached verdict answers the claims in between, and every call spends from a platform bucket
  of 900 per 5 minutes, over which a call is deferred rather than refused (§5.6.8). That
  bounds the spend; it does not make the platform carry any number of boards. D22 measured 20
  Required boards clean (486 calls, 0 deferrals) and 30 arriving in a minute not (873 to 898
  calls in the busiest five minutes, arrival-to-seated p95 223 to 274 s, every game created
  late). About 24 Required boards a minute is the ceiling the runs support. The owner has
  not decided whether to accept it or to build the reserved lane, the all-or-nothing read and
  the client re-claim net, raise the budget, or stagger a round's opening. D16 adds +4 calls
  per board and consumes the same bucket; its load re-run is listed with the tests owed.
