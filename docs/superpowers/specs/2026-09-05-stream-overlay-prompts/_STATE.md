# Stream overlay — resume state

## R1 EXECUTION STATE — CURRENT (updated 2026-09-20, session r1-w1). READ THIS BLOCK FIRST; it supersedes every older "where things stand" block.

**Owner standing order (2026-09-16):** context is compacted without warning, so every state change and every
decision is written HERE (committed, `_STATE.md`) and in the ledger
(`.superpowers/sdd/2026-09-13-streaming-r1/progress.md`, git-ignored, machine-local) AT THE TIME IT HAPPENS —
never only in conversation. After a compaction, trust these two files and `git log`, not recollection.

**Where:** worktree `.claude/worktrees/relay`, branch `feat/stream-relay`, env label `rly`
(Postgres :54484 dbs `seazn_rly` + `seazn_rly_t1`, data_directory `/tmp/seazn-env/rly/pg`; placement :50257).
Commits are LOCAL — nothing pushed this session. Process: superpowers:subagent-driven-development, `model: opus`
on every dispatch, reviewer after every task + every lane, orchestrator re-runs the gate at lane boundaries,
orchestrator commits (implementers never commit).

**Floor:** 17856 total / 0 real failures @ `b4091834d` (JSON at
`.superpowers/sdd/2026-09-13-streaming-r1/authorities/baseline-2026-09-16/`). Old 17064/17141 is SUPERSEDED.

**Done (task → commits → review):**
- Baseline → `ea60d147a`.
- Task 1 migration, 8 tables (written as V408, RENAMED to **V410** at the 2026-09-20 rebase after main landed V409), RLS forced zero policies, SUPERUSER_ONLY exemption) → `62e988a6f`, `f590dc114` — clean.
- Task 2 config / AES-256-GCM envelope / `*_enc` boundary / sanitiser / telemetry → `27c0681b8`, `56159fc41` — clean.
- Task 2A session aggregate → `5851d2956`, `e3c937736` — clean.
- Task 2B expiry / credits / retention → `4c1e66288`, `a2f6d5bb4` — clean.
- Plan amendment Tasks 7 / 7A (staff Match credits panel) → `36a9132e6` (plan file only).
- Task 2C runner table → `a49e3f4ff` + fix rounds `a21913582` (1), `292ac278b` (2+3), `56b29d971` (4),
  `30560cf9a` (5, FINAL). Domain 212/212/0, relay-with-DB 262/262/0, tsc/eslint 0.
  **COMPLETE** — re-review 3 Approved (task-2C-rereview-3.md), 3 Minor parked (duplicate "I1:" test title,
  comment precision session.ts:182–184/:212, C6 does not pin desiredState).

- Task 3 ports + fakes → `4a11c1b4a` — clean (15 tests, 53/53 mutants). 9 minors deferred to the lane-A sweep.
- Task 4 Cloudflare Stream ingest adapter → `32c3c8b82` + fix rounds `09f3aeea6` (1), `8b5072457` (2). **COMPLETE** —
  re-review 2 Approved (task-4-rereview-2.md). Round 1 fixed the CRITICAL: retention was sent NESTED inside
  `recording` (the shape measured as silently dropped, specs/2026-09-11-cloudflare-stream-measured.md:26,92) — now a
  top-level `deleteRecordingAfterDays` with a read-back that best-effort deletes the new input and THROWS on mismatch.
  Relay 297 total / 272 passed / 0 failed / 25 pending, exit 0; ingest-cf 16/16; tsc 0; eslint 0; 13 mutants killed.
  2 Minor parked (I-3's 2xx tolerance could mask an orphan; the refusal message is untranslated English — Task 10 must
  map it to a dictionary code and never render `err.message`).

- **N-3 CLOSED by live measurement** → `5b40fdf0c` (doc only). Owner authorised live create+delete 2026-09-20
  ("yes, you can create and delete"). The probe created ONE live input (`r1-n3-probe-1789901523`), deleted it in the
  same run and confirmed the delete with a 404/10003 re-read; post-sweep 0 inputs, videoCount 0 — NO LEAK, no secret
  printed. Verdict: `ingest-cf.ts`'s read-back HOLDS — the API echoes `recording.timeoutSeconds` 180 and
  `deleteRecordingAfterDays` 30 at the TOP LEVEL, exactly where :160–161 read them; the :178 throw is unreachable.
  `RELAY_DRIVERS=live` is no longer blocked by an inferred echo. Full measurements appended to
  specs/2026-09-11-cloudflare-stream-measured.md; verdict in `.superpowers/sdd/.../n3-probe-report.md`.

- Task 5A Fly Machines API client → `bcd459094` (BASE a6f5d9f32). fly-client.ts + fly-client.test.ts +
  fly-client.live.test.ts (new), config.ts (doc comments only). Orchestrator re-ran the gate independently: relay
  321/293/0/28 exit 0, worktree paths confirmed, the 3 live tests correctly PENDING without `RELAY_LIVE_FLY`; tsc 0;
  eslint 0. Implementer: unit 21/21, 15/15 mutants killed, live leg 3/3. **Live run: 14 Machines created across 4 runs,
  all 14 confirmed destroyed — orchestrator INDEPENDENTLY confirmed app `seazn-relay` holds 0 machines. No leak.**
  Three inferred premises were wrong and shipped broken until the live run (`/wait` returns `WaitMachineResponse`, not a
  Machine; `request: null` on launch/destroy events; events arrive NEWEST-FIRST, so the brief's `reverse().find()` read
  the OLDEST exit). All three fixed with a mutant each.

  **Task 5A COMPLETE** — `bcd459094` → fix round 1 `9ee011646` → fix round 2 `b42acb34c`; re-review 2 / confirm pass
  Approved, CLOSEABLE (task-5A-rereview-2.md). Round 1 closed 2 Critical + 6 Important; round 2 closed a NEW Critical
  (the `deadline` exit reported `retryable: true` on an absence from one unsettled list — the domain's retry posts a
  DIFFERENT name `relay-<sid>-r2`, so Fly would not refuse the duplicate). Now: `retryable: true` may leave a create
  ONLY on a CONFIRMED absence, proven by a 70-cell parity sweep with both outcomes witnessed. Gate at close:
  relay 331/302/0/29 exit 0, tsc 0, eslint 0, `seazn-relay` 0 machines — no leak across 19 live Machines this task.

- Task 5 Fly runner adapter + driver selection → `056347c56` → fix rounds `316fd4b2e` (1), `31a04f191` (2).
  **COMPLETE** — spec compliance APPROVED, 0 Critical; re-review 1 closed all six Importants and the small round-2
  `lazyRunner` Important was verified by the orchestrator directly (mutant on `observe` → exit 1, 30/1, red line
  names the method; restored `cmp`-identical). `PROVISION_TIMEOUT_SECONDS` 120 → **180**, DERIVED (createWorst 109.5
  + waitWorst 55 = 164.5, +1× requestTimeoutMs = 174.5 floor) and the gate extended to the COMPOSED path — it went
  red at `expected 164500 to be less than 120000` before the constant moved. Real defect found and fixed: `listingOf`
  read RAW Fly state while `observe` used `FLY_STATE_MAP`, so a `suspended` Machine answered `"other"` from `list()`
  and `"stopped"` from `observe()`; both now derive from one function, pinned by a 17-state two-PATH differential.
  Blast radius measured: exactly one cell moves and `RunnerListing.state` is read nowhere yet. Gate at close:
  relay 362/357/0/5 exit 0, 69 suites, tsc 0, eslint 0, one live Machine confirmed destroyed, `seazn-relay` empty.
  9 Minors deferred (incl. a real `fromFlyState("constructor")` prototype-key leak).

- Task 6 job + page tokens (`tokens.ts`, `AUTH_SECRET` via `jose`) -> `584e9e8f0` + fix round `f3cb1f8a0`. Review I2 was
  a REAL cross-surface defect: the SESSION verifier accepted a relay PAGE token. Closed by pinning `audience` AND
  `algorithms` on the session verify plus a `uid` type guard -> `b4d094253` (`lib/auth.ts` + `auth-session-audience.test.ts`).
  **Owner ruled option 3 ("3 as no users in prod today"): pin the audience on the session cookie and accept that every
  EXISTING session cookie stops verifying** — everyone is logged out once at deploy. Relay token lifetime is 5h30m and
  there is NO revocation; the session cookie is 30 days, not sliding, and logout only deletes the cookie. A
  `token_version` claim is RECOMMENDED as its own work AFTER R1 — the owner has not ruled on it.
- Task 7 **Step 0c** (the migration amend, pulled forward into lane A) -> `cdd66e9ed`. `max_duration_minutes > 0`;
  `beat_window_at timestamptz null` at ordinal 14; `'revoke'` in the reason CHECK; `idempotency_key text null` +
  `org_stream_credits_idempotency_key` unique partial, TABLE-WIDE (ruling: table-wide STAYS — the stored row's org must
  be comparable, so a key reused with a different org answers 409 `idempotency_key_reused`).
  **MERGE BLOCKER found and closed here: `main` had merged `V409__player_stat_folds.sql`, so our V408 sorted BELOW a
  merged migration and this repo does not enable Flyway `outOfOrder`.** Renamed `git mv` to
  **`V410__stream_sessions.sql`**, and the ordering PROVEN with its defeating half: against a DB carrying main's V409 a
  V408-numbered probe fails `Detected resolved migration not applied to database: 408` (exit 1) while V411 applies clean
  (exit 0). A fresh DB built from our branch alone applies 408 then 409 happily — which is exactly why every local green
  before the fetch could not see it.
  A SURVIVOR the whole suite missed: dropping the index's partial predicate SURVIVED, because **Postgres unique indexes
  are NULLS DISTINCT by default** so the NULL rows prove nothing, and nothing asserted the index NAME (lane B needs it to
  map 23505 -> 409). Closed with an `indexdef` pin.
- **REBASED onto `origin/main` (`ee80dcd66`) — 57 commits, clean, zero conflicts.** Re-verified from scratch rather than
  trusting the clean rebase: env torn down and up, DB recreated, `db:apply` (245 migrations, at v410), `sync:sports`, and
  the applied-version tail read back live -> `245|410, 244|409, 243|404`. Post-rebase gate 3475/3435/0/40, 954 suites,
  exit 0; tsc 0.
- **Lane-A minors sweep -> `79177018d`** (17 files under `server/relay/`). 70 minors from 16 reviews: 43 fixed, 9 already
  closed by a later round (re-verified), 2 not-a-defect, 16 routed to the owning task. Real find: a prototype-key leak —
  `fromFlyState("constructor")` returned the `Object` function. Two more found in the sweep's OWN instrumentation: a
  `toContain('import "server-only"')` assertion survived commenting the import out (it matches the string inside a
  comment), and `runner-fly.live.test.ts` read its Fly token at module scope ungated — the defect T5A m8 named in the
  sibling file. 23 mutants, 23 killed. Gate re-run by the orchestrator: **3486 / 3446 / 0 failed / 40 pending, 955
  suites, 274 files, exit 0**, zero paths outside the worktree; tsc 0; eslint 0 over **39 files actually linted**.
- **Lane-A plan pass -> `c454dc147`** (plan file only): V408 -> V410 across all 37 references (Task 10's preflight greps
  that path LITERALLY on a gate marked "STOP, this is money" — the empty grep would have read as a FALSE ABSENCE); the
  placeholder scan's own regex widened from `V40[3-9]__` to `V4[0-9][0-9]__` (it could no longer match the number it
  exists to police, so it would have reported CLEAN over 37 pinned refs); the NESTED retention shape synced to the
  measured top-level one at all four sites; and Task 12's N-1 acceptance criteria added as a new Step 3b.

- **Lane-A whole-branch review -> Needs Fixes (0 Critical, 6 Important, 3 Minor, 2 gaps), then TWO fix rounds,
  then a scoped re-review that judged the lane MERGEABLE.** `bcebfe657` closed I1-I6 + g1 + g2 + m1;
  `1a0be8a8d` closed N1 + N2, found by the re-review. Every Important was a SEAM BETWEEN TASKS — nothing
  shipped was wrong on its own, which is why eleven per-task reviews could not see them. Detail in
  `lane-a-review.md`, `lane-a-fixes-report.md`, `lane-a-rereview.md`; rulings in the ledger.
  The two that decide behaviour: the Machine's hard stop was anchored on `createdAt` while the session's
  wall clock is anchored on `startedAt`, so the Machine always died FIRST and burned the session's one
  retry (worst branch: a match that aired loses its replay link) — the slack now sits on the runner
  deadline, not the wall clock. And a create that FAILS is now unknown-outcome unless something PROVES
  otherwise: a 409 that could not be adopted, and any non-retryable 5xx, were both being reported as
  "made nothing", the first being the one status that proves a Machine holds that name.
  V410 gained three exit columns and the `<= 300` ceiling in the same amend, while it is still unmerged.

- **FULL GATE at `1a0be8a8d`: `apps/web` 19389 total / 19303 passed / 0 FAILED / 86 pending, 1404 files,
  EXIT 0** (floor 17856), plus the repo-root `scripts` suite **1926 / 1926 / 0 failed, EXIT 0**.
  **Two environmental faults were diagnosed, not accepted:** the four `schedule-build-honours-locks` reds
  pinned since Task 6 are a MISSING `PLACEMENT_SERVICE_HOST`/`SECRET` in the invocation (the service was
  running the whole time) — 12/12 with them, and the pinned red is closed with its mechanism named; and
  `smoke-db-shard-partition.test.ts` reds under full parallelism while passing 3/3 alone and 1926/1926 at
  `--maxWorkers=3`, which is LOAD on a shelled-out child, a second cause of an error string this repo
  already records for a nested worktree.

**In flight at time of writing:** NOTHING is dispatched. Lane A is built, reviewed, fixed, re-reviewed and
fully gated at `1a0be8a8d`. The next action is the OWNER's: ask -> push -> open the lane-A PR -> take its number
-> `gh workflow run e2e.yml -f pr=<N>` -> wait -> only then mergeable. `e2e.yml` re-read 2026-09-20: it triggers on
`push: branches: [main]` plus `workflow_dispatch` with a `pr` input, three jobs, seven widths across e2e-mobile's
3+2+2 matrix — a feature branch gets NO automatic e2e signal, so the dispatch is the only pre-merge run.
`apps/web/e2e/.auth/` has been EMPTIED (both cookies predated the session-audience pin).

**NEW outward-facing resource, owner flagged:** the Fly app `seazn-relay` did not exist; the Task 5A implementer
CREATED it (org seazn-club, id `p7vx1jevmyrw9k3z`). Empty apps bill nothing and Task 5 needs it. Ruling: KEEP.
`DELETE /v1/apps/seazn-relay` undoes it. The org's other apps (seazn-club-stg, placement, placement-stg) are
pre-existing and untouched.

**Verification trap found this session — put it in every lane brief:** eslint run from the WORKTREE ROOT with
`apps/web/src/...` paths answers "File ignored because of a matching ignore pattern" and EXITS 0 having linted
nothing. It must be `cd apps/web && npx eslint src/...`.

**Carries opened by Task 5A (detail in the ledger):** T5-c Task 5 must ADOPT on HTTP 409 `already_exists` rather than
fail (409 is non-retryable and its body NAMES the existing Machine id, so T5-b is not violated — but 409 skips
`onAmbiguous`); T5-d `waitMachine` is a long poll, default requestTimeoutMs 10s < default 60s wait and Fly caps
`timeout` at 60s (90 → HTTP 400) — Task 5 owes the sizing; T5-e `PROVISION_TIMEOUT_SECONDS` 120 holds (live
create→started 2.8–4.2s, worst case 98.5s) but the 21.5s headroom is the CREATE's alone — a `waitMachine(started)` in
the same window can exceed it; T5-f measured lifecycle facts — on an `auto_destroy` Machine `state: "stopped"` is often
NEVER observable (the wait 404s), a destroyed Machine GETs **200 `destroyed`** not 404, and after `wait destroyed` the
next GET can still read `destroying`.

**N-5 CLOSED on the ENV side — the code is correct, the minors-sweep rename is CANCELLED.** The owner re-keyed both
`.env.local` files to `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_STREAM_TOKEN`, the pair `ingest-cf.ts:79–82` reads; the old
`CF_ACCOUNT_ID` / `CF_API_TOKEN` names are gone. Do NOT rename anything in the code. One residual typo was found on
re-read and fixed: the key was spelled `CLOUDFLARE_STREAM_TOKEN.=` (trailing dot inside the KEY name) at root:48 and
apps/web:52, so `process.env.CLOUDFLARE_STREAM_TOKEN` would still have been undefined; renamed the key in place through
the resolved path, both worktree symlinks verified intact afterwards, no value read/printed/copied, backups deleted in
the same call. Verified live read-only: `GET /accounts/{acct}/stream/live_inputs` → HTTP 200, `success: true`, 0 inputs
(which also re-confirms the N-3 probe left no leak). Live credentials now work under the names the adapter expects.

**PLAN OWED — CLOSED 2026-09-20 by the lane-A plan pass (`c454dc147`); kept as the record of what was owed:** plan:4686 (comment), plan:4552–4557 (the create-body assertion) and
plan:4797 (the create body) still carry the retention field NESTED inside `recording` — sync all three to the MEASURED
top-level shape. plan:4730 / plan:4189 are the `capabilities` object, not a request body: correct as written, leave them.
The Task 12 brief owes the N-1 acceptance criteria: `length === LIST_VIDEOS_PAGE_LIMIT` means an INCOMPLETE listing
(import the constant); on truncation re-list by `createdBefore` = the oldest `created` seen, or record a
`listing_truncated` event — never silently under-delete; the fixture must hold exactly LIMIT videos because
`FakeIngest.listVideos` ignores `limit`; and any orphan-reclaim test must drive the REAL adapter (`FakeIngest` cannot
reach the orphan path). The probe confirmed `limit` IS the param name and 1000 a HARD ceiling (1001 → 400/10005), but
the account held zero videos, so TRUNCATION ITSELF remains unobserved and this carry stands.

**Next, in order:**
1. DONE `525f22c92`: plan synced to closed 2C (beat_window_at column/persist/tests, lifecycle table, carries as steps; T5-a in NAME form). Two OPEN items ruled: F-A (a) domain → Task 2C-post (in flight); F-B → Task 10 force_destroy feeds destroy_ok only while the locked row still names the destroyed Machine (drafter pass after 2C-post, which also removes the F-A OPEN notes).
2. Lane A: Tasks 3, 4, 5A, 5, 6 DONE → Task 7 Step 0c (the V410 amend) DONE → rebase DONE → minors sweep DONE → plan pass DONE. lane-A reviewer DONE → two fix rounds + re-review DONE → full gate DONE (19389/19303/0, scripts 1926/1926/0) → `e2e/.auth/` emptied. **REMAINING: ask owner, push + PR lane A → `gh workflow run e2e.yml -f pr=<N>` → update this block → owner opens a new session for lane B.**
3. Lane B: Task 7 (Step 0c already landed in lane A as V410) → 7A → 8 (lane-B review, 49 killers).
4. Lanes C/D/E per plan. Wave close: V410 retry-cap comment, rls-exempt header wording, File Structure `streamIdOf` row.

**FLY_API_TOKEN:** present (non-empty) in BOTH root `.env.local` and `apps/web/.env.local` (key-name check 2026-09-16; the worktree symlinks apps/web/.env.local to main). Nothing owed by the owner for Task 5A. Never print/echo/log RELAY_KEK, FLY_API_TOKEN/FLY_IO_TOKEN or `.env.local` values.

**Owner decisions 2026-09-20 (owner's words: "1 Ok , 2 yes e2e dispatch with pr number  3 Ok 4 Ok"):**
- **Retention:** no 3-day number in customer-facing copy until Task 12's sweep AND its schedule in the
  `seazn.club.workflow` repo are both live. State nothing, or state 30 days and tighten later.
- **Lane-A e2e:** run `workflow_dispatch` on `e2e.yml` with the `pr` input once the lane-A PR exists — this
  OVERRIDES my "skip it, lane A is server-only" recommendation. Sequence: ask owner → push → open PR → take its
  number → `gh workflow run e2e.yml -f pr=<N>` → wait → only then mergeable. A feature branch gets NO other
  pre-merge e2e signal (e2e.yml triggers on push to `main` only — re-read it, the trigger has changed three times).
- **Minors sweep:** fix ALL ~20 in lane A, one dispatch grouped by file.
- **Task 7A:** bring ≥2 UI options for the staff credits panel at the START of lane B, before any implementer runs.
- Earlier: "keep the fly app" — `seazn-relay` (org seazn-club, `p7vx1jevmyrw9k3z`) STAYS; "yes, you can create and
  delete" — live create+delete authorised against Fly and Cloudflare, under confirm-the-destroy conditions.

## LANE B — OPEN 2026-09-27 (session `r1-laneb`). Read this with the CURRENT block above it.

**Lane A MERGED as PR #812**, `main` = `b392be909`. Lane B worktree `.claude/worktrees/relay-b`, branch
`feat/stream-relay-b`, cut from that merge; `.env.local` symlinked both levels, `pnpm install --frozen-lockfile`
exit 0 with `node_modules/@seazn/engine` resolving INSIDE the worktree. The lane-A ledger was copied across, and
what lane A owes this lane is written up as
`.superpowers/sdd/2026-09-13-streaming-r1/lane-b-carries.md` — the four INERT Task 10 call sites
(`runnerDeadlineOf` → `RunnerSpec.deadlineAt`; `createFailedFrom(e)` from the create catch;
`readTargetSecret(tx, orgId, targetId)`; the three V410 exit columns read by `failReasonFromExit`, never
`last_heartbeat -> 'lastExit'`) plus the unknown-outcome create (an unmarked create routes the runner to `lost`
and emits `force_destroy`, signals the SESSION nothing, and on the LAST attempt now reports `machine_crash`
where it used to report `machine_create_failed`).

**OWNER RULING 2026-09-27 — the Task 7A panel is OPTION B: one button, one modal, ledger rail below**
(owner's word: "B", asked before any implementer ran, per the 2026-09-20 ruling "bring ≥2 UI options for the
staff credits panel at the START of lane B"). Three options were put: A = three inline action cards (what the
plan said), B = donor parity with `admin-credits-panel.tsx` — balance + one "Adjust credits" button opening a
`Modal` that carries the kind, amount, note and (refund only) session, C = B with no ledger rail, reusing the
page's existing Adjustments log. B was recommended and ruled.

Why it was recommended, kept here because the reasons decide later arguments: the three money verbs sit behind
one deliberate open, so `revoke` is never a button adjacent to `grant` on a staff page; it matches the ONLY
money precedent on that page, so staff learn one pattern for both wallets; and the rail stays because the
Adjustments log shows actor/action/category/reason/when/reversible but NOT the delta, the running balance or
the session link — which is exactly what a linked refund's cap is judged against (why C was rejected).

**What B moves and what it does not.** The route, the usecase, the zod body, the 401/400/404/409/422 codes and
every DB test are IDENTICAL under all three options; only `admin-stream-credits-panel.tsx`, its testids, its
component test and the walkthrough spec's steps change.

**The modal's opening values STAY in the component test — the "node cannot see inside a modal" worry was
WRONG, checked against the tree 2026-09-27 and corrected here.** `components/__tests__/_hook-harness.tsx`
exports `renderIsland`, `expandWithHooks`, `walk`, `textOf` and `propsOf`, and two live precedents drive a
closed modal open in `environment: "node"`: `v2/__tests__/stages-panel-court-tags-modal.test.tsx:47` calls the
trigger's own `onClick` prop (`(propsOf(button!).onClick as () => void)()`) and then asserts the modal BODY, and
`registration-hub-config-panel.test.tsx` finds the modal by `e.type === Modal` and expands both `children` and
`footer`. So the class-19 case — amount OPENS AT 1, `min` 1, `max` = the `maxDelta` prop (not the route's 50),
note and session empty, submit disabled until a note is typed — is asserted in the unit test as it would have
been under option A. Two traps came with the precedent: `island.text()` reaches `children` but is BLIND to
`footer`, which is exactly where the donor puts Cancel and the submit button; and an input's opening value is a
PROP, so it is read with `propsOf(el).value`, never from text. The only thing that genuinely moves to the
walkthrough is what a person does with it — open, type, submit, see the row.

**Lane B path note:** the plan's step commands are written against `.claude/worktrees/relay/` (42 occurrences).
Lane B runs in `.claude/worktrees/relay-b`; every such path reads as `relay-b` for Tasks 7 / 7A / 8.

**TEST STRATEGY — owner ruling 2026-09-27 ("update and store this similar rules for all R1 waves/lanes"):**
the format-matrix programme's ruling-21 practices are now RULES for every R1 lane and wave, adapted to this
programme's axis (mode x driver x state, not format x sport) and stored as `_RULES.md` "Test strategy" — S1
model-based sequence testing over the two machines (fast-check is ALREADY a devDependency of both packages and
already used in a money suite, so no new dependency; the command model is new to the repo), S2 anti-vacuity
(zero checked = failure), S3 both mutation layers (hand mutant per surface unconditional; a scoped Stryker run
waits on the owner's go for the CI spend), S4 sweep the axis by default, S5 shadow invariants logged never
blocking (needs the Sentry DSN the owner owes), S6 assumptions are guards, S7 rows declared per PR, S8 the four
reviewer questions translated to failure/expiry/refund/revoke, S9 rules before building, and S10 the
reconciliation of "values from code freeze wrong rules" with failure class 19 (a declared rule is the oracle; an
engine constant only for what the engine owns, imported not retyped; observed output is never an oracle).
**They apply from the next dispatch** — Task 7 keeps the brief it was dispatched with, and its REVIEW applies
them. Not yet ruled: whether they carry to R2/R3 as well, which I would recommend.

**Owner decisions this session (owner's words):**
- "No fine" (2026-09-16) — keep lane order: lane A (3→4→5A→5→6) before lane B.
- "Can we create the PR for each Lane, after each lane finish, we can start a new session and start a new lane?" —
  YES. At each lane close: lane reviewer + orchestrator full gate (JSON vs floor 17856) → PR for that lane (ask
  owner before push / gh pr create) → update this block → owner starts a NEW session for the next lane, which
  reads this block first. Lane A PR must include Task 7 Step 0c's migration amend pulled forward (it must be
  complete before it can merge; after merge an amend is a forward migration). DONE — it landed as **V410**.
- "FLY_API_TOKEN -Ok" — the env var is named `FLY_API_TOKEN` (not FLY_IO_TOKEN).
- "yes" to "Are we planning to build a new page in /admin?" follow-up — the staff Match credits panel goes on the
  EXISTING `/admin/orgs/[id]` page (plan owner ruling 15, Task 7A); no new admin page.

**Token policy (owner request 2026-09-16, adopted):** non-safety minors are ledgered "minor (deferred)" and fixed in
ONE minors-sweep dispatch at lane close (grouped by file); fix rounds and small re-reviews RESUME the same
implementer/reviewer; comment/title-only fixes are verified by orchestrator grep + JSON run; plan-text syncs are batched
once per lane. Exception: money, safety (no second Machine), data loss, a 500 on read -> fix in the task loop at once.

**Orchestrator rulings this session (full text + cost-if-wrong in the ledger):**
- V410 (written V408): fixture delete sets `fixture_stream_sessions.fixture_id` null (money/history survive); producer-less
  `vcpu_seconds`/`duplicated_frames` dropped; four org_id stream tables in `SUPERUSER_ONLY`; unmerged migration
  is AMENDED, never forward-fixed.
- SRT `{passphrase, streamId}` sealed as JSON in `ingest_srt_key_enc`; stored URLs stripped of query/fragment.
- Composed `credit_refused` tears the Machine down like `warming_timeout`; `fill_replay` only when `startedAt` set.
- A live composed session whose runner is not beating goes `stale_beat`; EVERY runner state answers it:
  none → fail; creating → lost + force_destroy; booting/playing → lost; stopping/exited stay; destroyed → retry
  while attempt < 2 else fail; lost → re-issue force_destroy once per window, no retry.
- `heartbeatAt` = last beat RECEIVED only (organiser panel); new `beatWindowAt` anchors the stale window
  (written by the stale arm and the retry arm); `evaluate` uses the later of the two.
- `runnerRetries` follows `runner.attempt` (idempotent).
- Invariant 1 (no retry create before the prior Machine's destroy is CONFIRMED) is proven by a full-depth walk
  of RUNNER_TABLE: lost leaves only on destroy_ok / observed destroyed (plus F17 completion cells); a late
  create_ok into destroyed → lost + force_destroy; marked-creating cells keep destroyed (no retry reachable).
- An ending session completes (own endReason + fill rule) on a runner `failed` signal; a stop on a provisioning
  session with a lost runner completes stopped.
- Model (owner, 2026-09-16, asked about Sonnet then "Ok Opus."): every subagent stays opus.
- Task 7A: donor parity (idempotency key + staff audit row in the same tx), revoke action, session-linked refund
  cap, 1–50 cap, English-only staff copy, 422 validation, per-org advisory lock on lower-cased org id, reused key
  with different values → 409 `idempotency_key_reused` (incl. 23505 race), route passes stored `org.id`.
- F-A: stopping/exited × grace_expired signal completed (organiser stop ends at grace+slack, not the 300 s backstop). F-B: stale destroy_ok gated at the application layer (Task 10), domain keeps throwing.
- Fix-loop rounds 4–5 resumed the SAME opus implementer (owner mandate pins opus; context continuity).

**Carries to later tasks (details in ledger):** T5-a `create_ok {machineId, attempt}` (late cross-attempt adopt;
M5 machineId overwrite); T5-b retryable create_failed ⇒ Fly holds no Machine; 5A retunes PROVISION_TIMEOUT;
T10-a beating lost Machine answered desiredState live; T10-b pin heartbeat route booting||playing guard;
T10-c lastExit provenance; T10-d / G2 drop `heartbeat_at` from apply's persist (beat route single writer);
T10 M1 retry_runner skip when runner no longer destroyed (lost × create_started throws); M2 plan
`machine_seconds` double count on re-entry to destroyed; G3 sweep `retried++` counts re-signals; T12-a
`orphan_listed` only terminal/absent; T-any composed `target_rejected` teardown; Tasks 3/4/13 fake driver on
observed CF SRT shape; G1-CI no workflow sets RELAY_KEK; Task 7 `consumeForSession(fixtureId: string | null)`;
Task 10 cost estimate (Fly preset incl. 2GB/CPU, lhr ×1.134615385), poll decrypt, `egress_bytes` null,
`created_by = userId ?? orgId`, fill_replay no-op when fixtureId null; flyway no outOfOrder (R1 before
`feat/chess-lichess-external-play` ⇒ that branch renumbers V405–V407).

<!-- /R1 EXECUTION STATE -->

**Read this first.** It says what exists, what is decided, and the next
action in order.

**Implementation HAS started, and TWO waves have MERGED.** T1 shipped as
**PR #752** (merge `1d1f34d69`) and W1 as **PR #761** (merge `0dc6fe1b9`,
2026-09-10), both from branch `feat/stream-overlay`. The programme carries
production and test code under `apps/web`, and `db/` is no longer untouched —
`V401__fixture_stream_url.sql` and `V402__streaming_entitlements.sql` are on
`main`. Anything below that says "no code exists", "docs only", "no migration
exists yet", or names #752 as an OPEN pull request describes the tree before
2026-09-10 and is marked where it survives as a prior record.

Last updated: **2026-09-14 (later)**, by the R1 plan session:
**R1 is READY TO START in a new session. Nothing is built yet.** The plan is
`../../plans/2026-09-13-streaming-r1.md`, amended the same day to capture every fact the relay
produces. Every recommendation the plan carried is now ruled; see `_INDEX.md`'s three 2026-09-14
sections: "R1's plan WRITTEN", "where the relay runs, and in what language", and "capture all
data".

**To start R1, in a fresh session:**

1. Read, in order: this file's block; `_INDEX.md`'s three 2026-09-14 sections;
   `docs/superpowers/RULES.md` (both owner checklists); `_RULES.md` beside this file; then the plan.
2. Execute the plan with `superpowers:subagent-driven-development`: `model: opus` on every dispatch,
   a reviewer after every lane, and the orchestrator re-running the gate at each lane boundary.
3. **Task 0 first**, alone:
   - cut `.claude/worktrees/relay` (branch `feat/stream-relay`) from current `main`;
   - stand up env label `rly` with the `seazn-local-env` skill;
   - re-pin every line reference — `main` moved past the plan's pin (#782, #784);
   - take the baseline;
   - put the two open data decisions (personal data in telemetry, telemetry retention) to the
     owner before Task 1 writes the migration.

**Already in place:** the Cloudflare token and account, Stripe sandbox keys, `AUTH_SECRET`, and
`RELAY_KEK` (both `.env.local` files, generated 2026-09-14).

**Owed by the owner, each before the step that needs it:**
- the Fly API token (Task 5A's live test);
- the Sentry DSN (Task 17);
- the daily relay-sweep workflow in `onryde/seazn.club.workflow`;
- `RELAY_KEK` as a Fly secret on staging and production;
- optionally, an unlisted YouTube key;
- cleared GitHub Actions billing — every job on `main` failed unstarted on 2026-09-14, and PR-R1's
  `ci.yml` needs it.

**Merge path:** a PR (not a direct push), with `ci.yml` green, e2e dispatched against the PR, a
review, and the owner's per-screen sign-off. R2's plan follows PR-R1's merge; R3 lives in the
capture repo.


**Lane B progress, 2026-09-28.** **Task 7 is CLOSED and committed** — `f02816779` (the ledger usecases,
5 files, +884) plus `353e78f3e` (fix round 2, test-only, +44). Verdict Approved-with-minors, **0 Critical**.
The last fix closed a MONEY regression that two review rounds and eighteen tests had missed: the staff
prior-row comparison and the purchase read-back both compare a stored lower-case org id, and comparing
either against the RAW argument turns an org's own replay (a hand-typed `/admin/orgs/<ID>` URL) into a 409
`idempotency_key_reused` — whose documented panel response is to drop the key and retry, which mints a new
key and grants a SECOND time. The orchestrator re-applied both mutants itself rather than taking the
implementer's word; each kills exactly the one test named for it.

**Task 7A is SPLIT in two.** Its plan section is 1820 lines and 20 steps ending in a browser walkthrough
with six screenshots; one dispatch would blow its budget and would review the money half alongside pixels.
**7A-i** (dispatched 2026-09-28) is Steps 1-9 — the read usecase, the admin write route, both tests — plus
the four carries the Task 7 re-review routed here: `note` validated at the WRITER (not only in the route's
zod) against an exported length bound, the zod IMPORTING `STAFF_CREDIT_MAX` rather than typing 50, the
audit/ledger atomicity probe (the `created_by` no-FK vs `actor_id` FK asymmetry makes a real 23503 without
a mock), and `recordPurchase`'s codeless 422. M1 — the replay branch echoes the CURRENT balance, not the
original row's `balance_after` — is carried into the route's response CONTRACT rather than changed, because
the panel is what echoes it. **7A-ii** is Steps 10-20 (the Option B panel, its component test, the
walkthrough, the mount, the six screenshots, the smoke wiring) and reads 7A-i's report first.

**OWNER RULING 2026-09-28 — the admin panel gets NO polish.** Owner's words: *"Admin panel doesn't need
fancy look or cosmetic changes."* Said while Task 7A-ii was in flight and relayed to it as a scope
NARROWING. It confirms AGENTS.md's functional bar for `/admin` rather than changing it: copy the donor
`admin-credits-panel.tsx`'s classes and shape, decide nothing aesthetic, add no polish the donor lacks, and
do not improve the surrounding admin page in passing. **The six screenshots stay** — they are a LAYOUT gate
(a modal that never opened, a control that never rendered, horizontal scroll at 320), not a design review,
and the standing "verify visually, always" rule is unaffected. Every other surface in this programme keeps
full polish; this exemption is `/admin` only.

**OWNER ANSWERS 2026-09-28 (owner's words in quotes).** Put as a numbered list; answers arrived as
"1 Ok, 2 ok ... 6 Yes".
- **(1) Deviation (f) ACCEPTED as built** — after a 409 the modal resets to its opening state and the
  action returns to `grant`; a staff member mid-refund re-picks it. The implementer recommended
  preserving `kind`; the owner did not take that. **Closed — do not re-raise, and do not "fix" it.**
- **(2) The ledger rail stays at the latest 20 with NO pager**, stated in the copy ("Latest 20 ledger
  entries"). An org past 20 adjustments reads its older rows from the Adjustments log, not this panel.
- **(6) The S1-S10 test-strategy rules DO carry to R2 and R3**, not just R1.
- **(3) device app, (4) revocation, (5) broadcast visibility: the owner asked for the best option
  rather than ruling.** Recommendations on file, NOT yet ruled: (3) the PWA stand-in for the pilot,
  with the browser-WHIP-to-Cloudflare ingest path flagged as UNVERIFIED (R0 killed browser-as-
  COMPOSITOR, which is a different claim) and a third-party RTMP app as the zero-cost fallback;
  (4) a device-status check on the heartbeat and on every mutating request, giving ~20 s worst-case
  revocation without refresh-token plumbing, in place of the 5 h 30 m token life; (5) UNLISTED by
  default with a per-competition switch to public — the argument is safeguarding, not reach, since an
  accidental public broadcast of a junior event cannot be taken back and YouTube's copy outlives ours.
- **`RELAY_KEK` as a Fly secret: DONE** (owner). Struck from the owed list.
- **Sentry DSN — the owner believes it is in `.env.local`; it is NOT.** Key-name check 2026-09-28 (names
  only, never values): neither the root nor `apps/web/.env.local` contains ANY Sentry key.
  `.env.example` declares `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
  and the code reads `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`. Most likely it is set in the deploy
  environment only, which may well be all Task 17 needs — but a local run has no DSN, so do not build a
  step that assumes one without checking.
- **Google OAuth: ask for the YouTube scope SEPARATELY, not at login** (owner's direction). Incremental
  authorization — login keeps `openid email profile`, and "Connect YouTube" triggers its own consent for
  only the orgs that use it. **This does NOT avoid Google's verification**: review is per OAuth client
  and per requested scope, so asking later still asks. What it buys is that the unverified-app warning
  and the user cap hit only the connect flow. To insulate login completely, a SEPARATE Cloud project and
  client for the YouTube integration is the clean move, at the cost of a second brand review and its own
  quota. Either way the submission is the long pole and should start when the wave is scheduled.

**OWNER RULINGS 2026-09-28 (second round) — (3), (4) and (5) now RULED; the Sentry question CLOSED.**

- **Sentry DSN: it IS configured, in the Fly deploy config, and the earlier "not present" note was
  looking in the wrong place.** Verified by key name 2026-09-28 (names only, never values):
  `NEXT_PUBLIC_SENTRY_DSN` is set in **`fly.stg.toml:16`** and **`fly.toml:19`**, baked at BUILD time
  through the Dockerfile (`ARG`/`ENV NEXT_PUBLIC_SENTRY_DSN`, :31/:39) — which is the correct shape,
  since a `NEXT_PUBLIC_*` value is compiled into the bundle and cannot be injected at runtime.
  `SENTRY_AUTH_TOKEN` is deliberately kept OUT of both toml files and passed as a build secret by
  `.github/workflows/stg.yml:167` and `prod.yml:170`, with `SENTRY_ORG` / `SENTRY_PROJECT` as build
  args for the source-map upload. A local `.env.local` has no Sentry key and is not supposed to.
  **Nothing is owed by the owner for Task 17** — strike it from the owed list.
- **(3) The device app is PLANNED WITH the wave, not decided ahead of it** (owner: "we need to plan
  along with the wave so that we can know the limitations and issues"). So do NOT pre-commit to the PWA
  stand-in or to waiting for R3's native capture app. The wave's own scout/spike answers it, and the
  question it must answer first is the one flagged as unverified: whether a browser can push ingest to
  Cloudflare Stream (WHIP) and hold frame timing. R0 killed browser-as-COMPOSITOR, which is a different
  claim and must not be cited as if it settled this one. The fallback that costs nothing either way is a
  third-party RTMP app pointed at the key we already mint.
- **(4) RULED: revocation is a device-status check on the heartbeat AND on every mutating request.**
  ~20 s worst-case revocation, no refresh-token plumbing. The 5 h 30 m token life stops being the only
  thing standing between a revoked device and the ingest.
- **(5) RULED: broadcasts default to PUBLIC, and the org can change it.** The per-competition switch is
  still owed as a control; the DEFAULT is public. (The recommendation on file argued for unlisted on
  safeguarding grounds; the owner took public with an org-level override. Recorded so the recommendation
  is not re-run as if it were open.)
- **YouTube OAuth: ONE client credential, and the brand is already verified** (owner). So the earlier
  suggestion of a SEPARATE Cloud project and client is **withdrawn** — it was contingent on protecting an
  unverified login flow, which does not apply. **One caveat to check against Google's CURRENT docs before
  the wave commits, not to take from this file:** brand verification and SENSITIVE-SCOPE review are
  believed to be separate gates, so adding `.../auth/youtube` may still trigger a scope review even
  though the brand passed. If it does, it hits only the "Connect YouTube" consent, never login, because
  the scope is requested incrementally rather than at sign-in. Verify before planning around it.

**OWNER RULING 2026-09-28 — `/admin` is DESKTOP-ONLY and exempt from the mobile bar.** Owner's words:
*"we don't need to worry about /admin mobile responsive design, admin always view in desktop."* This
goes further than the no-polish ruling earlier the same day and replaces the width half of the standing
UI rule for `/admin` alone; `AGENTS.md`'s bullet was amended to say so. Consequences:
- An `/admin` change is signed off at **1280 only** — no 320, no 768, no phone-width captures.
- **The `/admin` page overflow at 320 (44px) and 360 (4px) is CLOSED as a non-issue**, not deferred. It
  is `app/admin/layout.tsx:31-37`'s staff identity spans, it predates every branch in this programme, and
  the panel was measured to contribute nothing (mounted vs removed identical at five widths). Do not fix
  it, do not work around it, and do not re-raise it as a finding.
- Task 7A-ii's fix round was narrowed mid-flight: the 320 and 768 captures are no longer owed, only the
  1280 pair and the flow shot if the markup moved.
- **Every other surface keeps the full bar** — mobile-first, 1280 / 320 / 768, no horizontal scroll. The
  exemption is `/admin` and nothing else.
- Guard against the obvious over-application: a test that proves real behaviour is NOT deleted merely
  because it happens to run at a narrow width.

**LANE B REVIEW 2026-09-28 — Needs fixes, 0 Critical, 4 Important, 6 Minor.**
`.superpowers/sdd/2026-09-13-streaming-r1/lane-b-review.md`. The reviewer's own words on the money core:
it found nothing that moves credits twice, loses their trail, refuses a legitimate movement or crosses an
org. **All four Importants are in Task 8's `billing-events.ts` branch — the one file no earlier review in
this lane covered**, which is the lesson: a per-task review pass leaves whatever sits between the tasks
unread, and the whole-lane pass is not optional.

- **I4 (the one that would have shipped)** — three surfaces with NO mutant, all measured SURVIVING:
  `link.paymentIntentId` → null (35/35), deleting `linkStripeCustomer` + `pinBillingCurrency` (10/10),
  and deleting the arm's trailing `return;` (10/10, NOT equivalent).
- **I2** — paid-but-ungranted logs and alerts nobody; the file's own convention (`:267`, `:418`, `:531`)
  sends a `STAFF_ALERT_EMAIL` beside the `log.error`. A customer has paid and holds no credits.
- **I3** — the producer/consumer metadata seam is a hand-typed literal on BOTH ends; a fixture on both
  ends proves the fixture.
- **I1** — `async_payment_succeeded` (`:2456`) dispatches `registration_group` only, so a delayed
  notification method would take the money and never grant.
- **M6, ruled fix-now rather than owner-deferred** — `no_payment_required` is dropped with no log while
  promo codes are ON, so a 100% promo session pays zero, completes legitimately, and grants nothing.

**Two judgements the review SETTLED, recorded so they are not re-opened:** keying `recordPurchase` on
`session.id` rather than `payment_intent ?? session.id` is CORRECT here — `payment_intent` is null on a
zero-amount session and `return_url` carries `{CHECKOUT_SESSION_ID}`, so a reconcile path can key on
nothing else. And Task 8's `m34` equivalence is accepted; the guard it depends on was re-run and kills.

**M9 — the buyer-facing half of Task 8 is INERT, not rendered.** `/api/billing/relay-checkout`,
`fetchRelayCheckoutClientSecret` and the tile fields of `STREAM_CREDIT_PACKS` have no production consumer;
**the Phone tab wires them — that is Task 14, LANE D (corrected 2026-09-29; this line said "lane C", and lane C = Tasks 9–12 has no UI)**, and until it does, no real purchase can reach the webhook branch. Anything
in this file or in a header comment that says those tiles "render" is a FORWARD CLAIM, not present fact.

**Routed to lane C:** M7 (`stream_credits.stripe_event_id` holds a `cs_…`, so the column name understates
what it holds) and M9's wiring. **Owner notes:** M10 — staff adjustments are capped at 1..50 per action
with no aggregate cap or rate limit; and the `charge.refunded` clawback gap already recorded.

**Not yet confirmed by anyone:** the reviewer ran only the nine lane suites, so NONE of the three
environmental red families was re-confirmed by it. That confirmation is still owed at the gate, along with
smoke, which has not run since `a87929516`. Playwright was not run by the review either — every e2e-killed
guard (key lifetime, the 409 reset, double-submit, the seven widths, the linked-refund proof) is on the
record rather than witnessed by this pass.

**OWNER RULING 2026-09-28 — a refunded card payment DOES claw back match credits, capped at the balance.**
Asked as the last open lane-B money question ("if we refund then deduct the credit as well?"); the owner took
the recommendation whole ("Ok, add the new scope then?"). The rule, and the reasoning that is NOT derivable
from the code:

- On a **full** refund of a pack charge, revoke `min(creditsPurchased, currentBalance)` — never the full pack
  unconditionally. A SPENT match credit means the stream already broadcast and Cloudflare already billed us
  for those minutes; we cannot un-deliver it, and driving the balance negative would block the org's NEXT
  stream, which they may have paid for separately. V410's non-negative CHECK forbids it anyway, so an uncapped
  revoke would throw inside the webhook rather than record anything.
- When the claw-back is SHORT of the pack (i.e. they spent some), **alert staff**. "Bought a pack, streamed,
  then asked for the money back" is the refund-abuse signature. The webhook records and alerts; a human
  decides whether to chase. The webhook never judges.
- A **partial** refund claws back NOTHING and alerts only. The fair proportion is a judgement call, and the AI
  pack path already gates on `charge.refunded` (full refunds only) — same gate here, same reason.
- A **lost dispute** claws back on the same terms and **shares its idempotency key with the refund path**, so a
  dispute that follows a refund cannot double-claw. This is the `pass_refund:${intent}` pattern, not a new one.
- A refunded charge with no `purchase` ledger row logs and alerts, writes nothing — the ungranted-pack branch
  of `handlePackChargeRefunded`, mirrored.
- The ledger row's reason is **`revoke`**, never `refund`. In `org_stream_credits`, `refund` means ADD credits
  BACK (the staff remedy for a stream that failed); a card claw-back moves the other way. V410 is merged and
  its `reason in (…)` CHECK is not amendable, so `revoke` is both the correct direction and the only available
  value. The note names the charge.
- **Stripe does NOT copy `payment_intent_data.metadata` onto the Charge**, so `charge.metadata` is `{}` for a
  Checkout-created pack charge. The gate MUST match `charge.payment_intent` against the stored purchase row.
  Reading `charge.metadata` as the gate returns early on every real refund — it bit the AI pack path once and
  `handlePackChargeRefunded`'s own comment records it.

Scope is lane B's tail, not lane C's: the money half belongs to this lane. Built now rather than parked
because a refund path written AFTER real money exists is a refund path written under pressure — today nothing
can buy a pack, so the arm cannot fire and the cost of getting it wrong is zero.

**LANE C OPENED 2026-09-28, session `rl-lanec`** (owner started it; lanes A and B are both on `main`, which is
`e0f2834b7`). Tasks 9 → 12, sequential. What lane B handed it, by message rather than by file, because
`.superpowers/` is gitignored: `lane-b-carries.md`'s four inert Task 10 call sites, M7 and M9, this block's
four owner rulings, and the plan path note at `:6330` (Tasks 9–12's step commands all name
`.claude/worktrees/relay/`, which no longer exists).

**A false premise found the same day: the plan's `V419__stream_target_one_active.sql` for Task 10 is already
taken.** `V419__discovery_excludes_drafts.sql` is in the tree; the all-refs scan additionally still shows the
live **V417 collision** (`V417__division_results_skip_rest_byes.sql` beside the tree's
`V417__device_link_sealed_secret.sql`). Task 10's forward delta is V420 at the earliest and must be re-derived
from the HIGHER of the two tails on the day it is written — the plan's own Step 0 warns about exactly this and
has itself gone stale by one.

Concurrency with this lane: the claw-back PR ADDS an export to `stream-credits.ts` and edits `billing-events.ts`
and `lib/email.ts`. Task 9's file set and Task 10's creations are disjoint from all three, and Task 10 only
IMPORTS from `stream-credits.ts` — an added export beside an import does not conflict. An actual EDIT to
`stream-credits.ts` from lane C has to be sequenced.

## LANE C — CLOSING 2026-09-29 (session `rl-lanec`). PR #902, branch `feat/stream-relay-c`, base `64e009f2d`.

Tasks 9–12 built, each task-reviewed to approval, then one minors sweep (`565ea41b9..866f14e74`). Overriding
authority for every lane C brief: `.superpowers/sdd/2026-09-13-streaming-r1/authorities/laneC-amendments.md`
(A1–A23, gitignored — copy it across with the ledger before lane D). Migrations **V421**
`stream_target_one_active` (+ keyed `dest_fingerprint`) and **V422** `stream_runner_gone_confirmed`; main's tail
was V420 on the day.

**Owner rulings in this lane, not derivable from the code:**
- **ENV_NAME (`stg`/`prod`) is the environment identity.** Every Machine is tagged with it at create; the daily
  sweep destroys ONLY Machines carrying this environment's tag, and deletes ONLY Cloudflare videos traceable to
  an input this DB owns (positive ownership — house teardown rule). Live mode refuses an unset `FLY_RELAY_APP` /
  `ENV_NAME`, or the old shared default `seazn-relay`.
- **Both are Fly SECRETS, never in `fly.toml`/`fly.stg.toml`** (owner correction; tomls deliberately untouched).
- Cloudflare env names are **`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_STREAM_TOKEN`** (the `CF_*` pair in older
  docs was read by nothing; `.env.example` + README fixed, historical docs untouched).
- **Destinations are an ALLOWLIST** (`lib/stream-destinations.ts`, G2(a)): rtmp/rtmps to YouTube, Facebook,
  Twitch, Kick, Vimeo, Restream, Cloudflare Stream. **LinkedIn is NOT supported** — its AMS ingest host is
  NXDOMAIN; add it only from a real, current LinkedIn Live URL. Same destination saved twice = same target (G1
  fingerprint).
- A13: >1000 Cloudflare videos = flag + warn counter, NOT paging (cursor param unmeasured).
- A23: the usecase layer is provider-neutral (no `runner-fly`/`fly-client` import under usecases/ or
  relay/domain/, guarded by a test) — a GCP runner is a new adapter, not a rewrite. The shared adapter
  conformance suite is DEFERRED until a second adapter exists.

**Orchestrator rulings the owner may override:** a same-fixture restart inside the 24 h reuse window is FREE even
at 0 credits (spec §5.2 "a restart after a failure is the same match"); API-key callers stay refused on
stream-session create (NEVER_KEY_ROUTES); a Machine left by a FINISHED fixture on the same destination is
destroyed on the next admission rather than refused (it is an orphan by the sweep's own rule).

**Runbook rule (clone exposure, not closed in code):** never copy `RELAY_KEK`, `FLY_API_TOKEN` or
`CLOUDFLARE_STREAM_TOKEN` into an environment built from a cloned database — a clone's rows name live Machines
and inputs, and with those secrets its sweep would act on them.

**OWNER ACTIONS before any composed / live run:** `fly apps create seazn-relay-stg` and `seazn-relay-prod`; a
per-app deploy token as `FLY_API_TOKEN` on each web app; Fly secrets `ENV_NAME` + `FLY_RELAY_APP` per
environment; the `CLOUDFLARE_*` pair; the sweep's daily schedule in `onryde/seazn.club.workflow` (#757 — no
workflow is added in this repo).

**Carried to lane D:** M9 (the buyer-facing credits tiles + `/api/billing/relay-checkout` stay INERT until the
Phone tab, Task 14) and M7 (`stream_credits.stripe_event_id` holds a `cs_…`; V410 is merged, so a comment or a
forward rename, not an amend); the Phone tab must call `apiV1(...)`, not `api(...)` (the v1 routes 404 otherwise);
the first real sandbox pack purchase end to end. Parked minors: Task 12 n6 (`ended_at` age gate on the
two-listing mark — a 180 s gate reds 6 tests), a Stop tapped on an already-finished session is not audited,
interior whitespace in a stream key is not refused (edges are trimmed).

**Test-DB trap found:** an early Task 12 mutant run (before `dbb209e11`) dated ~14k events of OTHER suites to
1996 in `seazn_rlc`. Run sweep mutants that widen `inScope` on a throwaway DB only.

## Environment (label `rly`, stood up 2026-09-14 from `.claude/worktrees/relay` @ `453d95cd6`)

- `DATABASE_URL=postgresql://postgres@127.0.0.1:54484/seazn_rly` `DATABASE_SSL=disable`
- `SMOKE_BASE=http://localhost:3372` = `PLAYWRIGHT_BASE`; `E2E_PROD_TARGET=1`; `RELAY_DRIVERS=fake` on
  the server once the relay code exists. The port is the label's snapshot — re-read
  `seazn-env env --label rly` after every `rebuild`.
- Placement service up for `rly` on `:50257` (native). `PLACEMENT_SERVICE_HOST` reaches the test
  process only through `seazn-env env`, so gate scripts load that env inside the script and never
  echo the secret.
- `show data_directory` → `/tmp/seazn-env/rly/pg` (contains `rly`; the script also printed "data_directory verified").
- Deltas tail on this branch at Task 0: `V403__realtime_fixture_broadcast_policy.sql`; all-refs `V4*`
  tail: the same `V403`. Task 0 therefore reserved V404 — **superseded 2026-09-16, see FT0-1**:
  main landed V404 and an unmerged branch claims V405–V407, so **R1's migration was V408** — SUPERSEDED, it is **V410** since the 2026-09-20 rebase,
  recorded AS LANDED in `_INDEX.md`.
- **Baseline — CURRENT FLOOR (re-taken 2026-09-16 @ `b4091834d`, after rebasing onto the spectator hub
  merge; `rly` recreated from scratch — `/tmp/seazn-env/rly` had been wiped):** fresh DB, placement up
  (:50257), `apps/web` full run: **passed 17778 / total 17856 / failed 1 / pending 77** — 1312 files,
  `outside-worktree 0`, runner `EXIT=1`. The one red is ENVIRONMENTAL, proven by re-run:
  `lib/__tests__/credits-bootstrap-grant.test.ts` › "the daily cron run in the same calendar month is a
  no-op…" hit `duration 30005` (the skill's wallet-volume/load timeout signature) at load avg ~130;
  re-run alone on the same DB → `2 0 0`, that test 2.6 s at load 210. **Effective floor: 17856 total,
  0 real failures.** JSON (durable, gitignored):
  `.superpowers/sdd/2026-09-13-streaming-r1/authorities/baseline-2026-09-16/baseline-web.json` + `rerun-credits-bootstrap.json`.
  Compare gates by total and by red-file roster, never by a bare `failed` integer.
- (SUPERSEDED) Baseline at `453d95cd6`, 2026-09-14: passed 17064 / total 17141 / failed 0 / pending 77,
  1266 files. Stale since #787 (retire scorer role) and the spectator hub merge.
- Lint `✖ 143 problems (0 errors, 143 warnings)`, `LINT_EXIT=0` (via `rtk proxy`); tsc `EXIT=0`;
  `openapi:gen` + `i18n:gen-keys` porcelain: no generated diff (only the two Task 0 docs).
- `stream-overlay.spec.ts` preflight against `http://localhost:3372`: **25 expected / 0 unexpected /
  0 flaky / 0 skipped**, `PW_EXIT=0`, 120 s. This is the regression witness Task 17 compares
  against. #782's overlay drift left W1's spec green on this tree.
- `FLY_API_TOKEN`: owed by the owner (Task 5A's live test skips loudly until it lands).
- Worktree extras: `.env.local` symlinks (root + `apps/web`), `.claude/agent-memory` → the main
  checkout's (listed in the worktree's own `info/exclude`), `RELAY_KEK` confirmed in both env files
  by length check.
- Recreate: `POSTHOG_KEY= NEXT_PUBLIC_POSTHOG_KEY= ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label rly --server`
  from the worktree; `rebuild --label rly` after every code change; `down --label rly` at wave close.

## R1 Task 0 pins (2026-09-14 @ `453d95cd6`; RE-PINNED 2026-09-16 @ `814edc34e`)

Worktree `.claude/worktrees/relay`, branch `feat/stream-relay`, cut from `origin/main` @
`453d95cd6`. Line numbers are SNAPSHOTS; every brief cites the SYMBOL. **The plan carries no
`file:line` cites of its own** (a raw `grep -o` for `<file>.<ext>:<n>` over the plan returns 0),
so this symbol table IS the re-pin. Every one of the 26 symbol probes in Task 0 Step 6 HIT.

| Symbol | Seen at |
|---|---|
| `requireResourceAuth` / `requireOrgAuth` | `server/api-v1/auth.ts:352` / `:210` |
| `ROUTES` | `server/api-v1/openapi.ts:67` |
| `NEVER_KEY_ROUTES` | `server/api-v1/key-scopes.ts:301` |
| `reply` / `v1` / `parseBody` | `server/api-v1/http.ts:96` / `:124` / `:252` |
| `handler` | `lib/http.ts:69` |
| `hasFeature` / `requireFeature` | `lib/entitlements.ts:456` / `:668` |
| `UpgradeGate` | `components/upgrade-gate.tsx:252` |
| `setFixtureStreamUrl` | `server/usecases/fixtures.ts:201` |
| `streamUrlSchema` | `lib/stream-url.ts:61` |
| `Tx` / `withTenant` / `sql` | `lib/db.ts:5` / `:183` / `:221` |
| `log` | `server/logger.ts:24` |
| `getStripe` | `lib/stripe.ts:5` |
| `requireBillingOwner` | `server/usecases/billing-manage.ts:174` |
| `credit_pack` branch / `processStripeEvent` / `runEvent` / `sweepStuckEvents` | `server/usecases/billing-events.ts:151` / `:2080` / `:2259` / `:2318` |
| `buildCreditPackCheckoutParams` / `createCreditPackCheckout` | `lib/credit-packs.ts:62` / `:156` (`ui_mode: "embedded_page"` `:76`, `return_url` `:113`, 30 s idempotency key `:179`) |
| `balance` | `lib/credits.ts:94` |
| `mintPublicFixtureToken` | `lib/realtime.ts:224` |
| `CREDIT_PACKS` / `StreamPanelContext` / `relayEntitled` / `stream-tab-phone` / `stream-phone-gate` | `components/v2/fixture-stream-panel.tsx:98` / `:136` / `:141` / `:366` / `:519` |
| `const [streamOpen` | `components/v2/desk/run-sheet-row.tsx:162` |
| `SEED_KINDS` / `SEED_PARAMS` | `e2e/visual/manifest.ts:17` / `:19` |
| `expectNoHorizontalScroll` / `mintLoginPathBySql` / `setBoolEntitlementOverrideSql` / `seedRosteredFixture` | `e2e/helpers.ts:49` / `:274` / `:660` / `:1867` |
| `WALKTHROUGH_SPECS` | `lib/__tests__/e2e-ci-wiring.test.ts:159` |
| `releaseBoth` / `bothStarted` | `server/usecases/__tests__/registration-concurrency.test.ts:481-487` |
| `NEXT_PUBLIC_SENTRY_DSN` (commented) | `fly.toml:11` |
| `jose` / `qrcode` / `@types/qrcode` | `apps/web/package.json:37` / `:47` / `:69` |
| embedded-Checkout donors | `components/buy-credits.tsx:24` (`BuyCredits`; `EmbeddedCheckoutProvider` `:82`); `lib/billing-checkout-client.ts:42` (`orgScopeHeaders()`); `app/api/billing/credit-pack-checkout/route.ts:29` (`POST`, `{ client_secret }` `:57`) |
| Stripe frame idiom | `e2e/walkthrough/event-pass.spec.ts:339` (`frameLocator('iframe[src*="stripe.com"]')`) |
| admin overrides editor | `app/admin/orgs/[id]/page.tsx`; `app/api/admin/orgs/[id]/entitlement-override/route.ts:17` (`POST`) / `:53` (`DELETE`) |
| cron pair idiom | `app/api/cron/registrations/route.ts:15` (503) / `:17` (401) |
| P21 division gate | `run-sheet-row.tsx:386` `showStream`; `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:259` `editable`, `:424` `streamOffered`, `:426` `hasFeature(… "streaming.overlay" …)`, `:431` `"streaming.relay"` |
| P14 panel gate | `fixture-stream-panel.tsx:524` `<UpgradeGate feature="streaming.relay" …>`; `en/ui.json:5084` first `"stream.` key |

Negatives, all as expected: no `.github/workflows/relay-sweep.yml`; no `docs/contracts/`; no
`apps/web/src/server/relay/`; `stream-phone-tab` 0 hits (P13, and the live testid is
`stream-tab-phone`, 6 hits); `STREAM_POLL_MS` 0 hits repo-wide (watch 4 FALSE — Task 13 defines
it). **Path corrected 2026-09-16:** the old negative named `POLL_MS` in
`components/v2/live-score.tsx`, which does not exist — the file is
`components/public-site/live-score.tsx` (also 0 `POLL_MS` hits, so the conclusion survives, but
as written the probe was vacuous). The only `*POLL_MS` constants in the tree are `LIVE_POLL_MS`
and `QUIET_POLL_MS` at `components/v2/desk/band-poll.ts:20` / `:25`.

**Re-pin 2026-09-16 @ `814edc34e`** (full report: `authorities/repin-2026-09-16.md` in the
gitignored SDD ledger). 66 rows re-taken against current `main`: **SAME 63, MOVED 3, RENAMED 0,
GONE 0, SPLIT 0.** The three moves are folded into the table above — `requireResourceAuth`
362→352, `seedRosteredFixture` 1860→1867, first `"stream.` key 5083→5084; both code moves were
confirmed by opening the file at the new line, not by grep alone. #787 (scorer retirement)
reshaped `server/usecases/scorers.ts`, `stages.ts`, `api-v1/schemas.ts` and the members role
route but touched no pinned symbol; `api-v1/**`, the panel, `run-sheet-row.tsx` and the division
gate are byte-stable at their pinned lines. Three counted facts, all confirming the FT rows:
`ui.stream.*` = **31** keys (`en/ui.json:5084-5114`; locales are `en`/`es`/`fr`/`nl`, no `de`);
the migration tails disagree as FT0-1 says (tree V404, all-refs V407) so R1 took V408 — **now V410** (2026-09-20 rebase, main landed V409);
`SUPABASE_JWT_SECRET` in production code = **5 hits, all in `lib/realtime.ts`** (117, 136 doc
comments; 194, 197, 207), so FT0-2's rewritten probe is clean.

**Drift since the plan's pin `54a125d9f`** (#782 `9a7393cf4`, #783 `198a4a130`, #784). None of
the panel, `run-sheet-row.tsx`, `e2e/helpers.ts`, `e2e/visual/manifest.ts`, `billing-events.ts`,
`credit-packs.ts` or `server/api-v1/**` changed. What did, and what it does to the plan:

- **FT0-1 — the migration tail is `V403__realtime_fixture_broadcast_policy.sql`, not V402.** It
  was ADDED by #782 itself, so the plan's "unchanged at `9a7393cf4`" is false. At Task 0 the
  all-refs scan showed nothing past V403, so Task 0 reserved V404.
  **Re-checked 2026-09-16: R1's migration was `V408`. SUPERSEDED 2026-09-20 — it is `V410`.** `origin/main` is now
  `ea5b7027a`, four commits ahead of this branch, and landed `V404__retire_scorer_role.sql`
  (#787). `V405__lichess_external_play.sql`, `V406__lichess_challenge_identity.sql` and
  `V407__lichess_lobby_ready.sql` are CLAIMED on the unmerged
  `origin/feat/chess-lichess-external-play` — absent from this tree, and taken all the same.
  So after a rebase the two commands disagree (tree tail V404, all-refs tail V407); that is
  the normal case and the higher one wins. A duplicate Flyway version survives a clean rebase, so the
  number is fixed BEFORE rebasing, never after. Re-read `ls db/migration/deltas | sort -V | tail -1`
  AND the all-refs `git log --all --diff-filter=A -- 'db/migration/deltas/V4*'` when Task 1 starts:
  that pair, not this line, is the authority — main moves under long waves.
- **FT0-2 — the plan's P3 review grep reds on a clean tree.** `grep -a -rn "SUPABASE_JWT_SECRET"
  apps/web/src --include=*.ts | grep -v "lib/realtime.ts"` prints 8 lines, all in
  `lib/__tests__/realtime-publish.test.ts` (added by #782). Task 6's own `tokens.test.ts` will
  add more by design. The review probe becomes: exclude `__tests__` directories, and fail on any
  hit in production code. (Also quote `--include='*.ts'`: zsh aborts on the bare glob with "no
  matches found".)
- **FT0-3 — `lib/realtime.ts` now exports FOUR functions** (`resolveRealtimeMintKey` added by
  #782: an ES256/RS256 private key preferred, `SUPABASE_JWT_SECRET` only as the HS256 fallback).
  P2 still holds — none of the four is a producer mint. Task 6's G1 witness (same claims signed
  with `SUPABASE_JWT_SECRET` → 401) is still valid, because relay tokens verify on `AUTH_SECRET`
  only.
- **FT0-4 — `ui.stream.*` has 31 keys, not 33.** #782 removed `stream.tab.slate` and
  `stream.preview.slate` (the two surviving mentions are string probes in
  `overlay-dict-coverage.test.ts`). P15 reads "extends the 31 existing keys".
- **FT0-5 — P6's e2e replay witness is VACUOUS as written.** `sweepStuckEvents` selects only
  `processed_at is null and received_at < now() - 10 minutes` (`billing-events.ts:2324-2330`), so
  a purchase the webhook already processed is never selected. "Drive `POST
  /api/cron/billing-events`, assert the balance is unchanged" stays green with the
  `stripe_event_id` dedupe deleted. The replay must go through the real claim instead:
  `runEvent(sameEvent)` → `false`, or `replayEvent` → `"already_processed"`, plus a direct
  second call of the webhook branch asserting one ledger row. Owed to Tasks 8 and 15.
- **FT0-6 — `R0-CORRECTIONS-FOR-R1.md` was not in the repo.** The plan names it as the overriding
  authority (6 references), but it existed only in the plan session's `/tmp` scratchpad. It is now
  committed beside this file.

**Owner data rulings at Task 0 (2026-09-14), folded into Task 1's migration (V408, now V410 — see FT0-1):**
- **Telemetry retention — "2 is ok":** `fixture_stream_events` and `stream_provider_calls` kept
  indefinitely; raw `fixture_stream_samples` deleted after 90 days by the daily sweep
  (`SAMPLE_RETENTION_DAYS = 90`); the per-session `sample_summary` kept regardless.
- **Non-personal additions — "all":** (a) app build sha on every event and sample; (b) sport,
  competition, division, scheduled start, venue (via `fixtures.court_id` → `courts.venue_id`,
  null when no court) and org timezone snapshotted on the session; (c) entitlement source at
  admission; (d) recording facts after finalise; (e) QR shown / credentials revealed, first-at and
  count; (f) per-session cost estimate; (g) destination output uid and output error codes; (h)
  Cloudflare ingest edge location. Still never stored: raw IP, user agent, device ids, credentials.
- **Narrowed by a read-only Cloudflare probe, 2026-09-14** (field shapes only, no values; orchestrator
  rulings, each recorded in the SDD ledger with its cost if wrong):
  - **(h) dropped.** `GET /live_inputs/{uid}` returns no colo, location or region field. Its
    `status.current.reason` is captured instead.
  - **(d) narrowed.** A video carries `size`, `duration`, `input.width`, `input.height`,
    `status.state` and `status.errorReasonCode`, but no codec field. Values read -1 or 0 while
    `live-inprogress`, so they are written only after finalise.
  - **(c) narrowed to "granted by override: yes/no" at admission,** read through the existing
    `overrideRow`. The resolver (`resolveFromDb`) returns no source, and in R1 every granted org is
    an override anyway.
  - **(a) reads the image tag.** Fly's docs list `FLY_IMAGE_REF` as a runtime env var, and
    `prod.yml` / `stg.yml` deploy with `--image registry.fly.io/<app>:${{ github.sha }}`, so its
    tag should be the commit sha. `config.ts` takes the tag only when it is 40 hex characters,
    otherwise null (locally, in CI, or for a builder-tagged `deployment-…` image). One staging
    read confirms it.
- **Device GPS — owner wants it ("GPS").** Recommendation, not an owner ruling: it lands in
  **R3**, not R1. In R1 the phone streams straight to Cloudflare and no phone→app call exists, so
  an R1 column would have no writer. **Owed to R3's plan:** GPS from the capture app to our API,
  behind the OS permission prompt and consent copy, plus four owner questions — precision (raw or
  rounded to ~1 km), cadence (once at go-live or a track), retention, and privacy-policy copy.

**P7 — confirmed.** `requireBillingOwner` resolves the org from `x-seazn-org` or the `seazn_org`
cookie, then requires `subscriptions.owner_user_id` = the caller (a group payer, not the org
owner). `requireOrgAuth` is an org-role gate. So the plan's choice holds: the relay-checkout
route uses `requireBillingOwner` AND asserts the resolved `orgId` equals the body's `orgId`.
**P6 — as read.** The webhook route calls `runEvent` synchronously: it claims the row, runs
`processStripeEvent`, then stamps `processed_at`. `sweepStuckEvents` is a retry after 10 minutes,
capped at 3 attempts. So the purchase lands on the webhook; the cron is the fallback, not the
path (and see FT0-5).

Earlier the same day, by the R1 plan session (branch `docs/streaming-r1-plan`): R1's plan was
written, with fourteen owner rulings recorded in `_INDEX.md` "2026-09-14 — R1's plan WRITTEN".

Prior record — last updated **2026-09-12**, by the R0 bench wave (branch `docs/streaming-r0-memo`):
**R0 is CLOSED — its memo is `R0-memo.md` beside this file, and the Cloudflare
gate that blocked three items is cleared.** W1 CLOSED; W2 is next and owes a
task-zero RE-PIN; R1 and R2 are prompts with no plans; R3 is deferred to the
capture repo. **R2's plan is NOT yet writable** *(corrected 2026-09-13; this line first
said the gate was open)*: `R2-compositor.md` gates R2 on the R0 memo **and PR-R1 merged**,
and its plan re-pins on that merged tree — `runner-fly.ts`, the token and session APIs do
not exist yet. **The next writable plan is R1's**, whose gate (PR1 merged, #761) is open.

**Read `R0-memo.md` before planning R2.** It reverses the design of record's
compositor choice (B2, not B3), names the guest size and its price, and records
six false premises in the design itself — including that §7.2's graceful stop
cannot work as written and that the pull path is not LL-HLS.

## 2026-09-10 — where things stand (R2-prep; SUPERSEDES the 2026-09-08 block below)

- **W1 is CLOSED.** Merged 2026-09-10 as **PR #761** — `0dc6fe1b9`, "Merge pull
  request #761 from onryde/feat/stream-overlay" (verified against `origin/main`
  on 2026-09-10). Its close is the pair of `## 2026-09-10 —` sections in
  `_INDEX.md` — the measured gate numbers, FS-W1-8a's clipped footer, the three
  false premises, the two seed traps, and **"W1 closing: what is OWED to the next
  wave"**. That file is the authority for all of it; do not re-derive it here.
- **T1 is DONE and MERGED** as **PR #752** (`1d1f34d69`). The 2026-09-08 block
  below still describes #752 as an open pull request waiting on a
  `workflow_dispatch pr=752` run and a per-screen sign-off. Both are discharged;
  read that block as history.
- **W2 is NEXT, and it owes a task-zero RE-PIN before any step runs** — the rows
  annotated in `W2-moments.md` and in
  `../../plans/2026-09-05-stream-overlay-w2-moments.md`, with
  `match_centre.timeline` to be evaluated as the moments source. The spectator-W1
  gate that blocked it is open (PR #743 merged 2026-09-08); the RE-PIN is not.
- **R0 is CLOSED (2026-09-12, `R0-memo.md`). R1 and R2 are PROMPTS with NO
  PLANS and have not started.** No
  compositor code exists in the tree — no `x11grab`, no `module-null-sink`, no
  `runner-fly.ts`. Plans are still written one wave ahead: R1's gate ("after PR1
  merges") is now OPEN, since PR1 is #761; R2's plan waits on the R0 memo.
- **R3 is DEFERRED to the capture repo** (owner ruling 18: "R3 native apps in
  their own spec in the capture repo"). Its inherited risks **P1–P5** are
  recorded in `_INDEX.md` rather than here, because two of the five constrain
  work in THIS repo: **P5** (a device spike on real handsets) is startable NOW
  and blocks the R3 estimate; **P1** (iOS drops the camera when backgrounded)
  changes what R2's soak should prove.
- **[CLEARED 2026-09-12 — the account and token already existed in `.env.local`;
  R0 ran against them and U1's hold-window question is answered in `R0-memo.md`
  §4a. Kept as the prior record.]** **ONE owner action gates THREE items.** R0,
  R1 and the U1 spike
  (`_OPEN-QUESTIONS.md` Q17) all wait on the same thing: **provisioning a
  Cloudflare account and a Stream-scoped API token.** The code tree references no
  Cloudflare env var at all — `CF_ACCOUNT_ID` and `CF_API_TOKEN` appear only in
  `README.md:164-165` and nowhere under `apps/`, `packages/` or `scripts/`
  (verified 2026-09-10). Nobody can size the guest, provision a live input, or
  answer U1 until that account exists. It is the single highest-leverage
  unblock in the programme.
- **Migration numbers: the RULE still holds and the collision is already real.**
  `main` now ends at `V402__streaming_entitlements.sql`, so design §5.1's `V401`
  and §6.1's `V402` are BOTH taken. Take the next free number after
  `ls db/migration/deltas | sort -V | tail -1`, re-read at every rebase. A
  duplicate Flyway version survives a clean rebase with no conflict.
- **This wave:** **R2-prep**, branch `feat/stream-r2-prep`, opened 2026-09-10 —
  documentation only, folding the 22-row register
  `_FINDINGS-2026-09-10-relay-signal-path.html` into its owning documents before
  R2 starts and the window closes. Brief and fold map:
  `_WAVE-2026-09-10-r2-prep.md`; per-row audit trail in `_INDEX.md`.

## 2026-09-08 — where things stand (read this block, then the tables)

- **Planning is COMPLETE and ON MAIN.** Owner approved the design
  ("approve") and ruled "push to main": merge commit `b2244879f` carried the
  spec, the four wave prompts, the re-pinned W1/W2 prompts and the
  `RULES.md` owner checklist. The T1 plan + W1 amendment (`c8dc4d07f`) and
  the plan review follow in a second merge.
- **Shareable spec page:** https://claude.ai/code/artifact/b7e7d0c8-e254-4d6e-80f0-161681ae797a
  (rebuilt from the spec by `scratchpad/build-spec-page.mjs`; republish
  after any spec change).
- **`main` moved under us on 2026-09-08:** desk W3 (#740) and settings W8
  (#744) merged. Consequences recorded in the spec's findings: FS14 —
  `run-sheet-edit-time` is now `desk/run-sheet-row.tsx:407` (was `:377`;
  the symbol is the authority). ~~Deltas still end at `V399`.~~ **They end at
  `V400__repair_orphaned_age_cutoff_half.sql` as of later that day** — which is
  exactly why this programme now reads the tail instead of writing a number
  down. Do not trust this line either; run the `ls`.
- **2026-09-08 (later) — spectator W1 MERGED (PR #743, `main` 60c0615b0;
  worktree rebased, HEAD `09f5fa1de`+).** Consequences applied (design FS18):
  the live transport already exists at
  `components/public-site/match-centre/use-live-fixture.ts:17` — W1 Task 1 is
  rewritten to widen it IN PLACE (no lift; `LiveScore` wrapper is RETIRED,
  `live-score.tsx` exports only `LiveScoreBody`); the public payload carries
  `match_centre` (with `timeline: TimelineLine[] | null` — NO event `type` on a
  line); **the W2 gate is OPEN** — W2 waits on PR1 and its own task-zero RE-PIN
  (rows annotated in `W2-moments.md` and the W2 plan; `match_centre.timeline`
  to be evaluated as the moments source, F4 unchanged); `run-sheet.tsx`
  mounts re-pinned to `:355/:390/:428/:669`; `WALKTHROUGH_SPECS` now lists the
  two spectator walkthroughs, so W1 Task 8's insertion point moved.
- **Findings since the design was written:** FS10 credits donor is
  `ai_credit_ledger` (V320) + `lib/credits.ts` + `credit-pack-checkout` +
  `billing-events.ts:151`, not size packs; FS11 Stripe events may be applied
  by `api/cron/billing-events`; FS12 landing catalogue rows are FALSE for
  all five plans; FS13 `public_fixtures_v` latest definer is `V369:18`.
- **Plan review:** `_REVIEW-2026-09-08-plans.md` (reviewer pass over the T1
  plan and the amended W1 plan; fixes applied before the second merge).
- **T1 IS DONE (2026-09-08).** All four tasks executed from
  `../../plans/2026-09-07-streaming-t1.md`, on `feat/stream-overlay`, in
  **PR #752**. The commits are the range **`origin/main..feat/stream-overlay`** —
  count them with `git log --oneline origin/main..feat/stream-overlay` rather
  than trusting a number written in a document, because each fix round appends
  one. **Anchor on `origin/main`, never on a merge-base sha**: this line first
  read `0cc4614b8..`, and the 2026-09-08 rebase made `0cc4614b8` an ancestor of
  `origin/main`, so that range then swept the 79 replayed `main` commits too.
  Measured on `9164a926a`: `git rev-list --count 0cc4614b8..feat/stream-overlay`
  → **93**; `git rev-list --count origin/main..feat/stream-overlay` → **12**.
  Owner picks **1A · 2A · 3A · 4A · 5C**
  plus the ink-hairline addendum are in `_THEMES.md`; the full close — gate
  numbers, mutant killer lists, findings, deferred minors — is the
  "## 2026-09-08 — T1 wave CLOSED (PR-T1 #752)" section of `_INDEX.md`, which is
  the authority for all of it. (This bullet replaces the "NEXT ACTION: execute
  the T1 plan" instruction that stood here; Task 4 owned rewriting it and has.)
- **NEXT ACTION:** see "## THE FIRST THING TO DO NEXT SESSION" below. In short:
  PR #752's pre-merge e2e (`workflow_dispatch pr=752`) and the owner's
  per-screen sign-off, then **W1** from
  `../../plans/2026-09-05-stream-overlay-w1.md` (amended). R1's plan is written
  after PR1 merges, R2's after the R0 memo — one wave ahead, never earlier.

## T1 — what shipped, and what it handed forward (2026-09-08)

`_INDEX.md`'s "## 2026-09-08 — T1 wave CLOSED (PR-T1 #752)" is the single
authority for the detail: the commit table, the gate numbers, the mutant killer
lists, the findings and the deferred minors. Repeated here only so a resume
read knows what exists and what is owed.

**Shipped** — `apps/web/src/lib/contrast.ts`,
`apps/web/src/components/overlay/overlay-tokens.ts` and its eleven-sport
contrast sweep, `apps/web/e2e/visual/{manifest.ts,manifest.json,seeds.ts,asserts.ts,capture.spec.ts}`,
`overflowingIn` moved into `apps/web/e2e/helpers.ts`, `visualSeedRoutesSuite` in
`scripts/smoke.ts`, `docs/runbooks/visual-gate.md`, the T1a sections of
`_THEMES.md`, and one production fix (`court-card.tsx`, a `min-w-0` on the
truncate chain). **No migration, no dictionary key, no user-facing string.**

**Gate, on the tree at commit 10 of the range** (`knownDefects honoured one
check and lied about the other four`, the last Task 3 commit — its pre-rebase
sha no longer resolves)**:** full `apps/web` vitest **15543 / 15620 / 4 failed**
against the baseline's **15121 / 15198 / 4** — **+422 tests, delta failed 0**,
and the four reds are the baseline's own environmental placement file. Six PNGs,
all hashes distinct; `mobile.spec.ts` @ mobile-320 **44 / 1 / 0**, the exact
pre-change witness; spectator walkthroughs **19 / 0**; smoke visual-gate 4/4;
`tsc` 0; lint 137 warnings / 0 errors, unchanged from baseline.

**One caveat on the seven-width sweep (271 / 1 / 4):** the single red is
`page smokes: settings save + invoice/plan card render`, a read-modify-write on
the org name against the SHARED Pro org, raced by running seven width projects
against ONE local server and database. It is a **run-method artefact** — CI
matrixes those widths into separate jobs with their own DB — and it is recorded
as one rather than as a pass. Run the widths one project at a time locally.

**Handed forward, and each will be silently dropped if not carried:**

1. **The `--sport-ink` hairline is an e2e obligation on W1.** Two contrast
   findings (football's chip at 2.56, hockey's live dot at 2.75) are closed as
   *covered* rather than waived, and the covering element is a 1-px border that
   **no node-environment test can see**. If W1's e2e does not assert it, both
   closures are unbacked. Named in `W1-step-one.md` acceptance.
2. **`overlay-tokens.ts` owes an e2e and a smoke**, and W1 Task 8's are named as
   its. The module has no HTTP surface until the overlay route exists.
3. **`auth: true` and `seed: "none"` must be named as first-use in W1-E's
   brief** — live harness code no manifest row drives.
4. **Two `main` findings need an owner and a wave:** `standings-table.tsx:58`
   (axe SERIOUS, `scrollable-region-focusable`; the fix owes a new string in
   four locales across three surfaces) and `live-score.tsx:245`, the
   `truncate`-without-`min-w-0` twin of the `court-card.tsx` fix. **The second
   was being carried as "on a retired component" — that is wrong.** The
   `LiveScore` WRAPPER is retired; `LiveScoreBody`, which contains line 245, is
   mounted at `summary-tab.tsx:58` and `match-centre.tsx:90` and its branch
   renders whenever `suppressScorebug` is false — cricket on the Summary tab,
   and the no-document fallback, which passes the prop not at all. What is true
   is only that no manifest row photographs it. See `_INDEX.md` FS-T1h.
5. **An owner question for W2's planning:** `_THEMES.md` §5 scopes
   `dismissal-on-board-2` to the WICKET slab. If W2 widens it to red-card slabs,
   football measures 2.56 on its own band and the carrier accounting must be
   re-derived.

## Environment (label `ovl`, stood up 2026-09-08 from this worktree @ `4ee38278d`)

This block supersedes the "## Environment" and "## Baseline" sections at the
foot of this file — they describe the 2026-09-05 tree and are kept only as the
prior record.

- `DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl`
  `DATABASE_SSL=disable`
- `SMOKE_BASE=http://localhost:3303` = `PLAYWRIGHT_BASE`; `E2E_PROD_TARGET=1`
- `psql "postgresql://postgres@127.0.0.1:54405/seazn_ovl" -tAc "show
  data_directory"` → `/tmp/seazn-env/ovl/pg` (contains `ovl`). Run by hand
  2026-09-08; this is the psql output, not the script's
  `BENCH_EXPECTED_DATA_DIR`. The script separately verified the same value
  against its own datadir ("data_directory verified" in its log) before
  reporting the server ready. This is the check that tells our cluster apart
  from a squatter's — a `pg_ctl` that failed "Address already in use" is
  followed by a `createdb` that SUCCEEDS against another session's server.
- Deltas tail when the env was stood up: `V399__stats_player_career_split.sql`.
  **That number is already stale** — `main` took `V400__repair_orphaned_age_cutoff_half.sql`
  later the same day. T1 adds no migration. **No number is reserved for this
  programme; read the tail yourself** — see the rule under "Where the work
  lives" below.
- Baseline (`apps/web`, full, fresh DB, tree = `origin/main` + this branch @
  `4ee38278d`): **passed 15121 / total 15198 / failed 4 / pending 73** — 1182
  test files, 1 failed; `outside-worktree 0` (every `.testResults[].name`
  resolves under this worktree); runner exit 1. JSON at
  `/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/80298fc7-d342-412c-85bd-3bd1f75ab7f6/scratchpad/t1/baseline-web.json`.
  Red files: `apps/web/src/server/usecases/__tests__/schedule-build-honours-locks.test.ts`
  — all four assertions fail `AssertionError: expected undefined to be
  '2026-08-01T19:00:00.000Z'`. Classification **ENVIRONMENTAL**: the suite needs
  the CP-SAT placement service and `up` was not given `--placement`. Not
  attributable to this branch (which carries no code) and not to `main`.
- Lint `✖ 137 problems (0 errors, 137 warnings)`, `LINT_EXIT=0` — read through
  `rtk proxy pnpm run lint`, since plain `rtk` hides this output entirely; tsc
  `EXIT=0`; `openapi:gen` + `i18n:gen-keys` porcelain: **EMPTY both before and
  after**, so no generator drift on an untouched tree and no finding against
  `main` from that step.
- `mobile.spec.ts` @ mobile-320 before Task 3: **44 passed, 1 skipped, 0 failed**
  (2.2 m), `PW_EXIT=0`. Both `auth.setup.ts` projects passed first, so the
  served build is this tree's. This is the pre-change witness Task 3's helper
  move is judged against.
- Q12 (`pass-scoping-guard.test.ts`): **green on this tree.** The 2026-09-05
  note's "two reds, unclassified" do NOT reproduce; closed as green on
  `4ee38278d`. Nothing to attribute, nothing to fix.
- **`seed:demo` was NOT run** — the env skill lists it as owed by the caller.
  Nothing so far needed it; Task 3's smoke suite may.
- **The 2026-09-07 corpus re-pins are ALREADY LANDED — do not re-pin them.**
  Verified 2026-09-08 (T1 Task 0 Step 8a) on an untouched tree; they were
  committed at `8d31cb34f` / `c8dc4d07f` and their CONTENT is on `main`, so a
  rewrite would stage nothing. **The obvious ancestry check disagrees with the
  word "reached", and that is expected, not a missing merge**: `8d31cb34f` IS an
  ancestor of `origin/main`, `c8dc4d07f` is NOT — it was squash-merged, so
  `main` carries its changes under a different sha and
  `git merge-base --is-ancestor c8dc4d07f origin/main` returns false. Verify
  these by content, never by ancestry alone. (Re-run after the 2026-09-08
  rebase and unchanged. Both still `cat-file -e` in THIS clone, but
  `c8dc4d07f` is reachable from nothing now — a fresh clone will not have the
  object at all, which is the same reason the commit table above is keyed by
  position rather than by sha.)

  The five checks and what they printed: `"re-pinned 2026-09-07
  @ fb99bbd4c"` in `W1-step-one.md` → **7 as of the final-review fix round,
  2026-09-08; it was 8** — scope 4's entitlement migration lost its marker when
  that line was rewritten from the reserved `V401` to the `V<next+1>` RULE, and
  the re-pin it recorded is exactly what the rule supersedes. **The floor moves
  DOWN to 7 rather than the check reading as a regression**, and the general
  form is: when a marked line is deliberately rewritten, re-derive the floor and
  say why here — never restore a marker to satisfy a count, which turns the
  sentinel into decoration. (The remaining margin is still zero, so the original
  warning stands: an accidental drop takes this below its floor silently.)

  **A bare count still cannot tell a deliberate retirement from an accidental
  drop** — a round that retires one marker and loses another nets to 7 and
  reads clean. So the floor is a ROSTER, not an integer. The seven surviving
  markers and the scope each belongs to, re-derived 2026-09-08 from
  `grep -an "re-pinned 2026-09-07 @ fb99bbd4c" W1-step-one.md`:

  | Line | Owning scope |
  |---|---|
  | `:27` | header — desk sequencing (W1/W2 merged, W3 is the contention) |
  | `:209` | scope 5 — the cookie banner (Q2 + FS1) |
  | `:226` | scope 5 — `hasFeature` at `lib/entitlements.ts:456`, moved from `:454` |
  | `:270` | RP1 — `FixtureLine` / `fixture-schedule-toggle` retired by desk W2 |
  | `:342` | do-not-touch list — `stages-panel.tsx` is no longer the mount |
  | `:486` | acceptance — `fixture-schedule-toggle` absent, `run-sheet-edit-time` present |
  | `:536` | merge gate — rebase after any desk-W3 merge touching `desk/run-sheet-row.tsx` |

  Retired so far: **scope 3/4's migration numbers**, when the reserved
  `V400`/`V401` became the `V<next>` RULE (final-review fix round, 2026-09-08).
  Check the roster by SCOPE, not by count: a line number here moves whenever
  the file is edited, so match on the owning scope and re-derive the numbers.
  `"eleven"` in
  `_RULES.md` → **3** (R16 widened); `"run-sheet-row.tsx"` in `W1-step-one.md`
  → hit at `:29` (RP1 re-pinned; the mount is the SYMBOL
  `data-testid="run-sheet-edit-time"`, never a line number); `"set point"` in
  `W2-moments.md` → **5** (F3 landed); `"^| T1 |"` in `_INDEX.md` → **empty**,
  which was the row Task 0 then added.
- Recreate from this worktree with
  `POSTHOG_KEY= NEXT_PUBLIC_POSTHOG_KEY= ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label ovl --server`;
  `rebuild --label ovl` after every code change. **Blank both PostHog keys**:
  `captureServer` reads `POSTHOG_KEY ?? NEXT_PUBLIC_POSTHOG_KEY` and
  `.env.local` carries a real key, so a browser-driven local run otherwise
  posts to the LIVE PostHog project.

## Where the work lives

- Branch `feat/stream-overlay`, worktree `.claude/worktrees/stream-overlay`,
  **based at `4ee38278d`** (Task 0 Step 1, 2026-09-08). Every docs commit of
  this programme is already ON `main`: the branch was 0 ahead / 3 behind, so
  `/usr/bin/git rebase origin/main` was a FAST-FORWARD, not a replay. The
  earlier "rebased onto `fb99bbd4c`, 24 unpushed docs-only commits,
  force-pushed" no longer describes this branch — nothing is carried and no
  force-push is owed. **`main` moves under this branch several times a day**
  — during Task 0 alone #747 `feat/pad-attribution-side-groups`, #748
  `docs/spectator-w1-merged`, then #750 `fix/money-path-gate-arming` (which
  touched only `.github/workflows/e2e.yml`, no contention with this
  programme). So treat any ahead/behind written here as a SNAPSHOT and re-run
  `/usr/bin/git rev-list --left-right --count origin/main...HEAD` before
  trusting it. At the close of Task 0 the branch was **1 ahead** (the Task 0
  docs commit) **and 2 behind**, and `origin/feat/stream-overlay` still
  pointed at the pre-Task-0 `01669d287` — the push is the main session's call.
  The previous directory at that path was an unregistered residue and was
  moved to `.claude/worktrees/stream-overlay.stale-20260907`; the worktree was
  re-added from the branch. ~~The branch has no PR (docs only).~~ **It has one:
  PR #752**, opened 2026-09-08 once T1 landed code — **and #752 has since
  MERGED (`1d1f34d69`), as has W1's PR #761 (`0dc6fe1b9`, 2026-09-10).**
  R2-prep works from a different branch and worktree: `feat/stream-r2-prep`,
  `.claude/worktrees/stream-r2-prep`.
- ~~Every commit is documentation, all under `docs/superpowers/`.~~ **False
  since T1.** The branch now carries production and test code under `apps/web`
  (`lib/contrast.ts`, `components/overlay/overlay-tokens.ts`, `e2e/visual/**`,
  `e2e/helpers.ts`, `court-card.tsx`) plus `scripts/smoke.ts` and
  `docs/runbooks/visual-gate.md`. Still nothing under `packages/` or `db/`.
- ~~**No pull request, deliberately.**~~ **PR #752 is open.** The reasoning
  behind the old bullet still holds and is why the PR waited for code: CI and
  smoke run on `pull_request`, so a docs-only PR buys nothing. **e2e does NOT
  run on pull requests** — `.github/workflows/e2e.yml` triggers on push to
  `main` only, so the ONLY pre-merge e2e signal for #752 is
  `workflow_dispatch` with `pr=752`. Re-read `e2e.yml` rather than trusting this
  sentence; that trigger has changed three times in one day before.
- **Migrations: a RULE, never a reserved number.** This bullet used to read
  "this programme takes V400 / V401 / V402". `main` took
  `V400__repair_orphaned_age_cutoff_half.sql` during the T1 wave, so the
  reservation was already wrong — and renumbering to V401/V402/V403 would just
  reset the same trap. **Take the next free numbers after
  `ls db/migration/deltas | sort -V | tail -1`, re-read at every rebase and
  again immediately before writing the migration file. Never carry a number
  forward from a document.** A duplicate Flyway version survives a clean rebase
  with no conflict, which is why the check is at every rebase and not once.
  T1 adds no migration; **W1 is the first wave here that needs one.**

## The documents, and what each is for

| File | Role |
|---|---|
| `../2026-09-07-streaming-programme-design.md` | **design of record** (owner-approved 2026-09-07): Tier A rewritten in, T1, credits, Tier B, compositor, R0, testing, plan structure, findings |
| `../2026-09-05-stream-overlay-design.md` | superseded; kept for the canvas links and the approval record |
| `_INDEX.md` | decision log, owner rulings verbatim (1–23), false premises, both pinned-symbol tables, the 2026-09-07 section, and **"## 2026-09-08 — T1 wave CLOSED"** — the authority for T1's gate numbers, mutant killer lists, findings and deferred minors |
| `_RULES.md` | R1–R17 standing rules and the eight merge gates |
| `_THEMES.md` | binding values at 1920×1080; §3 `bar`, §4 `bug`. **T1a LANDED 2026-09-08**: §4a slate, §8a Phone tab, §8b credits card, the decided/void rows, §5's derived slab ink and §2's contrast + ink-hairline rows. It supersedes design §7.6 on the Phone-tab QR floor, and it is the authority `overlay-tokens.ts` parses — a value typed in both places is a finding, not a convenience |
| `_OPEN-QUESTIONS.md` | the 2026-09-05/06 questions and answers; the design's §12 holds today's open set |
| `W1-step-one.md`, `W2-moments.md` | the wave prompts (corrected in place by the plan's Task 0) |
| `../../plans/2026-09-05-stream-overlay-w1.md` | W1 plan, executes as corrected (Task 0 Steps 2–13 → the overlay endpoint) |
| `../../plans/2026-09-05-stream-overlay-w2-moments.md` | W2 plan, blocked on spectator W1 |
| `T1-theme-and-visual-gate.md`, `R0-bench.md`, `R1-relay-core.md`, `R2-compositor.md` | per-wave PROMPT files (owner ruling 2026-09-07: prompts for every wave now) — written, `8d31cb34f` |
| `../../plans/2026-09-07-streaming-t1.md` (now), `…-r1.md` (after PR1 merges), `…-r2.md` (after the R0 memo) | per-wave PLAN files, written one wave ahead of execution by `writing-plans`; Task 0's steps sit at the head of the T1 plan |
| `docs/superpowers/RULES.md` §"Owner checklist (2026-09-07)" | the owner's checklist; every task's acceptance names its rows |
| Canvas | https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 |

## THE FIRST THING TO DO NEXT SESSION

**Rewritten 2026-09-08 by T1 Task 4.** The two instructions that stood here as
items 2 and 3 are both dead and are named here so a fresh session does not act
on a stale copy of this file:

- ~~"execute Task 0 from the head of the T1 plan"~~ — **T1 is DONE**, Task 0
  included. Re-running it would re-baseline against a tree that has moved and
  re-do corpus corrections already landed.
- ~~"Force-push the rebased branch (`git push --force-with-lease`)"~~ — **no
  force-push is owed, and one would rewrite pushed history.** That instruction
  survived from a state where the branch carried 24 unpushed docs-only commits;
  the branch has since been a fast-forward and is pushed. `git push` plainly, or
  nothing at all.

**SUPERSEDED 2026-09-10 by the R2-prep wave. Items 1–3 below are DISCHARGED**
and are kept only so a fresh session does not act on a stale copy: #752 (T1)
merged as `1d1f34d69`, and W1 merged 2026-09-10 as **PR #761** (`0dc6fe1b9`),
carrying W1-E. Item 4's R1 gate has opened with it. Item 5 is NOT discharged —
FS-T1g (`standings-table.tsx:58`, axe SERIOUS) and FS-T1h
(`live-score.tsx:245`, `truncate` without `min-w-0`) still name an owner and a
wave, and neither belongs to this programme.

**The live order, 2026-09-10:**

1. ~~**The owner action that gates three items** — provision a Cloudflare account
   and a Stream-scoped API token.~~ **DONE 2026-09-12.** The credentials were
   already in `.env.local`; this file did not know. R0 has run, and U1's
   hold-window question (`_OPEN-QUESTIONS.md` Q17) is answered in `R0-memo.md`
   §4a — `timeoutSeconds` governs the hold, the hold is timeout + ~3 s, and at
   180 **no `EXT-X-ENDLIST` is ever emitted**.
2. **W2**, from `../../plans/2026-09-05-stream-overlay-w2-moments.md`, whose
   task zero owes the RE-PIN table in the PR. This is the only wave that can
   move without the Cloudflare account.
3. **The organiser-panel e2e** (`components/v2/fixture-stream-panel.tsx`) — the
   owner-ruled first item of the next wave, still unbuilt. Read the E3
   correction in `_INDEX.md`'s R2-prep section BEFORE writing the rig: the gate
   is four conditions across two files, not the one this file's ancestors
   recorded.
4. **P5, the device spike**, is startable now and blocks the R3 estimate. It
   needs handsets, not this repo, and touches nothing R2 depends on.
5. ~~Then R0's bench~~ **R0 is CLOSED.** ~~Next is **R1's plan** — its gate is open and R1
   has neither a plan nor code.~~ **R1's plan is WRITTEN (2026-09-14,
   `../../plans/2026-09-13-streaming-r1.md`); R1 execution waits on the owner's "start".** R2's plan follows PR-R1's merge and re-pins on that tree,
   and is written from `R0-memo.md`, not from design §7.2/§9.3, both of which R0
   corrects. Plans stay one wave ahead.

**[RULED 2026-09-13 — owner: "follow the order". Guest is `performance-4x`; the LL-HLS beta is to be enabled and measured. See `_INDEX.md` "Owner rulings, 2026-09-13".]** Prior record: two owner decisions were open and both cost money (`R0-memo.md` §2, §3):
whether the `< 80 %` CPU bar is honoured as written — `performance-4x` at
£0.539/3 h misses it by 1–5 points, `performance-8x` at £1.078 clears it and
also buys multi-cam n=4 — and whether to enable Cloudflare's **Low-Latency HLS
beta**, which is off today and is the difference between a ~12.6 s and a claimed
~5 s scorebug for anyone watching a phone-published match.

**The 2026-09-08 order, kept for the record:**

1. **PR #752 (T1).** Two things gate it, and neither is CI-automatic:
   (a) **pre-merge e2e is `workflow_dispatch` with `pr=752`** — `e2e.yml`
   triggers on push to `main` only, so opening the PR ran nothing; re-read
   `e2e.yml` rather than trusting this line. (b) **the owner's per-screen
   sign-off** — six PNGs and the five T1a picks plus the hairline addendum, one
   verdict each. "CI green" is not sign-off.
2. **Then W1**, from `../../plans/2026-09-05-stream-overlay-w1.md` (amended),
   per `superpowers:subagent-driven-development` with `model: opus` per dispatch
   (owner instruction; the agent frontmatter reads `sonnet`). W1's task zero
   owes: a rebase on `main`, the RE-PIN list, and the **migration-number READ**
   — `ls db/migration/deltas | sort -V | tail -1`; no number is reserved, and
   **the W1 plan still names `V400`/`V401` on 24 lines including two literal
   "create this file" steps, while `V400` is already taken on `main`.** Its own
   renumber guard sits at Step 13, after Steps 6 and 3 have written the files.
   Correct the plan's numbers at Task 0, in one edit, before any step creates a
   migration. Full list of the stale locations: `_INDEX.md` FS2. W1's
   acceptance carries **two obligations T1 handed it**, both recorded in
   `_INDEX.md`'s T1 close section and in `W1-step-one.md`: the **1-px
   `--sport-ink` hairline** asserted in e2e (two contrast closures rest on it),
   and this module's **e2e + smoke**, which W1 Task 8 owns.
3. **W1-E's brief must name `auth: true` and `seed: "none"` as first-use** —
   both are live harness code that no manifest row drives today, ruled
   deliberate on the condition that W1-E names them.
4. R1's plan is written after PR1 merges; R2's after the R0 memo. W2 stays
   blocked on its own task-zero RE-PIN.
5. Two `main` findings need an OWNER and a wave, not a fix here:
   `standings-table.tsx:58` (axe SERIOUS) and `live-score.tsx:245` (the
   `truncate` without `min-w-0`). Both are in `_INDEX.md` as FS-T1g / FS-T1h.

## Decisions, all made (owner's words in `_INDEX.md`)

- Shape: one design of record, one programme plan (ruling 18).
- Two keys, corpus names kept: `streaming.overlay` (Pro, Enterprise, Event
  Pass L) and `streaming.relay` (same split, "may buy credits").
- Per-match credits in packs of 1 / 5 / 20, a ledger, consumed at `live`,
  bought from the stream panel's Phone tab through Stripe Checkout (sandbox
  placeholders £6 / £25 / £80; real prices before GA).
- Runner: Fly Machines only, one per session, `lhr`, `auto_destroy`.
- Front door: Cloudflare Stream. Compositor self-mints realtime as a producer.
- T1 wave (theme design + visual gate) runs ahead of W1-C.
- Everything from 2026-09-05/06 still stands: themes are a registry; eleven
  hosts; overlay endpoint over `foldFixture`; football clock ticks and
  survives reduced-motion; panel toggle at every status; cookie banner off the
  overlay segment (now known to need building — FS1); sponsors last; W2 after
  spectator W1.

## Still open, none of them blocking

Design §12: real prices, passthrough half-credit, Enterprise monthly bundle,
Vault vs envelope, YouTube fresh-channel copy, per-destination VOD, mic
default (R3). Q11–Q13 from the earlier set stand as recorded.

**Added 2026-09-10 — and Q17 IS blocking, despite this heading.** `Q17`
(register U1, what the playback side sees while a live input is disconnected) is
the one open question in the programme that gates a wave: it decides whether R2's
slate is driven by frame starvation or by reconnect logic. It cannot be answered
until the Cloudflare account exists. `Q18`/`Q19` are RULED, not open — owner
rulings R-A and R-B, 2026-09-10, recorded as rulings 24 and 25 in `_INDEX.md`.

## Environment (SUPERSEDED — prior record, 2026-09-07)

**Stale as of 2026-09-08** in its FIRST SENTENCE only — the `ovl` environment IS
up, and the coordinates are in "## Environment (label `ovl`, stood up
2026-09-08 …)" above, which is the authority for them. **Everything else in
this section still holds and is kept deliberately:** the `up` FLAGS in the
first bullet — `--server` for e2e and smoke, and **`--placement` before
trusting `schedule-build-honours-locks.test.ts`**, which is the one command
that turns the new block's four ENVIRONMENTAL reds green — and the
worktree-setup traps in the last two bullets.

- No `ovl` database or server is up. Recreate from this worktree:
  `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label ovl`, then
  `eval "$(… env --label ovl)"` → `DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl
  DATABASE_SSL=disable`. Add `--server` for e2e and smoke, `--placement`
  before trusting `schedule-build-honours-locks.test.ts`.
- The re-added worktree has **no `node_modules` and no `.env.local`
  symlinks** yet: `pnpm install --frozen-lockfile` and relative symlinks in
  the root and in `apps/web` before any verify command. A package the
  worktree does not hoist resolves from the MAIN checkout — prove resolution
  with `require.resolve` if a dependency differs between branches.
- Shell guard: `/usr/bin/git` in plain calls, no heredocs, no `eval` or
  sourcing, Write tool for files, `grep -a`.

## Baseline (SUPERSEDED — apps/web vitest, fresh `ovl` DB, 2026-09-05, at `997ad22`)

**Stale as of 2026-09-08.** The live baseline is the one in "## Environment
(label `ovl`, stood up 2026-09-08 …)" above — 15121 / 15198, one red file,
environmental — and it is cited by JSON path, which is the single authority.
Q12 was reproduced there and closed GREEN. Kept as the prior record only.

13,962 passed of 14,041, 74 pending. Five reds: three placement-service
environmental, two `pass-scoping-guard.test.ts` unclassified (Q12). **Stale
after the rebase** — Task 0 re-baselines on `fb99bbd4c` and attributes Q12's
reds on a clean detached checkout before any wave starts.
