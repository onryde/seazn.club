# Check-in capacity plan 2: rollout runbook (Task 11, operator checklist)

Owner-run. Part A (this document and the code behind it) is done; the staging round and the production flips are the
owner's. Task 11's own text (Steps 1-4, preconditions) is in the plan; this is the ordered, mechanical version with every
carry folded in at the step where it bites. Every env name, route and report field below was grep-confirmed in the tree
on main `dab9750ff4`; anything not verifiable from the tree is marked **unverified**.

## 0. The four env switches, exactly

| Name | Read at | Reads ON when | Notes |
|---|---|---|---|
| `EXTERNAL_PLAY_PREMINT` | `usecases/external-play/premint.ts` (top of the pass) | exactly `"1"` | `"true"`, `"yes"`, `"on"`, unset all read **disabled**, and a disabled pass is healthy (`disabled: 1`), so a typo looks fine and does nothing. After setting, confirm the pass report no longer says `disabled: 1`. |
| `EXTERNAL_PLAY_PRESENCE_PROOF` | `usecases/external-play/preflight.ts` (`presenceProofOn`) | exactly `"1"` | Anything else is the old 3-call read. Stays OFF until section 3's two gates are met. |
| `EXTERNAL_PLAY_WINDOW_DEFER` | `external-play/round-open.ts` | default ON; **only exactly `"0"` disables** | Fail-safe: unset, `""`, `"false"` all defer. It is the open-window deferral of the sweep and pre-mint. `"0"` is the e2e server's setting and an emergency lever only. **Never `"0"` in production** (it lets the sweep and pre-mint spend vendor calls during a check-in window, against the players' claims). |
| `LOAD_PRESENCE_PROOF` | `e2e/load/chess-30-boards.load.ts` (`parseProofKnob`) | harness only | Must **equal the server's** `EXTERNAL_PLAY_PRESENCE_PROOF`: nothing cross-checks them, and a mismatch makes the harness's price bars compare against the wrong read cost (21 flag off; 9 flag on, so with the flag on the bars cannot see overspend between 9 and 21; tighten them at flag-on). Set it explicitly on every load run. `LOAD_WEBHOOKS=1` is also required for a flag-on run (without it no webhooks are delivered and every seat takes the fallback). |

Local note: `scripts/ci-local.sh` exports both server flags to **all** local e2e jobs (CI sets them for `e2e-parallel` only). A local
e2e green is not the CI shape for the other jobs.

## 1. Preconditions (both are blocking)

1. **Plan 3 Task 1 merged AND deployed** to the environment: staging before Step 2, production before Step 4. With the proof flag
   off, today's arbiter rule admits an arbiter into every pre-minted room stamped with its board's pairing (`arbiter.ts` samePair),
   before anyone has joined: billed, and contrary to the spec. Check: plan 3 Task 1's PR is on main and the stg/prod deploy that
   contains it has finished (Fly release, section 6).
2. **`closedByEnded` gate** of plan 1 Task 12 step 5 met, before ANY step turns `EXTERNAL_PLAY_PRESENCE_PROOF` on (staging Step 2 or
   production Step 4). Defined there only. Read it from `scripts/presence-shadow-report.ts` output: `closedByEnded > 0` prints
   `blocksProofFlag: true`.

## 2. Step 1: local pre-check (not the gate)

Local prod server, `EXTERNAL_PLAY_PREMINT=1`, `EXTERNAL_PLAY_PRESENCE_PROOF=1`, `LOAD_PRESENCE_PROOF=1`, `LOAD_WEBHOOKS=1`. The
fixture listens on 127.0.0.1 only, so this cannot run against staging. Run it on an otherwise idle machine (CPU contention skews seat
p95). Record beside the baseline in `docs/superpowers/plans/2026-11-05-checkin-capacity-baseline.md`: calls per board, seat p50/p95,
`lockWaitMs` p95, busy count, `presenceFallbackCount` (expected 0). Plan 1's end-of-run presence checks must pass. Adjust the harness's
price bars for flag-on first (section 0).

## 3. Step 2: THE GATE (staging, real Cloudflare RealtimeKit, webhook registered)

Defined in plan 1 Task 12 step 5; run after Step 1 is green with both of this plan's flags ON on staging. In the same round record:

- (a) `presenceFallbackCount` and the `seat: ... fell back` log lines (two kinds: "no presence on file", "the peer on file has left"). Expected 0.
  The counter is per process and in-memory (`presenceFallbackCount()` in preflight.ts; not exported over HTTP): the log line is the
  prod-visible signal. Do not budget on "at most once per page": a token restamp after every handout restarts the fallback clock, so a
  live page that never joins falls back again every >= 10 s per press, and a departed peer costs 1 + up to 3 reads per slot.
- (b) at the leave probe, read the departed peer's report every 1 s until `participant.left_at` appears; record the latency. This is R4's
  unmeasured fact. **The proof flag stays off in production until this is measured**: if `left_at` lags, a departed player is seated.
- (c) one board whose rooms were made while paired, deliberately re-paired before the open: rooms retired at the claim or by the
  sweep, and the +4 visible. The +4 is now a log line: `realtimekit: stale room retired` with `endCalls` (2 per room whose vendor end
  was asked, 0 for an already-ended row); two stale rooms = +4 over the claim's stamp.
- (d) pre-mint report fields `roomsMade`, `windowsOpen`, `deferred` and the sweep's `windowsOpen` / `deferred`; no
  `POST /meetings/:id/participants` before the open.
- (e) whether a pre-minted room nobody joins accrues a Cloudflare charge: **unverified**; a charge goes to the owner before production.

Pass rule: the `--strict` shadow report exits 0 (`node --experimental-strip-types scripts/presence-shadow-report.ts --since <iso with Z> --fixture <uuid> --strict`;
`--strict` needs at least one `--fixture`, exit 2 without). Steps 1 and 2 green, in that order, are the gate.

**Flip the proof flag OFF only between rounds, never mid-stay.** A stay is priced once at its first claim and never re-priced: a stay
stamped under the flag (reservation 8-9) that then reads at 3 calls (flag off) under-prices, up to -12 per stay for the admit hold. A
flip OFF mid-stay is the only way the price and the read disagree. (An upward-only restamp would fix it; not built, an owner call if ever
needed.) The same applies to turning it ON: do it with no round open.

## 4. Step 3: pre-mint on staging

`EXTERNAL_PLAY_PREMINT=1` (exactly). Use a Swiss division whose round 1 is paired in setup, and a started division with placeholders
paired later. The route is `/api/cron/external-play-premint` (cron Worker, fast trigger, last row of the table). Expect: rooms for the setup
pairing and for placeholders before their pairing, never a participant (the first claim adds each); the open seats every player.
Report fields: `skipped` (held lock, a failure), `disabled` (flag off, healthy), `scanned`, `roomsMade`, `deferred`, `failed`, `windowsOpen`.
A disabled pass reports `disabled: 1`, **not** `skipped` (an older plan text said `skipped: 1`; fixed).

## 5. Step 4: production

Pre-mint flag first, for a week. Then the proof flag, only after sections 1.2 and 3(b) are met. Watch both on:

- **Fallback counter** (`seat: ... fell back` warn lines; baseline 0 with webhooks healthy).
- **Sweep and pre-mint `windowsOpen` / `deferred`.** Record the **windowsOpen share** (firings with `windowsOpen: 1` over all firings, per
  day) as a metric from day one: window deferral has no maximum age across platform overlap, so a platform that is always inside some
  board's window starves the sweep and pre-mint, and nothing else says so. Decide a ceiling before scale.
- **Shared 45-call cap** (`SWEEP_RTK_CALLS_PER_PASS`, `sweep/pass.ts`): teardown runs first, so with >= 23 rooms due (2 calls each) the
  evidence, TTL-arm and parked-room jobs get 0 calls that pass. A growing `deferred` with `windowsOpen: 0` is this.
- **Pre-mint row overlap**: the pre-mint is last and can run into the next firing; the next pass's held lock answers `skipped: 1`
  (log-only except at `:00`; it is in `failureCounts`, so a persistent one pages). Occasional is expected at flag-on; persistent means
  the pass outruns a minute.
- **Stale-room spend**: sum `endCalls` of `realtimekit: stale room retired` per hour; it is the only per-retire view of the +4.

## 6. Cron Worker vs app deploy ordering (read from the workflows)

- `stg.yml` (push to main) and `prod.yml` (tags `v*.*.*`) each have two jobs with **no `needs:`**: `deploy-stg`/`deploy-prod`
  (Flyway migrate, sync, build, `flyctl deploy`) and `deploy-cron-worker-stg`/`-prod` (`wrangler deploy --env ...`). They start together
  and run in parallel.
- Consequences: the Worker can go live before the app's new route exists. A failed migrate or Fly deploy leaves the **Worker deployed**
  and calling `/api/cron/external-play-premint` on the old app, which has no such route. Whether that paged is **unverified**: the
  Worker's `failureCounts` for this row read `data.failed` and `data.skipped` from the response body, and how the Worker treats a 404
  with no body is not read here. Treat it as noise or a page, not as known behaviour. The
  Worker's `ACTIVE` var is `"true"` (wrangler.json), so there is no off switch short of redeploying or flipping that var.
- A `needs:` was **not added**: `apps/web/src/__tests__/toolchain.test.ts` ("no deploy workflow declares needs:") forbids it, because
  the gate jobs live in `ci.yml` and a cross-workflow `needs:` is a silent no-op. A same-file `needs: deploy-stg` on the Worker job
  would be real, but would reverse a deliberate test and change live deploy topology, so it is a recommendation, not a one-line safe
  change: **order the rollout by hand instead**. Because the premint route answers `disabled: 1` while the flag is unset, deploy the app
  first (plan 2 is already on main), confirm the Fly release is healthy, and only then set the flag. No Worker redeploy is needed for this
  rollout; the `external-play-premint` row already ships (plan 2 Task 5).
- The Worker smoke (`ai-previews`) retries across the Fly rollout and a missing `STAGING_CRON_WORKER_URL` is a warning, not a failure.
  Whether a Worker deploy with the route absent has paged in practice: **unverified**.

## 7. App rollback after V531 (the camera_live_first_at trap)

V531 added `fixture_video_participants.camera_live_first_at` and the check `fixture_video_participants_camera_live_first_check`:
`camera_live_first_at is null or camera_reported is not distinct from 'live'`. The new writer (`camera-report.ts`) clears the stamp in
the same statement as every non-live write. A **pre-V531-aware build never clears it**, so after rolling the app back, its first
`off` report over a stamped row is refused with 23514 and the camera report fails for that seat. (Migrations are not rolled back. Pricing is untouched by this trap: `reservation` and `recheck_cost` live on `fixture_seat_line`, not on
`fixture_video_participants`.) V531's other changes (nullable pair stamps, the new columns) being harmless to an old build is
**UNVERIFIED**; see "Unadopted rooms" below.

Two fixes; **use A**:

- **A (use this): clear the stamps, keep the constraint.** Run it only after the rollback deploy has **fully completed**: Fly's rolling
  deploy overlaps old and new machines, and any new-build machine still running can re-stamp. Confirm no new-build machine is left
  (`fly status` shows only the old release), then run it, then **run it once more** and confirm 0 rows updated. During the overlap the old
  machines refuse `off` reports over stamped rows (23514); that is expected until the statement has run on a clean fleet.

  ```sql
  update fixture_video_participants set camera_live_first_at = null where camera_live_first_at is not null;
  ```

  Blast radius: only the new fallback clock's "first live receipt" for seats currently live (the reader treats live-with-null as a run
  starting now, so the worst case is a fallback that starts later). Old code never reads the column. Small, one table, no lock beyond row
  locks of live seats. Between the app rollback and this statement, `off` reports for stamped seats fail: run it immediately, then
  re-check `off` reports succeed. Roll the app back first and let it finish, clear second; the other order lets the new code re-stamp.
- B (only if A cannot run): `alter table fixture_video_participants drop constraint fixture_video_participants_camera_live_first_check;`
  Blast radius: takes an access-exclusive lock on the table briefly, and removes the invariant for the next roll-forward (re-adding it
  validates every row). Stamps are then left in place and unread by old code.

**Unadopted rooms (UNVERIFIED, treat as a risk).** The current `retireStaleMeeting` skips null-stamped (unadopted, pre-minted) rooms
with `m.home_entrant_id is not null`. A **pre-plan-2 build lacks that guard** and was never tested against null stamps, so it would likely
read a pre-minted room as "another pairing's" and end it (2 vendor calls each, +4 per board). Nothing in the tree is a route or script that
cleans these up. Before rolling back past plan 2: turn `EXTERNAL_PLAY_PREMINT` off, then either accept the spend, or end the rooms first.
There is no operator route for the end; the SQL to **list** them is:

```sql
select m.fixture_id, m.side, m.meeting_id from fixture_video_meetings m
 where m.home_entrant_id is null and m.ended_at is null
   and not exists (select 1 from fixture_video_participants p where p.fixture_id = m.fixture_id and p.side = m.side);
```

Ending them at the vendor is a Cloudflare call per room (`PATCH /meetings/:id` inactive) and has no tooling here; deleting the rows
without ending the rooms leaves live vendor rooms nothing tracks (the exact thing the retire path's order exists to prevent), so do not.

Flags first: before any app rollback, turn `EXTERNAL_PLAY_PRESENCE_PROOF` off **between rounds** (section 3), then `EXTERNAL_PLAY_PREMINT` off.

## 8. Open items for the owner

- Cloudflare charge on a never-joined pre-minted room (3e): unverified.
- Worker/app deploy order: hand-ordered (section 6); a same-file `needs:` is the alternative and needs the toolchain test amended.
- Window-deferral max age: record the windowsOpen share first; build a ceiling only if it bites.
