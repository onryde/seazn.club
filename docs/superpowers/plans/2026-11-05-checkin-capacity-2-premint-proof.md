# Check-in capacity, plan 2 of 3: pre-mint and the one-read proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut a board's kickoff cost from 15 to 45 vendor calls to 6 or 7 for a room-pre-minted board whose cameras come on at once (each player: the participant the first claim adds, whose own token goes to the browser; one peer-report read; the seat's token; plus the re-verify's read unless it is trusted), by minting rooms ahead of the open, seating on the presence table plus one peer-report read, re-deriving the check-in line's reservation from the new cost, and capping and deferring the sweep's vendor calls. (The earlier "5" left out the first claim's call. Since owner ruling 2026-11-17 (2) the job makes no participant, and that call is the claim's own add.)

**Architecture:** A new cron job (`/api/cron/external-play-premint`, every firing of the fast trigger) makes rooms, and only rooms, for every board of an unopened round in an online, camera-on division, nearest round first: placeholder or paired in a started division, paired only in a division still in setup (Swiss pairs round 1 there). A placeholder's rooms carry an "unadopted" stamp (both entrant columns null); the seat's first claim on the paired board adopts them and adds the player's participant, as today. The job never adopts and makes no participant (owner ruling 2026-11-17 (2), Revision notes). The job defers while any check-in window is open. The seat reads presence from the table (0 calls) and proves the camera with one peer-report read, refusing a peer the report says has left. A 3-call fallback read runs only when the browser has reported a live camera for 10 s with no presence on file, counted from no earlier than the token this page was handed, and is counted. The line stamps each stay's price from the price table below (8 or 9 with the proof flag; 20 or 21 without; retiring an earlier pairing's rooms, up to 4 calls a board, stays outside it) and sums prices ahead for the estimate. The sweep runs arbiter revocations first, uncapped. Its other vendor-calling jobs share a 45-call cap per pass, and teardown and post-match evidence defer while any check-in window is open. Post-match evidence keeps reading peers from the vendor. Everything stays in Postgres; the presence table is plan 1's.

**Tech Stack:** as plan 1; plus the cron Worker's schedule table (`apps/cron-worker/src/schedule.ts`) and its drift test.

**Spec:** `docs/superpowers/specs/2026-11-05-checkin-capacity-design.md` sections 4, 5, 6.1, 6.3, 6.4, 6.6, 6.7, 6.8 steps 4 and 5, 9, 10. **Depends on plan 1** (`docs/superpowers/plans/2026-11-05-checkin-capacity-1-presence.md`): the presence table and `presence.ts` readers must exist.

> **Revised 2026-11-17** against origin/main 59c72dd361: migration renumbered V493 → V528; cron row re-pinned to today's table and its two tests (drift `checked` 14 → 16, `schedule.test.ts` row lists); vague test paths and greps pinned to real files; tests and readers the plan missed added (schema not-null case, `BOTH_SIDES`, every reader of the line constants, `room.ts queueDeferred`). The owner ruled on the four open items on 2026-11-17 (Revision notes, "Resolved by owner 2026-11-17"): the cron row stands where placed; the fallback clock reads a new first-live stamp (`camera_live_first_at`, V528, Task 6); `sweep.ts` is split first, in its own pure-move PR (Task 0); the arbiter's empty-room case belongs to plan 3.

**Execution order (owner, 2026-11-17):** capacity plan 1 → this plan (Task 0 first, as its own PR, then Tasks 1-11) → plan 3 Tasks 1-3 → the Match Day plan (`docs/superpowers/plans/2026-11-05-match-day-all-in-one.md`) → plan 3 Task 7. **Flags wait for plan 3 Task 1** (review fixes 2026-11-17, finding 8): this plan's code merges in the order above, but Task 11 turns no flag on, on staging or production, until plan 3 Task 1 (the arbiter's join refused until the player's counted check-in, with the proof flag off) is merged AND deployed. Before that, today's arbiter rule (a meeting row for the current pairing) admits an arbiter into every pre-minted room the job stamped with its board's pairing, before anyone has joined.

## Global Constraints

- The three stamp states of a `fixture_video_meetings` row: the pairing it was made for (today), the nil UUID `RETIRED_PAIR` ("belongs to no pairing, retire me", today), and UNADOPTED, both entrant columns null ("take the first pairing"). An unadopted row is never stale, is never retired by the sweep, the claim or the re-open, and is adopted by one statement (`adoptRooms`), which only the claim's `ensureMeeting` runs. The job never adopts (owner ruling 2026-11-17 (2)).
- The seat's verdict is the vendor's peer report. The presence table says WHO to read and WHEN; the browser's own camera report says only when a read is worth making and when the fallback is due. Neither ever seats a player (spec §2, §6.3).
- The one-reader guard for the line's five columns (`apps/web/src/server/external-play/__tests__/seat-line-one-reader.test.ts`) and the per-player video source guards (`_video-source-scan.ts` and its rule test) keep passing; their allow-lists and counts are updated in the task that moves them, never loosened.
- Constants, declared once in `seat-line.ts`: `LINE_MINT_ROOM_CALLS = 1`, `LINE_MINT_PARTICIPANT_CALLS = 1`, `LINE_READ_CALLS = 1`, `LINE_FALLBACK_READ_CALLS = 3`, `LINE_TOKEN_CALLS = 1`, `LINE_SESSION_PROBE_CALLS = 1` (today's read when no session is live: `seatCameraEvidence` stops after `GET active-session`, realtimekit.ts ~656), `LINE_END_ROOM_CALLS = 2` (`endMeeting`: kick-all, then deactivate; the cost suite asserts it equal to the fixture's count), `LINE_CLAIM_COST = 6` (asserted `= 2 * LINE_END_ROOM_CALLS + LINE_MINT_ROOM_CALLS + LINE_MINT_PARTICIPANT_CALLS`: a board's two stale rooms ended, its own created, the participant added). The old constants `LINE_RESERVATION`, `LINE_RECHECK_COST` and `LINE_COMPLETING_LEVEL` are removed, nowhere re-declared. The bucket's constants (`budget.ts`) do not change. Today `seat-line.ts` also declares `LINE_MINT_CALLS = 2` and `LINE_READ_CALLS = 3` (lines 50-51): `LINE_MINT_CALLS` goes with the three above (its two halves are the two mint constants), and `LINE_READ_CALLS` keeps its name with a NEW value, 1, so every current reader of either is re-read in Task 7 (listed there) rather than left to change meaning silently.
- **The stay price table** (owner ruling R1, 2026-11-17; re-derived from `preflight.ts verifyRequiredSeat`, lines ~437-465 of the ref tree, and the cost suite's schedule, `external-play-line-cost.test.ts` lines 144-169). A stay's own schedule from its first claim is: the FIRST claim's calls, then up to `CAMERA_EVIDENCE_MAX_POLLS + 1` (= 6) reads of a camera still starting, the last of them the verdict, then the token handed with the verdict. So `lineReservation(mint, readCalls) = lineFirstClaimCalls(mint, readCalls) + readCalls * (CAMERA_EVIDENCE_MAX_POLLS + 1) + LINE_TOKEN_CALLS`, with `readCalls` REQUIRED (1 under `EXTERNAL_PLAY_PRESENCE_PROOF=1`, 3 without). The first claim, by what is on file:
  - `"room"`, a current-pairing room on file (adopted, or unadopted) and no participant: **the normal round**, what the pre-mint job leaves. The participant is minted (`LINE_MINT_PARTICIPANT_CALLS`), and its token comes with the mint at no extra cost. The minting claim makes no read (`minted !== null → camera_required`, preflight.ts ~446-453). Total 1, on either flag state.
  - `"none"`, a current-pairing room with the player's participant already on it. The job makes no participant (owner ruling 2026-11-17 (2)), so only an EARLIER claim made it: a stay restarted (`upsertStay`'s restart, seat-line.ts ~168: served, ended or lapsed) after a claim of the same player minted. Nothing is minted, so nothing carries a token: the claim pays `refreshParticipantToken` (preflight.ts ~464, `minted ?? refresh…`), `LINE_TOKEN_CALLS`. With the proof flag the verdict costs nothing when no presence is on file and the fallback clock has not started (Task 6). Without it, the verdict is today's read; priced as the 1-call probe that finds no live session (`LINE_SESSION_PROBE_CALLS`). So the first claim is priced 1 with the flag and 2 without. A restarted stay whose player is still in the room (a live session or presence) can spend more on its first claim; that excess is uncovered cost (2) below, the client's own re-claims.
  - `"all"`, everything else: no unended room for the current pairing on this side (nothing on file, or only a room stamped for an EARLIER pairing, or an ended one). The claim mints the room and the participant (`LINE_MINT_ROOM_CALLS + LINE_MINT_PARTICIPANT_CALLS`). Total 2. A room on file stamped for an earlier pairing (adopted, then re-paired before the open; finding 5) is priced `"all"` too. Its retirement, which the claim's `ensureMeeting → retireStaleMeeting` makes before it mints (realtimekit.ts ~424-441), costs `LINE_END_ROOM_CALLS` (2) per unended stale room, at most 2 rooms. That is **+4 calls per board, outside the reservation**, the design's decision (spec §6.4, 2026-11-17), named in seat-line.ts beside the P1 note. `LINE_CLAIM_COST` (6) stays the declared most ONE claim spends, and it is still asserted `<= LINE_RESERVATION_MIN`.

  | stay | proof flag ON (`readCalls` 1) | proof flag OFF (`readCalls` 3) |
  |---|---|---|
  | `room` (room pre-minted: the normal round) | 1 + 6 + 1 = **8** | 1 + 18 + 1 = **20** |
  | `none` (participant already on file: a restarted stay; the job never produces it) | 1 + 6 + 1 = **8** | 2 + 18 + 1 = **21** |
  | `all` (nothing on file) | 2 + 6 + 1 = **9** | 2 + 18 + 1 = **21** (today's `LINE_RESERVATION`) |
  | `all`, with a room stamped for an earlier pairing (retire + mint) | **9**, plus up to 4 per board uncovered (13 realized at most) | **21**, plus up to 4 per board uncovered (25 realized at most) |

  These are the design's figures (§6.4 as revised by owner ruling 2026-11-17 (2): room pre-minted 8 / 20, nothing on file 9 / 21), re-derived here independently: they agree. Re-checked after ruling (2): `LINE_RESERVATION_MIN = lineReservation("none", LINE_READ_CALLS)` is still 8, equal to `"room"`'s 8 (the normal round's price; the equality is asserted in the test), and still the least of the six prices; `LINE_CLAIM_COST` (6) `<= LINE_RESERVATION_MIN` still holds. `LINE_RESERVATION_MAX = lineReservation("all", LINE_FALLBACK_READ_CALLS)` = 21, the price of a stay the gate has not priced. `lineRecheckCost(readCalls) = readCalls`. `lineCompletingLevel(readCalls) = readCalls + LINE_TOKEN_CALLS + lineRecheckCost(readCalls)`: (1) = 3, (3) = 7.
  **What "nothing under-reserves" means, exactly.** A stay's stamped price covers that stay's own schedule from its first claim, on either flag state and for every stay kind. That is the same promise today's `LINE_RESERVATION` makes. Four costs stay outside the price, and each is either named in seat-line.ts or counted. (1) The P1 dead-camera re-claims (seat-line.ts lines 57-65, unchanged). (2) A reload inside a stay, which re-spends the first claim's token and can restart the read schedule, and a restarted `"none"` stay whose player is still in the room; this is the same class as P1, the client's own re-asks. (3) Retiring an earlier pairing's rooms, up to +4 per board (above). (4) The fallback read (Task 6), `LINE_FALLBACK_READ_CALLS - LINE_READ_CALLS` = 2 calls over the price, at most once per page. It is counted (`presenceFallbackCount`, plus the log line) and expected to be 0 while webhooks deliver. The earlier text, "nothing under-reserves during the rollout", claimed more than this and was false for `"none"` (8 > 7 with the flag, 21 > 19 without: finding 4).
- Pre-mint pacing: `PREMINT_CALL_INTERVAL_MS = 1_000` between vendor calls (an injectable `wait`), `PREMINT_PASS_BUDGET_MS = 45_000`, so a pass makes at most `PREMINT_CALLS_PER_PASS = 45` calls and never bursts; 100 boards' rooms take about four and a half minutes on prod's minute trigger. `SWEEP_RTK_CALLS_PER_PASS = Math.floor(SWEEP_PASS_BUDGET_MS / 1000)` (45). `FIRST_READ_AFTER_JOIN_MS = 1_500`, `PRESENCE_FALLBACK_MS = 10_000`.
- A capped budget always composes with what the caller injected: `cappedBudget(cap, rtk.budget ?? platformSpend(rtk))`, so a test that injects `rtk.budget` still drives the deferral.
- Flags: `EXTERNAL_PLAY_PREMINT=1` enables the job's work (the route still answers; a disabled pass reports `skipped: 1`), `EXTERNAL_PLAY_PRESENCE_PROOF=1` enables the one-read path (unset: today's 3-call read, presence untouched). `EXTERNAL_PLAY_WINDOW_DEFER=0` turns OFF the open-window deferral of the sweep and the pre-mint (Task 8). Unset or any other value defers. It is set only on the e2e server, whose specs share one platform-wide window state (Task 8 says why), and it is an operator's rollback lever. All three are read from `process.env` at call time, so a test flips them per case.
- A new cron row needs: the route under `/api/cron/`, the row in `JOBS`, numeric `failed` and `skipped` declared in code in a module the route imports, and the drift test's `checked` count raised by the number of `failureCounts` added; a row on the fast trigger also enters `apps/cron-worker/test/schedule.test.ts`'s typed `FAST_ROWS` and `EVERY_FIRING_ROWS` lists (table order) and gets its own row-pin case, as `stream-tick`, `external-play` and `email-outbox` have.
- Everything else from plan 1's Global Constraints (sealed tables, numbering, scoped runs, four dictionaries, commits). This plan's migration is V529 (main's highest is V526 on 2026-11-17, origin/main 59c72dd361; plan 1 takes V527, plan 3 V530).
- Exact files the tasks below name: the line's guard `apps/web/src/server/external-play/__tests__/seat-line-one-reader.test.ts`; the camera-report guard is rule 2 of `apps/web/src/server/external-play/__tests__/video-per-player-source-guard.test.ts` over `CAMERA_REPORT_COLUMNS` in `_video-source-scan.ts` (today's two sites: `camera-report.ts` and `room.ts`; the allow-list itself is `CAMERA_REPORT_FILES`, line 80 of the guard test); rule 1's both-sides allow-list is `BOTH_SIDES` (line 46 of the same test); the line's cost suite `apps/web/src/server/usecases/__tests__/external-play-line-cost.test.ts` with its helper `_external-play-line.ts`; the seeds `_external-play-seed.ts` in the same directory; the load harness `apps/web/e2e/load/chess-30-boards.load.ts`.

## Review Focus

1. **A board whose rooms the job has not reached, or re-paired after its rooms were stamped for a pairing (by the job on a board already paired, or by a claim's adoption), at the open.** Expected: the seat finds whatever is on file and finishes the mint itself (room: `ensureMeeting` adopts or creates, retiring a room stamped for the earlier pairing first; participant: `playerParticipant` mints, as on every board now that the job makes none). Priced `"all"` (9 with the flag, 21 without) whether nothing is on file or a room for the earlier pairing is (finding 5). The latter's retirement, up to 4 calls a board, is the design's named uncovered cost. Pinned in Task 6 (`stayMintOf`) and Task 7 (the table's rows, both flag states, and the re-paired case measured at 9 + 4 / 21 + 4).
2. **Webhooks stop mid-round.** Expected: a player whose browser reports `live` for 10 s with no presence row is seated through the 3-call fallback. That read is taken under `claimEvidenceRead`, so racing claims make one. The fallback is counted, and presence rows from that read carry `source = 'read'`. A reload with webhooks UP never fires it: the clock starts no earlier than the token handed to the page (finding 6). Pinned in Task 6.
3. **The vendor's clock ahead of ours.** Expected: a `joined_at` in the future reads as "just joined": `camera_starting` until 1.5 s have passed on our clock (`since = least(joinedAt, receivedAt)`, finding 13), never a refusal, never a read every claim. Pinned in Task 6.
4. **A placeholder that never gets paired.** Expected: an unadopted room on an opened round's unpaired board is ended by the teardown after the round's deadline (2 calls, off-peak) and never retired as stale. Pinned in Task 8 (finding 16's case).
5. **Twenty rounds opening together while the sweep has work.** Expected: arbiter revocations still run first and uncapped (R5). Teardown and evidence defer while any window is open, while the stale-room retire and parked rooms still run. The pre-mint defers too (R3), and the pass reports the deferral. Pinned in Task 8.
6. **A peer that left while its webhook was lost.** Expected: the one read sees the peer report's `participant.left_at`, so the player is not seated on that peer. The same claim takes the counted departed-peer fallback (the session list says who is really there), and nothing closes the webhook row: only a webhook does (plan 1). Includes plan 1's fallback-then-leave sequence (R4). Pinned in Task 6.
7. **The pre-mint's deferral on a busy day** (accepted by ruling R3): with staggered rounds, a window somewhere is open for most of the day (each round's bound runs `ROUND_WINDOW_TAIL_MS`, 30 min, past its last batch). So the job may pre-mint little, and a round opened then pays the `"all"` price. The Task 11 staging run records how often a pass is deferred.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/web/src/server/usecases/external-play/sweep.ts` → `apps/web/src/server/usecases/external-play/sweep/` (Task 0, its own PR) | A verbatim split behind an identical barrel; no behaviour change. |
| `db/migration/deltas/V529__premint_and_line_price.sql` (create) | Nullable stamps on meetings (if NOT NULL today), `fixture_seat_line.reservation` and `recheck_cost`, and on `fixture_video_participants` the columns `presence_fallback_from`, `camera_live_first_at` and `token_issued_at`. |
| `apps/web/src/server/external-play/video/realtimekit.ts` (modify) | Unadopted rooms in `ensureMeeting`/`meetingOnFile`/`retireStaleMeeting`; `adoptRooms`; `peerReportCamera` (1 call, carries the report's `left_at`); `platformSpend` and `cappedBudget`; `SeatCamera` carries the peer. |
| `apps/web/src/server/usecases/external-play/open-round.ts` (modify) | The re-open (only) spares unended rooms made for the current pairing and unended unadopted rooms; the re-arm retires as today. |
| `apps/web/src/server/usecases/external-play/premint.ts` (create) | The pre-mint pass: candidates, rooms (rooms only: no adoption, no participant, owner ruling 2026-11-17 (2)), the cap, the report. |
| `apps/web/src/app/api/cron/external-play-premint/route.ts` (create), `apps/web/src/server/usecases/external-play/index.ts` (modify, export), `apps/cron-worker/src/schedule.ts` (modify), `apps/cron-worker/test/drift.test.ts` (modify), `apps/cron-worker/test/schedule.test.ts` (modify) | The job's door and schedule. |
| `apps/web/src/server/usecases/external-play/camera-reported.ts` (create, a leaf), `camera-report.ts` (modify), `room.ts` (modify), `apps/web/src/server/external-play/__tests__/_video-source-scan.ts` (modify) | `reportedCamera`, the one reader of the camera-report columns, in a leaf module; `camera-report.ts` keeps the one writer, and now also keeps the first-live stamp; room.ts, preflight.ts and later arbiter.ts call the reader. |
| `apps/web/src/server/usecases/external-play/preflight.ts` (modify) | The one-read proof, the fallback, the counter, `stayMintOf`; `Video` gains `peerReportCamera` (Task 6). |
| `apps/web/src/server/external-play/seat-line.ts` (modify) and its guard test; `apps/web/src/server/usecases/external-play/room.ts` (`queueDeferred`'s `GateAsk`) | The stamped price, the summed estimate. |
| `apps/web/src/server/external-play/round-open.ts` (modify), `apps/web/src/server/external-play/window.ts` (modify: the bound's constant tail) | `anyCheckinWindowOpen`. |
| `apps/web/src/server/usecases/external-play/sweep/` modules after Task 0: `pass.ts`, `teardown.ts`, `camera-evidence.ts`, `arbiter-revoke.ts`, `run.ts` (modify); `premint.ts` (modify: its deferral) | The vendor cap, the deferral, arbiter revocations first and uncapped. Post-match evidence keeps `listPeerIds` (R6): it never reads peers from presence. |
| `apps/web/src/server/external-play/creation-queue.ts` (modify) | The stale comment (spec §9). |
| `apps/web/e2e/walkthrough/chess-external-play.spec.ts` (modify), `apps/web/e2e/load/line-load.ts` and `apps/web/src/server/external-play/__tests__/line-load.test.ts` (modify: the mirrored price table and its pin) | The pre-minted round's cost, asserted from the fixture's call log (a LOCAL pre-check; the final gate is Task 11's staging run against real Cloudflare, R7). |

---

### Task 0: Split `sweep.ts` (prerequisite; its own pure-move PR, merged before Task 1 starts)

The owner's ruling (2026-11-17): `apps/web/src/server/usecases/external-play/sweep.ts` is 1504 lines, over `apps/web/src/server/MODULARIZATION.md`'s 1500-line line, and Task 8 adds to it. So it is split FIRST, as a separate PR that changes no behaviour. Every rule below is that file's (rules 1-9); read it before starting.

**Files:**
- Delete: `apps/web/src/server/usecases/external-play/sweep.ts`
- Create: `apps/web/src/server/usecases/external-play/sweep/index.ts` (the barrel) and the modules below
- Modify (source guards that pin the file BY PATH): `apps/web/src/server/external-play/__tests__/seat-line-one-reader.test.ts` (rows at lines 72, 73, 76; the per-file count at 272), `apps/web/src/server/external-play/__tests__/batch-anchor-source-guard.test.ts` (rows at lines 95, 98; the per-file count and its comment at 453-455)
- Modify (comment-only commit, rule 8): `apps/web/src/lib/__tests__/arbiter-view.test.ts` (lines 3-4 cite `usecases/external-play/sweep.ts`)
- Optional (rule 5): `apps/web/src/server/usecases/__tests__/external-play-sweep.test.ts` (5990 lines), split to mirror the modules

**The importers do not change** (rule "no importer edits in a split commit"). The specifier `@/server/usecases/external-play/sweep`, `../external-play/sweep`, `../../usecases/external-play/sweep`, `../sweep` and `./sweep` all resolve to `sweep/index.ts`. None of them names the file with a `.ts` extension. Today these are:
- the cron route `apps/web/src/app/api/cron/external-play/route.ts` (`import type { SweepReport }`) and its `route.test.ts` (`vi.importActual` on the same specifier);
- `apps/web/src/server/external-play/__tests__/line-load.test.ts`;
- in `apps/web/src/server/usecases/__tests__/`: `external-play-stranded-create.test.ts`, `external-play-checkin-extend-create.test.ts`, `external-play-board-budget.test.ts`, `_external-play-line-route.ts`, `external-play-line-completing.test.ts`, `external-play-batch-gap.test.ts` (dynamic `import`), `external-play-sweep.test.ts`, `external-play-checkin-extend.test.ts`;
- in `apps/web/src/server/usecases/external-play/`: the barrel `index.ts` (`export * from "./sweep"`), `room.ts` (`throttledRetryAt`), and `__tests__/open-round.test.ts`, `__tests__/video-rooms-to-end.test.ts`.

No test mocks the module (`vi.mock` / `vi.doMock` on it: none), so rule 4 has nothing to move.

**Modules** (by concern, using the file's own job headers; the line ranges are today's, re-pin them before moving):

| Module | Holds (today's lines) |
|---|---|
| `sweep/pass.ts` | The shared shape: imports, `SWEEP_JOBS`, `SweepJob`, `SweepReport`, `SweepDeps`, `SWEEP_PASS_BUDGET_MS`, `SWEEP_SETTLING_READS_PER_PASS`, `SWEEP_RECONCILE_BUDGET_MS`, `NETWORK_JOBS`, `playableWindow`, `bothCameFor`, `candidateAnchor`, `PLAYABLE_STATUSES`, `codeOf`, `type Pass`, `budgetSpent`, `each`, `orgScope` (1-305), and the "may be on file" helpers `BridgeFacts`, `claimIsLive`, `gameMayBeOnFile` (333-362). Also, so that the one direction holds (finding 10): `type ParkedRoom` (791; `SweepDeps.parkedRooms` at 147 names it, so leaving it in teardown.ts makes a pass ↔ teardown type cycle) and `anchorIfClosedNow` (409-416; job 1 calls it at 424 and job 3's `meetingIsDone` at 749, so leaving it in no-show.ts makes a job → job import). |
| `sweep/no-show.ts` | Job 0, close-unplayable (306-332), and Job 1, the deadline no-show, with its refusal and hold paths (363-571, less `anchorIfClosedNow`). |
| `sweep/mint-retry.ts` | Job 2 (572-685): `STRANDED_CREATE_AFTER_MS`, `retryCandidates`, `__retryCandidates`, `throttledRetryAt`, `mintRetry`. |
| `sweep/teardown.ts` | Job 3, meeting teardown (686-775), and Job 3b, parked rooms (776-813, less `type ParkedRoom`). |
| `sweep/reconcile.ts` | Job 4 (814-1060): `SWEEP_CADENCE_MS`, `SWEEP_BACKOFF_CAP_MS`, `SWEEP_NO_TRUTH_HOLD_AFTER`, `SWEEP_MOVE_BUDGET`, `expectedEndAt`, the reconcile candidates, reads and holds. |
| `sweep/camera-evidence.ts` | Job 5 (1061-1340): `CAMERA_EVIDENCE_AFTER_MS`, `CAMERA_EVIDENCE_GIVE_UP_MS`, `cameraCandidates`, `readCameraEvidence`, `settleCamera`, `cameraEvidence`, `giveUpUnread`. |
| `sweep/arbiter-revoke.ts` | Job 6 (1357-1422): `ARBITER_PARTICIPANT_TTL_MS`, the arbiter candidates and revoke. |
| `sweep/run.ts` | The pass (1341-1356 and 1423-1504): `SWEEP_LOCK`, `emptyReport`, `sweepExternalPlay`, `runPass`. **Including plan 1 Task 10b's retention step**: the one `prunePresence` call plan 1 adds to `runPass` before the parked-rooms job (plan 1 merges first, so it is in the file this task splits). It moves verbatim with `runPass`, together with its import from `@/server/external-play/video/presence`. Its wiring case in `external-play-sweep.test.ts` must stay green, and the Step 2 surface list must still find it. Plan 1 shifts every line number in this table, so re-pin them all. |
| `sweep/index.ts` | The barrel: a header comment listing each module and what it owns, one line each, then re-exports of exactly the names `sweep.ts` exported today. Nothing private is re-exported. |

The siblings import from `pass.ts` or in one direction only (`run.ts` → the job modules → `pass.ts`), never from `./index` (rule 3). A helper a sibling needs gets an `export` in its own module but stays out of the barrel.

- [ ] **Step 1: Check no open branch is editing the file.** For each open branch: `git diff main...<branch> --stat -- apps/web/src/server/usecases/external-play/sweep.ts`. If one is, stop and report it; do not split under it.

- [ ] **Step 2: Capture the public surface before.** Save the list of `export` names in `sweep.ts`: `grep -a -E '^export ' apps/web/src/server/usecases/external-play/sweep.ts`, plus the names of any `export { … }` lists.

- [ ] **Step 3: Move verbatim**, one module per commit (rule 6). No renames, no reordering of logic and no comment edits in a move commit (rule 1). `import type` stays `import type` (rule 7).

- [ ] **Step 4: Repoint the source guards that pin the file by path** (rule 8). The rule for this step: **every assertion is kept, and a per-file count moves by exactly the number of files the split adds, never by anything else.** These are the ONLY test edits a pure move allows. Two per-file counts move; both are hard `toBe`s, and Step 7's verify goes red without them (finding 1):
  - `seat-line-one-reader.test.ts`: the rows at lines 72, 73 and 76 are `noShow` → `server/usecases/external-play/sweep/no-show.ts`, `meetingIsDone` → `.../sweep/teardown.ts` and `mintRetry` → `.../sweep/mint-retry.ts`. **"files with pinned sites" `toBe(4)` (line 272) → `toBe(6)`**: sweep.ts was one file holding three sites, and now three files hold one each. `calls` stays a `>=` on the summed `times`.
  - `batch-anchor-source-guard.test.ts`: `windowFor` (1, inside `playableWindow`'s body) → `.../sweep/pass.ts`. Split `playableWindow` (5 calls) by module: `pass.ts` 1 (line 415, inside `anchorIfClosedNow`, which moves to pass.ts: its `readers` tag is `["no-show", "teardown"]`, the two jobs that call it), `no-show.ts` 2 (422, 427), `teardown.ts` 1 (745) and `reconcile.ts` 1 (949). The other `readers` tags move with their call sites, and the total stays 5. Re-read how the guard treats the definition line before counting. **"files that build a rank" `toBe(5)` (line 455) → `toBe(8)`**: sweep.ts's four `boardRankSql` queries (no-show 381, mint retry 613, teardown 727, reconcile 905) land in four modules. `ranks` stays `toBe(8)`. Rewrite the comment at line 453 per module: "round-open.ts (boardOpenFor) 1, open-round.ts 1, open-round-view.ts 1, sweep/no-show.ts 1, sweep/mint-retry.ts 1, sweep/teardown.ts 1, sweep/reconcile.ts 1, arbiter.ts 1".
  - Both guards then name modules of a folder. If either one reads a file it was not given a row for (a whole-folder rule), it reads ALL the folder's modules with a module-count floor (rule 9).

- [ ] **Step 5: Sweep for the old filename** (rule 8) across every workspace and the root `scripts/`: `grep -a -rn "external-play/sweep\.ts" apps packages tools scripts`. Expect only the two guards above (now repointed) and the comment in `arbiter-view.test.ts`, which is fixed in a separate comment-only commit. `docs/superpowers/specs/2026-10-15-chess-per-board-timers-design.md` cites `sweep.ts:147` as history; it is left alone.

- [ ] **Step 6: Optionally split the test file to mirror the source** (rule 5): `external-play-sweep.test.ts` → `apps/web/src/server/usecases/__tests__/external-play-sweep/<module>.test.ts`, moving each top-level `describe` verbatim to its job's file and the shared setup (lines 1-495) to a `_sweep-setup.ts` beside them. The test titles and the total test count must be the same before and after. If module-level state shared between describes stops a verbatim move, keep the file whole and say so in the PR. Rule 5 is there to keep reviews small, and must not bring a behaviour change with it.

- [ ] **Step 7: Verify** (MODULARIZATION.md "Verify", scoped only):
  - `cd apps/web && npx tsc --noEmit` (the scoped project config per `AGENTS.md`).
  - The surface diff: re-take Step 2's list from `sweep/index.ts` and its modules. The diff must be empty.
  - `cd apps/web && npx vitest run --reporter=json --outputFile=<f>` over the importers above, the two guards and `apps/web/src/server/usecases/external-play/__tests__/no-import-cycle.test.ts`. Read `numTotalTests`/`numPassedTests` and confirm `.testResults[].name` resolve inside the worktree. The sweep suite's total must equal its count before the split. The two guards' totals must equal theirs too: only the two per-file counts in Step 4 moved, and no case was added or removed.
  - The direction check: `grep -a -n "from \"\./" apps/web/src/server/usecases/external-play/sweep/*.ts`. Every job module imports from `./pass` only, `run.ts` imports from the job modules and `./pass`, and `pass.ts` imports from no sibling.
  - `pnpm --filter @seazn/cron-worker test`: the drift test reads the route's imported source, and must still find `failed` and `skipped` declared as numbers.
  - The two `scripts/__tests__/rules-reference*.test.ts` runs. They read `usecases/**` from outside `apps/web`.

- [ ] **Step 8: Mutate once:** delete one re-export from the barrel. `tsc` must go red. Restore it.

- [ ] **Step 9: PR**, titled `refactor(sweep): split external-play sweep.ts into a folder behind an identical barrel`, with commits `refactor(sweep): move <concern> to sweep/<module>.ts`, one per module, then `test(guards): repoint sweep path pins to sweep/ modules`, then the comment-only `docs(sweep): fix sweep.ts path citations`. Merge it before Task 1.

---

### Task 1: Migration

**Files:**
- Create: `db/migration/deltas/V529__premint_and_line_price.sql`
- Modify: `apps/web/src/server/usecases/__tests__/online-chess-video-schema.test.ts` (its R2-2 not-null case, Step 3)

- [ ] **Step 1: Read the table definitions** — `fixture_video_meetings` is created in `db/migration/deltas/V451__online_chess_board_and_camera.sql` (line 249; `home_entrant_id uuid not null`, `away_entrant_id uuid not null`, the comment "Never null: a board with no pairing gets no meeting" which this design retires) and `fixture_seat_line` in `V461__checkin_batches_and_seat_line.sql`.

- [ ] **Step 2: Write the migration** (`db/migration/deltas/V529__premint_and_line_price.sql`)

```sql
-- V529 — pre-minted rooms and the line's stamped price (check-in capacity design 2026-11-05 §6.1, §6.3, §6.4).
-- MERGE GATE: Flyway runs with outOfOrder=false (db/flyway.toml sets none; false is the default), so V528 (the stage
-- lots-draw index fix PR) must merge before this file reaches ANY database; a V528 arriving after V529 is applied is refused.
-- V451 made the stamps NOT NULL ("a board with no pairing gets no meeting"); an unadopted room is exactly that board's room, both null.
alter table fixture_video_meetings alter column home_entrant_id drop not null;
alter table fixture_video_meetings alter column away_entrant_id drop not null;
-- An unadopted room has BOTH stamps null; one null alone is a bug.
alter table fixture_video_meetings add constraint fixture_video_meetings_stamp_pair_check
  check ((home_entrant_id is null) = (away_entrant_id is null));
-- The stay's price, stamped at the stay's FIRST claim (and again when a stay restarts), never re-priced inside a stay
-- (seat-line.ts lineReservation), and what its opponent's re-verify costs at that read price (lineRecheckCost). Both are written
-- by upsertStay together; both are null for a row from before this migration, and every reader coalesces them.
alter table fixture_seat_line add column reservation int null check (reservation between 1 and 64);
alter table fixture_seat_line add column recheck_cost int null check (recheck_cost between 1 and 8);
-- The instant a claim first saw the browser report a live camera with no presence on file (preflight.ts PRESENCE_FALLBACK_MS); cleared when presence arrives.
alter table fixture_video_participants add column presence_fallback_from timestamptz null;
-- The receipt of the FIRST `live` camera report of this seat's current live run (owner ruling 2026-11-17): written by
-- camera-report.ts when it writes `live` over a stored state that is not a FRESH `live` (null, `off`, or a `live` older than
-- CAMERA_REPORT_STALE_MS); never re-stamped by a same-state heartbeat on a fresh `live` (`refreshed`, which re-stamps
-- camera_reported_at every 30 s); cleared when it writes `off`. The fallback clock reads it. A row already `live` at deploy
-- keeps null until its next report, which stamps it (the writer coalesces); the reader treats live-with-null as a run starting now.
alter table fixture_video_participants add column camera_live_first_at timestamptz null;
-- The stamp is set only while camera_reported is 'live'. `is not distinct from`, not `=`: with camera_reported null, `= 'live'`
-- is NULL, and a NULL check PASSES (three-valued logic), so `=` would admit a stamp beside no report at all (controller ruling
-- 2026-11-18, amending the plan's DDL). The other direction bites too: a build older than plan 2 Task 6 (a rollback after
-- Task 6 has stamped rows) that writes `off` over a stamped row is refused (23514); Task 6's writer clears the stamp in the
-- same statement as every non-live write. No "live implies stamped" constraint: the app version running while this
-- migration applies writes `live` without it.
alter table fixture_video_participants add constraint fixture_video_participants_camera_live_first_check
  check (camera_live_first_at is null or camera_reported is not distinct from 'live');
-- When the seat last handed this participant a token (a mint's own, or refreshParticipantToken), written by preflight.ts.
-- The fallback clock never starts before it: no peer can join before its page holds a token, and a reload's page gets a new
-- one (review fix 2026-11-17, finding 6). Null: never handed, so nobody can have joined and the fallback never fires.
alter table fixture_video_participants add column token_issued_at timestamptz null;
```

- [ ] **Step 3: Apply** (`npm run db:apply`) and run the sealed catalog test (`apps/web/src/server/usecases/__tests__/online-chess-video-schema.test.ts`) and `apps/web/src/server/__tests__/rls-coverage.test.ts`. No new table, so `rls-coverage` stays green. The catalog test does NOT stay green, for two reasons:
  - **The R2-2 case.** "R2-2: a meeting names the pairing it was made for — an insert without either entrant is refused" (lines 80-97) expects `23502` on the missing column. After this migration one null stamp is refused by `fixture_video_meetings_stamp_pair_check` (`23514`). Update that case to expect the check constraint by name (one null alone, each way round, still refused, count 2) and add its positive pair: both stamps null is accepted. Add a case for `fixture_video_participants_camera_live_first_check`: `camera_live_first_at` set with `camera_reported` null or `off` is refused (`23514`, count 2), and set with `live` is accepted.
  - **The V459 replay** (found by plan 3's reviser, 2026-11-17). `describe("the delta's guard")` (lines ~671-800) runs `V459__video_meeting_per_player.sql` against a scratch schema holding the V451/V454/V457 shape (`_v459-old-shape.ts`). Then "with ONLY ended meetings it applies … the three tables end up exactly as the migrated database has them" (~771-793) compares `shapeOf` (columns, constraints, indexes) of `fixture_video_meetings`, `fixture_video_participants` and `fixture_video_guard_faults` in scratch with the LIVE tables. V529 changes the live shape of two of them (the dropped NOT NULLs, two checks, three columns), so the comparison goes red. Fix it by replaying the later deltas too, never by loosening the comparison:
    - After `tx.unsafe(delta())`, the case replays every delta numbered above V459 whose statements touch the three tables, in version order. It reads `db/migration/deltas/`, keeps the files `V(\d+)__*.sql` with a number > 459, and splits each on `;` at a line end (V529 has no `do` block). It keeps a statement only when it is an `alter table` / `create [unique] index … on` naming one of `TABLES` (`\b`-bounded), and runs the kept statements in the scratch schema.
    - Statements on any other table (V529's two `fixture_seat_line` lines) are skipped and are NOT run. Running them would take an access-exclusive lock on a LIVE table and fail on the existing columns, and the case "no strong lock on a LIVE table" (~795) must stay green.
    - Anti-vacuity, pinned per file in a typed map: `{ V529: { kept: 7, skipped: 2 } }`. The 7 are the two `drop not null`s, the stamp check, `presence_fallback_from`, `camera_live_first_at`, its check, and `token_issued_at`. A delta above V459 that touches the three tables and is not in the map fails the case by name. So plan 3's V530, if it touches `fixture_video_participants`, adds its own entry in its own task.
    - Mutation, once: leave V529 out of the replay; the comparison must fail on `fixture_video_meetings`. Restore.

- [ ] **Step 4: Commit** — `feat(db): unadopted room stamps, stay price, presence fallback clock, first-live and token stamps`.

---

### Task 2: Unadopted rooms in the adapter

**Files:**
- Modify: `apps/web/src/server/external-play/video/realtimekit.ts`
- Modify: `apps/web/src/server/external-play/__tests__/video-per-player-source-guard.test.ts` — `adoptRooms` reaches `fixture_video_meetings` by `fixture_id` and means both sides on purpose, so it joins `BOTH_SIDES` (`file: "external-play/video/realtimekit.ts"`, `times: 1`, with its reason), or rule 1 reds
- Test: `apps/web/src/server/external-play/video/__tests__/realtimekit-unadopted.test.ts` (DB suite, fixture vendor in process or `deps.fetch` double, as the existing `realtimekit` suites do)

**Interfaces:**

```ts
// meetingOnFile's row gains:  unadopted: boolean   // both stamps null
// A row is "the current pairing's" when samePair OR unadopted.
export async function ensureMeeting(fixtureId: string, side: MeetingSide, deps?: RealtimeKitDeps, opts?: { unpaired?: "allow" }): Promise<MeetingRef>;
//   ALWAYS, whatever the caller passes (the seat passes nothing): on a PAIRED fixture whose row is unadopted, ensureMeeting adopts it
//   (adoptRooms) and returns it as the current pairing's; it never creates a second room beside an unadopted one.
//   `unpaired` default: an unpaired fixture with no row is VIDEO_MEETING_UNPAIRED, as today. "allow" (the pre-mint job only): a fixture
//   with a null entrant and no row gets a room stamped (null, null).
/** ONE statement: every unadopted row of the board takes the fixture's current pairing; 0 rows when the fixture is unpaired or nothing is unadopted. */
export async function adoptRooms(db: postgres.Sql | postgres.TransactionSql, fixtureId: string): Promise<number>;
// retireStaleMeeting: the select gains `and m.home_entrant_id is not null` (an unadopted row is never stale).
/** The one-read proof's read: GET /sessions/peer-report/{peerId}. `none` is the vendor's own not-found (no report yet).
 *  A RealtimeKitDeferred is rethrown, never `unreadable` (seatCameraEvidence's D21 rule today, realtimekit.ts:694).
 *  `left` (owner ruling R4): the report's `participant.left_at` is set. The real vendor carries that field (realtimekit.ts
 *  `videoOffCoverage` already parses it, ~913/927: "not_left" while it is null), and the e2e fixture serves it (rowJson's
 *  `left_at`, realtimekit-fixture-server.ts ~245, spread into the peer-report body at ~391). A departed peer is never judged
 *  on its last camera events. A malformed `left_at` is `unreadable`, never `on`. */
export async function peerReportCamera(peerId: string, deps?: RealtimeKitDeps): Promise<
  | { camera: "on" | "off" | "blocked" | "starting" }
  | { camera: "left"; leftAt: Date }
  | { camera: "unreadable"; error: RealtimeKitError }
  | { camera: "none" }>;
// SeatCamera's present states gain `peerId: string; sessionId: string` (seatCameraEvidence already knows both).
/** What cfEnvelope spends with for this base: the platform bucket when metered, null when not (a fixture base without REALTIMEKIT_METER_ANY_BASE, or a caller-supplied fetch). */
export function platformSpend(deps: RealtimeKitDeps): CallBudget | null;
/** A budget that refuses past `cap` attempts and otherwise asks `inner` (true when inner is null). `spent()` counts attempts that reached inner. */
export function cappedBudget(cap: number, inner: CallBudget | null): { budget: CallBudget; spent(): number };
```

- [ ] **Step 1: Write the failing tests**

```ts
describe.skipIf(!DB)("unadopted rooms", () => {
  it("ensureMeeting with unpaired 'allow' on a placeholder makes a room stamped (null, null); without it the placeholder is refused as today", async () => {});
  it("a paired fixture whose row is unadopted: ensureMeeting WITHOUT opts (the seat's call) adopts it (stamps = the fixture's entrants), returns its id and makes no vendor call", async () => { /* fixture calls count unchanged; no second POST /meetings */ });
  it("adoptRooms: both sides in one statement; 0 on an unpaired fixture; idempotent", async () => { /* returns 2 then 0 */ });
  it("retireStaleMeeting never selects an unadopted row, and still retires a row stamped for another pairing", async () => {});
  it("the stamp pair check refuses one null stamp", async () => { await expect(sql`update fixture_video_meetings set home_entrant_id = null where …`).rejects.toThrow(); });
});
describe("peerReportCamera", () => {
  it("maps the measured report shapes to on / off / blocked / starting, a not-found to none, an outage to unreadable, and costs exactly one call", async () => { /* a deps.fetch double counting requests; or the fixture's calls log */ });
  it("a report whose participant.left_at is set reads `left` with that instant, whatever its last video event says (video_on last: still `left`); a malformed left_at is unreadable", async () => { /* the fixture: join, camera on, then leave the row; count 2 cases */ });
});
describe("platformSpend and cappedBudget", () => {
  it("cappedBudget refuses the (cap+1)th attempt and never reaches inner for it; spent() counts attempts that did", async () => { /* cap 2, inner counting */ });
  it("platformSpend is null for a fixture base without REALTIMEKIT_METER_ANY_BASE and a spender with it", () => {});
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** `cfEnvelope` is refactored to `const spend = deps.budget ?? platformSpend(deps)` with no change in behavior (the existing `realtimekit` suites prove it). `peerReportCamera` is the tail of `seatCameraEvidence` (the report fetch and `cameraFromReport`, realtimekit.ts lines 686-707), extracted, plus the `left_at` read. `seatCameraEvidence` calls it, maps `none` back to today's `{ state: "starting", since }`, and maps `left` to `{ state: "absent" }`. Today's caller only reads a peer that `currentPeer` found present, so for it that mapping is a guard, not a behaviour change, and the existing suites prove it.

- [ ] **Step 4: Run to verify they pass**, then the video source guards (`cd apps/web && npx vitest run src/server/external-play/__tests__/`) and the existing suites in `apps/web/src/server/external-play/video/__tests__/` (`realtimekit.test.ts`, the only `realtimekit*` one there, and `budget.test.ts`, which covers the metering the `cfEnvelope` refactor touches).

- [ ] **Step 5: Mutate once:** drop `and m.home_entrant_id is not null` from `retireStaleMeeting`; the "never selects an unadopted row" test must fail. Restore.

- [ ] **Step 6: Commit** — `feat(video): unadopted rooms, one-call peer report, capped budgets`.

---

### Task 3: The re-open spares the current pairing's rooms

**Files:**
- Modify: `apps/web/src/server/usecases/external-play/open-round.ts` (`retireBoardsMeetings`, line 132)
- Test: the open-round DB suite, `apps/web/src/server/usecases/external-play/__tests__/open-round.test.ts` (its meeting cases are around line 1598; the plan's earlier grep for `retireBoardsMeetings\|RETIRED_PAIR` in that directory matches no file)

**Interfaces:** `retireBoardsMeetings(tx, fixtureIds, now, mode: "reopen" | "rearm")` has two callers (finding 2), and only §11's re-open is sanctioned to spare anything:
- `"reopen"` (the re-open, open-round.ts :409): the mark and the delete skip a row that is UNENDED and either unadopted or stamped for the fixture's current pairing. The UPDATE joins `fixtures f` (`from fixtures f where f.id = m.fixture_id`) and adds `and not (m.ended_at is null and (m.home_entrant_id is null or (m.home_entrant_id, m.away_entrant_id) = (f.home_entrant_id, f.away_entrant_id)))`. An ENDED row of the current pairing is still retired, as today. Spared, it would make every later claim's `ensureMeeting` throw `VIDEO_MEETING_ENDED` (realtimekit.ts ~427, `samePair && endedAt !== null`), so the board could never check in again. That hole was found while applying finding 2. The game-evidence `spare` clause is unchanged and still applies in both modes.
- `"rearm"` (the No-result re-arm, :476): exactly today's statement, which retires every row of the board without a game. The re-arm replays a board whose bridge finished with no game, and nobody ruled that a room carrying the old attempt's `last_publisher_seen_at` and seat cache may carry into the replay. So it does not.

- [ ] **Step 1: Write the failing tests** (chess-only: online play is `onlinePlay = 'lichess'` on `boardgame`, so another sport does not apply):
  - Re-open after a re-pair, zero invited seats: the old pairing's rooms are ended and deleted (as today). An UNENDED room stamped for the NEW pairing and an unended unadopted room both survive, unmarked, and the next claim on that board makes no room (fixture calls: 0 POST /meetings).
  - Re-open: an ENDED room stamped for the current pairing is deleted, and the next claim makes a fresh room (1 POST /meetings) and is never refused `VIDEO_MEETING_ENDED`.
  - Re-arm: a room stamped for the CURRENT pairing is retired exactly as today. The existing re-arm tests (open-round.test.ts ~2651-2712) stay unchanged and pass, which pins that the re-arm path did not move.
  - Sequence: a re-open, then a second re-open with nothing changed. The spared rooms survive both, and the second marks nothing.
  - Rewrite (not a new test) the two R2-3 table cases that stamp the CURRENT pairing (`insertMeeting`) and expect the re-open to retire the row: "a STALE mint claim" and "a bare pending row" (open-round.test.ts ~1920-1962, the insert at ~1950). They now stamp an EARLIER pairing, which is what "stale" means after this task. Their assertions are unchanged.

- [ ] **Step 2: Run to verify they fail** (the new-pairing room is retired today; the ended-row case passes today and must still pass; the rewritten R2-3 cases pass both before and after).

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the whole open-round suite to verify it passes** (`open-round.test.ts` and `open-round-property.test.ts` in that directory), and the video source guards (`retireBoardsMeetings` stays at `times: 2` in `BOTH_SIDES`).

- [ ] **Step 5: Mutate once, each** (TEST-STRATEGY rule 5; finding 17), restoring after each:
  - drop `m.home_entrant_id is null or` from the re-open's spare: the unadopted-room case must fail;
  - drop `m.ended_at is null and` from it: the ended-row case must fail;
  - make `"rearm"` spare like `"reopen"`: an existing re-arm test must fail.

- [ ] **Step 6: Commit** — `fix(open-round): a re-open keeps unended rooms made for the current pairing`.

---

### Task 4: The pre-mint pass

**Files:**
- Create: `apps/web/src/server/usecases/external-play/premint.ts`
- Modify: `apps/web/src/server/usecases/external-play/index.ts` (export `premintExternalPlay`, `PremintReport`: the barrel is `export * from "./<module>"` lines, so one `export * from "./premint";`). The job does not touch `preflight.ts`: it makes rooms only, through `ensureMeeting` with its own capped `RealtimeKitDeps` (owner ruling 2026-11-17 (2); the earlier `videoWith` / `playerParticipant` exports for the job are dropped, and `Video`'s `peerReportCamera` moved to Task 6).
- Test: `apps/web/src/server/usecases/external-play/__tests__/external-play-premint.test.ts` (DB suite, fixture vendor in process, seeded like the sweep suite)

**Interfaces:**

```ts
export const PREMINT_CALL_INTERVAL_MS = 1_000;
export const PREMINT_PASS_BUDGET_MS = 45_000;
export const PREMINT_CALLS_PER_PASS = Math.floor(PREMINT_PASS_BUDGET_MS / PREMINT_CALL_INTERVAL_MS); // 45
export const PREMINT_LOCK = "external-play-premint";
// Rooms only (owner ruling 2026-11-17 (2)): no PremintStep, no adoption, no participant, so no `adopted`, `participantsMade` or `noPlayer`.
export type PremintReport = {
  skipped: number;          // 1: another pass held the lock (the sweep's meaning, and a failure counter for the Worker); never anything else
  disabled: number;         // 1: EXTERNAL_PLAY_PREMINT is not "1", so the pass did nothing; not a failure (a flag-off environment must not page every minute)
  scanned: number;          // candidate (board, side) rows examined
  roomsMade: number;
  deferred: number;         // rows not started: the call cap, the pass budget, or the platform bucket
  failed: number;           // failures.length, derived once as the pass returns
  windowsOpen: 0 | 1;       // 1: a check-in window was open, so the pass made no vendor call (Task 8); informational, not a failure
  failures: { fixtureId: string; side: "home" | "away"; code: string }[];
};
export type PremintCandidate = { fixtureId: string; orgId: string; side: "home" | "away" };
export type PremintDeps = {
  now?: Date; orgIds?: readonly string[]; rtk?: RealtimeKitDeps; callCap?: number; serialise?: false; wallClock?: () => number;
  /** TEST SEAM (Task 8): is a check-in window open? Default `anyCheckinWindowOpen(sql, now, orgIds)`, off when EXTERNAL_PLAY_WINDOW_DEFER=0. */
  windowsOpen?: () => Promise<boolean>;
  /** The pacing wait (PREMINT_CALL_INTERVAL_MS between vendor calls); a test passes a no-op. */
  wait?: (ms: number) => Promise<void>;
  offered?: (asker: { orgId: string; userId: null }) => Promise<boolean>; // onlineChessOffered
};
/** Test seam: the candidate set on its own (the shape of sweep.ts __retryCandidates). */
export async function premintCandidates(now: Date, orgIds?: readonly string[]): Promise<PremintCandidate[]>;
export async function premintExternalPlay(deps?: PremintDeps): Promise<PremintReport>;
```

Candidates, one statement: `fixtures f join stages s join divisions d join competitions c`, where the division has started OR the board is paired (owner ruling R3): `(d.status not in ('setup', 'scheduled') or (f.home_entrant_id is not null and f.away_entrant_id is not null))`. The first arm is the negation of `divisionScoringClosed`, lib/division-phase.ts, the one predicate for "not started". The second arm is there because Swiss shells AND round-1 pairings exist before Start, while the division is still `setup` (`server/usecases/stages/swiss-boards.ts` ~150, the unseat-round doc). A placeholder in a setup division is never a candidate. A setup pairing that a roster change later unseats leaves its rooms stamped for that pairing: they are stale, the job makes nothing beside them (a row is on file), and the claim retires them (the `"all"` price plus the uncovered +4). `guard.ts onlinePlayBoardWhere()` holds (the one statement of "an online board": the DIVISION's predicate alone, guard.ts line 172; the pairing test `loadOnlinePlayFixture` adds at lines 212-213 is not part of it, so a placeholder passes), `coalesce(s.camera_policy, d.camera_policy, c.camera_policy) <> 'off'` (the SQL form of camera-policy.ts `effectivePolicy`: the nearest set level wins, the competition's is NOT NULL), `f.status in PLAYABLE_STATUSES` (today a private const of sweep.ts, line 211, in `sweep/pass.ts` after Task 0: `FIXTURE_STATUSES.filter(isPlayableFixtureStatus)`; premint.ts derives its own the same way or `sweep/pass.ts` exports it, never a typed list and never through the sweep barrel), `not exists (select 1 from stage_round_opens o where o.stage_id = f.stage_id and o.round_no = f.round_no)`; one row per (board, side) when no `fixture_video_meetings` row exists for that side. A side with ANY row on file (current, unadopted, stamped for an earlier pairing, or ended) is never a candidate: a stale or ended row is the claim's and the sweep's to retire, and the job makes rooms only (owner ruling 2026-11-17 (2): no participant candidate, no adoption).

**Nearest round first (owner ruling R3), an explicit `ORDER BY`:** `min(f.scheduled_at) over (partition by f.stage_id, f.round_no) asc nulls last, f.round_no asc, c.org_id, f.stage_id, f.seq_in_round, side`. The round's earliest scheduled board comes first. Unscheduled rounds come after every scheduled one, lowest round number first. Inside a round the rest is a stable tie-break. A near round's rooms therefore all come before a far round's. The cap then spends a pass on the round that opens next.

The pass: lock (`pg_try_advisory_xact_lock(hashtext(PREMINT_LOCK))`, the sweep's shape), flag check, the open-window deferral (added by Task 8, which owns `anyCheckinWindowOpen`: while any window is open, the pass makes no vendor call, reports `windowsOpen: 1` and counts every candidate deferred), per org `offered` once (skip the org's rows when false, counted deferred: never a failure), then for each candidate under the capped budget (`cappedBudget(callCap ?? PREMINT_CALLS_PER_PASS, rtk.budget ?? platformSpend(rtk))` as the `budget` of the `RealtimeKitDeps` handed to `ensureMeeting`, `{ ...rtk, budget }`), `wait(PREMINT_CALL_INTERVAL_MS)` before every vendor call after the first, and the wall-clock budget: `ensureMeeting(fixtureId, side, { ...rtk, budget }, { unpaired: "allow" })`. On a paired board that call stamps the row with the pairing; on a placeholder, unadopted. The job never calls `adoptRooms` (verified: nothing the job does needs an adopted row, and a candidate never has a row on file, so `ensureMeeting`'s own adoption branch is unreachable from the job) and never mints a participant.

A `RealtimeKitDeferred` from the cap or the bucket stops the pass and counts the rest deferred (the sweep's `each` rule).

- [ ] **Step 1: Write the failing tests**

```ts
// Chess-only (single-sport reason): online play is `onlinePlay = 'lichess'` on `boardgame`; no other sport has an online board.
describe.skipIf(!DB)("premint candidates (the set)", () => {
  it("empty case: no online camera division at all → [] (and the pass makes no vendor call)", async () => {});
  it("a placeholder board (null entrants) of an unopened round in a STARTED division yields two rows, one per side", async () => {});
  it("a division still in setup: its paired Swiss round-1 board yields two rows; its placeholder board yields none (R3; count 2)", async () => {});
  it("a side with ANY room on file yields no row, whatever the row: adopted for the current pairing, unadopted on a since-paired board, stamped for an EARLIER pairing, ended (count 4)", async () => {});
  it("an opened round, a camera-off policy, an OTB division, a cancelled board, a withdrawn board (fixture no longer playable): never candidates (one case each, count 5)", async () => {});
  it("a voided round put back on its shells: placeholder again, so rooms in a started division and nothing in a setup one (sequence: paired → void → candidates)", async () => {});
  it("nearest round first: stage A round 2 scheduled at T+1h and stage B round 1 scheduled at T+3h (B is first by round number, org and insert order) → A's rows lead; an unscheduled round 1 comes after both; with callCap 2 the pass makes A's two rooms only", async () => { /* the sort key perturbed: round_no and insert order disagree with scheduled_at */ });
  it("inside one stage, two unopened unscheduled rounds: round 1's rows before round 2's", async () => {});
});
describe.skipIf(!DB)("premint pass", () => {
  it("flag unset: disabled 1, skipped 0, failed 0 and no vendor call", async () => {});
  it("makes rooms for 10 placeholders (20 POST /meetings) stamped (null,null); a second pass makes none", async () => { /* fixture calls route counts */ });
  it("rooms only (owner ruling 2026-11-17 (2)): after the 10 boards are paired, a pass makes NO vendor call (0 POST /meetings, 0 POST participants), the 20 rows keep both stamps null, and no fixture_video_participants row exists; the seat's own `ensureMeeting` (no opts) on one of them then adopts it with no vendor call (Task 2's case, driven here on the job's own rows)", async () => {});
  it("a board already paired when the job reaches it: its two rooms are stamped with the pairing, and no participant is made (0 POST participants)", async () => {});
  it("the cap: callCap 7 over 10 boards' rooms makes 7 POST /meetings at the fixture, reports deferred = the 13 remaining rows, and the next pass continues from the top", async () => {});
  it("pacing: with a counting `wait`, a pass of 5 calls waits PREMINT_CALL_INTERVAL_MS exactly 4 times (between calls, never before the first)", async () => {});
  it("the platform bucket dry: RealtimeKitDeferred stops the pass with the rest deferred and failed 0", async () => { /* rtk.budget: async () => false, which the capped budget must consult */ });
  it("a club not offered online chess is skipped (deferred), never minted", async () => { /* offered: async () => false */ });
  it("a vendor 503 on one board is one failure and the pass goes on", async () => {});
  it("two passes at once: the second is skipped (the lock)", async () => {});
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement `premint.ts`.**

- [ ] **Step 4: Run to verify they pass**, plus the video source guards and `apps/web/src/server/usecases/external-play/__tests__/no-import-cycle.test.ts` (premint.ts imports `guard.ts` and the video adapter; it no longer imports `preflight.ts`).

- [ ] **Step 5: Mutate once, each** (restore after each):
  - remove the `not exists stage_round_opens` clause: the "opened round is never a candidate" case must fail;
  - drop the `or (paired)` arm: the setup Swiss case must fail. Drop the started arm instead: the started placeholder case must fail;
  - drop the `min(f.scheduled_at) …` key from the `ORDER BY`: the nearest-round case must fail;
  - drop the `not exists fixture_video_meetings` side clause: the "a side with ANY room on file yields no row" case must fail.

- [ ] **Step 6: Commit** — `feat(external-play): pre-mint rooms before the open`.

---

### Task 5: The job's route and schedule

**Files:**
- Create: `apps/web/src/app/api/cron/external-play-premint/route.ts`
- Modify: `apps/cron-worker/src/schedule.ts`, `apps/cron-worker/test/drift.test.ts`, `apps/cron-worker/test/schedule.test.ts`
- Test: `apps/web/src/app/api/cron/external-play-premint/__tests__/route.test.ts` (the shape of the sweep route's `apps/web/src/app/api/cron/external-play/route.test.ts`, which sits BESIDE its route: its computed `cronSrc` URL into `apps/cron-worker/src/` needs one more `../` from `__tests__/`; it reads the REAL `JOBS` row and `failureCountsOver0`, and pins the pass budget below the Worker's `JOB_TIMEOUT_MS`, 60 s)

**Interfaces:** `POST /api/cron/external-play-premint`, `x-cron-secret`, answers `PremintReport`. The route imports `premintExternalPlay` from the barrel and `type PremintReport` from `@/server/usecases/external-play/premint`, as the sweep route does. Schedule row, placed after `stream-tick` and before `external-play` in `JOBS` (the Worker runs a firing's rows one after another, `apps/cron-worker/src/run.ts` line 59; accepted by the owner 2026-11-17, see Revision notes, Resolved 1):

```ts
{ id: "external-play-premint", path: "/api/cron/external-play-premint", trigger: FAST_TRIGGER, due: { kind: "every" }, retry: false, manual: true, failureCounts: ["data.failed", "data.skipped"] }
```

Never retried (the next firing is the retry; the lock answers an overlap with `skipped`).

- [ ] **Step 1: Write the failing tests:** 401 on a bad secret, 503 without `CRON_SECRET`, 200 with the report shape; in the drift test raise `checked` from 14 to 16 (two new counters; extend the trailing comment's list) — the generic "every scheduled path resolves to a real route file" case already asserts the row's path resolves; in `schedule.test.ts` add `"external-play-premint"` to `FAST_ROWS` and `EVERY_FIRING_ROWS` at its table position, add it to `triggerFor`'s per-env row list, and add a row-pin case ("in the table exactly once, on the env's fast trigger, due on EVERY firing, never retried") shaped like the `email-outbox` one.

- [ ] **Step 2: Run to verify they fail** (`cd apps/cron-worker && npx vitest run test/drift.test.ts test/schedule.test.ts`: drift fails on "every cron-shaped route has exactly one schedule row" once the route exists, schedule on the row lists).

- [ ] **Step 3: Implement** the route (copy the sweep route; `premintExternalPlay()`), the row, and `PREMINT_PASS_BUDGET_MS` wiring.

- [ ] **Step 4: Run to verify they pass**: the route test, the drift test, `schedule.test.ts`, `npm run typecheck --workspace apps/cron-worker`.

- [ ] **Step 5: Commit** — `feat(cron): external-play-premint every firing of the fast trigger`.

---

### Task 6: The one-read proof at the seat

**Files:**
- Create: `apps/web/src/server/usecases/external-play/camera-reported.ts` (a LEAF module: imports `@/lib/db` and the stale constant only, so room.ts, preflight.ts and arbiter.ts can all import it with no cycle)
- Modify: `camera-report.ts`, which KEEPS its own read (finding 11). Its only read of the columns is the writer's `select … for update of p` inside its transaction (`reportOwnCamera`, lines 60-66), and that read decides `written` / `refreshed` / `ignored`. It needs the RAW stored state and stamp under a lock, while `reportedCamera` judges on `now` (a stale `live` reads `unknown`) and takes no lock. Routed through the leaf, a stale `live` would flip `refreshed` to `written` plus a ping. So it stays where it is, and the writer gains the first-live CASE below.
- Modify: `room.ts` (`opponentCameraReport`, lines 321-337, calls the leaf; the columns leave room.ts), `preflight.ts`. In `preflight.ts`, the private `type Video` (today `ensureMeeting`, `addParticipant`, `seatCameraEvidence` and `refreshParticipantToken`, preflight.ts:109-114) gains `peerReportCamera`, and `REAL_VIDEO` (:125) binds it (finding 19; moved here from Task 4 when the job stopped using `Video`). So the one read goes through `video.peerReportCamera`, and the `PreflightDeps.video` seam (`fakeRtk().video`) can intercept it.
- Modify: `apps/web/src/server/external-play/__tests__/video-per-player-source-guard.test.ts` (rule 2, "nothing but the pill reads the camera report": the allow-list is `CAMERA_REPORT_FILES`, line 80, and the case at lines 336-342). It becomes `camera-report.ts` (the writer and its lock read) plus `camera-reported.ts` (the leaf); `room.ts` leaves it. Modify `_video-source-scan.ts` too: `CAMERA_REPORT_COLUMNS` (line 602, today `["camera_reported", "camera_reported_at"]`) gains `camera_live_first_at`. The scanner's regex is `\b`-bounded, so it does not match the new name through the two existing ones, and without this addition the new column would be unguarded.
- Reads plan 1's `presence.ts` as plan 1 ships it (final 2026-11-17): `currentPresence(db, { meetingId, participantId, customParticipantId, now? })` returns `{ peerId, sessionId, joinedAt, source, receivedAt }`, and a `source = 'read'` row counts as current only for `PRESENCE_READ_TRUST_MS` (10 s) after its `received_at`. Also `recordPresenceFromRead`. This plan adds nothing to presence.ts and writes no presence row except through `recordPresenceFromRead`. Plan 1's rule is that only a webhook closes a row, and R4 below is built to respect it.
- Test: `apps/web/src/server/usecases/__tests__/external-play-camera-report.test.ts` (the writer's suite; the first-live cases below)
- Test: `apps/web/src/server/usecases/external-play/__tests__/external-play-seat-presence.test.ts` (DB suite, fixture vendor in process with in-process webhook delivery as plan 1 Task 9 wires it). Chess-only (single-sport reason: online play is `onlinePlay = 'lichess'` on `boardgame`).

**Interfaces:**

```ts
// camera-reported.ts (leaf)
/** The ONE reader of the camera-report columns outside the writer: the player's own browser's last word, judged on `now`. */
export async function reportedCamera(db: AnySql, a: { fixtureId: string; side: Side; participantId: string; now: Date }): Promise<{ state: "live" | "off" | "unknown"; at: Date | null; firstLiveAt: Date | null }>;
// `at` is camera_reported_at (the LATEST receipt, re-stamped by every heartbeat); `firstLiveAt` is camera_live_first_at
// (the first receipt of the current live run), null unless the stored state is live. A FRESH live with a null firstLiveAt
// (a seat already live at the V529 deploy, until its next report) is returned as it is; the seat treats it as a run
// starting at `now` (finding 12's guard, tested below).

// camera-report.ts reportOwnCamera, the writer's one UPDATE (today lines 86-88) also sets (old-row values on the right):
//   camera_live_first_at = case when ${body.state} = 'live'
//       then (case when camera_reported = 'live' and camera_reported_at > ${now} - CAMERA_REPORT_STALE_MS
//                  then coalesce(camera_live_first_at, ${now})     -- a fresh live run continues (finding 12: never stays null)
//                  else ${now} end)                                -- null / off / a STALE live: a new run (finding 6)
//       else null end
// `written` live over null/off stamps it; `refreshed` live over a FRESH live keeps it; a live arriving over a live older than
// CAMERA_REPORT_STALE_MS (room-snapshot.ts:57, 75 s) restarts it; `off` clears it; `ignored` writes nothing, as today.

// preflight.ts
export const FIRST_READ_AFTER_JOIN_MS = 1_500;
export const PRESENCE_FALLBACK_MS = 10_000;
/** What one vendor read of a camera costs NOW: LINE_READ_CALLS (1) with EXTERNAL_PLAY_PRESENCE_PROOF=1, else LINE_FALLBACK_READ_CALLS (3). The seat hands it to the gate (GateAsk.readCalls, Task 7). */
export function seatReadCalls(): number;
/** How many claims this process answered through a 3-call fallback, either kind (the load test expects 0; the log carries the same count and the kind). */
export function presenceFallbackCount(): number;
export type StayMint = "none" | "room" | "all";
/** What a stay's FIRST claim will meet (the price table, Global Constraints). The side's row is "current" when it is UNENDED
 *  and either unadopted or stamped for the fixture's current pairing (finding 5).
 *  "none": a current row AND the player's live participant on THAT row (preset 'player', the person, removed_at null): an earlier
 *          claim made it (a restarted stay); the pre-mint job never makes one (owner ruling 2026-11-17 (2)).
 *  "room": a current row and no such participant: the normal round, the job's own room.
 *  "all": anything else: no row, a row stamped for an earlier pairing (its retirement is the design's uncovered +4), an ended row. */
export async function stayMintOf(db: AnySql, a: { fixtureId: string; side: Side; personId: string }): Promise<StayMint>;
// The token stamp (finding 6): every path that hands a player a token (verifyRequiredSeat's `minted ?? refresh…`, ~464, and
// issuePlayerToken, ~678-681) calls ONE helper after the token is in hand:
//   update fixture_video_participants set token_issued_at = ${now} where fixture_id = … and participant_id = …
// The pre-mint makes no participant (owner ruling 2026-11-17 (2)), so every player participant row is written by a claim that hands
// its token and stamps it. A null token_issued_at is only a row from before V529.
```

`judgeSeat`, with `EXTERNAL_PLAY_PRESENCE_PROOF=1`:

1. `presence = currentPresence(sql, { meetingId, participantId, customParticipantId: personId, now })`. A `read` row is current only for plan 1's `PRESENCE_READ_TRUST_MS`.
2. **No presence.** Read `report = reportedCamera(...)` and the row's `token_issued_at`.
   - `report.state !== "live"`, or `token_issued_at` is null (no page holds a token, so nobody can have joined): clear `presence_fallback_from` and answer as `absent` does today (`camera_required`, or `camera_lost` when `last_publisher_seen_at` is set). Zero calls.
   - `live`: the clock is `presence_fallback_from = greatest(coalesce(presence_fallback_from, report.firstLiveAt ?? now), token_issued_at)` (Postgres `greatest` skips nulls), set in one statement that returns it. So it starts at the receipt of the browser's FIRST `live` report of its current run (spec §6.3; owner ruling 2026-11-17: never `report.at`, the latest heartbeat). It never starts before the token this page was handed: a reload's page gets a new token, so a reload mid-check-in restarts the 10 s, and a camera previewed before the first claim is not counted as "no presence" (finding 6). A fresh `live` with a null `firstLiveAt` starts at `now` (finding 12).
   - `now - clock < PRESENCE_FALLBACK_MS` → `camera_starting`, no call.
   - Else the **no-presence FALLBACK**, under `claimEvidenceRead` like every other read (finding 9: racing claims make one fallback between them, and a claim that does not get the slot answers from `cachedEvidence`): `video.seatCameraEvidence(...)` (≤ 3 calls), `recordPresenceFromRead` for the peer it found, the counter, and `log.warn({ meetingId, fixtureId, kind: "no_presence" }, "seat: no presence on file; fell back to the vendor's session read")`. Then judge as today.
3. **Presence.** Clear `presence_fallback_from`. `since = least(presence.joinedAt, presence.receivedAt)` (finding 13: our own receipt bounds a vendor clock running ahead). If `now - since < FIRST_READ_AFTER_JOIN_MS` and `reportedCamera` is not `live` → `camera_starting`, no call. Otherwise, under `claimEvidenceRead` (unchanged schedule), `video.peerReportCamera(presence.peerId)`:
   - `on` → seated, and stamp `last_publisher_seen_at`;
   - `off` → `camera_lost` / `camera_required` as today; `blocked` → `camera_blocked`;
   - `starting` / `none` → `camera_starting` until `CAMERA_EVIDENCE_DEADLINE_MS` from `since`, then `camera_required`;
   - `unreadable` → waited out as today, then the outage path;
   - **`left` (owner ruling R4)**: the presence on file names a peer the vendor says has gone, so a `participantLeft` was lost. The player is NOT judged on that peer's camera. In the SAME claim and the same slot it takes the **departed-peer FALLBACK**: `video.seatCameraEvidence(...)` (≤ 3 calls; the session participants list is authoritative about who is there), `recordPresenceFromRead` for a current peer if one is found, the counter, and the log line with `kind: "departed_peer"`. Then it judges as today: no current peer means `absent`, so `camera_required` / `camera_lost`, never a seat.
   - Nothing is written to close the departed row: only a webhook closes a row (plan 1). While the stale webhook row stays the newest open one, each read slot of a claim costs 1 + up to 3 calls. That only happens when the leave was lost AND the player has not come back on a peer whose join webhook arrived, and every one of those reads is counted.

   `recordEvidence` / `cachedEvidence` keep working on `{ state, since }`.

**Why the peer report's own `left_at`, and what is unmeasured (R4).** The cheapest sound signal is already in the one read: the real vendor's report carries `participant.left_at` (realtimekit.ts `videoOffCoverage` parses it, and its `not_left` / `not_finalised` split says `left_at` appears before the report's `duration` settles, ~70 s later). The e2e fixture serves it. What nobody has measured is how soon after a leave the real report shows `left_at`, and whether it is per peer or per session row (the fixture's is per row: a reload's old peer under the same row keeps `left_at` null). Task 11 records the latency at plan 1's leave probe. If it is longer than a recheck's window, the recheck path (the one claimer with no browser behind it) is routed to the 3-call read, and that goes to the owner first. T9's recheck inside `SEAT_RECHECK_TRUST_MS` still trusts a pass with no call, as today. That window is a few seconds, and the R4 tests claim outside it.

With the flag unset the function body is today's (plus the token stamp, which nothing reads with the flag off). The T9 re-verify (`recheck`) goes through the same function.

- [ ] **Step 1: Write the failing tests**

```ts
describe.skipIf(!DB)("the one-read proof", () => {
  it("a joined player with the camera on is seated after ONE vendor call (the peer report) and no session reads", async () => { /* fixture route counts since the claim: GET peer-report 1, GET active-session 0, GET sessions/:id/participants 0 */ });
  it("no presence yet, browser silent: camera_required with ZERO vendor calls", async () => {});
  it("a participant row whose token_issued_at is null (a row from before V529, seeded by a one-column update; the job makes no participants), browser reporting live for 30 s: camera_starting / camera_required with ZERO calls and no fallback; the claim's answer carries a token (a refresh) and stamps token_issued_at", async () => {});
  it("presence younger than 1.5 s and no live report: camera_starting with zero calls; 1.5 s later the read is made", async () => { /* deps.now */ });
  it("a joined_at in the future (the vendor's clock ahead) with received_at = our now: camera_starting, no read, until 1.5 s have passed on OUR clock", async () => {});
  it("camera off at the vendor: camera_required / camera_lost from one call; blocked: camera_blocked", async () => {});
  it("the fallback: webhooks down, token handed, browser reports live; T0+9s → camera_starting, zero calls; T0+10s → the 3-call read seats the player, the counter is 1, the presence row has source 'read', the log line is written", async () => { fx.setWebhooksDown(true); });
  it("two claims racing at T0+10s (webhooks down): ONE fallback read between them (3 calls at the fixture, counter 1); the loser answers from the cache", async () => { /* Promise.all of two claims; finding 9 */ });
  it("presence arriving clears the fallback clock: a later silent stretch starts the 10 s again", async () => {});
  it("the fallback clock starts at the FIRST live report, not the latest heartbeat: token at T0-1s, live at T0, live heartbeat at T0+30s, first claim at T0+31s falls back (3 calls); with the clock read from camera_reported_at it would answer camera_starting", async () => {});
  it("RELOAD with webhooks UP (finding 6): live camera seated through presence for 20 s, then the page reloads (old peer's participantLeft delivered, the old tab's live report still fresh, new page's first claim before its join): no fallback, counter 0; after the new page joins, ONE peer-report read seats it", async () => { /* calls since the reload: token 1 + peer-report 1 + seat token 1; active-session 0 */ });
  it("a fresh live report with a NULL camera_live_first_at (a pre-V529 live seat, seeded by a one-column update): the clock starts at now: camera_starting, zero calls, fallback only 10 s later", async () => {});
  it("R4: a peer that LEFT with its participantLeft LOST (webhook row still open): a claim past SEAT_RECHECK_TRUST_MS reads the report, sees left_at, takes the departed-peer fallback, and the player is NOT seated (camera_lost); counter +1, kind departed_peer", async () => { /* seat via webhook presence; fx.setWebhooksDown(true); fx.leave(row); claim */ });
  it("R4 + the reload: the departed peer's player came back on a new peer whose join webhook was ALSO lost: the departed-peer fallback finds the new peer, records it (source 'read'), and seats from that read", async () => {});
  it("plan 1 finding 3, the fallback-then-leave sequence: a fallback read seats the player (read row), then the peer leaves with its leave webhook lost; the next claim is NOT seated, inside the read row's 10 s trust (departed-peer fallback) AND after it (no presence; the fallback finds no peer) — count 2", async () => {});
  it("the T9 re-verify (recheck) also costs one call, or none inside SEAT_RECHECK_TRUST_MS", async () => {});
  it("flag unset: today's three reads", async () => {});
});
describe.skipIf(!DB)("stayMintOf", () => {
  it("each kind from the rows on file, counted (7): room (the pre-mint pass's own unadopted room on a since-paired board, no participant: the normal round), room (current room, no participant), none (adopted room + a participant an earlier claim made), none (unadopted room + participant), all (nothing), all (a room stamped for an earlier pairing, participant on it), all (an ended current-pairing room)", async () => {});
});
describe.skipIf(!DB)("the token stamp", () => {
  it("every token handed stamps token_issued_at (the minted one, a refresh, issuePlayerToken); a camera_starting answer to a browser that already holds the token stamps nothing (count 4)", async () => {});
});

// external-play-camera-report.test.ts (the writer's suite)
describe.skipIf(!DB)("camera report - the first-live stamp (owner ruling 2026-11-17)", () => {
  it("a second live heartbeat does not move camera_live_first_at (outcome 'refreshed'; camera_reported_at does move)", async () => {});
  it("each transition, counted: null→live stamps it; fresh live→live (change or heartbeat) keeps it; live (stale, older than CAMERA_REPORT_STALE_MS)→live restarts it; live→off clears it; off→live stamps the new receipt; a fresh live over a NULL stamp fills it; an ignored heartbeat leaves it", async () => {});
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** Move `room.ts`'s camera-report column read into the leaf `camera-reported.ts`. Leave `camera-report.ts`'s lock read where it is. Update the camera-report source guard's allow-list (`camera-report.ts` and `camera-reported.ts`) and pin the leaf reader's consumers: `room.ts opponentCameraReport`, `preflight.ts judgeSeat`, and later `arbiter.ts`. Rewrite the guard's and `camera-report.ts`'s header comments to state the constraint as it now is: the report may schedule a read or the fallback, and never decides a seat. The token stamp is one helper, called on both handout paths. Plan 1's `currentPresence` already carries `source`, `receivedAt` and `now`: if the merged plan 1 differs, stop and report rather than widen it here.

- [ ] **Step 4: Run to verify they pass**, plus the source guards, `apps/web/src/server/usecases/external-play/__tests__/no-import-cycle.test.ts`, and the existing seat suites (`grep -a -l seatPlayer apps/web/src/server/usecases/__tests__/*.ts`: the seat suites live in `usecases/__tests__/`, e.g. `external-play-preflight.test.ts`, `external-play-seat-camera.test.ts`, `external-play-seat-budget.test.ts`, plus `external-play-camera-report.test.ts` for the writer; the same grep in `usecases/external-play/__tests__/` finds only the two open-round suites).

- [ ] **Step 5: Mutate once, each** (restore after each):
  - Make the fallback fire with no `live` report: the "browser silent: zero calls" test must fail.
  - Re-stamp on heartbeat: make the writer set `camera_live_first_at = ${now}` on `refreshed`. The "a second live heartbeat does not move camera_live_first_at" test and the seat's "FIRST live report" test must both fail.
  - Drop `token_issued_at` from the clock's `greatest`: the reload test must fail. Drop the `token_issued_at` null arm: the null-token test must fail.
  - Take the fallback read outside `claimEvidenceRead`: the racing-claims test must fail.
  - Map `left` to `on`'s branch (judge the departed peer): both R4 tests must fail.
  - Use `presence.joinedAt` alone for `since`: the vendor-clock-ahead test must fail.
  - Drop the `coalesce` from the writer's CASE: the null-stamp transition case must fail.

- [ ] **Step 6: Commit** — `feat(seat): presence plus one peer-report read, departed peers refused, a counted fallback from the first live report after the token`.

---

### Task 7: The line's stamped price

**Files:**
- Modify: `apps/web/src/server/external-play/seat-line.ts`, `preflight.ts` (`passTheLine` prices the stay, its `GateAsk` at line 333), `apps/web/src/server/usecases/external-play/room.ts` (`queueDeferred`, lines 667-685, builds the other production `GateAsk`, for `settleDeferral`, and must pass `mint` and `readCalls` too), `apps/web/src/server/external-play/__tests__/seat-line-one-reader.test.ts`, `apps/web/src/server/usecases/__tests__/external-play-line-cost.test.ts` (and its helper `_external-play-line.ts`: `stubBucket` meters the fixture base, `askOf` builds every test `GateAsk`)
- Modify (every other current reader of `LINE_RESERVATION`, `LINE_RECHECK_COST`, `LINE_COMPLETING_LEVEL`, `LINE_MINT_CALLS` or the re-valued `LINE_READ_CALLS`, by `grep -a` on the ref tree): `apps/web/src/server/external-play/__tests__/seat-line-wire.test.ts`, `apps/web/src/server/external-play/__tests__/line-load.test.ts`, and in `apps/web/src/server/usecases/__tests__/`: `external-play-line-pool.test.ts`, `external-play-line-order.test.ts`, `external-play-line-hold.test.ts`, `external-play-line-effects.test.ts`, `external-play-line-gate.test.ts`, `external-play-line-cap.test.ts`, `external-play-line-completing.test.ts`, `external-play-line-consumers.test.ts`, `external-play-line-stay.test.ts`; and the load harness `apps/web/e2e/load/chess-30-boards.load.ts` and `apps/web/e2e/load/line-load.ts`. `external-play-line-cost.test.ts` line 138 pins `{ mint: LINE_MINT_CALLS, read: LINE_READ_CALLS, token: LINE_TOKEN_CALLS }` to the fixture's counts: it becomes the room, participant, proof-read, fallback-read and token counts, each equal to the fixture's.
- Test: the line's existing suites plus new cases in `external-play-line-cost.test.ts`

**Interfaces:**

```ts
export const LINE_MINT_ROOM_CALLS = 1; export const LINE_MINT_PARTICIPANT_CALLS = 1;
export const LINE_READ_CALLS = 1; export const LINE_FALLBACK_READ_CALLS = 3;
export const LINE_TOKEN_CALLS = 1; export const LINE_SESSION_PROBE_CALLS = 1; export const LINE_END_ROOM_CALLS = 2;
export const LINE_CLAIM_COST = 6; // = 2 * LINE_END_ROOM_CALLS + LINE_MINT_ROOM_CALLS + LINE_MINT_PARTICIPANT_CALLS (asserted)
/** The calls of a stay's FIRST claim (Global Constraints, the price table): "none" pays the token nothing minted carries, plus,
 *  with the proof flag off (readCalls === LINE_FALLBACK_READ_CALLS), today's read finding no live session; "room" the participant;
 *  "all" the room and the participant. */
export function lineFirstClaimCalls(mint: StayMint, readCalls: number): number;
/** lineFirstClaimCalls(mint, readCalls) + readCalls * (CAMERA_EVIDENCE_MAX_POLLS + 1) + LINE_TOKEN_CALLS. `readCalls` is REQUIRED:
 *  LINE_READ_CALLS under the proof flag, LINE_FALLBACK_READ_CALLS without it (preflight.ts `seatReadCalls()`).
 *  Flag on: none 8, room 8, all 9. Flag off: none 21, room 20, all 21. Outside it, named here beside the P1 note: retiring an
 *  earlier pairing's rooms (+4 a board, the design's decision), a reload inside a stay, the counted fallback read (+2). */
export function lineReservation(mint: StayMint, readCalls: number): number;
export const LINE_RESERVATION_MIN = lineReservation("none", LINE_READ_CALLS); // 8
export const LINE_RESERVATION_MAX = lineReservation("all", LINE_FALLBACK_READ_CALLS); // 21: the price of a stay the gate has not priced
// The recheck is ONE read and the completing level two reads and a token, so both follow `readCalls` too:
export function lineRecheckCost(readCalls: number): number;      // readCalls (1 or 3)
export function lineCompletingLevel(readCalls: number): number;  // readCalls + LINE_TOKEN_CALLS + lineRecheckCost(readCalls) (3 or 7)
// LINE_RECHECK_COST and LINE_COMPLETING_LEVEL (the constants) are removed with LINE_RESERVATION.
// GateAsk gains `mint: StayMint` and `readCalls: number` (preflight's stayMintOf / seatReadCalls(); seat-line.ts imports only the
// TYPE from preflight.ts, so no runtime cycle).
// upsertStay gains `reservation: number` and `recheckCost: number` and writes BOTH (finding 7: recheck_cost had no writer):
//   reservation  = case when ${restart} or l.reservation  is null then excluded.reservation  else l.reservation  end
//   recheck_cost = case when ${restart} or l.recheck_cost is null then excluded.recheck_cost else l.recheck_cost end
// i.e. stamped at the stay's FIRST claim (insert, or a restart), never re-priced inside a stay: a later claim of the same stay
// sees its own mint already made and would under-state what the stay was admitted for.
// reservedSql(now): (coalesce(l.reservation, LINE_RESERVATION_MAX) + (case when l.completing then coalesce(l.recheck_cost,
//   LINE_FALLBACK_READ_CALLS) else 0 end)) for an admitted live stay, null otherwise. BOTH coalesced (finding 7): reservedSql doubles
//   as the admitted-live test (`is not null`, seat-line.ts ~116-119, read by readStanding's mine_admitted / admitted_live ~290-299),
//   so a null recheck_cost on a completing stay (every live stay at deploy) would make an admitted stay read as not admitted.
// readStanding gains `aheadReserved`: sum over WAITING stays ahead of (coalesce(reservation, LINE_RESERVATION_MAX) + coalesce(recheck_cost, LINE_FALLBACK_READ_CALLS)).
// reservationIf(mint, completing, readCalls) = lineReservation(mint, readCalls) + (completing ? lineRecheckCost(readCalls) : 0).
// The idle completing check reads `tokens >= lineCompletingLevel(ask.readCalls)`.
// lineWire takes `aheadReserved` in place of position-based pricing: tokensToAdmit = aheadReserved + need.
```

`LINE_RESERVATION` (the old constant) is removed; every reader of it moves to `lineReservation(mint, readCalls)` or `LINE_RESERVATION_MAX`. Both columns are in Task 1's migration already.

- [ ] **Step 1: Write the failing tests**
  - **The price table, measured** (owner ruling R1), in `external-play-line-cost.test.ts`. The fixture's own counts first, each equal to its declared constant: room create 1, participant add 1, token 1, proof read 1 (GET peer-report), full read 3, session probe 1 (GET active-session with no session), `endMeeting` 2. Then drive the late-verdict schedule (the existing "verdict one back-off step late" case, 6 reads) for each stay kind × flag state: `room` (pre-minted through the premint pass itself, so the room is the job's own row: the normal round), `none` (the participant made by an earlier claim of the same player, whose stay then restarted; the job never makes one), `all`, and `all` with a room stamped for an earlier pairing. That is 8 stays; anti-vacuity: 8 driven. Under the flag, seed the presence row's `received_at` equal to the vendor's `joined_at`, so that `since` is the vendor's instant and the schedule needs its sixth read. Assert, literally (hand-derived in Global Constraints; never computed from `lineReservation`):
    - realized `[room, none, all]` = `[8, 8, 9]` with the flag and `[20, 21, 21]` without;
    - each equals `lineReservation(kind, readCalls)` (the code agrees with the hand count);
    - the earlier-pairing stay realizes `9 + 4` and `21 + 4` (the uncovered retirement, `2 * LINE_END_ROOM_CALLS`), and the excess over its price is exactly `2 * LINE_END_ROOM_CALLS`.
    The flag-off `none` case is finding 4's: first claim = session probe + token. The flag-off `room` case (20) is the normal round with the proof flag off: the job's room, the claim's add with its own token, no read at the first claim.
  - Also: `LINE_CLAIM_COST <= LINE_RESERVATION_MIN`; the recheck costs `lineRecheckCost(LINE_READ_CALLS)` with the flag on and `lineRecheckCost(LINE_FALLBACK_READ_CALLS)` without; a fallback read costs `LINE_FALLBACK_READ_CALLS`, and the overspend is `LINE_FALLBACK_READ_CALLS - LINE_READ_CALLS` per fallback.
  - **The stamp** (finding 7), in the line's suite:
    - A stay's `reservation` and `recheck_cost` are written at its first claim. A second claim of the same stay, after its own mint, re-prices nothing: the `all` stay keeps 9, not `none`'s 8. A restarted stay gets a new stamp.
    - An admitted, completing stay with `recheck_cost` NULL (seeded by a one-column update): it still reads admitted and live (`mine_admitted`, `admitted_live` true), and the pool reserves `coalesce`'s value for it.
    - Sequence: a stay stamped with the flag ON, the flag flipped off, a second claim. The stamp is unchanged; a NEW stay is priced off.
  - In the line's suite:
    - Three waiting stays, priced 9 (`all`, flag on), 8 (`room`, flag on) and 21 (`all`, flag off), wait ahead of a fourth. Its `etaS` is `ceil(max(0, (9+1)+(8+1)+(21+3) + need - pool) / RTK_BUDGET_REFILL_PER_S + pollMs/1000)`.
    - A pool of 17 with one 8-priced stay waiting ahead (9 reserved with its recheck) admits an 8-priced stay at once (9 + 8 = 17) and holds a 9-priced one (9 + 9 = 18).
  - With the proof flag OFF, the gate's idle completing check holds a completing claim below `lineCompletingLevel(3)` = 7 and admits it at 7; with the flag on, at `lineCompletingLevel(1)` = 3 (the defect `LINE_COMPLETING_LEVEL`'s doc comment in seat-line.ts records, lines 68-72 — a level of the recheck cost alone created one board 268.7 s late — must not come back under either; the "P1" note at lines 57-65 is a different matter, the dead-camera re-claim overspend).
  - In `seat-line-one-reader.test.ts`: update `FRAGMENT_USES`. The ahead sum is a NEW reader of `reservation` and `recheck_cost`, not of a guarded column. `lineLiveSql` gains one use in `readStanding` for the ahead sum, so the typed total at the `it` that asserts `uses("lineLiveSql")` is 5 becomes 6, and its title moves with it. Also update the consumer pins for `passTheLine`'s `stayMintOf` and `seatReadCalls` calls. The scanner's anti-vacuity counts must still be above zero, and the eight mutants must still fail.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run to verify they pass**: `cd apps/web && npx vitest run src/server/external-play/ src/server/usecases/__tests__/external-play-line-` (the line suites, the cost suite among them, live in `usecases/__tests__/`; the old second path named a file that does not exist, and vitest positionals are literal filters, so the cost suite was silently left out), plus `src/server/usecases/__tests__/external-play-preflight.test.ts` and `external-play-room.test.ts` for the two `GateAsk` builders.

- [ ] **Step 5: Mutate once, each** (TEST-STRATEGY rule 5; finding 17), restoring after each:
  - price every stay as `"none"` (make `passTheLine` pass `mint: "none"`): the ETA test and the admit/hold test must fail;
  - drop the `coalesce` around `recheck_cost` in `reservedSql`: the null-recheck admitted-stay test must fail;
  - re-price on every claim (drop the `l.reservation is null` / `restart` guard): the "second claim re-prices nothing" test must fail;
  - make `lineFirstClaimCalls("none", …)` return 0: the measured `none` row must fail.

- [ ] **Step 6: Commit** — `feat(line): price each stay by what its first claim meets`.

---

### Task 8: The sweep: arbiter revocations first, the cap, the open-window deferral (and the pre-mint's)

**Files:**
- Modify: `apps/web/src/server/external-play/round-open.ts` (`anyCheckinWindowOpen`), `apps/web/src/server/external-play/window.ts` (the bound's constant tail, below), and the sweep's modules after Task 0:
  - `apps/web/src/server/usecases/external-play/sweep/pass.ts` (`SweepReport`, `SweepDeps`, the constant);
  - `sweep/teardown.ts` (jobs 3 and 3b), `sweep/camera-evidence.ts` (job 5: deferral and cap only; its peer read is UNCHANGED, R6), `sweep/arbiter-revoke.ts` (job 6, split below);
  - `sweep/run.ts` (`runPass`);
  - plus `apps/web/src/server/usecases/external-play/premint.ts` (its deferral, R3).
  The line numbers below are `sweep.ts`'s before the split; re-pin them in the module.
- Modify (the e2e server's env, finding 3): `.github/workflows/e2e.yml` (`e2e-parallel` job env, beside the RealtimeKit fixture values) gains `EXTERNAL_PLAY_WINDOW_DEFER: "0"`, and `docs/runbooks/e2e-local.md`'s recipe gains the same. Run `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` after the edit, with a case added that pins the value.
- Test: `apps/web/src/server/external-play/__tests__/round-open-any-window.test.ts` (new), the sweep suite `apps/web/src/server/usecases/__tests__/external-play-sweep.test.ts` (or its per-module files if Task 0 split it), `external-play-premint.test.ts` (Task 4's), `apps/web/src/server/usecases/external-play/__tests__/open-round.test.ts`, and `apps/web/src/server/external-play/__tests__/batch-anchor-source-guard.test.ts` (rule 3)

**Interfaces:**

```ts
// round-open.ts
/** THE one SQL spelling of a round's window bound, for the alias `o` (a stage_round_opens row) with `f` its fixtures: the round's last
 *  batch start + DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS + CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS, where the last batch start
 *  is opened_at + (batchCount(boards) - 1) * CHECKIN_BATCH_GAP_MS when staggered, opened_at otherwise. Conservative, never a per-board
 *  re-derivation of `windowFor`. Shared with the Match Day plan's "today" rule (match-day-all-in-one Task 5).
 *  The constant tail is declared in window.ts, NOT summed here: rule 3 of batch-anchor-source-guard.test.ts refuses arithmetic
 *  with DEADLINE_AFTER_MS anywhere but window.ts (its `windowArithmetic` scan, lines 188-196). */
export function roundWindowBoundSql(db: AnySql): postgres.Fragment;
// window.ts (re-exports CHECKIN_EXTEND_MAX / CHECKIN_EXTEND_STEP_MS from lib/checkin-extend.ts; CHECKIN_BATCH_SIZE and
// CHECKIN_BATCH_GAP_MS are its own):
export const ROUND_WINDOW_TAIL_MS = DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS + CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS;
/** Is ANY board inside a check-in window, its grace or an extension at `now`? exists(stage_round_opens o where roundWindowBoundSql > now).
 *  Platform-wide in production. `orgIds` (a TEST scope, the sweep's own `SweepDeps.orgIds` rule, sweep.ts:133-136) limits it to
 *  those orgs' rounds, so the shared test DB's other suites cannot flip it (finding 3). */
export async function anyCheckinWindowOpen(db: AnySql, now: Date, orgIds?: readonly string[]): Promise<boolean>;
/** process.env.EXTERNAL_PLAY_WINDOW_DEFER !== "0", read at call time. */
export function windowDeferralOn(): boolean;
// sweep/pass.ts (re-exported from sweep/index.ts)
export const SWEEP_RTK_CALLS_PER_PASS = Math.floor(SWEEP_PASS_BUDGET_MS / 1000); // 45
// SweepReport gains `windowsOpen: 0 | 1` (the pass found a window open and deferred teardown and evidence) — declared as a number in code.
// SweepDeps gains two TEST SEAMS: `windowsOpen?: () => Promise<boolean>` (default: windowDeferralOn() && anyCheckinWindowOpen(sql,
// pass.now, deps.orgIds)) and `rtkCallCap?: number` (default SWEEP_RTK_CALLS_PER_PASS). Production passes neither.
// SWEEP_JOBS gains "arbiter_revocation" (the first job, below); "arbiter_revoke" keeps its name for the rest of job 6.
```

**Order of the pass** (today's `runPass` from line 1463: close_unplayable, reconcile, mint_retry, no_show, teardown, camera_evidence, arbiter_revoke, then job 3b's parked rooms LAST, with plan 1 Task 10b's retention call before the parked rooms). After this task:

1. **`arbiter_revocation` FIRST**, before job 0 (owner ruling R5; plan 3's Global Constraints rely on it). It takes job 6's candidates and keeps only those `arbiterMustGo`'s safeguarding and role arms select: `userId === null` (the account is gone), `!organiser` (no longer an owner/admin of the club), and `isSeatedOn(userId, fixtureId)` (now plays on the board). Each is removed with an UNCAPPED `rtk` (`deps.realtimeKit ?? {}`, never the capped budget) and is never deferred by an open window. It still goes through the platform bucket that `cfEnvelope` applies to every call: that bucket is the vendor's own rate limit, not this pass's policy, so a refusal there is a `RealtimeKitDeferred` retried on the next pass, and it is reported. A watch on an ended room needs no vendor call and is stamped, as today. Running first costs one `removeParticipant` on a room the teardown would end later in the same pass, and that is the accepted price of revoking first.
2. close_unplayable, reconcile, mint_retry, no_show: unchanged and NOT under the cap (finding 15). mint_retry's `createGameIfReady` runs T9's camera re-verify (RealtimeKit reads), and reconcile's result path ends rooms (`endRoomAtResult → endMeeting`, room-end.ts:32-50, 2 calls a room). **Both are stated exemptions**: they create or finish a GAME, and a game held back by the sweep's cap is a player waiting. Neither takes the sweep's deps (`createGameIfReady(id, { now })` and `reconcile(…)` build their own adapters), so their calls are metered by the platform bucket and not counted in `SweepReport`. Threading the capped deps through `create-game.ts` and `reconcile.ts` would change two more modules' signatures and is out of this plan's scope. Their volume is still visible in the report's `mintRetries` and `reconciled`. The rest of finding 15 (counting their calls) is not applied: see the Revision notes.
3. `windowsOpen = await (deps.windowsOpen ?? default)()`, read ONCE, before teardown.
4. teardown (job 3) under the capped budget. A candidate that is not `retirable` is deferred while `windowsOpen` (count it, continue). `teardownCandidates`' `retirable` (sweep.ts 728-730; it already requires a paired fixture) gains `and m.home_entrant_id is not null`, so an unadopted room is never retired and is judged by `meetingIsDone` instead. On an unpaired board (`boardOpenFor` / `bothCameFor`, ~195-200, 741-755) it is ended after the deadline with nobody playing, at 2 calls (finding 16).
5. camera_evidence (job 5) under the capped budget, and the whole job is deferred while `windowsOpen`. **Its peers are read as today** (owner ruling R6): `readCameraEvidence` keeps `listPeerIds` per session (lines 1192-1200) and never reads the presence table.
6. `arbiter_revoke` (job 6, the rest): the TTL arm (`ARBITER_PARTICIPANT_TTL_MS`) and the ended-room arm, under the capped budget and not deferred.
7. plan 1's retention call, then job 3b's parked rooms LAST, under the same capped budget (`end = deps.endMeeting ?? ((m) => endMeeting(m, { ...rtk, budget }))`, keeping the `SweepDeps.endMeeting` test seam; today's default is `endMeeting(m)` with no deps), never deferred.

The capped budget is ONE `cappedBudget(deps.rtkCallCap ?? SWEEP_RTK_CALLS_PER_PASS, rtk.budget ?? platformSpend(rtk))`, built in `runPass`. Today `rtk` (`deps.realtimeKit ?? {}`, sweep.ts line 1493) is declared AFTER `end`, so move it up.

**The pre-mint's deferral** (owner ruling R3: "as the sweep does"): `premintExternalPlay` reads `windowsOpen` once, after the lock and the flag check, with the same default (`windowDeferralOn() && anyCheckinWindowOpen(sql, now, deps.orgIds)`) and seam (`PremintDeps.windowsOpen`). While it is true the pass makes no vendor call, reports `windowsOpen: 1`, and counts every candidate `deferred`. The deferral lives here rather than in Task 4 because this task owns `anyCheckinWindowOpen`, and the Match Day plan cites this task for it. Until this task lands the job is flag-gated off (Task 11), so nothing runs without it.

**Existing tests the deferral breaks, and the fix** (finding 3). The bound is conservative: a sweep's OWN round reads as open for `ROUND_WINDOW_TAIL_MS` (30 min) past its last batch, so these cases red. None of them is about the deferral. They pass `windowsOpen: async () => false` (`NO_WINDOW`, declared once in the sweep suite's shared setup) and keep every assertion:
- `external-play-sweep.test.ts` ~1308-1317 (the withdrawal case sweeps at `b.at(5)` and expects 2 rooms ended) and ~2062-2074 (the cap case sweeps at `CAP_MIN + 5`);
- `open-round.test.ts` ~1645-1650 (the unpair case sweeps at DEADLINE + 2 min and expects 2);
- any further red case that Step 2's run of EVERY sweep importer's suite shows (Task 0's list of 15). Each gets the same seam and is listed by title in the commit message, with the count. A case is re-timed past the tail (from `ROUND_WINDOW_TAIL_MS`, never a typed number) only if it is itself about time.
- The walkthrough `e2e/walkthrough/chess-external-play.spec.ts`: ~836-846 (board 1's rooms torn down by the pass after its game ended, inside the round's window) and ~976-990 (the unpaired round aged by `DEADLINE_AFTER_MS + 2 min`, then polled for teardown). Both would depend on the deferral, and on OTHER specs' open windows, because the e2e server is shared and the cron route takes no `orgIds`. The e2e server therefore runs with `EXTERNAL_PLAY_WINDOW_DEFER=0` (Files, above). The walkthrough is unchanged, and the deferral is proven by this task's DB tests and by the staging gate (Task 11).

- [ ] **Step 1: Write the failing tests**
  - `anyCheckinWindowOpen`: false with no opened round (the empty case first); true inside a window; true during the grace and the maximum extension; false past them; staggered rounds extend by the batch gaps (derive the bound from `window.ts` constants, never a typed number); with `orgIds`, another org's open round is not seen; and `batch-anchor-source-guard.test.ts` stays green (no `DEADLINE_AFTER_MS` arithmetic outside window.ts). `windowDeferralOn`: unset → true, `"0"` → false, `"1"` → true (count 3).
  - Sweep: with 50 ended rooms and a window open (the REAL scoped check, an own round opened a minute ago), teardown ends none of the non-retirable rooms (deferred = their count, `windowsOpen` 1) and ends the retirable ones and the parked ones. Camera evidence makes no call. With `EXTERNAL_PLAY_WINDOW_DEFER=0` the same pass is not deferred.
  - Sweep, no window open: at 45 calls a pass and 2 calls a room, exactly 45 fixture calls are made. 22 rows are stamped ended, the 23rd room is kicked and still active (its row unstamped, ended by the next pass), and the rest are deferred. A second pass finishes them (sequence).
  - Finding 16, the never-paired placeholder: a round opened, a board never paired with its unadopted room on file, past the deadline. The room is ended (2 calls), counted in `meetingsEnded` and NOT retired. The same board BEFORE the deadline is left alone.
  - An unadopted room on a PAIRED board past its deadline with no game is ended by the done path and never counted retired.
  - **R5**, the cap and the window: with a window open AND `rtkCallCap: 0`, a role-removed arbiter (org membership deleted), an account-deleted one (user_id null) and one now seated on the board are each removed at the fixture (`DELETE participant` 3), `arbitersRemoved` 3. The fixture's call log puts those three calls BEFORE any other job's call in the pass. A TTL-expired watch in the same pass is NOT removed (it is capped). Count 4.
  - Camera evidence still lists peers at the vendor (R6): one `GET /sessions/:id/participants` per session, as today, even when presence rows exist for the participant.
  - The remaining capped jobs share ONE cap: a counting `rtk.budget` sees teardown, evidence, `arbiter_revoke` (TTL) and parked-room calls, and none from `arbiter_revocation`.
  - Pre-mint (in `external-play-premint.test.ts`): with an own round's window open, the pass makes no vendor call, reports `windowsOpen` 1 and counts the candidates deferred. With no window it mints. With `EXTERNAL_PLAY_WINDOW_DEFER=0` it mints under an open window.

- [ ] **Step 2: Run to verify they fail**, then run every sweep importer's suite (Task 0's list), and apply the `NO_WINDOW` seam to each red case that is not about the deferral, as above.

- [ ] **Step 3: Implement.** The drift test must still find `failed` and `skipped` declared as numbers; `windowsOpen` is informational.

- [ ] **Step 4: Run to verify they pass**: the whole sweep suite, every sweep importer's suite, the new one, the premint suite, `open-round.test.ts`, `e2e-ci-wiring.test.ts`.

- [ ] **Step 5: Mutate once, each** (restore after each):
  - exempt nothing from the deferral: the "retirable rooms still end while a window is open" case must fail;
  - route `arbiter_revocation` through the capped budget: the R5 case must fail;
  - move `arbiter_revocation` back after teardown: the R5 case's call ORDER assertion must fail;
  - drop the `orgIds` scope from `anyCheckinWindowOpen`: the other-org case must fail;
  - drop `and m.home_entrant_id is not null` from `retirable`: finding 16's "not counted retired" must fail.

- [ ] **Step 6: Commit** — `feat(sweep): arbiter revocations first and uncapped, vendor call cap, defer teardown, evidence and the pre-mint while check-in runs`.

---

### Task 9: Passing fix (spec §9)

**Files:**
- Modify: `apps/web/src/server/external-play/creation-queue.ts`

- [ ] **Step 1:** Replace the comment that says queue wait counts against the caller's claim (creation-queue.ts lines 43-46, "Time WAITING in this queue still counts against the caller's claim") with the constraint as it is: the claim is taken at dequeue (`create-game.ts createAtDequeue`, line 350), so the queue never waits against a claim; the check-in request awaits the create.
- [ ] **Step 2:** Run `cd apps/web && npx vitest run src/server/external-play/__tests__/creation-queue.test.ts` to prove nothing moved.
- [ ] **Step 3: Commit** — `docs(creation-queue): the claim is taken at dequeue`.

---

### Task 10: The walkthrough prices a pre-minted round (the LOCAL pre-check)

This is the fixture-against-fixture run. It proves the wiring and the arithmetic end to end, and nothing about the real vendor. The gate is Task 11 (owner ruling R7).

**Files:**
- Modify: `apps/web/e2e/walkthrough/chess-external-play.spec.ts`, `docs/runbooks/e2e-local.md`, `.github/workflows/e2e.yml` (the `e2e-parallel` job's env block, beside the RealtimeKit fixture values that `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` pins: run that test after the edit)
- Modify (finding 18): `apps/web/e2e/load/line-load.ts` (`LINE_LOAD` gains `stayPrice: { proof: { none: 8, room: 8, all: 9 }, fallback: { none: 21, room: 20, all: 21 } }` and `recheckCost: { proof: 1, fallback: 3 }`, replacing the single `reservation: 21` / `recheckCost: 3`) and `apps/web/src/server/external-play/__tests__/line-load.test.ts` (one pin per number against `lineReservation(kind, LINE_READ_CALLS | LINE_FALLBACK_READ_CALLS)` and `lineRecheckCost`, so the copy cannot drift). A Playwright spec cannot import `seat-line.ts`, which starts with `import "server-only"` (seat-line.ts:1), so the spec reads the bound from `LINE_LOAD`, as the load harness already does.

- [ ] **Step 1:** In the Task 17 flow, before the organizer opens round 1 and with `EXTERNAL_PLAY_PREMINT=1 EXTERNAL_PLAY_PRESENCE_PROOF=1` on the server under test (add both to `docs/runbooks/e2e-local.md`'s recipe and to `e2e.yml`'s job env; `EXTERNAL_PLAY_WINDOW_DEFER=0` is already there from Task 8, without which another spec's open window would defer the job), POST `/api/cron/external-play-premint` with the cron secret header TWICE, as the spec already fires the sweep (line 320, `CRON()` headers), and assert from `video.calls` (the spec's RealtimeKit fixture handle; each call carries `route` and `meetingId`): the first pass makes the rooms, `POST /meetings` count = 2 × boards; the second makes no vendor call at all; `POST /meetings/:id/participants` count = 0 before the open (rooms only, owner ruling 2026-11-17 (2)); each report's `windowsOpen` is 0.
- [ ] **Step 2:** After both players of a board are seated and the game is created, assert the board's vendor calls since the open (`video.calls` filtered by the board's two `meetingId`s). With the walkthrough's instant cameras they number at most `LINE_LOAD.stayPrice.proof.room * 2 + LINE_LOAD.recheckCost.proof` (17). The hand count is 7: each player's first claim adds the participant (1 call; its own token goes to the browser), one peer-report read and the seat's token, plus the re-verify's read. Assert exactly 2 `POST /meetings/:id/participants` since the open, no `POST /meetings` since the open, and no `GET /meetings/:id/active-session`.
- [ ] **Step 3:** A second round opened WITHOUT the pre-mint (the flag off for that part, or the job simply not run): the board still seats and plays; its calls since the open number at most `LINE_LOAD.stayPrice.proof.all * 2 + LINE_LOAD.recheckCost.proof` (19).
- [ ] **Step 4: Run the whole spec file** locally; expected green.
- [ ] **Step 5: Commit** — `test(e2e): the pre-minted round's cost from the fixture's own log`.

---

### Task 11: Staging rollout and the gate (operator checklist, spec §6.8 steps 4 and 5)

**Precondition (finding 8):** plan 3 Task 1 is merged AND deployed to the environment, on staging before Step 2 and on production before Step 4. With the proof flag off, today's arbiter rule admits an arbiter into every pre-minted room the job stamped with its board's pairing (`arbiter.ts` 755-765, a samePair row), before anyone has joined. That is billed, and it contradicts §12.

**Precondition (owner ruling 2026-11-17 (2)), before ANY step below turns `EXTERNAL_PLAY_PRESENCE_PROOF` on, on staging (Step 2) or production (Step 4):** the `closedByEnded` gate condition of plan 1 Task 12 step 5 is met. It is defined there and only there; this plan does not restate it.

- [ ] **Step 1 (local pre-check, not the gate):** the load harness against a LOCAL server with `EXTERNAL_PLAY_PREMINT=1`, `EXTERNAL_PLAY_PRESENCE_PROOF=1` and `LOAD_WEBHOOKS=1` (plan 1 Task 10c's knob; without it the fixture delivers no webhooks and every seat would take the fallback). The fixture listens on 127.0.0.1 only, so this run cannot happen against staging. Record, beside the baseline in `docs/superpowers/plans/2026-11-05-checkin-capacity-baseline.md`: calls per board, time to seat p50/p95, `lockWaitMs` p95, the busy count, and `presenceFallbackCount` (expected 0). Plan 1's own end-of-run presence checks must pass too.
- [ ] **Step 2: THE GATE** (owner ruling R7) is **plan 1 Task 12 step 5**, a staging round against REAL Cloudflare RealtimeKit with the webhook registered. It is defined there and only there, and this plan does not redefine it. Run it AFTER Step 1 is green, as written, with this plan's two flags ON on staging. In the same round, record:
  - (a) `presenceFallbackCount` and the `seat: … fell back` log lines, both kinds (expected 0);
  - (b) at its leave probe, the departed peer's report read every 1 s until `participant.left_at` appears, and the latency (R4's unmeasured fact; Task 6 says what follows if it is longer than a recheck);
  - (c) one board whose rooms the job made while it was already paired (so stamped for that pairing), deliberately re-paired before the open: its rooms retired at the claim (or by the sweep's stale-room retire), and the +4 visible;
  - (d) the pre-mint's reports (`roomsMade`, `windowsOpen`, `deferred`) and the sweep's `windowsOpen` / `deferred`; no `POST /meetings/:id/participants` before the open;
  - (e) whether a pre-minted room that nobody ever joins accrues any charge on the Cloudflare account (unverified today; a charge goes to the owner before production).
  The step's own pass rule stands (its `--strict` shadow report exit 0). Steps 1 and 2 both green, in that order, are the gate. Plan 1's `closedByEnded` condition applies to this run too: a non-zero value here blocks Step 4's proof flag on production until it is met as plan 1 Task 12 step 5 defines it.
- [ ] **Step 3:** `EXTERNAL_PLAY_PREMINT=1` on staging with a Swiss division whose round 1 is paired while the division is still in setup, and a started division with placeholders paired later. The job's report shows rooms for the setup pairing and rooms for the placeholders before their pairing, never a participant (the first claim adds each one), and the open seats every player.
- [ ] **Step 4:** Production: the pre-mint flag first (a week), then the proof flag, each watched on the fallback counter and the sweep's `windowsOpen` / `deferred`. **The proof flag is not turned on until plan 1 Task 12 step 5's `closedByEnded` gate condition is met** (owner ruling 2026-11-17 (2); the condition is defined there, not here).

---

## Self-review notes

- Spec coverage: §6.1 → Tasks 2 to 5; §6.3 → Task 6; §6.4 → Task 7; §6.6 → Task 8; §6.7 (refresh) → covered by the seat's re-entry and token paths, proven by Task 6's recheck and reload cases; §9 → Task 9; §6.8 steps 4 and 5 → Tasks 10 (local pre-check) and 11 (the gate is plan 1 Task 12 step 5, on real Cloudflare).
- Type consistency: `StayMint` (`"none" | "room" | "all"`) is declared in `preflight.ts` and imported as a TYPE by `seat-line.ts`; `cappedBudget` / `platformSpend` (Task 2) are what Tasks 4 and 8 pass as `rtk.budget`; `currentPresence` (with `source`, `receivedAt`, optional `now`) and `recordPresenceFromRead` are plan 1's final signatures. This plan no longer calls `peersOf` (R6: post-match evidence keeps `listPeerIds`).
- Proportion: bodies appear only where the spec fixes exact SQL or an algorithm the signature does not determine (the stamp check, the seat's decision order, the window bound).

---

## Revision notes (2026-11-17, against origin/main 59c72dd361)

Every path, symbol, signature, SQL column and line number above was re-read in the reference tree. The external-play files this plan touches have not moved (the `src/server` folder splits did not reach `usecases/external-play/` or `external-play/`), and every symbol the plan names still exists with the shape it assumes (`ensureMeeting(fixtureId, side, deps)`, private `meetingOnFile` with `samePair`, `retireStaleMeeting(fixtureId, now, end)`, `RETIRED_PAIR`, `cfEnvelope`'s `deps.budget ?? (metered ? takeRealtimeKitCall : null)`, `CallBudget = (key) => Promise<boolean>`, `seatCameraEvidence`/`SeatCamera`, `listPeerIds`, private `type Video` and `playerParticipant` in preflight.ts, `judgeSeat`, `claimEvidenceRead`, `recordEvidence`, `cachedEvidence`, `SEAT_RECHECK_TRUST_MS`, `onlinePlayBoardWhere` at guard.ts:172 and the pairing test at 212-213, `divisionScoringClosed`, `effectivePolicy`, competitions' NOT NULL `camera_policy`, `SWEEP_PASS_BUDGET_MS`, `__retryCandidates`, `SweepReport.failed`/`skipped`, V451's NOT NULL stamps at line 249, the window constants). Changes, old → new:

**Renumbering**
- Migration V493 → V528 (File structure row, Task 1 Files, Step 2 filename and header comment, Global Constraints). Main's highest is V526; siblings: plan 1 V492 → V527, plan 3 V494 → V529. The two `V<next>` placeholders became V528.

**Cron row and its tests (Task 5)**
- Drift test `checked`: "12 → 14" → "14 → 16". Main added four counters since 2026-11-05 (sponsor-deals, quick-match-expiry, stream-tick's YouTube one and email-outbox's).
- Added `apps/cron-worker/test/schedule.test.ts` to Files, Steps 1, 2 and 4, and the Global Constraint: it types `FAST_ROWS = ["stream-tick", "external-play", "email-outbox"]` and `EVERY_FIRING_ROWS` in table order and compares them with `toEqual`, so a new fast-trigger row turns them red. The other fast rows each have a row-pin case.
- Row position: the plan gave none. It is now "after `stream-tick`, before `external-play`", because `run.ts` line 59 runs a firing's rows one after another (owner accepted 2026-11-17: Resolved 1).
- Route test: kept at `__tests__/route.test.ts`. Noted that the sweep's `route.test.ts` sits beside its route and builds a relative `cronSrc` URL, so the copied URL needs one more `../`. Also noted that it pins the pass budget below `JOB_TIMEOUT_MS`. The "assert the row's path resolves" step is already done by the drift test's generic case.
- The route imports the report type from its own module, as the sweep route does. The drift scan reads every `.ts` file in a folder reached through `index.ts`, so `premint.ts`'s `failed: number` and `skipped: number` are found either way.

**Paths and greps that pointed at nothing**
- Task 3's grep for `retireBoardsMeetings\|RETIRED_PAIR` in `usecases/external-play/__tests__/` matched no file. It now points at `open-round.test.ts` (and `open-round-property.test.ts`).
- Task 6's `grep -l seatPlayer` looked in `usecases/external-play/__tests__/`, where it finds only the two open-round suites. The seat suites are in `usecases/__tests__/`.
- Task 7 Step 4's `src/server/usecases/external-play/__tests__/external-play-line-cost.test.ts` does not exist, and as a literal vitest filter it silently left the cost suite out. It is now `src/server/usecases/__tests__/external-play-line-`.
- Task 8's sweep suite is now the exact path `usecases/__tests__/external-play-sweep.test.ts`. Task 9's "whatever the queue's suite is named" is now `creation-queue.test.ts`. Task 2's "`realtimekit*.test.ts` suites" is now `realtimekit.test.ts` plus `budget.test.ts`.
- Task 10's `fixture.calls` is now `video.calls`, the spec's handle (`RealtimeKitFixtureCall` carries `route` and `meetingId`). The `e2e.yml` env goes in the `e2e-parallel` job, whose lines `e2e-ci-wiring.test.ts` pins. The runbook and workflow were added to Files.

**Tests and readers the plan missed (they would have gone red, or been left reading a value that changed)**
- Task 1 Step 3 said the sealed catalog test "stays green". It does not: `online-chess-video-schema.test.ts` lines 80-97 expect `23502` (not null) for a single missing stamp. The step now updates that case to the new check constraint (`23514`) and adds the both-null positive pair.
- Task 2: `adoptRooms` is a both-sides statement on `fixture_video_meetings`, so it must join `BOTH_SIDES` in `video-per-player-source-guard.test.ts` (rule 1). Without that, the source-guard run in Step 4 reds.
- Task 7: `LINE_MINT_CALLS = 2` and `LINE_READ_CALLS = 3` exist today, and the plan's `LINE_READ_CALLS = 1` re-values an existing export. The Global Constraint now says so, and Task 7 Files lists every current reader: 11 test files, `_external-play-line.ts` and the 2 load-harness files. The cost suite's line 138 pins the old trio to the fixture's counts.
- Task 7: `room.ts queueDeferred` (lines 667-685) is the second production `GateAsk` builder (for `settleDeferral`). The plan named only `passTheLine`. Added.
- Task 7: Step 1 cited "the P1 note" for the completing-level defect. That defect is recorded in `LINE_COMPLETING_LEVEL`'s doc comment (lines 68-72); P1 (lines 57-65) is the dead-camera overspend. Corrected.
- Task 8: rule 3 of `batch-anchor-source-guard.test.ts` refuses `DEADLINE_AFTER_MS` arithmetic outside window.ts, and `roundWindowBoundSql` in round-open.ts would sum it. The constant tail moves to window.ts as `ROUND_WINDOW_TAIL_MS` (a new export; `roundWindowBoundSql`'s name and shape, which the Match Day plan's Task 5 reuses, are unchanged). window.ts was added to Files.
- Task 8: in the sweep, the deps field is `realtimeKit` (`rtk = deps.realtimeKit ?? {}`, declared after `end` today), and `end` has a `SweepDeps.endMeeting` test seam. The plan's `end = (m) => endMeeting(m, { ...rtk, budget })` now keeps that seam.
- Task 6: the camera-report allow-list is `CAMERA_REPORT_FILES` in the guard test, not in `_video-source-scan.ts`. `camera-report.ts`'s only read is the writer's `for update` lock read. (After Resolved 2, `_video-source-scan.ts`'s `CAMERA_REPORT_COLUMNS` gains the new column.)
- Smaller pins: `peerReportCamera` rethrows `RealtimeKitDeferred` (as `seatCameraEvidence` does at :694), and `seatCameraEvidence` maps `none` back to `starting`. `PLAYABLE_STATUSES` is sweep.ts's private const (line 211). Task 3's UPDATE uses `from fixtures f`. The barrel is `export *` lines. `no-import-cycle.test.ts` was added to Task 4 and Task 6 verification.

**Interfaces plan 3 consumes:** unchanged in name (`reportedCamera`, whose result gains the field `firstLiveAt` (Resolved 2), so an existing destructure still type-checks; the `camera-reported.ts` leaf, `presenceFallbackCount`, and also `platformSpend`, `cappedBudget`, `peerReportCamera`, `adoptRooms`, `PREMINT_*`, the `LINE_*` and `line*` exports). One new export: `ROUND_WINDOW_TAIL_MS` in window.ts.

### Resolved by owner 2026-11-17 ("apply rec")

These were the four "Open for owner" items. Each is closed as the owner ruled, and each was re-checked against the reference tree.

1. **The pre-mint row against a Worker that runs a firing's rows one at a time.** The ruling: ACCEPTED as placed, after `stream-tick` and before `external-play`, including its cost. `apps/cron-worker/src/run.ts` line 59 runs due rows in sequence (`JOB_TIMEOUT_MS` 60 s per job, `RUN_DEADLINE_MS` 12 min per firing), so while a premint pass has work the sweep (every 5 minutes) and the email outbox (every minute) wait up to one premint pass, 45 s. `data.skipped` stays in the row's `failureCounts` (drift +2, 14 → 16). Task 5 is unchanged except that its pointer now names this ruling.
2. **The fallback clock and the camera report's refresh.** The ruling: record the FIRST live report separately, in a field set once per live run of a seat's stay and never re-stamped by the 30 s heartbeat, and have the fallback clock read it. Today `camera-report.ts` (lines 59-88) re-stamps `camera_reported_at` on `written` and `refreshed` alike. Changes:
   - V529 (Task 1) adds `fixture_video_participants.camera_live_first_at timestamptz null`, with `fixture_video_participants_camera_live_first_check` (set only while `camera_reported = 'live'`), and the catalog test gets a refused/accepted case for it.
   - The writer's one UPDATE sets it on a `live` write over a stored state that is not `live`, keeps it on `live` over `live` (including `refreshed`), and clears it on `off`. `ignored` writes nothing, as today.
   - `reportedCamera` returns `firstLiveAt`, and `judgeSeat` step 2 starts the clock at `coalesce(presence_fallback_from, report.firstLiveAt)`.
   - The column joins `CAMERA_REPORT_COLUMNS` in `_video-source-scan.ts`. The guard's regex is `\b`-bounded, so without that it would not be guarded. The allow-list `CAMERA_REPORT_FILES` gains nothing new, because the writer and the leaf reader are already its members after Task 6.
   - Tests in Task 6: in the writer's suite, "a second live heartbeat does not move camera_live_first_at" and the transition table, counted; in the seat suite, "the clock starts at the FIRST live report".
   - The mutation (Task 6 Step 5): re-stamping `camera_live_first_at` on `refreshed` must turn both tests red.
   - (Superseded by "Review fixes 2026-11-17", finding 6: the premise below is false, because participant rows live for the meeting's life and are reused by every reload; the clock is now bounded below by `token_issued_at`.) "Per seat stay": a new stay gets a new participant row, so the stamp starts null. Inside one stay, an `off` clears it, and the next `live` starts a new run. This matches `judgeSeat`, which already clears `presence_fallback_from` whenever the report is not `live`.
3. **sweep.ts is 1504 lines.** The ruling: split it first, as "Task 0", a SEPARATE pure-move PR before this plan, per `apps/web/src/server/MODULARIZATION.md`: verbatim moves behind an identical barrel, no behaviour change, and the importers keep importing the barrel. Task 0 is above Task 1.
   - Re-checked: the earlier "14 files" were 11 importers outside the folder, the 2 path-pinning guards and `arbiter-view.test.ts`'s comment. The grep missed the 4 importers inside `usecases/external-play/`: the barrel, `room.ts`, `open-round.test.ts` and `video-rooms-to-end.test.ts`. Task 0 lists all 15 importers; none of them changes.
   - Only two of them pin the FILE by path: `seat-line-one-reader.test.ts` and `batch-anchor-source-guard.test.ts`. Those rows are repointed to the modules. The earlier note's "line-load" was wrong: `line-load.test.ts` imports the module by specifier and needs no change.
   - No importer uses a `.ts` extension, and nothing mocks the module.
   - Task 8's edits now name the post-split modules: `sweep/pass.ts`, `teardown.ts`, `camera-evidence.ts`, `arbiter-revoke.ts`, `run.ts`. Task 4's `PLAYABLE_STATUSES` note now names `sweep/pass.ts`. No other task edits the sweep.
4. **The arbiter in an empty pre-minted room.** The ruling: plan 3 owns it (`docs/superpowers/plans/2026-11-05-checkin-capacity-3-arbiter.md`). With the proof flag (`EXTERNAL_PLAY_PRESENCE_PROOF`) off, the arbiter's join refuses until the player has actually checked in. So an adopted pre-minted room no longer counts as "checked in" by itself, as it would under today's test (`arbiter.ts` lines 755-765: a meeting row made for the current pairing). This plan changes nothing in `arbiter.ts`. Its unadopted rows already read as not started there, and the adopted case is plan 3's.
5. **Execution order** (recorded in the header): capacity plan 1 → this plan (Task 0 first, as its own PR) → plan 3 Tasks 1-3 → the Match Day plan → plan 3 Task 7.

### Review fixes 2026-11-17

Applied from `.superpowers/sdd/2026-11-17-checkin-capacity-review/plan-2.md`, from the owner's rulings R1 and R3-R7 (2026-11-17), and from the coordinator's cross-plan items (the design's price re-derivation, plan 3's reviser, plan 1's final interfaces). Every claim below was re-read in the ref tree (origin/main 59c72dd361).

**Owner rulings**
- **R1 (prices).** The table is in Global Constraints, re-derived from `preflight.ts verifyRequiredSeat` (~437-465). A pre-minted participant carries no token, so its first claim pays `refreshParticipantToken` (~464). With the flag off it also pays today's read, which finds no session (`seatCameraEvidence` → `liveSessionId`, realtimekit.ts ~651-656).
  - Flag ON: none 8, room 8, all 9. Flag OFF: none 21, room 20, all 21.
  - A room stamped for an earlier pairing is priced `"all"`, and its retirement (+4 a board) is left uncovered. This matches the design's decision, and the design's figures agree with this plan's independent derivation.
  - The "nothing under-reserves" claim is now stated exactly (four named uncovered costs).
  - `recheck_cost` has a writer (`upsertStay`), and `reservedSql` coalesces it.
  - The Goal's "5 to 13" is now "6 or 7" for a fully pre-minted instant-camera board.
- **R3.** Candidates include setup divisions' PAIRED boards (Swiss round 1, swiss-boards.ts ~150). Nearest round first is an explicit `ORDER BY`, with a test that perturbs the key and a mutant. The job defers while any window is open, in Task 8, which owns `anyCheckinWindowOpen`; Match Day cites it there.
- **R4.** Mechanism: the peer report's own `participant.left_at`, read in the one call. Verified in realtimekit.ts (`videoOffCoverage` parses it, ~913/927) and in `e2e/realtimekit-fixture-server.ts` (`rowJson` ~245, spread into the peer-report body ~391).
  - A `left` peer is never judged; the same claim takes the counted departed-peer fallback. No presence row is closed: plan 1 says only a webhook closes a row.
  - Unmeasured: the latency of `left_at` on the real vendor (recorded in Task 11 Step 2(b)), and whether it is per peer or per row (the fixture's is per row).
  - Tests: lost leave + departed peer, not seated; and plan 1's fallback-then-leave sequence (coordinator item 5), both inside and after the read row's 10 s trust.
- **R5.** `arbiter_revocation` (the account-gone, role-removed and seated arms) runs FIRST, uncapped and never deferred. The TTL and ended-room arms stay capped in job 6. It is tested (3 removals under `rtkCallCap: 0` and an open window, with call order) and mutated twice.
- **R6.** Post-match evidence keeps `listPeerIds`. The peers-from-presence change and its tests are removed from Task 8, and `peersOf` is no longer consumed.
- **R7.** The gate is plan 1 Task 12 step 5 (real Cloudflare), pointed to, not redefined (coordinator item 6). Task 10 and Task 11 Step 1 are local pre-checks, and Step 1 sets `LOAD_WEBHOOKS=1`. The old "load harness on staging" step could not run (the fixture listens on 127.0.0.1) and is gone.

**Findings** (# → change)
1. Task 0 Step 4 now lists the two per-file counts: batch-anchor "files that build a rank" 5 → 8, with the comment at :453 rewritten per module, and seat-line "files with pinned sites" 4 → 6. The rule is now "every assertion kept; a per-file count moves only by the files the split adds". Step 7 checks the guards' totals.
2. `retireBoardsMeetings` gains a mode: `"reopen"` spares, `"rearm"` is today's. The R2-3 "STALE mint claim" and "bare pending row" cases are rewritten to stamp an EARLIER pairing, the re-arm tests stay unchanged, and there are three mutants. **Found while applying:** sparing an ENDED current-pairing row would make every later claim throw `VIDEO_MEETING_ENDED` (realtimekit.ts ~427), so ended rows are still retired, with a test and a mutant.
3. `SweepDeps.windowsOpen` / `PremintDeps.windowsOpen` seams, `anyCheckinWindowOpen(…, orgIds?)` scoped for tests, and `EXTERNAL_PLAY_WINDOW_DEFER=0` on the e2e server (pinned in e2e-ci-wiring). The three named suite cases plus every red found by running each sweep importer get `NO_WINDOW`, listed in the commit. The walkthrough's ~836-846 and ~976-990 are named and stay unchanged under the env.
4. The prices are re-derived (R1), and the flag-off pre-minted case is in the cost test. The design figure was raised through the coordinator; the design agent's re-derivation now agrees.
5. `stayMintOf` counts only an unended current-or-unadopted room, with the participant on THAT room; anything else is `"all"`. The re-paired-after-adoption case is measured in Task 7 (9 + 4 / 21 + 4).
6. Reload: the fallback clock is `greatest(…, token_issued_at)`, a new V529 column stamped on every token handed. The writer also restarts a run whose stored `live` is stale. Tests cover the webhooks-up reload (no fallback, 1 read) and the camera previewed before the first claim.
7. `upsertStay` writes `reservation` AND `recheck_cost` at a stay's first claim and never re-prices inside a stay. `reservedSql` coalesces both. Tests cover a null-`recheck_cost` admitted completing stay and a second claim re-pricing nothing.
8. Flags wait for plan 3 Task 1 to be merged and deployed (header and Task 11 precondition).
9. The no-presence fallback is taken under `claimEvidenceRead`, with a racing-claims test (one read) and a mutant.
10. `ParkedRoom` and `anchorIfClosedNow` move to `sweep/pass.ts`. The `playableWindow` split becomes pass 1 / no-show 2 / teardown 1 / reconcile 1, and Step 7 adds a direction check.
11. The writer's lock read stays in camera-report.ts; only room.ts and the seat use the leaf. `CAMERA_REPORT_FILES` = camera-report.ts + camera-reported.ts.
12. The writer coalesces `camera_live_first_at` on a fresh live-over-live, and the reader treats a fresh live with a null stamp as a run starting now. Both are tested and mutated. There is no "live implies stamped" CHECK, because the app version running while V529 applies would violate it.
13. `since = least(joinedAt, receivedAt)`, from plan 1's final `currentPresence`, which returns `source`, `receivedAt` and takes `now` (coordinator item 3). A `read` row is current only for `PRESENCE_READ_TRUST_MS`.
14. A premint participant candidate requires an unended current-or-unadopted row and carries its `meetingId`. The row is re-read after `adoptRooms`, and a null fixture is `noPlayer`. Tested. (Superseded by owner ruling 2026-11-17 (2): there is no participant candidate.)
15. **Partly applied.** mint_retry's and reconcile's vendor calls are stated exemptions from the cap and the deferral, with the reason (they create or finish a game). **Not applied: counting their calls in the report.** Neither takes the sweep's deps, and threading the capped deps through `create-game.ts` and `reconcile.ts` changes two more modules' signatures outside this plan. The platform bucket still meters them, and `mintRetries` / `reconciled` show their volume.
16. Task 8 adds the never-paired placeholder case (opened round, unpaired board, past the deadline: ended, 2 calls, not counted retired; before the deadline: untouched) and a mutant.
17. Mutation steps are added to Task 3 (three mutants) and Task 7 (four mutants, including "price every stay as none"). Task 4 gains withdrawn and voided board cases and its single-sport reason (chess-only online play).
18. Task 10 reads its bound from `LINE_LOAD` (`e2e/load/line-load.ts`), which gains the price table, pinned per number in `line-load.test.ts`.
19. `Video` gains `peerReportCamera`, and `REAL_VIDEO` / `videoWith` bind it. The seat reads through `video.peerReportCamera`. (After owner ruling 2026-11-17 (2): `videoWith` is dropped with the job's participant step; `REAL_VIDEO` alone binds it, in Task 6.)

**Coordinator cross-plan items**
- The V529 replay: plan 3's reviser found that V529 breaks `online-chess-video-schema.test.ts`'s V459 replay. That case compares the replica's shape after V459 with the LIVE tables. Task 1 Step 3 now replays every later delta's statements on the three tables in the scratch schema, with a per-file anti-vacuity map (`V529: kept 7, skipped 2`), a by-name failure for an unlisted delta, and a mutant. The `fixture_seat_line` lines are never run there, so the "no strong lock on a LIVE table" case stays green.
- Plan 1 Task 10b's retention call is in Task 0's move inventory (`sweep/run.ts`).

**Interface changes other plans should know** (names plan 3 imports are unchanged):
- `peerReportCamera` gains `{ camera: "left"; leftAt }`.
- `anyCheckinWindowOpen` gains an optional `orgIds` (additive; Match Day's `roundWindowBoundSql` is unchanged).
- New `windowDeferralOn()` and env `EXTERNAL_PLAY_WINDOW_DEFER`.
- `SweepDeps.windowsOpen` / `rtkCallCap` and `PremintDeps.windowsOpen` seams; `PremintReport.windowsOpen`; `PremintCandidate.meetingId`.
- `SWEEP_JOBS` gains `"arbiter_revocation"`.
- `retireBoardsMeetings(…, mode)` (private).
- New constants `LINE_SESSION_PROBE_CALLS`, `LINE_END_ROOM_CALLS` and `lineFirstClaimCalls`. `LINE_RESERVATION_MIN` is now 8 (was 7); `LINE_RESERVATION_MAX` stays 21.
- `upsertStay` takes `recheckCost`.
- V529 adds `fixture_video_participants.token_issued_at`.
- `StayMint` is unchanged (`"none" | "room" | "all"`).
- Plan 2 no longer consumes plan 1's `peersOf`.

### Owner rulings 2026-11-17 (2) ("apply both rec")

1. **The pre-mint job makes rooms only.** A pre-minted participant has no token (tokens are never stored), so the seat pays a refresh that replaces the add one for one: zero calls saved at the seat, and one MORE with the proof flag off (the absent probe the F1 shortcut skips). Dropping the step saves about 200 off-peak calls per 100 boards a round and removes participant churn on a re-pair. Everything about rooms is unchanged: placeholder or paired boards, the unadopted stamp, nearest round first, setup divisions with pairings, the open-window deferral. Changes, old → new:
   - Architecture and Goal: the job makes rooms only; the first claim adds the participant with its own token (the hand count of 7 per board is unchanged; its first-claim call is now the add, not a refresh).
   - Adoption: only the claim's `ensureMeeting` runs `adoptRooms`. Verified that the job has no reason to call it: a candidate side never has a row on file, so `ensureMeeting`'s adoption branch cannot fire from the job; and no later job step reads an adopted row, because the participant step that needed one is gone. `adoptRooms` stays exported (plan 3's consumed list names it) and keeps its Task 2 tests.
   - Task 4: `PremintStep` removed; `PremintCandidate` loses `step` and `meetingId`; `PremintReport` loses `adopted`, `participantsMade` and `noPlayer`, and `failures[]` loses `step`. The participant-candidate clause and the `step` sort key are removed from the candidate query and its `ORDER BY`. Tests removed: the participant-row candidate case, the earlier-pairing participant case (folded into "a side with ANY room on file yields no row", count 4), the two `noPlayer` cases. Tests added: the rooms-only pass after pairing (0 vendor calls, stamps stay null, the claim adopts), a paired board stamped by the job with no participant. The finding-14 mutant is replaced by one on the `not exists fixture_video_meetings` clause.
   - Task 4 / Task 6: `preflight.ts` no longer exports `type Video`, `videoWith` or `playerParticipant` (they existed only for the job); `Video`'s `peerReportCamera` and `REAL_VIDEO`'s binding move to Task 6's Files. No other plan named them (grep of plans 1, 3 and the Match Day plan: none).
   - Prices (Global Constraints, Task 7): unchanged numbers, renamed roles. `"room"` is the normal round, 8 with the proof flag, 20 without. `"none"` stays as a code kind (the participant already on file from an earlier claim, i.e. a restarted stay; the job never produces it), 8 / 21. `"all"` 9 / 21; a room from an earlier pairing is `"all"` with its +4 outside. `LINE_RESERVATION_MIN` re-checked: still 8, equal to `"room"`'s. `LINE_RESERVATION_MAX` 21, `LINE_CLAIM_COST <= LINE_RESERVATION_MIN` both hold. Task 7's measured row order is now `[room, none, all]`; the `room` stay is driven through the premint pass, the `none` stay through a restarted stay.
   - Task 6: the null-`token_issued_at` case is now a row from before V529 (the job no longer makes token-less participants); the token-stamp case drops "the pre-mint's mint" (count 5 → 4); `stayMintOf` gains the job's own room as a `room` case (count 6 → 7); the `greatest` mutant and the null-arm mutant are listed separately.
   - Task 10: one premint pass makes the rooms and the second makes no call; 0 participant adds before the open; the bound reads `LINE_LOAD.stayPrice.proof.room` (still 17), with exactly 2 participant adds since the open.
   - Task 11: Step 2(c) re-pairs a board the job stamped while paired (adoption before the open no longer happens); 2(d) and Step 3 read rooms only.
   - Plan 3's "pre-mint shape" seeds (meeting row + participant row) are now worded as "not arrived" (the participant row a camera-refused claim leaves); the check-in gate itself is unchanged.
2. **`closedByEnded` gates the proof flag.** A non-zero `closedByEnded` at plan 1 Task 12 step 5 blocks turning `EXTERNAL_PLAY_PRESENCE_PROOF` on until explained and recorded. The condition is defined in plan 1 Task 12 step 5 only; Task 11's new precondition and Steps 2 and 4 point at it. Removed from "Open for owner".

### Open for owner (2026-11-17)
1. **For information:** with the pre-mint deferring while ANY window is open (R3), a day of staggered rounds may leave little pre-minted (Review Focus 7). Task 11 Step 2(d) measures it.

## Revision notes (2026-11-18, Task 1 as built)

- **Renumbered V528 → V529** in every live reference above (the two 2026-11-17 renumbering records keep their text): a separate fix PR on main holds V528 (the stage lots-draw index fix). Plan 3's migration moves to V530.
- **Merge gate.** Flyway runs with outOfOrder=false, so V528 must merge before V529 reaches any database. The V529 header says so.
- **The first-live check is `camera_reported is not distinct from 'live'`, not `= 'live'`** (controller ruling 2026-11-18). With `=`, a null `camera_reported` makes the check NULL, which passes (three-valued logic), so a stamp beside no report at all was admitted: the Task 1 catalog case "stamped beside null is refused" failed against the plan's DDL. The strict form also refuses a build older than Task 6 writing `off` over a stamped row (23514): Task 6's writer clears the stamp in the same statement as every non-live write.
- Task 1 Step 2's SQL block above is now the shipped file, verbatim.
