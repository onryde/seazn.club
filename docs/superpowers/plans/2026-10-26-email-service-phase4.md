# Email outbox phase 4: the Seazn Email Service via QStash. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Written against `67eb05aedd`** (phase 3 wave 1 merged, #1035). Phase 4 starts after phase 3 wave 5. Waves 2–5 will
> move almost every count and line number below: kinds 7 → 51, `dispatchNow` call sites 11 → more, test files that mock
> the transport 44 → more, and the migration number. Every number here is "as of `67eb05aedd`, re-pin at T0", and every
> line is cited by symbol so an executor can re-pin it with `grep -an <symbol>`.

**Goal:** Move every email send out of the web app into a separate Seazn Email Service. The service is its own Fly app
and shares the Postgres database through a restricted role. QStash delivers it signed, retried `/dispatch {id}` calls
and a schedule that fires `/sweep` once a minute, and the Resend webhook moves to it. The app keeps one job for email:
writing the outbox row inside its own transaction.

**Architecture:** Part 1 ships whether the owner picks templates option A or B. The outbox core is already
kind-agnostic and render-free, except for two imports from `@/lib/email` and the kind hooks. Part 1 first makes the core
liftable inside the app (T1–T3, app PR P4-1). It then lifts the core into the service repo with a thin HTTP surface
(T4–T6). Next the app swaps `dispatchNow` for a QStash publish (T7–T9, app PR P4-2), and a cutover runbook moves traffic,
secrets and the webhook (T10–T11, app PR P4-3). Part 2 is only built if Q1 is answered B. It replaces each kind's sealed
`{html, text}` body with a sealed, versioned facts envelope `{kind, v, facts}`, and the service renders it on the first
attempt (T12–T18).

**Tech Stack:**
- App: Next (repo fork, see `AGENTS.md`), TypeScript, postgres.js, Postgres 17 with Flyway deltas, vitest (node), and
  Playwright on CI only.
- Service: Node (the engine floor in the app's root `package.json`, `>=26`), the same TypeScript, postgres.js, pino and
  vitest versions the app pins at T0, Hono with `@hono/node-server`, `@upstash/qstash`, and `zod` (Part 2 only).
- Infra: Fly.io (region `lhr`, like `fly.toml`), Upstash QStash, Resend, Supabase Postgres.

**Spec:** `docs/superpowers/specs/2026-10-26-email-service-phase4-note.md` (owner-approved roadmap, 2026-10-26).
Executors also read:
- `docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md` §2 (render at enqueue; the Resend 409 argument),
  §4 (first attempt), §11 (D3: the `{sent}` booleans keep their shape) and §12 (expiry);
- `docs/superpowers/plans/email-outbox-HANDOFF.md` (binding owner rules, the pending prod Resend webhook approval);
- the plan format and recipes in `docs/superpowers/plans/2026-10-26-email-outbox-phase3-wave2.md`.

**External API sources (verified 2026-10-26; re-read at T0, they change):**
- Deduplication: header `Upstash-Deduplication-Id`, SDK option `deduplicationId`. "The deduplication window is 10
  minutes." A duplicate is answered `202` with the existing message id.
  <https://upstash.com/docs/qstash/features/deduplication>
- Signatures: a JWT in `Upstash-Signature`.
  `new Receiver({ currentSigningKey, nextSigningKey })`, then `await receiver.verify({ body, signature, url })` on the
  RAW body. The claims are `iss`, `sub` (the destination URL), `exp`, `nbf`, and `body` (the SHA-256 of the raw body).
  <https://upstash.com/docs/qstash/howto/signature>
- Retries: 3 by default; header `Upstash-Retries`, option `retries`. Only a 2xx is success.
  `delay = min(86400, e ** (2.5*n))`. `Upstash-Retried` starts at 0. Answering 489 with
  `Upstash-NonRetryable-Error: true` stops the retries.
  <https://upstash.com/docs/qstash/features/retry>
- Flow control: `flowControl: { key, rate, period, parallelism }`, with headers `Upstash-Flow-Control-Key` and
  `Upstash-Flow-Control-Value: parallelism=…,rate=…,period=…`. `period` defaults to 1 s. Limits apply per key.
  <https://upstash.com/docs/qstash/features/flowcontrol>
- Schedules: `client.schedules.create({ destination, cron, scheduleId })`. The same `scheduleId` overwrites. UTC by
  default. <https://upstash.com/docs/qstash/features/schedules>
- Pricing: Free allows 1,000 messages a day and 10 active schedules. Pay as you go costs "$1 per 100K messages".
  "Scheduled messages are billed once for each time the schedule triggers." <https://upstash.com/pricing/qstash>

## PARKED (owner, 2026-10-26)

Phase 4 is parked after phase 3 wave 5. Start it only when one of these triggers happens: (1) email volume makes sending slow app requests or the minute cron cannot keep up; (2) a security review asks for the Resend key to be held outside the web app; (3) a second product or service needs to send email. Until then the in-app outbox (worker on the Cloudflare minute cron, `dispatchNow` for request emails, the Resend webhook in the app) is the design. The phase-3 obligations stay: no send path bypasses the outbox; dispatch/worker/webhook keep no app-render dependency. The owner questions below stay open until the phase starts.

Also parked with it (owner, 2026-10-26): **QStash dispatch inside `apps/web`**, no separate service. After commit the app publishes `{id}` to QStash, which POSTs a signed `/api/email-outbox/dispatch` on the app (claim, send, status). Request emails keep `dispatchNow`; the Cloudflare minute cron stays as the safety-net sweep (a lost publish leaves the row queued). Gain: webhook emails in seconds instead of up to a minute, retries on QStash backoff. Cost: about half a wave, three secrets (QStash token, two signing keys). Likely within QStash Free (1,000/day) with the cron kept; volume not measured. Considered and parked, not rejected.

## Global Constraints

- **Two repos.**
  - App: worktree `/Users/ashokhein/github/seazn.club/.claude/worktrees/email-p4`, cut from `origin/main` after wave 5
    merges. PR branches are `feat/email-service-p4-1`, `-p4-2`, `-p4-3` and `-p4-b<n>`.
  - Service: `onryde/seazn-email-service` (the name is pending Q3), cloned at
    `/Users/ashokhein/github/seazn-email-service`.
  - Prefix every command with `cd <abs path> &&`. Never check anything out in the main checkout, and never use
    `git stash`.
- **Owner rules for this programme** (HANDOFF, 2026-10-26), binding:
  - **Mainstream paths only.** Every rare case is one line under "Rare cases — recorded, not built". There are NO
    key-fault or KEK-unset tests, NO provider or QStash outage tests and NO race tests. The exception is a fix where
    money or data is lost or a secret's value leaks; its single test says why.
  - **No time on scripts or test tooling** beyond what a task names. The QStash schedule and the Resend webhook are
    created in their consoles, not by a script.
  - **Same-shape work is batched.** One dispatch and one review per batch, with one commit per kind (Part 2) or per
    producer file (T8).
  - **Changed while queued.** Part 1 changes nothing about what a row holds: the body is still sealed at enqueue by
    the app, and the service sends it as stored. So no kind gains a changed-while-queued case in Part 1. Part 2
    carries the per-kind line (T13–T17).
- **OWNER-GO.** A step marked **[OWNER-GO]** is not run by an agent. The controller asks the owner, the owner runs it
  or says "go", and the result is written to the ledger. This covers: creating a repo, a Fly app, a QStash account or
  plan, or a Resend webhook endpoint; any `fly secrets` change; any SQL on stg or prod; every merge, stg deploy and prod
  tag.
- **Secrets never touch argv, a URL or a log line** (memory: a secret in argv or in `new URL()` leaks).
  - Set them with `fly secrets import -a <app>` reading a `0600` file on stdin.
  - Set a role password with psql `\password` or `:'pw'` from a file.
  - Code logs a variable's NAME, never its value.
- **Migration number.** Main's max + 1, re-pinned right before the T3 commit and again before the PR:
  `git fetch origin && git ls-tree --name-only origin/main db/migration/deltas/ | sort -V | tail -1`. At `67eb05aedd`
  the max is `V472`, and wave 2 expects `V473`. Write it below as `V<N>`. If the number is taken, `git mv` and amend.
- **App recipes** (copied from the wave-2 plan; `$OUT` is the executor's own scratchpad subdirectory):
  - `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`. Run `$S up --label email-p4`, then confirm
    `show data_directory` is this label's. After a migration edit, run `$S down` then `$S up`. Never run a bare
    `pnpm db:apply`.
  - **VERIFY `<files>` → `tN`:**
    `cd <app wt>/apps/web && eval "$($S env --label email-p4)" && npx vitest run <files> --reporter=json --outputFile=$OUT/tN.json; echo EXIT=$?`,
    then `jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests, files: [.testResults[].name]}' $OUT/tN.json`.
    Green means `EXIT=0` and `failed == 0`, and every file is listed under this worktree's path.
  - **TSC:** `cd <app wt>/apps/web && rtk proxy npx tsc --noEmit -p tsconfig.json; echo EXIT=$?`.
  - **LINT:** `rtk proxy npx eslint <files>; echo EXIT=$?`. Read `✖ N problems`.
  - **MUTATE:** `cp` a backup, edit, VERIFY (the named test fails and `total` is unchanged), `cp` the backup back,
    VERIFY green. Never use `git checkout` or `git restore` on a file.
- **Service recipes.**
  - **SVC-VERIFY `<files>` → `tN`:**
    `cd /Users/ashokhein/github/seazn-email-service && eval "$($S env --label email-p4)" && DB_SCHEMA=<the label's schema> npx vitest run <files> --reporter=json --outputFile=$OUT/tN.json; echo EXIT=$?`,
    then the same `jq` check.
  - The suite reuses the app's local database and schema. That label's DB already carries the app's migrations,
    including `V<N>`.
  - **SVC-TSC:** `npx tsc --noEmit; echo EXIT=$?`.
- **Never run locally:**
  - the full vitest suite of either repo, the full e2e suite, `$S gate`, or a local web server;
  - e2e itself. The controller dispatches it on CI: `gh workflow run e2e.yml --ref <branch> -f pr=<n>`.
- **Copy.** Part 1 adds no user-facing string. D3's rewording already covers "queued, retrying". Part 2 moves the
  `emails` dictionary entries into the service. The app's `pnpm i18n:gen-keys && pnpm i18n:check` runs after each
  removal.
- **Test rules** (`docs/superpowers/TEST-STRATEGY.md`, `RULES.md`):
  - one test per behaviour, with the four types kept (unit, e2e, smoke, regression);
  - mutate each new guard once, with a named killer;
  - every sweep reports its count, and zero is a failure;
  - expected values come from the spec, this plan's literals, the dictionaries or the docs above, never from the code
    under test.
- **Models.** Use the agents in `.claude/agents/*.md` and the batching rule in `docs/superpowers/RULES.md`. This plan
  names no model.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Plan decisions where the tree contradicts or underdetermines the note

Each is a finding for the phase report. A controller who disagrees with one rules on it, or asks the owner, before the
task that owns it runs.

| # | The note says | The tree says (`67eb05aedd`) | Plan does |
|---|---|---|---|
| P4-1 | The KEK "moves" to the service. | The app seals every body at enqueue: `enqueue.ts` `insertQueued` calls `sealBody` (`:123`) under `EMAIL_OUTBOX_KEK` (`seal.ts:12`, `:82-87`). Option B also seals the facts at enqueue. | The KEK is COPIED, not moved: the app seals and the service opens (B: it also re-seals). The same value is set on both. RESEND_API_KEY and RESEND_WEBHOOK_SECRET do move. An asymmetric seal (the app holding only a public key) is recorded, not built: the app mints the links anyway. |
| P4-2 | The final section says the service carries "no rendering code"; the Q&A section recommends option B, where the service owns ALL rendering. | Every body is rendered and sealed at enqueue today. The send core needs only `checkSendable` and `deliver` from `@/lib/email` (`attempt.ts:31`, `transport.ts:7`) plus a type (`classify.ts:13`). | Part 1 is A-shaped: the service sends sealed bodies exactly as the app does today. Part 2 builds B on top, only if Q1 says B. |
| P4-3 | dispatch, the worker and the webhook "keep no dependency on app rendering … so they lift out cleanly". | They also run the kind hooks. `hooks.ts:8` imports the chess usecase (`invite-outbox-hook.ts`). The hooks are called from `dispatchNow` (`attempt.ts:524`), worker step 6 (`worker.ts:297-322`) and `applyProviderEvent` (`provider-events.ts:124-128`). | The hooks stay in the app. T2 takes the three calls out of the send core and adds `runHookRedrive()`, which the app's existing cron route runs every tick. The chess hook already recomputes from state (`hooks.ts:22-33`, R9), so this is safe. Seat release after a dead or bounced invite moves from "at once" to "within one tick" (1 min on prod, 5 on stg). `account-deletion` keeps its direct call (`app/api/users/me/route.ts:207`). |
| P4-4 | "after commit ──> QStash publish {id}". | Five callers AWAIT `dispatchNow`. Four read the outcome: `registrations.ts:1886` and `:1935` (resend), `:6334` (remind) and `external-play/invite.ts:403` (`dispatchAndClassify`). The magic-link route awaits for latency (`route.ts:102`). Spec §11: the `{sent}` / `email_sent` booleans keep their shape. | The app publishes, then `awaitEmailOutcomes` polls the rows for at most `AWAIT_OUTCOME_BUDGET_MS = 10_000` (the old `DISPATCH_NOW_BUDGET_MS`). D3's copy is already true for "not yet". Magic link: publish only, no wait. When the publisher is not configured (local, CI), the wait returns at once. |
| P4-5 | `/sweep` covers "lost publishes, retries, expiry". | `runOutboxTick` (`worker.ts:219-339`) already does exactly that, in-process and paced, minus the hooks (P4-3). | `/sweep` IS `runOutboxTick`, lifted unchanged. It does not publish the due ids back to `/dispatch`: that would double the message count and needs a per-attempt dedup id, because retries at 1 and 5 min fall inside the 10-min dedup window. |
| P4-6 | Dedup id = outbox id. | The dedup window is 10 minutes (docs). The real guard is the claim: `claimQueuedRow` (`attempt.ts:392-401`) takes only `attempts = 0`. | Kept as the note says. A late or duplicate `/dispatch` finds the row already claimed and answers `deferred`. |
| P4-7 | A schedule every minute. | 1,440 firings a day on prod alone, against the 1,000-a-day Free plan; each firing is billed (pricing page). | Pay as you go (Q2). The stg schedule runs `*/5`, as stg's cron does today (`apps/cron-worker/src/schedule.ts:46-56`). |
| P4-8 | The Resend webhook moves. | The route also writes the suppression list on bounce and complaint (`webhooks/resend/route.ts:86-101`, `suppress` from `lib/email.ts:96`). | Lifted whole. The role needs `select, insert` on `email_suppressions`. |
| P4-9 | (secrets move) | `outboxKeyProblem` keys "may this box send?" on `RESEND_API_KEY` (`seal.ts:36`). So does the boot readiness check (`readiness.ts:13-20`, `instrumentation.ts:46-52`). Once the key leaves the app, both go silent, and a missing KEK would queue bodiless rows that die `body_missing`. | The app keys on `QSTASH_TOKEN` (the publisher being configured) instead (T9). The existing `seal.test.ts` and `readiness.test.ts` re-point their env var. No new key-fault test (owner rule). |
| P4-10 | "restricted role (outbox tables only plus the few lookups)". | `email_outbox` is FORCE RLS, with only an INSERT policy for `app_user` (V470 `:120-123`). The role check accepts only superuser or BYPASSRLS (`role-check.ts:13-17`). A role that is neither gets every UPDATE matching zero rows, so everything is deferred quietly. | T3 adds `email_service` NOLOGIN, column-scoped grants and an RLS policy `for all to email_service`. The probe also accepts membership in `email_service`. The login role and its password are an ops step per env, so no password sits in a migration. |
| P4-11 | (contract) | The kind sweep drives the REAL send path through the transport double (`_kind-harness.ts:17-19`, `:124-134`; `outbox-kind-sweep.test.ts:42`). | After the lift the app's sweep stops at: one row, its body opens to the expected subject and content, and a publish was requested for R kinds. Sending is kind-agnostic and is tested in the service. |
| P4-12 | (shared facts) | The app keeps reading literals the service writes. `status.ts` `lockQueuedEmails` tests `last_error like 'http 429 %'` (the shape `attempt.ts` `lastErrorOf` writes, `:131-138`). `ACCOUNT_DELETED_REASON` and `deletedAccountPlaceholder` (`account-deletion.ts:58`, `:65`) are written by both. `MAX_EXPIRY_MS` (`constants.ts:111`) is derived from `LEASE_MS` and the slowest tick cadence, which become the service's. | Each literal is pinned by a literal-valued test in BOTH repos (T4 lists them). The service asserts `LEASE_MS + SLOWEST_SWEEP_MS <= 7 * 60_000` (the app's `EXPIRY_MARGIN_MS` today). The seal envelope is pinned by one committed sealed fixture that both repos open (T1, T4). |
| P4-13 | (cron) | The cron Worker's `email-outbox` job POSTs `/api/cron/email-outbox` and counts `data.failed` (`schedule.ts:146-154`). Its drift test reads the route's imports (`route.ts:4-6`). | The route keeps its path and secret. Its body becomes `runOutboxTick()` then `runHookRedrive()` (T2). From P4-2 on it is `runHookRedrive()` only, reporting `{ redriven, skipped, failed }` (T9). The job row is unchanged. |
| P4-14 | (logging) | `checkSendable` logs the address on the no-key and suppressed paths (`lib/email.ts:163`, `:171`). | The lifted gate logs `outboxId` only: the core's own rule is "never the address". |
| P4-15 | (CI) | With no Resend key, CI and local rows end `dead`/`no_api_key` in the request today. 4 e2e lines assert `no_api_key`; `scripts/smoke.ts` checks rows. | With no service in CI, rows stay `queued`, attempts 0, which is what prod looks like before the service picks them up. T10 re-points those assertions. |
| P4-16 | "Size: about one wave." | Part 1 is about one wave across two repos. Part 2 (B) re-plumbs every producer: 51 kinds after wave 5 (spec §1), plus 4 locales of dictionary per kind. | Recorded as a sizing finding. Part 2 is 5 batches, about 3 waves (Q1). |
| P4-17 | B: the locale is resolved at send. | Phase 3 D4 resolves it at enqueue (`locale.ts`). Spec §2: re-rendering at a later attempt can change the bytes under one idempotency key, and Resend answers `409 invalid_idempotent_request`, so the row ends `dead` (`classify.ts:31`). | B resolves the locale and renders at the FIRST attempt, then re-seals the render into `body_sealed`. Every retry sends those exact bytes (T12). |
| P4-18 | B: the app enqueues facts. | `subject text not null` is plaintext (V470 `:45`). Under B the app does not know the subject. | Part 2's migration makes `subject` nullable. The service writes it at render, before the send (T12). `status.ts` does not read `subject` (`grep -an subject status.ts` is empty at `67eb05aedd`). |

## Review Focus

1. **A stg QStash message replayed against prod.** One Upstash account signs for both environments. `verify` must bind
   the `url` to the receiving service's own public URL, so a message signed for stg is refused by prod. Test: T5 test 3.
2. **A publish that never arrives** (a crash between commit and publish, or a refused publish) must still send. The
   sweep takes the row once `FIRST_ATTEMPT_WINDOW_MS` has passed. Test: T5 test 6 (regression).
3. **The restricted role lacks one grant the service needs.** Every send would then be `deferred` with nothing in the
   way of an error. Test: the whole lifted service suite runs AS the role (T4 Step 3), and the T3 grant tests.
4. **An organiser who presses Resend or Remind** while the service is slower than the budget gets `{ sent: false }`,
   and D3's copy reads true. Test: T7 test 5.
5. **A chess invite that ends dead or bounced** must still release its seat, now through the app's re-drive and not
   inline. Test: T2 test 2.

## Owner questions (ask at phase-4 start, before T4)

1. **Q1: confirm templates option A or B.** (The note: "Final confirmation of option B is due at phase 4 start".)
   - **Recommendation: A for phase 4, with B (Part 2) kept planned but not scheduled.**
   - Part 1 alone delivers what phase 4 is for: no send, provider key or webhook in the app; one sender with its own
     deploys; and no address or body ever leaving our database.
   - B's value is template edits that ship with a service deploy instead of an app deploy, and a body that follows a
     locale change made before the first attempt. A person reading the email sees no difference.
   - B's cost: about 3 more waves (P4-16); the `emails` dictionary splits across two repos and two i18n checks; a facts
     contract to keep in step; and the service gains every builder. The note's own last section says the service
     should carry no rendering code (P4-2).
   - If the owner says B: Part 2 runs after Part 1's prod cutover. T1–T11 are unchanged either way.
2. **Q2: running costs.**
   - (a) QStash Pay as you go. Prod's schedule is 1,440 messages a day, stg's 288, plus one per email, which is over
     the Free plan's 1,000 a day. At "$1 per 100K" that is roughly $0.50–$1 a month.
   - (b) Prod service `min_machines_running = 1`, so a sign-in link never waits for a machine to resume (a small
     shared-cpu machine, a few dollars a month); stg at 0 with `auto_stop_machines = "suspend"`.
   - **Recommendation:** both. The cheaper alternative is to drive `/sweep` from the existing Cloudflare cron Worker and
     stay on Free. It saves about $1 a month, but leaves the service with two kinds of caller and a second shared
     secret.
3. **Q3: one repo or two.**
   - The approved shape is a separate repo, and this plan is written for it.
   - **Recommendation: a workspace app in this monorepo (`apps/email-service`), still its own Fly app,** as
     `apps/cron-worker` already is.
   - What the tree shows the separate repo costs:
     - its tests need the app's schema: CI checks out the app repo with a read token **[OWNER-GO]**, or the schema is
       copied;
     - the shared literals (P4-12) and, under B, the facts contract become a published package or a copied file
       pinned by tests in both repos;
     - two CI and deploy pipelines.
   - In the monorepo these become plain imports, the local env, and one more job in `ci.yml`, `stg.yml` and
     `prod.yml`. The isolation the owner wanted (own process, own secrets, own deploys) comes from the Fly app, not
     the repo.
   - If the owner picks the monorepo: T4 Step 1 creates `apps/email-service`, the T4 fixture copy becomes an import,
     T6's workflows become jobs in the existing files, and Part 2's contract is a workspace package. Nothing else
     changes.
4. **Q4: the prod Resend webhook events** (HANDOFF, an approval not yet carried out). The owner approved adding
   `email.delivered`, `email.delivery_delayed` and `email.suppressed` to the PROD webhook "only when the outbox reaches
   prod", and asked to be asked again then. T11 creates the prod endpoint on the service.
   - **Recommendation:** subscribe the new endpoint to all six events `PROVIDER_EVENT_STATUS` names
     (`provider-events.ts:46-53`). Owner value: prod rows reach `delivered`, so "did it arrive?" has an answer.

## Rare cases — recorded, not built

1. QStash down, or a publish refused or lost: the minute sweep sends the row after the 30 s first-attempt window.
2. A `/dispatch` that arrives after the sweep already sent the row: the claim finds nothing and answers `deferred`.
3. QStash-paced dispatches and the sweep's own pacing overlap and exceed 2 requests a second: Resend answers 429, the
   row retries a minute later, and a 429 stays key-clean (`recipient.ts:31`).
4. The service is down for longer than a row's life: the row ends `expired`, as with a stopped worker today.
5. KEK or Resend key unset or wrong on the service: rows end `dead` (`no_api_key` / `body_unreadable`). Set on stg and
   prod.
6. A signing-key rotation while messages are in flight: `Receiver` tries the current key, then the next.
7. A publish re-sent more than 10 minutes later (outside the dedup window): a second `/dispatch`, answered `deferred`.
8. During cutover, both webhook endpoints receive each event: the move is monotonic (`provider-events.ts:11-16`) and
   `suppress` is `on conflict do nothing`.
9. The app's cron route and the service's sweep both tick during cutover: `skip locked`, the lease and the fenced
   writes already make two ticks safe (`worker.ts:37-39`).
10. The login role's membership is revoked: the role check defers every row and logs, as today (`role-check.ts`).
11. The chess seat release waits up to one tick after an invite dies (P4-3).
12. (B) The app enqueues a facts version the deployed service does not know: the row ends `dead` with
    `facts_version_unknown`. Deploy order rule: service first (T12).
13. (B) A fact changes while a row waits in provider-outage retry: as in phase 3, not refreshed.

## File map

**App** (`/Users/ashokhein/github/seazn.club/.claude/worktrees/email-p4`):

| File | Responsibility | Tasks |
|---|---|---|
| `apps/web/src/server/email-outbox/resend.ts` (create) | `checkSendable`, `deliver`, `isSuppressed`, `suppress` and their types, out of `lib/email.ts` | T1 |
| `apps/web/src/lib/email.ts` | drops the send primitives (`:74-286` at `67eb05aedd`) and `emailConfigured` (`:1678`) | T1 |
| `apps/web/src/server/email-outbox/{attempt,transport,classify}.ts`, `app/api/webhooks/resend/route.ts` | import from `./resend` | T1 |
| `apps/web/src/server/email-outbox/__tests__/fixtures/sealed-sample.json` (create) | the envelope fixture both repos open | T1 |
| `apps/web/src/server/email-outbox/hook-redrive.ts` (create) | `runHookRedrive` | T2 |
| `apps/web/src/server/email-outbox/{attempt,worker,provider-events}.ts` | no hook calls | T2 |
| `apps/web/src/app/api/cron/email-outbox/route.ts` | tick then re-drive (T2); re-drive only (T9) | T2, T9 |
| `apps/web/src/server/email-outbox/__tests__/no-import-cycle.test.ts` | claim 4: the send core's closure | T1, T2 |
| `db/migration/deltas/V<N>__email_service_role.sql` (create) | role, grants, policy | T3 |
| `apps/web/src/server/email-outbox/role-check.ts` | the probe accepts `email_service` membership | T3 |
| `apps/web/src/server/email-outbox/publish.ts` (create) | `publishDispatch`, `awaitEmailOutcomes`, `isSentStatus` | T7 |
| producers that call `dispatchNow` (11 sites at `67eb05aedd`; re-count) | publish (and await where they answer) | T8 |
| `apps/web/src/server/email-outbox/{seal,readiness}.ts`, `index.ts`; delete `attempt.ts` send paths, `transport.ts`, `classify.ts`, `recipient.ts`, `provider-events.ts`, the tick in `worker.ts` | retire the send core | T9 |
| `apps/web/src/server/email-outbox/__tests__/_kind-harness.ts`, `outbox-kind-sweep.test.ts`, `no-second-path.test.ts`, and the transport-mocking test files (44 at `67eb05aedd`) | re-seam to `publish.ts` | T9 |
| `scripts/smoke.ts`, `apps/web/e2e/*` (the 4 `no_api_key` assertions) | queued, not dead | T10 |
| `app/api/webhooks/resend/` (delete), `.env.example` | after the cutover | T11 |

**Service** (`/Users/ashokhein/github/seazn-email-service`):

| File | Responsibility | Tasks |
|---|---|---|
| `src/core/*` | lifted: `constants`, `classify`, `attempt` (`dispatchNow`, `attemptClaimed`, `claimQueuedRow`), `worker` (`runOutboxTick`, `claimOne`), `recipient`, `provider-events`, `transport`, `resend`, `seal` (open; B also re-seals), `crypto` (the envelope from `server/relay/crypto.ts`, the outbox KEK only), `role-check`, `err-fields`, `account-deletion` (the reason and placeholder only), `purge` (`purgeOldEmails`) | T4 |
| `src/db.ts`, `src/logger.ts`, `src/env.ts` | postgres.js with the app's `connectionOptions` (`lib/db.ts:126-142`: `prepare` off on `:6543`), pino, env reads | T4 |
| `src/http/{app,verify-qstash,verify-svix}.ts`, `src/http/routes/{dispatch,sweep,webhook-resend,health}.ts`, `src/server.ts` | the HTTP surface | T5 |
| `test/**` | lifted suites, HTTP tests, literal pins | T4, T5 |
| `Dockerfile`, `fly.toml`, `fly.stg.toml`, `.github/workflows/{ci,stg,prod}.yml` | build and deploy | T6 |

---

## Part 1: the service (ships for A and B)

### Task 0: Preconditions (no commit)

**Files:** none.

- [ ] **Step 1: Wave 5 merged.**
  - `git log --oneline origin/main | grep -ai "outbox" | head` shows wave 5.
  - `grep -an "^export async function sendWithResult\|^async function send(" apps/web/src/lib/email.ts` is empty.
  - The no-second-path allowlist is empty.
  - If any of these fails, STOP.
- [ ] **Step 2: The owner's answers to Q1–Q4** are in the ledger. Q3 decides T4 Step 1's shape.
- [ ] **Step 3: Re-count and re-pin by symbol.** Write each into the ledger:
  - production `dispatchNow(` callers (11 at `67eb05aedd`): `grep -arn "dispatchNow(" apps/web/src | grep -v __tests__ | grep -v "\.test\."`;
  - test files that name the transport (44): `grep -arln "email-outbox/transport" apps/web/src`;
  - test files that name `dispatchNow` (34) or `runOutboxTick` (22 files);
  - `OUTBOX_KINDS.length` (51 expected);
  - every `file:line` cited in the Plan decisions table.
- [ ] **Step 4: Re-read the five QStash pages above.** Record any change to the dedup window, the `Receiver` and
  `verify` signature, the flow-control option names or the pricing. Pin the `@upstash/qstash` version at T0. Confirm
  whether its `batchJSON` takes `deduplicationId` and `flowControl` per message. If not, T7 publishes per id.
- [ ] **Step 5: Env.** `$S up --label email-p4`, and confirm `show data_directory`.

### Task 1: The send primitives leave `lib/email.ts`

Ships first: A and B both need it. It is a pure move, with one change: the gate no longer logs an address.

**Files:**
- Create `apps/web/src/server/email-outbox/resend.ts` and
  `apps/web/src/server/email-outbox/__tests__/fixtures/sealed-sample.json`.
- Modify:
  - `lib/email.ts`: remove `RESEND_ENDPOINT`, `from`, `replyTo`, `isSuppressed`, `suppress`, `SendOptions`,
    `SendBlocked`, `SendGate`, `DeliverResult`, `SendResult`, `checkSendable`, `readJson`, `errorNameOf`,
    `DeliverLogging`, `logToken`, `deliver` and `emailConfigured`. After wave 5, `send` and `sendWithResult` are already
    gone.
  - `email-outbox/attempt.ts:31`, `transport.ts:7`, `classify.ts:13`;
  - `app/api/webhooks/resend/route.ts:3`.
- Test:
  - `__tests__/no-import-cycle.test.ts` (claim 4);
  - `__tests__/no-second-path.test.ts` (its "two allowed imports" and its "exactly one file names `api.resend.com`"
    claim now name `email-outbox/resend.ts`);
  - `__tests__/seal.test.ts` (the fixture).

**Interfaces:**
- Produces, from `@/server/email-outbox/resend`, the same signatures `lib/email.ts` has today:
  - `checkSendable(opts: { to: string; subject: string; transactional?: boolean; outboxId?: string }): Promise<SendGate>`;
    its log lines carry `outboxId` and never `to`;
  - `deliver(opts: SendOptions, apiKey: string, logging?: DeliverLogging): Promise<DeliverResult>`;
  - `isSuppressed(email: string): Promise<boolean>`;
  - `suppress(email, type, providerId?): Promise<void>`;
  - the types `SendGate`, `SendBlocked`, `DeliverResult`, `SendResult`, `SendOptions`.
- `resend.ts` imports only `@/lib/db`, `@/server/logger` and `node:` modules. No `@/lib/i18n*`, `@/lib/email*` or
  `@/lib/email-templates*`.

- [ ] **Step 1: Write the failing tests.**
  - `no-import-cycle.test.ts` gains `claim 4: the send core's static import closure renders nothing and reaches no usecase`.
    - The roots are `attempt.ts`, `worker.ts`, `transport.ts`, `classify.ts`, `recipient.ts`, `provider-events.ts`,
      `role-check.ts`, `seal.ts`, `resend.ts` and `constants.ts`.
    - It walks with the file's existing walker.
    - It asserts the closure contains no path matching `/^lib\/email(\.ts|-templates\/)|^lib\/i18n|^dictionaries\//`.
    - It reports `checked`, the closure size, which must be `>= 10`.
    - The usecase half (`/^server\/usecases\//`) is asserted in T2. Here it is listed as an expected failure with
      the T2 reason, through vitest's `it.fails` on that one claim, so T1 is green before T2.
  - `seal.test.ts`: `the committed sealed sample opens to its plaintext`. The fixture is
    `{ kek: SAMPLE_OUTBOX_KEK, sealedBase64, plaintext: { html: "<p>sample</p>", text: "sample" } }`.
    The test opens `sealedBase64` under that KEK and asserts deep equality with `plaintext`. The executor generates
    the fixture once with `sealWith` in a scratch run and commits the JSON. The test only OPENS it, so a format change
    in either repo fails both.
- [ ] **Step 2: Run red.** VERIFY the three files → `t1`. Expected failure: claim 4 (the closure reaches
  `lib/email.ts`, and through it `lib/i18n` and `lib/email-templates`).
- [ ] **Step 3: Implement.** Move the code verbatim. Make the one log change (P4-14), and re-point the four imports.
- [ ] **Step 4: Run green.** VERIFY → `t1b`. Also VERIFY the webhook route's two suites and `classify.test.ts`. TSC
  and LINT.
- [ ] **Step 5: Mutate.** Add `import { getDictionary } from "@/lib/i18n";` (unused, with `void getDictionary`) to
  `resend.ts`: claim 4 fails. Restore.
- [ ] **Step 6: Commit.** `refactor(email-outbox): the send primitives leave lib/email for a render-free leaf`.

### Task 2: The kind hooks leave the send path

**Files:**
- Create `apps/web/src/server/email-outbox/hook-redrive.ts` and `__tests__/hook-redrive.test.ts`.
- Modify:
  - `attempt.ts`: remove `afterEndedBadly(ended)` at `:524` and the `ended` bookkeeping;
  - `worker.ts`: remove step 6 (`:297-322`) and the import at `:55`; the header lines `:27-31` are updated;
  - `provider-events.ts`: remove `:124-128` and the import at `:26`;
  - `app/api/cron/email-outbox/route.ts`;
  - `__tests__/no-import-cycle.test.ts`: claim 4's usecase half becomes a real assertion.
- Test:
  - the hook assertions in `worker.test.ts`, `dispatch.test.ts` and `provider-events.test.ts` move to
    `hook-redrive.test.ts`; T0 lists them by title;
  - `app/api/cron/email-outbox/__tests__/route.test.ts`.

**Interfaces:**
- Produces `runHookRedrive(opts?: { budgetMs?: number; nowMs?: () => number }): Promise<{ redriven: number; skipped: number }>`.
  - It calls `findUnappliedEndings(REDRIVE_LIMIT)` and then `afterEndedBadly` one row at a time.
  - It stops at `budgetMs` (default `HOOK_RESERVE_MS`, 10 s) and counts what it skipped. The logic is worker step 6's,
    moved, with the same `log.warn` on skips.
- `OutboxTickReport` is unchanged. The cron route answers `{ ...tickReport, redriven, skippedHooks }`, and `failed`
  still means the tick's own failures.

- [ ] **Step 1: Write the failing tests.**
  1. `hook-redrive.test.ts` › `a badly-ended chess invite is released by the re-drive, not by the tick`.
     - Stage a seat-stamped chess invite row and end it `dead` with `runOutboxTick({ onlyIds })`.
     - Assert the seat is still stamped. This is the negative half: the tick no longer runs hooks.
     - Then `runHookRedrive()`, and assert the seat is released and `redriven >= 1`.
     - Use the chess fixtures the moved worker hook tests already use.
  2. The same file, for a row moved to `bounced` by `applyProviderEvent`: still stamped after the event, released
     after `runHookRedrive()` (Review Focus 5).
  3. `route.test.ts` › `the cron route runs the tick and then the re-drive`: the answer carries `redriven`, and a
     badly-ended row's seat is released by one POST.
  4. Claim 4 now asserts that no `server/usecases/` path is in the closure. Remove the `it.fails`.
- [ ] **Step 2: Run red.** VERIFY → `t2`. Expected failures: tests 1 and 2 (the tick or event releases at once), test 3
  (no `redriven`), and claim 4 (the closure reaches `hooks.ts` and then `invite-outbox-hook.ts`).
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run green.** VERIFY `hook-redrive.test.ts`, `route.test.ts`, `no-import-cycle.test.ts`,
  `worker.test.ts`, `dispatch.test.ts`, `provider-events.test.ts` and `hooks.test.ts` → `t2b`. TSC. Also run
  `apps/cron-worker`'s `test/drift.test.ts`. Its expected list of route imports gains `hook-redrive`; edit the list, not
  the walker.
- [ ] **Step 5: Mutate.**
  - Remove the `runHookRedrive()` call from the route: test 3 fails.
  - Re-add `import { afterEndedBadly } from "./hooks"` to `worker.ts`, with a call: claim 4 fails.
  - Restore after each.
- [ ] **Step 6: Commit.** `refactor(email-outbox): kind hooks run from the app's re-drive, not from the send path`.

### Task 3: The `email_service` role

**Files:**
- Create `db/migration/deltas/V<N>__email_service_role.sql` and `__tests__/email-service-role.test.ts`.
- Modify `email-outbox/role-check.ts:13-17`.
- Test: `role-check.test.ts`.

**Interfaces:** the migration, as statements (each one line; the schema placeholder is `${flyway:defaultSchema}`, as in
V017):
- Create the role if absent: a `do $$ … if not exists (select from pg_roles where rolname = 'email_service') then create role email_service nologin; …` block, shaped like V017's `app_user` block.
- Grants:
  - `grant usage on schema ${flyway:defaultSchema} to email_service;`
  - `grant select, update, delete on email_outbox to email_service;`. No insert: only the app writes rows.
  - `grant select, insert on email_suppressions to email_service;`
  - `grant select (id, email, deleted_at, locale) on users to email_service;` (`locale` is for B; harmless in A)
  - `grant select (id, default_locale) on organizations to email_service;` (B)
- The policy: `create policy email_outbox_service on email_outbox for all to email_service using (true) with check (true);`
- `role-check.ts` `probeOutboxRole`:
  `select (rolsuper or rolbypassrls or pg_has_role(current_user, 'email_service', 'MEMBER')) as ok from pg_roles where rolname = current_user`.

- [ ] **Step 1: Write the failing tests** (`email-service-role.test.ts`). Each test runs in a `sql.begin` with
  `set local role email_service`, on rows the file stages as the superuser:
  1. `the service role claims, sends and ends a row`: `claimQueuedRow(id, new Date())` (the real exported statement)
     returns the row, and the fenced `markSent`-shaped update returns one row. Then
     `update … set status = 'sent' … returning id` yields 1 row.
  2. `the service role inserts a suppression and reads it back`.
  3. `the service role reads users (id, email, deleted_at) and is refused another column`.
     `select password_hash from users limit 1` throws `42501`. If `password_hash` does not exist at T0, use any
     column outside the four granted; record which.
  4. `the service role purges an old row`: `delete … where id = $1` returns 1.
  5. `the service role cannot insert into email_outbox`: an insert throws `42501`.
  - `role-check.test.ts` gains `a member of email_service passes the probe`. It runs as a fresh
    `create role email_svc_probe_<tag> login in role email_service`, created and dropped by the test.
- [ ] **Step 2: Run red** (before the migration exists). VERIFY → `t3`.
- [ ] **Step 3: Implement.** Write the migration and the probe. `$S down && $S up`.
- [ ] **Step 4: Run green.** VERIFY → `t3b`. Re-run `outbox-schema.test.ts`: if it lists the table's policies, add
  `email_outbox_service` there.
- [ ] **Step 5: Mutate.**
  - Drop the `delete` grant (env down and up): test 4 fails.
  - Drop the policy: test 1 fails (zero rows claimed).
  - Remove `pg_has_role(…)` from the probe: the probe test fails.
  - Restore after each.
- [ ] **Step 6: Commit.** `feat(db): email_service role for the email service, outbox and suppressions only`.

**PR P4-1** (T1–T3):
- Rebase onto `origin/main` and re-pin `V<N>`.
- Paste the scoped VERIFY counts for every file T1–T3 touched.
- Smoke runs on the PR. T1–T3 change no behaviour a smoke check sees, except the hook timing.
- Dispatch e2e (`online-chess-desk.spec.ts` covers the seat). Treat a serial red as a floor.
- **[OWNER-GO] merge.** On merge, stg applies `V<N>` on deploy. Prod applies it at the next tag.

### Task 4: The service repo and the lifted core

**Files** (service repo): `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/core/*`, `src/db.ts`,
`src/logger.ts`, `src/env.ts`, `test/core/*`, `test/fixtures/sealed-sample.json` (a copy of T1's), `test/setup.ts`.

**Interfaces:**
- `src/core` exports the same names and signatures as the app's modules at P4-1's merge commit: `dispatchNow`,
  `attemptClaimed`, `claimQueuedRow`, `runOutboxTick`, `claimOne`, `applyProviderEvent`, `resolveRecipient`,
  `isKeyClean`, `classifyResult`, `nextAttemptAt`, `openBody`, `outboxRoleOk`, `purgeOldEmails`, `checkSendable`,
  `deliver` and `suppress`.
- Import paths become relative. `@/lib/db` → `src/db.ts`; `@/server/logger` → `src/logger.ts`;
  `@/server/relay/crypto` → `src/core/crypto.ts` (the envelope's open and seal for `EMAIL_OUTBOX_KEK` only, nothing
  for the other three KEKs).
- `src/env.ts`: `requireEnv(name)` and `optionalEnv(name)`. Names: `DATABASE_URL`, `DB_SCHEMA` (tests), `EMAIL_OUTBOX_KEK`,
  `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`,
  `PUBLIC_BASE_URL`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `NODE_ENV`.

- [ ] **Step 1: [OWNER-GO] Create the repo** `onryde/seazn-email-service` (private), or `apps/email-service` if Q3 =
  monorepo. Clone it.
- [ ] **Step 2: Lift.**
  - Copy the modules above from the app at P4-1's merge SHA (record it), and change only imports.
  - Copy the core suites:
    - `classify.test.ts`, `dispatch.test.ts`, `dispatch-pacing.test.ts`, `dispatch-wire.test.ts`;
    - `worker.test.ts`, `worker-wire.test.ts`, `worker-purge-wiring.test.ts`;
    - `provider-events.test.ts`, `recipient-resolution.test.ts`, `role-check.test.ts`;
    - the open half of `seal.test.ts`;
    - the two webhook route suites, as `test/http/` stubs to be finished in T5.
    - The list is from `67eb05aedd`; T0 re-lists it.
  - Each keeps its `vi.mock` of `./transport`. Fixtures that called app usecases (chess seats in the old hook tests)
    stayed in the app in T2. A lifted test that still needs a usecase is a T2 leftover: STOP and report it.
- [ ] **Step 3: Run the suite as the restricted role** (Review Focus 3).
  - `test/setup.ts` creates `email_svc_test_<pid> login in role email_service` once (as the superuser `DATABASE_URL`),
    with no password. Use local trust, or a generated one passed through `PGPASSWORD` in the process env, never argv.
  - The suite's `src/db.ts` connects AS that role. Staging inserts, which the role may not do, go through a separate
    superuser handle, `test/stage-db.ts`.
  - This is the one piece of new test tooling the plan needs. It replaces nothing and is under 40 lines.
- [ ] **Step 4: Literal pins** (`test/core/contract-literals.test.ts`), each value typed from this plan and never
  imported:
  - `idempotencyKey("…")` is `` `email-outbox/${id}` ``;
  - `OUTBOX_TAG_NAME` is `"outbox"`;
  - `ACCOUNT_DELETED_REASON` is `"account_deleted"`;
  - `deletedAccountPlaceholder(u)` is `` `deleted-${u}@deleted.invalid` ``;
  - a 429 attempt writes `last_error` matching `/^http 429 /`;
  - `LEASE_MS + 5 * 60_000 <= 7 * 60_000` (P4-12);
  - the fixture opens. The app's `seal.test.ts` opens the same bytes.
  - It reports `checked === 7`.
- [ ] **Step 5: Run.** SVC-VERIFY the whole lifted list → `t4`. This is the service's whole suite, which is scoped by
  definition. Expected: the same `total` as the app's copies had at the SHA, `failed: 0`. SVC-TSC.
- [ ] **Step 6: Mutate.** Revoke `update` on `email_outbox` from `email_service` for the run (in the local DB, then
  re-grant): the dispatch suites fail on "deferred" instead of "sent". That proves the role is really in use.
- [ ] **Step 7: Commit.** `feat: lift the email outbox send core from seazn.club@<sha>`.

### Task 5: The HTTP surface

**Files:** `src/http/app.ts`, `src/http/verify-qstash.ts`, `src/http/verify-svix.ts` (lifted from
`webhooks/resend/route.ts:14-71`), `src/http/routes/{dispatch,sweep,webhook-resend,health}.ts`, `src/server.ts`, and
`test/http/*.test.ts`.

**Interfaces:**
- `verifyQstash(req: { rawBody: string; signature: string | null; path: string }): Promise<boolean>` uses
  `new Receiver({ currentSigningKey, nextSigningKey })` and
  `receiver.verify({ body: rawBody, signature, url: PUBLIC_BASE_URL + path })`. A missing header or a throw is false.
  The URL is the configured public one, never the request's own URL: Fly's proxy rewrites the host.
- `POST /dispatch`, body `{ "id": "<uuid>" }`:
  - it verifies the signature, else answers 401;
  - it runs `dispatchNow([id])`, which already answers `deferred` for a malformed id and never throws;
  - it answers `200 { outcome }` for every outcome. A non-2xx would make QStash retry a row whose own retry schedule
    lives in the database.
- `POST /sweep` verifies the signature, else 401, then answers `200` with `runOutboxTick()`'s report. The schedule is
  created with retries 0 (T11): the next firing is the retry, as the cron job is today.
- `POST /webhooks/resend` is the lifted route body (`route.ts:103-146`): Svix verify, `suppress` on bounce or
  complaint, `applyProviderEvent`, and 500 on its failure so Resend retries.
- `GET /healthz` answers `200 { ok: true }`, with no DB call (it is Fly's check).
- The body is read raw ONCE (`await c.req.text()`) and handed to the verifier before any parse (the doc's raw-body
  warning).

- [ ] **Step 1: Write the failing tests.**
  - Signed requests are minted in the test with `jose`: HS256 under a test signing key, with claims
    `{ iss: "Upstash", sub: url, exp: now + 300, nbf: now, iat: now, jti, body: base64url(sha256(rawBody)) }` (the
    claims named on the signature page). Its expected `url` values are literal strings in the test.
  - The cases:
    1. `a signed dispatch sends the row`: stage a queued row with the transport mocked to 200. The answer is
       `200 { outcome: "sent" }` and the row is `sent`.
    2. `an unsigned dispatch is refused and sends nothing`: 401, and the row is still `queued`.
    3. `a dispatch signed for the stg URL is refused by the prod service` (Review Focus 1): `sub` is
       `https://seazn-email-stg.fly.dev/dispatch` while `PUBLIC_BASE_URL` is prod's. Expect 401.
    4. `a signed dispatch whose body was changed after signing is refused`: 401.
    5. `a second dispatch of the same id is deferred`: 200 `{ outcome: "deferred" }`, and the transport was called once.
    6. `the sweep sends a row whose publish never arrived` (Review Focus 2, regression): a queued row,
       `attempts = 0`, born `FIRST_ATTEMPT_WINDOW_MS + 1 s` ago (`bornAgo` lifted), with no `/dispatch` ever sent. A
       signed `/sweep` gives a report with `sent: 1`, and the row is `sent`.
    7. `an unsigned sweep is refused`: 401.
    8. The two lifted webhook suites run against `/webhooks/resend` (signature, monotonic move, suppression).
    9. `healthz answers without the database`: 200 with `DATABASE_URL` pointed at a closed port.
- [ ] **Step 2: Run red.** SVC-VERIFY `test/http` → `t5`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green.** SVC-VERIFY `test/http` plus `test/core` → `t5b`. SVC-TSC.
- [ ] **Step 5: Mutate.**
  - `verifyQstash` returns true: tests 2, 3, 4 and 7 fail.
  - Pass `url: undefined` to `verify`: test 3 fails.
  - Restore after each.
- [ ] **Step 6: Commit.** `feat(http): signed /dispatch and /sweep, the Resend webhook, healthz`.

### Task 6: Build and deploy

**Files:** `Dockerfile` (Node per T0, `pnpm install --frozen-lockfile`, `node dist/server.js`),
`fly.toml` (`app = "seazn-email-prod"`, `primary_region = "lhr"`, `internal_port = 8080`, an http check on
`/healthz`, `auto_stop_machines = "suspend"`, `min_machines_running` per Q2), `fly.stg.toml`
(`seazn-email-stg`, min 0), and `.github/workflows/ci.yml`, `stg.yml` and `prod.yml`.

**Interfaces:**
- `ci.yml` runs on PR and push. It typechecks and runs vitest with a `postgres:17` service.
  - The schema comes from the app: `actions/checkout` of `onryde/seazn.club` at `main`, using the repo secret
    `APP_REPO_READ_TOKEN` **[OWNER-GO]**, then the app's Flyway migrations into the service DB.
  - It then creates the same test login role as `test/setup.ts`.
  - If Q3 = monorepo, this is a job in the app's `ci.yml` instead.
- `stg.yml` runs on push to `main`: `flyctl deploy -c fly.stg.toml`, then `curl -fsS https://seazn-email-stg.fly.dev/healthz`
  as the deploy smoke.
- `prod.yml` runs on a `v*.*.*` tag. It mirrors the app's `prod.yml` (`:45-47`, `:207`), the same way.

- [ ] **Step 1: Write and push the workflows** on a PR branch. CI must be green with the `t4`/`t5` totals.
- [ ] **Step 2: [OWNER-GO]** `fly apps create seazn-email-stg` and `fly apps create seazn-email-prod`. Add the
  repo secrets `FLY_API_TOKEN` and `APP_REPO_READ_TOKEN`.
- [ ] **Step 3: Commit.** `ci: build, test as the restricted role, deploy stg on main and prod on tag`.

Stop here until T11 Phase A. The service stays undeployed until its secrets exist.

### Task 7: The app publishes, and answers from the row

**Files:** create `apps/web/src/server/email-outbox/publish.ts` and `__tests__/publish.test.ts`; modify
`index.ts`; add a `serviceDouble` to `__tests__/_kind-harness.ts`.

**Interfaces:**
- `publishDispatch(ids: readonly string[]): Promise<boolean>`.
  - It returns `false` without a request when `QSTASH_TOKEN` or `EMAIL_SERVICE_URL` is unset (local, CI).
  - Otherwise it publishes one message per id: `url: \`${EMAIL_SERVICE_URL}/dispatch\``, `body: { id }`,
    `deduplicationId: id`, `retries: 3`,
    `flowControl: { key: \`resend-${EMAIL_SERVICE_ENV}\`, parallelism: 1, rate: 1, period: "1s" }`.
    The rate stays below Resend's 2 a second, and the sweep paces itself on top.
  - Use `batchJSON` if T0 Step 4 confirmed it takes these options; otherwise `publishJSON` per id.
  - It never throws. On an error it logs `{ ids: n, ...errFields(err) }` and returns false. The sweep sends the rows
    (rare case 1).
  - The id goes in the body, never in the URL.
- `awaitEmailOutcomes(ids: readonly string[], opts?: { budgetMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; nowMs?: () => number }): Promise<Map<string, OutboxStatus>>`.
  - It polls `select id, status, attempts from email_outbox where id = any($1)` every `pollMs` (250). It stops once
    no row is `sending` or `queued` with `attempts = 0`, or after `budgetMs` (`AWAIT_OUTCOME_BUDGET_MS = 10_000`, a new
    constant in `constants.ts`).
  - It returns each row's last status.
- `isSentStatus(s: OutboxStatus | undefined): boolean` is true for `sent`, `delayed` and `delivered`.
- `serviceDouble(outcome: "sent" | "dead" | "retrying")` is a test helper. It returns an implementation for a mocked
  `publishDispatch` that writes the outcome to each id's row by SQL (`sent` sets `provider_id 'test_<id>'` and nulls
  the body), then returns true. It is about 15 lines and no framework.

- [ ] **Step 1: Write the failing tests** (`publish.test.ts`, `vi.mock("@upstash/qstash")`):
  1. `with no token, nothing is published and the answer is false`.
  2. `each id is published once to /dispatch with its own dedup id and the env's flow-control key`. It asserts the
     mocked SDK's arguments against this plan's literals.
  3. `a publish that throws answers false and does not throw`.
  4. `awaitEmailOutcomes returns as soon as every row has left its first attempt`: a fake clock, with rows flipped to
     `sent` after 2 polls. It returns after 2 polls, and the map says `sent`.
  5. `awaitEmailOutcomes gives up at the budget and reports the row as it stands` (Review Focus 4): the row stays
     `queued`, attempts 0. It returns at 10 000 ms of fake clock with `queued`, and `isSentStatus` is false.
  6. `a retrying row (queued, attempts 1) is an outcome, not a wait`: it returns at the first poll.
- [ ] **Step 2: Run red.** VERIFY → `t7`.
- [ ] **Step 3: Implement.** Add `@upstash/qstash` at the T0 pin.
- [ ] **Step 4: Run green.** VERIFY → `t7b`. TSC, LINT.
- [ ] **Step 5: Mutate.**
  - Drop `deduplicationId`: test 2 fails.
  - Treat `queued` with `attempts = 0` as an outcome: test 4 fails at poll 1.
  - Restore after each.
- [ ] **Step 6: Commit.** `feat(email-outbox): publish first attempts to the email service; answer from the row`.

### Task 8: Every `dispatchNow` caller publishes (batch, one commit per producer file)

**Files** (at `67eb05aedd`; T0 re-counts):
- `app/api/auth/magic-link/route.ts:102`;
- `server/usecases/external-play/invite.ts:403` (`dispatchAndClassify`);
- `registration-approval.ts:285`;
- `registration-assign.ts:399`;
- `registrations.ts:1529`, `:1820`, `:1886`, `:1935`, `:5111`, `:6334` and `:6422`;
- plus waves 2–5's sites.

Tests: each file's existing producer suite (T0 lists them).

**Interfaces** (consumed from T7):
- **Fire-and-forget sites** (`deferred(() => dispatchNow([id]))`) become `deferred(() => publishDispatch([id]))`.
- **Answering sites** (`const sent = (await dispatchNow([id])).get(id) === "sent"`) become
  `const sent = (await publishDispatch([id])) && isSentStatus((await awaitEmailOutcomes([id])).get(id));`.
- **The magic link** becomes `await publishDispatch([id]);`, with no wait.
- **`dispatchAndClassify(seatRowIds, now)`** keeps its signature. It publishes `all`, awaits only when the publish
  returned true, and then runs `seatOutcome` over the statuses, as it does now. `now` stays for its callers' test
  clocks. Expiry is now judged by the service on real time, which spec §4 already intends.

- [ ] **Step 1, per file: re-point the file's tests first.**
  - Replace `vi.mock("@/server/email-outbox/transport", …)` with `vi.mock("@/server/email-outbox/publish", …)`, and
    keep the real `isSentStatus` and `awaitEmailOutcomes` through `importOriginal`.
  - A test that asserted a "sent" answer now installs `serviceDouble("sent")`. One that asserted "retrying" or
    `{sent:false}` installs `serviceDouble("retrying")`.
  - Add one assertion per site: `publishDispatch` was called with exactly `[<the row id>]` after the commit (read the
    row id from `email_outbox`). This is the seam-proving pair (AGENTS class 1): the real producer, through the real
    publisher's call.
- [ ] **Step 2, per file: run red** (the producer still calls `dispatchNow`): VERIFY → `t8-<file>`.
- [ ] **Step 3, per file: swap the call** as in Interfaces.
- [ ] **Step 4, per file: run green**, then TSC.
- [ ] **Step 5, once per batch: mutate** `registrations.ts`'s remind site to `const sent = true`. The
  `serviceDouble("retrying")` case fails. Restore.
- [ ] **Step 6, per file: commit.** `feat(<area>): publish the first attempt to the email service`.

### Task 9: The app's send core retires

**Files:**
- Delete:
  - from `attempt.ts`: `attemptClaimed`, `dispatchNow`, `claimQueuedRow` and the mark functions;
  - `transport.ts`, `classify.ts`, `recipient.ts`, `provider-events.ts`, `resend.ts` (its `checkSendable` and
    `deliver`);
  - the tick in `worker.ts`.
- Keep `resend.ts`'s `isSuppressed` if T0 finds an app reader; otherwise delete it too.
- Modify:
  - `index.ts` (its exports);
  - `app/api/cron/email-outbox/route.ts` (re-drive only);
  - `seal.ts:36` and `readiness.ts:13-20` (P4-9);
  - `__tests__/_kind-harness.ts` (`assertNothingMoreToSend` and the send leg become "row queued, body opens, publish
    requested");
  - `outbox-kind-sweep.test.ts`, `no-second-path.test.ts` (the scan's gated names are now `publishDispatch` and the
    sealing calls; "exactly one file names `api.resend.com`" becomes "no file does");
  - every remaining transport-mocking test file (T0's list, minus those T8 already changed).
- Delete the app copies of the suites T4 lifted.
- `__tests__/seal.test.ts` and `readiness.test.ts` re-point `RESEND_API_KEY` → `QSTASH_TOKEN`.

**Interfaces:**
- App tests that need a `sending` row (account deletion with a row in flight, `lockQueuedEmails`) stage it with a
  plain `update … set status = 'sending', attempts = 1, lease_until = now() + interval '2 minutes'`. They test the
  app's reaction, not the claim.
- The claim's own tests now live in the service.

- [ ] **Step 1: Re-point the tests first** (the kind sweep, the scan, the seal and readiness env var, and the cron
  route's `{ redriven, skipped, failed }` answer). Run red: VERIFY → `t9`.
- [ ] **Step 2: Delete and modify** as above.
- [ ] **Step 3: Run green.**
  - VERIFY every file under `server/email-outbox/__tests__/`, the cron route suite, the webhook route suites (still
    present until T11), and every file T0 listed as naming `dispatchNow` or the transport → `t9b`.
  - Expected: `failed: 0`. The kind sweep reports `checked === OUTBOX_KINDS.length` (51).
  - TSC. Run the cron Worker's drift test (the route now imports only `hook-redrive`).
- [ ] **Step 4: Mutate.** In `seal.ts`, key on `RESEND_API_KEY` again: the re-pointed seal test fails. Restore.
- [ ] **Step 5: Commit**, one per group:
  1. `refactor(email-outbox): the app no longer sends; cron runs only the hook re-drive`;
  2. `test(email-outbox): re-seam producer suites on publish`.

### Task 10: Smoke and e2e

**Files:** `scripts/smoke.ts` (`checkOutboxRow`, `checkSignInOutbox`, `checkQueuedOutboxRow` and the
`/api/cron/email-outbox` probe at `:1263`), and the 4 e2e assertions on `no_api_key` (T0 re-greps
`apps/web/e2e/{online-chess-desk,registration-hub,passwordless-login}.spec.ts`, `match-room-kit.ts`,
`arbiter-column-kit.ts`).

**Interfaces:**
- An R-kind row on a server with no service is `queued`, `attempts = 0`, with its body present. Smoke and e2e assert
  that instead of `dead`/`no_api_key`.
- The arbiter column's chess seat outcome is now "retrying" in CI.
- The cron probe expects `{ redriven, skipped, failed }`.

- [ ] **Step 1: Edit the assertions.** Expected values come from this plan's literals.
- [ ] **Step 2:** `npx vitest run scripts/__tests__/smoke-select.test.ts` (the registry is unchanged), the scripts
  typecheck, and `npx playwright test <the e2e files> --list; echo EXIT=$?` (they collect; they are never run
  locally).
- [ ] **Step 3: Commit.** `test(smoke,e2e): with no email service, rows wait queued`.

**PR P4-2** (T7–T10):
- Rebase onto `origin/main`.
- Paste the scoped VERIFY counts.
- Smoke runs on the PR.
- Dispatch e2e on the PR branch, with `online-chess-desk`, `registration-hub` and `passwordless-login` whole. A serial
  red is a floor.
- Hand back. **[OWNER-GO] merge** comes only at T11 Phase B.

### Task 11: Cutover runbook (stg, then prod; every step [OWNER-GO])

Each phase is reversible until the next one starts.

**Phase A: the service runs beside the app.**
1. **[OWNER-GO]** Upstash: QStash on Pay as you go (Q2). Copy the token and the current and next signing keys to the
   ledger's secret store, not to chat.
2. **[OWNER-GO]** Per env, on the database, as the owner role:
   `create role seazn_email_login login password :'pw' in role email_service;`. The password comes from a `0600` file
   through psql's `\set pw` and `\password`. On Supabase, confirm the pooler user form
   (`seazn_email_login.<project-ref>`) and `prepare` (`:6543` turns it off, `lib/db.ts:138`).
3. **[OWNER-GO]** `fly secrets import -a seazn-email-stg` from a `0600` file:
   - `DATABASE_URL` (the login role);
   - `EMAIL_OUTBOX_KEK` (the SAME value as the app's, P4-1);
   - `RESEND_API_KEY`;
   - `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`;
   - `PUBLIC_BASE_URL=https://seazn-email-stg.fly.dev`;
   - `EMAIL_FROM`, `EMAIL_REPLY_TO` (the app's values);
   - `NODE_ENV=production`.
   - `RESEND_WEBHOOK_SECRET` comes in step 6.
4. **[OWNER-GO]** Merge the service's first PR. `stg.yml` deploys, and the healthz curl is green.
5. **[OWNER-GO]** A QStash schedule: destination `https://seazn-email-stg.fly.dev/sweep`, cron `*/5 * * * *`,
   retries 0, `scheduleId: email-sweep-stg`. Watch one firing answer 200 in the service log.
   - From now the service sweep and the app's cron tick both work the queue. That is safe (rare case 9).
6. **[OWNER-GO]** Resend: add a webhook endpoint `https://seazn-email-stg.fly.dev/webhooks/resend` with stg's events,
   and set its signing secret as `RESEND_WEBHOOK_SECRET` on the service. The app's endpoint stays (rare case 8).
7. **[OWNER-GO]** On the app, set `QSTASH_TOKEN`, `EMAIL_SERVICE_URL=https://seazn-email-stg.fly.dev` and
   `EMAIL_SERVICE_ENV=stg`. They do nothing until P4-2 is deployed.

**Phase B: the app hands over.**

8. **[OWNER-GO]** Merge P4-2. stg deploys.
9. **Owner's stg walk.** The first three items are the cross-system e2e that CI cannot run:
   - a sign-in link arrives, and its row goes `sent`, then `delivered` (from the service's webhook);
   - an organiser resend answers "sent";
   - a chess round open shows the seats sent;
   - one forced dead invite (an invalid address) has its seat released within one stg tick.
10. **[OWNER-GO]** Remove `RESEND_API_KEY` from the app on stg. The app's readiness check stays quiet (P4-9).

**Phase C: the webhook leaves the app.**

11. **[OWNER-GO]** Delete the app's Resend endpoint (stg).
12. PR P4-3 (implementer):
    - delete `app/api/webhooks/resend/` and its two suites (lifted in T4);
    - remove `RESEND_*` from `.env.example` and add `QSTASH_TOKEN`, `EMAIL_SERVICE_URL` and `EMAIL_SERVICE_ENV`;
    - remove the smoke probe that POSTs the app webhook (`scripts/smoke.ts:1267`, `:22443`).
    - Commit `chore: the Resend webhook lives in the email service`. **[OWNER-GO] merge.** Then **[OWNER-GO]** unset
      `RESEND_WEBHOOK_SECRET` on the app.
13. **Prod:** repeat 2, 3, 5, 6 and 7 for prod.
    - The schedule is `* * * * *` with `scheduleId: email-sweep-prod`.
    - The webhook takes the six events per Q4.
    - `min_machines_running` per Q2.
    - Then tag the service (`prod.yml`), tag the app with P4-2 and P4-3 **[OWNER-GO]**, and repeat 10–12 on prod.

---

## Part 2: templates in the service (only if Q1 = B; after Part 1's prod cutover)

**Deploy-order rule (binding for every Part 2 PR):** the service ships a kind's template and facts version BEFORE the
app enqueues that version. A row whose `v` the service does not know ends `dead`, `facts_version_unknown` (rare case
12).

**Changed while queued (Part 2):**
- The facts are what the email says, frozen at enqueue exactly as the phase-3 per-kind tables already state.
- What changes is the locale and render moment. They are resolved at the FIRST attempt, not at enqueue. So a locale
  the recipient changes before the first attempt is followed, and after it nothing moves (P4-17).
- Each batch's per-kind line restates the phase-3 entry for that kind. It adds code or a test only where phase 3 did.

### Task 12: The facts envelope and render-on-first-attempt

**Files:**
- App: create `db/migration/deltas/V<N>__email_outbox_facts.sql`, `email-outbox/enqueue-facts.ts`, and the contract
  (its location depends on Q3: `packages/email-contract` in the monorepo, or a versioned package published from the
  service repo).
- Service: create `src/render/{registry,locale}.ts` and `test/render/*.test.ts`; modify `src/core/attempt.ts`.

**Interfaces:**
- Contract: `FACTS: { [K in OutboxKind]?: { v: number; schema: z.ZodType } }`, with
  `type FactsEnvelope = { kind: OutboxKind; v: number; facts: unknown; localePick: string | null }`.
- Migration: `alter table email_outbox alter column subject drop not null;` (P4-18).
- App: `enqueueFacts(db, m: Omit<OutboxMessage, "subject" | "html" | "text"> & { v: number; facts: unknown; localePick: string | null; dedupeKey?: string }): Promise<string | null>`.
  - It refuses before any statement with `OutboxFactsInvalidError` (code `EMAIL_OUTBOX_FACTS_INVALID`; the message
    names the kind and `v`, never a value) unless `FACTS[kind]?.v === m.v && FACTS[kind].schema.safeParse(m.facts).success`.
  - It seals `JSON.stringify(envelope)` and writes `subject = null`. It shares `insertQueued`'s refusals and the
    once-key path.
- Service `attemptClaimed`, after the gate passes:
  1. open the body;
  2. if it is a `FactsEnvelope`, `resolveLocale(row, env.localePick)`: the pick, then `users.locale` by
     `recipient_user_id` (not deleted), then `organizations.default_locale` by `org_id`, then `en` (D4's order);
  3. `render(kind, v, facts, locale): { subject, html, text }`; an unknown `v` → `markEnded(row, "dead", "facts_version_unknown")`;
  4. the fenced update `set body_sealed = <sealed rendered>, subject = $s where id = $1 and status = 'sending' and attempts = $n`;
  5. send.
  - A row that already holds `{ html, text }` (every later attempt, and every Part 1 row) skips straight to sending.

- [ ] **Step 1: Write the failing tests.**
  - Service:
    1. `a facts row is rendered once: the retry sends the stored bytes`. The first attempt answers 503, the second
       200. `render` was called once, and both transport calls carry identical `html`/`text`/`subject`.
    2. `the locale is the account's at the first attempt, not at enqueue`. Enqueue for a user with `locale = 'fr'`,
       set it to `nl`, attempt: the subject is the `nl` dictionary's value (read from the service's `nl` JSON).
    3. `an unknown facts version ends the row dead with facts_version_unknown`.
  - App:
    1. `enqueueFacts refuses facts the contract rejects, before any statement` (D1: a refusal fails the action).
    2. `enqueueFacts writes a sealed envelope whose kind and v match the contract`.
- [ ] **Step 2: Run red**, in both repos.
- [ ] **Step 3: Implement.** Service first (the deploy-order rule), then the app.
- [ ] **Step 4: Run green**, in both repos. TSC both.
- [ ] **Step 5: Mutate.**
  - Skip the stored-render update: service test 1 fails (`render` called twice).
  - Drop the `v` check in `enqueueFacts`: app test 2 fails.
  - Restore after each.
- [ ] **Step 6: Commit**, one per repo:
  - service: `feat(render): render facts on the first attempt and keep the bytes for every retry`;
  - app: `feat(email-outbox): enqueueFacts and the facts contract`.

### Tasks 13–17: Kind batches (one task per batch, one commit per kind)

| Task | Batch (phase-3 wave) | Kinds (re-pin from `OUTBOX_KINDS` at T0) | Producers |
|---|---|---|---|
| T13 | wave 1 | 7: `magic_link`, `chess_invite`, `registration_confirmation`, `payment_reminder`, `registration_promoted`, `refund_issued`, `solo_signup_assigned` | magic-link route, `invite.ts`, `registrations.ts`, `registration-assign.ts`, refund paths |
| T14 | wave 2 | 10 money kinds (wave-2 plan, "The ten kinds") | `registrations.ts`, `sponsors.ts`, `billing-events.ts`, `lib/billing.ts` |
| T15 | wave 3 | 8 account and invite kinds | per the wave-3 plan |
| T16 | wave 4 | 9 officials, suspension and group kinds | per the wave-4 plan |
| T17 | wave 5 | 17: the funnel reminder plus 16 staff alerts (15 inline English, F2) | per the wave-5 plan |

`chess_invite`'s re-render (`lockQueuedEmails`, the FU3 rule) re-enqueues facts instead of a body. It is handled in
T13, its own step, before the other six.

**Per kind, the same five steps:**
- [ ] **a. Contract:** add `FACTS.<kind> = { v: 1, schema }`. The schema's fields are exactly the builder's current
  argument object (`<name>Email(args, locale)`, the wave convention), minus anything the service resolves (recipient,
  locale).
- [ ] **b. Service:**
  - copy the builder's template from `lib/email-templates/*` and its `emails.json` keys (all four locales) into the
    service;
  - add `test/render/<kind>.test.ts › renders every locale with the dictionary's subject`, with the expected subject
    read from the service's JSON per locale, and `checked === 4`;
  - ship the service (the deploy-order rule).
- [ ] **c. App:**
  - the producer swaps `<name>Email(...)` + `enqueueEmail(Once)` for `enqueueFacts(...)` with the same args object as
    facts;
  - its producer test opens the row's envelope and asserts `facts` deep-equals the fixture's own values (not the
    builder's output), `v === 1` and `subject === null`;
  - the kind sweep's scenario for the kind asserts the envelope instead of the body.
- [ ] **d. App:** delete the builder and, once nothing reads them, its `emails.json` keys in all four locales. Run
  `pnpm i18n:gen-keys && pnpm i18n:check`.
- [ ] **e.** Scoped VERIFY in both repos, then commit:
  - app: `feat(email): <kind> enqueues facts; the service renders it`;
  - service: `feat(render): <kind> v1`.
- **Once per batch: mutate** one kind's schema to drop a required field. That kind's app producer test fails at
  `enqueueFacts` (the contract test). Restore.
- **Changed-while-queued line per kind:** copied from that kind's phase-3 table entry, plus "locale: followed until the
  first attempt (P4-17)".

### Task 18: The app stops rendering

**Files:** delete `apps/web/src/lib/email.ts` (by then builder-free), `lib/email-templates/**` and
`dictionaries/{en,es,fr,nl}/emails.json`, if T0 Step 3's grep finds no other reader (for example a UI preview). If it
finds one, the reader stays and is recorded.

- [ ] **Step 1:** `grep -arn "lib/email\b\|email-templates\|\"emails\"" apps/web/src` is empty, apart from the files
  being deleted.
- [ ] **Step 2:** Delete them, then `pnpm i18n:gen-keys && pnpm i18n:check`, TSC, and VERIFY
  `server/email-outbox/__tests__/`. The no-second-path scan's render half now asserts that no builder exists.
- [ ] **Step 3: Commit.** `chore(email): rendering lives in the email service`.

---

## Conflict scan

| Pair | Shared | Resolution |
|---|---|---|
| T1 → T2 | `no-import-cycle.test.ts` claim 4 (T1 adds it with `it.fails` on the usecase half; T2 makes it real), `attempt.ts`, `provider-events.ts` | Sequential. |
| T2 → T4 | T4 lifts the core at P4-1's merge SHA, after the hooks left | T4 after P4-1 merges. |
| T3 → T4, T11 | the role must exist before the service connects | P4-1 merged and deployed to the env first. |
| T7 → T8 → T9 | `publish.ts`, `_kind-harness.ts`, the producer suites (T8 re-seams some, T9 the rest) | Sequential. |
| T9 – T10 | none (`__tests__` vs `scripts/` and `e2e/`) | T10 may run beside T9. |
| T11 step 12 → T9 | the webhook route suites (T9 keeps them; P4-3 deletes them) | P4-3 after Phase C step 11. |
| T12 → T13…T17 | `enqueueFacts`, the contract, the service registry | Sequential. Inside a batch, kinds are sequential (shared `emails.json`, the sweep). |
| Peer branches | migration numbers; any session editing `registrations.ts`, `invite.ts` or `scripts/smoke.ts` | `git log origin/main --oneline -- <file>` at T0 and before each PR. |

**Execution order:** T0, T1, T2, T3, then PR P4-1 **[OWNER-GO]**; T4, T5, T6 (service); T7, T8, T9 ∥ T10, then
PR P4-2; T11 Phases A → B → C on stg, then prod. Part 2 only if Q1 = B: T12, T13 … T17, T18.

## Next waves and routed findings (not built here)

- **Q3 = monorepo** collapses T6 into `ci.yml`, `stg.yml` and `prod.yml` jobs, and the contract into a workspace
  package.
- `latestEmailStatus` readers could show "delivered" now that prod receives `email.delivered` (Q4). That is a product
  follow-up, not phase 4 (D3: no new status UI).
- The parked items in `email-outbox-HANDOFF.md` are unaffected, except "Public resend shows 'couldn't resend' when the
  mail has not gone out". Its local cause changes from "no Resend key" to "no service". That is the same honest answer.

## Self-review

1. **Note coverage.**
   - Separate repo and Fly app: T4, T6, Q3.
   - Shared DB through a restricted role: T3, T4 Step 3.
   - QStash carries only the id, with dedup id = outbox id: T7.
   - `/dispatch {id}` signed and retried: T5, T7.
   - The per-minute schedule to `/sweep`: T5, T11.
   - Lost publishes, retries and expiry: T5 test 6 and the lifted `runOutboxTick`.
   - The Resend webhook moves: T5, T11.
   - Secrets: T11, with P4-1 on the KEK.
   - The rejected options stay rejected: nothing here uses Redis, LISTEN/NOTIFY or a second store.
   - "Was it queued?" is answered by the row: T7 `awaitEmailOutcomes`.
   - Option B: Q1 and T12–T18.
   - The `checkSendable`/`deliver` split ships first: T1.
2. **Step scan.**
   - Every test step names its test and its literal expectations.
   - Every code step names its file, signature and values.
   - The OWNER-GO steps name the exact console or CLI action.
3. **Type consistency.** These names are spelled identically everywhere: `publishDispatch(ids): Promise<boolean>`,
   `awaitEmailOutcomes(ids, opts?)`, `isSentStatus(s)`, `runHookRedrive(opts?)`, `serviceDouble(outcome)`,
   `enqueueFacts(db, m)`, `FactsEnvelope` and `AWAIT_OUTCOME_BUDGET_MS`.
4. **Review Focus.** T5 test 3; T5 test 6; T4 Step 3 and the T3 tests; T7 test 5; T2 test 2.
5. **Proportion.** No function bodies, only signatures, one-line SQL and literals. Part 2's 51 kinds share one step
   template and are not written out 51 times.
