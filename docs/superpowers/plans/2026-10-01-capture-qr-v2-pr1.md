# Capture QR v2 — PR-1 (capture-facing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Amended 2026-10-01, before execution, from the pre-flight review.** The review read this plan against
> `feat/capture-qr-v2-pr1` (origin/main 81d1f3d73, #909 merged, plus the spec and plan commits). It found 23 false
> premises and 27 mandatory amendments (A1–A27), and asked for ten rulings (R1–R10). All are folded in below, with
> five more false premises found while amending (FP24–FP28) and one ruling they raised (R11, owed). The
> review file is `.superpowers/sdd/2026-10-01-capture-qr-v2-pr1/preflight.md`. That directory is gitignored, so every
> fact this plan needs is restated here, and **this file is the authority**. "Pre-flight rulings and amendments",
> below the batch table, indexes them. Where a ruling changed spec text, the spec carries it in §17.

**Goal:** Replace the credential-carrying v1 capture QR with a stable per-fixture stream code. A Seazn Capture phone
pairs once, beats to the server, hears Go live, fetches its credentials only while it is the current phone, can
start and stop from the phone, and is ended cleanly when it is lost. The organiser panel offers Go live only once a
phone is paired.

**Architecture:**

- **Pure domain tables, no I/O.** Code, pairing, slot, beat answer, poll cadence, end reasons and both phone-lost
  rules are pure modules under `server/relay/domain/`, decided by tables, with `now` passed in.
- **Thin use-cases.** `stream-codes.ts` mints and resolves codes. `capture-phone.ts` serves the three phone routes.
  `stream-sessions.ts` gains `startBroadcast` (one start path for organiser and operator) and `tickSession` (one tick
  for organiser polls, phone beats and the sweep).
- **One V430 migration.** `relay/secret-columns.ts` stays the only SQL over sealed columns, `tok_enc` included. Its four
  new tables follow V410's RLS model (R1): enable plus force, no policy, and access only through the non-tenant `sql`.
- **The contract first.** Task 1 publishes the JSON contracts that capture vendors. Everything after it builds
  against their zod twins.

**Tech Stack:**

- Next.js 16 app router and React 19 client islands.
- Zod v4, with OpenAPI generated through `z.toJSONSchema`.
- postgres.js (`sql.begin`, `tx.savepoint`), with Flyway deltas under `db/migration/deltas/`.
- vitest with `environment: "node"`, so there is no DOM.
- fast-check `^3`, which is already a devDependency.
- Playwright (the walkthrough project and the seven width projects of `mobile.spec.ts`), and `scripts/smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md`, approved by the owner on 2026-10-01, with
rulings W18–W25. Read it beside every task: section numbers below (§n) point into it. The spec binds. Where this plan
deviates, the deviation is named under "Premises re-verified". Capture's side is its amendment
`docs/specs/2026-10-01-s1-amendment-stable-code-design.md` (capture repo, `feat/s1-plan-c`, agreed through
`5344d04`).

**Worktree.**

- Path: `/Users/ashokhein/github/seazn.club/.claude/worktrees/capture-qr-v2-pr1`.
- Branch: `feat/capture-qr-v2-pr1`.
- **Dependency (W22): met.** The Cloudflare Cron Triggers programme merged in #909 (81d1f3d73). T7b adds a job to its
  `apps/cron-worker`, and its `V429__weekly_digest_cron_once.sql` sits below this plan's V430.
- The branch is origin/main 81d1f3d73 plus the cherry-picked spec and plan commits, so the spec and this plan travel
  with the build.
- `WT` below means that absolute path. Every command starts with `cd $WT…` in the **same** shell call (AGENTS.md:
  shell cwd resets between calls).
- `SCRATCH` below means the executing session's own scratchpad directory, **never `/tmp`** (A22). Several sessions
  share `/tmp`, and another run's stale `--outputFile` JSON reads as green.
- The worktree has no `node_modules` until `pnpm install` runs in it. Stand it up with the `seazn-local-env` skill.

## Execution batches

Ten batches over eighteen tasks. Each batch gets **one implementer and one review**. Inside a batch the implementer still commits **once
per task**, in task order, so each commit stays bisectable and each task's own gate and mutations still run.

| Batch | Tasks | Boundary gate (the orchestrator re-runs it, scoped) |
|---|---|---|
| B1 | T1 | T1 Step 6. **Committable alone, first: capture vendors it.** R5 is final (capture agreed 2026-10-01). |
| B2 | T2 | The mockup files exist and differ (Step 3); then **STOP: owner OK required** (OG2). B3 does not wait for it. |
| B3 | T3 + T4a + T4b | T3, T4a and T4b scope commands together. T3's command now includes `stream-sessions.test.ts`, `routes.test.ts` and `rls-static.test.ts` (A3, R1). T4a's and T4b's include `domain-purity.test.ts` (A6). |
| B4 | T5 + T6 + T6b | T5, T6 and T6b scope commands, plus `stream-contract.test.ts` and `routes.test.ts`, **plus every A7 caller file** (`relay-sweep.test.ts`, `relay-internal-routes.test.ts`, `stream-targets.test.ts`, `stream-credits-monthly.test.ts`), `domain/__tests__/expiry.test.ts` (A8), and `fixture-stream-panel.test.tsx` as A9(a)'s proof that `restartFree` still reads the same (A25) |
| B5 | T7 + T7b + T8a | T7, T7b (both the web and the cron-worker runs) and T8a scope commands, **plus `relay-sweep.test.ts` (A11), the full cron-worker list (A12), and `key-scopes.test.ts` and `openapi-coverage.test.ts`, because T8a now registers its own route (A16)** |
| B6 | T8b + T8c | T8b and T8c scope commands, plus `key-scopes.test.ts` and `openapi-coverage.test.ts` (unchanged, A25), **plus every A7 caller file again**, because T8b re-points `pairPresentPhone` onto the real `postBeat` claim (FP25), and the four FP26 seam callers in T8c's command |
| B7 | T9 + T10 | T9's scope, then T10's model run **three times** (each seed logged) and the mutation table recorded |
| B8 | T11 | **Gated on B2's sign-off (OG2).** T11 scope, then `mobile.spec.ts` whole, then screenshots |
| B9 | T12 | The four Go-live walkthroughs whole (`capture-phone`, `stream-relay`, `stream-credits`, `directory-stream-destinations`; A7), then `stream-overlay.spec.ts` under `parallel` with a test count above 0 (A19), the re-run list, `e2e-ci-wiring.test.ts` (R10), then `SMOKE_ONLY=captureV2 pnpm test:smoke` |
| B10 | T13 | The lane close. It STOPs before any push or PR (OG3 onward). |

A batch's review runs over the batch's commits (`git diff <batch base>..HEAD`), with this plan's task text as the
brief. Fixes from that review land in the owning task's files as a follow-up commit in the same batch, and the batch
gate is re-run before the next batch starts. **Every batch gate is scoped, never the full suite** (owner, 2026-09-28).
**Re-pin `stream-sessions.ts` line anchors at each batch start** (A14): B3 and B4 move its lines for B5.

**Batch adjustments from the pre-flight (2026-10-01).** The ten batches keep their composition. No task moves
between batches. What changed is the gates and one division of work:

- **A16 (route registration).** T8a and T8b now register their own routes, in `NEVER_KEY_ROUTES` and in OpenAPI
  `ROUTES` under the `capture` tag, each in its own commit. Under the old plan, T8c registered all three phone routes
  in B6. `key-scopes.test.ts` (total classification) and `openapi-coverage.test.ts` (1:1) would then red at the
  T8a and T8b commits, from B5 until T8c, so those commits were not bisectable. That is why B5's gate gains both
  files. T8c keeps only the start route's registration and the sibling pin of all three.
- **A3 / R3 (the column drop and rename).** This moves the live writer's re-pointing into T3 (B3). It changes no
  batch, but B3's gate gains the writer's tests.
- **A7 (W5's blast radius).** B4's gate gains every organiser-start caller. B9 gains the two Go-live walkthroughs.
  Between T6 (B4) and T12 (B9) those walkthroughs start sessions with no phone, so they would red **by design**. Nothing
  runs them before B9, because nothing is pushed before T13.
  B6's gate re-runs the B4 callers, because T8b moves `pairPresentPhone` off its direct INSERT and onto the real
  claim (FP25).

## Pre-flight rulings and amendments (2026-10-01)

### Rulings

Every ruling below is the controller's call unless its row says otherwise. Only R9 is an owner ruling. **Never relay
a controller ruling to a peer session as the owner's word** (AGENTS.md class 17).

| # | Ruling | Status | Where it lands |
|---|---|---|---|
| R1 | **RLS for the four V430 tables: the V410 pattern.** Each table gets enable plus force row level security, with no policy, no `trg_set_org` and no grant to `app_user`. Every read and write goes through the non-tenant `sql`. The use-case writes `org_id` from the code row or the session row. | ruled | T3; spec §17.1 |
| R2 | **The Sentry throttle is option S, stateless.** A scheduled firing sends a failure to Sentry only from the first `*/N` slot of each UTC hour, keyed on `scheduledTime`. Every other failing firing logs `sentryThrottled: true` and sends nothing. The hourly trigger is never throttled. | ruled | T7b; spec §17.2 |
| R3 | **The column drop and rename happen in T3,** together with the live writer and its three test readers. | ruled | T3; spec §17.3 |
| R4 | **`Retry-After` is the true remaining seconds,** read from the Lua TTL. The fail-closed 429 answers the full window. | ruled | T8c; spec §17.4 |
| R5 | **The contract's `at` field and the beat-answer union.** `at` uses `z.iso.datetime({ offset: true })`, and the server normalises it to UTC. The beat answer and the descriptor become discriminated unions on `state`. | **final**: capture agreed on 2026-10-01. This is a technical contract detail, not an owner ruling. | T1, T8b; spec §17.5 |
| R6 | **Manual runs bypass the throttle.** | ruled | T7b; spec §17.2 |
| R7 | **The descriptor builder truncates `"{A} v {B}"` to 200 characters and `destinationName` to 80,** each with one trailing ellipsis. | ruled | T8a, T8b; spec §17.6 |
| R8 | **"Another sport" for `finished_at` is a sweep over the status writers,** plus a `// single-sport:` reason. | ruled | T3; spec §17.7 |
| R9 | **The staging cost of the `*/5` trigger is accepted,** including keeping the stg Fly machine awake. Stg runs `min_machines_running = 0` with `auto_stop = "suspend"`, so a request every 5 min keeps it mostly awake, for a few dollars a month (unverified estimate). Prod already runs `min_machines_running = 1`, so prod's cost is unchanged. | **ruled by the owner, 2026-10-01** (relayed by the controller). This is the only owner ruling in the table. The merge itself still needs its own OK (OG6). | T7b, T13 |
| R10 | **The walkthrough tunables go in `e2e.yml`.** They are set in e2e-parallel's Start server step and Playwright step, and pinned in `e2e-ci-wiring.test.ts` the way `FAKE_INGEST_CONNECT_AFTER_MS` is. | ruled. The `e2e.yml` edit itself is owner-gated (OG15). | T12 |
| R11 | **New, raised while amending.** `domain/session.ts:230` can complete a `live`, `warming` or `provisioning` session with `endReason: null`. Spec §6.8.4 maps no wire value for a `completed` row with no end reason, and both unions require one (`over`, and the descriptor's `completed`). *Recommendation: map it to `failed`.* G0-f defines `failed` as "a server-side end that is neither a stop nor a timeout", the enum already admits it, and capture already has copy for it. | **owed (controller)** before T4b commits | T4b |

### Amendment index

| Amendment | Task | What it changes |
|---|---|---|
| A1 | T1 | The panel suite is not deleted. Its `QR` fixture becomes an inline `CaptureQrV1` literal. |
| A2, A21 | T1 | `at` admits offsets. The beat answer and the descriptor are per-state unions, with a field matrix test. |
| A3 | T3 | The drop and rename re-point the live writer and three test readers in the same commit. |
| A4 | T3 | `lastCheckList` parses both inline and named CHECK forms. It is checked with an ordering differential and an anti-vacuity count. |
| A5 | T3, T5 | Plan:668's duplicate enc-boundary case is deleted. The `tok_enc` assertions move under `server/relay/__tests__/`. |
| A6 | T4a, T4b, T6 | `domain-purity.test.ts` pins the seven new files. `EventSource` gains `"phone"`. T4b keys on `CaptureEndReason`. |
| A7 | T6, T12 | W5's blast radius is in the file lists: the rig helper `pairPresentPhone`, every organiser-start caller, and two walkthroughs. |
| A8 | T6 | The warming anchor lives in `domain/expiry.ts:95`, as `warmingAt ?? createdAt`. |
| A9 | T6b, T11 | Option (a): `restartFree` stays on the wire, derived, until T11. `restart` is added beside it. |
| A10, A27 | T7, Global Constraints | B0's interfaces are moved verbatim. `tickSession` returns an observation. The freshness window is 2×, not 1×. |
| A11 | T7 | `relay-sweep.test.ts` is in scope. |
| A12, A13 | T7b | A full rewrite against the real `apps/cron-worker`. |
| A14 | P14, T6, T6b, T7, P6, T1 | Line anchors are re-pinned, and re-pinned again at each batch start. |
| A15 | T8c | `Retry-After` comes from the Lua TTL. `CounterFn` returns `{count, ttlMs} \| null`. The test seam's callers move. |
| A16 | T8a, T8b, T8c | Each route task registers its own routes. |
| A17 | T8a | A capture bearer reader answers `401 code_ended` uniformly. The SRT hold is computed in the builder. |
| A18 | T8c | The Sentry scrub covers capture paths, the Bearer, and the request body. |
| A19 | T12 | `stream-overlay.spec.ts` runs under `parallel`. The tunables are wired through `e2e.yml` (R10). |
| A20 | T3 | R8's status-writer sweep, and the C5 revert case. |
| A22 | everywhere | Scoped JSON goes to `$SCRATCH`, never `/tmp`. |
| A23 | T6 | The diff test also asserts the order of the provider calls. |
| A24 | T13 | Runbook additions: the stg hosts, `wrangler deployments list`, and one throttled firing. |
| A25 | batch table | The B4 and B5 gates widen. |
| A26 | T10 | The model flips ingest through `FakeIngest.setState`. |

### Owner-gated steps

Each step below is marked **STOP: owner OK required** where it occurs. The orchestrator never takes it on its own
authority, and never on a peer session's word.

| # | Step | Where | Why it is gated |
|---|---|---|---|
| OG1 | Hand T1's commit to the capture session to vendor. **STOP: owner OK required.** | T1 Step 8 | It is cross-session. Send the contract and R5's record as a recommendation-framed note (class 17). |
| OG2 | Sign off one of the T2 mockups. **STOP: owner OK required.** | T2 Step 4; it gates B8 | This is an owner UI choice (the ≥2-options rule). |
| OG3 | Push `feat/capture-qr-v2-pr1`. **STOP: owner OK required.** | after T13 | T13 STOPs before the push. |
| OG4 | Open the PR. **STOP: owner OK required.** | after OG3 | Smoke CI runs on the PR. e2e does **not**. |
| OG5 | Run `workflow_dispatch` e2e with the `pr` input. **STOP: owner OK required.** | T12 Step 6, before merge | It is the only pre-merge e2e signal. The branch edits `e2e.yml` (R10), so dispatch with `--ref feat/capture-qr-v2-pr1`; otherwise main's workflow file runs. |
| OG6 | Merge to main. **STOP: owner OK required.** | — | `stg.yml` runs Flyway V430 on the stg DB, deploys Fly stg, and runs `deploy-cron-worker-stg` (`wrangler deploy --env stg`). That is a **Cloudflare write**: the `*/5` trigger goes live on stg at once, and the account goes from 2 to 3 of its 5 triggers. Migration runs before deploy, so V430 must be backward compatible with the running app (`stg.yml:15-17`). **R3's rename is not:** the old app's QR writer fails against the renamed columns for the deploy window. The owner accepts or refuses that stg-only window (greenfield, RULES.md §Schema). R9 (the stg `*/5` cost) is already accepted; this merge OK is still asked at merge time. |
| OG7 | Watch the e2e run on the push to main. **STOP: owner OK required** to act on its result. | after OG6 | A main push cancels a dispatched run, so "cancelled" is not a pass. |
| OG8 | Version tag. **STOP: owner OK required.** | — | `prod.yml` runs the prod migration, Fly prod, and the cron Worker prod deploy (4 of 5 triggers). This is a Cloudflare write. |
| OG9 | Set `STREAM_INGEST_HOST` and `STREAM_PLAYBACK_HOST`, and confirm `RELAY_DRIVERS`, on stg and prod. **STOP: owner OK required.** | before S1, and before the tag | Neither host is in `fly.toml` or `fly.stg.toml` `[env]` today. Without `STREAM_PLAYBACK_HOST`, a real-driver descriptor 503s (`playback_unconfigured`). |
| OG10 | Any DNS or ingest host, such as `live.stg.seazn.club`. **STOP: owner OK required.** | runbook | Cloudflare write. |
| OG11 | KV namespaces and bindings. **Not triggered: R2 is S.** If R2 ever moves to K: **STOP: owner OK required.** | — | Cloudflare write, ×2 envs. |
| OG12 | `wrangler secret put`, `wrangler tail`, `wrangler deployments list`. **STOP: owner OK required.** | runbook | They run on the owner's account. |
| OG13 | The `STREAM_SRT_ENABLED` flip. **STOP: owner OK required.** | post-merge | Product exposure. |
| OG14 | The staging runbook, S1–S11. **STOP: owner OK required.** | post-merge | Live stg on real Cloudflare Stream, billed by Stream minutes and storage. |
| OG15 | Edit `.github/workflows/e2e.yml` (R10). **STOP: owner OK required.** | T12 Step 1b | It is live CI on push to main. |
| OG16 | The deploy-order race. **STOP: owner OK required:** the owner acknowledges it before OG6 and OG8. | PR body | `toolchain.test.ts` forbids `needs:`, so the Worker can deploy before Fly serves `/api/cron/stream-tick`. The first firings can 404 and read as degraded, with Sentry throttled to 1 per hour. This is expected and self-healing. |

## Global Constraints

**Contract (spec §4, §6.3, §6.14):**

- The phone's words are kebab-case and the server's are snake_case. `mode` is `"automatic" | "operator"`.
- `x?` means omitted, never `null`. `x | null` means always present. `scheduledStart` is `?` on the waiting and session
  shapes and `| null` on the beat answer.
- **R5 (final, capture agreed 2026-10-01).** The beat's `at` is ISO-8601 with any offset (`z.iso.datetime({ offset:
  true })`). The server normalises it to UTC before storing it, and the phone sends `Z`. The beat answer and the
  descriptor are discriminated unions on `state`, so each state admits only its own fields (T1 gives the matrix).
- Every 2xx is the **bare** shape, never `{ok, data}`. Every refusal is
  `{ code, message, ...extras }`, for example `409 {code:"already_live", message, sid, startedBy}`. The phone keys its
  copy on `code` and never shows `message`.
- The phone routes never throw a bare `HttpError` for a refusal: `handler()` drops `extra` and would lose `sid`.
- `cred` goes only to the slot's current phone (G0-d). A session shape without `cred` is the hint to claim; there is
  no hint field.
- No route sends 410. Beats never answer 410 (ask 8).
- End reasons on the wire are `stopped | auto_stopped | no_inbound_timeout | target_rejected | max_duration |
  phone_lost | failed`, mapped from the DB by §6.8.4.

**Ingest hosts and SRT (spec §6.4, W15, W21, A18, G0-i):**

- RTMPS: when `STREAM_INGEST_HOST` is set, an exact `live.cloudflare.com` host is rewritten to it. Scheme, port and
  path are kept.
- SRT: **never rewritten**. Its url is Cloudflare's `srt://live.cloudflare.com:778`.
- With `STREAM_INGEST_HOST` set, any other host on either url answers `503 ingest_host_unexpected`. With it unset
  (local, CI and the fake driver), the provider's values pass through.
- `STREAM_SRT_ENABLED` **defaults ON** (unset means on). `false` is A18's safety net: `cred.srt: null` and
  `preferred: "rtmps"`. `preferred` never names a null shape.
- The schemas document the allowed SRT hosts as {`live.cloudflare.com`, the environment's `live.*`} in the
  `description`. They pattern-check no host, because capture enforces the host per environment.
- **G0-i is agreed** (2026-10-01, capture's owner's ruling, relayed by capture). `cred.srt` may sit on exactly
  `live.cloudflare.com` or the environment's `live.*`; RTMPS and every other URL stay strict `live.*`. So prod and stg
  ship with `STREAM_SRT_ENABLED` unset (on), with no interim `false`. Only an S2 SRT failure turns it off.

**Rulings the code must honour (spec §1):**

- **W2:** expiry is `finished_at` + 120 min with no cap, and never ends an open session (C2, C3).
- **W5:** Go live needs a present phone (`phone_not_paired`).
- **W8:** silence while live only warns.
- **W19:** a live session ends `phone_lost` only when all three hold: no beat for 15 min, a fresh read not
  connected, and no connected poll sample for 15 min.
- **W18:** `overlayUrl` follows the `streaming.overlay` entitlement.
- **A3:** an organiser Stop keeps the pairing; the operator's Stop ends it.
- **A14 and T4:** takeover of a live slot needs three conjuncts at 60 s.
- **A17 and T24a:** a late `stopped` from a phone that is not current is ignored while the current phone holds that
  sid.
- **Ask 10:** a warming session whose phone goes silent is ended `phone_lost`, cadence-aware, and no credit is spent.
- **W22:** a `stream-tick` job ticks every open session every 5 min through the cron Worker. The panel poll still
  ticks too. The Worker sends at most one Sentry error event per job per UTC hour (R2, option S, keyed on
  `scheduledTime`). Throttled firings log `sentryThrottled: true`. Manual runs are never throttled (R6).
- **W23:** `FREE_RESTARTS_PER_WINDOW` = 3. Only restarts that reached video count, never the paid first live, never
  a rejoin or takeover of the same sid. The 4th costs 1 credit at live and never hard-blocks. One authority,
  `restartAllowance`, serves admission, the consume and the panel.
- **W24:** "Reconnecting…" replaces "No signal" while live without video; after `RECONNECT_QUIET_SECONDS` = 30 a
  server-computed countdown runs to W19's end (live) or the warming deadline (warming).
- **W25:** the "Match {n}" fallback on the wire is in the competition's locale, which is
  `organizations.default_locale`.

**B0 interfaces (A27; merged in #908, 58e8103e3, not #909: FP28). No task edits their text, and an extraction moves
them verbatim:**

> B0 (in #908; the preflight wrote #909, FP28) owns four things: the single-statement coalesced read (`latestPollSampleWithSince`,
> `stream-sessions.ts:580`), the one-tx sample+event, `expireTargetHolders`' per-holder catch (`:1759`), and the
> ingest-cf output word map (`server/relay/ingest-cf.ts`). No task edits their text; extraction moves them verbatim.

Its constants stay as they are: `POLL_CLAIM_WINDOW_MS` (`:615`) and `COALESCED_SAMPLE_MAX_AGE_MS = 2 * STREAM_POLL_MS`
(`:621`). No task reads a coalesced sample against a 1× window (FP17).

**House rules (AGENTS.md, RULES.md, TEST-STRATEGY.md) that bind every task:**

- **Copy.** Every new or changed user-facing string goes in all four `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`.
  Then run `cd $WT && pnpm i18n:gen-keys` (never hand-edit `lib/i18n-keys.ts`), then `pnpm i18n:check`.
- **Every change ships a test that fails without it.**
- **Mutate each new guard once.** Delete the predicate, or `return true`; the named test must go red. Record each
  mutant and the red test's name in the task's commit body.
- **Anti-vacuity.** Every sweep, table and property test asserts how many items it checked. Zero checked is a
  failure.
- **Expected values come from declarations** (`relay/config.ts` constants, `ACTIVE_STATES`, the domain tables, the
  contract JSON), never from a table typed into the test. At least one case per guard must have a right answer that
  differs from the wrong answer's constant.
- **Test the sequence:** a second call, an empty input, after a withdrawal or void, and another sport.
- **Scoped local runs only.** Never the full vitest, e2e or gate, and never `seazn-env gate` (owner, 2026-09-28).
  Vitest runs as:

  ```bash
  cd $WT/apps/web && rm -f $OUT && pnpm vitest run <exact paths> --reporter=json --outputFile=$OUT; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $OUT
  ```

  Green means all of these:
  - `f == 0`, `p == t` and `t > 0`;
  - every path you passed appears in `.files`, with a `capture-qr-v2-pr1` path.

  Positional paths are literal filters, and a missing path is silently ignored. Delete `$OUT` first: a stale JSON
  reads as a pass. `$OUT` is `$SCRATCH/cq1-<task>.json`, never under `/tmp` (A22).
- **DB-backed tests need a fresh, migrated database.** That means `db:apply` **and** `sync:sports`; confirm
  `show data_directory` is yours. Use the `seazn-local-env` skill. A DB that lags `main`'s migrations reds unrelated
  suites.
- **`tsc` and `eslint` run through `rtk proxy`:**
  - `cd $WT/apps/web && rtk proxy pnpm typecheck` must exit 0;
  - `cd $WT/apps/web && rtk proxy pnpm lint` must read `✖ 0 problems`, or no problems line at all.
- **Playwright** always runs **whole files**, never `-g`:

  ```bash
  cd $WT/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test <file> --project=<p> --reporter=line; echo EXIT=$?
  ```

  Use `localhost`, never `127.0.0.1`. The server is a **prod build of this worktree**.
- **All four test types are owed** across the branch: unit, E2E, smoke and regression. Each task names which ones it
  owes.
- **UI** is verified at 1280, 768 and 320 with no horizontal page scroll, with per-screen verdicts.
- **Git:** never `git stash`. Commit with the session's attribution trailer, using `git commit -F <file>` (no
  heredocs in a worktree).

## Review Focus

These are the five inputs the spec implies but never names that are most likely to bite. Each has its test in the
owning task.

1. **A pasted code with whitespace or upper case** (the paste-code field, a hand-typed code).
   - Expect: the code is matched case-insensitively after trimming. Crockford's `I`/`L` → `1` and `O` → `0` are
     **not** folded (the phone sends what the QR holds), so they stay malformed, which is `404`.
   - Owner: T5 `normaliseCode`, with a test for `" ABCD…  "` → resolves, and `"abcdefghijko"` → 404.
2. **A beat body at the size limit, or one carrying an unknown key.**
   - Expect: the strict body refuses an unknown key with `422` (the phone counts it). An `appVersion` of 41 characters
     is refused, never silently cut. A `device.model` over 80 characters is refused the same way.
   - Owner: T8b, cases `tampered` and `overlong`.
3. **Two organiser tabs and a phone beat inside one poll interval.**
   - Expect: one Cloudflare read. The panel and the phone see the same live transition.
   - Owner: T7, the coalescing case with three callers.
4. **A phone clock far off UTC** (`at` hours ahead or behind), or an `at` with an offset.
   - Expect: every server clock uses the server's `now`. `at` is stored normalised to UTC (R5), and is never used
     for silence, history throttling or W19.
   - Owner: T8b, "`at` five hours ahead still writes a minute row on the server's clock".
5. **A fixture whose sides are unknown (TBD) when the code is minted.**
   - Expect: `label` is "{side A} v {side B}" once both are known, and before that the `breadcrumb.match` text in the
     organisation's `default_locale` with the match number (W25): "Match 7", "Partido 7", and so on.
   - Owner: T8a `labelFor`, with a TBD-sided case in each of the four locales.

## Premises re-verified (spec → corrected fact)

These were re-pinned against `origin/main` 58e8103e3 (PR #908 merged) on 2026-10-01, then **re-checked by the
pre-flight review against 81d1f3d73 (#909 merged)**. Items 1, 4, 6, 9, 11, 12 and 14 were corrected in place. The
pre-flight's false premises FP1–FP23 follow the list, together with what each changes. Each item says what the plan
does about it.

1. **Migration numbers (corrected, FP1).** `main` tops out at `V429__weekly_digest_cron_once.sql` (the cron
   programme, #909). V430 and V431 are free on every local and remote branch and in every worktree. **V430 is PR-1's
   and V431 is PR-2's.** T3 and T13 re-check: T13's guard is "past V429".
2. **`enc-boundary.test.ts` requires every `*_enc` column to have an owner.** It derives `ENC_COLUMNS` from every
   delta. The spec's first form ("crypto.ts remains the only module") was corrected on 2026-10-01: T3 adds `tok_enc`
   to `STREAM_COLUMNS`, owned by `server/relay/secret-columns.ts`. That edit is the test's own designed extension
   point, not a weakening.
3. **`_stream-migration.ts` reads only `V410__stream_sessions.sql`.** `stream-contract.test.ts` checks enums against
   V410's CHECK lists. V430 redefines `end_reason` and `fixture_stream_events.source`, so T3 teaches the helper to
   read V410 plus every later delta, with the **last** definition of a named check winning. Otherwise T6's widened
   `StreamEndReason` reds against V410's two values.
4. **`rateLimit()` throws `HttpError(429)` with no `Retry-After`** (`lib/rate-limit.ts:66`). T8c gives `HttpError` an
   optional `headers` field, and the limiter fills `Retry-After` with the window's remaining seconds. **Corrected
   (FP10):** the limiter cannot read a remaining time today. `CounterFn` returns `number | null`
   (`rate-limit.ts:43`), and `INCR_WINDOW_LUA`/`incrWindow` return the count only (`lib/cache.ts:314-333`). The
   fail-closed 429 (`rate-limit.ts:61`, Redis configured but unreachable) has no window to read at all. R4 and A15:
   the Lua script returns the TTL, `CounterFn` becomes `{count, ttlMs} | null`, and the fail-closed path answers the
   full window.
5. **The fake ingest issues `srt://fake.ingest.invalid:778`** (`relay/fakes.ts:125`). Host checks therefore run only
   when `STREAM_INGEST_HOST` is set. The fake keeps passing through, and the contract pattern-checks no host.
6. **The v1 contract is read by four tests (corrected, FP6):**
   - `capture-qr.v1.test.ts`;
   - `stream-sessions.test.ts:461-489` (the lane-D D5 seam case);
   - `fixture-stream-panel.test.tsx:585`. That line is the `QR` constant read from the v1 fixture file, and it is
     the **default of the `session()` factory** (`qr: QR`). That factory is called 85 times across 140 cases, so
     "every case that reads its fixture constant" means most of the panel suite;
   - `stream-session-view.test.ts:420-426`.

   T1 deletes the v1 contract files. It then **keeps** the panel suite, by replacing the file read with an inline
   literal typed `CaptureQrV1` (A1). It deletes only the cases that assert contract conformance. The v1 builder and
   parser stay live until T11 removes them. Nobody consumes v1 (W4), so the window is accepted and recorded in T1's
   commit.
7. **Fixture statuses** are `scheduled, in_play, decided, finalized, abandoned, forfeited, cancelled`
   (`v2-engine/tables/V214__fixtures.sql:21`). The finished set in §3 matches the CHECK.
8. **The latest connected sample** (A14, W19) is `fixture_stream_samples` with `source = 'poll'` and `ingest_state =
   'connected'`. It is written by the ingest read that `claimIngestPoll` guards, and T7 makes the tick write it.
9. **The phone routes and the API-key door.** `key-scopes.test.ts` and `openapi-coverage.test.ts` sweep the route
   files. The phone routes read their own Bearer and must never accept an org API key. **Corrected (FP14, A16):**
   `relay/bearer.ts`'s `bearerOf` throws `HttpError(401, …, "RELAY_TOKEN_INVALID")`, which is not the capture shape
   `{code:"code_ended"}`, and nothing covers a **missing** header. T8a therefore adds a capture bearer reader to
   `capture-http.ts`. Each route task registers its own routes in `NEVER_KEY_ROUTES` (`key-scopes.ts:312`) and in
   `ROUTES` under the `capture` tag, in the same commit (T8a, T8b and T8c each register one).
10. **Spec §9's "the `stream-contract.test.ts` pin of stream operations moves from 7 to 11" is right in count but
    hides the mechanism.** The pin is the sorted list at `stream-contract.test.ts:224`, filtered by a regex that
    matches only `stream-sessions|stream-targets`. Without widening the regex, the new routes never enter the pin and
    it stays at seven, which is a vacuous pass. T6 widens it; T9 reaches eleven; T8c pins the three `capture` routes
    in a sibling case.
11. **The relay sweep is daily (corrected, FP4).** It is the cron Worker's `JOBS` row `relay-sweep`
    (`apps/cron-worker/src/schedule.ts:56`): daily at 04:17 UTC on the hourly trigger, with `retry: false`. It is
    not in `seazn.club.workflow` (`app/api/cron/relay-sweep/route.ts:12-13`). W22 adds the 5-minute `stream-tick` job
    (T7b); the sweep stays as a backstop and keeps the beat-history purge.
12. **The cron Worker as merged in #909 (corrected, FP2 and FP3).** The brief said "POSTs with HMAC to
    `/api/internal/jobs/*`". The merged Worker instead:
    - POSTs with a shared `x-cron-secret` header to unchanged `/api/cron/*` routes (`relay-sweep` is the model: 503
      when `CRON_SECRET` is unset, before 401 on a mismatch);
    - declares jobs in one table, `apps/cron-worker/src/schedule.ts` (`JOBS`). **Each row already names its own
      `trigger`.** `dueJobs(scheduledTime, cron, jobs)` is already keyed on the trigger (`:110-112`), and `index.ts:10`
      already passes `controller.cron`. `Due` is `every | daily | weekly`, and **has no `minutes` kind**. There is no
      `jobCrontab`. The Worker sends **error events only, with zero Sentry check-in calls** (cron R5, pinned by
      `test/run.test.ts:229-240`). A row may declare `failureCounts`: dotted paths into the 200 body, where a value
      above 0 or an unreadable value reads as degraded (`call.ts:52-67`);
    - registers exactly the triggers `triggersOf(JOBS)` uses, in both envs (`test/drift.test.ts:76`), and requires
      every `/api/cron/*` route to have exactly one `JOBS` row;
    - already has a `relay-sweep` row (`schedule.ts:56`), which arrived in #902/#904. The old flag that "relay-sweep
      has no row" is void.

    T7b is therefore one `JOBS` row, one trigger (`*/5 * * * *`) in both envs, the Sentry throttle (R2), and the
    route. The existing test fixtures `TICK` and `WITH_TICK` already model that row. T7b replaces them with the real
    row.
13. **No competition has a locale.** The tree has `organizations.default_locale` (V281) and `users.locale`, nothing on
    competitions. W25's "competition's locale" is therefore the organisation's default, which the public league pages
    already read. T8a uses it.
14. **`reuseWindowOpen` has three callers** that must agree (`stream-credits.ts:125`): admission's balance waiver
    (`stream-sessions.ts:1216`), `consumeForSession` (`stream-credits.ts:169`) and the panel's `restartFree`
    (`stream-sessions.ts:1611`). T6b replaces all three with `restartAllowance`, and its tests prove they agree.
    (Line anchors corrected by FP5. `createSession` is at `:1140`. `:1402` is `openStreamStates`. The poll block is
    inside `currentSession` at `:1446-1530`, with the claim at `:1457`. The QR transaction is at `:1534-1553`.)

### False premises found by the pre-flight (FP1–FP23), and five found while amending (FP24–FP28)

| # | The plan said | The tree says | Lands in |
|---|---|---|---|
| FP1 | `main` tops at V428 | It tops at V429. | P1, T3, T13 |
| FP2, FP3 | T7b adds a `Due` minutes kind, `FAST_TRIGGER_CRON`, `jobCrontab`, a trigger-keyed `dueJobs`, check-ins and `retry: true` | Already done, or absent by design (P12). | T7b rewritten |
| FP4 | The relay sweep is scheduled in `seazn.club.workflow` | It is the cron Worker's row (P11). | P11 |
| FP5 | createSession :1107, admission :1183, restartFree :1577, poll block "from :1402" | :1140, :1216 and :1611. `:1402` is `openStreamStates`. The poll block is `:1446-1530`. | P14, T6, T6b, T7 |
| FP6 | `stream-sessions.test.ts:449-470`; panel `:583-590` | `:461-489`. Panel `:585` is the factory default (85 calls). | P6, T1 (A1) |
| FP7 | The warming anchor is in `domain/session.ts` | It is in `domain/expiry.ts:95` (on `createdAt`), tested by `domain/__tests__/expiry.test.ts`. Pre-V430 sessions have a null `warming_at`. | T6 (A8) |
| FP8 | T7 and T10 add `FakeIngest.setConnected` | `FakeIngest.setState(inputId, state)` already exists (`relay/fakes.ts:130-134`) and overrides the timer. | T7, T10 (A26) |
| FP9 | T3 should copy "V410's tenant policy" with `trg_set_org` | V410 creates **no policy, no trigger and no grant** (`V410:17-23`, enable+force `:407-422`). `rls-static.test.ts` asserts "creates no policy and no grant". The trigger+policy+GRANT pattern is V117 (`V117__device_links.sql:33-42`). | T3 (R1) |
| FP10 | Retry-After goes through the existing seam | The seam returns a count only (P4). | T8c (A15, R4) |
| FP11 | Domain files and `tok_enc` naming are free | `domain-purity.test.ts:15` pins **exactly five** domain files. `enc-boundary.test.ts` claim 2 (`:56-63`) already forbids `tok_enc` in every file outside `server/relay/`, tests included. Claim 4 (`:86-100`) lets only `telemetry.ts`, `relay-sweep.ts` and `stream-sessions.ts` name `fixture_stream_events`/`_samples` outside `__tests__`. | T3, T4a, T4b, T5 (A5, A6) |
| FP12 | `source 'phone'` is a DB-only change | The TS `EventSource` (`server/relay/telemetry.ts:16`) has no `"phone"`. | T6 (A6) |
| FP13 | `holdWindowSeconds.srt` comes from the capability | The capability says SRT is unmeasured and stays null (`relay/ports.ts:67-68`, `ingest-cf.ts:114`, the fake's `{rtmps:183, srt:null}`). Spec §6.4 sanctions 183 on the wire. | T8a (A17) |
| FP14 | Reuse `relay/bearer.ts` | It answers the wrong 401 shape, and misses the missing-header case (P9). | T8a (A17) |
| FP15 | Run `e2e/stream-overlay.spec.ts --project=walkthrough` | `WALKTHROUGH = /[\\/]e2e[\\/]walkthrough[\\/]/` (`playwright.config.ts:126`), so that command runs **zero** tests and exits 0. The spec belongs to `parallel`. | T12 (A19) |
| FP16 | `cd apps/cron-worker && npx vitest run` | In a worktree, `npx` resolves the main checkout's packages. | T7b: `pnpm exec vitest run` |
| FP17 | The W19 fresh read uses a sample "younger than `STREAM_POLL_MS`" | B0's bound is `COALESCED_SAMPLE_MAX_AGE_MS = 2 × STREAM_POLL_MS` (`:621`). At 1×, W19 refuses the sample B0 admits, and skips roughly every other tick. | T7 (A10) |
| FP18 | Redaction is the logger only | Spec §10.2 also drops the request body from Sentry captures. `lib/scrub-score-url.ts` scrubs only `dl_` tokens and the overlay `key=`. | T8c (A18) |
| FP19 | The deploy has `STREAM_INGEST_HOST`, `STREAM_PLAYBACK_HOST` | Neither is in `fly.toml` or `fly.stg.toml` `[env]`. `RELAY_DRIVERS` may be a Fly secret (unverified). | OG9, T13 |
| FP20 | `at: z.iso.datetime()` | zod v4's default admits `Z` only, and refuses an offset. | T1 (R5, A2) |
| FP21 | The label fits the contract | Entrant and team names reach 200 (`api-v1/schemas.ts:615` and siblings), so `"{A} v {B}"` reaches 403. A target `label` is capped at 80 at create, but the DB has no CHECK. | T8a (R7) |
| FP22 | `forEachSportAsync` drives each sport's finishing events through `appendEvent`, counted against the testkit's `builtinModules` | The testkit barrel does not export `builtinModules` (it lives in `packages/engine/src/sports/index.ts`). No helper drives per-sport finishing events through `appendEvent` (`append-event.ts:449`). | T3 (R8, A20) |
| FP23 | (unstated) W5 is local to T6 | Every existing organiser start has **no phone**: 233 `createSession(` calls in `stream-sessions.test.ts`, more in five other suites, and three Go-live walkthroughs. | T6, T12 (A7) |
| FP24 | A7's caller list includes `lib/__tests__/auth-session-audience.test.ts` | That file calls `lib/auth.ts`'s **login** `createSession(userId)` (`:54`, `:120`), not the stream one. A bare-name grep for `createSession(` also hits seven auth routes. The re-pin keys on the stream import or the stream route module instead. | T6 |
| FP25 | A7's rig helper pairs "through the real T5 ensure and claim path" | T5 has ensure but **no claim**. The pairing row is first written by T8b's `postBeat` (B6). | T6 helper, T8b re-point |
| FP26 | A15's `CounterFn` change reaches `rate-limit.test.ts` only | `__setRateLimitCounterForTests` is also called by `competitions/[id]/exports/scorer-sheets/__tests__/route.test.ts`, `scoring-durable-idempotency.test.ts`, `scoring-idem-cache-version.test.ts` and `scoring-replay-is-free.test.ts`. | T8c |
| FP27 | Every `completed` session has an end reason | `session.ts:230` completes with `s.endReason ?? signal.endReason ?? null`. Spec §6.8.4 has no row for a null. | T4b (R11) |
| FP28 | A27 (preflight): "B0 (in #909)" | B0's coalescing (`COALESCED_SAMPLE_MAX_AGE_MS`, first added in 8fd00ec18) and `V428__stream_poll_claim.sql` reached main through **#908** (58e8103e3, `feat/fixture-page-stream`). #909 (81d1f3d73) is the cron Worker, and brought `V429__weekly_digest_cron_once.sql`. The constraints are unchanged; only the attribution moves. | Global Constraints (A27 block) |

**Correct premises, kept by the pre-flight:** P3 (`_stream-migration.ts` reads only V410), P5 (`fakes.ts:125`), P7
(`V214__fixtures.sql:21`), P10 (`stream-contract.test.ts:220`, `:224`), P13 (V281), and P14's `stream-credits.ts:125`
and `:169`. Also kept:

- `lib/errors.ts`'s `HttpError(status, message, code?, extra?)`, so `headers` is a 5th field;
- `lib/http.ts`'s `handler()`, which wraps a non-Response in `{ok, data}`;
- V214's only trigger on `fixtures`, the insert trigger (`V263__routing_slugs.sql:52`).

**Spec deviations this plan makes (not rulings):**

- **The `stream-tick` answer.** Spec §6.11 says `{ticked, ended}`. T7b answers `{ticked, ended, failed, deferred}`.
  `failed` is the counter the Worker's `failureCounts` reads (R3 of the cron spec). `deferred` counts the sessions
  left for the next firing when the wall-clock budget runs out.
- **The descriptor's `warmingDeadline` for a session opened before V430.** Its `warming_at` is null, so the deadline
  falls back to `createdAt`, as the warming timeout does (A8).

## File Structure

**Created:**

| Path | Responsibility | Task |
|---|---|---|
| `docs/contracts/capture-qr.v2.json`, `capture-descriptor.v1.json`, `capture-beat.v1.json`, `capture-start.v1.json` + `fixtures/capture-*/…` | the cross-repo contract | T1 |
| `apps/web/src/server/api-v1/capture-schemas.ts` | zod twins of the four contracts (re-exported from `schemas.ts`) | T1 |
| `apps/web/src/server/api-v1/__tests__/capture-contract.test.ts` | checksums, zod ↔ JSON parity, fixtures | T1 |
| `docs/superpowers/specs/2026-10-01-capture-qr-v2-mockups/option-{a,b}.html` | the two Ready-state options | T2 |
| `db/migration/deltas/V430__capture_stream_codes.sql` | spec §8.1 | T3 |
| `apps/web/src/server/relay/domain/stream-code.ts` | C1–C5 | T4a |
| `apps/web/src/server/relay/domain/pairing.ts` | T1–T7, silent / present / not responding, A14 | T4a |
| `apps/web/src/server/relay/domain/slot.ts` | §5.4 | T4a |
| `apps/web/src/server/relay/domain/poll-seconds.ts` | §6.6 | T4a |
| `apps/web/src/server/relay/domain/beat-answer.ts` | §6.3.3 precedence | T4b |
| `apps/web/src/server/relay/domain/end-reason.ts` | §6.8.4 | T4b |
| `apps/web/src/server/relay/domain/phone-lost.ts` | ask 10 (§6.8.3) and W19 (§6.8.5) | T4b |
| `apps/web/src/server/usecases/stream-codes.ts` | ensure, reissue, resolve (C1) | T5 |
| `apps/web/src/app/api/v1/fixtures/[id]/stream-code/route.ts`, `…/reissue/route.ts`, `…/stream-settings/route.ts` | organiser routes | T5 |
| `apps/web/src/server/relay/__tests__/stream-code-tok.test.ts` | the `tok_enc` tamper and "tok_enc is null" assertions, under `server/relay/__tests__/` because enc-boundary claim 3 exempts only relay tests (A5) | T5 |
| `apps/web/src/server/relay/ingest-cred.ts` | the §6.4 rewrite and host rules | T8a |
| `apps/web/src/server/usecases/capture-phone.ts` | `getCode`, `postBeat`, `postStart` | T8a, T8b, T8c |
| `apps/web/src/server/api-v1/capture-http.ts` | bare bodies, refusals, no-store, the capture bearer reader (A17), Retry-After | T5 (`CaptureRefusalError`), T8a |
| `apps/web/src/server/__tests__/logger-redact.test.ts` | the pino `redact` spy test | T8c |
| `apps/web/src/app/api/v1/capture/codes/[code]/route.ts`, `…/beats/route.ts`, `…/start/route.ts` | phone routes | T8a–T8c |
| `apps/web/src/app/api/internal/relay/fake-ingest/[inputId]/route.ts` | fake connect control (local/ci) | T7 |
| `apps/web/src/server/usecases/stream-phone.ts` + `app/api/v1/fixtures/[id]/stream-phone/route.ts` | the panel's read model | T9 |
| `apps/web/src/server/usecases/__tests__/capture-model.test.ts` | the fast-check model (§11.1.4) | T10 |
| `apps/web/src/server/usecases/__tests__/restart-allowance.test.ts` | W23 boundary and sequence | T6b |
| `apps/web/src/app/api/cron/stream-tick/route.ts` + `route.test.ts` | the 5-minute tick job (W22) | T7b |
| `apps/web/e2e/helpers/fake-capture-phone.ts` | the phone, driven from the panel's paste code | T12 |
| `apps/web/e2e/walkthrough/capture-phone.spec.ts` | §11.1.5 | T12 |

**Modified:**

| Path | What changes | Task |
|---|---|---|
| `apps/web/src/lib/capture-qr.ts` | `CaptureQrV2` and `parseCaptureQrV2` added (T1); v1 removed (T11) | T1, T11 |
| `apps/web/src/server/relay/secret-columns.ts` | `insertStreamCode`, `openStreamCodeTok`, `wipeStreamCodeTok` | T5 |
| `apps/web/src/server/relay/__tests__/enc-boundary.test.ts`, `_stream-migration.ts`, `migration-shape.test.ts`, `rls-static.test.ts` | `tok_enc` owner; the delta fold (both CHECK forms, A4); the V430 shape; the four new tables under the V410 RLS model (R1) | T3 |
| `apps/web/src/server/relay/domain/__tests__/domain-purity.test.ts` | the pinned domain file list, plus four files (T4a) and three files (T4b) (A6) | T4a, T4b |
| `apps/web/src/server/relay/config.ts` | the §6 constants, `STREAM_SRT_ENABLED`, `tunable()` | T4a, T8a |
| `apps/web/src/server/relay/domain/session.ts` | `startCause`, `stop` reasons, `warmingAt`, `phone_not_paired` | T6 |
| `apps/web/src/server/relay/domain/expiry.ts` + `domain/__tests__/expiry.test.ts` | the warming timeout anchors on `warmingAt ?? createdAt` (A8) | T6 |
| `apps/web/src/server/relay/telemetry.ts` | `EventSource` gains `"phone"` (A6) | T6 |
| `apps/web/src/server/relay/__tests__/_session-rig.ts` | `pairPresentPhone(fixtureId)` (A7) | T6, re-pointed in T8b |
| `apps/web/src/server/usecases/stream-sessions.ts` | the QR writer re-pointed to the renamed columns (T3); `startBroadcast` (T6); `tickSession`, `tickOpenSessions` (T7, T7b); v1 QR removed (T11) | T3, T6, T7, T7b, T11 |
| `apps/web/src/server/api-v1/schemas.ts` | `StreamEndReason` widens; `StreamSessionCurrent` gains `startCause` (T6) and `restart` beside a derived `restartFree` (T6b); loses `qr` and `restartFree` (T11) | T6, T6b, T11 |
| `apps/web/src/lib/errors.ts`, `lib/http.ts`, `server/api-v1/http.ts`, `lib/rate-limit.ts`, `lib/cache.ts` | `HttpError.headers`; `Retry-After` from the Lua TTL; the capture presets (A15) | T8c |
| `apps/web/src/lib/scrub-score-url.ts` | `scrubSentryEvent` redacts capture codes and the Bearer, and drops capture request bodies (A18) | T8c |
| `apps/web/src/server/logger.ts` | pino `redact` paths | T8c |
| `apps/web/src/server/api-v1/key-scopes.ts`, `openapi.ts` | new routes, each registered by the task that creates it (A16) | T5, T8a, T8b, T8c, T9 |
| `apps/web/src/app/api/cron/relay-sweep/route.ts` (and the sweep use-case it calls) | ticks open sessions and purges beat history | T7 |
| `apps/web/src/components/v2/fixture-stream-panel.tsx`, `lib/stream-session-view.ts` | Ready states, pairing, v1 QR gone, `restartFree` → `restart` (A9) | T11 |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` + generated `lib/i18n-keys.ts` | `stream.code.*`, `stream.phone.*`, `stream.end.*`, `stream.restart.*` | T11 |
| `apps/web/e2e/walkthrough/stream-relay.spec.ts`, `stream-credits.spec.ts`, `directory-stream-destinations.spec.ts`, `e2e/mobile.spec.ts`, `lib/__tests__/e2e-ci-wiring.test.ts` | v2 rewrite; Go live through a paired fake phone (A7); registration; the tunables' pin (R10) | T11, T12 |
| `.github/workflows/e2e.yml` | the walkthrough tunables, on e2e-parallel's Start server and Playwright steps (R10). **STOP: owner OK required** (OG15). | T12 |
| `scripts/smoke.ts` | `captureV2Suite` in `SELECTABLE_SUITES` | T12 |
| `apps/web/src/server/usecases/stream-credits.ts`, `server/relay/domain/credits.ts` | `restartAllowance`, `restartIsFree` | T6b |
| `apps/cron-worker/src/schedule.ts`, `src/run.ts`, `wrangler.json`, `test/schedule.test.ts`, `test/run.test.ts`, `test/index.test.ts`, `test/drift.test.ts` | the `stream-tick` row, the `*/5` trigger, and the hourly Sentry throttle. `src/index.ts`, `src/call.ts` and `src/sentry.ts` are **not** touched. | T7b |

---

## Wave C — the contract (capture vendors it)

### Task 1: Publish the v2 contracts and remove v1

**Files:**

- Create:
  - `docs/contracts/capture-qr.v2.json`
  - `docs/contracts/capture-descriptor.v1.json`
  - `docs/contracts/capture-beat.v1.json`
  - `docs/contracts/capture-start.v1.json`
  - fixtures under `docs/contracts/fixtures/capture-qr.v2/`, `capture-descriptor.v1/`, `capture-beat.v1/` and
    `capture-start.v1/`
- Create: `apps/web/src/server/api-v1/capture-schemas.ts`
- Create: `scripts/gen-capture-contracts.ts`, a one-off generator that stays in the tree for the next v-bump
- Modify:
  - `apps/web/src/lib/capture-qr.ts` (add the v2 schema and parser; v1 stays until T11);
  - `apps/web/src/server/api-v1/schemas.ts` (re-export the twins).
- Delete:
  - `docs/contracts/capture-qr.v1.json` and `docs/contracts/fixtures/capture-qr.v1/`;
  - `apps/web/src/lib/__tests__/capture-qr.v1.test.ts`.
- Modify. **The v1 builder and parser live until T11, so these suites keep testing them. Only contract conformance
  goes** (A1, critical):
  - `components/v2/__tests__/fixture-stream-panel.test.tsx:585`. The `QR` constant read from the v1 fixture file is
    the **default of the `session()` factory** (`qr: QR`), which 85 calls across 140 cases use. **Replace the file
    read with an inline literal typed `CaptureQrV1`.** That type stays exported from `lib/capture-qr.ts` until T11.
    Delete only the cases that assert conformance to the v1 contract file. Every other case stays, unedited.
  - `server/usecases/__tests__/stream-sessions.test.ts:461-489` (D5). Drop the levels that compare against the v1
    contract's keys. **Keep the round trip from the real builder through `parseCaptureQr`**: the v1 parser lives
    until T11.
  - `lib/__tests__/stream-session-view.test.ts:420-426` and its case.
- Test: `apps/web/src/server/api-v1/__tests__/capture-contract.test.ts`

**Interfaces:**

- Produces, from `server/api-v1/capture-schemas.ts`, every name below, also re-exported from `schemas.ts`:
  - `CAPTURE_CODE_RE = /^[0-9a-hjkmnp-tv-z]{12}$/`
  - `CaptureEndReason`, `CaptureStartedBy`, `CaptureCause`, `CapturePhoneState`, `CaptureNotReady`,
    `CaptureStartFailed`
  - `CaptureWaiting`; `CaptureSession` (the five session states) and `CaptureDescriptor` (waiting plus the five),
    each a discriminated union on `state` (R5, A21)
  - `CaptureBeat`; `CaptureBeatAnswer`, a discriminated union on `state` over six states (R5, final)
  - `CaptureStartBody`, `CaptureStartOk`, `CaptureRefusal`
  - `CaptureRefusalCode = z.enum(["code_ended","not_a_stream_code","already_live","replaced","no_destination","no_credit","not_entitled","unavailable","invalid","rate_limited"])`
- Produces, from `lib/capture-qr.ts`:
  - `CaptureQrV2`
  - `parseCaptureQrV2(json): {ok:true; payload} | {ok:false; reason:"wrong_version"|"invalid"}`
  - `captureQrV2Text(p): string`

- [ ] **Step 1: Write the zod twins.** This file is the shape authority inside the web app, and the JSON is
  generated from it once (Step 3).

```ts
// apps/web/src/server/api-v1/capture-schemas.ts — the zod twins of docs/contracts/capture-*.json (spec §4, §6.3,
// §6.14). The JSON files are the cross-repo authority; capture-contract.test.ts pins parity both ways.
import { z } from "zod";

export const CAPTURE_CODE_RE = /^[0-9a-hjkmnp-tv-z]{12}$/;
const Code = z.string().regex(CAPTURE_CODE_RE);
const EpochS = z.number().int().min(1);
const PollSeconds = z.number().int().min(5).max(300);
const Url = z.url();

export const CaptureEndReason = z.enum([
  "stopped", "auto_stopped", "no_inbound_timeout", "target_rejected", "max_duration", "phone_lost", "failed",
]);
export const CaptureStartedBy = z.enum(["organiser", "automatic", "operator"]);
export const CaptureCause = z.enum(["organiser", "automatic", "operator", "rejoin"]);
export const CapturePhoneState = z.enum([
  "paired", "arming", "armed", "connecting", "publishing", "degraded", "reconnecting", "ended",
]);
export const CaptureNotReady = z.enum(["camera", "sound", "network", "held"]);
export const CaptureStartFailed = z.enum(["not-found", "cred-host", "config", "start-error"]);

const WaitingFields = {
  code: Code,
  label: z.string().min(1).max(200),
  venueTimezone: z.string().min(1).max(64),
  scheduledStart: EpochS.optional(),
  pollSeconds: PollSeconds,
  autoAllowed: z.boolean(),
  destinationName: z.string().min(1).max(80).nullable(),
  overlayUrl: Url.nullable(),
  heartbeatUrl: Url,
  startUrl: Url,
};

export const CaptureWaiting = z.strictObject({ state: z.literal("waiting"), ...WaitingFields });

/** W21: SRT is offered on srt://live.cloudflare.com:778 as Cloudflare issues it; RTMPS on the environment's live.*.
 *  No host is pattern-checked here: capture enforces the host per environment (G0-i, agreed 2026-10-01:
 *  cred.srt on exactly live.cloudflare.com or the env's live.*; RTMPS and every other URL strict live.*). */
export const CaptureCred = z.strictObject({
  srt: z.strictObject({
    url: z.string().min(1), streamId: z.string().min(1), passphrase: z.string().min(1),
    latencyMs: z.number().int().min(1),
  }).nullable(),
  rtmps: z.strictObject({ url: z.string().min(1), streamKey: z.string().min(1) }),
});

const SessionFields = {
  sid: z.uuid(),
  preferred: z.enum(["srt", "rtmps"]),
  playbackUrl: Url,
  holdWindowSeconds: z.strictObject({ srt: z.number().int().min(1).max(999), rtmps: z.number().int().min(1).max(999) }),
  maxDurationMinutes: z.number().int().min(1),
  warmingDeadline: EpochS,
  scoreUpdates: z.enum(["realtime", "polled"]),
  ...WaitingFields,
};

/** §6.3.1, per state (R5, A21): `cred` only in warming, live and ending (and only to the current phone, else
 *  absent); `endReason` present in ending, completed and failed, absent otherwise. A field from another state is
 *  refused, never ignored. */
const Warming = z.strictObject({ state: z.literal("warming"), ...SessionFields, cred: CaptureCred.optional() });
const Live = z.strictObject({ state: z.literal("live"), ...SessionFields, cred: CaptureCred.optional() });
const Ending = z.strictObject({ state: z.literal("ending"), ...SessionFields, cred: CaptureCred.optional(), endReason: CaptureEndReason });
const Completed = z.strictObject({ state: z.literal("completed"), ...SessionFields, endReason: CaptureEndReason });
const Failed = z.strictObject({ state: z.literal("failed"), ...SessionFields, endReason: CaptureEndReason });

export const CaptureSession = z.discriminatedUnion("state", [Warming, Live, Ending, Completed, Failed]);
export const CaptureDescriptor = z.discriminatedUnion("state", [CaptureWaiting, Warming, Live, Ending, Completed, Failed]);

export const CaptureBeat = z.strictObject({
  code: Code,
  slot: z.number().int().min(0),
  phone: z.string().min(16).max(64),
  claim: z.enum(["new", "resume"]).nullable(),
  device: z.strictObject({ model: z.string().min(1).max(80) }).nullable(),
  sid: z.uuid().nullable(),
  at: z.iso.datetime({ offset: true }),   // R5 (final): any offset accepted; the server normalises to UTC; the phone sends Z
  state: CapturePhoneState,
  cause: CaptureCause.nullable(),
  notReady: CaptureNotReady.nullable(),
  startFailed: CaptureStartFailed.nullable(),
  stopped: z.uuid().nullable(),
  mode: z.enum(["automatic", "operator"]),
  transport: z.enum(["srt", "rtmps"]).nullable(),
  bitrateKbps: z.number().int().min(0).max(100_000).nullable(),
  delivery: z.enum(["ok", "stalled", "unknown"]),
  deliveredLagS: z.number().min(0).max(99_999).nullable(),
  audioOk: z.boolean().nullable(),
  battery: z.strictObject({
    percent: z.number().int().min(0).max(100), charging: z.boolean(),
    drainPctPerHour: z.number().min(0).max(1000).nullable(),
  }).nullable(),
  thermal: z.number().int().min(0).max(6).nullable(),
  dataUsedMB: z.number().min(0).max(1_000_000).nullable(),
  appVersion: z.string().min(1).max(40),
  endReason: z.literal("operator-stopped").optional(),
});

/** R5 (final, capture agreed 2026-10-01): the beat answer is a discriminated union on `state`.
 *  Common fields: required on waiting, go-live, live and over; optional on replaced and taken.
 *  go-live: sid + startedBy. live: sid, NO startedBy. over: sid + endReason. replaced/taken: no sid, no startedBy,
 *  no endReason, and an optional `device` (G0-e, for the panel; the phone ignores it). */
const AnswerCommon = z.strictObject({
  label: z.string().min(1).max(200),
  scheduledStart: EpochS.nullable(),
  autoAllowed: z.boolean(),
  destinationName: z.string().min(1).max(80).nullable(),
  overlayUrl: Url.nullable(),
  pollSeconds: PollSeconds,
});
const AnswerDevice = z.strictObject({ model: z.string().min(1).max(80) });

export const CaptureBeatAnswer = z.discriminatedUnion("state", [
  AnswerCommon.extend({ state: z.literal("waiting") }),
  AnswerCommon.extend({ state: z.literal("go-live"), sid: z.uuid(), startedBy: CaptureStartedBy }),
  AnswerCommon.extend({ state: z.literal("live"), sid: z.uuid() }),
  AnswerCommon.extend({ state: z.literal("over"), sid: z.uuid(), endReason: CaptureEndReason }),
  AnswerCommon.partial().extend({ state: z.literal("replaced"), device: AnswerDevice.optional() }),
  AnswerCommon.partial().extend({ state: z.literal("taken"), device: AnswerDevice.optional() }),
]);
// Every branch must stay strict after .extend()/.partial(): each branch's `answer-tampered-<state>.json` (one extra
// key) is refused. That is the guard, not this comment.

export const CaptureStartBody = z.strictObject({ phone: z.string().min(16).max(64) });
export const CaptureStartOk = z.strictObject({ sid: z.uuid() });

export const CaptureRefusalCode = z.enum([
  "code_ended", "not_a_stream_code", "already_live", "replaced", "no_destination", "no_credit", "not_entitled",
  "unavailable", "invalid", "rate_limited",
]);
/** Every refusal: {code, message, ...extras}. Only already_live carries extras: {code, message, sid, startedBy}
 *  (unchanged by R5). */
export const CaptureRefusal = z.union([
  z.strictObject({ code: z.literal("already_live"), message: z.string(), sid: z.uuid(), startedBy: CaptureStartedBy }),
  z.strictObject({ code: CaptureRefusalCode.exclude(["already_live"]), message: z.string() }),
]);
```

  Add `CaptureQrV2` to `lib/capture-qr.ts`. The module is client-safe, so it does not import the server file.

```ts
export const CaptureQrV2 = z.strictObject({
  v: z.literal(2),
  code: z.string().regex(/^[0-9a-hjkmnp-tv-z]{12}$/),
  slot: z.number().int().min(0),
  tok: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});
export type CaptureQrV2 = z.infer<typeof CaptureQrV2>;
export function parseCaptureQrV2(json: unknown): { ok: true; payload: CaptureQrV2 } | { ok: false; reason: "wrong_version" | "invalid" } {
  if (typeof json === "object" && json !== null && "v" in json && (json as { v: unknown }).v !== 2) return { ok: false, reason: "wrong_version" };
  const p = CaptureQrV2.safeParse(json);
  return p.success ? { ok: true, payload: p.data } : { ok: false, reason: "invalid" };
}
/** The QR and paste-code text: exactly these four keys, in this order (W3; T11's regression pins it). */
export const captureQrV2Text = (p: CaptureQrV2): string => JSON.stringify({ v: 2, code: p.code, slot: p.slot, tok: p.tok });
```

- [ ] **Step 2: Write the failing parity test.** Create `capture-contract.test.ts` with these cases.
  - **Checksums.** For each of the four files, `sha256(file)` equals a constant in the test. A change to a contract is
    a deliberate bump and moves its constant in the same commit.
  - **Parity, structural.** For each `[file, twin]` pair, normalise both `z.toJSONSchema(twin, {target:"draft-2020-12"})`
    and the file. The normaliser drops `$schema`, `$id`, `title` and `description` at every level, and sorts
    `required` and `enum`. Then `expect(normalisedFile).toEqual(normalisedZod)`.
    - The descriptor's file is a `oneOf` over the six states. Compare per branch, matched by `properties.state.const`.
      Assert six branches were compared, which is the anti-vacuity count. The beat answer's `oneOf` is compared
      the same way: six branches.
  - **Fixtures.** Each `valid*.json` parses with its twin. Each `invalid-*` and `tampered*.json` is refused. **No
    fixture named `valid-*` is ever expected to be refused** (the old `valid-null-*` naming broke that rule). Assert
    the count per directory, and that it is never 0.
  - **Per-state field matrix (R5, A21).** Each state must admit only its own fields, and refuse a field from another
    state (for example, `endReason` on `live`). The test holds the matrix as typed from the spec's text (§6.3.1, and
    §6.3.3 as amended in spec §17.5). That text is the rulebook, not the code under test. Each cell is `required`,
    `optional` or `forbidden`.

    | Beat answer | `sid` | `startedBy` | `endReason` | `device` | the six common fields |
    |---|---|---|---|---|---|
    | `waiting` | forbidden | forbidden | forbidden | forbidden | required |
    | `go-live` | required | required | forbidden | forbidden | required |
    | `live` | required | **forbidden** | forbidden | forbidden | required |
    | `over` | required | forbidden | required | forbidden | required |
    | `replaced`, `taken` | forbidden | forbidden | forbidden | optional | optional |

    The six common fields are `label`, `scheduledStart` (`| null`), `autoAllowed`, `destinationName` (`| null`),
    `overlayUrl` (`| null`) and `pollSeconds`.

    | Descriptor | `cred` | `endReason` | `sid`, `preferred`, `playbackUrl`, `holdWindowSeconds`, `maxDurationMinutes`, `warmingDeadline`, `scoreUpdates` |
    |---|---|---|---|
    | `waiting` | forbidden | forbidden | forbidden |
    | `warming`, `live` | optional | forbidden | required |
    | `ending` | optional | required | required |
    | `completed`, `failed` | forbidden | required | required |

    For each cell, start from that state's hand-written valid fixture:
    - **forbidden:** add the field, taking its value from a fixture of a state that allows it, and expect a refusal;
    - **required:** delete the field, and expect a refusal;
    - **optional:** both the present form and the absent form parse.

    Count the cells checked. The beat answer has 6 states × 10 fields = 60 cells; the descriptor has 6 × 9 = 54.
    Assert both totals, so a skipped cell fails the run.
  - **Optional versus null.** For every field the matrix marks `optional` that is not also `| null`, a fixture
    `invalid-null-<state>-<field>.json` sets it to `null`. **That fixture is refused.** The fields are:
    - `scheduledStart` on waiting and on each session state;
    - `cred` on warming, live and ending;
    - `device`, `label`, `autoAllowed` and `pollSeconds` on replaced and taken.
  - **`at` (R5).** This is a positive/negative pair whose right answer differs from the old default.
    - `capture-beat.v1/beat-valid-at-offset.json` (`"at": "2026-10-01T15:30:00+05:30"`) **parses**.
    - `beat-invalid-at-local.json` (`"2026-10-01T10:00:00"`, no zone) is **refused**.
    - `beat-valid.json` carries `Z`.
  - **Strictness survives `.extend`/`.partial`.** Each beat-answer branch has `answer-tampered-<state>.json` (one
    extra key), and each one is refused. Assert six were checked.
  - **SRT nullable (A18).** `valid-live-srt-null.json` (with `preferred: "rtmps"`) parses.
  - **W21 hosts.** `valid-live.json` carries `srt.url: "srt://live.cloudflare.com:778"` and
    `rtmps.url: "rtmps://live.stg.seazn.club:443/live/"`. The descriptor file's `cred.srt.url.description` names
    both `live.cloudflare.com` and `live.*`; the test asserts both substrings.
  - **QR v2.** `capture-qr.v2/valid.json` parses. `tampered.json` (a fifth key, `cred`) and `wrong-version.json`
    (`v: 1`) are refused with their reasons. `captureQrV2Text` of the valid payload has exactly 4 keys.
  - **409 `already_live`** still carries `{code, message, sid, startedBy}` (`capture-start.v1/valid-already_live.json`).

  Run it:
  `cd $WT/apps/web && rm -f $SCRATCH/cq1-t1.json && pnpm vitest run src/server/api-v1/__tests__/capture-contract.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t1.json; echo EXIT=$?`.
  Expected: it FAILS, because the contract files are missing.

- [ ] **Step 3: Generate, then hand-finish, the JSON files.** Write `scripts/gen-capture-contracts.ts`. It imports the
  twins, writes `z.toJSONSchema(twin, {target: "draft-2020-12"})` per contract, and adds the header fields. Run it
  once with `cd $WT && pnpm tsx scripts/gen-capture-contracts.ts`. Then hand-add the `$id`, `title` and
  `description` strings:
  - `$id` is `https://seazn.club/contracts/<file>`.
  - Every description cites the spec section.
  - `cred.srt.url`: "srt://live.cloudflare.com:778 (as Cloudflare issues it, W21) or the environment's live.* host;
    null cred.srt means the RTMPS-only safety net (A18)".
  - `cred.rtmps.url`: "the environment's live.* host (live.seazn.club / live.stg.seazn.club)".
  - `cred`: "present only to the slot's current phone; absent = claim first (G0-d)".
  - Refusal: "`code` is the machine word the phone keys its copy on; `message` is a developer string, never shown".

  **Never hand-edit a structural key.** The parity test catches any drift.

- [ ] **Step 4: Write the fixtures** by hand, from the spec's shapes, never dumped from code.
  - Per contract: `valid.json`, one `valid-<member>.json` per union member or refusal code, `tampered.json` (an extra
    key) and `wrong-version.json` where versioned.
  - The descriptor's set: `valid-waiting.json`, `valid-warming.json`, `valid-live.json` (with `cred`),
    `valid-live-no-cred.json`, `valid-live-srt-null.json`, `valid-ending.json`, `valid-completed.json` and
    `valid-failed.json`.
  - `capture-beat.v1/` holds both the request and the answer, so its fixtures carry a prefix:
    - `beat-valid.json`, `beat-valid-at-offset.json` and `beat-invalid-at-local.json` for the request;
    - `answer-valid-<state>.json` for each of the six states;
    - `answer-valid-replaced-device.json`, `answer-valid-taken-bare.json` (no common fields at all), and
      `answer-tampered-<state>.json` ×6.
  - Boundaries: `slot` 0, `holdWindowSeconds` 999, `pollSeconds` 5 and 300.
  - The `invalid-null-<state>-<field>.json` set from Step 2.
  - Use a real-shaped sid, a 12-character code and a 22-character tok.

- [ ] **Step 5: Remove v1** (A1).
  - Delete `capture-qr.v1.json`, its fixture directory and `capture-qr.v1.test.ts`.
  - In `fixture-stream-panel.test.tsx`, replace the file read at `:585` with the inline `CaptureQrV1` literal.
  - Delete only the contract-conformance cases named in Files.
  - **Count the cases in each touched test file before and after, and put both counts in the commit body.** A drop
    larger than the conformance cases is a red, not a cleanup.
  - Each removed case's name goes in the commit body.
  - Update the header comment of `lib/capture-qr.ts`: v1 stays until T11 removes it, and its contract is gone (W4).

- [ ] **Step 6: Run T1's scope and confirm green.**

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t1.json && pnpm vitest run src/server/api-v1/__tests__/capture-contract.test.ts src/lib/__tests__/capture-qr.test.ts src/server/usecases/__tests__/stream-sessions.test.ts src/components/v2/__tests__/fixture-stream-panel.test.tsx src/lib/__tests__/stream-session-view.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t1.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t1.json
```

  Expected: `f: 0`, and five files. The panel suite's total drops only by its conformance cases (A1). Then
  `rtk proxy pnpm typecheck` exits 0, and `grep -rn -a "capture-qr.v1" $WT/apps/web/src $WT/docs/contracts` finds
  nothing outside comments that say "removed".

- [ ] **Step 7: Mutate.** Revert each mutation after it goes red, restoring from a `cp` backup and never with
  `git checkout`.
  - Make `scheduledStart` `.nullish()` in the twin. Red: the parity case, and the
    `invalid-null-waiting-scheduledStart` refusal.
  - Delete `failed` from `CaptureEndReason`. Red: parity, and the end-reason fixture.
  - Drop `.optional()` from `cred` on `Live`. Red: the `valid-live-no-cred` fixture.
  - Drop `{ offset: true }` from `at`. Red: `beat-valid-at-offset.json`.
  - Add `startedBy: CaptureStartedBy.optional()` to the `live` branch. Red: the matrix cell (live, `startedBy`).
  - Add `endReason: CaptureEndReason.optional()` to the `Live` descriptor branch. Red: the matrix cell (live,
    `endReason`).
  - Restore the panel suite's v1 file read after the v1 file is deleted. Red: the panel suite fails on ENOENT, which
    proves the inline literal is load-bearing (A1).

- [ ] **Step 8: Commit.** Use `git add` for the four contracts, the four fixture directories, the twins, the
  generator, `capture-qr.ts`, `schemas.ts`, the new test, the deleted v1 files and the three edited tests. Message:
  `feat(capture): publish capture QR v2 contracts; remove v1 (PR-1 T1)`. The body lists:
  - the mutations;
  - the removed v1 cases;
  - the before/after case counts per touched test file (A1);
  - R5's record: final, capture agreed 2026-10-01, a contract detail and not an owner ruling.

  **STOP: owner OK required (OG1)** before this commit is handed to capture to vendor. The hand-off happens before B3
  starts, and goes to the capture session as a recommendation-framed note, never as an owner ruling (class 17).

Owes: unit (parity, fixtures, the field matrix) and regression (v1 gone; QR has 4 keys).

### Task 2: The two Ready-state mockups (owner gate for T11)

**Files:**

- Create: `docs/superpowers/specs/2026-10-01-capture-qr-v2-mockups/option-a.html`
- Create: `docs/superpowers/specs/2026-10-01-capture-qr-v2-mockups/option-b.html`
- Create: the screenshots `…/shots/{a,b}-{320,768,1280}-{nophone,paired,silent,restarts,warming,reconnecting,paused}.png`

- [ ] **Step 1: Read** `docs/superpowers/specs/2026-09-30-fixture-page-stream-mockups/option-a.html`. It is the
  Option A frame the panel already ships. Read spec §6.12.

- [ ] **Step 2: Build two options**, each a static HTML page with seven states side by side:
  - Ready, no phone;
  - Ready, phone paired;
  - Ready, phone paired but silent;
  - Ready inside the reuse window, at the limit: "Free restarts used (3 of 3) — this one uses 1 credit" (W23);
  - Waiting, warming with the countdown (W24);
  - Live, "Reconnecting…" with the countdown (W24);
  - Live, "Reconnecting…" while the phone still beats: no countdown, with the reason "Phone is on a call — video
    paused" (O5).

  Every option uses §6.12's copy verbatim. Stay inside the existing tokens: lime (`--mk-lime`) is never text.
  - **Option A ("QR first").** The QR leads the body, and Go live sits disabled under it with the pairing reason.
    Once paired, the QR folds into "Show the code again".
  - **Option B ("Chain first").** The Phone node's state leads, and the QR sits in a card beside the picker (below it
    on a phone). Once paired, the card collapses to a one-line "Paired · Show the code again".

- [ ] **Step 3: Capture** each option at 320, 768 and 1280 with Playwright (`page.setViewportSize`, a full-page
  screenshot). Then check:
  - all 42 PNGs exist;
  - no two are byte-identical (`shasum` shows 42 distinct hashes);
  - `document.documentElement.scrollWidth <= innerWidth` at each width, printed per image.

- [ ] **Step 4: Commit** with `docs(capture): PR-1 Ready-state mockups, options A and B (T2)`. Then **STOP: owner OK
  required (OG2).** Send the owner both options at all three widths. T11 does not start until the owner names one.
  Record the choice and its date in spec §6.12 in the same branch.

Owes: nothing executable. This is the house "≥2 UI options" gate.

---

## Wave S — server

### Task 3: V430 — the schema, its trigger, the column drop with its live writer, and the boundary tests

**Files:**

- Create: `db/migration/deltas/V430__capture_stream_codes.sql`
- Modify:
  - `apps/web/src/server/relay/__tests__/_stream-migration.ts`: the delta fold, parsing both CHECK forms (A4);
  - `migration-shape.test.ts`: the V430 cases. Its existing reveal-column cases (`:259-282`) are re-pointed to the
    renamed columns (A3);
  - `enc-boundary.test.ts`: the `tok_enc` owner, and nothing else (A5);
  - `rls-static.test.ts` (R1). This is **no longer "only if"**. Its `STREAM_TABLES` is derived from V410 alone
    today, and it now derives from the fold. Each of the four V430 tables is asserted enable plus force, and the case
    "creates no policy and no grant" scans V430 too;
  - **the live QR writer, `apps/web/src/server/usecases/stream-sessions.ts:1534-1553` (A3, R3, critical).**
    - Delete the `qr_issued_first_at` update (`:1548`). The code's `first_shown_at` supersedes it (spec §6.13).
    - Rename the two credential columns in the update at `:1551-1552`.
    - `opts.reveal`'s semantics stay until T11.
    - Touch nothing else in the file. B0's hunk near `:1580-1600` is off limits (A27);
  - the writer's three test readers:
    - `app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts:240`;
    - `server/usecases/__tests__/stream-sessions.test.ts:2292-2312`;
    - `migration-shape.test.ts:259-282`.
- Test: `apps/web/src/server/usecases/__tests__/fixture-finished-at.test.ts` (new, DB-backed)

Re-pin the writer and its readers before starting:

```bash
grep -rn -a -E "qr_issued_first_at|credentials_reveal" $WT/apps/web/src
```

After the commit, that grep finds only V430's own assertions that the old names are absent.

**Interfaces:**

- Produces these tables and columns, exactly as spec §8.1:
  - `fixtures.finished_at` and the trigger `fixtures_track_finished`;
  - `fixture_stream_codes`, `fixture_stream_settings`, `fixture_stream_pairings` and `fixture_stream_phone_beats`;
  - on `fixture_stream_sessions`:
    - added: `start_cause`, `code_id`, `pairing_id`, `phone_beat`, `phone_beat_at` and `warming_at`;
    - dropped: `qr_issued_first_at`;
    - renamed: `credentials_revealed_first_at` and `credentials_reveal_count` become `credentials_served_first_at`
      and `credentials_served_count`, **in this commit, with the live writer re-pointed** (R3).
- Produces from `_stream-migration.ts`:
  - `STREAM_DELTAS: string`: V410 and every later delta matching `stream|capture`, in version order;
  - `STREAM_DELTA_COUNT: number`, the number of delta files folded (anti-vacuity);
  - `lastCheckList(table, column): string[]`. It parses **both** CHECK forms: the inline unnamed column check
    (`end_reason text null check (end_reason in (…))`, V410 `:175`; `source text not null check (source in (…))`,
    V410 `:307`), and the `add constraint <name> check (<column> in (…))` form. The **last** definition in version
    order wins;
  - `STREAM_TABLES`, now derived from `STREAM_DELTAS`, so it gains the four V430 tables.

- [ ] **Step 1: Write the migration** from spec §8.1 verbatim, plus the following.
  - **RLS: the V410 pattern (R1).** Each of the four new tables gets `alter table … enable row level security;
    alter table … force row level security;`, exactly as V410 does at `:407-422`.
    - **No policy, no `trg_set_org` trigger and no grant to `app_user`.** V410 creates none of these
      (`V410:17-23`), and `rls-static.test.ts` asserts "creates no policy and no grant".
    - Every read and write goes through the non-tenant `sql`. The use-case writes `org_id` from the code row or the
      session row.
    - The `trg_set_org` + tenant policy + GRANT pattern belongs to V117 (`V117__device_links.sql:33-42`). R1 rejected
      it, for two reasons. The phone routes have no org session, because the tok is the auth. And it would split
      the stream tables across two models.
    - Spec §8.1's "the V117 / V410 pattern … then under `withTenant`" is amended by spec §17.1.
  - **The end-reason check (A4).** V410 declares it inline and unnamed (`V410:175`), so Postgres names it
    `fixture_stream_sessions_end_reason_check`. V430 drops it and re-adds it **under that same name in one `alter`**:
    `alter table fixture_stream_sessions drop constraint fixture_stream_sessions_end_reason_check, add constraint
    fixture_stream_sessions_end_reason_check check (end_reason in
    ('stopped','operator_stopped','auto_stopped','phone_lost','max_duration'));`
    - Before writing it, confirm the default name on the fresh DB with `\d fixture_stream_sessions`, and pin it in a
      comment.
    - The named `fixture_stream_sessions_end_reason_state` constraint is unchanged.
  - **The events source.** V410 declares `fixture_stream_events.source`'s check inline too (`:307`). Drop it by its
    default name, which is `fixture_stream_events_source_check`; confirm it with `\d fixture_stream_events`. Then
    re-add it with `'phone'` added. The rest of V410's list is copied exactly.
  - **The finished-at backfill.** The `update fixtures set finished_at = now() …` line must run **after** the
    trigger, or the trigger would stamp it again.
  - **The drop and rename (R3)** stay in V430, as spec §8.1 has them. They land in **this** commit, together with
    the writer and its readers (see Files).
    - From this commit until T11 removes `?reveal=1`, `credentials_served_*` also count organiser reveals.
    - From T8a, they also count descriptor serves (spec §17.3).
    - Record this interim meaning in the commit body.

- [ ] **Step 2: Write the failing tests.**
  - **`migration-shape.test.ts` gains a V430 block:**
    - the four tables exist. Each has RLS enabled **and** forced, and no row in `pg_policies` (R1);
    - `fixture_stream_codes_one_active` and `fixture_stream_pairings_one_current` are partial unique indexes;
    - `tok_enc` is nullable, with the check `ended_at is null or tok_enc is null`;
    - the end-reason check admits exactly five values. They are read from the parsed delta, never typed, and are
      compared with T6's `StreamEndReason.options` later;
    - the end-reason constraint's name, read from `pg_constraint` on the fresh DB, is
      `fixture_stream_sessions_end_reason_check`. That is Postgres's default for V410's inline check (A4);
    - `qr_issued_first_at` is absent, and the two renamed columns are present. The existing reveal cases
      (`:259-282`) read the new names (A3).
  - **The fold (A4), in `stream-contract.test.ts`.**
    - **Ordering differential.** Folding V410 alone yields V410's two end-reason values; folding V410 + V430 yields
      five. Both expectations are read from the two SQL files' `in (…)` lists, never typed.
    - Both CHECK forms parse: the inline form (V410 `:175` and `:307`) and V430's `add constraint` form.
    - `fixture_stream_events.source`: the folded list contains `'phone'`, and V410's alone does not.
    - **Anti-vacuity:** `STREAM_DELTA_COUNT` is greater than 0, and the folded files include V410 and V430 by name.
  - **`enc-boundary.test.ts`.** Add `"tok_enc"` to `STREAM_COLUMNS`. The first case ("every declared `*_enc` column
    is owned") stays exactly as written, and now passes with the new column.
    **Add no new case.** The old plan's "outside `server/relay/`, no file names `tok_enc`" duplicated claim 2
    (`:56-63`), which already scans every file outside `server/relay/`, tests included (A5).
  - **`rls-static.test.ts` (R1).**
    - `STREAM_TABLES` now comes from the fold.
    - Assert `fixture_stream_codes`, `fixture_stream_settings`, `fixture_stream_pairings` and
      `fixture_stream_phone_beats` by name, each enable plus force.
    - The count pin (today `>= 8`) rises by those four.
    - "Creates no policy and no grant" scans the fold.
  - **`fixture-finished-at.test.ts` (DB-backed).**
    - For every pair in (the §3 finished set ∪ {scheduled, in_play})², an update from A to B leaves `finished_at`
      correct.
    - Entering the set stamps it, staying inside keeps the first stamp, and leaving clears it.
    - The pairs come from the V214 CHECK list, parsed from the file. Assert `count === 49`.
    - **The revert case (C5).** A corrected result that moves a fixture out of the finished set clears
      `finished_at`. Finishing it again stamps a new time.
    - **Another sport (R8, A20).** The trigger keys on `fixtures.status`, and no sport module writes that column. So
      the sweep runs over the **status writers**, not over the sport registry. FP22 rules out the old mechanism: the
      testkit exports no `builtinModules` and has no per-sport finishing driver.
      - Re-pin the writers by behaviour: `grep -rn -a` for writes of `fixtures.status` under `apps/web/src/server`.
      - Drive each writer that moves a fixture into or out of the finished set through its real use-case: score
        finalize, walkover/forfeit, abandon, cancel, and an admin correction.
      - Assert `finished_at` after each.
      - Report the count of writers swept. **0 fails the run.**
      - The file carries `// single-sport: finished_at keys on fixtures.status; no sport module writes it`, so
        `matrix:single-sport --check` stays flat.
  - **The live writer (A3).** `stream-sessions.test.ts`'s reveal case (`:2292-2312`) and `routes.test.ts:240` read
    the renamed columns and stay green.

- [ ] **Step 3: Run** `pnpm db:apply` on your fresh DB (and `sync:sports`; confirm `show data_directory` is yours),
  then run the scope below. Confirm the new cases fail before Step 1's file exists, and pass after it.

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t3.json && pnpm vitest run src/server/relay/__tests__/migration-shape.test.ts src/server/relay/__tests__/enc-boundary.test.ts src/server/relay/__tests__/rls-static.test.ts src/server/relay/__tests__/port-boundary.test.ts src/server/usecases/__tests__/fixture-finished-at.test.ts src/server/api-v1/__tests__/stream-contract.test.ts src/server/usecases/__tests__/stream-sessions.test.ts "src/app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts" --reporter=json --outputFile=$SCRATCH/cq1-t3.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t3.json
cd $WT && pnpm matrix:single-sport --check; echo EXIT=$?
```

- [ ] **Step 4: Mutate.** Restore each from a `cp` backup.
  - The trigger without the `old.status not in (…)` guard. Red: "staying inside the set keeps the first stamp".
  - The backfill before the trigger. Red: a backfilled row's stamp moves on its next in-set update.
  - Drop `"tok_enc"` from `STREAM_COLUMNS`. Red: the ownership case.
  - **Revert the writer's column name** to `credentials_reveal_count` (A3). Red: `stream-sessions.test.ts`'s reveal
    case.
  - Make `lastCheckList` parse only the named form. Red: the V410-alone differential (zero values read).
  - Add a `create policy` on one V430 table. Red: `rls-static.test.ts`'s "creates no policy and no grant".

- [ ] **Step 5: Commit** with `feat(capture): V430 stream codes, pairings, beat history, finished_at (T3)`. The body
  lists:
  - the mutations;
  - the status writers swept, and their count;
  - R1 and R3, with the interim meaning of `credentials_served_*`.

Owes:

- unit (shape, the fold);
- use-case (the trigger, and every status writer);
- regression (the end-reason check admits five; the live writer survives the rename).

### Task 4a: Pure domain — code, pairing, slot, cadence

**Files:**

- Create: `apps/web/src/server/relay/domain/stream-code.ts`, `pairing.ts`, `slot.ts` and `poll-seconds.ts`
- Modify: `apps/web/src/server/relay/config.ts` (the constants, and `tunable`)
- Modify: `apps/web/src/server/relay/domain/__tests__/domain-purity.test.ts` (A6). Its "has the five units" case
  (`:15`) pins **exactly** five files today. Add this task's four, in this commit, which makes nine.
- Test: `apps/web/src/server/relay/domain/__tests__/{stream-code,pairing,slot,poll-seconds}.test.ts`

**Acceptance, beyond the tables (A6).** `domain-purity.test.ts` stays green over the four new files. It forbids
imports from `@/lib/db`, `@/server/logger` and the relay adapters (`ports`, `fakes`, `ingest-cf`, `runner-fly`,
`fly-client`, `drivers`, `crypto`, `secret-columns`, `tokens`). It also forbids `fetch(`, `Date.now()`, `new Date()`,
`setTimeout` and `process.env`. So `now` is always passed in, and `tunable()` (which reads `process.env`) lives in
`config.ts`, never in a domain file.

**Interfaces:**

- Produces, from `config.ts`:

```ts
export const CODE_GRACE_AFTER_FINISH_MINUTES = 120;
export const DEAD_PHONE_TAKEOVER_SECONDS = 60;
export const PHONE_SILENT_FLOOR_SECONDS = 60;
export const PHONE_SILENT_SLACK_SECONDS = 30;
export const NOT_RESPONDING_BEATS = 3;
export const POLL_STARTING_SECONDS = 5;
export const POLL_NEAR_SECONDS = 10;
export const POLL_FAR_SECONDS = 60;
export const POLL_NEAR_WINDOW_MINUTES = 30;
export const PHONE_LOST_LIVE_MINUTES = 15;
export const PHONE_BEAT_RETENTION_HOURS = 24;
export const LOW_BATTERY_PERCENT = 20;
export const HOT_THERMAL_STATUS = 3;
/** §6.15 / AGENTS.md #20: an override is honoured ONLY when ENV_NAME ∈ {local, ci}; every guard pins the DEFAULT. */
export function tunable(name: "DEAD_PHONE_TAKEOVER_SECONDS" | "PHONE_LOST_LIVE_MINUTES" | "PHONE_SILENT_FLOOR_SECONDS"
  | "CODE_GRACE_AFTER_FINISH_MINUTES", fallback: number, env: NodeJS.ProcessEnv = process.env): number;
```

- Produces, from `domain/stream-code.ts`:
  - `normaliseCode(raw: string): string | null`, which trims, lower-cases and tests `CAPTURE_CODE_RE`
  - `type CodeView = { endedAt: Date | null; finishedAt: Date | null }`
  - `codeStatus(v: CodeView, now: Date, hasOpenSession: boolean): "active" | "finishing" | "ended" | "expiry_due"`
  - `codeServes(i: { status; callerIsOpenSessionPhone: boolean; sessionCreatedBeforeEnd: boolean; call: "get" |
    "beat" | "claim" | "start" }): boolean`, which is C1, with C1b admitting only `get` and `beat` (no claim, no
    start)
- Produces, from `domain/pairing.ts`:
  - `type ClaimInput = { kind: "new" | "resume" | null; caller: string; current: { phone: string } | null; slot: SlotState }`
  - `type ClaimOutcome = { result: "accept" | "takeover" | "taken" | "replaced" | "none"; row: "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8" }`
  - `decideClaim(i: ClaimInput): ClaimOutcome`
  - `isSilent(lastBeatAt: Date, answeredPoll: number, now: Date): boolean`, plus `isPresent` and `isNotResponding`
  - `deadForTakeover(i: { lastBeatAt: Date; freshReadConnected: boolean; lastConnectedAt: Date | null; liveSince: Date }, now: Date): boolean`
- Produces, from `domain/slot.ts`:
  - `type SlotState = "empty" | "paired" | "starting" | "armed" | "live" | "live_dead"`
  - `slotState(i: { hasCurrent: boolean; open: { state: SessionState; firstIngestAt: Date | null } | null; dead: boolean }): SlotState`
- Produces, from `domain/poll-seconds.ts`:
  - `pollSecondsFor(i: { open: SessionState | null; fixtureStatus: string; scheduledAt: Date | null; finished: boolean }, now: Date): number`

- [ ] **Step 1: Write the failing tables.** Each row is a case, and each file states its empty case first.
  - **`stream-code.test.ts`.**
    - Every (status × caller × call) row of C1, including C1b and its negative pair (the same caller after the
      session ends gets no service).
    - Expiry at grace − 1 s and at the grace exactly, with the grace read from `CODE_GRACE_AFTER_FINISH_MINUTES`.
    - A reverted result (`finishedAt: null`) reads `active`.
    - `normaliseCode`: `" ABCDEFGHJKMN "` → `"abcdefghjkmn"`; `"abcdefghijkl"` (has `i` and `l`) → `null`.
  - **`pairing.test.ts`.**
    - T1–T8 (T8 is "beat from current"), each row asserting both `result` and `row`.
    - T4's three conjuncts, each failing alone.
    - `isSilent` at the boundary for each cadence in `[POLL_STARTING_SECONDS, POLL_NEAR_SECONDS, POLL_FAR_SECONDS]`,
      with the expected threshold computed from the constants.
    - The ordering-differential case: a phone silent at 60 s on a 10 s cadence but not silent at 60 s on a 60 s
      cadence.
    - Ask 2's rule: `resume` with `current: null` → `accept`, even for a phone once replaced.
  - **`slot.test.ts`.** The empty case first (`hasCurrent:false, open:null` → `empty`), then every §5.4 row. The cases
    cover `warming` with ingest → `live` (a reconnect) and `ending` → `live`.
  - **`poll-seconds.test.ts`.** Every §6.6 row:
    - at T−30 min ± 1 s, with the window from `POLL_NEAR_WINDOW_MINUTES`;
    - with no `scheduled_at`;
    - finished → far.
  - **`tunable`.**
    - With `ENV_NAME=stg` and `DEAD_PHONE_TAKEOVER_SECONDS=1`, the result is 60.
    - With `ENV_NAME=ci`, the result is 1.
    - The guard asserts the **default** constant is 60. It never asserts the live value.

- [ ] **Step 2: Run** and see the cases fail, because the modules are missing.

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t4a.json && pnpm vitest run src/server/relay/domain/__tests__/stream-code.test.ts src/server/relay/domain/__tests__/pairing.test.ts src/server/relay/domain/__tests__/slot.test.ts src/server/relay/domain/__tests__/poll-seconds.test.ts src/server/relay/__tests__/config.test.ts src/server/relay/domain/__tests__/domain-purity.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t4a.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t4a.json
```

  `domain-purity.test.ts` reds first, because the four files are missing from its pin. That is the red for A6.

- [ ] **Step 3: Implement** the four modules as strategy tables: one `const` array of `{when, then}` rows per machine,
  scanned in order. This is the `session.ts` precedent and the house "lookup table over if/else" rule. The core of
  `decideClaim`:

```ts
const CLAIM_ROWS: readonly { row: ClaimOutcome["row"]; when: (i: ClaimInput) => boolean; result: ClaimOutcome["result"] }[] = [
  { row: "T1", when: (i) => i.kind === "new" && (i.current === null || i.current.phone === i.caller), result: "accept" },
  { row: "T3", when: (i) => i.kind === "new" && i.slot === "live", result: "taken" },
  { row: "T4", when: (i) => i.kind === "new" && i.slot === "live_dead", result: "takeover" },
  { row: "T2", when: (i) => i.kind === "new", result: "takeover" },
  { row: "T5", when: (i) => i.kind === "resume" && (i.current === null || i.current.phone === i.caller), result: "accept" },
  { row: "T6", when: (i) => i.kind === "resume", result: "replaced" },
  { row: "T8", when: (i) => i.kind === null && i.current?.phone === i.caller, result: "none" },
  { row: "T7", when: () => true, result: "replaced" },
];
export function decideClaim(i: ClaimInput): ClaimOutcome {
  const hit = CLAIM_ROWS.find((r) => r.when(i))!;   // the last row always matches; a test asserts it is reached
  return { result: hit.result, row: hit.row };
}
```

- [ ] **Step 4: Run Step 2's command.** Expected: green, with six files.

- [ ] **Step 5: Mutate.** Each mutation is reverted after its red.
  - T6 → `accept`. Red: "resume from a phone that is not current".
  - Delete each T4 conjunct in turn: three mutants, three reds.
  - In `isSilent`, `>=` → `>`. Red: the boundary case.
  - `tunable` ignores `ENV_NAME`. Red: the stg case.
  - In `codeServes`, C1b also admits `claim`. Red: "ended code, new claim".

- [ ] **Step 6: Commit** with `feat(capture): pure code, pairing, slot and cadence tables (T4a)`, listing the
  mutations in the body.

Owes: unit.

### Task 4b: Pure domain — beat answer, end reasons, phone lost

**Files:**

- Create: `apps/web/src/server/relay/domain/beat-answer.ts`, `end-reason.ts` and `phone-lost.ts`
- Modify: `apps/web/src/server/relay/domain/__tests__/domain-purity.test.ts`. Add this task's three files to the pin,
  which makes twelve. The acceptance is as in T4a (A6).
- Test: `apps/web/src/server/relay/domain/__tests__/{beat-answer,end-reason,phone-lost}.test.ts`

**Interfaces:**

- Consumes `SlotState` and `decideClaim` (T4a), and `SessionState` and `FailReason` (`domain/session.ts`).
- **The end-reason tables key on T1's `CaptureEndReason`, never on `domain/session.ts:44`'s `endReason` (A6).**
  `session.ts`'s type is widened only in T6 (B4). Keying on it here would red `tsc` in B3. `DbEndReason` is the
  `DB_END_REASONS` tuple below; T6 later makes `Session.endReason` agree with it.
- **R11 (owed, controller) before this task commits.** `session.ts:230` can complete a session with `endReason:
  null`, and spec §6.8.4 has no row for that. Both unions require a wire `endReason` (`over`, and the descriptor's
  `completed`).
  - *Recommendation: map it to `failed`.*
  - This task writes the case `wireEndReason({endReason: null, failReason: null})` for a terminal row, and asserts
    R11's value.
  - **The guard.** `wireEndReason`'s signature returns a `WireEndReason` for every terminal row. A row it cannot map
    (a reason outside `DB_END_REASONS` and `StreamFailReason`) **throws** the named error `TerminalWithoutReason`,
    and a test reaches that throw. It never returns `null` into an answer whose contract requires `endReason`. A
    non-terminal row is not its input, and the callers (T8a, T8b) call it only for `ending`, `completed` and
    `failed`.
- Produces, from `beat-answer.ts`:

```ts
export type BeatAnswerInput = {
  claim: ClaimOutcome | null;          // null when the beat carried no claim
  callerCurrent: boolean;              // judged BEFORE this beat's own `ended` is applied (§6.3.3 row 2)
  namedEnded: { sid: string; endReason: WireEndReason } | null;  // the beat's sid or stopped, if terminal
  slot: SlotState;
  open: { sid: string; startedBy: "organiser" | "automatic" | "operator" } | null;
};
export type BeatAnswerCore =
  | { state: "taken" } | { state: "replaced" }
  | { state: "over"; sid: string; endReason: WireEndReason }
  | { state: "waiting"; starting: boolean }
  | { state: "go-live"; sid: string; startedBy: "organiser" | "automatic" | "operator" }
  | { state: "live"; sid: string };
export function beatAnswer(i: BeatAnswerInput): BeatAnswerCore;
```

- Produces, from `end-reason.ts`:
  - `type WireEndReason = z.infer<typeof CaptureEndReason>`
  - `wireEndReason(row: { endReason: DbEndReason | null; failReason: FailReason | null }): WireEndReason`. It is
    called for terminal rows only. Its null-reason row is R11's value, and anything unmappable throws
    `TerminalWithoutReason`.
  - `DB_END_REASONS = ["stopped","operator_stopped","auto_stopped","phone_lost","max_duration"] as const`
- Produces, from `phone-lost.ts`:

```ts
export function warmingPhoneLost(i: {
  state: SessionState; firstIngestAt: Date | null; hasCurrentPairing: boolean;
  lastBeatAt: Date | null; answeredPollSeconds: number; heardGoLive: boolean;
}, now: Date): boolean;      // ask 10, §6.8.3
export function livePhoneLost(i: {
  state: SessionState; firstIngestAt: Date | null; phoneBeatAt: Date | null;
  freshReadConnected: boolean; lastConnectedSampleAt: Date | null;
}, now: Date, lostMinutes: number): boolean;   // W19, §6.8.5 — lostMinutes = tunable("PHONE_LOST_LIVE_MINUTES", PHONE_LOST_LIVE_MINUTES)
/** W24: the panel's countdown, on the server clock. null = nothing to show. */
export function lostCountdown(i: {
  state: SessionState; firstIngestAt: Date | null; warmingAt: Date | null; phoneBeatAt: Date | null;
  ingestConnected: boolean; lastConnectedSampleAt: Date | null;
}, now: Date, cfg: { lostMinutes: number; warmingMinutes: number; quietSeconds: number }):
  { kind: "warming" | "live"; elapsedMs: number; remainingMs: number } | null;
```

- Produces, in `config.ts`: `RECONNECT_QUIET_SECONDS = 30`.

- [ ] **Step 1: Write the failing tables.**
  - **`beat-answer.test.ts`.**
    - Every row of §6.3.3 in precedence order.
    - The four G0-g combinations: a refused `new` with an ended `stopped` → `taken`; a refused `resume` → `replaced`;
      no claim and not current → `replaced`; current with an ended X → `over X`.
    - `armed` → `go-live` with `startedBy`; `starting` → `waiting` with `starting: true`.
    - A row-ordering differential: swap rows 2 and 3 and assert the answer changes for the case "not current and
      names an ended X".
  - **`end-reason.test.ts`.**
    - Every DB end and fail reason maps to exactly one wire value.
    - The anti-vacuity count equals `DB_END_REASONS.length + FailReason`'s declared count, read from
      `StreamFailReason.options` (11 today).
    - `operator_stopped` → `stopped`. Every unnamed fail reason → `failed`.
    - A terminal row with neither reason (`session.ts:230`'s completion) → R11's value. An unmappable row →
      `TerminalWithoutReason` is thrown.
  - **`phone-lost.test.ts`.**
    - Ask 10:
      - at the floor, with the threshold derived from `max(PHONE_SILENT_FLOOR_SECONDS, poll + PHONE_SILENT_SLACK_SECONDS)`;
      - a 60 s-cadence phone that has not heard go-live is not ended at 60 s and is ended at 90 s;
      - `firstIngestAt` set → never.
    - W19:
      - all three conjuncts at exactly `lostMinutes` → true;
      - each conjunct at `lostMinutes` − 1 s alone → false: three cases;
      - `freshReadConnected: true` → false;
      - `firstIngestAt: null` → false (that is ask 10's case);
      - `phoneBeatAt: null` falls back to `firstIngestAt`.
      - `lostMinutes` is passed as `PHONE_LOST_LIVE_MINUTES`; a second run with `lostMinutes = 1` proves the
        parameter is used.
    - **`lostCountdown` (W24).** The empty case first: connected → null.
      - Live, no video and no beat for `RECONNECT_QUIET_SECONDS` − 1 s → null; at 30 s → `{kind:"live", elapsedMs:
        30_000, remainingMs: lostMinutes·60 000 − 30 000}`.
      - Live, video gone 10 min but the phone beat 2 min ago → **null** (O5, ruled 2026-10-01: no countdown while the phone beats).
      - Live, the two silences differ (beat 12 min, video 9 min) → elapsed is the **shorter** (9 min) and remaining
        is `lostMinutes` − 9 min. This is the ordering differential: the longer silence gives the wrong answer.
      - Warming, no video, 30 s after `warmingAt` → `{kind:"warming"}`, with remaining = `warmingAt` +
        `WARMING_TIMEOUT_MINUTES` − now.
      - Every expected value comes from `PHONE_LOST_LIVE_MINUTES`, `WARMING_TIMEOUT_MINUTES` and
        `RECONNECT_QUIET_SECONDS`.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t4b.json && pnpm vitest run src/server/relay/domain/__tests__/beat-answer.test.ts src/server/relay/domain/__tests__/end-reason.test.ts src/server/relay/domain/__tests__/phone-lost.test.ts src/server/relay/domain/__tests__/domain-purity.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t4b.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t4b.json
```

- [ ] **Step 3: Implement.** `beatAnswer` is a precedence list, the same shape as `CLAIM_ROWS`. `livePhoneLost`:

```ts
export function livePhoneLost(i: Parameters<typeof livePhoneLost>[0], now: Date, lostMinutes: number): boolean {
  if (i.firstIngestAt === null || !(i.state === "live" || i.state === "warming")) return false;
  const limitMs = lostMinutes * 60_000;
  const beatAge = now.getTime() - (i.phoneBeatAt ?? i.firstIngestAt).getTime();
  const videoAge = now.getTime() - (i.lastConnectedSampleAt ?? i.firstIngestAt).getTime();
  return beatAge >= limitMs && !i.freshReadConnected && videoAge >= limitMs;
}
```

  A `warming` session with `firstIngestAt` set is a reconnect, which is still "live" for W19 (§5.4).

- [ ] **Step 4: Run Step 2's command.** Expected: green.

- [ ] **Step 5: Mutate.** Each W19 conjunct is dropped in turn (three mutants). The other mutants:
  - `>=` → `>`;
  - swap rows 2 and 3 of `beatAnswer`;
  - `operator_stopped` → `failed`;
  - ask 10 with a flat 60 s;
  - `lostCountdown` takes the longer silence (`Math.max`). Red: the 12/9 case;
  - `lostCountdown` ignores the beat. Red: the O5 case.

  Each one must go red.

- [ ] **Step 6: Commit** with `feat(capture): beat answer, end reasons, ask-10, W19 and the countdown (T4b)`, listing
  the mutations in the body.

Owes: unit.

### Task 5: Stream codes — ensure, reissue, resolve, and the organiser routes

**Files:**

- Create: `apps/web/src/server/usecases/stream-codes.ts`
- Create the routes:
  - `apps/web/src/app/api/v1/fixtures/[id]/stream-code/route.ts` (POST ensure);
  - `…/stream-code/reissue/route.ts` (POST);
  - `…/stream-settings/route.ts` (PUT `{targetId}`).
- Modify:
  - `apps/web/src/server/relay/secret-columns.ts` (the `tok_enc` SQL);
  - `apps/web/src/server/api-v1/key-scopes.ts` (`NEVER_KEY_ROUTES`: the three routes);
  - `apps/web/src/server/api-v1/openapi.ts` (`ROUTES`).
- Create: `apps/web/src/server/api-v1/capture-http.ts`, holding `CaptureRefusalError` only. T8a extends it.
- Test:
  - `apps/web/src/server/usecases/__tests__/stream-codes.test.ts` (DB-backed). It never names `tok_enc` (A5);
  - **`apps/web/src/server/relay/__tests__/stream-code-tok.test.ts`** (new, DB-backed). It holds every assertion that
    has to name `tok_enc`: the forced-UPDATE tamper case, and "`tok_enc` is null on an ended code". Enc-boundary
    claim 3 exempts relay `__tests__`, while claim 2 forbids `tok_enc` in **every** file outside `server/relay/`,
    usecase tests included (A5);
  - `app/api/v1/fixtures/[id]/stream-code/__tests__/routes.test.ts`.

**Acceptance, beyond the cases (A5).**

- `grep -rn -a tok_enc $WT/apps/web/src` hits only `server/relay/` (non-test) and `server/relay/__tests__/`, **comments
  included**. Enc-boundary claims 1–3 do not strip comments, so a comment in `stream-codes.ts` reds them.
- Claim 4 (`enc-boundary.test.ts:86-100`): `stream-codes.ts` (and later `capture-phone.ts` and `stream-phone.ts`)
  records events only through `server/relay/telemetry.ts`. None of them names `fixture_stream_events` or
  `fixture_stream_samples` in code.
- R1: the four V430 tables are read and written through the non-tenant `sql` only, never under `withTenant` (no
  policy exists to admit a tenant role). `org_id` is written from the fixture's org on mint, and read back from the
  code row on resolve.

**Interfaces:**

- Consumes `sealWith` and `openWith` (`relay/crypto.ts`, KEK `RELAY_KEK`), plus `codeStatus` and `codeServes` (T4a).
- Produces, from `secret-columns.ts`:
  - `insertStreamCode(tx, {orgId, fixtureId, code, tokHash, tokEnc, issuedBy}): Promise<{id: string}>`
  - `openStreamCodeTok(tx, codeId): Promise<string | null>`
  - `wipeStreamCodeTok(tx, codeId, cause: "reissued" | "expired", endedBy: string | null): Promise<void>`
- Produces, from `stream-codes.ts`:
  - `ensureStreamCode(auth, fixtureId): Promise<{ qr: CaptureQrV2; issuedAt: string }>`
  - `reissueStreamCode(auth, fixtureId): Promise<{ qr: CaptureQrV2; issuedAt: string }>`
  - `resolveStreamCode(rawCode, tok, call, phone | null, now): Promise<ResolvedCode>`, which throws
    `CaptureRefusalError(401, "code_ended")` or `(404, "not_a_stream_code")`
  - `type ResolvedCode = { codeId; orgId; fixtureId; status; issuedBy }`
  - `saveStreamSettings(auth, fixtureId, {targetId}): Promise<{targetId: string | null}>`
- Produces, from `capture-http.ts` (created here, and used by T8a–T8c):
  - `class CaptureRefusalError extends Error { constructor(status, code: CaptureRefusalCode, message, extras?) }`

- [ ] **Step 1: Write the failing use-case tests** (DB-backed):
  - **Ensure.**
    - Re-shows the same code twice, and `shown_count` is 2.
    - Mints when there is none.
    - A missing `RELAY_KEK` writes **no row** (count the rows before and after).
    - **In `server/relay/__tests__/stream-code-tok.test.ts` (A5):** an envelope that no longer matches its hash,
      forced by an UPDATE of the sealed column in the test, reissues and logs.
    - A finished fixture → `422 fixture_finished` (C4). An ACTIVE·FINISHING code inside the grace is re-shown.
  - **Reissue.** The old row is ENDED(reissued) and the new code differs. "Its sealed tok is wiped" is asserted in the
    relay test (A5). Concurrency: two ensures at once under the advisory lock leave exactly one ACTIVE code (the
    `registration-concurrency.test.ts` gated-tx pattern).
  - **Resolve (C1).**
    - Wrong tok and unknown code both give `401 code_ended`, and both run `timingSafeEqual`. A spy on
      `crypto.timingSafeEqual` asserts one call for each, the unknown code against `DUMMY_TOK_HASH`.
    - A malformed code gives `404` before any query (a spy on `sql` sees zero calls).
    - C1b serves the open session's phone a `get` and a `beat`, and refuses a `claim` and a `start` (401).
    - Expiry is written lazily on the first evaluation that finds it due (C2).
    - `normaliseCode` is applied first (Review Focus 1).
  - **Settings.** A `targetId` from another org → 404. An archived target → 404. `null` clears it.
  - **Routes.** Every test runs at the HTTP level through the route module:
    - session-editor only; an API key → 401/403 by the `NEVER_KEY_ROUTES` door;
    - `Cache-Control: private, no-store` on the ensure answer;
    - no `streaming.relay` → 402.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t5.json && pnpm vitest run src/server/usecases/__tests__/stream-codes.test.ts src/server/relay/__tests__/stream-code-tok.test.ts "src/app/api/v1/fixtures/[id]/stream-code/__tests__/routes.test.ts" src/server/relay/__tests__/secret-columns.test.ts src/server/relay/__tests__/enc-boundary.test.ts src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-coverage.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t5.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t5.json
cd $WT && pnpm openapi:gen && git status --porcelain; echo EXIT=$?
```

  After the commit, `pnpm openapi:gen` leaves `git status --porcelain` empty (the RULES.md pre-commit; A16).

- [ ] **Step 3: Implement** by the `device-links.ts` pattern. Read `ensureDeviceLink` and copy its order: the advisory
  lock, the seal **before** any write, re-open and verify, then mint. The constant-time compare:

```ts
const DUMMY_TOK_HASH = createHash("sha256").update("capture-dummy-tok", "utf8").digest("hex");
function tokMatches(storedHex: string | null, tok: string): boolean {
  const given = Buffer.from(createHash("sha256").update(tok, "utf8").digest("hex"), "hex");
  const stored = Buffer.from(storedHex ?? DUMMY_TOK_HASH, "hex");
  return timingSafeEqual(given, stored) && storedHex !== null;
}
```

  Code minting: 12 characters from `"0123456789abcdefghjkmnpqrstvwxyz"`, drawn with `randomInt`. Retry on a
  unique-violation, at most 3 times.

- [ ] **Step 4: Run Step 2's command.** Expected: green.

- [ ] **Step 5: Mutate.**
  - `timingSafeEqual` → `===`. Red: the structural spy case.
  - Drop the dummy-hash path. Red: "unknown code runs the compare".
  - C1b admits `start`. Red: "ended code refuses start".
  - Seal after the insert. Red: "missing KEK writes no row".

- [ ] **Step 6: Commit** with `feat(capture): stream codes — ensure, reissue, resolve, settings (T5)`, listing the
  mutations in the body.

Owes: use-case and unit.

### Task 6: One start path — `startBroadcast`, `phone_not_paired`, the new end reasons

**Files:**

- Modify:
  - `apps/web/src/server/relay/domain/session.ts`:
    - `AdmitInput.phonePresent`;
    - `AdmitRefusal` gains `phone_not_paired`;
    - the `stop` `Command` gains `reason`;
    - `Session.endReason` widens to `DB_END_REASONS` (T4b);
    - `startCause` and `warmingAt`;
  - **`apps/web/src/server/relay/domain/expiry.ts:95`.** The warming timeout anchors on `warmingAt ?? createdAt`
    (A8, FP7). **This file, not `session.ts`, holds the warming deadline;**
  - **`apps/web/src/server/relay/telemetry.ts:16`.** `EventSource` gains `"phone"` (A6, FP12). V430 admits it in the
    DB, and without this edit `tsc` reds here;
  - `apps/web/src/server/usecases/stream-sessions.ts`: `createSession` (`:1140`, re-pin at batch start) →
    `startBroadcast`, plus a thin organiser wrapper;
  - `apps/web/src/server/api-v1/schemas.ts`: `StreamEndReason` widens to the five DB reasons, and
    `StreamSessionCurrent` gains `startCause`;
  - `apps/web/src/app/api/v1/fixtures/[id]/stream-sessions/route.ts`: saves the pre-pick on success;
  - **`apps/web/src/server/relay/__tests__/_session-rig.ts`: a new `pairPresentPhone(fixtureId, opts?)` (A7).**
- **Modify: every organiser-start caller (A7, critical).** W5 refuses every organiser start that has no present
  phone, and today **no** existing start has one. Re-point each caller in **this** commit:
  - `server/usecases/__tests__/stream-sessions.test.ts`: 233 `createSession(` calls. Prefer a rig default (the
    file's own start helper calls `pairPresentPhone` first) over 233 edits;
  - `server/usecases/__tests__/relay-sweep.test.ts` (5);
  - `server/usecases/__tests__/relay-internal-routes.test.ts`;
  - `server/usecases/__tests__/stream-targets.test.ts`. It calls the stream-sessions route's `POST` at `:560`;
  - `server/usecases/__tests__/stream-credits-monthly.test.ts`. Re-pin how it starts a session (it uses
    `streamRig`);
  - `app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts`.

  **Not** `lib/__tests__/auth-session-audience.test.ts`. That file calls `lib/auth.ts`'s **login** `createSession`,
  which is a different function (FP24).

  Re-pin the list by behaviour before starting. Key on the stream module, never on the bare name, because
  `createSession(` also matches seven auth routes:

  ```bash
  cd $WT/apps/web && grep -rln -a -E 'usecases/stream-sessions"|fixtures/\[id\]/stream-sessions/route' src | grep -a -E '\.test\.tsx?$'
  ```

  In each file the grep finds, count the organiser starts. A file with none (it imports only a read) is left alone.
  Add every file that starts a session to the scope command.
- Test:
  - `server/relay/domain/__tests__/session.test.ts`;
  - `server/relay/domain/__tests__/expiry.test.ts` (A8);
  - `server/usecases/__tests__/stream-sessions.test.ts`;
  - `app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts`;
  - `server/api-v1/__tests__/stream-contract.test.ts`;
  - the A7 caller files above.

**Interfaces:**

- Produces:

```ts
export type StartCause = "organiser" | "operator" | "automatic";
export async function startBroadcast(
  actor: { userId: string; orgId: string; source: "organiser" | "phone" | "auto"; pairingId: string | null },
  fixtureId: string,
  opts: { targetId: string; startCause: StartCause; phonePresent: boolean },
  deps: SessionDeps,
): Promise<{ sessionId: string }>;
// Organiser wrapper, unchanged signature for the route:
export async function createSession(auth: AuthCtx, fixtureId: string, body: CreateStreamSession, deps: SessionDeps): Promise<{ sessionId: string }>;
// _session-rig.ts (A7):
export async function pairPresentPhone(fixtureId: string, opts?: { phone?: string; at?: Date }): Promise<{ codeId: string; pairingId: string; phone: string }>;
```

- `stop` command: `{ type: "stop"; reason: "stopped" | "operator_stopped" | "auto_stopped" | "phone_lost" }`. `ending ×
  stop` keeps the first reason.
- Admission order (§6.7.1): plan gates → `active_session` → `phone_not_paired` → `no_credits` → `target_not_found` →
  `storage_exhausted`.
- **`pairPresentPhone` (A7, FP25).** It mints the fixture's code through the **real** `ensureStreamCode` (T5).
  - It then writes slot 0's current pairing with one INSERT whose columns are read from V430's
    `fixture_stream_pairings`, with `last_beat_at = opts.at ?? now` and `answered_poll_seconds =
    POLL_FAR_SECONDS`.
  - The real claim path is T8b's `postBeat`, which does not exist until B6, so this INSERT is the one non-real step,
    and it is named here so it cannot be forgotten. **T8b re-points the helper's pairing step to a real `postBeat`
    claim in its own commit**, and B6's gate re-runs every A7 caller.
  - A second call for the same fixture refreshes `last_beat_at` rather than adding a pairing. That lets a test that
    advances its clock re-call it before the next start.
- **The warming anchor (A8).** `expiry.ts`'s warming branch reads `s.warmingAt ?? s.createdAt`. Sessions opened
  before V430 have a null `warming_at`, so the fallback is load-bearing.

- [ ] **Step 1: Write the failing tests.**
  - **`session.test.ts`.**
    - `stop` with each reason sets `endReason` to it.
    - A second `stop` in `ending` keeps the first reason.
    - `admit` refuses `phone_not_paired` after `active_session` and before `no_credits`. The ordering differential:
      with no phone **and** no credits, the refusal is `phone_not_paired`.
  - **`expiry.test.ts` (A8).**
    - Provisioning lasted 179 s, so `warmingAt` is 179 s after `createdAt`, and the two anchors differ. The session
      still gets the full `WARMING_TIMEOUT_MINUTES` from `warmingAt`: it is not timed out at `createdAt + limit`, and
      it is timed out at `warmingAt + limit`.
    - **The null fallback:** a session with `warmingAt: null` (opened before V430) times out at `createdAt + limit`.
  - **`stream-sessions.test.ts`** (DB-backed).
    - The organiser start with no present phone → `409 phone_not_paired`. This is the one place that deliberately
      skips `pairPresentPhone`.
    - With a present phone, it creates the session with `start_cause 'organiser'` and `pairing_id` set.
    - **Diff test (house rule "new write path"; A23).** Spy on `admit`, then call the organiser wrapper and
      `startBroadcast(…'operator'…)` on identical fixtures.
      - Assert that the two `AdmitInput` objects are deep-equal except `phonePresent`, which is the documented
        difference.
      - Assert that the provider calls are the same and **in the same order**, on a `FakeRecorder`. That proves both
        paths go through B0's one-tx sample+event path inside the same `startBroadcast`, not through two copies.
    - `created_by` is the code's `issued_by` for `operator`.
    - The events row has `source 'phone'` and the pairing id.
  - **`stream-contract.test.ts`.**
    - `StreamEndReason ↔ end_reason` now reads `lastCheckList` (T3), and passes with five.
    - **`EventSource ↔ fixture_stream_events.source` (A6).** Pin the TS union against
      `lastCheckList('fixture_stream_events','source')`, the same way `StreamEndReason` is pinned. Both directions
      must agree, and the count checked must be greater than 0.
    - The relay-route pin ("ROUTES declares exactly the SEVEN relay operations", `stream-contract.test.ts:224`)
      filters on `STREAM_ROUTE = /\/(stream-sessions|stream-targets)(\/|$)/`, so T5's routes are invisible to it.
      Widen it to `/\/(stream-sessions|stream-targets|stream-code|stream-phone|stream-settings)(\/|$)/` and add T5's
      three entries (`POST /fixtures/:id/stream-code`, `POST /fixtures/:id/stream-code/reissue` and
      `PUT /fixtures/:id/stream-settings`). That makes ten, and T9's `GET /fixtures/:id/stream-phone` makes eleven,
      which is spec §9's "7 to 11". Rename the case title to match the count.
  - **`routes.test.ts`.** A Go live with `targetId` saves `fixture_stream_settings.target_id`.
  - **The A7 callers.** Each one stays green, with the same assertions, once it pairs through `pairPresentPhone`.
    The pairing call is the **only** edit to each. Any other assertion edit is a behaviour change: stop and report
    it.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t6.json && pnpm vitest run src/server/relay/domain/__tests__/session.test.ts src/server/relay/domain/__tests__/expiry.test.ts src/server/usecases/__tests__/stream-sessions.test.ts "src/app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts" src/server/api-v1/__tests__/stream-contract.test.ts src/server/usecases/__tests__/relay-sweep.test.ts src/server/usecases/__tests__/relay-internal-routes.test.ts src/server/usecases/__tests__/stream-targets.test.ts src/server/usecases/__tests__/stream-credits-monthly.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t6.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t6.json
```

  Add any further caller that the re-pin grep finds, and confirm it appears in `.files`.

- [ ] **Step 3: Implement.**
  - Move the body of `createSession` (`stream-sessions.ts:1140`, to the end of its admission and provisioning) into
    `startBroadcast` **unchanged**, except that it takes the actor and the new opts. B0's one-tx sample+event path
    moves verbatim (A27).
  - `createSession` becomes:
    1. resolve the auth;
    2. read slot 0's current pairing for the fixture's ACTIVE code, through the non-tenant `sql` (R1), and compute
       `isPresent` (T4a);
    3. call `startBroadcast` with `startCause: "organiser"`;
    4. save the pre-pick on success.
  - `stopSession` passes `reason: "stopped"`.
  - Set `warming_at` where the session enters `warming`. The anchor change is in `domain/expiry.ts:95` (A8), and
    `Session` gains `warmingAt`.
  - Widen `EventSource` in `telemetry.ts` (A6).
  - Add `pairPresentPhone` to `_session-rig.ts`, and re-point every A7 caller.

- [ ] **Step 4: Run Step 2's command.** Expected: green.

- [ ] **Step 5: Mutate.** Restore each from a `cp` backup.
  - Remove the `phone_not_paired` gate. Red: the organiser Go live with no phone.
  - Put `phone_not_paired` after `no_credits`. Red: the ordering differential.
  - Let `ending × stop` take the last reason. Red: "a second stop keeps the first reason".
  - Anchor warming on `createdAt` in `expiry.ts`. Red: the 179 s case.
  - Drop the `?? createdAt` fallback (use `warmingAt!`). Red: the pre-V430 null case (A8).
  - Drop `"phone"` from `EventSource`. Red: the `EventSource ↔ source` pin, and `tsc`.
  - Swap two provider calls in the operator path's order. Red: the diff test's order assertion (A23).

- [ ] **Step 6: Commit** with `feat(stream): one start path with startCause, phone_not_paired, stop reasons (T6)`. The
  body lists:
  - the mutations;
  - every A7 caller file re-pointed, with its case count before and after (equal);
  - the one non-real step in `pairPresentPhone`, and that T8b replaces it.

Owes:

- unit;
- use-case;
- regression: the warming anchor and its pre-V430 fallback; the end-reason check admits five; every existing
  organiser start survives W5.

### Task 6b: Free restarts — three per reuse window (W23)

**Files:**

- Modify:
  - `apps/web/src/server/relay/domain/credits.ts` (`restartIsFree`);
  - `apps/web/src/server/relay/config.ts` (`FREE_RESTARTS_PER_WINDOW = 3`);
  - `apps/web/src/server/usecases/stream-credits.ts` (`restartAllowance`; `consumeForSession` uses it);
  - `apps/web/src/server/usecases/stream-sessions.ts`: admission at `:1216` and the read at `:1611` use it. Re-pin
    both after T6, which moves the lines;
  - `apps/web/src/server/api-v1/schemas.ts`: `StreamSessionCurrent` **gains `restart` beside `restartFree`** (A9,
    option (a)).
- **Not modified here (A9(a)):**
  - `fixture-stream-panel.tsx`, with its five `restartFree` sites (`:1047`, `:1136-1138`, `:1282`, `:1320`,
    `:1496`);
  - `fixture-stream-panel.test.tsx`;
  - the i18n key `stream.phone.restartFree`.

  `restartFree` stays on the wire as a **derived** field until T11 removes it. T11 owns the panel and is gated on the
  owner (OG2). Under option (b), an ungated task would edit a gated surface, and B4 would red `tsc` and the panel
  suite.
- Test:
  - `server/usecases/__tests__/restart-allowance.test.ts` (new, DB-backed);
  - `server/relay/domain/__tests__/credits.test.ts`;
  - `server/usecases/__tests__/stream-credits.test.ts` and `stream-sessions.test.ts` (its `restartFree` cases at
    `:679-717` stay green, unedited);
  - `server/api-v1/__tests__/stream-contract.test.ts`. Its `StreamSessionCurrent` pin (`:176-206`) gains `restart`;
  - `components/v2/__tests__/fixture-stream-panel.test.tsx`, run unedited, as the proof that the panel reads the same.

**Interfaces:**

- Produces:

```ts
export const FREE_RESTARTS_PER_WINDOW = 3;                         // config.ts
export function restartIsFree(a: { windowOpen: boolean; used: number }, limit: number): boolean;   // domain/credits.ts
export type RestartAllowance = { windowOpen: boolean; used: number; limit: number; free: boolean };
export async function restartAllowance(
  exec: Executor,
  args: { orgId: string; fixtureId: string | null; excludeSessionId: string | null },
  now: Date,
): Promise<RestartAllowance>;                                      // stream-credits.ts
```

- The SQL. The anchor is `reuseWindowOpen`'s query unchanged, also selecting `c.session_id`. Then:

```sql
select count(*)::int as used from fixture_stream_sessions s
 where s.org_id = ${orgId} and s.fixture_id = ${fixtureId}
   and s.first_ingest_at is not null
   and s.id <> ${anchorSessionId}
   and (${excludeSessionId}::uuid is null or s.id <> ${excludeSessionId})
   and s.created_at > (select created_at from fixture_stream_sessions where id = ${anchorSessionId})
```

- `StreamSessionCurrent.restart: RestartAllowance | null` (null when no window is open) is added **beside**
  `restartFree` (A9(a)).
  - `restartFree` stays, and is now derived from the **same** `restartAllowance` call: `restart !== null &&
    restart.free`. So the two can never disagree.
  - `grep -rn -a restartFree $WT/apps/web/src` must show that every reader still compiles. T11 moves them all to
    `restart` and deletes `restartFree`.

- [ ] **Step 1: Write the failing tests.**
  - **`credits.test.ts`.** The empty case first: the window is closed → not free. Then `used` 0, 1 and 2 → free, and
    3 → not free. `limit` comes from `FREE_RESTARTS_PER_WINDOW`.
  - **`restart-allowance.test.ts`** (DB-backed, fake drivers, injected clock). Each case asserts the credit ledger
    rows, not just the flag:
    - **Boundary:** paid live, then three restarts that each reach video, all free (0 consume rows added). The 4th
      that reaches video consumes 1 at live. Then the 5th is free again (O4, ruled YES 2026-10-01: the paid 4th re-anchors).
    - **No video:** a restart that is stopped before first ingest leaves `used` unchanged, so after three counted
      restarts and one without video, the next is still the 4th.
    - **Same sid:** a takeover (T4) and an operator rejoin of the live session never change `used`.
    - **Never blocks:** at the limit with a balance of 0, Go live is refused `402 no_credits` at admission. That is the
      existing balance gate, not a new block; with a balance of 1 it is admitted.
    - **Agreement:** at every step of the boundary sequence, admission's waiver, `consumeForSession`'s decision,
      `current.restart.free` and the derived `current.restartFree` are all equal. Assert the count of compared steps
      is 5.
    - **The window closes:** 24 h after the anchor, `restart` is null and a Go live pays, as today.
  - **Sequence (rule 10):** a fast-check property over `{goLive, ingest, stop}` sequences of length ≤ 12 on one
    fixture. The expected number of consume rows is computed by a model that knows only the W23 rule text: the first
    live pays, every 4th counted restart after an anchor pays, and sessions without video never count. It is never
    computed from `restartAllowance`. Count the runs that reached a 4th restart and assert > 0.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t6b.json && pnpm vitest run src/server/usecases/__tests__/restart-allowance.test.ts src/server/relay/domain/__tests__/credits.test.ts src/server/usecases/__tests__/stream-credits.test.ts src/server/usecases/__tests__/stream-sessions.test.ts src/server/api-v1/__tests__/stream-contract.test.ts src/components/v2/__tests__/fixture-stream-panel.test.tsx --reporter=json --outputFile=$SCRATCH/cq1-t6b.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t6b.json
```

  If `credits.test.ts` or `stream-credits.test.ts` has a different name in the tree, use the real one
  (`ls $WT/apps/web/src/server/relay/domain/__tests__ $WT/apps/web/src/server/usecases/__tests__ | grep -a credit`)
  and confirm it appears in `.files`.

- [ ] **Step 3: Implement.** `reuseWindowOpen` stays exported for any other caller that grep finds, but none of the
  three call sites in Premise 14 uses it any more.

- [ ] **Step 4: Run Step 2's command.** Expected: green, with every existing reuse-window case unchanged.

- [ ] **Step 5: Mutate.**
  - `used < limit` → `used <= limit`. Red: the boundary case at the 4th.
  - Drop `first_ingest_at is not null`. Red: the no-video case.
  - Drop the anchor exclusion. Red: the 3rd restart pays.
  - Make admission still call `reuseWindowOpen`. Red: the agreement case.
  - Derive `restartFree` from `reuseWindowOpen` instead of `restart`. Red: the agreement case at the 4th restart.

- [ ] **Step 6: Commit** with `feat(stream): three free restarts per reuse window, one authority (T6b)`, listing the
  mutations in the body.

Owes: unit, use-case, money and the sequence test.

### Task 7: The tick — `tickSession`, ask 10, W19, the sweep, the fake-ingest control

**Files:**

- Modify: `apps/web/src/server/usecases/stream-sessions.ts`. Extract `tickSession` from `currentSession`'s
  reconcile-and-poll block (`:1446-1530`, with the claim at `:1457`; re-pin at batch start, A14). `currentSession`
  calls it. **This is B0 code. A10 and the Global Constraints' B0 paragraph bind every line of the extraction.**
- Modify: `apps/web/src/app/api/cron/relay-sweep/route.ts`, and the sweep use-case it calls. Every open session is
  ticked, and beat history older than `PHONE_BEAT_RETENTION_HOURS` is deleted.
- Create: `apps/web/src/app/api/internal/relay/fake-ingest/[inputId]/route.ts`. It drives the **existing**
  `FakeIngest.setState(inputId, state)` (`relay/fakes.ts:130-134`), which already overrides the timer.
  **`fakes.ts` is not modified, and no `setConnected` twin is added** (FP8).
- **Not touched:** `server/relay/ingest-cf.ts`, `expireTargetHolders` (`stream-sessions.ts:1759`), the text of
  `latestPollSampleWithSince` (`:580`), `claimIngestPoll` (`:600`), `POLL_CLAIM_WINDOW_MS` (`:615`) and
  `COALESCED_SAMPLE_MAX_AGE_MS` (`:621`) (A27).
- Test:
  - `server/usecases/__tests__/stream-tick.test.ts` (new, DB-backed);
  - `server/usecases/__tests__/relay-sweep.test.ts` (A11), because the sweep changes;
  - `app/api/internal/relay/fake-ingest/__tests__/route.test.ts`;
  - `app/api/cron/relay-sweep/route.test.ts`;
  - `server/usecases/__tests__/stream-sessions.test.ts`. **B0's own regression cases** (the coalescing cases and the
    one-tx sample+event cases) are in scope, and stay green **unedited** (A10).
  - `stream-target-holders.test.ts` only if `expireTargetHolders` is reached at all. It must not be.

**Interfaces:**

- Produces:

```ts
/** What one tick observed. currentSession builds its projection from this, so the projection stays byte-identical
 *  to the pre-extraction code (A10). A bare `Session | null` would drop ingestState, outputObserved and
 *  coalescedSince, which the projection reads today. */
export type TickObservation = {
  session: Session | null;
  ingestState: StreamSessionCurrent["ingest"];   // today's `let ingestState` (:1446), default null
  outputObserved: OutputState | null;            // D3: what THIS poll read of the destination; null = read nothing
  coalescedSince: Date | null | undefined;       // I-1 (B0): a served sample's own since; undefined = not served
};
export async function tickSession(sessionId: string, deps: SessionDeps, cause: "poll" | "beat" | "sweep"): Promise<TickObservation>;
```

  The three field types are the ones `currentSession`'s locals carry today (`:1446-1448`, re-pinned 2026-10-01), moved
  verbatim. `coalescedSince`'s three states (`Date`, `null` and `undefined`) all mean something, so none may be
  collapsed.
- The order inside `tickSession`:
  1. lazy expiry;
  2. the coalesced ingest read: `claimIngestPoll`, which writes a `poll` sample with `ingest_state`. The sample and
     its event are written in **one tx** (B0 R-1);
  3. `warming → live`, which consumes the credit;
  4. `target_rejected`;
  5. ask 10: `warmingPhoneLost` → `stop(phone_lost)`;
  6. W19: `livePhoneLost` → `stop(phone_lost)`.
- Consumes `warmingPhoneLost` and `livePhoneLost` (T4b), and `tunable` (T4a).

- [ ] **Step 1: Write the failing tests** (DB-backed, with an injected clock and the fake drivers).
  - **Advancing without a panel.** A beat-cause tick advances `warming → live` with no organiser poll.
  - **Coalescing.** Two organiser polls and one beat inside one `STREAM_POLL_MS` make exactly one `inputStatus`
    call, counted on `FakeRecorder` (Review Focus 3).
  - **Two ticks at once (the four questions: a second call).** Two `tickSession` calls in parallel on one W19-due
    session → it ends exactly once, with one end event. `claimIngestPoll`'s coalescing makes this safe; the case
    proves it.
  - **A deleted fixture (T35).** Tick a session whose fixture was deleted, so its `fixture_id` is set null. The tick
    does not throw, and the session's state is unchanged by the deletion.
  - **Ask 10.**
    - A warming session with a silent phone and no ingest is ended `phone_lost`, and its credit rows sum to 0.
    - A session with `first_ingest_at` is never ended by ask 10.
  - **W19.**
    - Live, no beat, the fake set not connected (through `setState`), and the last connected sample at exactly
      `PHONE_LOST_LIVE_MINUTES`: ended `phone_lost`. No refund row and no second consume.
    - The same at 14 min 59 s on each clock alone: not ended (two cases).
    - Beating while the input is down, for 20 min: not ended.
    - Silent while the input is connected, for 20 min: not ended.
    - **The B0 freshness bound (FP17).** The claim is held by another caller, and its coalesced sample is
      1.5 × `STREAM_POLL_MS` old. That sample is W19's fresh read, because it is inside B0's
      `COALESCED_SAMPLE_MAX_AGE_MS`. A sample older than `COALESCED_SAMPLE_MAX_AGE_MS` is not: W19 skips this tick.
      Both bounds are read from the constants, and the right answer differs from the 1× bound's.
    - The expected minutes come from `PHONE_LOST_LIVE_MINUTES`.
  - **Sweep (`relay-sweep.test.ts`).**
    - The sweep ticks an open session and ends a W19 session.
    - It deletes beat history older than 24 h, and keeps `fixture_stream_sessions.phone_beat` and
      `fixture_stream_pairings.last_beat`.
    - Its existing cases stay green.
  - **Fake-ingest route.** It is 404 unless `RELAY_DRIVERS=fake` and `ENV_NAME ∈ {local, ci}`. There is one test per
    refused combination: stg+fake, local+real, ci+real, and unset+fake. With both set, it calls
    `FakeIngest.setState`, and the next tick reads the flipped state.
  - **B0 untouched.** `stream-sessions.test.ts`'s coalescing and one-tx cases pass with **no assertion edits**.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t7.json && pnpm vitest run src/server/usecases/__tests__/stream-tick.test.ts src/server/usecases/__tests__/stream-sessions.test.ts src/server/usecases/__tests__/relay-sweep.test.ts src/app/api/internal/relay/fake-ingest/__tests__/route.test.ts src/app/api/cron/relay-sweep/route.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t7.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t7.json
```

- [ ] **Step 3: Implement.**
  - **The extraction moves code; it must not change the organiser poll's behaviour (A10).**
    - `stream-sessions.test.ts` stays green **with no assertion edits**. If one needs an edit, stop and report it:
      that is a behaviour change.
    - Preserve exactly: the `claimIngestPoll` coalescing (`:1457`); `latestPollSampleWithSince`'s **single
      statement** (`:580`); R-1's sample+event in **one tx**; `COALESCED_SAMPLE_MAX_AGE_MS = 2 × STREAM_POLL_MS`; and
      `POLL_CLAIM_WINDOW_MS`.
    - `currentSession` builds its projection from the returned `TickObservation`, so that projection is
      byte-identical.
    - Do not touch `expireTargetHolders` (`:1759`) or `ingest-cf.ts`.
  - W19's three reads:
    - `phone_beat_at` from the session row;
    - the fresh read from this tick's `claimIngestPoll`. When another caller holds the claim, use that caller's
      coalesced sample if it is younger than **`COALESCED_SAMPLE_MAX_AGE_MS` (2 × `STREAM_POLL_MS`, B0's bound;
      FP17)**. Otherwise skip W19 this tick, and never guess;
    - `max(sampled_at) where source='poll' and ingest_state='connected'`.

- [ ] **Step 4: Run Step 2's command.** Expected: green. Then confirm B0 is untouched:
  `git diff <batch base> -- $WT/apps/web/src/server/relay/ingest-cf.ts` is empty, and the B0 SQL text (the
  statements of `latestPollSampleWithSince`, `claimIngestPoll` and the one-tx sample+event write) shows **zero
  changed lines** in `git diff -w`. Moved lines appear as moves, never as edits.

- [ ] **Step 5: Mutate.** Restore each from a `cp` backup.
  - Ask 10 without the `first_ingest_at IS NULL` check. Red: a live session ended at 60 s.
  - W19: drop each conjunct (three mutants), and `>=` → `>`. Red: their cases.
  - Read the coalesced sample against a 1× `STREAM_POLL_MS` window. Red: the 1.5× freshness case.
  - Drop the `ENV_NAME` gate on the fake route. Red: its 404 cases.
  - The purge deletes the session's final beat. Red: the purge case.

- [ ] **Step 6: Commit** with `feat(stream): tickSession with ask-10 and W19 phone-lost ends; sweep ticks (T7)`. The
  body lists:
  - the mutations;
  - the statement that `git diff` shows **zero changes to the B0 SQL text**, and none to `ingest-cf.ts` or
    `expireTargetHolders` (A10).

Owes:

- use-case;
- regression (the fake route outside local/ci; B0's cases unedited);
- money (no consume for `phone_lost` before ingest, and no refund after).

### Task 7b: The 5-minute `stream-tick` job, and the cron Worker's hourly Sentry throttle (W22, R2, R6)

**Rewritten 2026-10-01 against the real `apps/cron-worker` (A12, A13).** The first version targeted a Worker shape
that does not exist (FP2, FP3). Its disabled body would also have sent a Sentry event from every relay-disabled
deployment on every firing.

**Precondition: met.** The cron Worker merged in #909 (81d1f3d73). Step 1 re-pins `schedule.ts`, `run.ts`,
`call.ts`, `index.ts` and `test/*`. If anything below differs from the tree, follow the tree and record each
difference in the commit body.

**Files:**

- Create `apps/web/src/app/api/cron/stream-tick/route.ts`, and a sibling `route.test.ts` (the relay-sweep
  convention).
- Modify `apps/web/src/server/usecases/stream-sessions.ts`:
  - add `export type StreamTickResult = { ticked: number; ended: number; failed: number; deferred: number }`,
    **written out literally**. `drift.test.ts:56-69` greps the route's `@/` imports for a `failed: number` field,
    and an inferred return type fails that check;
  - add `tickOpenSessions(deps): Promise<StreamTickResult>`.
- Modify in `apps/cron-worker`:
  - `src/schedule.ts`:
    - add `export const STREAM_TICK_CRON = "*/5 * * * *"`;
    - add one `JOBS` row, appended **last**. The table is in wave order, so never re-sort it;
    - add `firstSlotOfHour(trigger, t)`;
  - `src/run.ts`: the throttle, and `JobResult` gains `sentryThrottled?: true`;
  - `wrangler.json`: both envs carry `"crons": ["17 * * * *", "*/5 * * * *"]`;
  - tests: `test/schedule.test.ts`, `test/run.test.ts`, `test/index.test.ts` and `test/drift.test.ts`;
  - `test/manual.test.ts`: read it, and edit it only if it reds.
- **Not touched:**
  - `src/index.ts`: `scheduled` already passes `controller.cron` (`:10`);
  - `dueJobs`: already keyed on the trigger (`:110-112`);
  - `src/call.ts` and `src/sentry.ts`;
  - `Due`: there is no `minutes` kind, and none is added.

**The row:**

```ts
{ id: "stream-tick", path: "/api/cron/stream-tick", trigger: STREAM_TICK_CRON, due: { kind: "every" }, retry: false, manual: true, failureCounts: ["data.failed"] },
```

- `retry: false`. A 502/503/504 retry of a tick can overlap the next firing and double the work. The next firing *is*
  the retry. This also matches the existing `TICK` fixtures.
- `failureCounts: ["data.failed"]`. Under the cron spec's R3, a 200 with `failed > 0` reads as degraded. The route
  answers through `handler()`, so the body is `{ok, data}`, and the path is `data.failed`, as the
  `billing-quantity` and `billing-grant` rows use.

**Interfaces:**

- **The route, `POST /api/cron/stream-tick`.** Copy `relay-sweep/route.ts`'s guards in order:
  1. `503` when `CRON_SECRET` is unset;
  2. then `401` on a mismatched `x-cron-secret`;
  3. then `defaultDeps(baseUrl(req))`.
  - When `deps.drivers.disabled`, answer `{ disabled: true, ticked: 0, ended: 0, failed: 0, deferred: 0 }`. **`failed`
    must be present.**
    - `failureCountsOver0` (`call.ts:52-67`) reads a missing path as `"unreadable"`. So relay-sweep's bare
      `{disabled: true}` shape, which is safe only because its row has no `failureCounts`, would read as degraded
      here.
    - That would send a Sentry event from every relay-disabled deployment, on every firing. That includes prod if
      `RELAY_DRIVERS` is unset there (unverified).
  - Otherwise, answer `tickOpenSessions(deps)`.
- **The usecase, `tickOpenSessions(deps)`:**
  - It reads open sessions across orgs with the non-tenant `sql`. The existing `openStreamStates` (`:1402`) is the
    single source of what "open" means. It reads them oldest first.
  - It runs `tickSession(id, deps, "sweep")` (T7) on each, inside its own try/catch. A throw adds 1 to `failed` and
    logs a line. A terminal result adds 1 to `ended`.
  - It stops at a wall-clock budget below `JOB_TIMEOUT_MS` (60 s, `call.ts:29`), and counts the sessions it did not
    reach in `deferred`. That count is **not** a failure counter: those sessions are reached at the next firing.
- **The throttle (R2, option S, stateless; R6).** It allows at most one Sentry error event per job per UTC hour.
  - In `run.ts`'s `runJobs`, before `captureJobFailure` (`:57-65`): when `ctx.run === "scheduled"` and
    `!firstSlotOfHour(job.trigger, scheduledTime)`, set `result.sentryThrottled = true` and send nothing. Otherwise,
    send as today.
  - `firstSlotOfHour(trigger, t)` lives in `schedule.ts`:
    - the hourly `TRIGGER_CRON` returns `true`. It fires once an hour, so it is never throttled;
    - `*/N * * * *` returns `t.getUTCMinutes() < N`;
    - **any other trigger shape throws.** That is a guard, not a comment.
  - It keys on `scheduledTime`, **never `deps.now()`**. Cloudflare's `scheduledTime` is the slot, so every isolate gets
    the same answer. The R5 harness also freezes `now()` at 0.
  - **Manual runs bypass the throttle (R6).** A human asked for that run.
  - The job's log line carries `sentryThrottled: true`, so a suppressed failure stays visible in Workers logs. This
    is class 6: an absent symptom must not read as safe.
  - **The cost (recorded in the commit body):** a failure that clears before the next `:00` slot reaches Workers logs,
    not Sentry. A persistent failure is reported up to 55 min late. Option K (a KV key per job and hour) would
    report the *first* failure, but needs owner-gated KV writes (OG11). R2 chose S.

- [ ] **Step 1: Re-pin the merged cron Worker.** Read `schedule.ts`, `run.ts`, `call.ts`, `index.ts` and the
  `test/*` files. Confirm each of these, with its line:
  - the job header is still `x-cron-secret`;
  - `dueJobs(scheduledTime, cron, jobs)` is keyed on the trigger;
  - `relay-sweep` has a row;
  - `RunContext.run` is `"scheduled" | "manual"`;
  - `captureJobFailure` is called only under `dsn && result.status !== "ok"`;
  - `drift.test.ts` counts `failureCounts` paths (6 today) and compares `triggersOf()` with `wrangler.json`;
  - the `TICK` / `WITH_TICK` / `FAST` fixtures in `test/schedule.test.ts` and `test/run.test.ts`.

- [ ] **Step 2: Write the failing tests.** Expected values come from the spec, never from `JOBS`, which is the
  existing convention of these files.
  - **`route.test.ts` (apps/web).**
    - **The empty case first:** no open sessions → `{ticked: 0, ended: 0, failed: 0, deferred: 0}`. It is asserted,
      not skipped.
    - No `CRON_SECRET` → 503.
    - A wrong secret → 401, and a `tickSession` spy sees 0 calls.
    - **The disabled seam.** The disabled body includes `failed: 0`. Feed the raw response text through the Worker's
      own `failureCountsOver0` (imported from `apps/cron-worker/src/call.ts`) with the real `stream-tick` row: the
      result is `{}`. That proves the producer/consumer seam, not a fixture on both ends.
      - If that cross-workspace import reds the web `tsc` or lint, **stop and report**.
      - Never copy `failureCountsOver0` into the web tree. A twin is a fixture on both ends.
    - A W19 live session plus a warming session past its deadline → `{ticked: 2, ended: 2, failed: 0}`, with
      `phone_lost` and `no_inbound_timeout` in the DB.
    - A throwing session is counted in `failed`, and the next session is still ticked.
    - An ended session is never ticked.
    - A session whose fixture was deleted (`fixture_id` null, T35) is ticked without being counted in `failed`.
    - **Two `tickOpenSessions` in parallel** (an overlapping firing) → each session ends exactly once, with one end
      event.
  - **`schedule.test.ts`.**
    - `:66-69` "a trigger no row names selects nothing": re-target it from `FAST` to `"*/7 * * * *"`.
    - `:71-75`: run it on `JOBS`, now that the row exists, not on `withTick`. `stream-tick` appears exactly once, and
      Monday 08:05 on `STREAM_TICK_CRON` is exactly `["stream-tick"]`.
    - `:77-80`: `triggersOf()` equals `["17 * * * *", "*/5 * * * *"]`. Per the spec, that is four of the account's
      five triggers once both envs deploy.
    - `:89-92`: the retry-off list is `["relay-sweep", "news-digest", "stream-tick"]`, in table order.
    - New: every `triggersOf()` entry is accepted by `firstSlotOfHour`'s parser. Assert `checked >= 2`.
    - New: an unknown shape (`"0 9 * * 1"`) throws.
  - **`run.test.ts`.**
    - `:194-200`: the unknown trigger becomes `"*/7 * * * *"`.
    - `:202-216`: use `JOBS`, not `WITH_TICK`.
    - New: `stream-tick` failing on all 12 firings of one hour → exactly 1 event, and 11 `sentryThrottled` lines.
    - New: 288 firings over 24 h → 24 events. Assert `firings === 288`.
    - New positive/negative pair: a failure only at `:05` → 0 events and a `sentryThrottled` line; a failure only at
      `:00` → 1 event.
    - The R5 week test (`:229-240`) stays at `3*168 + 4*7 + 1`, **unedited**. Hourly rows are never throttled, and
      the week runs only `TRIGGER_CRON`.
    - New: a manual run at `:07` that fails → 1 event (R6).
  - **`index.test.ts:54-58`.** "An unknown trigger is refused": re-target it to `"*/7 * * * *"`. `*/5` is now known.
  - **`drift.test.ts`.**
    - `:68`: counters checked go from 6 to 7. The spec adds exactly one counter, `stream-tick`'s `data.failed`.
    - `:76` passes once `wrangler.json` carries both triggers in both envs, **with no edit to the test**.
    - The route scan still matches `JOBS` one-to-one, now including `/api/cron/stream-tick`.
  - **Delete the `TICK` and `WITH_TICK` fixtures**, or point them at `JOBS`. Never test with a duplicated row.

- [ ] **Step 3: Run** and see them fail. These commands are scoped, never the full gate. Use `pnpm exec`, **never
  `npx`**: in a worktree, `npx` resolves the main checkout's packages (FP16).

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t7b.json && pnpm vitest run src/app/api/cron/stream-tick/route.test.ts src/app/api/cron/relay-sweep/route.test.ts src/server/usecases/__tests__/stream-tick.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t7b.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t7b.json
cd $WT/apps/cron-worker && rm -f $SCRATCH/cq1-t7b-cw.json && pnpm exec vitest run test/schedule.test.ts test/call.test.ts test/sentry.test.ts test/run.test.ts test/manual.test.ts test/index.test.ts test/drift.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t7b-cw.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t7b-cw.json
cd $WT && pnpm --filter @seazn/cron-worker typecheck; echo EXIT=$?
```

  - Judge green from `numPassedTests` / `numTotalTests`, and pin `numTotalTests` too.
  - Confirm that every `.testResults[].name` resolves under `$WT`.
  - `test/e2e.local.test.ts` is excluded on purpose.

- [ ] **Step 4: Implement.**
  - Add the row, `STREAM_TICK_CRON`, `firstSlotOfHour` and the throttle.
  - Add the route and `tickOpenSessions`.
  - **Add the trigger to `wrangler.json`, both envs.** R9 is ruled: the owner accepted the stg cost on 2026-10-01,
    including keeping the stg machine awake. On merge, `stg.yml`'s `deploy-cron-worker-stg` runs
    `wrangler deploy --env stg`, which is a Cloudflare write. That deploy is OG6, and is **STOP: owner OK required**
    at merge time. This task only commits the file.

- [ ] **Step 5: Run Step 3's commands.** Expected: green in both workspaces.

- [ ] **Step 6: Mutate.** Each mutant must be killed by its named case. Report the killer list.

| Mutant | Killed by |
|---|---|
| `firstSlotOfHour` returns `true` | the 288-firing case |
| key on `deps.now()` instead of `scheduledTime` | the 288-firing case (the frozen clock reads minute 0 every time) |
| the throttle also applies to the hourly trigger | the R5 week test |
| manual runs are not bypassed | the manual case (R6) |
| the disabled body drops `failed` | the route's seam case |
| the route skips the secret check | the 401 case |
| `tickOpenSessions` stops at the first throw | the `failed` case |
| `STREAM_TICK_CRON` dropped from either env's `wrangler.json` | `drift.test.ts:76` |

- [ ] **Step 7: Commit** with:

```
feat(stream): a 5-minute stream-tick job, and the cron Worker's hourly Sentry throttle (T7b, W22)
```

  The body lists:
  - each existing-test edit, with its reason;
  - the mutant killer list;
  - R2's cost (up to 55 min late for a persistent failure; a transient one reaches logs only);
  - R6 (manual runs are not throttled);
  - R9 (owner, 2026-10-01: the stg `*/5` cost is accepted).

  The PR body (T13) states:
  - the account goes to four of its five Cron Triggers once both envs deploy;
  - stg deploys its trigger on merge, and the stg machine is woken every 5 minutes (R9, accepted);
  - the deploy-order race (OG16).

Owes:

- unit, use-case and regression (the hourly jobs unchanged; the R5 week unchanged);
- e2e (T12's W22 case).

### Task 8a: The descriptor — `GET /api/v1/capture/codes/{code}`

**Files:**

- Create:
  - `apps/web/src/server/relay/ingest-cred.ts`;
  - `apps/web/src/server/usecases/capture-phone.ts` (`getCode`, and the waiting-fields builder that T8b reuses);
  - `apps/web/src/app/api/v1/capture/codes/[code]/route.ts`.
- Modify:
  - `apps/web/src/server/api-v1/capture-http.ts` (created in T5). It gains `captureJson`, `captureRefusal`,
    `captureRoute` and **`captureBearer`** (A17);
  - `apps/web/src/server/relay/config.ts`: the `STREAM_INGEST_HOST`, `STREAM_PLAYBACK_HOST` and `STREAM_SRT_ENABLED`
    readers;
  - **`apps/web/src/server/api-v1/key-scopes.ts`** (`NEVER_KEY_ROUTES`, `:312`: `GET /capture/codes/:code`) and
    **`openapi.ts`** (its `ROUTES` entry under the `capture` tag), **in this commit (A16).** Otherwise
    `key-scopes.test.ts` (total classification) and `openapi-coverage.test.ts` (1:1) red from this commit until T8c.
- **Not touched (A17, FP13):** `server/relay/ingest-cf.ts`, `relay/ports.ts`, and the fake's capability
  `{rtmps: 183, srt: null}`. SRT's hold is unmeasured, and the capability saying so stays true.
- **Deploy env (OG9, FP19).** `STREAM_INGEST_HOST` and `STREAM_PLAYBACK_HOST` are in neither `fly.toml` nor
  `fly.stg.toml` `[env]` today. Without `STREAM_PLAYBACK_HOST`, a real-driver deployment answers
  `503 playback_unconfigured`, so stg's descriptor 503s after merge. **STOP: owner OK required (OG9)** before
  either toml or any Fly secret is changed. This task does not edit them.
- Test:
  - `server/relay/__tests__/ingest-cred.test.ts`;
  - `server/usecases/__tests__/capture-get.test.ts` (DB-backed);
  - `app/api/v1/capture/codes/__tests__/get-route.test.ts`;
  - `server/api-v1/__tests__/key-scopes.test.ts` and `openapi-coverage.test.ts` (A16).

**Interfaces:**

- Produces:

```ts
// ingest-cred.ts — §6.4, W15, W21
export type RawCred = { srt: { url: string; streamId: string; passphrase: string }; rtmps: { url: string; streamKey: string } };
export function ingestCred(raw: RawCred, env: { ingestHost: string | null; srtEnabled: boolean; latencyMs: number }):
  | { ok: true; cred: CaptureCred; preferred: "srt" | "rtmps" }
  | { ok: false; reason: "ingest_host_unexpected"; which: "srt" | "rtmps" };
export function srtEnabled(env?: NodeJS.ProcessEnv): boolean;   // unset → true (W21); "false" → false
// capture-http.ts
export function captureJson(status: number, body: unknown, headers?: Record<string, string>): Response; // + private, no-store, Pragma: no-cache
export function captureRefusal(e: CaptureRefusalError): Response;
export function captureRoute(fn: () => Promise<Response>): Promise<Response>; // runs inside handler(); maps CaptureRefusalError and HttpError(429) to bare bodies
/** A17: the capture Bearer. A missing header, a malformed one ("Bearer" with no token, another scheme, extra parts)
 *  all throw CaptureRefusalError(401, "code_ended"), the same body as a wrong tok or an ended code, so the wire never
 *  tells them apart. NOT relay/bearer.ts's bearerOf, which answers HttpError(401, …, "RELAY_TOKEN_INVALID"). */
export function captureBearer(req: Request): string;
// capture-phone.ts
export async function getCode(rawCode: string, tok: string, q: { slot: number; phone: string | null }, deps: SessionDeps, now: Date): Promise<z.infer<typeof CaptureDescriptor>>;
/** R7: the ONE owner of the length fit, used for every label and destinationName on the wire (GET and the beat
 *  answer). Under max → unchanged. Over → cut to exactly `max` UTF-16 units (what zod's .max measures), ending in a
 *  single "…", without splitting a surrogate pair. */
export function fitText(s: string, max: number): string;
```

- `ingestCred` core:

```ts
const CF = "live.cloudflare.com";
export function ingestCred(raw: RawCred, env: { ingestHost: string | null; srtEnabled: boolean; latencyMs: number }) {
  const rtmps = new URL(raw.rtmps.url);
  const srt = new URL(raw.srt.url);
  if (env.ingestHost !== null) {
    if (rtmps.hostname !== CF) return { ok: false, reason: "ingest_host_unexpected", which: "rtmps" } as const;
    if (env.srtEnabled && srt.hostname !== CF) return { ok: false, reason: "ingest_host_unexpected", which: "srt" } as const;
    rtmps.hostname = env.ingestHost;               // RTMPS only — SRT is never rewritten (W21)
  }
  const srtCred = env.srtEnabled
    ? { url: raw.srt.url, streamId: raw.srt.streamId, passphrase: raw.srt.passphrase, latencyMs: env.latencyMs }
    : null;
  return { ok: true, cred: { srt: srtCred, rtmps: { url: rtmps.toString(), streamKey: raw.rtmps.streamKey } },
           preferred: srtCred ? "srt" : "rtmps" } as const;
}
```

  `new URL("rtmps://…:443/live/").toString()` must keep the port and path. A test pins the exact output string,
  because `URL` normalises default ports for special schemes only, and `rtmps:` is not special.

- [ ] **Step 1: Write the failing tests.**
  - **`ingest-cred.test.ts`.**
    - Host set: RTMPS is rewritten, and SRT is untouched (`srt://live.cloudflare.com:778`).
    - A foreign RTMPS host → `ingest_host_unexpected` on `rtmps`. A foreign SRT host → the same on `srt`.
    - Host unset: the fake's `fake.ingest.invalid` values pass through.
    - `srtEnabled:false` → `srt: null` and `preferred: "rtmps"`.
    - `srtEnabled()` reads unset as `true` and `"false"` as `false` (the W21 default).
  - **`capture-get.test.ts`** (DB-backed). The §6.3.1 decision, one case per bullet:
    - an open session gives the session shape with `cred` for the current phone, and `cred` **absent** (the key is
      not present) for another phone;
    - an ended-after-warming session gives `completed` or `failed` with the wire `endReason` and no `cred`;
    - ended-before-warming, `requested`, `provisioning` and no session give waiting, with `pollSeconds: 5` while
      starting;
    - no `phone` gives waiting in every case;
    - every field from its §6.4 source:
      - `label` with a TBD side → the `breadcrumb.match` text in the organisation's `default_locale` (W25, Review
        Focus 5): one case per locale (en, es, fr, nl), with the expected text read from that locale's `ui.json`;
      - `venueTimezone` through the V305 lane;
      - `scheduledStart` omitted when null;
      - `overlayUrl` both ways of the entitlement (W18), never header-derived: a forged `X-Forwarded-Host` is
        ignored;
      - `playbackUrl` with no query;
      - `autoAllowed` is `false` in every shape (spec §6.4: PR-1 always `false`; PR-2 wires the switch);
      - `holdWindowSeconds.srt` = `INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS`, with both ≤ 999. **It is computed in
        the descriptor builder from those two `config.ts` declarations** (spec §6.4), never from the capability, whose
        `srt` stays `null` (A17, FP13). The expected value is read from the same two constants;
      - `warmingDeadline` = `(warmingAt ?? createdAt) + WARMING_TIMEOUT_MINUTES`, so it uses the same anchor as the
        timeout (A8). Add one case with a null `warming_at` (a session opened before V430).
    - **Label and destination length (R7, FP21).** Every expected value is derived from the contract maxima (200 and
      80), never typed:
      - two 200-character entrant names → `label.length === 200`, ending in exactly one `"…"`;
      - a legacy 81-character target label (inserted directly; the DB has no CHECK) → `destinationName.length === 80`,
        ending in `"…"`;
      - **the positive pair:** names whose `"{A} v {B}"` is exactly 200 characters → unchanged, with no ellipsis;
      - an emoji (a surrogate pair) straddling the cut → never split. The result still parses with the contract.
    - A real-driver deployment without `STREAM_PLAYBACK_HOST` → `503 playback_unconfigured`.
    - `credentials_served_count` increments only when `cred` was in the body. From T3 until T11 the organiser reveal
      also increments it (R3's interim meaning). Assert the descriptor's own increment by its delta, not by the
      absolute value.
  - **`get-route.test.ts`.**
    - The 2xx body is bare, with no `ok` key, and parses with `CaptureDescriptor`'s branch for its `state`.
    - A malformed code → `404 {code:"not_a_stream_code", message}`.
    - **The bearer (A17).** No `Authorization` header, a malformed Bearer, a wrong tok and an ended code each answer
      the **same** body, `401 {code:"code_ended", message}`. Assert the four bodies are deep-equal.
    - `Cache-Control: private, no-store` on 200, 401 and 404.
    - `slot` omitted → treated as 0. `slot=1` → `422 {code:"invalid"}`.
  - **Registry (A16).** `key-scopes.test.ts`: an org API key on `GET /capture/codes/:code` is refused at the door, and
    the route is classified. `openapi-coverage.test.ts`: the route is covered.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t8a.json && pnpm vitest run src/server/relay/__tests__/ingest-cred.test.ts src/server/usecases/__tests__/capture-get.test.ts src/app/api/v1/capture/codes/__tests__/get-route.test.ts src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-coverage.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t8a.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t8a.json
cd $WT && pnpm openapi:gen && git status --porcelain; echo EXIT=$?
```

  After the commit, `pnpm openapi:gen` leaves `git status --porcelain` empty (A16).

- [ ] **Step 3: Implement.**
  - The route reads the Bearer through **`captureBearer`** (A17), never `relay/bearer.ts`, and calls
    `captureRoute(() => getCode(…))`.
  - The code, pairing and session rows are read through the non-tenant `sql` (R1). The org comes from the code row.
  - `cred` comes from `readFirstInput` (`secret-columns.ts:195`), opened inside the request only.
  - The answer is built field by field, never by spreading a DB row.
  - `label` and `destinationName` go through `fitText(…, 200)` and `fitText(…, 80)`. T8b's answer reuses the same
    waiting-fields builder, so the truncation has one owner (R7).
  - Register the route in `NEVER_KEY_ROUTES` and `ROUTES` (A16).

- [ ] **Step 4: Run Step 2's command.** Expected: green.

- [ ] **Step 5: Mutate.**
  - Serve `cred` to any phone (drop the current check). Red: the two-phone case.
  - Rewrite SRT too. Red: the W21 case.
  - Make `srtEnabled()` default to false. Red: the default case.
  - Send `scheduledStart: null` on waiting. Red: the route's contract parse.
  - Drop `no-store` from the 401 path. Red: the header case.
  - `captureBearer` lets a missing header fall through to the tok compare as `""`. Red: the four-body equality case,
    or a 500.
  - `fitText` returns `s.slice(0, max)` with no ellipsis. Red: the 200-character label case.
  - `fitText` cuts at `max + 1`. Red: the contract parse of the 403-character case.
  - Read `holdWindowSeconds.srt` from the capability. Red: the hold case (it reads `null`).

- [ ] **Step 6: Commit** with `feat(capture): the descriptor GET — cred only to the current phone, SRT on Cloudflare
  (T8a)`, listing the mutations in the body.

Owes:

- unit and use-case;
- regression (`overlayUrl` is never header-derived; the uniform 401; the label fit).

### Task 8b: Beats — `POST /api/v1/capture/codes/{code}/beats`

**Files:**

- Modify: `apps/web/src/server/usecases/capture-phone.ts` (`postBeat`)
- Create: `apps/web/src/app/api/v1/capture/codes/[code]/beats/route.ts`
- Modify: `apps/web/src/server/api-v1/key-scopes.ts` (`NEVER_KEY_ROUTES`: `POST /capture/codes/:code/beats`) and
  `openapi.ts` (its `ROUTES` entry, tag `capture`), **in this commit (A16)**.
- Modify: `apps/web/src/server/relay/__tests__/_session-rig.ts`. **`pairPresentPhone`'s pairing step is re-pointed to
  a real `postBeat` claim** (a `claim: "new"` beat through the use-case), replacing T6's direct INSERT (FP25, A7).
  The helper's signature is unchanged, so no caller changes.
- Test:
  - `server/usecases/__tests__/capture-beat.test.ts` (DB-backed);
  - `app/api/v1/capture/codes/__tests__/beats-route.test.ts`;
  - `server/api-v1/__tests__/key-scopes.test.ts` and `openapi-coverage.test.ts` (A16);
  - every A7 caller file (T6's list), re-run because the rig now pairs through the real claim.

**Acceptance (A5, claim 4).** `capture-phone.ts` records events only through `server/relay/telemetry.ts`, and never
names `fixture_stream_events` or `fixture_stream_samples` in code. The V430 tables are read and written through the
non-tenant `sql` only (R1).

**Interfaces:**

- Produces `postBeat(rawCode, tok, body: CaptureBeat, deps, now): Promise<z.infer<typeof CaptureBeatAnswer>>`. The
  answer is built **per state** (R5, final; T1's union):
  - `waiting`: the common fields;
  - `go-live`: `sid` and `startedBy`, plus the common fields;
  - `live`: `sid`, plus the common fields, and **never `startedBy`**;
  - `over`: `sid` and `endReason` (`wireEndReason`, T4b), plus the common fields;
  - `replaced` and `taken`: no `sid`, `startedBy` or `endReason`.
  - The contract makes the common fields optional on `replaced` and `taken`. **This server still sends them on every
    2xx** (spec §6.3.3, ask 1, unchanged). The contract only stops requiring them there.
  - `device` is **never** sent by PR-1. The contract admits it on `replaced` and `taken` for PR-2's panel use (G0-e,
    §7.5).
- **`at` (R5).** `at` is parsed with `{ offset: true }` and normalised to UTC (`new Date(at).toISOString()`) before
  it is stored in `last_beat`, `phone_beat` or a history row's `raw`. It is never used for any server clock.
- The processing order, inside `sql.begin`, takes `select … for update` on the code row when a claim or a `stopped`
  is present (§6.3.2):
  1. resolve (C1) and rate-limit;
  2. `decideClaim` (T4a), then write the pairing rows (T2/T4: the old one becomes ENDED(replaced) and the session's
     `pairing_id` moves);
  3. store the beat:
     - `last_beat` and `last_beat_at` on the pairing, using the **server** `now`;
     - the session's `phone_beat` when the beat names the open sid;
     - history: a `minute` row when none exists in 60 s, a `change` row on a state or flag change; one row when both;
     - the purge on a `minute` insert;
     - wrapped in a savepoint, so a failure is logged and the answer still goes out;
  4. apply `ended` (T21/T22) or `stopped` (T23/T24/T24a);
  5. `tickSession(…, "beat")` (T7);
  6. answer: `beatAnswer` (T4b) plus the waiting fields plus `pollSeconds`, with the answered cadence stored on the
     pairing.

- [ ] **Step 1: Write the failing tests** (DB-backed). One case per transition row:
  - **Claims.**
    - T1–T7.
    - T3 → `taken`, and no row is written.
    - T4 with the fake set disconnected and the tuned clock → the new phone hears `live S`. Same sid, and no second
      consume.
    - **Concurrency:** two `new` claims at once leave exactly one current pairing (the gated-tx pattern).
  - **Stops.**
    - T21: the session's phone's `ended` ends the session `operator_stopped` and the pairing ENDED(operator_stopped).
      The answer is `over S stopped`.
    - T22: an `ended` from a phone that is not current → `replaced`, and nothing changes.
    - T23: `stopped: X` from the current phone closes X.
    - T24: an ended X → `over X`, and a newer Y stays open.
    - **T24a:** a non-current A's `stopped: X` while the current B holds X → `taken` or `replaced`, X stays live,
      and an event `stop_ignored`.
    - **T24a's positive branch,** built directly: no current pairing holds X → the stop applies.
  - **G0-g.** A refused `new` claim carrying `stopped: X` (X ended) → `taken`, never `over X`.
  - **The answer (R5).**
    - Every 2xx parses with `CaptureBeatAnswer`'s branch for its own `state`.
    - Every 2xx carries the waiting fields and `pollSeconds`, including `replaced` and `taken` (ask 1, unchanged).
    - `sid`, `startedBy` and `endReason` appear exactly where the matrix says (T1), and are otherwise **omitted**,
      never null. In particular, a `live` answer has no `startedBy` and an `over` answer has an `endReason`.
    - No answer carries `device` (PR-1).
    - Never 410: assert over every case that `status !== 410`.
  - **Storage.**
    - The minute throttle at 59 s and 60 s.
    - A change row for each flag: `battery_low` from `LOW_BATTERY_PERCENT`, `hot` from `HOT_THERMAL_STATUS`,
      `stalled`, `not_ready` and `not_responding`.
    - `at` five hours ahead still uses the server clock (Review Focus 4).
    - **`at` with an offset (R5).** A beat at `"2026-10-01T15:30:00+05:30"` is stored as `"2026-10-01T10:00:00.000Z"`.
      That expected string is a literal worked out by hand from the offset, never computed by the code under test.
    - A forced history-write failure (drop the history table inside a savepoint in the test) still answers 200.
  - **Strict body (Review Focus 2).**
    - An unknown key → 422.
    - An `appVersion` of 41 characters → 422.
    - A `device.model` of 81 characters → 422.
    - `endReason` without `state:"ended"` → 422.
    - `stopped` with a non-null `sid` → 422.
    - `device` on a non-claim beat is ignored, not stored.
    - `raw` stores only allowlisted keys.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t8b.json && pnpm vitest run src/server/usecases/__tests__/capture-beat.test.ts src/app/api/v1/capture/codes/__tests__/beats-route.test.ts src/server/usecases/__tests__/stream-tick.test.ts src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-coverage.test.ts src/server/usecases/__tests__/stream-sessions.test.ts src/server/usecases/__tests__/relay-sweep.test.ts src/server/usecases/__tests__/relay-internal-routes.test.ts src/server/usecases/__tests__/stream-targets.test.ts src/server/usecases/__tests__/stream-credits-monthly.test.ts "src/app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts" --reporter=json --outputFile=$SCRATCH/cq1-t8b.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t8b.json
cd $WT && pnpm openapi:gen && git status --porcelain; echo EXIT=$?
```

- [ ] **Step 3: Implement**, following the order above. The T24a check:

```ts
// X is held by the current phone iff X's session pairing_id is the slot's current pairing (§6.8.2).
const heldByCurrent = current !== null && xSession.pairingId === current.id;
const stopApplies = callerIsCurrentAfterClaim || !heldByCurrent;
```

- [ ] **Step 4: Run Step 2's command.** Expected: green.

- [ ] **Step 5: Mutate.**
  - Drop the T24a hold check. Red: "A's late stop must not end B's live X".
  - Apply the hold check to the current phone too. Red: T23.
  - Put `over` before `replaced`. Red: G0-g.
  - Make the history failure throw. Red: "still answers 200".
  - Use `at` for the throttle. Red: Review Focus 4.
  - Store `at` raw, without normalising it. Red: the `+05:30` case.
  - Add `startedBy` to the `live` answer. Red: the route's per-state contract parse.

- [ ] **Step 6: Commit** with `feat(capture): phone beats — claims, takeover, stops, storage, answer (T8b)`, listing
  the mutations in the body.

Owes: use-case and regression.

### Task 8c: `POST start`, rate limits, `Retry-After`, redaction, and the route registry

**Files:**

- Modify: `apps/web/src/server/usecases/capture-phone.ts` (`postStart`)
- Create: `apps/web/src/app/api/v1/capture/codes/[code]/start/route.ts`
- Modify:
  - `apps/web/src/lib/errors.ts`: `HttpError` gains `readonly headers?: Record<string,string>` as a 5th constructor
    argument;
  - `apps/web/src/lib/http.ts` and `apps/web/src/server/api-v1/http.ts`: both set `err.headers` on the response.
    `v1()` **merges** `HttpError.headers` with `rateLimitHeaders()` (`server/api-v1/http.ts:114`, `:139`), and neither
    clobbers the other (A15);
  - **`apps/web/src/lib/cache.ts` (A15, R4).** `INCR_WINDOW_LUA` (`:314-333`) returns `{count, pttl}`: the `INCR`,
    plus `PTTL` on the same key in the same script, still one command. `incrWindow` returns
    `{count, ttlMs} | null`;
  - `apps/web/src/lib/rate-limit.ts`:
    - `CounterFn` (`:43`) becomes `(key, windowSeconds) => Promise<{count: number; ttlMs: number} | null>`;
    - the 429 carries `Retry-After` = `max(1, ceil(ttlMs / 1000))`. That is the **true remaining seconds** (R4): an
      integer, and **never 0**, because a 0 makes clients hammer;
    - **the fail-closed 429** (`:61`, Redis configured but unreachable) has no window to read, so it answers
      `Retry-After` = the full `windowSeconds` (R4);
    - the presets `CAPTURE_CODE_LIMIT` (120/60 s), `CAPTURE_FAIL_LIMIT` (30/60 s per IP, failed 401s) and
      `CAPTURE_START_LIMIT` (6/60 s);
  - **every caller of the test seam `__setRateLimitCounterForTests`**, re-pointed to the new `CounterFn` shape in this
    commit (FP26). A15 named only the first; the tree has five:
    - `lib/__tests__/rate-limit.test.ts`;
    - `app/api/v1/competitions/[id]/exports/scorer-sheets/__tests__/route.test.ts`;
    - `server/usecases/__tests__/scoring-durable-idempotency.test.ts`;
    - `server/usecases/__tests__/scoring-idem-cache-version.test.ts`;
    - `server/usecases/__tests__/scoring-replay-is-free.test.ts`.

    Re-pin them with `grep -rln -a __setRateLimitCounterForTests $WT/apps/web/src`;
  - `apps/web/src/server/logger.ts`: `redact: ['req.headers.authorization','*.tok','*.cred','*.streamKey','*.passphrase']`;
  - **`apps/web/src/lib/scrub-score-url.ts` (A18, FP18; spec §10.2).** `scrubSentryEvent` gains three things:
    - a capture code in a `/api/v1/capture/codes/{code}` path is redacted;
    - the `Authorization` Bearer is redacted;
    - the request body of a capture route is dropped;
  - `apps/web/src/server/api-v1/key-scopes.ts` and `openapi.ts`: **only `POST /capture/codes/:code/start`.** T8a and
    T8b registered the other two in their own commits (A16).
- Test:
  - `server/usecases/__tests__/capture-start.test.ts`;
  - `lib/__tests__/rate-limit.test.ts` and **`lib/__tests__/rate-limit.redis.test.ts`** (A15: the Lua script's
    `{count, pttl}`);
  - `lib/__tests__/http.test.ts`, and `server/api-v1/__tests__/http.test.ts` (the `v1()` merge);
  - `server/__tests__/logger-redact.test.ts` (new);
  - `lib/__tests__/scrub-score-url.test.ts` (A18);
  - the four other seam callers above;
  - `key-scopes.test.ts`, `openapi-coverage.test.ts` and `stream-contract.test.ts` (the sibling pin).

**Interfaces:**

- Produces `postStart(rawCode, tok, body: CaptureStartBody, deps, now): Promise<{ sid: string }>`, which throws
  `CaptureRefusalError`. The mapping is §6.7.2, with no English shown to the phone.
- Consumes `startBroadcast` (T6) with `startCause: "operator"` and `phonePresent: true`, after the caller is checked
  current (T12).

- [ ] **Step 1: Write the failing tests.**
  - **Start.**
    - Each refusal in §6.7.2, asserting the **raw body**: `already_live` carries `sid` and `startedBy`; `replaced`,
      `no_destination`, `no_credit` (402), `not_entitled` (403) and `unavailable` (503) do not.
    - A retry after a lost 200 meets `409 already_live` with the same sid.
    - `target_in_use` → `409 no_destination`.
    - A start on an ended code (C1b) → 401.
    - Money: the operator start consumes once, at live.
  - **Retry-After (R4, A15).**
    - The limiter's 429 has `Retry-After` equal to the window's remaining seconds, driven through the seam with its
      new `{count, ttlMs}` shape. A case with `ttlMs: 42_500` → `"43"`. The expected value is derived from the
      `ttlMs` the test passes in.
    - **The boundary:** `ttlMs: 400`, which is under 1000 → `"1"`, never `"0"`.
    - **Fail-closed:** a configured but unreachable Redis (the counter returns `null` with `cacheEnabled()` true, on
      a `failClosed` limit) → 429 with `Retry-After` equal to the full `windowSeconds`.
    - The inert path (Redis not configured) still allows, with no 429. This is the positive pair of fail-closed.
    - `rate-limit.redis.test.ts`: the Lua script returns both the count and the TTL. On the first increment of a
      window, the TTL is the window.
    - `handler()` and `v1()` both copy `HttpError.headers`. **One `v1()` case carries both an `HttpError.headers`
      `Retry-After` and `rateLimitHeaders()`, and asserts that both survive.**
    - The capture routes' 429 body is `{code:"rate_limited", message}`.
  - **Redaction.** A spy logger drives each phone route, success and every error path. No captured line contains the
    tok, a stream key or a passphrase, and the count of captured lines is > 0 (anti-vacuity).
  - **Sentry scrub (A18).** Build a captured event through the real `beforeSend` path for a capture route that
    carries a code in its path, a Bearer header and a body. After the scrub:
    - the code is redacted;
    - the Bearer is redacted;
    - the body is gone.

    **The positive pair:** a non-capture path keeps its URL and body unchanged.
  - **Registry (A16).** T8c registers only the start route. `key-scopes.test.ts`: an org API key on each of the three
    phone routes is refused at the door. `stream-contract.test.ts` gains a sibling of the relay-route pin for the
    `capture` tag:
    - it holds exactly the three phone operations;
    - each is an explicit `NEVER_KEY_ROUTES` entry, with `matchKeyRoute(...) === null` on a concrete path;
    - its `checked === 3` count is asserted.

    `openapi-coverage.test.ts`: the three routes are covered.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t8c.json && pnpm vitest run src/server/usecases/__tests__/capture-start.test.ts src/lib/__tests__/rate-limit.test.ts src/lib/__tests__/rate-limit.redis.test.ts src/lib/__tests__/http.test.ts src/server/api-v1/__tests__/http.test.ts src/server/__tests__/logger-redact.test.ts src/lib/__tests__/scrub-score-url.test.ts src/lib/__tests__/scrub-score-url-wiring.test.ts "src/app/api/v1/competitions/[id]/exports/scorer-sheets/__tests__/route.test.ts" src/server/usecases/__tests__/scoring-durable-idempotency.test.ts src/server/usecases/__tests__/scoring-idem-cache-version.test.ts src/server/usecases/__tests__/scoring-replay-is-free.test.ts src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-coverage.test.ts src/server/api-v1/__tests__/stream-contract.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t8c.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t8c.json
cd $WT && pnpm openapi:gen && git status --porcelain; echo EXIT=$?
```

  `server/__tests__/logger-redact.test.ts` does not exist yet (checked 2026-10-01), so create it. The other paths
  exist. Confirm all fifteen appear in `.files`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run Step 2's command.** Expected: green.

- [ ] **Step 5: Mutate.**
  - Route `already_live` through a bare `HttpError`. Red: the `sid` body case.
  - Drop `Retry-After`. Red: its case.
  - `Retry-After` = `floor(ttlMs / 1000)`. Red: the `ttlMs: 400` boundary (it reads `"0"`).
  - The fail-closed path omits `Retry-After`. Red: the fail-closed case.
  - `v1()` replaces the headers with `HttpError.headers` instead of merging. Red: the both-survive case.
  - Remove `*.passphrase` from `redact`. Red: the spy case.
  - Skip the capture-body drop in `scrubSentryEvent`. Red: the Sentry scrub case.
  - Skip consume for `startCause operator`. Red: the money case.

- [ ] **Step 6: Commit** with `feat(capture): phone start, Retry-After, redaction, route registry (T8c)`, listing the
  mutations in the body.

Owes: use-case, unit and money.

---

## Wave M — read model and the model test

### Task 9: The panel's read model — `GET /api/v1/fixtures/{id}/stream-phone`

**Files:**

- Create:
  - `apps/web/src/server/usecases/stream-phone.ts`;
  - `apps/web/src/app/api/v1/fixtures/[id]/stream-phone/route.ts`.
- Modify: `apps/web/src/server/api-v1/schemas.ts` (`StreamPhone`), `key-scopes.ts` and `openapi.ts`.
- Test:
  - `server/usecases/__tests__/stream-phone.test.ts`;
  - `app/api/v1/fixtures/[id]/stream-phone/__tests__/route.test.ts`.

**Interfaces:**

- Produces `StreamPhone`, exactly the §9 row:
  - `code: {issuedAt, state: "active"|"finishing"|"ended", endCause} | null`;
  - `phone: {present, silent, notResponding, model, appVersion, mode, state, notReady, startFailed, lastBeatAt, elapsedMs,
    beat: {battery, bitrateKbps, delivery, thermal, dataUsedMB}} | null`;
  - `destination: {id, label} | null`;
  - `lastTakeover: {at, model} | null`;
  - `auto: null`. PR-2 fills it.

- [ ] **Step 1: Write the failing tests.**
  - No secret appears in the body: assert that `JSON.stringify(body)` contains neither the tok nor any `cred` value.
  - The phone states follow `isPresent`, `isSilent` and `isNotResponding`, with `elapsedMs` on the server clock.
  - The archived pre-pick reads `destination: null` (T36).
  - Editors only. An API key → refused (`NEVER_KEY_ROUTES`).
  - `stream-contract.test.ts`: the relay-route pin gains `GET /fixtures/:id/stream-phone`, for eleven (T6 widened
    the filter). Add the file to the scope command below.
  - **W24 on `current`:** `currentSession` gains `countdown`, computed by `lostCountdown` (T4b) from the same clocks
    the tick uses, on the server's `now`. Test it in `stream-sessions.test.ts`: live and silent past 30 s → a
    countdown whose `remainingMs` matches W19's firing (tick at `now + remainingMs` ends the session; tick 1 s earlier
    does not), and warming → remaining equals the warming deadline. Add `stream-sessions.test.ts` to the scope
    command.

- [ ] **Step 2: Run, implement, re-run.**

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t9.json && pnpm vitest run src/server/usecases/__tests__/stream-phone.test.ts "src/app/api/v1/fixtures/[id]/stream-phone/__tests__/route.test.ts" src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-coverage.test.ts src/server/api-v1/__tests__/stream-contract.test.ts src/server/usecases/__tests__/stream-sessions.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t9.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t9.json
```

- [ ] **Step 3: Mutate.**
  - Read `present` from the last beat alone, ignoring `ended_at`. Red: "a replaced pairing is not present".
  - Compute `countdown` from `heartbeat_at` instead of `phone_beat_at`. Red: the W19-agreement case.

- [ ] **Step 4: Commit** with `feat(stream): stream-phone read model for the panel (T9)`, listing the mutation in the
  body.

Owes: use-case.

### Task 10: The fast-check model (§11.1.4) and the mutation table

**Files:**

- Create: `apps/web/src/server/usecases/__tests__/capture-model.test.ts` (DB-backed)
- Create: `docs/superpowers/plans/2026-10-01-capture-qr-v2-pr1-mutations.md`, the killer list. The spec requires it
  in the PR, and this file is its source.

**Interfaces:**

- Consumes:
  - the real use-cases: `ensureStreamCode`, `postBeat`, `postStart`, `getCode`, `createSession`, `stopSession`,
    `tickSession`, `tickOpenSessions` and `reissueStreamCode`;
  - the fake drivers;
  - the **existing** `FakeIngest.setState(inputId, state)` (`relay/fakes.ts:130-134`), which is the same fake the
    unit tests use (A26, FP8). There is no `setConnected`;
  - an injected clock (`deps.now`).
- The model's action alphabet flips ingest (`ingestConnect` and `ingestDrop`) through `setState` only.

- [ ] **Step 1: Write the model.**
  - Use `fc.commands` with the actions in §11.1.4, two phones (A and B), and a model state:
    `{ current: "A"|"B"|null; open: {sid; live: boolean; holder: "A"|"B"} | null; stopRecords: Map<phone, sid> }`.
  - Each `Command.run` calls the real use-case, then checks **all eleven invariants** (the spec's ten plus W23's) against the DB.
  - `phone_lost` (invariant 10) is checked by reading `end_reason` and the clocks at the moment it was written.
  - **W23 and W22 join the model.** Add the actions `restart` (organiser Go live after an end) and `cronTick` (calls
    `tickOpenSessions`). Add invariant 11: the fixture's consume rows equal the W23 model's count, from the rule text
    as in T6b. Add a counter `paidRestarts`, which must be > 0.

```ts
it("capture model: eleven invariants hold over every generated sequence", async () => {
  const counts = { takeovers: 0, lateStopsDelivered: 0, lateStopsIgnoredHeld: 0, credsServed: 0, phoneLostLive: 0,
                   phoneLostWarming: 0, consumes: 0, refusedClaims: 0, oneCurrent: 0, oneOpen: 0 };
  await fc.assert(
    fc.asyncProperty(fc.commands(allCommands, { maxCommands: 40 }), async (cmds) => {
      const real = await freshFixtureWithCode();          // new org/fixture per run; fake drivers; clock at T0
      await fc.asyncModelRun(() => ({ model: initialModel(), real }), cmds);
    }),
    { numRuns: Number(process.env.CAPTURE_MODEL_RUNS ?? 60), seed: seedFromEnv(), verbose: 1 },
  );
  for (const [k, v] of Object.entries(counts)) expect(v, `invariant exercised: ${k}`).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Add the two pinned sequences** from §11.1.4 as plain `it` cases, using the same commands:
  - "A's late stop must not end B's live broadcast";
  - its positive pair.

- [ ] **Step 3: Run it three times**, logging each seed (house rule 8: a flaky-shaped gate runs three times).

```bash
cd $WT/apps/web && for i in 1 2 3; do rm -f $SCRATCH/cq1-t10-$i.json; CAPTURE_MODEL_SEED=$RANDOM pnpm vitest run src/server/usecases/__tests__/capture-model.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t10-$i.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests}' $SCRATCH/cq1-t10-$i.json; done
```

  A shrunk failure is committed as a named regression with its seed **before** the fix.

- [ ] **Step 4: Mutation table.** For every row of spec §11.1.3:
  1. apply the mutant;
  2. run its killer test's file;
  3. record `mutant | test name | RED`;
  4. revert.

  Most rows were already run in their task; re-run them here as one sweep on the integrated tree, because two guards
  covering for each other only show up together (AGENTS.md class 3). Write the table into the mutations file.

- [ ] **Step 5: Commit** with `test(capture): fast-check model with eleven invariants; mutation table (T10)`.

Owes: the sequence test and the mutation table.

---

## Wave U — the panel (gated on T2's sign-off)

### Task 11: The panel's Ready states and the v1 removal

**Precondition:** the owner has named Option A or B (T2 Step 4). If not, STOP.

**Files:**

- Modify:
  - `apps/web/src/components/v2/fixture-stream-panel.tsx` (the Ready states, and the `stream-phone` poll every
    `STREAM_POLL_MS` while open);
  - `apps/web/src/lib/stream-session-view.ts` (pure view helpers for the states).
- Modify, for the v1 removal (§6.13):
  - `lib/capture-qr.ts` (delete `CaptureQrV1` and `parseCaptureQr`);
  - `schemas.ts` (`StreamSessionCurrent.qr` removed);
  - `stream-sessions.ts`: `currentSession`'s `reveal` and the QR transaction (`:1534-1553` at T3, re-pinned now) are
    removed. **Keep the diff to the QR transaction.** Do not reflow `:1580-1600`, which is next to B0's hunk (A27);
  - `app/api/v1/fixtures/[id]/stream-sessions/current/route.ts` (`?reveal=1` → 400);
  - the two renamed columns' readers **are already re-pointed by T3** (R3). T11 only removes the reveal path's write,
    which leaves `credentials_served_*` counting descriptor serves alone (spec §6.13's meaning);
  - `capture-qr.test.ts`, `stream-sessions.test.ts`, `stream-contract.test.ts`, `stream-session-view.test.ts` and
    `fixture-stream-panel.test.tsx`: the v1 cases are removed. That includes the cases T1 kept on the inline
    `CaptureQrV1` literal (A1). They go with the type.
- **Modify, for the restart field (A9, inherited from T6b's option (a)):** remove the derived `restartFree` from the
  wire, and move every reader to `restart`:
  - `fixture-stream-panel.tsx` (`:1047`, `:1136-1138`, `:1282`, `:1320`, `:1496`; re-pin);
  - `fixture-stream-panel.test.tsx`;
  - `stream-contract.test.ts:176-206`;
  - `stream-sessions.test.ts:679-717`;
  - `schemas.ts:1371-1373`;
  - the i18n key `stream.phone.restartFree`, which is replaced by the `stream.restart.*` keys in all four locale
    dictionaries, then `gen-keys`.

  After this commit, `grep -rn -a restartFree $WT/apps/web/src` finds nothing.
- Modify: the dictionaries `{en,es,fr,nl}/ui.json`, then `pnpm i18n:gen-keys`. The keys are `stream.code.*`,
  `stream.phone.*`, `stream.end.*` and `stream.restart.*`. They include:
  - W19's "The phone and its video were gone for 15 minutes";
  - W24's "Reconnecting…", "No video from the phone for {elapsed} — the stream ends in {remaining} if it doesn't come
    back." and "No video from the phone yet — the stream is cancelled in {remaining} if it doesn't arrive.";
  - O5's reasons from spec §6.12 (`stream.phone.paused.*`): "Phone is on a call — video paused" and its four
    siblings;
  - W23's "Free restarts used ({used} of {limit})" and "Free restarts used ({used} of {limit}) — this one uses 1
    credit".
- Modify: `apps/web/e2e/mobile.spec.ts`, only if a stream testid it asserts changes.

**Interfaces:**

- Consumes `StreamPhone` (T9), the `stream-code` routes (T5), the `stream-settings` route (T5), and
  `captureQrV2Text` and `renderSeaznQr` / `SeaznQrImage` (existing, D7/D10, with `ph-no-capture` on the QR and the
  paste code).
- Produces the pure `reconnectReasonOf(phone: StreamPhone["phone"]): "camera" | "sound" | "network" | "held" |
  "weak" | null`, the §6.12 O5 mapping, exported from `stream-session-view.ts`.
- Produces the pure `readyStateOf(phone: StreamPhone | null, session: StreamSessionCurrent | null): "no_phone" |
  "paired" | "silent" | "waiting" | "live" | "ended" | "code_ended"`, exported from `stream-session-view.ts`.

- [ ] **Step 1: Write the failing unit tests.**
  - `stream-session-view.test.ts`: `readyStateOf` over every §6.12 row, with the empty case first (`null, null` →
    `no_phone`). Go live's enabled flag is true **only** for `paired`.
  - `fixture-stream-panel.test.tsx` (node, so markup only):
    - each state renders the signed-off option's structure and §6.12's copy keys;
    - the QR and the paste code carry `ph-no-capture`;
    - `captureQrV2Text` output has exactly 4 keys (W3 regression);
    - W24: with `countdown` set, the sentence renders `elapsed` and `remaining` through the locale's duration
      formatter; with a connected live session, the Phone node reads `stream.chain.word.noSignal`'s successor
      "Reconnecting…" only while the input is not connected, and no countdown renders when `countdown` is null;
    - W23: the restart line renders only when `restart` is non-null; the credit suffix only when `free` is false;
    - O5: `reconnectReasonOf` over every `notReady` value, then `degraded`, `reconnecting` and `publishing` (→ null),
      with the empty case first (`null` phone → null) and a count of 7. A live session, input not connected, the
      phone beating with `notReady: "camera"` → "Reconnecting…" plus "Phone is on a call — video paused", and **no**
      countdown sentence;
    - no `qr` or `reveal` is read.
  - Regression: `current` has no `qr`, and `?reveal=1` → 400.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f $SCRATCH/cq1-t11.json && pnpm vitest run src/lib/__tests__/stream-session-view.test.ts src/components/v2/__tests__/fixture-stream-panel.test.tsx src/lib/__tests__/capture-qr.test.ts src/server/usecases/__tests__/stream-sessions.test.ts src/server/api-v1/__tests__/stream-contract.test.ts "src/app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts" src/server/relay/__tests__/migration-shape.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t11.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t11.json
```

- [ ] **Step 3: Implement** the signed-off option. Then:
  - `cd $WT && pnpm i18n:gen-keys && pnpm i18n:check`;
  - `grep -rn -a -E "CaptureQrV1|parseCaptureQr\b|qr_issued_first_at|credentials_reveal|reveal=1|restartFree" $WT/apps/web/src`
    returns nothing, apart from V430's own "absent" assertions in `migration-shape.test.ts`.

- [ ] **Step 4: Run Step 2's command,** then typecheck and lint.

- [ ] **Step 5: Visual check.**
  1. Build the worktree for production (`seazn-local-env`).
  2. Screenshot every §6.12 state at 1280, 768 and 320. Crop to the panel: full-page shots dominate context.
  3. Confirm `scrollWidth <= innerWidth` at each width.
  4. Write a per-screen verdict against the signed-off mockup in the commit body.
  5. Run `mobile.spec.ts` **whole** across its seven width projects:

```bash
cd $WT/apps/web && for p in mobile-320 mobile-360 mobile-se mobile-14 mobile-430 tablet-768 tablet-834; do PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/mobile.spec.ts --project=$p --reporter=line; echo "$p EXIT=$?"; done
```

  The project names are the config's (`playwright.config.ts`, re-pinned 2026-10-01): `mobile-se` is 375 and
  `mobile-14` is 390. `mobile.spec.ts` is serial, so a red is a floor, not a total (AGENTS.md #21). Re-run after each
  fix until a full pass completes.

- [ ] **Step 6: Mutate.**
  - Enable Go live for `silent`. Red: the `readyStateOf` row.
  - Render the countdown whenever the input is down, ignoring `countdown: null`. Red: the O5 case.

- [ ] **Step 7: Commit** with `feat(stream): panel Ready states for the stream code; v1 QR removed (T11)`, with the
  mutation and the per-screen verdicts in the body.

Owes: unit, regression (v1 gone) and visual.

---

## Wave E — end to end

### Task 12: Walkthroughs, the fake phone, and smoke

**Files:**

- Create:
  - `apps/web/e2e/helpers/fake-capture-phone.ts`;
  - `apps/web/e2e/walkthrough/capture-phone.spec.ts`.
- Modify:
  - `apps/web/e2e/walkthrough/stream-relay.spec.ts`: the v2 rewrite of the QR steps, and the A11 zoom case on the v2
    QR;
  - **`apps/web/e2e/walkthrough/stream-credits.spec.ts` and `apps/web/e2e/walkthrough/directory-stream-destinations.spec.ts`
    (A7, critical).** Both drive an organiser Go live, which W5 refuses with no present phone. Each Go live first
    pairs a phone through `fakeCapturePhone`. Re-pinned 2026-10-01:
    - `stream-credits.spec.ts`: the Go-live assertions at `:607` and `:1103`, and the API start at `:917`;
    - `directory-stream-destinations.spec.ts`: the API start at `:233`, the click at `:371`, and the `goLive`
      helper at `:927`;
  - `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`: registers the new walkthrough, and pins R10's tunables;
  - **`.github/workflows/e2e.yml` (R10, Step 1b only; STOP: owner OK required, OG15).** The three tunables go in the
    e2e-parallel job's `Start server` step (`:756`, env beside `FAKE_INGEST_CONNECT_AFTER_MS` at `:782`) **and** its
    `Run Playwright` step (env beside `:834`). That job runs both the `parallel` and the `walkthrough` shards. The
    walkthroughs need the short values, and the shared server serves both;
  - `scripts/smoke.ts`: `captureV2Suite`, plus a `SELECTABLE_SUITES.captureV2` entry.
- **Re-pin every organiser Go-live in the e2e tree by behaviour, not by filename** (AGENTS.md class 16):

  ```bash
  cd $WT/apps/web && grep -rln -a -E 'stream-go-live|/stream-sessions`, "POST"' e2e
  ```

  On 2026-10-01 that finds exactly the three walkthroughs above. `mobile.spec.ts` does not start a session. Every file
  it finds is paired and run whole.

**Interfaces:**

- `fakeCapturePhone(page, request, { phone?: string })` returns `{ claim(kind), beat(partial), get(), start(),
  ended(), stoppedBeat(sid) }`. It reads the QR text **from the panel's paste-code field** (`stream-qr-text`), so the
  panel's own output drives the real routes. This is the inert-seam rule.
- **The tunables (R10, T4a's `tunable`).**
  - In CI (`ENV_NAME=ci`), the e2e-parallel server runs with `DEAD_PHONE_TAKEOVER_SECONDS=3`,
    `PHONE_LOST_LIVE_MINUTES=1` and `PHONE_SILENT_FLOOR_SECONDS` shortened. Locally, `ENV_NAME=local` takes the same
    values.
  - `tunable` honours them only when `ENV_NAME ∈ {local, ci}` (T4a). `e2e.yml` sets `ENV_NAME: ci`, so the fake-ingest
    route (T7) and the tunables both work there.
  - **`PHONE_SILENT_SLACK_SECONDS` is not tunable.** Only the floor shortens. The slack is the margin a real phone
    needs, and the threshold stays `max(floor, poll + slack)`.
  - `e2e-serial` and `e2e-mobile` get **none** of these. No capture walkthrough runs there.

- [ ] **Step 1: Write the walkthroughs** from spec §11.1.5. Every case is listed there.
  - Budgets are derived from the constants (AGENTS.md #20).
  - The server runs with the R10 tunables, so A14, ask 10 and W19 run in seconds.
  - **W24:** the W19 case also asserts:
    - the panel shows "Reconnecting…", then the countdown sentence after 30 s;
    - the session ends when the countdown reaches zero (within one poll).
  - **W22:** a W19 case with the panel **closed** ends through a direct `POST /api/cron/stream-tick` with the local
    `x-cron-secret`. That proves the job ends a session no one is watching.
  - **W23:** four restarts that reach video through the fake ingest. The panel shows
    "(3 of 3) — this one uses 1 credit" before the 4th, and the balance drops by exactly 1 after it.
  - Each spec asserts the env it needs at its top, and fails loudly if the env is missing.
  - The W19 case drives `fake-ingest/{inputId}` to disconnected (`FakeIngest.setState`, A26) and stops beats. It
    asserts the panel's `phone_lost` copy and the DB `end_reason`.
  - **A7.** In `stream-credits.spec.ts` and `directory-stream-destinations.spec.ts`, the pairing call is the only
    edit. Every existing assertion stays as written. Any other edit is a behaviour change: stop and report it.
  - **Audit the shortened floor.** `stream-relay.spec.ts` and `stream-credits.spec.ts` hold sessions open across
    long waits. Under a shortened silent floor, a phone that stops beating mid-test now ends `phone_lost` in seconds.
    - Read each wait in both files, and keep the fake phone beating through every wait that must not end the
      session.
    - Record each wait audited, and its count, in the commit body. **0 audited fails the step.**

- [ ] **Step 1b: Wire the tunables into CI (R10). STOP: owner OK required (OG15).** This edits live CI: `e2e.yml`
  runs on every push to `main`. Do not edit it until the controller relays the owner's OK.
  - Add the three tunables beside `FAKE_INGEST_CONNECT_AFTER_MS` in both e2e-parallel steps (`:782`, `:834`;
    re-pin).
  - Pin them in `e2e-ci-wiring.test.ts`, the same way `:916-957` pins `FAKE_INGEST_CONNECT_AFTER_MS`:
    - each name is present, with the same value, on e2e-parallel's `Start server` and `Run Playwright` steps;
    - each is **absent** from e2e-serial and e2e-mobile;
    - the count checked equals 3.

- [ ] **Step 2: Write `captureV2Suite`** from §11.1.6. It asserts the headers and the absence of `cred` for a second
  phone.

- [ ] **Step 3: Run** against a prod build of this worktree, with the R10 tunables set on the local server. Every
  file runs **whole**, never as a `-g` slice (class 21).

```bash
cd $WT/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/walkthrough/capture-phone.spec.ts e2e/walkthrough/stream-relay.spec.ts e2e/walkthrough/stream-credits.spec.ts e2e/walkthrough/directory-stream-destinations.spec.ts --project=walkthrough --reporter=line; echo EXIT=$?
cd $WT/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/stream-overlay.spec.ts --project=parallel --reporter=line; echo EXIT=$?
cd $WT/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/stream-overlay.spec.ts --project=parallel --list | tail -1
cd $WT && SMOKE_ONLY=captureV2 pnpm test:smoke; echo EXIT=$?
cd $WT/apps/web && rm -f $SCRATCH/cq1-t12.json && pnpm vitest run src/lib/__tests__/e2e-ci-wiring.test.ts --reporter=json --outputFile=$SCRATCH/cq1-t12.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/cq1-t12.json
cd $WT && ./packages/engine/node_modules/.bin/vitest run scripts/__tests__/smoke-select.test.ts; echo EXIT=$?
```

  - **`stream-overlay.spec.ts` is not a walkthrough (A19, FP20).** It sits at `e2e/`, outside the `walkthrough`
    project's `testMatch` (`/[\\/]e2e[\\/]walkthrough[\\/]/`). Under `--project=walkthrough` it selects zero tests and
    exits green. Run it under `parallel`, and confirm that `--list` reports **more than 0 tests**. Zero fails the
    step.
  - For every Playwright run, read the reporter's test count and confirm it is greater than 0. "No tests found" is a
    failure, not a pass.
  - The smoke script is the root `package.json`'s `test:smoke`. `smoke-select.test.ts` lives at the repo root and
    runs from there, as `ci.yml` runs it.

- [ ] **Step 4: Mutate.**
  - Comment out the fake phone's claim. Red: every pairing case, and the A7 Go lives, which proves the helper is
    load-bearing.
  - Make `fake-ingest` a no-op. Red: A14 and W19.
  - Drop one tunable from e2e-parallel's `Run Playwright` step only. Red: `e2e-ci-wiring.test.ts`'s same-value pin.

- [ ] **Step 5: Commit** with `test(capture): walkthroughs for the phone routes, fake phone, smoke capture-v2 (T12)`.
  The body lists:
  - the mutations;
  - every Go-live file paired, and its test count before and after (equal);
  - the shortened-floor audit and its count;
  - the `e2e.yml` change, if OG15 was granted. Otherwise, a note that Step 1b is held.

- [ ] **Step 6: The CI e2e signal (OG5). STOP: owner OK required.**
  - `e2e.yml` runs on push to `main` only, so a PR gets no automatic e2e.
  - A dispatched run uses **main's** `e2e.yml` unless it is dispatched with `--ref feat/capture-qr-v2-pr1`. This
    branch edits that file (R10), so the dispatch must carry `--ref`, or it tests without the tunables and reds the
    capture walkthroughs.
  - The dispatch is a CI run on a shared runner budget, so it waits for the owner's OK (OG5).

Owes: E2E and smoke.

### Task 13: Lane close — the scoped gate, the staging runbook, then STOP

- [ ] **Step 1: Re-check the migration number.**
  - Run `ls db/migration/deltas | sort -V | tail -1` on `origin/main`, and
    `git log --all --name-only | grep -a -E 'V43[0-9]__'`.
  - On 2026-10-01, main's newest delta is **V429** (`V429__weekly_digest_cron_once.sql`, the cron Worker's), so V430
    is next (FP1).
  - **If main has moved past V429,** renumber this branch's delta, re-pin every `V430` reference in the code and
    tests, and re-run T3's scope.

- [ ] **Step 2: Run the scoped gate.** That is the union of every task's vitest path list in one JSON run, then
  typecheck and lint. **Never the full suite.**
  - The union includes the cron Worker's run from T7b (`pnpm exec vitest run` in `apps/cron-worker`, plus
    `pnpm --filter @seazn/cron-worker typecheck`).
  - Confirm that every `.testResults[].name` resolves under `$WT`, and that `numTotalTests` equals the sum of the
    per-task totals recorded in each commit body.
  - Lint goes through `rtk proxy`. Read the `✖ N problems` line.

- [ ] **Step 3: Write the PR body draft** to `docs/superpowers/plans/2026-10-01-capture-qr-v2-pr1-pr-body.md`. It
  holds:
  - the mutation table (T10);
  - the per-screen verdicts (T11);
  - **the staging runbook S1–S11**, copied from spec §12 with each step's command. S2 includes the
    `srt-live-transmit` UDP-relay note. S11 is the W19 real-Cloudflare run. The whole runbook is
    **STOP: owner OK required (OG14)**. The runbook additions from A24:
    - **before S1:** set `STREAM_INGEST_HOST` and `STREAM_PLAYBACK_HOST` on stg, and confirm stg's `RELAY_DRIVERS`.
      **STOP: owner OK required (OG9).** Without `STREAM_PLAYBACK_HOST`, stg's descriptor answers
      `503 playback_unconfigured`. Any new ingest hostname is OG10;
    - **after the merge deploy:** confirm the stg Worker carries both triggers with
      `wrangler deployments list --env stg`. **STOP: owner OK required (OG12).** That command runs on the owner's
      account;
    - **watch one throttled firing:** with a deliberately failing `stream-tick` on stg, the `:00` firing sends exactly
      one Sentry event, and a later firing in the same hour logs `sentryThrottled: true` and sends none. Reading
      Workers logs (`wrangler tail`) is OG12;
  - **the Cron Trigger count.** Once both envs deploy, the account holds four of the Free plan's five triggers
    (Review Focus 5). Stg deploys its `*/5` trigger **on merge**, and wakes the stg machine every 5 minutes. **R9:
    the owner accepted that cost on 2026-10-01.** The merge itself is still **STOP: owner OK required (OG6)**;
  - **the deploy-order race (OG16).** `toolchain.test.ts` forbids `needs:` between deploy jobs, so the cron Worker
    can deploy before Fly serves `/api/cron/stream-tick`. The first firings would then 404 and send a Sentry event.
    The owner acknowledges this before OG6 and OG8;
  - **the R3 stg window.** V430 renames `credentials_revealed_*` → `credentials_served_*` and drops
    `qr_issued_first_at`. Between Flyway applying V430 on stg and Fly stg serving this branch's code, the old stg
    server's QR writer would fail on the missing columns. The window is the length of `stg.yml`'s Fly deploy after
    its migrate step. State it, and state that it closes when the deploy finishes;
  - **the sport scope (R8):** "Nothing else in PR-1 branches on sport. `finished_at` keys on `fixtures.status`, and
    T3 sweeps every status writer";
  - every OG row that is still open, with its STOP marker.

- [ ] **Step 4: STOP.** No push (OG3) and no PR (OG4). Report the branch, the gate counts and the open items to the
  orchestrator. Every later step in the OG table waits for the owner's OK, relayed by the controller.

---

## Self-review (2026-10-01, against the spec)

- **Spec coverage.**
  - §4 and §6.14 → T1.
  - §6.12 mockups → T2. Panel → T11.
  - §8 V430 → T3.
  - §5 machines → T4a/T4b.
  - §6.1/§6.2/§6.5 code, QR and pairing → T4a, T5 and T8b.
  - §6.3.1/§6.4/W21 → T8a.
  - §6.3.2/§6.3.3/§6.8.1–6.8.2/A17 → T8b.
  - §6.3.4/§6.7/§10 → T8c.
  - §6.6 → T4a and T8b.
  - §6.7.1 → T6.
  - §6.8.3/§6.8.5/§6.9–§6.11 → T7; the W22 job → T7b.
  - §6.7.4 (W23) → T6b, T10 and T11. W24 → T4b, T9 and T11. W25 → T8a.
  - §6.8.4 → T4b.
  - §9 `stream-phone` → T9.
  - §6.13 → T1 (contract) and T11 (code).
  - §11.1.3/§11.1.4 → T10.
  - §11.1.5/§11.1.6 → T12.
  - §12 → T13.

  §7 (automatic mode) is PR-2.
- **Placeholders.** None are left open.
  - V410's end-reason constraint name is now known: Postgres's default for the inline check,
    `fixture_stream_sessions_end_reason_check` (A4). T3 still confirms it with `\d` on the fresh DB, and pins it in a
    test.
  - There is no tenant policy text to copy. R1 chose the V410 pattern: enable plus force, with no policy, trigger or
    grant.
  - `TickObservation`'s field types are named, from `currentSession`'s locals today (T7).
- **Type consistency.**
  - `SlotState` includes `live_dead` (T4a); T4b and T8b consume it.
  - `WireEndReason` = `CaptureEndReason` (T1) = the output of `wireEndReason` (T4b). A terminal row with no mappable
    reason throws `TerminalWithoutReason` until R11 is ruled.
  - `CaptureBeatAnswer` is the R5 union (T1). T8b builds each branch, and T10's model parses every answer with it.
  - `CaptureDescriptor` and `CaptureSession` are unions on `state` (T1). T8a builds them.
  - `CaptureRefusalError` is born in T5 (`capture-http.ts`); `captureBearer`, `captureRoute`, `captureJson` and
    `captureRefusal` join it in T8a. T8b and T8c use them.
  - `fitText` is born in T8a, and T8b's answer reuses the same waiting-fields builder (R7).
  - `pairPresentPhone` is born in T6 (a direct pairing INSERT) and re-pointed to a real `postBeat` claim in T8b.
  - `TickObservation` is born in T7, and `currentSession` and `tickOpenSessions` (T7b) consume it.
  - `StreamTickResult` is written literally in T7b, and `drift.test.ts`'s counter scan reads `failed`.
  - `RestartAllowance` is born in T6b, beside the derived `restartFree`, which T11 removes.
  - `tunable` is born in T4a, and read by T7 and by T12's env (R10).
- **Review Focus.** All five lines have a test in their owning task (T5, T8b ×2, T7, T8a).
