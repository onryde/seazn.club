# Check-in capacity: baseline load run (plan 1, Task 11)

The numbers plans 2 and 3 are measured against. Operator task, local only, 2026-11-18. Nothing here is a production
number; it is the load harness (`apps/web/e2e/load/chess-30-boards.load.ts`, its fixture vendors) driving a local
production build.

## Provenance

- **Commit:** `f9b6027a489a747a7b246bd73256b86af6f8ceb9` (branch `feat/checkin-capacity`, worktree
  `seazn.club-worktrees/checkin-capacity`). Ruling: the run is on this branch's build, not `main`; batches 1-2 changed no
  seat code (plan 1 only adds webhooks and presence, dark), so the seat numbers are today's.
- **Build:** `seazn-env up --label ckcap-t11 --no-placement --server` (`NEXT_LEAN_BUILD=1 NEXT_BUILD_FS_CACHE=1
  SKIP_TYPECHECK=1 turbo run build`), then the standalone server started by hand per run (below). Postgres is the label's own
  cluster (`show data_directory` = `/tmp/seazn-env/ckcap-t11/pg`, verified before every run).
- **Fresh database per run:** each run clones the migrated label DB (`createdb -T`, schema v527, sports synced) into its own
  database, so no run sees another's meetings. The server is started per run on `:3391` against that database, and stopped by
  PID afterwards. The harness's fixture vendors are its own (Lichess `:4321`, RealtimeKit `:4322`), started by the test.
- **Server env** (fixtures, no `.env.local`): `LICHESS_BASE_URL=http://127.0.0.1:4321 REALTIMEKIT_BASE_URL=http://127.0.0.1:4322
  REALTIMEKIT_METER_ANY_BASE=1 ONLINE_CHESS_ALWAYS=1 CLOUDFLARE_ACCOUNT_ID=e2e-rtk-account REALTIMEKIT_API_TOKEN=e2e-rtk-api-token
  REALTIMEKIT_APP_ID=e2e-rtk-app REALTIMEKIT_PLAYER_PRESET=e2e_chess_player REALTIMEKIT_ARBITER_PRESET=e2e_chess_arbiter
  RELAY_DRIVERS=fake ENV_NAME=local REALTIME_PUBLISH=off AUTH_DEV_LINKS=1 RESEND_API_KEY=` plus `AUTH_SECRET`, `CRON_SECRET`,
  `LICHESS_TOKEN_KEK` (fixture values), `DATABASE_URL`/`DATABASE_SSL=disable`; stdout is the `LOAD_SERVER_LOG`.
- **Runner command** (from `apps/web`):
  `PLAYWRIGHT_BASE=http://localhost:3391 E2E_PROD_TARGET=1 DATABASE_URL=<that run's db> DATABASE_SSL=disable AUTH_SECRET=... CRON_SECRET=... LICHESS_TOKEN_KEK=... LOAD_SWEEP_EVERY_S=300 LOAD_WEBHOOKS=<0|1> LOAD_REPORT=... LOAD_SERVER_LOG=... <scenario env> npx playwright test -c playwright.load.config.ts`
- **Board count used: `LOAD_BOARDS=100` = 200 players** (the harness's own setting; default 30).
- Scenario env shared by the burst runs: `LOAD_ARRIVAL_SPREAD_S=60 LOAD_OPENED_AGO_S=250`, plus
  - `B`: `LOAD_SCENARIO=B LOAD_CAMERA_LAG_MIN_S=0 LOAD_CAMERA_LAG_MAX_S=0`
  - `B-honest`: `LOAD_SCENARIO=B-honest LOAD_CAMERA_LAG_MIN_S=1 LOAD_CAMERA_LAG_MAX_S=3`
  - `B-slow-5`: `LOAD_SCENARIO=B-slow-5 LOAD_CAMERA_LAG_MIN_S=5 LOAD_CAMERA_LAG_MAX_S=5`
  - `B-slow-10`: `LOAD_SCENARIO=B-slow-10 LOAD_CAMERA_LAG_MIN_S=10 LOAD_CAMERA_LAG_MAX_S=10`
- The burst runs were all `LOAD_WEBHOOKS=0` (the baseline: the fixture emits webhooks, delivers none: `emitted 600, delivered 0`).
- **Machine caveat.** The machine was shared with other sessions' builds and gates throughout. Load average (1 min) swung
  between 4 and 480 during the session; the two completed runs overlapped spikes (see each run). Latency tails (`max`,
  p95 of room reads and seat claims) carry that noise; the call counts and the gate/ledger arithmetic do not (they are
  counts of the fixture's calls and of the product's own decisions).

## Step 2: the 200-player burst runs

| Scenario | Exit | Wall | Verdict |
| --- | --- | --- | --- |
| `B` | **0** (3 passed) | 21.4 min, `runSeconds` 1250 | green; every bar of the burst cost scenario met |
| `B-honest` | **1** | 24.2 min, `runSeconds` 1428 | red: one `room read answered 500` (see below); the later bars were not reached (2 unexcused position rises were already recorded) |
| `B-slow-5` | no report | see "Runs that produced no report" | not completed |
| `B-slow-10` | no report | see "Runs that produced no report" | not completed |

### The numbers (Step 3)

| | `B` (instant cameras) | `B-honest` (1-3 s cameras) |
| --- | --- | --- |
| Boards / players | 100 / 200 | 100 / 200 |
| **Calls per board**, check-in only, attributed by `meetingId` (the fixture's own calls; the cost verdict's per-stay spend, two stays a board) | 6 per stay, 200 of 200 stays at 6 (12 per board); reservation 21, re-verify cost 3, max 6 | 6 / 9 / 12 per stay (94 / 78 / 28 stays); max 12 (12 to 24 per board); 1 stay with unreserved client spend |
| Calls per board, whole run (all RealtimeKit calls / boards) | **23** (2300 total) | **28** (2804 total) |
| RealtimeKit calls, busiest 5 minutes (ceiling 900, vendor 1200) | 687 | 876 |
| **Time to seat** (arrival to seated), p50 / p95 / max | **3.09 s / 29.1 s / 47.4 s** (200 seated) | **20.8 s / 190.1 s / 200.4 s** (200 seated) |
| First claim to last seat | 817.7 s | 824.7 s |
| **`lockWaitMs`** (`seat-line: gate decision` log), p95 / max, n | **21 ms** / 440 ms, 565 decisions | **174 ms** / 4280 ms, 1754 decisions |
| **`seatLineBusyCount`** (`seat-line: gate lock busy`) | **0** | **7** |
| Gate decisions | go_idle 372, hold_blocked 141, hold_pool 22, admit 27, hold_recheck 3 | go_idle 372, hold_blocked 1108, hold_pool 108, admit 86, go_admitted 75, hold_recheck 5 |
| Held stays / lowest bucket level at a gate decision | 27 / 4.8 | 101 / 2.3 |
| Admission pairs / unexcused inversions; positions looked at / unexcused rises | 351 / 0; 139 / 0 | 3655 / 0; 1130 / **2** |
| Seat answers | camera_required 200, seated 200, queued 166 | camera_required 200, camera_starting 134, seated 200, queued 1228 |
| Seat deferrals / sweep deferred | 0 / 31 | 0 / 703 |
| Claims per player (min / max) | 2 / 12 (566 total) | 2 / 28 (1762 total) |
| Database peak connections (budget 60) | 5 | 5 |
| Room read p50 / p95 / max | 18 / 238 / 1713 ms | 26 / 3417 / 37016 ms (machine spike) |
| Seat claim p50 / p95 / max | 30 / 267 / 3346 ms | 31 / 8409 / 59416 ms (machine spike) |
| Move p95 | 129 ms | 521 ms |
| Peak transactions per second (harness's measure) | 1964 | 2136.5 |
| Lichess creates / 10 min | within bound (assertion held) | not reached |

Webhooks block, both runs: `enabled false, emitted 600, delivered 0, failed 0, down 600`.

**B-honest red, exactly.** `expect(failures).toEqual([])` received `["room read answered 500 (Load 94 mwlwu20b)"]`. The
server log has one matching error: `v1: unhandled error ... UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1`
(postgres.js, thrown from the socket data handler). It was not reproduced and not diagnosed: it occurred during a machine
load spike (1-minute load 120 to 480 from other sessions' work), and `B` did not show it. It is a finding to carry, not
a baseline number. The harness also recorded 2 unexcused position rises and 7 `gate lock busy` refusals in this run,
against 0 and 0 in `B`; the same caveat applies to them, and a quiet-machine re-run of `B-honest` is owed before they
are read as the line's behaviour.

**Order and cost bars in `B`** (the numbers plan 3's arbiter is compared with): 351 admission pairs checked with 0
unexcused inversions, 139 positions looked at with 0 unexcused rises (13 excused), 200 stays costed with 0 over
reservation and 0 over the re-verify cost, 0 gate-lock busy refusals.

### Runs that produced no report (recorded, not omitted)

- **`B-slow-5`.** Four attempts, none with a harness report:
  1. Started 09:43, **stopped by me** at ~18 min (the machine's load average was 350-450 from other sessions; stopped per the
     brief's load rule). Nothing recorded.
  2. 10:16-10:41: harness `fetch` aborted after its own 60 s limit (`TimeoutError`) at 24.7 min, at a load spike of 165 at
     the end of the run. The server log of that run showed `seat-line: gate lock busy` (busy 19) under that spike; not a
     baseline number.
  3. 10:47-11:17, on a mostly quiet machine (load under 25 apart from one 45 spike): `Test timeout of 1800000ms exceeded`
     (the load config's 30-minute budget, `playwright.load.config.ts` `timeout`). All 100 games had been decided and 200
     result events written (server log: `fixture decided` 100, `scoring event appended` 200); the run was still in its
     tail when the clock ran out, so no report was written. **At 200 players `B-slow-5` does not fit the harness's
     30-minute test budget** (`B` took 21.4 min, `B-honest` 24.2). The server-log-derived gate figures for this attempt:
     16461 gate decisions, `lockWaitMs` p95 **37 ms** / max 2348 ms, 0 `gate lock busy`, lowest bucket level 0.2,
     decisions go_idle 114, hold_blocked 14998, hold_pool 493, admit 183, go_admitted 672, hold_recheck 1. These are server-log
     numbers only: calls per board and time to seat for `B-slow-5` are NOT measured.
  4. Two later launches (a second, overlapping queue of mine) answered `port 4321 busy` at the harness's own preflight and
     never started a run (the fixture ports were held by the run in flight). They ran nothing.
  To record a `B-slow-5` baseline: re-run it alone with `--timeout=2700000` (or at `LOAD_BOARDS=30`, the harness's
  default size), on a quiet machine.
- **`B-slow-10`.** One attempt, 11:17-11:34: harness `fetch` aborted after its 60 s limit (`TimeoutError`) at 16.7 min with
  46 of 100 games decided, coinciding with a machine load spike (1-minute load 58 to 76). No report. Server-log figures
  to that point: 12358 gate decisions, `lockWaitMs` p95 174 ms / max 4604 ms, 9 `gate lock busy`. Not a baseline number;
  not completed.

### A finding at 200 players, outside this task's scope

Every run logged about 93-94 `match room: reconcile(game_end) after a game-ending act failed` errors (one per finished
game, from the first games on): `index row size N exceeds btree version 4 maximum 2704 for index
"stage_lots_draws_live_key"` (N falling from 7376 to the limit as boards finish). The index is on `members_key`, the
sorted member ids of one residual tie, so a tie class larger than about 70 entrants (all 200 players level on the same
points in one pool) cannot be stored (`V475__w2d_table_rules.sql`). The result events were written and the harness
passed `B` regardless, so the run does not see it; it is a defect for a division that large (a draw of lots over a big tie).
Route it to the stage/table-rules owner. It is also why a 100-board round is not the shape plans 2 and 3 should assume
for standings.

## Step 2b: the webhook knob is not inert

Same local server, `LOAD_BOARDS=2`, scenario `B`, 2 boards x 2 players, `LOAD_SWEEP_EVERY_S=300`. Run time about 6 minutes each.

| # | Setup | Exit | `webhooks` block |
| --- | --- | --- | --- |
| 1 | `LOAD_WEBHOOKS=0` | **0** | `enabled false, emitted 12, delivered 0, failed 0, down 12, checks null, shadow null` |
| 2 | `LOAD_WEBHOOKS=1` | **0** | `emitted 12, delivered 12, failed 0, down 0`; checks `allMeetingsEnded true, openRows 0, leftDelivered 4, leftClosedByLeft 4, uuidsDelivered 12, uuidsRecorded 12`; shadow `verified 4, covered 4, missing 0, open 0, closedByEnded 0` |
| 3 | `LOAD_WEBHOOKS=1`, build whose webhook route answers 401 to everything | **1** | `emitted 12, delivered 0, failed 12, down 0`; failures: `"LOAD_WEBHOOKS=1 delivered 0 of 12 emitted webhooks: an inert run ..."`, `"12 webhook(s) failed delivery"`, `"no participantLeft was delivered: the left_by check looked at nothing"`; shadow `verified 4, covered 0, missing 4`; 12 `realtimekit-webhook: delivery refused` log lines |
| 2 again | restore confirmed, `LOAD_WEBHOOKS=1` | **0** | `delivered 12, failed 0, down 0`; checks as run 2 (`openRows 0, leftClosedByLeft 4 of 4, uuidsRecorded 12 of 12`); shadow `verified 4, covered 4, missing 0, open 0` |

**Verdict: the knob is not inert.** (2) delivers (12 of 12) and is green, (3) fails on `failed > 0`, the restore delivers again.

**Deviation, stated plainly.** Run 3 was NOT made by editing the verifier source and rebuilding: with the machine at a load
average of 340 to 480 from other sessions, a 5 GB `next build` (twice) was the thrash the brief tells me to avoid. Instead the
compiled standalone chunk that holds `receiveRealtimeKitWebhook`
(`.next/standalone/apps/web/.next/server/chunks/_0b63abn._.js`, untracked build output) was patched in place so the
function's first statement returns `{status:401, reason:"signature"}` (the same 401 path the source's `signature` branch
returns), the run was made, and the chunk was restored from a `cp` backup; the md5 of the restored chunk equals the
original's (`08ed3d85a99730391d9902c6241407f2`) and the patch string was absent afterwards. No source file was edited, so
there was nothing to `git checkout`; `git status` was clean before and after. Run 2-again is the restore confirmation.

## Reading these numbers

- `B` is the clean baseline at 200 players. Its `lockWaitMs` p95 (21 ms), its 0 busy refusals, 6 calls per stay and 3.1 s /
  29.1 s time to seat are what plan 2's pre-mint and plan 3's arbiter are measured against.
- `B-honest`'s figures are valid as counts (calls per stay 6/9/12, 101 held stays, 3655 admission pairs) but its latency
  tails and the 500 and the 7 busy refusals ran through a loaded machine; do not use them as the baseline for those three
  without a quiet re-run.
- `B-slow-5` and `B-slow-10` at 200 players are open: not measured here, and the first needs a longer test budget.

## Plan 2, Task 11 Step 1: local pre-check with the flags ON (2026-11-19)

Not the gate (that is the staging round against real RealtimeKit). Branch `feat/checkin-rollout` (main `dab9750ff4` + runbook commits), same
shape as the baseline's `B` run: `LOAD_BOARDS=100` (200 players), `LOAD_SCENARIO=B`, `LOAD_ARRIVAL_SPREAD_S=60 LOAD_OPENED_AGO_S=250`,
cameras instant, standalone prod build, fixture vendors, fresh label database. Server env as the baseline plus
`EXTERNAL_PLAY_PREMINT=1 EXTERNAL_PLAY_PRESENCE_PROOF=1`; runner `LOAD_PRESENCE_PROOF=1 LOAD_WEBHOOKS=1`.
**`EXTERNAL_PLAY_WINDOW_DEFER=0` on this server**: the harness's own post-check demands it ("sweep deferred for an open check-in window:
start the server with EXTERNAL_PLAY_WINDOW_DEFER=0"); it is the load server's setting, never production's.

**Verdict: the run is RED (exit 1)** on the harness's room-read smoke guard (`room read p95 13367 ms`, bar 3000), on a machine whose 1-minute
load average was 85-136 (another session's `next-build` at 120% CPU and Chrome) while it ran. The latency rows below are therefore NOT
a baseline comparison. The call-count and presence rows are counts, not latencies, and are unaffected. A quiet-machine re-run is owed
before the latency rows are read as the line's behaviour.

| | Baseline `B` (flags off, `LOAD_WEBHOOKS=0`) | This run (premint + proof + webhooks on) |
| --- | --- | --- |
| Calls per board, whole run | 23 (2300) | **18.1** (1814) |
| Check-in calls per player (harness `perPlayerCheckIn`) | 6 per stay (12 per board) | 5.9 |
| RealtimeKit calls, busiest 5 min (ceiling 900) | 687 | 708 |
| Time to seat p50 / p95 / max | 3.09 s / 29.1 s / 47.4 s | 34.9 s / 131.2 s / 141.8 s (machine load; not comparable) |
| `lockWaitMs` p95 / max (gate decisions) | 21 ms / 440 ms (565) | 1189 ms / 2105 ms (606) (machine load) |
| `gate lock busy` | 0 | **7** (machine load; the baseline's B-honest also saw 7 under spikes) |
| `presenceFallbackCount` (`seat: ... fell back` lines) | n/a | **0** |
| Webhooks | emitted 600, delivered 0 | emitted 600, **delivered 600**, failed 0 |
| Plan 1 end-of-run presence checks | n/a | `allMeetingsEnded`, `openRows 0`, `leftDelivered 200`, `leftClosedByLeft 200`, uuids 600/600, shadow `verified 200 covered 200 missing 0 open 0 closedByEnded 0`: all pass |
| Camera evidence settled | 200 | 200 (13 sweep passes) |
| Seat answers | camera_required 200, seated 200, queued 166 | camera_required 200, seated 200, queued 213 |
| Claims per player (min/max, total) | 2 / 12 (566) | 2 / 11 (613) |
| Database peak connections | 5 | 5 |
| Pre-mint `roomsMade` / `windowsOpen` / `deferred` | n/a | **not measured**: this harness drives the sweep, not `/api/cron/external-play-premint`; the sweep's `windowsOpen` was 0 on every pass (deferral off by the setting above) |

Plainly: **latency is worse (seat p50 11x, room-read p95 and `lockWaitMs` p95 far above baseline) and the harness's own latency guard reds**,
under heavy machine contention; whether any of it is the flags is not established by this run. Calls are lower (18.1 vs 23 per board) and
presence is clean (0 fallbacks, 200/200 covered, 0 closed-by-end). The "bars at flag-on" carry was already met in the tree:
`line-load.ts` `stayPriceMax(mode)` is 9 flag-on and 21 flag-off, pinned to `lineReservation` in `line-load.test.ts`; replacing it with a constant 21
fails 2 of 61 tests.

Environment faults hit and fixed on the way (not defects): `LICHESS_TOKEN_KEK` must be 64 hex (base64 aborts seeding); a
killed server's listener survived and kept :3391, so the next run talked to the old server and its KEK (every seal failed
`LICHESS_TOKEN_UNAVAILABLE`, 30-min timeout); a re-used database made the sweep scan the earlier runs' rooms (600 candidates, 22
`not_found` failures per pass, camera evidence never settled): each run needs a fresh database; without `WINDOW_DEFER=0` the harness
refuses the run.
