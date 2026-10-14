# Chess: per-board timers on Cloudflare Durable Objects — design

Status: DRAFT for owner review. The owner approved writing it on 2026-10-14. This document contains no code.

Branch: `feat/chess-lichess-external-play`.

Line numbers were pinned on 50ad0bf6c. Re-pin them before building: the brief is a hypothesis (AGENTS.md class 5).

Parents:
- `docs/superpowers/specs/2026-10-09-chess-in-page-board-and-camera-design.md`: §3.2 (the window), §3.5 (reconcile), §4 (the cron).
- `docs/superpowers/specs/2026-09-28-cloudflare-cron-triggers-design.md`: the `apps/cron-worker` this builds on.
- `.superpowers/sdd/2026-10-09-chess-in-page-board-and-camera/predeploy-review.md`: items I1 and I2.

---

## 0. The problem, as measured

The external-play sweep (`apps/web/src/server/usecases/external-play/sweep.ts`) runs from the cron Worker's `*/5 * * * *` trigger (`apps/cron-worker/src/schedule.ts`, the `external-play` row). It is a single pass with a 45 s budget for its network jobs (`SWEEP_PASS_BUDGET_MS`, sweep.ts:147). Once the budget is spent, `each` defers every later network row (sweep.ts:199-204).

The jobs run in this order (sweep.ts:1185-1203): close_unplayable, reconcile, mint_retry, no_show, teardown, camera_evidence, arbiter_revoke.

How the budget gets used up:
- Suppose reconcile finds a board whose side to move is at zero while Lichess still says `started`.
- It reads that board again with the stream held open for `FLAG_SETTLE_HOLD_MS` = 9 s (reconcile.ts:69, 376-379). The read is bounded at `LICHESS_TIMEOUT_MS` + the hold (board-api.ts:575-580).
- The reads run one after another. About 5 such boards spend the whole budget, so the five network jobs after reconcile do not run. The sweep's own comment records the same figure (sweep.ts:144-146).
- A board held `clock_flag_unsettled` stays a reconcile candidate (reconcile.ts:133, sweep.ts:664-667) and stays at zero on Lichess. So it costs the same hold on every pass until the organiser acts.

Review I1 judged this owed before production, or before any stg round with several boards.

Two latency facts follow from the 5-minute cadence:
- **The T+20 no-show** (and the teardown of a room nobody used) lands up to 5 min late. No other path rules on it.
- **A flag nobody is watching** lands up to 5 min late. That means a flag with both room tabs closed. **Correction to the brief:** a flag with a room tab open is already handled within seconds, by the room's clock-zero report (room.ts:592-622, `reconcile(…, "clock_zero")`). The 5-minute bound applies only when no tab is open.

**The idea.** Each board's deadlines move off the shared serial pass onto a per-board timer. When a timer fires, it calls one per-board endpoint in the app, so boards run in parallel and never starve each other. The sweep keeps the cheap jobs and becomes the backstop.

## 1. Every per-board deadline today, and where it lands

"Timer" means a per-board Durable Object alarm. "Sweep" means it stays in the 5-minute pass. Every timer-owned deadline is ALSO still checked by the sweep as a backstop (§6).

| # | Deadline | Defined at | What happens at it | Lands |
|---|---|---|---|---|
| D1 | **Arrival (T+20).** The round's `opened_at` + `DEADLINE_AFTER_MS` (20 min). | window.ts:6, 19-25; sweep.ts:160-162, 329-330. Stamped by open-round.ts:325-327 (first open) and :337-339 (re-stamp, including D17's re-arm at :305-318). | No-show forfeit, or one of three holds: `not_started` when both checked in and no game was made (sweep.ts:342-355); `create_outcome_unknown` for a sent create under a stale claim (sweep.ts:337-339, 447-468); a refused no-show (sweep.ts:364-377, 394-400). | **Timer** (`arrival`) |
| D1a | **Arrival teardown.** Same instant: no game is or may be on file past the deadline. | sweep.ts:558-564 | `endMeeting` for the room nobody used | **Timer**, same fire as D1 |
| D1b | **A live mint claim at the deadline.** The claim + `MINT_CLAIM_STALE_MS` (30 s). | window.ts:8, 12-14; sweep.ts:284-291 | `gameMayBeOnFile` holds D1 back while T9 is in flight. Once the claim is stale, D1 can rule. | **Timer**: the D1 fire answers "again at claim + 30 s" (§4.3) |
| D2 | **Flag due.** `last_move_at` + the side to move's stored ms. The clock does not run before ply 2 (scalachess `Clock.step`, play.ts:456-476). | reconcile.ts:550 (`flagAt`); room.ts:604-608 (same arithmetic, `CLOCK_ZERO_TOLERANCE_MS` 2 s at :114) | `reconcile`: one first-line read, then the 9 s settling read when Lichess shows the mover at 0 (reconcile.ts:230-233, 372-379) | **Timer** (`flag`), re-armed every ply |
| D3 | **Flag unsettled.** `flagAt` + `FLAG_UNSETTLED_HOLD_MS` (60 s). | reconcile.ts:73, 540-557, 678-680 | Held `clock_flag_unsettled`, with the evidence | **Timer** (`flag_unsettled`), armed by the D2 fire when the flag did not settle |
| D4 | **Mint retry.** A 429'd create's `retry_at`, before D1. | create-game.ts:857-861 (marker); sweep.ts:505-520 | `createGameIfReady` again | **Timer** (`mint_retry`), recommended; see Q4 |
| D5 | **Teardown at the result.** | sweep.ts:558-560; room-end.ts:28-47 (D8b, best effort after the answer) | `endMeeting` | **Sweep** backstop only. The result path already does this at once. |
| D6 | **Camera evidence.** The room's `ended_at` + 2 min, retried until the reports are final; give up at 24 h. | sweep.ts:826-827, 846-862, 996-1038 | Peer-report reads, then flags | **Sweep.** Not time-critical, and it is the heaviest RealtimeKit (RTK) job. A round's rooms end together, so N parallel fires would burst against RTK's 1,200 per 5 min limit (§5.3). Once flags leave the sweep, this job is no longer starved. |
| D7 | **Arbiter watch TTL.** `created_at` + 3 h. | sweep.ts:1095, 1123-1128 | `removeParticipant` | **Sweep.** Per participant, not per board, and nothing user-visible waits on it. |
| D8 | **No-truth back-off and the M4 hold.** `expectedEndAt`, `reReadAfterMs`, `SWEEP_NO_TRUTH_HOLD_AFTER` = 3. | sweep.ts:614-634, 683-698, 771-782 | A read cadence, then `provider_error` | **Sweep.** It is a cadence, not a deadline. |
| D9 | **The every-tick mid-game read.** It is the main detector of moves made at Lichess. | sweep.ts:572-581, 653-670 | A first-line read, about one request, with no hold | **Sweep.** No settling hold when a timer owns the board (§6). |
| D10 | **A refused no-show becomes a hold after 3 passes.** | sweep.ts:411-438 | `holdRefusedNoShow` | **Sweep.** It is counted in passes. A D1 fire that is refused leaves it to the sweep. |
| D11 | **Close a decided fixture's bridge (job 0).** | sweep.ts:248-261 | `closeBridgeIfUnplayable` | **Sweep.** It is triggered by an event, not a time. It also disarms (§3.3). |

Read and found NOT to be a deadline:
- `MATCH_ROOM_TOKEN_TTL_MS` (window.ts:7) is a passive expiry.
- `WINDOW_OPEN_LEAD_MS` and `EMAIL_LEAD_MS` (window.ts:4-5) are not used for any action under D12. sweep.ts:16-17 says so: the open sends the invites.
- Lichess's own abort of a game with no first move is Lichess's timer. We learn of it at the next reconcile (D9), and nothing of ours is due at a time for it.

Two stale lines in the parent design, found while reading. Neither is in scope to fix here; they are recorded so nobody builds on them:
- §3.5 still describes `FLAG_REREAD_MS` (re-read once after 3 s). D11 replaced it with the held read (reconcile.ts:22-35).
- §3.5's fifth trigger says the sweep reads "a live game past its expected end". The code reads every game on every tick (sweep.ts:579-581).

## 2. Shape

```
app (Fly, Next)                         Cloudflare (apps/cron-worker)
───────────────                         ─────────────────────────────
openRound / play append / reconcile ──► POST /timer/arm      ─► BoardTimer DO (one per fixture)
result / void / re-pair             ──► POST /timer/disarm   ─►   deadline table + ONE alarm
                                                                   │ alarm()
POST /api/cron/external-play/board ◄─────────────────────────────┘ (x-cron-secret)
  → runs that board's due jobs (the sweep's own per-fixture functions)
  → answers { done, next[] } and the DO re-arms from `next`
```

- **What the Durable Object (DO) holds.** It never touches the DB, Lichess or RealtimeKit, and it holds no tokens. It stores:
  - the fixture id;
  - a small table of `{ kind, at, version }`;
  - an attempt counter;
  - the last outcome code, for logs.
- **Where it lives (recommended, see Q1).** In `apps/cron-worker`, as a new SQLite-backed class (`new_sqlite_classes` migration), with these benefits:
  - It reuses the Worker's `CRON_SECRET`, `BASE_URL`, `ACTIVE` kill switch, user agent, Sentry plumbing and deploy scripts.
  - The Worker's `fetch` handler gains `/timer/arm` and `/timer/disarm` beside `/run` (manual.ts), behind the same `secretMatches`.
- **Instance key.** `idFromName(fixtureId)`. Each env already deploys a separate Worker (`seazn-cron-stg`, `seazn-cron-prod`), and so a separate namespace.
- **One alarm per object.** A DO has exactly ONE alarm; `setAlarm` replaces it. The DO therefore keeps the deadline table and always sets its alarm to `min(at)`. When the alarm fires, it takes every row due by now, calls the endpoint once with all those kinds, and re-sets the alarm to the next row.

## 3. Arming

### 3.1 Who arms, when

All arming is best effort and runs AFTER the caller's answer: `deferred()`, lib/deferred.ts:14, which is Next's `after()`.
- Each call is bounded at 3 s.
- A failure is logged and never raised. A move, an open or a result must never wait on Cloudflare or fail because of it.
- A lost arm is what the sweep backstop exists for (§6).

| Event | Where (file:line) | Arms |
|---|---|---|
| Round opened, or re-stamped (`opened`, `reopened`; D17's re-arm) | open-round.ts, after the transaction returns (:398). The decision's `open.roundOpenedAt` and the attached boards (:391). | `arrival` at `opened_at + DEADLINE_AFTER_MS + jitter`, for every board attached to the open |
| `reinvited` (window unchanged) | same | Same version, so the call is idempotent and may be skipped |
| A create throttled by 429 | create-game.ts:857-861 (`noteThrottled`) | `mint_retry` at `retry_at`, or now + 60 s for `unknown` |
| A ply appended by T10 | play.ts:463-488 (the `appended` row), after the publish | `flag` at `last_move_at + mover_ms`, only when `move_count ≥ 2`; plus `flag_unsettled` cleared |
| Plies or clocks adopted by reconcile | reconcile.ts:635-661 (stream), :700-719 (export), when a row was written | Same as the line above, from the written row |
| The D2 fire finds the flag unsettled | the endpoint's answer (§4.3) | `flag_unsettled` at `flagAt + FLAG_UNSETTLED_HOLD_MS + margin` |

**Jitter.** A round's boards share one `opened_at`, so 30 arrival alarms would fire in the same second. Each one is offset by a stable hash of the fixture id, between 0 and 10 s. That spreads the load on the Fly machine and on the DB connection budget (about 57 connections in prod). Ten seconds late on a 20-minute window is immaterial.

**Margin.** `flag` fires at `flagAt + 1.5 s`. That is inside room.ts's `CLOCK_ZERO_TOLERANCE_MS` and covers the clock skew between Cloudflare and Fly. Our `last_move_at` is our append time, which is later than Lichess's acceptance, so our `flagAt` errs late. That is the safe side: we never read before Lichess's clock can have run out.

### 3.2 Versions: the order of arm calls is not guaranteed

Two plies can be appended on two Fly machines, and their deferred arm calls can reach the DO in either order. So every arm and disarm carries a version, and the DO ignores any call older than what it holds for that kind.

The version is the pair **`(openedAtMs, moveCount)`**, compared in that order:
- A re-pair or D17 re-arm re-stamps `opened_at`, so it outranks everything from the old pairing.
- A ply raises `moveCount`.

The endpoint's `next` answer carries versions computed from the DB. The DB is the authority, so a DO that took a stale arm is corrected at its next fire.

### 3.3 Disarm

A disarm carries a version and clears every kind at or below it. When the table is empty, the DO calls `deleteAll()`, so no storage is billed and the object can be collected.

| Event | Where |
|---|---|
| The bridge closes on a result | reconcile.ts:478-486 (`finish`) |
| An organiser settles | resolve.ts:136-139 (`closeBridge`) |
| The fixture becomes unplayable (pad result, withdrawal, void, cancel) | bridge-close.ts:40-54 (`closeBridgeIfUnplayable`), also sweep job 0 |
| A Swiss re-pair deletes the row | stages.ts:2103-2113 (`clearSwissFixtureSeats`) |
| D17 deletes and re-arms | open-round.ts:375-388. The re-arm's `arrival` (newer version) follows. |
| A board is held for the organiser | No disarm call. The endpoint answers `next: []` for a held board (§4.3), so the DO empties itself at its next fire. |

A disarm that is lost costs one fire: the endpoint finds nothing due and answers `next: []`.

## 4. Delivery

### 4.1 Auth, both directions: what `apps/cron-worker` already uses

Read in the tree:
- **Worker to app.** `POST {BASE_URL}{path}` with headers `x-cron-secret: CRON_SECRET` and `user-agent: seazn-cron/1 (<env>)`, plus `redirect: "manual"` and a 60 s `AbortSignal.timeout` (call.ts:93-104, :33-36, :39).
  - The user agent matters. The zone's Browser Integrity Check challenges a request without one (call.ts m2).
  - The redirect setting matters too: fetch would replay a POST as a GET and forward the secret (call.ts M-3).
- **The app's check.** `process.env.CRON_SECRET`, compared with `!==` (route.ts in `api/cron/external-play`).
- **Into the Worker.** Its manual endpoint checks `x-cron-secret` with a constant-time compare (manual.ts:5-10).

**The design:**
- The DO calls `POST /api/cron/external-play/board` exactly as `callJob` calls a job: same headers, redirect and timeout. The DO code should reuse `call.ts` rather than copy it.
- The app arms through the Worker's `POST /timer/arm` and `/timer/disarm`, checked by the same `secretMatches`. The app needs a new env var with the Worker's URL (`BOARD_TIMER_URL`). On stg and prod that URL is the `*.workers.dev` host, so it never meets the zone's challenge (memory note on the cron split).
- **Minor, found in passing.** The app routes compare the secret with `!==`, which is not constant-time. A shared helper with the same compare as manual.ts would cover every cron route at once. Optional.
- Whether to reuse `CRON_SECRET` or mint a separate `BOARD_TIMER_SECRET` is Q3. One secret is simpler. A separate one limits the blast radius, because the timer secret flows FROM the app TO a public `workers.dev` host on every ply.

### 4.2 At-least-once: the endpoint is idempotent

Cloudflare documents the guarantees:
- `alarm()` runs at least once.
- It is retried on an uncaught exception, with exponential backoff from 2 s, up to 6 retries.
- "In rare cases, alarms may fire more than once."

So the endpoint treats the fire as a **hint**. It re-derives everything from the DB, and every action it takes is one the sweep already makes overlap-safe:
- **The no-show** is keyed `extplay-noshow:<id>` (sweep.ts:303, :383). The candidate query excludes a board whose key is already in the ledger (:322-323). A second fire finds no candidate.
- **Holds** are reported as `held.wrote` and counted once (result.ts:308). A board already held is not re-held.
- **The I3 takeover** is a CAS on the very claim it judged (sweep.ts:454-459).
- **The flag read** is reconcile, whose writes are CAS on `move_count` and the offer (reconcile.ts:652-655). The result write is T12's keyed replay (result.ts:113). `settle` already absorbs the loser of a race, once (reconcile.ts:776-788).
- **Teardown** stamps `ended_at` only after the vendor deactivates. A repeat finds the row ended.
- **The read claim.** The endpoint takes the sweep's own read claim before a reconcile: the `last_polled_at` CAS (sweep.ts:706-711). A sweep pass overlapping a fire therefore skips that board, and two fires read it once. The only cost is that the next ordinary sweep read moves back one cadence, which is harmless.

**Staleness.** A fire whose version is older than the DB's current version reads nothing at Lichess. Example: a `flag` fire for `moveCount` 30 when the ledger is now at 31. The endpoint answers `stale` with the current `next`. The gate is the same server arithmetic `reportClockZero` uses (room.ts:604-608): no read unless the side to move is within `CLOCK_ZERO_TOLERANCE_MS` of zero.

**The reconcile trigger.** Reuse `"clock_zero"`, recommended in Q10. A timer fire IS "a clock reached zero", so the closed list of five triggers (reconcile.ts:64) and its enumeration test stay unchanged. The log line carries `source: "timer"`.

### 4.3 The endpoint's contract

- **Request:** `{ fixtureId, kinds: ("arrival"|"flag"|"flag_unsettled"|"mint_retry")[], version }`.
- **What it runs.** The sweep's per-fixture functions (`noShow`, `teardown`, `mintRetry`, `sweepReconcile`), scoped to ONE fixture. The candidate queries gain a `fixtureIds` scope beside `orgScope` (sweep.ts:232-234). There is one authority for each rule, never a second copy of it.
- **Answer 200:** `{ done: kind[], examined: number, stale: boolean, next: { kind, at, version }[] }`. The DO replaces its table with `next`. These cases answer 200, never an error:
  - **"Nothing due"** (the deadline moved, the game ended, or the board is held).
  - **D1b.** A live mint claim answers `next: arrival at claim + 30 s`.
  - **A `flag` read where Lichess still shows the mover above 0** (lag compensation) answers `next: flag at read + Lichess's mover ms + margin`.
  - **A `flag` read that did not settle** answers `next: flag_unsettled`.
- **Answer 404:** the fixture or its bridge is gone. The DO deletes everything.
- **Answer 401 or 503 (`CRON_SECRET` unset):** a configuration fault. Logged at error level; no tight retry (§4.4).
- **Answer 5xx, network error or timeout:** retried (§4.4).

**Anti-vacuity.** `examined` counts the kinds actually judged. A 200 with `examined: 0` for a non-empty `kinds` is a failure the DO logs as an error. The same counter feeds the tests (§7).

### 4.4 Retries, and an app that is down or stopped

The DO catches its own errors rather than throwing. Cloudflare's built-in retry spends six tries in about 2 minutes, which is shorter than a deploy or a cold boot can take. On a failure, the DO re-arms itself with its own back-off:
- 15 s, 30 s, 60 s, then every 5 min;
- up to a horizon of 30 min after the deadline;
- then it gives up, logs, and leaves the board to the sweep, which always reaches it.

What is retried, and what is not:
- **A timeout** is retried, unlike `callJob`, which never retries one. It is safe here: the endpoint is per board and idempotent, and the back-off (at least 60 s after a timeout) outlasts a held read still running server-side.
- **A 4xx** is not retried tightly. A 401 every 5 min until the horizon is enough to surface a broken secret.

**A stopped or suspended Fly machine:**
- **stg** has `auto_stop_machines = "stop"` and `min_machines_running = 0` (fly.stg.toml). The DO's request goes through the Fly proxy, which auto-starts a stopped machine (`auto_start_machines = true`) and holds the request while Next cold-boots. The cold-boot time is NOT measured; it is a rollout check (§8).
  - A 502 or 503 during the boot is retried at 15 s.
  - Cloudflare's own connection limits do not bite: the Fly edge accepts the TCP connection at once (522 needs 19 s without a TCP connect), and the read timeout is 125 s (524).
- **prod** keeps at least 1 machine running and suspends the others (fly.toml). That is the same path as stg, with a warm floor.
- **Deferred work after a response.** The arming calls and `endRoomAtResult` run after the response. On stg, a machine stopped right after a response could cut them. A lost arm is the sweep's case, and `endRoomAtResult` already documents the sweep as its backstop. Recorded, not fixed here.

### 4.5 The cron Worker's kill switch

`ACTIVE !== "true"` already stops every scheduled job (run.ts:118-124).
- The DO checks it too. Inactive means the alarm logs and re-arms 5 min later without calling the app, so the kill switch never loses a deadline.
- Arming calls are still accepted while inactive.

## 5. Lichess, request limits and cost

### 5.1 Is an alarm-time read enough to settle a flag?

It is exactly the read the room's clock-zero report makes today: `reconcile(fixtureId, "clock_zero")` with the D11 settling read. The timer changes WHEN and WHERE the question is asked, not the question. So the timer settles a flag exactly as well as a tab left open does, and no better.

What the code says:
- The premise comes from lila SOURCE (reconcile.ts:22-35). lila's CheckOnline tick runs 7 s after a board stream opens (GameStateStream.scala:118-124, lila ad760137c) and flags a side to move that is out of time. That is why the read is held for 9 s (reconcile.ts:67-69).
- The measured counter-example is game x0JKlePc (stg, 2026-10-14). It sat `started` with White at 0 through first-line reads for 7 minutes, and that is what retired the "next read settles it" premise.
- The predeploy review records that the held-read premise itself is **unmeasured**.

Therefore:
- **The first stg check of this design is a measurement, not a feature test (§8, step 2).** Both tabs closed, a 3+0 game, let White flag. Did the timer's held read return `outoftime`, and within how many seconds of `flagAt`?
- **If lila does not settle on a held read,** the timer still bounds the damage. A board is held `clock_flag_unsettled` at about `flagAt` + 60 s rather than read forever, and the sweep stops paying 9 s for it (§6).

### 5.2 Does the hold fit Fly and Next request limits?

**The worst-case endpoint wall time for a `flag` fire:**
- the first-line read: ≤ 10 s;
- the settling read: ≤ 10 + 9 s through White's token, and the same again through Black's if White's stream refuses (readTruth tries both seats, reconcile.ts:276-312);
- the export fallback: ≤ 10 s;
- the result write, plus a ≤ 3 s broadcast.

That is about **60 s at the very worst, about 12 s typically**. Each limit in the path:

| Limit | Value | Fits? |
|---|---|---|
| Next.js `maxDuration` | Advisory. "Deployment platforms can use `maxDuration`" (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md). A self-hosted `next start` on Fly does not enforce it. | Yes |
| Node http `requestTimeout` | Default 300 s in Node ≥ 18. Not re-verified on Node 26. | Yes |
| Cloudflare proxy read timeout | 125 s before a 524. Applies only if `BASE_URL` is a proxied host, as `stg.seazn.club` is. | Yes |
| Fly proxy | No request cap is configured in fly.toml. Not verified in Fly's docs here. Evidence: the existing cron route already runs passes of 45 s+ through the same path. | Yes, by precedent |
| The DO's fetch | 60 s `AbortSignal.timeout` (call.ts:39 reused). The alarm handler's own wall limit is 15 min. | Yes |

Two parallel effects the review asked about:
- **A held read occupies one Node request**, not the sweep's single pass. Thirty boards flagging in the same minute mean thirty concurrent requests. The concurrency soft limits are 80 on stg and 400 on prod (connections), so they fit.
- **Lichess per-token stream limits under that concurrency are not measured.** Each board uses its own players' tokens, so no single token is shared across boards.

### 5.3 Cloudflare cost and limits

**Prices.** From developers.cloudflare.com, `durable-objects/platform/pricing` (updated 2026-09-30) and `workers/platform/limits`:

| | Workers Free | Workers Paid ($5/month minimum) |
|---|---|---|
| DO requests (HTTP, RPC, **alarm invocations**) | 100,000 / day | 1 M / month, then $0.15 / M |
| DO duration | 13,000 GB-s / day | 400,000 GB-s / month, then $12.50 / M GB-s |
| DO SQLite rows written (**each `setAlarm` = 1 row**) | 100,000 / day | 50 M / month, then $1.00 / M |
| SQLite storage | 5 GB total | 5 GB-month, then $0.20 / GB-month |
| Worker requests (account-wide) | 100,000 / day, then **Error 1027** | no limit |
| Subrequests per invocation | 50 external | 10,000 |
| CPU per invocation | 10 ms | up to 5 min |
| Over a free limit | "further operations of that type will fail with an error" | billed |

Durable Objects run on Workers Free, but only SQLite-backed ones. The account is on Workers Free today (cron spec, line 74).

**Per-board usage (estimate).** A 40-move game is about 80 plies. Each ply costs:
- one Worker request (`/timer/arm`);
- one DO request;
- one `setAlarm` row.

On top of that, each board costs one arrival fire, and one or two flag fires when a game flags. Call it **about 85 Worker requests, about 85 DO requests and about 90 rows per board**.

Duration is the wall time the DO waits on our endpoint, at 128 MB:
- a typical flag fire (about 12 s) costs about 1.5 GB-s;
- an arrival fire (about 1 s) costs about 0.1 GB-s;
- arming calls are milliseconds.

**What that means:**
- **Free plan:** about 1,100 boards a day before the 100k Worker-request ceiling.
- **The catch.** That ceiling is **account-wide**, and the cron Worker draws on it too. A busy day exhausts it for both: arming fails (degrading to the sweep, by design), and the cron Worker's own `/run` and its probes would also be refused. Whether scheduled invocations count against the 100k is not stated in the pages read; it is unverified.
- **Workers Paid:** the included 1 M DO requests a month cover about 11,000 boards a month. Each further million costs $0.15.

**Cost conclusion:**
- **stg runs on Workers Free at no cost.**
- **prod should move to Workers Paid ($5/month) before timers are switched on there** (Q2). It costs about $5 a month, flat, at any volume this product will see this year. The reason is not price. It is taking the account-wide request ceiling off the path that also carries the cron Worker.
- A "lazy re-arm" would cut the per-ply requests (Q7): arm only when the new deadline is EARLIER than the one armed, and otherwise let the stale fire answer `next`. The volume does not require it.

**RealtimeKit (review I2, a related item, not in scope):**
- The timer adds no RTK calls of its own kind. The arrival fire's teardown is the same `endMeeting` the sweep makes today, made up to 5 min earlier and spread by jitter. Camera evidence stays in the sweep, deliberately (D6).
- I2 is unchanged: D2's 1 s `camera_starting` polls cost about 4 RTK calls each (realtimekit.ts:524-562, preflight.ts:306-337) against the shared limit of 1,200 per 5 min. A 30-board round checking in inside 5 minutes spends roughly 720–1,200 calls.
- The cheapest fix is to skip the token refresh on a `camera_starting` re-ask (camera-session.ts:189 already makes it a no-op at the vendor). It is not trivial enough to fold in here; it is recommended as its own task. The sweep's per-pass budget also caps how many RTK calls camera evidence can burst.

## 6. The sweep after this change

The sweep stays the backstop for every deadline and keeps the cheap jobs. Its changes, all independent of the flag except where marked:

1. **Fix I1 directly** (lands first, flag or not):
   - **(a)** On `trigger === "sweep"`, a row already held `clock_flag_unsettled` is read WITHOUT the settling hold. The organiser and the room's reports own it.
   - **(b)** Settling reads are capped at **2 per pass**; the rest are counted `deferred`.
   - **(c)** Reconcile gets its own sub-budget (20 s of the 45 s), so mint_retry, no_show, teardown, camera_evidence and arbiter_revoke always get the rest.
   - The order stays as it is, because reconcile-first is load-bearing (sweep.ts:1187-1189).
2. **With timers ON,** the sweep's ordinary reconcile does no settling hold for a flag-due board inside the timer's window. It does one only as a **backstop**: a board still `ready`/`live` and at zero more than `FLAG_UNSETTLED_HOLD_MS` + 2 min after `flagAt` is evidently a board whose timer never fired. It is read with the hold, within the cap of 2, and counted as `timerBackstop` in SweepReport.
   - The arrival backstop needs no change. The sweep's no-show and teardown already act on anything past the deadline. With timers on, `timerBackstop` also counts a no-show the SWEEP made more than one cadence after its deadline: the sign of an arrival fire that never came.
3. **`timerBackstop` is not a failure counter.** The cron Worker reads only `failed` and `skipped` (schedule.ts). A sustained non-zero count is surfaced by a log line at warn level. Whether it should page is Q11.

## 7. Testing

Every item below follows docs/superpowers/TEST-STRATEGY.md:
- **anti-vacuity:** every sweep and property reports what it checked, and zero checked fails;
- **expected values derived from declarations,** never typed: `flagAt` comes from the stored clock rule and `DEADLINE_AFTER_MS`, not from literals;
- **the guard mutated once.**

All four test types are owed (RULES.md). Commands are scoped to the changed files and never the full suite. vitest results are judged from `--reporter=json`, with `.testResults[].name` confirmed.

**Worker (apps/cron-worker, plain-Node vitest, as today):**
- **Shape.** The DO's logic is a pure module (`board-timer-table`: arm, disarm, due, next alarm, version compare, back-off) behind a thin DO class. The pure module is tested with a **fake clock and a fake storage** (getAlarm, setAlarm, get, put, deleteAll), and no miniflare is needed.
- **The class itself.** One optional integration test through `runDurableObjectAlarm` (`cloudflare:test`) would need `@cloudflare/vitest-pool-workers`, a new dev dependency; that is Q12.
- **Cases:**
  - one alarm equals the minimum of the table;
  - an arm with a lower version is ignored, in both arrival orders;
  - a disarm clears kinds at or below its version and calls `deleteAll` on an empty table;
  - a fire calls the endpoint once with ALL due kinds;
  - a 200's `next` replaces the table;
  - 5xx, network and timeout follow the 15/30/60 s/5 min back-off, and give up at the horizon;
  - a 401 does not retry tightly;
  - `ACTIVE` false means no app call and a re-arm;
  - the drift test (test/drift.test.ts) is extended to pin the DO binding and the migration in both envs.

**App (apps/web vitest, DB-backed like the sweep suite, with the `now`/`orgIds` seams):**
- **The timer moves on each ply.** Drive the REAL `act()` append (play.ts) over two plies with the arm transport captured. Assert two arms whose `at` equals `last_move_at + mover_ms` as the row itself stores them, read back from the row and never typed, with increasing versions. Also cover plies 0 and 1 (no flag arm) and an adopted ply from reconcile.
- **It fires once.** An arrival fire on a no-show board writes exactly one `core.forfeit` (counted in `score_events`) and answers `done: ["arrival"]` with `examined` ≥ 1.
- **An idempotent double fire.** The same fire sent twice, serially and concurrently, gives one forfeit, one hold and one result event. A `flag` fire twice gives one held read: the second loses the `last_polled_at` claim, and the fake `readStream` call count says so.
- **A stale fire.** A `flag` fire whose version is behind the ledger makes ZERO Lichess reads and answers `stale` with the current `next`.
- **The sequence cases:**
  - a second fire;
  - an empty `kinds`, which is a 400;
  - a fire after a void, after a re-pair, and after D17's re-arm (`next` carries the new arrival);
  - a held board (`next: []`);
  - another sport, which is a 404: the endpoint is gated to online chess.
- **The sweep backstop catches a board whose DO never fired.** With timers on and no fire, a board past `flagAt + 60 s + 2 min` is read with the hold by the sweep and `timerBackstop` = 1. The same board inside the window is read WITHOUT the hold.
- **Review I1's own pin.** N = 6 flag-due boards plus one teardown candidate and one mint-retry candidate: the teardown and the retry RUN, and the settling reads are 2 with `deferred` ≥ 4. Then the same with N = 0. Derive the hold count from `FLAG_SETTLE_HOLD_MS` and the cap, never a literal.
- **Mutants**, each run once, each must red a named test:
  - delete the arm call in play.ts;
  - invert the version compare;
  - drop the staleness gate;
  - drop the `last_polled_at` claim in the endpoint;
  - remove the cap of 2;
  - remove the sub-budget;
  - make the held-row exception `return true`;
  - zero the jitter. This one should NOT red anything: it is a load measure, so its test is a property ("offsets differ across 30 boards").
- **E2E / walkthrough.**
  - A chess walkthrough on a prod build: both tabs closed at a flag. The arm is visible in the Worker log, the fire lands, and the fixture shows the result within 30 s of `flagAt`, against today's ≤ 5 min.
  - Then "No result → void → re-open" with timers on: D17's arrival is re-armed.
- **Smoke.** `POST /api/cron/external-play/board` without the secret returns 401, and with it for an unknown fixture returns 404.
- **Regression.** The existing sweep suite stays green with timers OFF, so the flag off is today's behaviour plus the I1 fix.

## 8. Rollout

1. **Land the I1 fix (§6.1) on its own,** flag-independent. It makes the sweep safe whatever happens to the rest of this design.
2. **Measure on stg before building on it (§5.1):**
   - the lila held-read flag, with both tabs closed;
   - a stopped-machine cold boot, timed from a `curl` against the stopped app.
   Record both in the programme's progress file.
3. **Ship the endpoint and the arming code with the app flag OFF.**
   - The flag is an env var, `EXTERNAL_PLAY_BOARD_TIMERS=1` (Q6). It is not the PostHog org flag: this is infrastructure, and `online-chess-flag.ts` forbids gating anything that finishes play on an org flag.
   - Off means no arm calls, the endpoint answers 200 `disabled` and the DO empties, and the sweep runs today's behaviour plus §6.1.
4. **Deploy the Worker with the DO class.** That means the migration tag, the binding and the `/timer/*` routes, to **stg** first (`deploy:stg`). `ACTIVE` stays as it is.
5. **Turn the flag on on stg.**
   - **Migration of live boards needs no code.** Every NEW ply arms its board's flag at once, and every NEW open arms its arrival.
   - A board live at the switch with both players gone is exactly today's case, and the sweep's backstop covers it.
   - A round opened before the switch keeps its arrival in the sweep, so it is up to 5 min late, as today.
   - The alternative, a one-off backfill route that arms every live board, is offered as Q8 only if the owner wants the switch to be instant.
6. **The stg drill,** with at least 6 concurrent boards:
   - 3 flag with tabs closed, 2 no-shows, 1 played normally;
   - pass: every deadline acted on within 30 s, the sweep's teardown and mint_retry not deferred, `timerBackstop` 0;
   - then kill the Worker (`ACTIVE` off) mid-round. Pass: the sweep backstop resolves every board within one cadence plus the grace.
7. **prod.** Move to Workers Paid (Q2), deploy the Worker, then set the env flag.
8. **Fallback, at any time.** Unset the flag, which takes effect at the next deploy or machine start, or set the Worker's `ACTIVE` off, which is immediate. Either way the sweep, with §6.1 in place, resumes every deadline within one cadence. Nothing is stored only in the DO, so turning it off loses nothing.

## 9. Not in scope

- RTK budget I2 (§5.3, its own task).
- Moving camera evidence or arbiter TTL into timers.
- Any change to the five reconcile triggers.
- Correcting the parent design's stale §3.5 text (§1); it belongs in that document's next revision.
- A DB-wide dedupe for the room's clock-zero report. It is still per process (room.ts:121-125). With prod at up to 3 machines, a client report and a timer fire can each hold one read. That is accepted: idempotent, and two reads at most.

## 10. Open questions for the owner

Each question carries a recommendation, the product owner's view of it; it is not a ruling.

1. **Q1. Where does the DO live?** Recommended: inside `apps/cron-worker`, which is one Worker, one secret and one deploy, rather than a new Worker.
2. **Q2. Workers Paid ($5/month) for the account before prod timers?** Recommended yes. The reason is not price. The free 100k requests a day are shared account-wide with the cron Worker, and exhausting them would also stop the cron.
3. **Q3. Reuse `CRON_SECRET` for both directions, or a separate `BOARD_TIMER_SECRET`?** Recommended: separate, because the app sends it to a public `workers.dev` host on every ply.
4. **Q4. Mint retry (D4) in the timer?** Recommended yes. A 429 retry then lands at `retry_at` rather than up to 5 min later, which can be the difference between a game made and a `not_started` hold inside a 20-minute window.
5. **Q5. Camera evidence and arbiter TTL stay in the sweep: confirm.** Recommended: stay (D6, D7).
6. **Q6. The flag mechanism: an env var (recommended) or a PostHog flag?**
7. **Q7. Re-arm on every ply (as the brief has it, and recommended for ship 1), or the lazy re-arm that halves requests?**
8. **Q8. Is the zero-code migration of live boards acceptable (§8.5), or is a one-off backfill wanted?**
9. **Q9. What if the stg measurement shows lila does NOT settle a flag on a held read?** The timer then only moves the `clock_flag_unsettled` hold to about 60 s. Is a held board, with the organiser deciding on the evidence, an acceptable end state for an unwatched flag?
10. **Q10. Reuse the `clock_zero` trigger (recommended), or add a sixth trigger `timer`?** A sixth trigger changes the parent design's "five triggers" and its enumeration test.
11. **Q11. Should a sustained `timerBackstop` count become a cron failure counter (a Sentry event an hour), or stay a warn log?**
12. **Q12. Is a new dev dependency, `@cloudflare/vitest-pool-workers`, acceptable for one true DO integration test, or are the pure-module tests with a fake clock enough?**
