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

Owner decisions taken 2026-10-15, capacity (the staggered check-in and the check-in line: §3.2.1,
§5.7, and the "Capacity amendment" in §5.6.8). Numbered C so they are not confused with the D21/D22
fix names above:

| # | Decision |
|---|---|
| C1 | **Timed batches, not a queue.** Boards in board-number order, `CHECKIN_BATCH_SIZE` = 10 to a batch. Batch i's check-in opens at `T + i × CHECKIN_BATCH_GAP_MS`. The gap is ONE constant, started at 60 s; the load re-run decides 60 vs 120 s. Each batch gets its own full check-in window. Waiting boards show "Your check-in opens at HH:MM" in the viewer's local time, in four locales. No limit once playing |
| C2 | **Every time-relative rule moves with the batch.** The no-show walkover is at `T_batch + 20`, not `T + 20`, and so is every other job keyed off `T`: the game create, the sweep's arms, the window's close |
| C3 | **Late arrival is unchanged** ("keep it for now"): no clock penalty, the game is created when both are seated, the only consequence of lateness is the walkover at `T_batch + 20`. Revisit later |
| C4 | **A first-come check-in line** when the vendor-call budget is short: seats are granted in arrival order, and the player is told where they stand and about how long |
| C5 | **A seat 429 says "wait a moment"**: a countdown from `Retry-After`, then the button re-enables |
| C6 | **Raising Cloudflare's API limit is an owner action** before big events. Nothing is built for it (§13) |

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
A fixture with no `round_opened_at` is not yet playable and says so. *(Amended 2026-10-15,
C1/C2: "T" in every sentence of this spec that times a window is the BOARD's batch start
`T_batch`, which is `round_opened_at` for the first ten boards of a round and later for the rest,
§3.2.1. T−10 is a lead on the first batch only.)*

Check-in stamps the fixture. Under policy `Required`, the seat is granted only after
camera preflight passes (§5).

**Round N+1 cannot be paired until Round N's results are all in** — which is why the
abandoned-board sweep in §3.5 matters operationally, not just tidily. One unresolved
board blocks the next round.

#### 3.2.1 Staggered check-in: timed batches (amended 2026-10-15; owner decisions C1, C2, C3)

**Why.** Check-in is where the platform's vendor-call budget is spent (§5.6.8): about 20 calls a
board, in the minute after the invites, from every board at once. D22 measured 20 Required boards
clean and 30 arriving in a minute not. Batches spread a round's check-in over time so each wave
fits the bucket. It is a timetable, not a queue: no state is kept, and a player can read when
they are due.

**The rule.**
- **Rank and batch.** A board's rank is its zero-based position among EVERY fixture row of its
  (stage, round), ordered by `(seq_in_round, id)`; `seq_in_round` is the board number the room
  already shows (`boardNo`, `room.ts` `roomFacts`). Its batch is `floor(rank /
  CHECKIN_BATCH_SIZE)`: boards 1 to 10 are batch 0, 11 to 20 batch 1, 21 to 30 batch 2. It is the
  RANK and not the raw number, so that a gap or an offset in `seq_in_round` cannot put a board in
  the wrong batch; and it counts every row, a bye and a withdrawn board included (a bye occupies a
  fixture row; a withdrawal leaves the row `abandoned`), so no board's check-in time moves after
  its invite was sent. It is computed and not stored: the rows it counts do not move, and a stored
  batch would go stale for a board the open did not attach. A re-pair that keeps the round's
  window (a partly invited round) can move a regenerated board to another rank; one that lands in a
  batch the clock has already passed is simply open at once, one that lands later waits, and the
  room shows the new time. Accepted: the re-pair is the organiser's act.
- **The constants.** `CHECKIN_BATCH_SIZE = 10` and `CHECKIN_BATCH_GAP_MS = 60_000`, beside the
  other window values in `server/external-play/window.ts` ("the only definition of these
  values"). The gap is the only knob: the load re-run picks 60 or 120 s (§5.6.8) and that is a
  change to one number.
- **The start.** `T_batch(i) = round_opened_at + i × CHECKIN_BATCH_GAP_MS`. A round of ten boards
  or fewer has one batch, `T_batch = round_opened_at`, and nothing about it changes.
- **The window.** Batch 0 keeps today's window exactly: opens `T − 10 min`, closes `T + 20 min`.
  Batch i ≥ 1 opens at `T_batch(i)` and closes at `T_batch(i) + 20 min` (`DEADLINE_AFTER_MS`).
  **Each batch has its own full 20 minutes**: a batch that opens late loses none of them.
- **The T−10 lead does not apply to a later batch (a finding, not in the brief).** `windowFor`
  opens a window `WINDOW_OPEN_LEAD_MS` (10 min) before its anchor. Fed `T_batch(i)` it would open
  batch i at `T + i × gap − 10 min`, before the organiser pressed Open for every gap under ten
  minutes, and the stagger would not exist. The lead is already a no-op for batch 0: `openRound`
  stamps `opened_at = now` (`open-round.ts`: the insert and the re-stamp), so `T − 10 min` is
  always in the past, and `phase === "before"` is reachable only with a stamp in the future (a
  test). So `boardWindow(board)` returns `opensAt = T − lead` for batch 0 and `opensAt = T_batch`
  for the rest, and `deadline = T_batch + 20 min` for all.
- **Every reader moves, through one authority.** Every place that asks "is this window open"
  today passes `round_opened_at`. Each now passes the BOARD's anchor, and the window functions in
  `window.ts` take a branded `BoardAnchor` that only `boardAnchor(roundOpenedAt, rank)` makes, so
  a raw round stamp no longer compiles. The readers, found by symbol at `00e5179b6`:

| Reader | Symbol | What `T` does there |
|---|---|---|
| seat | `preflight.ts` `seatPlayer` | `before` → `round_not_open`; `closed` and not a re-entry → `window_closed` |
| a check-in counts | `window.ts` `checkInCounts`, via `room.ts` `checkIns` (the room, `noShow` and `mintRetry` all judge "who came" through it) | a check-in counts only inside the board's window |
| snapshot | `room.ts` `compose` and `claimRoomSeat`, via `room-snapshot.ts` `roomPhaseWire` and `windowWire` | the `phase`, `opensAt` and `deadline` the room draws, and the gate on stamping a check-in |
| game create | `create-game.ts` `createGameIfReady` (the `not_ready` gate), `createAtDequeue` (the `claimAt` refusal), and the `ready` row's `expires_at` | "T+20 is the deadline to have the game created" |
| sweep | `sweep.ts` `playableWindow`, read by `noShow` (and its `not_started` hold), `mintRetry`, `meetingIsDone` (teardown) and `expectedEnd` (the reconcile base) | the no-show, the stranded-board and throttled-create arms, the "nobody played" teardown, the base of an expected end |
| invites | `invite.ts` `sendFixtureInvite` (the deadline in the mail) and the resend refusal; `open-round.ts` `openRound`'s "reinvited" `window_closed` skip | per board: a board whose batch window has closed is skipped, one whose has not is still invited |
| organiser | `open-round-view.ts` `closed`, `deadlineAt`, `windowMinutes` | the round is closed when its LAST batch has closed; the view lists each batch (below) |

  Not moved: `guard.ts`'s `scheduled_at_basis` (schedule-based, a different question; do not
  re-anchor).

  Where a reader needs a board's rank in SQL (`noShowCandidates`, `retryCandidates`,
  `teardownCandidates` and the reconcile candidates all join `stage_round_opens`), it uses ONE
  shared fragment, `boardRankSql`, never a copy per query. A **source guard** walks the non-test
  tree for callers of `roomPhase`, `windowFor`, `checkInCounts`, `playableWindow`,
  `roomPhaseWire` and `windowWire`, requires each to take a `BoardAnchor` (the type does the work;
  the scan catches a cast), and reports how many call sites it checked and how many of each reader
  in the table it found. Zero checked is a failure, and so is a reader in the table that the scan
  no longer finds.
- **Late arrival is unchanged (C3), stated plainly.** A player who arrives after their batch
  opened keeps the whole game clock. Nothing is deducted and no "late" mark is written; the game
  is created when both players are seated, however long the first one waited, and a Lichess clock
  starts at the create, so an early player's clock does not run while they wait. The ONLY
  consequence of lateness is the walkover at `T_batch + 20` (§3.6). Owner, 2026-10-15: "keep it for
  now"; to be revisited.
- **No limit once playing (C1).** Moves, draw offers and the result path make no vendor call and
  are throttled by neither batches nor the line (§5.7). Only the seat is.
- **What the player sees.** A board whose batch has not opened shows the waiting card, "Your
  check-in opens at HH:MM", in the viewer's local time, rounded UP to the minute so the page never
  promises a time earlier than the door opens (§6.1). The room re-reads at `opensAt`, not on the
  idle poll. The invite mail names the board's own deadline (`T_batch + 20`) and, for batch 1
  onwards, when check-in opens.
- **What the organiser sees.** The open-round confirmation says how long the stagger runs ("Check-in
  is staggered over N minutes", `(batches − 1) × gap`) before the press, and the view lists the
  batches (boards a to b, opens at, closes at). A round of 100 boards is ten batches and its last
  opens `9 × gap` after Open: 9 minutes at 60 s, 18 at 120 s. That is the price of the stagger and
  the organiser is shown it before pressing. This is an organiser surface, not `/admin`: it keeps
  the full mobile bar.

**What batches do not do.** They stagger ONE (stage, round). Two divisions opened together each
start their batch 0 at once, so 30 boards across three divisions still arrive together; the line
(§5.7), not the batch, is what holds that, and the organiser is expected to open divisions apart.
A platform-wide scheduler across rounds is out of scope (§12).

**Open question Q1 (§13).** A round whose camera policy is `off` spends no vendor calls, yet under
the ruling as worded it staggers all the same, costing an `off` board up to `(n − 1) × gap` of
waiting for nothing. The recommendation is that an `off` round is ONE batch, because the stagger
exists for the vendor budget alone. The policy is per division/stage, so it is one predicate in
`boardAnchor`. This section is written as ruled (every round staggers) until the owner answers.

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
| no-show at `T_batch` + 20 | `core.forfeit {by, reason: "walkover"}` |
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

**`T_batch` + 20 is the deadline to be seated and have the game created** — not a cap on the
game. Once a game exists it runs on its own clock, past the window if it must. Nothing in our
system ends a live game early. *(Amended 2026-10-15, C2: the deadline is the BOARD's, `T_batch(i)
+ 20 min`, §3.2.1; a batch-3 player checking in at `T + 21 min` is not forfeited at a 60 s gap,
because their board's deadline is `T + 22 min`. And a player the vendor-call budget is still
holding in the check-in line at the deadline has arrived and is not forfeited for the platform's
delay, §5.7.8.)*

**Late arrival costs no clock (C3).** A player who comes after their window opened is seated when
they get there, and the game is created when both are. No time is taken off their clock and none
is added to their opponent's; the walkover at the deadline is the only consequence of lateness.

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
four jobs, every one of which happens when no page is open: the `T_batch`+20 no-show (each
board's own deadline, §3.2.1), the mint retry for a creation that hit the 429 wall, meeting
teardown when nobody came, and the reconcile sweep for a live game nobody is watching.

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
or at `T_batch`+20 if nobody comes (C2). *(Amended 2026-10-14, §5.6: each player's OWN meeting is created
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
- **A Required claim the budget cut short joins the check-in line** (capacity amendment,
  2026-10-15, owner decision C4). The `camera_starting` answer a deferral gave above sends the
  player's browser to ask again on its own back-off, and who got the next token was luck. A
  deferred `required` claim is now answered `queued`, in arrival order (§5.7); an `optional` camera
  yields to the line and never waits in it; `off` never meets it. The seat's proof is unchanged:
  the line orders who may SPEND, it grants nothing.

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
  **What counts, as built.** A reference counts when its own predicate, `on` or insert column list
  compares `fixture_id`. A bare scan, one with no fixture predicate at all (the sweep's
  `teardownCandidates` and `cameraCandidates`, and the scan of participants in `arbiterCandidates`),
  does not count, but it must SELECT `side` (its per-row consumer needs it) or be identified by its
  own primary key (`arbiterCandidates` selects `vp.id` and revokes by it). The guard also fails on any
  mention of a video table that is not one of those five reference shapes (`lock table`, `using`, a
  plain string), so a shape it cannot read is never skipped.

**A room whose meeting row cascades away with its fixture (D16 fix-2, V449).** A meeting row is the only
thing that tracks an ACTIVE vendor room, and it goes with its fixture: a stage delete, Rebuild fixtures, a
Swiss round reshaped to a smaller field, the undo of a generation, and every wider delete (division,
competition, organisation) leave up to two rooms per board active with live player tokens. The delete cannot
end them (no vendor call in its transaction; the writes run under the tenant role, which cannot read the
sealed meetings table to collect them first), so a trigger on `fixture_video_meetings` (`after delete ... when
old.ended_at is null`, security definer) parks each un-ended room in the sealed `video_rooms_to_end` (no
foreign keys: the fixture is gone and the organisation may be going), in the deleting transaction, whatever
statement or cascade deleted it. The sweep (job 3b) ends each parked room and deletes the parking only after
the end succeeded, so a refused end is asked again; the vendor's documented not-found counts as gone. Latency
is one sweep tick; cost is the two teardown calls per room through the D21 budget.

**Schema** (a new delta after V446, D21's call-budget delta; numbered at the time):
- `fixture_video_meetings` gains `side text not null check (side in ('home','away'))`. Its
  key becomes `(fixture_id, side)`; `meeting_id` stays unique.
- `fixture_video_participants` and `fixture_video_guard_faults` gain `side` and reference
  `(fixture_id, side)` instead of `fixture_id`.
- The pairing stamp (`home_entrant_id`/`away_entrant_id`, R2-2) stays on each row, and each
  row is judged by BOTH entrants, in order, exactly as today (m1). A re-pair therefore
  retires BOTH rows, the stayer's included. The stayer's meeting held no opponent, so this
  is not about a leak; it keeps R2-2 and R3-1 working unchanged. As built, the retire is not
  left to a claim that finds a stale row on its own side: a claim that is about to CREATE
  retires the board's stale rows first, so a newcomer who lands on the side with nothing on
  file ends the stayer's old room too (walkthrough R3-1 found the gap; `realtimekit.test.ts`
  pins it).
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
- at `T_batch`+20 if nobody came (C2; not while the board's player is held in the check-in line,
  §5.7.8);
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
**Decided 2026-10-15 (C1, C4): stagger the opening (§3.2.1) and order the wait (§5.7).** The
ceiling is still not claimed closed; the "Capacity amendment" below says what the two mechanisms
do and what they cannot.

D16 puts 4 more calls on a board of about 24. Where it bites is the check-in ceiling: the
create's +1 lands in the burst, about 17 to 20 more calls (one per board) on D22's busiest minute
of 342 calls for 20 boards, 5 to 6%. The teardown's +2 and the evidence's +1 come after the games
and do not touch the burst. The ceiling can only fall; by how much is for the load re-run to say,
not for this arithmetic, because the cost per player is not constant near the cap.

**Capacity amendment (2026-10-15; owner decisions C1 to C6).**

*What the 1,200 is.* This section and `video/budget.ts` call the 1,200 the account's RealtimeKit
limit. Cloudflare's documentation (read 2026-10-15: `developers.cloudflare.com/realtime/realtimekit/limits/`
and `developers.cloudflare.com/fundamentals/api/reference/limits/`) says otherwise. RealtimeKit's
own limit is 3,500 requests per five minutes, and RealtimeKit calls COUNT TOWARD the global
Cloudflare API limit of 1,200 requests per five minutes per user (dashboard, API key and API
token use all count), which binds first. Over it, every API call is blocked for five minutes
(HTTP 429). Two consequences. The 900 bucket is 75% of a limit that anything else spending on the
same Cloudflare credentials also draws on (a script, a staff member in the dashboard), which the
bucket does not meter; its margin exists for exactly that, and `budget.ts` says "none today", so
that is to be checked, not assumed. And the ceiling cannot be raised in code (C6, §13). We do not
design around several tokens.

*What was decided.* Stagger the opening (timed batches, §3.2.1) and order the wait (the check-in
line, §5.7), built together: they share the budget and seat code and one load re-run answers
both.

*What a batch costs, with the per-player create in it.* One board's check-in spends, from the
table above: TWO meeting creates (one in each player's minting claim, at the burst's peak: the
shared meeting had one, spent by the first arrival, so the second player's mint cost 1 call and
now costs 2), plus for each player the mint (1), `k` reads of 3 and the token handed with the
seat (1). That is `2 + 2 × (3k + 2) = 6k + 6` calls a board, 18 at k = 2, plus up to 6 more when
T9's re-verify falls outside the trust window. D16's load A measured 605 calls for 20 boards
(30.25 a board, of which about 10 are teardown and evidence after the game), so 20.25 at the seat
(k ≈ 2.4) and about 202 a batch of ten; with a re-verify or two outside the window it reaches
about 210, the figure the capacity ruling was made on, which is used below. The per-PLAYER cost
the line plans with is the same table: `LINE_PLAYER_COST` = 1 (create) + 1 (mint) + 3 × 2
(reads) + 1 (token) = 9, against D22's measured 8.7 clean. The bucket holds `RTK_BUDGET_BURST` = 300 and
refills `RTK_BUDGET_REFILL_PER_S` = 2 a second. With n batches of demand d and a gap G, every
batch finds its d when `300 + (n − 1) × 2 × G ≥ n × d`, the bucket's cap permitting. For 30
boards, n = 3, d = 210:

| gap | bucket before each batch, and after | verdict |
|---|---|---|
| 60 s | 300 → 90; +120 = 210 → 0; +120 = 120 → needs 210 | batch 3 is SHORT by about 90 calls (45 s of refill) |
| 120 s | 300 → 90; +240 = 330, capped 300 → 90; +240 → 300 → 90 | fits |

The least gap for n = 3 is `(3d − 300) / (2 × 2)` = 82.5 s; for two batches 60 s; as n grows it
tends to `d / 2` = 105 s, so 120 s carries any number of batches. **The arithmetic already
predicts that 60 s fails test A below** (the third batch is short by about 90 calls). The line
turns that shortfall into a wait of about 45 s instead of a stranded board, and the re-run
decides. The ruling starts at 60 s; the owner may start at 120 s at once, it is one constant.

*How the re-run picks it.* The smaller of {60, 120} s for which A shows zero deferrals and an
arrival-to-seated p95 within twice the clean 20-board p95 (D22: 7.9 s; D16's load A: 6.3 s, so
within about 16 s). If 120 s still defers, the batch is too big for the bucket: record it and the
owner picks a smaller `CHECKIN_BATCH_SIZE`.

*What the line cannot do: the drain floor.* The bucket gives at most `300 + 2 × t` calls in t
seconds, so draining D calls takes at least `max(0, D − RTK_BUDGET_BURST) /
RTK_BUDGET_REFILL_PER_S` seconds. At `D = RTK_CALLS_PER_WINDOW` (900) that is exactly
`RTK_BUDGET_WINDOW_MS`, 300 s: "about five minutes" is that saturated case and not a constant. For
60 Required players it is 111 s at the clean 8.7 calls a player (D ≈ 522) and 333 s at D22's
starved 16.1 (D ≈ 966). Test B reports D, computes the floor from it and records the drain time
beside it. It never asserts a number of minutes.

*The line costs the vendor nothing.* A queued claim makes no vendor call; what it costs the
database is in §5.7.9. The budget's total does not change; what changes is who spends the next
token.

*Acceptance for the load re-run.* Prod build, fresh database, metered
(`REALTIMEKIT_METER_ANY_BASE=1`), `e2e/load/chess-30-boards.load.ts` extended. Every scenario
reports how many players, claims and boards it checked; zero is a failure.

*The metrics, defined once.* D16's load B reported "7 stranded", and its harness meant "a game
seen more than 30 s after the second seat", NOT "never created": all 30 of its boards got their
game. The word is retired here because it covers two different failures.
- **Seated** (a player) is the first claim answer with `seated: true`. **Arrival-to-seated** runs
  from that player's first claim request. **Both seated** (a board) is the later of its two
  players' seated instants.
- **Late create**: a board whose game was first seen more than `CREATE_PROMPT_S` = 30 s after
  both seated (the harness reads each board's room snapshot at least once a second). This is what
  the old harness called stranded.
- **Never created**: a board with both players seated and no game once the settle window has
  ended. The run waits for every such board's game, for at most `2 × SWEEP_CADENCE_MS` (10 min)
  after the last seat, so the stranded-board arm (§5.2) gets two passes. Every late create must also
  land within `SWEEP_CADENCE_MS + STRANDED_CREATE_AFTER_MS` (310 s) of both seated, that arm's
  declared bound; one that does not is a defect even though it is not "never".
- **Wrong refusal**: any seat answer that is a refusal other than `camera_starting` and `queued`
  (both mean "not yet"), or a 429, given to a player the harness knows is entitled to a seat: on
  a playable board, inside their window, camera on. The room's own schedule must never meet the
  limiter.

- **A, three batches.** 30 Required boards in 3 batches, every player on the page before `T`.
  Pass: 0 never-created boards, 0 late creates, 0 wrong refusals. Recorded: seat deferrals,
  arrival-to-seated p95 per batch, both-seated-to-game p95 and maximum, calls in the busiest five
  minutes. The result picks the gap (above).
- **B, "late burst".** Every batch already open; 60 players (30 Required boards) arrive within
  60 s. Pass: 0 never created, 0 late creates, 0 wrong refusals, 0 inversions. A late create here
  means the completing claim's threshold (`LINE_COMPLETING_COST`, §5.7.3) is too low, and that is
  the constant to raise. Recorded: both-seated-to-game p95 and maximum; the line position each
  player was shown (it must never rise for a player who stayed: checked on every poll, the count of
  polls reported); the total drain time beside the floor computed from the run's own D (above);
  the busiest five minutes; the claim route's peak requests a second and database statements a
  second; and the bucket's level at every `queued` answer (a median above `LINE_CLAIM_COST`
  means the head-only gate left budget idle, and windowed admission, §12, is owed). It counts
  deferred MINTS and deferred READS apart: D16's load B (p95 448 s, 1,071 deferrals against
  D22's 223/274 s and 454/591) is read as the minting claim's create arriving at the burst's peak
  with no read cache to back it off, so the line must cover the mint (§5.7.3), and the count shows it
  does.
  An **inversion** is a pair of players X and Y, both queued, with X's `first_claim_at` before
  Y's and Y's `served_at` before X's. Excused, and counted apart in the report: a pair involving
  a player the run abandoned on purpose, and a pair where X's `queued_at` is later than Y's
  `released_at` (X was not waiting when Y was released). What is left must be 0. The harness's
  players have instant cameras, so camera pace adds none: the line orders who may SPEND, not
  whose camera comes on first, and a slow camera can seat a later arrival first without breaking
  it.
- **Regressions.** 20 Required boards (two batches): about 605 calls, 0 deferrals, 0 never
  created, 0 late creates, and **0 rows with `queued_at`**: the line stays inert when it is not
  needed, which is the evidence for "the line empties, back to today's path". Mixed 10 Required +
  10 Optional + 10 Off: green as D16's load C (366 calls), and no `off` or `optional` player has
  a line row with `queued_at`.

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
  the budget can carry"), and the number goes to the owner. *(Superseded 2026-10-15 for the
  30-board case: scenarios A and B of the Capacity amendment above replace this record-only
  run with an acceptance.)*
- The vendor title carries the side, and `online-chess-privacy.test.tsx` pins the new
  literal.

### 5.7 The check-in line (amended 2026-10-15; owner decision C4)

#### 5.7.1 What it is, and what it is not

When the vendor-call bucket (§5.6.8) is dry, a `required` seat claim is deferred. Until now the
player's browser answered that by asking again on its own back-off (1, 2, 4, 8 s,
`CAMERA_EVIDENCE_MAX_POLLS` times, then a button), so which player got the next token was luck:
D16's load B, 60 players arriving together, took 1,071 deferrals and a seat p95 of 448 s. The
line makes it an order: **first come, first served, one place per player.**

- It orders **who may spend** the bucket on the seat path. It grants no seat: the camera proof of
  §5.2 is unchanged and the head of the line still has to pass it.
- It covers **every Required claim before the seat, the mint as well as the reads.** A deferred
  MINT (the meeting create and the participant add of a player's first claim, 2 calls at the
  burst's peak, with no read cache to back it off) is exactly as much a `queued` claim as a
  deferred read: both are the same `RealtimeKitDeferred` caught in `verifyRequiredSeat`.
- **`off` never meets it.** `seatPlayer` returns before any vendor call for policy `off` and for
  the D11 override; the line is not consulted and no row is written.
- **`optional` never waits in it, and yields to it.** An optional seat is granted without a tile
  when the budget is spent (`cameraRetry`), so there is no seat to wait for. But while the line
  holds a live waiting entry, an optional claim and the camera-token ask (`cameraTokenForSeat`,
  which reaches the vendor only through `seatPlayer`'s optional branch) make no vendor call and
  answer the existing `cameraRetry` shape; with the line empty they spend as today. The tile is a
  nicety, the seat is not.
- It is **Postgres**, like the budget and the seat limiter, because Redis is inert in dev, e2e and
  the load test. The client polls; nothing is pushed.

#### 5.7.2 The ledger

A new delta, **V449 on this branch** (V448 is its last; numbered at the time and renumbered at
merge, as V446 to V448 are). `fixture_seat_line` has one row per `(fixture_id, person_id)`, a
**stay**:

- `fixture_id`, `person_id`: both `on delete cascade`, so the row goes with its board and its
  person and no cleanup job exists to forget.
- `budget_key text`: the bucket this player spends from, `budgetKey(baseUrl, accountId)`. The
  line is per bucket (§5.7.6).
- `first_claim_at timestamptz`: the stay's **arrival**, the line's order key. Stamped once, on the
  database clock, by the stay's first Required claim, whether or not it is ever deferred.
- `last_seen_at timestamptz`: the last claim that reached the gate. Liveness (§5.7.5).
- `waiting boolean`: held by the budget right now. Set when a claim is deferred or blocked,
  cleared when a claim gets through or is served.
- `queued_at`, `released_at`, `served_at` (all null until they happen): the stay's history, kept
  for the load report and for debugging. `served_at` is stamped with the check-in.
- Checks: `queued_at >= first_claim_at` and `served_at >= first_claim_at`.
- Index `(budget_key, first_claim_at, fixture_id, person_id) where waiting and served_at is null`:
  the line's order.
- **A stay ends** when it is served or abandoned (`last_seen_at` older than
  `LINE_ABANDON_AFTER_MS`). A claim that finds a served or an abandoned row starts a NEW stay in
  the same statement: `first_claim_at = now`, `waiting = false`, the history cleared. That is
  how a re-opened round, a re-pair and a returning player all start clean without a delete.
- **Sealed like V439, V446 and V447:** RLS enabled AND forced, no policy, no grant for `app_user`;
  only the privileged client reaches it, and `online-chess-video-schema.test.ts` reads the
  catalogue (its sealed-table count rises by one). No `org_id`: it is not a tenant table. Two small
  rows per Required board per round.
- The same delta adds `'line'` to V447's check on `fixture_seat_asks.route`: a closed set on
  purpose, so a third door cannot ship unlimited (§5.7.3). If no environment has applied V447 the
  build may amend it instead (an unmerged migration is amended, not corrected forward); the
  controller says which.

#### 5.7.3 The gate

The module is `server/external-play/seat-line.ts`, in the shape of `seat-ask-limit.ts` and
`video/budget.ts`: privileged client, the database's clock, an `opts.at` test seam. `budget.ts`
gains `peekRealtimeKitCall(key)`, which returns the bucket's tokens after the same refill formula
the spend uses, spending nothing (a test pins that a peek and a take at one `at` agree).

**Which claims are gated.** A claim is gated when the camera policy is `required`, the board has no
override and no game, the club is offered online chess, and the caller's check-in does not already
count (they are not yet seated). Everything else is today's path: an already-seated player
re-claiming (a reload, the camera's re-entry) is not an arrival and is not gated.

**The order key** is `(first_claim_at, fixture_id, person_id)`, total. **Live** is `last_seen_at`
within `LINE_ABANDON_AFTER_MS`. For a gated claim, in one short sequence:

1. Upsert the stay (arrival and liveness), one statement.
2. `ahead` = the live, `waiting`, unserved rows of the same `budget_key` whose key is below this
   claim's. Position is `ahead + 1`.
3. Decide:
   - `ahead > 0` → **blocked.** Mark this stay `waiting` (`queued_at` if it is the first time),
     spend NOTHING, answer `queued` with the position. This is how a new arrival behind an
     existing line joins its tail without spending a call: **a claim may not spend budget ahead of
     an earlier waiting entry**, and a later arrival is later whatever it asks.
   - `ahead = 0`, this stay is `waiting`, and the bucket holds fewer tokens than the claim needs →
     **head, not yet.** Answer `queued` at position 1, spend nothing. A head that went when the
     bucket held one token would make the first of its calls and be deferred between two of them,
     throwing the work away (the cost D22 measured: 14.6 to 16.1 calls a player against 8.7 clean).
     What the claim needs is `LINE_CLAIM_COST` = 4, the most one claim can spend: a reading claim
     is 3 reads + 1 token, a minting claim at most 2 (the meeting create and the participant add).
     When this claim would **complete** its board (the opponent is already seated, so a seat here
     triggers the create and T9's re-verify of the opponent, whose pass in a line is usually older
     than `SEAT_RECHECK_TRUST_MS`), it needs `LINE_COMPLETING_COST` = `LINE_CLAIM_COST` + 3 = 7,
     so the create that follows finds its tokens and the board is not stranded behind the
     claim that seated it (§5.7.7).
   - otherwise → **go.** Stamp `released_at`, run the claim. If it gets through without a
     deferral: `waiting = false`. If it is deferred mid-claim (a concurrent spender took the
     tokens): `waiting = true`, `queued_at` if first, answer `queued`. A seat granted: `served_at`
     with the check-in stamp.
4. **The line empty is today's path.** With no live waiting row in the bucket, an arrival that is
   not itself waiting goes straight through: the same calls as before this section, plus the
   upsert. The token threshold applies to a stay that is already `waiting`, never to a fresh one.
   A deferral then makes THAT claim the first entry, and the next arrival queues behind it.

**What the claim answers.** A new seat refusal `queued`, beside `camera_starting`:
`{ seated: false, reason: "queued", participant: null, line: { position, etaS, pollMs } }`. It is
not a camera refusal and carries no token; the room keeps the token it already holds, as it does
across a `camera_starting` that could not look. `seatPlayer` marks the answer it gives where it
catches `RealtimeKitDeferred` in `verifyRequiredSeat` (`budgetDeferred`); `claimRoomSeat` turns
that into `queued`. T9's re-verify (`recheck`) keeps reading `camera_starting`/`not_ready` as
today: it is not a claim and never queues.

**Counting against the seat limiter, without breaking its number.** V447's 20 asks a minute on the
seat door is the owner's ruling (D21-fix-4: KEEP 20) and is derived from the room's own worst case
of one attempt per device. A queued player polls every few seconds, and counted there those polls
would eat the asks a check-in attempt needs and leave the button dead for a minute (the D21-fix-4
re-review's m-a). So: a claim from a player who holds a live waiting entry counts under the new
`line` door, with its own limit, derived the way the other two are, `LINE_ASK_LIMIT` = `DEVICES ×
(⌈SEAT_ASK_WINDOW_S × 1000 / LINE_POLL_MS⌉ + 2)` = 2 × (20 + 2) = 44, and a test replays the
client's schedule against it; and when the gate then lets that claim spend, it ALSO counts one
`seat` ask first, so nothing that can reach the vendor escapes the per-seat bound. A player with
no entry (an arrival, or a claim after a reload) counts under `seat` as today.

#### 5.7.4 Player, not board

The order is over **players**.
- The cost is per player. With a meeting per player (§5.6) the two players of a board share no
  vendor call: each has their own create, mint, reads and token.
- Arrival is per player. Each person presses Check in on their own device, "You are number N" is a
  statement about a person, and the complaint it prevents ("they came after me") is a person's.
- Ordering by board would make the first player of a board wait on an absent or late partner, or
  order boards by their later arrival, which is the later player's place anyway.
- The price: a board's two players can sit far apart (number 3 and number 40), and the board starts
  when the later is seated. That is true with no line at all. The create is the last step of the
  later player's service and rides it (§5.7.7).

#### 5.7.5 Abandonment, reload and two tabs

- **Abandonment.** An entry whose client has not claimed for `LINE_ABANDON_AFTER_MS` = 20 s is not
  live: it no longer blocks the line behind it, is not counted in anyone's position, and a dead
  head stalls the line for at most that long. The client polls every `LINE_POLL_MS` = 3 s for the
  first `LINE_NEAR_POSITIONS` = 5 places and every `LINE_POLL_SLOW_MS` = 5 s behind them, so an
  honest client must miss four slow polls to lose its place. The server sends `pollMs` with every
  answer.
- **Coming back late.** The first claim after that starts a new stay at the back, and the card
  says so ("You left the line, so you are at the back again"). The price is stated up front on the
  line card: "Keep this page open." A phone that locks for more than 20 s loses its place; the
  card asks for a screen wake lock while queued (best effort), and the claim fires at once when the
  page becomes visible again. A longer grace would let one dead head stall everyone for as long;
  the rule is simple and testable.
- **Reload and a second tab are one entry**: `(fixture_id, person_id)` is the key, so both read
  the same row, keep the same `first_claim_at` and see the same position. Two first claims racing
  meet on the primary key and make one row. Two tabs polling double that person's poll rate, which
  the `line` limit's two devices allow for.

#### 5.7.6 One line per bucket: what that means between clubs

The line's scope is `budget_key`, the vendor host and account the calls spend from, so **in
production it is one line for the whole platform and every club shares it**; in dev, e2e and the
load test each fixture vendor is its own bucket and its own line, as it is its own bucket today.
- **Fairness is arrival order across clubs.** A club that opens a 40-board round and whose 80
  players arrive before another club's four makes those four wait behind them: about 4.5 s a place
  (`LINE_PLAYER_COST` 9 over the refill of 2 a second), so number 81 waits about six minutes. That
  is the honest price of one shared resource and of first come, first served, the only order a
  player can check against their own clock.
- **Why not a share per club.** The bucket is the platform's, not a club's. Batches already spread
  one club's own wave, so a line long enough to matter needs two large events to collide or a late
  burst. And a fair share needs a policy (by organisation, by plan) that the owner has not made and
  this spec does not invent. Open question Q2 (§13).
- The position is a count. The `queued` answer names nobody and the position counts players of
  other clubs without saying whose.

#### 5.7.7 What spends outside the line, and why

- **T9's create and its re-verify (`recheck`), and the sweep's stranded-board create: exempt.**
  The create is the last step of the later player's service, and it rides the gate decision that
  claim passed: the gate reserved its tokens (`LINE_COMPLETING_COST`). Making it queue would
  re-strand a board whose two players have both waited their turn, which is the failure the load
  acceptance forbids, and the sweep's create (every five minutes) is the backlog of such steps, not
  a new arrival. It is bounded: at most 6 calls a board (a re-verify read of 3 for each seat), and 0
  inside `SEAT_RECHECK_TRUST_MS`; the completing claim's gate reserves the opponent's 3
  (`LINE_COMPLETING_COST`, §5.7.3), the claimant's own seat having just been verified.
  The line also helps it: with one claimant spending at a time the sweep's create no longer loses
  the race for tokens to thirty polling players (D22). The exception is MEASURED, not assumed: the
  load report counts creates made while an earlier waiting entry existed, and a test proves both
  directions (a create runs with the line non-empty; gating it strands a board and goes red).
- **Housekeeping: teardown, camera evidence, the arbiter, a re-pair's stale-meeting ends: exempt.**
  They are bounded (about 10 calls a board, after the game) and starving them has a cost the
  line's does not: an unended meeting stays active at the vendor.
- **Optional yields** (§5.7.1). **An already-seated player's re-claim** is not gated.

#### 5.7.8 The deadline and the line

This is a consequence the owner's ruling did not name. `T_batch` + 20 exists to stop waiting for
people who did not come (§3.6). A player the budget is holding in the line has come, and
forfeiting them for the platform's delay punishes the wrong party. A line of L players drains in
about `L × 4.5 s`, so the deadline binds only beyond roughly 260 places, but "only beyond" is not
"never", and a walkover written in error is a wrong result. So **the deadline judges arrival, not
the seat**: *arrived in time* is a ledger row whose `first_claim_at` is not after the board's
deadline.
- **The no-show skips a board with a live waiting entry on either side** (`noShow`'s candidate
  test; it is judged again on the next pass). Without it a player in the line reads as absent: the
  sweep forfeits them, or with their opponent seated holds the board for the organiser as
  `not_started`.
- **The seat gate admits a past-deadline claim** (`seatPlayer`, `phase === "closed"`) when the
  caller's own row arrived in time and is waiting and live, beside `isReentry`. A player who
  arrived AFTER the deadline gets `window_closed` as today, line or no line.
- **The check-in is dated at the arrival.** `stampFixtureCheckIn` (`me.ts`) stamps `now()` and
  takes no time; a seat granted after the deadline would be stamped outside the window and
  `checkInCounts` would read it as never having come. A line-served seat past the deadline stamps
  `first_claim_at`, through an optional `at` argument (default `now()`), so the QR self check-in
  that shares the function is untouched.
- **The create is allowed past the deadline** for a board whose BOTH players arrived in time and
  were served, for `LINE_CREATE_GRACE_MS` = 2 × `SWEEP_CADENCE_MS` after the later `served_at`
  (two sweep passes, so one failed pass can retry); after that the board falls to the existing
  `not_started` hold for the organiser. That is `createGameIfReady`'s `not_ready` gate,
  `createAtDequeue`'s refusal, `mintRetry`'s deadline test, the `ready` row's `expires_at`, the
  teardown's "nobody played" test and `expectedEnd`'s base (its comment, "T9 creates no game
  after the round's deadline", stops being true and becomes a guard).
- An absent opponent is forfeited normally once the present player is no longer waiting.
- One function carries it, `boardPhase(now, board)`, whose hold (`lineHoldsBoard`) is read once
  per request, so the arithmetic in `window.ts` stays pure. The room shows `open` for a held
  board, not the closed card.

#### 5.7.9 What the player is told, and what it costs

- **The estimate.** `etaS` = `ceil(max(0, position × LINE_PLAYER_COST − tokens) /
  RTK_BUDGET_REFILL_PER_S)`, with `LINE_PLAYER_COST` = 9 (1 create + 1 mint + 3 × 2 reads + 1 token,
  against D22's measured 8.7) and `tokens` the bucket's level at the answer. It is an estimate:
  "about". The card rounds up to the next 5 s, and shows minutes above 90 s.
- **The cadence.** `pollMs` is `LINE_POLL_MS` for places 1 to 5, `LINE_POLL_SLOW_MS` behind them,
  and for the head never longer than the time until the bucket holds what its claim needs.
- **The client.** While the seat answer is `queued` the room claims again after `pollMs`, with NO
  upper bound (`CAMERA_EVIDENCE_MAX_POLLS` bounds `camera_starting` and does not apply), until the
  answer changes; it also claims at once on `visibilitychange`. The screen is the check-in card,
  now showing the line (§6.1).
- **The cost to the database.** A queued poll is the room's identity read, one limiter upsert, one
  stay upsert and one count: about 6 to 10 statements. Sixty players at 3 to 5 s is about 13
  requests a second, about 100 statements a second for the length of the drain; test B records
  both (§5.6.8).
- **The trace.** One `info` line per gate decision (`fixtureId`, decision, position), so how often
  the line forms in production can be counted. The seat limiter and the budget leave no such
  trace today.
- **The wire.** `queued` joins `SEAT_REFUSAL_REASONS`, `SeatRefusal`, the room's `REFUSAL_SCREEN`
  (which is total over `SeatRefusal`, so a missed one fails compilation), `schemas.ts` and the
  OpenAPI entry of `POST …/external-play/room`.

#### 5.7.10 Constants

| Constant | Value | Where it comes from |
|---|---|---|
| `CHECKIN_BATCH_SIZE` | 10 | owner, C1 |
| `CHECKIN_BATCH_GAP_MS` | 60,000 (60 or 120 s after the re-run) | owner, C1; §5.6.8 |
| `LINE_ABANDON_AFTER_MS` | 20,000 | four missed slow polls |
| `LINE_POLL_MS` / `LINE_POLL_SLOW_MS` / `LINE_NEAR_POSITIONS` | 3,000 / 5,000 / 5 | the cadence above |
| `LINE_CLAIM_COST` | 4 | the largest one claim spends (§5.6.8's per-claim bullets); a test asserts it is at least the largest count the fixture server sees for any claim shape |
| `LINE_COMPLETING_COST` | 7 | `LINE_CLAIM_COST` + one re-verify read of 3 |
| `LINE_PLAYER_COST` | 9 | 1 + 1 + 3k + 1 at k = 2 |
| `LINE_ASK_LIMIT` | 44 | derived from the poll cadence, as V447's two are |
| `LINE_CREATE_GRACE_MS` | 2 × `SWEEP_CADENCE_MS` | §5.7.8 |
| `CREATE_PROMPT_S` | 30 | the load metrics (§5.6.8) |

Every value is one named constant, declared once; a test derives each expectation from the
declarations it follows, not from a number typed twice.

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

### 6.1 Waiting states (amended 2026-10-15; owner decisions C1, C4, C5)

Three new states sit before "window open, not seated". All are public, phone-first surfaces: the
**full mobile bar** applies (320, 768 and 1280, no horizontal page scroll, 44 px targets, accessible
names), and the build brief names the frontend-design skill. Every string is a new key in all four
locale dictionaries, regenerated with `gen-keys`; none is hardcoded English.

**1. The batch wait: "Your check-in opens at HH:MM".** A board in batch `i ≥ 1` (§3.2.1) before
`T_batch(i)` has phase `before` with the board's own `opensAt`. Today `phase "before"` maps to
`room-screen.ts`'s `notOpened` screen, whose copy (`externalPlay.room.state.notOpened.title` and
`.body`: "This round has not been opened yet." / "Your organiser will open it; you will be emailed
when it starts.") is false for a board whose round IS open. So `before` splits on whether the
round is stamped:
- no stamp (`round_not_open`): the existing `notOpened` screen, unchanged;
- stamped, board's batch not yet open (`checkin_not_open`): a new screen, keys
  `externalPlay.room.state.batchWait.title` ("Your check-in opens soon"),
  `.body` ("Your board is in a later group so that everyone can check in without queueing.
  Keep this page open: it will let you in at {time}.") and `.time` (the time itself).
- **The time** is the board's `opensAt` in the VIEWER's local zone and locale (`Intl.DateTimeFormat`,
  hour and minute), **rounded UP to the next minute** so the page never promises a minute before
  the server opens (the gap is a multiple of a minute at 60 and 120 s, but the constant may be set
  to any value). A server that sends `opensAt` also sends its own `now`; the client computes the
  difference, so a phone with a wrong clock still counts down correctly.
- **The room re-reads at `opensAt`** with a small jitter (0 to 2 s, so ten boards' players do not
  hit the door in the same instant), not before and not on a poll; it does not start a poll of its
  own for the wait. After the re-read the normal check-in card appears.
- Organisers and the invite mail say the same (§3.2.1).

**2. The line card: "You're number N in line, about X s".** When the seat answer is `queued` (§5.7)
the check-in card shows, in place of the preflight actions: the position ("You are number 7 in
line"; "number N" avoids ordinal grammar in four languages), the estimate ("about 30 seconds", "about
2 minutes" above 90 s, rounded UP to 5 s), and "Keep this page open: if you leave it for more than
20 seconds you go to the back of the line." Keys `externalPlay.room.state.line.title`, `.body`,
`.eta.seconds`, `.eta.minutes` (plural-aware), `.left` ("You left the line, so you are at the back
again."). The position text is a `role="status"` region that announces a change, not every poll.
The card keeps the camera tile the player already holds; it never shows a refusal reason, because
nothing was refused. The screen is `REFUSAL_SCREEN.queued = "checkin"` (the same screen with the line
in it), so a new `SeatRefusal` that is missed fails compilation.

**3. The seat 429 wait: a countdown, then the button comes back (C5).** The seat door allows 20 asks
a minute per seat (one person on one board; V447, `fixture_seat_asks`), which is the room's own
worst case for one check-in attempt on each of two devices (§5.7.3). A SECOND attempt on one device inside the minute (the player
presses Check in, the camera is slow, they press Try again after 23 s) can meet the limit: today
the client treats the 429 as "later", burns a poll step and shows nothing, so the button does
nothing for up to 60 s. The new behaviour:
- On a 429 from the seat door the room parses `Retry-After`: a whole number of seconds, clamped to
  1 to `SEAT_ASK_WINDOW_S` (60); missing, zero, negative or not a number counts as 60 (the longest
  the limiter can hold).
- The button is **disabled**, with a visible countdown ("Try again in 23 s"), on a MONOTONIC clock
  (`performance.now()`), so a changed system clock neither shortens nor stretches it. It is
  re-enabled when the countdown reaches zero, **not before**. Keys
  `externalPlay.room.state.seatWait.title` and `.countdown`.
- While waiting, the client's own guard sends no seat request (a keyboard activation of the
  disabled button, a visibility change and the `camera_starting` back-off all stop at the guard),
  so the wait does not spend asks.
- A second 429 (a second tab spent them) restarts the countdown from its new `Retry-After`.
- The countdown is a `role="status"` region that announces its start and its end, not each second.
- **Sentences to reword, because they now say the opposite.** The wait is shown, so "silent to the
  player" and "the client treats it as later" are false:
  1. `apps/web/src/server/api-v1/openapi.ts`, the entry for `POST …/external-play/room`, line 209:
     "429 RATE_LIMITED: more claims from this seat on this board inside a minute than the room
     itself ever sends (Retry-After is the seconds until the minute reopens; nothing was done)
     — a client treats it as \"later\"". Reword to: one check-in attempt per device per minute,
     where an attempt is the press and the room's own follow-up asks, with room for two devices; a
     second attempt on the same device inside the minute can be refused; the room shows a countdown
     from `Retry-After` and offers the button again. (The camera door's sentence on line 212, limit
     10, is unchanged.) The brief named `server/http/openapi.ts`, which does not exist.
  2. `apps/web/src/server/external-play/seat-ask-limit.ts`, its header: "WHAT AN OVER-LIMIT ASK
     COSTS THE PLAYER … sees the button do nothing until the window ends. That is a person mashing a
     button for a minute" and "THE NUMBERS ARE THE ROOM'S WORST CASE … a limit under what the room
     itself sends would refuse the product's own check-in". The second sentence stays true and
     gains the queued poll's own door (`line`, §5.7.3); the first stops being true.
  3. The D21-fix-4 report, `.superpowers/sdd/2026-10-09-chess-in-page-board-and-camera/t17b-fix-2-report.md`
     line 822, "The client already treats a 429 as \"later\"." and line 849, "A 429 on a seat claim
     leaves `seat` unchanged and burns one poll step in room-shell; silent to the player, no new
     copy (none was owed…). Only a hand-rolled or looping client can reach it; the legitimate worst
     case is under the limit by construction and by a replay test." Line 849's last sentence was
     reasoned for the room's own schedule and the re-review's finding m-a disproved it for a
     deliberate second press (Try again after about 23 s). Add a dated note, or the next reader
     trusts it.
  Where the "one attempt per device" phrase itself appears, it is the progress ruling m-a, not a
  string in the code: the three places above are the sentences that overstate it.

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

### 8.1 Capacity amendment tests (2026-10-15)

Owed with the capacity build (§11). They follow `docs/superpowers/TEST-STRATEGY.md`: every
sweep, count and invariant below reports how many items it checked and zero is a failure; an
expected value comes from the constant or the rulebook it follows, never from the code under
test; "cannot happen" owes an assertion and a test that reaches it; each guard is mutated ONCE,
restored from a `cp` backup (never `git checkout <file>`), and the mutant must turn a named test
red with the suite's total unchanged. The sport registry is swept by default; the one
single-sport test says why. Each test drives the REAL producer and consumer (the route, the
reducer, the client), because a fixture on both ends proves the fixture.

**Batches (§3.2.1)**
1. **Boundaries** from the constants: for `CHECKIN_BATCH_SIZE` = S, boards ranked S−1 and S sit in
   batches 0 and 1, and 2S−1 and 2S in batches 1 and 2 (the owner's "10/11 and 20/21" in
   one-based terms). Derived from the exported constant, so a change of size moves the test. A
   25-board round gives batches of 10, 10 and 5 (count of boards per batch checked, 25 in total).
2. **The gap comes from the constant.** `T_batch(i) − round_opened_at = i × CHECKIN_BATCH_GAP_MS`
   with the exported constant; the default (60,000) is pinned in one separate test that says why,
   so changing it is a deliberate act and no other test moves.
3. **Rank over every row.** A bye and a withdrawn entrant keep their rank; a round with a gap in
   `seq_in_round`, a duplicate `seq_in_round` across pools, and a re-pair after the round opened
   all rank by position, not by number (N boards checked per case).
4. **A round of at most S boards is unchanged**: one batch, window and deadline identical to the
   pre-amendment values, call for call.
5. **Deadline shift through every reader.** One table lists the readers (§3.2.1): seat, check-in
   counts, compose, claim, create, dequeue, `expires_at`, sweep window, no-show, mint retry,
   teardown, `expectedEnd`, invite, resend, open-round-view. The test drives each at batch 0 and at
   batch 2 and asserts the deadline is `T_batch + 20 min` for that board; it reports the number of
   readers checked and fails if it is not the number in the table, so a new reader must be added to
   both. A source guard (counts reported) forbids a reader that calls `windowFor(round_opened_at)`
   directly; the one shared `boardAnchor`/`boardRankSql` carries it. Mutate: drop the batch term
   from one reader, red.
6. **The owed deadline test (C2).** At `now = T + 21 min` with the 60 s gap, the sweep forfeits a
   batch-0 board with an absent player and does NOT forfeit a board of batch index 2, whose
   deadline is `T + 22 min`; at `T + 22 min` it does. Derive the minutes from the constants. A
   second case at a gap of 120 s moves the answer (index 2's deadline is `T + 24 min`), so the test
   can tell the constant was read.
7. **Early claim.** A claim before its batch opens is refused `checkin_not_open`, makes ZERO vendor
   calls (counted at the fixture server), and writes no stay and no check-in. A claim for a round
   with no stamp is still `round_not_open`.
8. **Late arrival (C3).** A player of a later batch who arrives 15 min after their batch opened is
   seated when the camera passes, and the game is created when the second is seated; there is no
   clock penalty. A player who arrives after `T_batch + 20` gets `window_closed`.
9. **Sport registry.** Sweep `supportsOnlinePlay` over the registry: exactly one sport
   (`boardgame`) plays online, pinned at 1, so a sport that gains online play fails the test and
   forces the batch rules to be widened on purpose. Every other sport's round is unbatched.
10. **The waiting card.** "Your check-in opens at HH:MM" renders in all four locales, in the
    viewer's local zone (a test with two zones gives two different strings from one `opensAt`),
    rounded up (12:00:01 shows 12:01), and the room re-reads at `opensAt` and not before (fake
    timers: one tick before, no request; at it, one request). The invite mail names the board's
    deadline and its opens-at time. The organiser's round view shows the batch length
    (100 boards at 60 s is 9 minutes).

**The line (§5.7)**
11. **FIFO with tokens one at a time.** Drive the real claim route with N players arriving in a
    known order and the bucket refilled one token at a time; the order of `served_at` equals the
    order of `first_claim_at`, **inversion count 0, and the number of pairs checked is reported**
    (zero pairs is a failure). Mutant: delete the "an earlier waiting entry blocks this claim"
    predicate, the inversion count rises above 0 and the test is red.
12. **The head waits for its cost.** The head does not spend until the bucket holds
    `LINE_CLAIM_COST`, and a completing claim until `LINE_COMPLETING_COST`; a bucket at one token
    produces `queued` with zero calls. Mutant: release at one token, red (and the claim spends and is
    deferred mid-way, which the test counts).
13. **A new arrival joins the tail with zero vendor calls** while the line is non-empty, whatever it
    asks.
14. **The line empty is today's path**: a recorded sequence of calls for one board with the line
    empty equals the pre-amendment sequence, call for call, and writes no `queued_at`.
15. **Abandonment at the boundary.** An entry silent for `LINE_ABANDON_AFTER_MS − 1` ms still
    blocks the line behind it; at `LINE_ABANDON_AFTER_MS` it does not. A player who returns after is at
    the back and told so. Mutate the comparison (`<` for `<=`), red.
16. **Reload and a second tab are one entry**: same `first_claim_at`, same position; two first
    claims racing at once make one row.
17. **Off and the override never enter**: no row, no `queued`, with a line pre-seeded and non-empty,
    for the D11 override too. **Optional never queues and spends nothing** while the line is non-empty,
    answering `cameraRetry`; with the line empty it spends as before.
18. **Buckets.** Two budget keys are independent lines; two organisations on one key share one.
19. **The create is not gated.** With the line non-empty, a board whose second player is seated
    gets its game. Mutant: gate the create, a board strands (never created) and the test is red.
20. **Deferred mints queue too (§5.7.1).** Starve the bucket so the first claim's mint is deferred:
    the answer is `queued`, the order holds, and a mutant that treats a deferred mint as an error
    or as `camera_starting` reds the test. The count of deferred mints and reads is reported
    separately.
21. **The deadline and the line (§5.7.8).** A queued player is not forfeited; is seated past the
    deadline; the check-in is dated `first_claim_at` and counts in `checkInCounts`; the game is
    created. An absent opponent is forfeited. A player who first arrives after the deadline gets
    `window_closed` even with a line. The create grace ends after `LINE_CREATE_GRACE_MS`.
22. **The `line` limit is derived and replayed**: `LINE_ASK_LIMIT` computed from the poll cadence,
    and a replay of the client's real schedule for 60 s at two devices stays under it; the
    `seat` limit (20) is unchanged and its own replay stays green.
23. **The wire**: `queued` through the real route, the schema and the real client reducer to the
    card, with the position and `pollMs`; `REFUSAL_SCREEN` stays total (a compile-time check, plus
    a runtime count of the reasons covered).

**The seat 429 wait (§6.1)**
24. With fake timers: after a 429 with `Retry-After: 23` the button is disabled at 22.999 s and
    enabled at 23 s, **not before**; the countdown ticks on the monotonic clock (a changed
    `Date.now()` does not move it); no request is sent while waiting; a second 429 restarts from
    its new header. A missing, zero, negative and non-numeric header each count as 60. Mutant:
    re-enable on the first tick, red. Strings in four locales (count of locales checked).

**The load re-run (§5.6.8)** is the acceptance for the whole amendment and is not a vitest:
scenarios A and B, the regressions, and the metrics defined there, with the number of players,
claims and boards each checked. Then, as for every UI change, the e2e spec for the match room
(`match-room.spec.ts` states for the batch wait, the line and the 429 wait), its walkthrough, and
screenshots at 1280, 320 and 768 with no horizontal scroll.

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
- **The capacity build (§3.2.1, §5.7, §6.1, §8.1) comes AFTER the D16 review loop closes**, on its
  own branch off the merged tree. It touches `window.ts`, `preflight.ts`, `room.ts`, `sweep.ts`,
  `invite.ts`, `budget.ts`, `seat-ask-limit.ts`, the room client and one new migration. The
  migration is "the next free number at the time, renumbered at merge": this spec says V449 because
  V448 is the branch's last, and the build takes whatever is next on the tree it starts from. This
  document is the only thing this amendment changes; nothing in it is built.

---

## 12. Out of scope for ship 1

Recording and retention. A second camera angle (the model allows N participants per
player, so it is config later, not a migration). Takeback. Rated games. A new arbiter
role — the existing organiser/admin role is used, one migration after `scorer` was
retired. Variants other than standard.

Out of scope for the capacity amendment (2026-10-15), each with the reason it is not built:
- **A fair share per club** (§5.7.6): needs a policy the owner has not made.
- **A scheduler across rounds or divisions**: batches order the boards of one (stage, round); two
  events at once meet in the line, which is the safety net and not a plan.
- **A server push for "your turn"** (SSE, realtime): the client polls; Redis and realtime are inert
  in dev and the load test, and a poll of 3 to 5 s is within the estimate's error.
- **Windowed admission** (K claimants spend at once instead of the head alone): built only if test
  B's median bucket level at `queued` answers shows the head-only gate left budget idle (§5.6.8).
- **Ordering by board** instead of by player (§5.7.4): argued against there.
- **Several Cloudflare API tokens** to multiply the limit (§13, C6): not designed around.

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
  late). About 24 Required boards a minute is the ceiling the runs support. D16 adds +4 calls
  per board and consumes the same bucket; its load re-run is listed with the tests owed.
  **Decided 2026-10-15 (C1, C4): stagger a round's opening in timed batches (§3.2.1) and order the
  wait in a first-come line (§5.7).** Not built; the acceptance is the load re-run of §5.6.8 and the
  tests of §8.1. It reduces the peak and orders the rest; it does not raise the ceiling, and the
  drain floor of §5.6.8 stands (about `(D − 300) / 2` seconds for D metered calls).
- **Owner action, nothing built (C6): ask Cloudflare to raise the account's API limit before a big
  event.** The 900-call bucket is 75% of Cloudflare's global limit of 1,200 API requests per five
  minutes PER USER (dashboard, API key and API token use all count; over it, every API call is
  blocked for five minutes with HTTP 429). RealtimeKit's own limit is 3,500 per five minutes
  (recording APIs 1,000 per 50 s, separate), and RealtimeKit calls count toward the global one.
  Only an Enterprise plan can "contact Cloudflare Support to raise the Client API per user, GraphQL,
  or API token limits": no self-serve increase is documented (read 2026-10-15,
  `developers.cloudflare.com/realtime/realtimekit/limits/` and
  `developers.cloudflare.com/fundamentals/api/reference/limits/`). The owner asks Cloudflare
  (Enterprise or Support) to raise the account's API limit; the lead time is Cloudflare's, so ask
  before the event and not during it. Once granted, `RTK_VENDOR_LIMIT_PER_WINDOW` and the derived
  `RTK_CALLS_PER_WINDOW`, `RTK_BUDGET_BURST` and `RTK_BUDGET_REFILL_PER_S` are one constant to
  change and the load re-run is repeated. The 1,200 is a limit on the whole Cloudflare user: any
  script, staff dashboard session or other API use on the same credentials spends from it, and
  `budget.ts` assumes there is none today. That assumption is to be re-verified, and
  `budget.ts` and §5.6.8 said the limit was RealtimeKit's.
- **Open questions from the capacity amendment**, each with a recommendation. The spec is written as
  recommended and reads as ruled until the owner says otherwise; none blocks the build's start.
  1. **Q1: a round whose camera policy is `off`** (§3.2.1). Batching exists for the vendor budget,
     and an `off` board spends nothing at the check-in. Recommend: an `off` round is ONE batch (no
     stagger), one predicate in `boardAnchor` on the stage's camera policy. Without it a
     100-board round with no cameras waits 9 minutes for nothing. (`optional` still staggers: its
     tile spends when the budget allows.)
  2. **Q2: global FIFO or a share per club** (§5.7.6). Recommend the global FIFO: it is the only
     order a player can check against their own clock; a per-club share needs a policy.
  3. **Q3: Optional yields to the line** (§5.7.1). Recommend yes: an optional tile is a nicety and
     spending on it ahead of a Required seat reverses the order the line promises.
  4. **Q4: the deadline carve-out** (§5.7.8) is an addition beyond the ruling: a player in the
     line is not forfeited and their check-in is dated at their arrival. Recommend yes: otherwise a
     long line forfeits people the platform delayed. It is bounded by `LINE_CREATE_GRACE_MS`.
  5. **Q5: start gap 60 or 120 s.** The bucket arithmetic (§5.6.8) says 60 s leaves the third batch
     about 90 calls short and 120 s fits. Recommend starting at 120 s: it costs 3 minutes of
     stagger on 30 boards and removes the case where the line is the normal path. The ruling says
     60 s and the load re-run decides; this is only the recommendation to skip a known-red step.
  6. **Q6: the `fixture_seat_asks` check.** Extend V447's `route` check with a new migration, or
     amend V447, depends on whether any environment has applied it (§5.7.2); the controller says.
