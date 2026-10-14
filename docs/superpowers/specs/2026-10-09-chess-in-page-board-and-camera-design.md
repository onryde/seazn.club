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
- **Not live.** During the session the report stayed frozen at its join snapshot for all
  nine minutes: one sample, `duration` 0, and no `video_off` event even 2.5 minutes into
  the camera being off. It cannot be an in-match signal.
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
no evidence yet is `camera_starting` (the room re-asks every 1 s; the server waits 15 s from
the peer's join, then refuses). Samples are never required.
**Residual, accepted:** the report is client-uploaded SDK telemetry, so a tampered client
could forge it; this closes the honest-browser gap, not a determined forger.

### 5.3 What each person sees
- **A player sees their own tile only** (D7). Local preview; no subscription to the
  opponent. Since 2026-10-14 the opponent is not in the player's meeting at all (§5.6).
- A **presence pill** shows "opponent camera: live / off" — compliance without a face.
- An **arbiter**, when assigned, joins receive-only and sees both players' tiles for a
  chosen fixture, plus that fixture's flags. Since 2026-10-14 that is two meetings, one per
  player (§5.6).
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

### 5.6 One meeting per player (amended 2026-10-14, owner ruling "1 per-player", T17B fix 2 D16)

**This replaces the shared meeting.** Each board now has TWO RealtimeKit meetings, one per
player. A player's meeting holds that player and, when one is watching, the arbiters. Nobody
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

**What changes, each consumer once.**
- **Schema** (a new delta after V445, numbered at the time). The meeting row is keyed per
  player: `fixture_video_meetings` gains `side text not null check (side in ('home',
  'away'))`, and its key becomes `(fixture_id, side)`.
  - The side is the player's ENTRANT side (the fixture's seat), which is fixed for a
    pairing. The colour is not fixed: it is read from the ledger (home unless a
    `boardgame.pairing` card records Black on home, `whiteSideOf`), so an organiser's card
    can swap it after a player has arrived.
  - Every table that references a meeting by `fixture_id` (participants, guard faults)
    references `(fixture_id, side)` instead.
  - The pairing stamp (`home_entrant_id`/`away_entrant_id`, R2-2) stays on each row.
  - Greenfield (RULES.md): the delta drops the existing shared-meeting rows, which cascade.
    It does not try to split them, and nothing is backfilled.
- **The seat claim** mints the player into THEIR side's meeting, creating it on first
  arrival. The opponent's claim touches the other row only.
  - The seat evidence (§5.2 amended: the current peer's `media_permission` and
    `video_on`) is read from the player's own meeting. Nothing about the gate changes.
- **The presence pill** ("opponent camera: live / off") is read on the server from the
  OPPONENT's meeting. The player never joins it, and nothing about the opponent's meeting
  is handed to the player's browser except that one answer.
- **The arbiter** joins BOTH meetings receive-only, as two participants, one per meeting,
  each minted and removed exactly as one is today. The panel shows two panes, labelled by
  player.
  - The per-open participant id (`${userId}:${uuid}`) and the `removed_at` record apply
    per meeting.
  - The RealtimeKit global limit (1,200 calls per 5 min) is now spent twice per watch.
- **Teardown** ends both meetings everywhere a meeting is ended today: at the result (the
  room's own end and the sweep's backstop), at T+20 if nobody came, on a re-pair (openRound's
  fresh window deletes both rows of a game-less board), and on ensureMeeting's replace of
  another pairing's meeting.
  - A board's camera room is over only when both are ended.
- **Camera evidence and flags** run per meeting.
  - Each meeting's peer reports belong to one player, so `camera_lost` is that player's.
  - The multiple-devices flag (`concurrentConnections`) is computed per meeting, i.e. per
    player, which is what it always meant.
  - The guard-fault intervals are per meeting.
  - `camera_evidence_at` is stamped per meeting, and the board's evidence is settled when
    both are.
- **The organiser's video override** (D11) covers the board: both meetings, or neither.

**Copy.** The privacy line may now state the guarantee: **"Your opponent can't see your
camera."**
- It replaces the hedged first sentence ruled for D5 ("Your opponent's room isn't set up to
  show your camera."). The second sentence, "Your organiser can watch it live; it isn't
  recorded.", stays.
- The check-in copy test's ABSOLUTES guard keeps refusing "can't" everywhere else. This one
  line is excepted, citing this section.
- The arbiter's watch-only line and the privacy page say the same thing.

**Tests owed** (with the build):
- The two players' participants are in DIFFERENT meeting ids. Drive the real seat claim
  twice, against the RealtimeKit fixture server.
- A player's meeting never contains the opponent, whichever player arrives first.
- The arbiter receives both.
- A mutant that collapses the two meetings back into one must go red.

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
