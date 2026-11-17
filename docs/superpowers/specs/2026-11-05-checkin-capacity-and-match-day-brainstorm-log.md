# Check-in capacity and Match Day all in one — brainstorm log

The record of how `2026-11-05-checkin-capacity-design.md` and `2026-11-05-match-day-all-in-one-design.md` came to say what they say: the questions asked, the answers given in the owner's own words, the options shown and set aside, the reviewers' questions and how each was settled. The design files carry only decisions and current truth; this file carries the path. Both designs came out of one conversation on 2026-11-05, so they share one log. Local file only.

## Files

| File | What it is |
|---|---|
| `docs/superpowers/specs/2026-11-05-checkin-capacity-design.md` | The capacity design: pre-minted rooms, webhook presence plus one read as camera proof, the re-derived check-in line, the arbiter's participant for the life of a game, paced teardown, rollout. Approved 2026-11-05. |
| `docs/superpowers/specs/2026-11-05-match-day-all-in-one-design.md` | The Match Day design: every online round inside Match Day, the board panel with the chess board or both cameras, the round panel, the two Needs you kinds, the arbiter page removed. Approved 2026-11-05. |
| `docs/superpowers/plans/2026-11-05-checkin-capacity-1-presence.md` | Plan 1: the webhook receiver, the presence table, the fixture vendor's signed webhooks, the shadow comparison. |
| `docs/superpowers/plans/2026-11-05-checkin-capacity-2-premint-proof.md` | Plan 2: the pre-mint job, the one-read seat proof, the priced line, the paced sweep. |
| `docs/superpowers/plans/2026-11-05-checkin-capacity-3-arbiter.md` | Plan 3: the arbiter's participant kept for the game, per-meeting chains, presence in the loader; tasks 4 to 6 withdrawn by the Match Day design. |
| `docs/superpowers/plans/2026-11-05-match-day-all-in-one.md` | The Match Day plan, ten tasks. |
| `docs/superpowers/specs/2026-11-05-checkin-capacity-and-match-day-brainstorm-log.md` | This file. |
| `mockups/layout.html` | Mockup round 1: three layouts for online boards inside Match Day, A list and focus, B board grid with cameras on every card, C state grid and focus. |
| `mockups/focus.html` | Mockup round 2: the board panel in Match Day's own layout, first pass. |
| `mockups/focus-v2.html` | Mockup round 3, the screens the owner approved: board in focus with cameras, board in focus with the chess board, round in focus. |
| `mockups/approved-match-day.html` | The approved screens re-pushed on 2026-11-06 with the two refinements the plan made after approval. |

The four HTML files are fragments written for the brainstorming companion server's frame: opened directly they show the mockup bodies styled and the outer page plain.

## 2026-11-05: the queue question that opened it

The owner pasted `creation-queue.ts`, the in-process serial queue that paces Lichess challenge creation, and asked: "can we use qstash for queue?" Then the shape they wanted: "All I want, when checkin both players -> put in a queue -> create the challage and show to the players and then go to next checked in player ?"

Found in the code: that queue already exists and already does this. `claimRoomSeat` calls `createGameIfReady` when both players are checked in, the creation is enqueued per fixture, the Lichess claim is taken at dequeue, and a throttled creation is retried by the sweep. Nothing was missing on the Lichess side.

The first answer on QStash called it a good fit, on the assumption of a serverless host. The survey showed Next.js standalone on Fly.io with long-lived machines, a Cloudflare Worker cron, Postgres, and an Upstash-backed rate limiter already in the tree. The answer was withdrawn and the owner told it had changed.

## 2026-11-05: the real limit

Owner: "there is a rate limiting with cloudflare as well right when video checkin". Confirmed: "yes  This is RealtimeKit's API quota, so if 5 clubs with plays 10 entrants what will happen?"

Sized from the code: a board costs 15 to 45 vendor calls at check-in (two rooms, two participants, up to five camera reads of three calls each per player, two tokens), about 3 per arbiter hop, about 4 at teardown and about 6 after the match for camera evidence; play itself costs nothing. Against the Postgres token bucket (900 calls a window, burst 300, refill 2 a second) five clubs of ten are 375 to 1,125 calls and one to seven minutes of waiting.

Owner: "yes. /Users/asubramanian-mac2/Downloads/seazn.club-main/apps/web and how do we solve that show that exact seconds/min waiting period?" Answered from the code: the check-in line already computes and shows an ETA (`lineWire`), with a reservation of 21 calls per stay.

Owner: "I want to have a scalable solution", and mid-turn: "try to use redis or upstash".

Owner: "are we talking about initial min or during the play as well? like one board for two camera player then arbiter can join and view the video.  if a club playe 10 players for multiple rounds and have 5 club". Answered: the cost is at check-in and at the arbiter's hops; play is free; every round pays check-in again.

Owner: "not sure same mins, what happen 20 clubs and start want to play". Sized: 1,500 to 4,500 calls, ten to thirty-five minutes, which misses the check-in deadlines. That number is what the design had to remove.

## 2026-11-05: the design choice

Options put to the owner for the camera proof: keep today's three-call read per attempt, or take the vendor's `participantJoined` webhook as presence plus one peer-report read, with a fallback to the full read when no webhook arrives. And for the rooms: mint them ahead of the rush rather than at check-in.

Owner: "webhook plus one peer report read is fine, write it up and what happen if we refresh the page and to the arbiter and are you saying that we will create the meet which are does not matter for which club to play and so we can create the 100 meeting in advance and doesn't cost us then we both player checked in with camera then do we add them into that meeting". The design was started before those questions were answered; the owner said "first answer my questions", and they were answered first from then on: refresh behavior per role became §6.7; the arbiter became §6.5; empty meetings cost nothing, so rooms can be made ahead, and players are added when they are known.

Owner: " paid while the bucket is idle. what does it mean?" Explained: the bucket refills at two calls a second whether or not anyone is checking in, so quiet minutes are capacity that goes unused; a job that mints rooms ahead spends that idle refill instead of competing with players at the open.

Owner: "one meeting per player, and arbiter need to watch multiple onboard so he can join and view then click another board  , check the code". Recorded: one meeting per player stays; the arbiter hops from board to board. Mid-turn: "how do we improve artiber view?" and "show all board video at a time?" The cost of a grid was laid out (one participant mint per meeting joined, arbiter minutes billed per meeting) and the owner was asked how many boards one club's arbiter needs live at once and on what device.

Owner: "And for the arbiter grid: how many boards does one club's arbiter need live on screen at once, and is that on a laptop = laptpop, we can limit based on need". Recorded: laptop only, an organizer-set limit. The grid was later dropped altogether by the Match Day design (§9).

## 2026-11-05: builder check

An independent reviewer read the capacity design. One defect it caught: the pre-mint was keyed on "an hour before the window opens", and a window exists only from the organizer's Open press. Verified in `open-round.ts` and `window.ts`, fixed: the pre-mint keys on pairing, and the cost model gained a "paired at the open" column as the guaranteed floor.

Three questions only the owner could answer, brought in one message: (1) are rounds paired ahead, or paired minutes before the open; (2) are there production rounds with required cameras now, for a week of shadow mode; (3) do they control the Cloudflare zone, for a WAF skip rule on the webhook path.

Owner: "1. Let's do before scheduled date and for round 2, we can do when round 1 is paired\n2 No.\n3 we will check and fix, \n\nNo code. Only Design". Recorded: round 1 is paired before the scheduled date and later rounds while the previous one is current; no production camera rounds exist, so a staging load run is the gate; the owner adds the zone rule. "No code. Only Design" became the standing word for the whole session.

Owner, when asked whether Swiss rounds have fixture rows before pairing: "Ok, we do have a placeholder for swiss even before pairing". Recorded: rooms are pre-minted on the placeholder, participants at pairing.

Owner: "approve". The design was approved at 20:57 UTC and the three capacity plans written.

## 2026-11-05: questions after the plans

Owner: "show me list a tasks". The three plans' tasks were listed.

Owner: "so do we need to use qstash?" No. The pre-mint runs as a cron-worker job on the existing minute trigger; Redis enters only if the staging load run shows gate contention (design §7); QStash stays an optional scheduler nobody needs yet.

Owner: "can we merge arbiter and match day panel ?" The two pages' shapes and what a merge would cost were laid out. Owner: "remove arbiter panel and move the functionality to match day". That reopened brainstorming for a second design.

## 2026-11-05: Match Day all in one

Asked whether one division can have both online and in-hall boards. Owner: "assume that same division won't do tht". Recorded: a division is online or in-hall, never both.

Asked what the page must show for a round. Owner: "simply, we will load number board on that round, each side show a play and optional camera and addtional arbiter settings".

Mid-turn: "Also I don't see chess online when division creation?" Answered from the code: online play is decided by the division's sport configuration (`divisionPlaysOnline`) and the club's `online-chess` flag, not by a field on the creation form.

The visual companion was offered. Owner: "don't do that in artifact, create simple html server to show me". The brainstorming skill's local server was started and every screen pushed to it.

Round 1, `layout.html`, three layouts: A list and focus (Match Day's own shape), B board grid with cameras on every card, C state grid and focus. Owner: "A, I need exactly same layout of matchday". Mid-turn: "simple, instead of loading the scoring board, we will be loading chess board / or camera if rquired".

Round 2, `focus.html`, the board panel drawn in Match Day's layout. Owner: "ok, just design/ui looks, otherwise ok". Mid-turn, when the write-up still read as an arbiter-panel redesign: "we are not redesigning arbiter panel, we are desinging the matchday which include all in one". The design was reframed around Match Day as the one page.

Round 3, `focus-v2.html`, three states of the same page: board in focus with cameras, board in focus with the chess board, round in focus. The design was written from it. Owner: "approve", at 23:11 UTC.

Options set aside in this round: layout B, layout C, the all-boards video grid from the capacity design's §6.5, and a separate arbiter page in any form.

Recorded in the design as the designer's calls, for the owner to overturn: one row per (division, stage, round); held and flagged boards of earlier rounds under a "Needs a decision" sub-group; two per-board Needs you kinds; who sees cameras and presses (`EDITOR_ROLES`, finish-type decisions for every editor, start-type only where the club is offered online chess); the arbiter page redirects to Match Day with the board in focus.

## 2026-11-05 to 2026-11-06: the reviews

Owner: "all plan written and reviewed?" then "yes independent reviewer". Four fresh reviewers read the four plans against the designs and the code. Findings folded in, the notable ones: adoption of a pre-minted room at the seat made unconditional; the line's prices follow the proof flag into the gate; the arbiter's floor sits on the pool, not the raw bucket; the arbiter's subject keeps its nonce and the find-or-make goes through the row; a presence read is filtered to the player's own participant; the webhook key's shape is normalized and its refetch floored; the Match Day rows come from the arbiter loader and the open-round reader together.

Owner: "added path to ~/.cloudeng/tools-config.json". The Downloads checkout became searchable, and every guessed path in the plans was replaced by a verified one.

Owner, mid-turn: "if you need review of 4 then do it". A second pass by four more fresh reviewers. Folded in: plan 2's two derived constants removed so every price takes the read cost as a required argument, the fallback clock starting at the camera report's own stamp, the pre-mint report separating "flag off" and "no player yet" from failures; plan 1's refetch floor applying to Cloudflare's base only, the shadow test pointed at the fixture server the way the contract test does, the registration script guarded against running on import, the staging load run kept local; plan 3's row-based find-or-make and eviction rules; the Match Day plan listing one row per stage's latest opened round, taking only paired views as "before" rows, dropping listed boards from the no-court rows, opening a Needs you board in place, and wrapping the board panel's test in the dictionary provider. One finding was wrong and not applied: the camera-verified stamp column exists (V451 line 279).

## 2026-11-06: files moved, this log

Owner: "show html flie mock?" The companion server was restarted and the approved screens re-pushed as `approved-match-day.html`.

Owner: "show me html files and design md\nincluding all questons and brainstoring? same or separate files". Answered: separate. The mockups are fragments for the server, the designs carry decisions, and the questions lived only in the chat.

Owner: "show me a full path to open in a finder, move all newly changed files to /Users/asubramanian-mac2/Documents/s-new-u". The two designs, the four plans and the four mockups were moved there, repo-relative paths kept for the markdown, mockups under `mockups/`; the companion server was stopped.

Owner: "write and move it there". This file.

## Open as of 2026-11-06

- The execution method for the four plans, in the order capacity 1, capacity 2, capacity 3 tasks 1 to 3, Match Day, capacity 3 task 7. Subagent-driven recommended: the plans hand interfaces across tasks and a shipped mistake lands in a player's check-in.
- Execution needs a real git clone or worktree; the Downloads copy has no `.git`.
- Standalone copies of the four mockups, offered, not yet asked for.
- No code before the owner says so.

## 2026-11-17: plans re-pinned against main

Owner: "Revise Chess External Play, there is a new design doc", pointing at the three capacity plans. Main had moved twelve days since they were written on a git-less copy. Each plan was re-pinned against origin/main 59c72dd361 by a separate agent: migrations renumbered V527 / V528 / V529, moved server paths, false premises and tests the plans would have broken. Seven items came back for the owner, with recommendations: the arbiter admitted to a pre-minted empty room while only the pre-mint flag is on; the pre-mint cron row before the sweep; the fallback clock re-stamped by the heartbeat; `sweep.ts` over the split threshold; the 23505 racing-tab match; the DELETE route with no caller; the order of work. Owner: "Ok apply rec." Recorded in the design's §12.
