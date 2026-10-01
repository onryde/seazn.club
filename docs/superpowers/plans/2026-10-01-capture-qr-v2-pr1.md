# Capture QR v2 — PR-1 (capture-facing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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
- **One V430 migration.** `relay/secret-columns.ts` stays the only SQL over sealed columns, `tok_enc` included.
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
- **Dependency (W22): this plan executes only after the Cloudflare Cron Triggers plan
  (`docs/superpowers/plans/2026-09-28-cloudflare-cron-triggers.md`, branch `docs/cloudflare-cron-triggers` at
  327eee9e1) has merged.** T7b adds a job to its `apps/cron-worker`, and its V429 sits below this plan's V430.
- Cut from `docs/capture-qr-v2-spec` after rebasing that docs-only branch onto `origin/main` **after the cron merge**,
  so the spec and this plan travel with the build.
- `WT` below means that absolute path. Every command starts with `cd $WT…` in the **same** shell call (AGENTS.md:
  shell cwd resets between calls).
- The worktree has no `node_modules` until `pnpm install` runs in it. Stand it up with the `seazn-local-env` skill.

## Execution batches

Ten batches over eighteen tasks. Each batch gets **one implementer and one review**. Inside a batch the implementer still commits **once
per task**, in task order, so each commit stays bisectable and each task's own gate and mutations still run.

| Batch | Tasks | Boundary gate (the orchestrator re-runs it, scoped) |
|---|---|---|
| B1 | T1 | T1 Step 6. **Committable alone, first: capture vendors it.** |
| B2 | T2 | The mockup files exist and differ (Step 3); then **STOP for the owner's sign-off**. B3 does not wait for it. |
| B3 | T3 + T4a + T4b | T3, T4a and T4b scope commands together |
| B4 | T5 + T6 + T6b | T5, T6 and T6b scope commands, plus `stream-contract.test.ts` and `routes.test.ts` |
| B5 | T7 + T7b + T8a | T7, T7b (both the web and the cron-worker runs) and T8a scope commands |
| B6 | T8b + T8c | T8b and T8c scope commands, plus `key-scopes.test.ts` and `openapi-coverage.test.ts` |
| B7 | T9 + T10 | T9's scope, then T10's model run **three times** (each seed logged) and the mutation table recorded |
| B8 | T11 | **Gated on B2's sign-off.** T11 scope, then `mobile.spec.ts` whole, then screenshots |
| B9 | T12 | the two walkthroughs whole, the re-run list, then `SMOKE_ONLY=captureV2 pnpm test:smoke` |
| B10 | T13 | The lane close. It STOPs before any push or PR. |

A batch's review runs over the batch's commits (`git diff <batch base>..HEAD`), with this plan's task text as the
brief. Fixes from that review land in the owning task's files as a follow-up commit in the same batch, and the batch
gate is re-run before the next batch starts.

## Global Constraints

**Contract (spec §4, §6.3, §6.14):**

- The phone's words are kebab-case and the server's are snake_case. `mode` is `"automatic" | "operator"`.
- `x?` means omitted, never `null`. `x | null` means always present. `scheduledStart` is `?` on the waiting and session
  shapes and `| null` on the beat answer.
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
  ticks too.
- **W23:** `FREE_RESTARTS_PER_WINDOW` = 3. Only restarts that reached video count, never the paid first live, never
  a rejoin or takeover of the same sid. The 4th costs 1 credit at live and never hard-blocks. One authority,
  `restartAllowance`, serves admission, the consume and the panel.
- **W24:** "Reconnecting…" replaces "No signal" while live without video; after `RECONNECT_QUIET_SECONDS` = 30 a
  server-computed countdown runs to W19's end (live) or the warming deadline (warming).
- **W25:** the "Match {n}" fallback on the wire is in the competition's locale, which is
  `organizations.default_locale`.

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
  reads as a pass. `$OUT` is `/tmp/cq1-<task>.json`.
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
4. **A phone clock far off UTC** (`at` hours ahead or behind).
   - Expect: every server clock uses the server's `now`. `at` is stored raw and never used for silence, history
     throttling or W19.
   - Owner: T8b, "`at` five hours ahead still writes a minute row on the server's clock".
5. **A fixture whose sides are unknown (TBD) when the code is minted.**
   - Expect: `label` is "{side A} v {side B}" once both are known, and before that the `breadcrumb.match` text in the
     organisation's `default_locale` with the match number (W25): "Match 7", "Partido 7", and so on.
   - Owner: T8a `labelFor`, with a TBD-sided case in each of the four locales.

## Premises re-verified (spec → corrected fact)

These were re-pinned against `origin/main` 58e8103e3 (PR #908 merged) on 2026-10-01. Each item says what the plan
does about it.

1. **Migration numbers.** `main` tops out at `V428__stream_poll_claim.sql`. The Cloudflare Cron plan executes first
   and takes V429 (its text says V419, which main already holds). **V430 is PR-1's and V431 is PR-2's.** T3 and T13
   re-check.
2. **`enc-boundary.test.ts` requires every `*_enc` column to have an owner.** It derives `ENC_COLUMNS` from every
   delta. The spec's first form ("crypto.ts remains the only module") was corrected on 2026-10-01: T3 adds `tok_enc`
   to `STREAM_COLUMNS`, owned by `server/relay/secret-columns.ts`. That edit is the test's own designed extension
   point, not a weakening.
3. **`_stream-migration.ts` reads only `V410__stream_sessions.sql`.** `stream-contract.test.ts` checks enums against
   V410's CHECK lists. V430 redefines `end_reason` and `fixture_stream_events.source`, so T3 teaches the helper to
   read V410 plus every later delta, with the **last** definition of a named check winning. Otherwise T6's widened
   `StreamEndReason` reds against V410's two values.
4. **`rateLimit()` throws `HttpError(429)` with no `Retry-After`** (`lib/rate-limit.ts:66`). T8c gives `HttpError` an
   optional `headers` field, and the limiter fills `Retry-After` with the window's remaining seconds.
5. **The fake ingest issues `srt://fake.ingest.invalid:778`** (`relay/fakes.ts:125`). Host checks therefore run only
   when `STREAM_INGEST_HOST` is set. The fake keeps passing through, and the contract pattern-checks no host.
6. **The v1 contract is read by four tests:**
   - `capture-qr.v1.test.ts`;
   - `stream-sessions.test.ts:449-470` (the lane-D D5 seam case);
   - `fixture-stream-panel.test.tsx:583-590`;
   - `stream-session-view.test.ts:421`.

   T1 deletes the v1 files, so T1 removes exactly those cases. The v1 builder stays live until T11 removes it. Nobody
   consumes v1 (W4), so the window is accepted and recorded in T1's commit.
7. **Fixture statuses** are `scheduled, in_play, decided, finalized, abandoned, forfeited, cancelled`
   (`v2-engine/tables/V214__fixtures.sql:21`). The finished set in §3 matches the CHECK.
8. **The latest connected sample** (A14, W19) is `fixture_stream_samples` with `source = 'poll'` and `ingest_state =
   'connected'`. It is written by the ingest read that `claimIngestPoll` guards, and T7 makes the tick write it.
9. **The phone routes and the API-key door.** `key-scopes.test.ts` and `openapi-coverage.test.ts` sweep the route
   files. The phone routes read their own Bearer (the `relay/bearer.ts` idiom) and must never accept an org API key.
   T8c lists them in `NEVER_KEY_ROUTES` and in `ROUTES` under a `capture` tag.
10. **Spec §9's "the `stream-contract.test.ts` pin of stream operations moves from 7 to 11" is right in count but
    hides the mechanism.** The pin is the sorted list at `stream-contract.test.ts:224`, filtered by a regex that
    matches only `stream-sessions|stream-targets`. Without widening the regex, the new routes never enter the pin and
    it stays at seven, which is a vacuous pass. T6 widens it; T9 reaches eleven; T8c pins the three `capture` routes
    in a sibling case.
11. **The relay sweep is daily** (`app/api/cron/relay-sweep/route.ts`, schedule in `seazn.club.workflow`). W22 adds
    the 5-minute `stream-tick` job (T7b); the sweep stays as a backstop and keeps the beat-history purge.
12. **The cron Worker's conventions are not the ones in the brief.** The brief said "POSTs with HMAC to
    `/api/internal/jobs/*`". The approved cron plan (327eee9e1) instead:
    - POSTs with a shared `x-cron-secret` header to unchanged `/api/cron/*` routes (`relay-sweep` is the model: 503
      when `CRON_SECRET` is unset, before 401 on a mismatch);
    - declares jobs in one table, `apps/cron-worker/src/schedule.ts` (`JOBS`, `Due`, `dueJobs(scheduledTime)`);
    - has exactly one trigger per env, `17 * * * *`, pinned by `test/drift.test.ts`, which also requires every
      `/api/cron/*` route to have exactly one `JOBS` row.

    T7b follows the plan as written: `POST /api/cron/stream-tick` with `x-cron-secret`, a `JOBS` row, and a second
    trigger, `*/5 * * * *`. A 5-minute job cannot ride an hourly trigger. **Also flagged:** `relay-sweep` (merged in
    #908 after the cron plan was written) is a `/api/cron/*` route with no `JOBS` row, so the cron plan's drift guard
    reds on execution unless that plan adds it. That is the cron programme's to fix; T7b re-checks it at Step 1.
13. **No competition has a locale.** The tree has `organizations.default_locale` (V281) and `users.locale`, nothing on
    competitions. W25's "competition's locale" is therefore the organisation's default, which the public league pages
    already read. T8a uses it.
14. **`reuseWindowOpen` has three callers** that must agree (`stream-credits.ts:125`): admission's balance waiver
    (`stream-sessions.ts:1183`), `consumeForSession` (`stream-credits.ts:169`) and the panel's `restartFree`
    (`stream-sessions.ts:1577`). T6b replaces all three with `restartAllowance`, and its tests prove they agree.

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
| `apps/web/src/server/relay/ingest-cred.ts` | the §6.4 rewrite and host rules | T8a |
| `apps/web/src/server/usecases/capture-phone.ts` | `getCode`, `postBeat`, `postStart` | T8a, T8b, T8c |
| `apps/web/src/server/api-v1/capture-http.ts` | bare bodies, refusals, no-store, Retry-After | T8a |
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
| `apps/web/src/server/relay/__tests__/enc-boundary.test.ts`, `_stream-migration.ts`, `migration-shape.test.ts` | `tok_enc` owner; the delta fold; V430 shape | T3 |
| `apps/web/src/server/relay/config.ts` | the §6 constants, `STREAM_SRT_ENABLED`, `tunable()` | T4a, T8a |
| `apps/web/src/server/relay/domain/session.ts` | `startCause`, `stop` reasons, `warmingAt`, `phone_not_paired` | T6 |
| `apps/web/src/server/usecases/stream-sessions.ts` | `startBroadcast`, `tickSession`, v1 QR removed | T6, T7, T11 |
| `apps/web/src/server/api-v1/schemas.ts` | `StreamEndReason` widens; `StreamSessionCurrent` loses `qr`, gains `startCause` | T6, T11 |
| `apps/web/src/lib/errors.ts`, `lib/http.ts`, `server/api-v1/http.ts`, `lib/rate-limit.ts` | `HttpError.headers`, `Retry-After`, the capture presets | T8c |
| `apps/web/src/server/logger.ts` | pino `redact` paths | T8c |
| `apps/web/src/server/api-v1/key-scopes.ts`, `openapi.ts` | new routes | T5, T8c, T9 |
| `apps/web/src/app/api/cron/relay-sweep/route.ts` (and the sweep use-case it calls) | ticks open sessions and purges beat history | T7 |
| `apps/web/src/components/v2/fixture-stream-panel.tsx`, `lib/stream-session-view.ts` | Ready states, pairing, v1 QR gone | T11 |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` + generated `lib/i18n-keys.ts` | `stream.code.*`, `stream.phone.*`, `stream.end.*` | T11 |
| `apps/web/e2e/walkthrough/stream-relay.spec.ts`, `e2e/mobile.spec.ts`, `lib/__tests__/e2e-ci-wiring.test.ts` | v2 rewrite; registration | T11, T12 |
| `scripts/smoke.ts` | `captureV2Suite` in `SELECTABLE_SUITES` | T12 |
| `apps/web/src/server/usecases/stream-credits.ts`, `server/relay/domain/credits.ts` | `restartAllowance`, `restartIsFree` | T6b |
| `apps/cron-worker/src/schedule.ts`, `wrangler.json`, `src/index.ts`, `test/schedule.test.ts`, `test/drift.test.ts` | the `stream-tick` row and the `*/5` trigger | T7b |

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
- Modify, removing only the v1-contract cases:
  - `server/usecases/__tests__/stream-sessions.test.ts:449-470`;
  - `components/v2/__tests__/fixture-stream-panel.test.tsx:583-590`, together with every case that reads its
    `fixture` constant;
  - `lib/__tests__/stream-session-view.test.ts:421` and its case.
- Test: `apps/web/src/server/api-v1/__tests__/capture-contract.test.ts`

**Interfaces:**

- Produces, from `server/api-v1/capture-schemas.ts`, every name below, also re-exported from `schemas.ts`:
  - `CAPTURE_CODE_RE = /^[0-9a-hjkmnp-tv-z]{12}$/`
  - `CaptureEndReason`, `CaptureStartedBy`, `CaptureCause`, `CapturePhoneState`, `CaptureNotReady`,
    `CaptureStartFailed`
  - `CaptureWaiting`, `CaptureSession`, `CaptureDescriptor` (a discriminated union on `state`)
  - `CaptureBeat`, `CaptureBeatAnswer`
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

export const CaptureSession = z.strictObject({
  state: z.enum(["warming", "live", "ending", "completed", "failed"]),
  endReason: CaptureEndReason.optional(),
  sid: z.uuid(),
  cred: CaptureCred.optional(),
  preferred: z.enum(["srt", "rtmps"]),
  playbackUrl: Url,
  holdWindowSeconds: z.strictObject({ srt: z.number().int().min(1).max(999), rtmps: z.number().int().min(1).max(999) }),
  maxDurationMinutes: z.number().int().min(1),
  warmingDeadline: EpochS,
  scoreUpdates: z.enum(["realtime", "polled"]),
  ...WaitingFields,
});

export const CaptureDescriptor = z.discriminatedUnion("state", [
  CaptureWaiting,
  CaptureSession.extend({ state: z.literal("warming") }),
  CaptureSession.extend({ state: z.literal("live") }),
  CaptureSession.extend({ state: z.literal("ending") }),
  CaptureSession.extend({ state: z.literal("completed") }),
  CaptureSession.extend({ state: z.literal("failed") }),
]);

export const CaptureBeat = z.strictObject({
  code: Code,
  slot: z.number().int().min(0),
  phone: z.string().min(16).max(64),
  claim: z.enum(["new", "resume"]).nullable(),
  device: z.strictObject({ model: z.string().min(1).max(80) }).nullable(),
  sid: z.uuid().nullable(),
  at: z.iso.datetime(),
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

export const CaptureBeatAnswer = z.strictObject({
  state: z.enum(["waiting", "go-live", "live", "over", "replaced", "taken"]),
  sid: z.uuid().optional(),
  startedBy: CaptureStartedBy.optional(),
  endReason: CaptureEndReason.optional(),
  label: z.string().min(1).max(200),
  scheduledStart: EpochS.nullable(),
  autoAllowed: z.boolean(),
  destinationName: z.string().min(1).max(80).nullable(),
  overlayUrl: Url.nullable(),
  pollSeconds: PollSeconds,
});

export const CaptureStartBody = z.strictObject({ phone: z.string().min(16).max(64) });
export const CaptureStartOk = z.strictObject({ sid: z.uuid() });

export const CaptureRefusalCode = z.enum([
  "code_ended", "not_a_stream_code", "already_live", "replaced", "no_destination", "no_credit", "not_entitled",
  "unavailable", "invalid", "rate_limited",
]);
/** Every refusal: {code, message, ...extras}. Only already_live carries extras. */
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
      Assert six branches were compared, which is the anti-vacuity count.
  - **Fixtures.** Each `valid*.json` parses with its twin. Each `invalid-*` and `tampered.json` is refused. Assert
    the count per directory, and that it is never 0.
  - **Optional versus null.** For every `x?` field (`scheduledStart` on waiting and session; `sid`, `startedBy` and
    `endReason` on the beat answer; `endReason` and `cred` on the session), its fixture `valid-null-<field>.json`
    (the field set to `null`) is **refused**.
  - **SRT nullable (A18).** `valid-session-srt-null.json` (with `preferred: "rtmps"`) parses.
  - **W21 hosts.** `valid-session.json` carries `srt.url: "srt://live.cloudflare.com:778"` and
    `rtmps.url: "rtmps://live.stg.seazn.club:443/live/"`. The descriptor file's `cred.srt.url.description` names
    both `live.cloudflare.com` and `live.*`; the test asserts both substrings.
  - **QR v2.** `capture-qr.v2/valid.json` parses. `tampered.json` (a fifth key, `cred`) and `wrong-version.json`
    (`v: 1`) are refused with their reasons. `captureQrV2Text` of the valid payload has exactly 4 keys.

  Run it:
  `cd $WT/apps/web && rm -f /tmp/cq1-t1.json && pnpm vitest run src/server/api-v1/__tests__/capture-contract.test.ts --reporter=json --outputFile=/tmp/cq1-t1.json; echo EXIT=$?`.
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
  - Boundaries: `slot` 0, `holdWindowSeconds` 999, `pollSeconds` 5 and 300.
  - The `valid-null-<field>.json` set from Step 2.
  - Use a real-shaped sid, a 12-character code and a 22-character tok.

- [ ] **Step 5: Remove v1.**
  - Delete `capture-qr.v1.json`, its fixture directory and `capture-qr.v1.test.ts`.
  - Remove the three v1-contract cases named in Files. Each removed case's name goes in the commit body.
  - Update the header comment of `lib/capture-qr.ts`: v1 stays until T11 removes it, and its contract is gone (W4).

- [ ] **Step 6: Run T1's scope and confirm green.**

```bash
cd $WT/apps/web && rm -f /tmp/cq1-t1.json && pnpm vitest run src/server/api-v1/__tests__/capture-contract.test.ts src/lib/__tests__/capture-qr.test.ts src/server/usecases/__tests__/stream-sessions.test.ts src/components/v2/__tests__/fixture-stream-panel.test.tsx src/lib/__tests__/stream-session-view.test.ts --reporter=json --outputFile=/tmp/cq1-t1.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t1.json
```

  Expected: `f: 0`, and five files. Then `rtk proxy pnpm typecheck` exits 0, and
  `grep -rn -a "capture-qr.v1" $WT/apps/web/src $WT/docs/contracts` finds nothing outside comments that say "removed".

- [ ] **Step 7: Mutate.** Revert each mutation after it goes red.
  - Make `scheduledStart` `.nullish()` in the twin. Red: the parity case, and the `valid-null-scheduledStart` refusal.
  - Delete `failed` from `CaptureEndReason`. Red: parity, and the end-reason fixture.
  - Drop `.optional()` from `cred`. Red: the `valid-session-no-cred` fixture.

- [ ] **Step 8: Commit.** Use `git add` for the four contracts, the four fixture directories, the twins, the
  generator, `capture-qr.ts`, `schemas.ts`, the new test, the deleted v1 files and the three edited tests. Message:
  `feat(capture): publish capture QR v2 contracts; remove v1 (PR-1 T1)`. The body lists the mutations and the three
  removed v1 cases. **This commit is handed to capture to vendor before B3 starts.**

Owes: unit (parity, fixtures) and regression (v1 gone; QR has 4 keys).

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

- [ ] **Step 4: Commit** with `docs(capture): PR-1 Ready-state mockups, options A and B (T2)`. Then **STOP**. Send
  the owner both options at all three widths. T11 does not start until the owner names one. Record the choice and
  its date in spec §6.12 in the same branch.

Owes: nothing executable. This is the house "≥2 UI options" gate.

---

## Wave S — server

### Task 3: V430 — the schema, its trigger, and the boundary tests

**Files:**

- Create: `db/migration/deltas/V430__capture_stream_codes.sql`
- Modify:
  - `apps/web/src/server/relay/__tests__/_stream-migration.ts` (the delta fold);
  - `migration-shape.test.ts` (the V430 cases);
  - `enc-boundary.test.ts` (the `tok_enc` owner);
  - `rls-static.test.ts`, only if its table list is derived and needs the new tables admitted.
- Test: `apps/web/src/server/usecases/__tests__/fixture-finished-at.test.ts` (new, DB-backed)

**Interfaces:**

- Produces these tables and columns, exactly as spec §8.1:
  - `fixtures.finished_at` and the trigger `fixtures_track_finished`;
  - `fixture_stream_codes`, `fixture_stream_settings`, `fixture_stream_pairings` and `fixture_stream_phone_beats`;
  - on `fixture_stream_sessions`: `start_cause`, `code_id`, `pairing_id`, `phone_beat`, `phone_beat_at` and
    `warming_at`; `qr_issued_first_at` is dropped, and `credentials_revealed_first_at` and `credentials_reveal_count`
    become `credentials_served_first_at` and `credentials_served_count`.
- Produces from `_stream-migration.ts`: `STREAM_DELTAS: string` (V410 and every later delta matching
  `stream|capture`, in version order), and `lastCheckList(table, column): string[]` (the **last** CHECK definition
  wins).

- [ ] **Step 1: Write the migration** from spec §8.1 verbatim, plus:
  - **RLS.** Each new table gets the `trg_set_org` trigger and RLS by the V410 pattern: `alter table … enable row
    level security; alter table … force row level security;`, with the tenant policy copied from V410's
    `fixture_stream_sessions`. Open V410 and copy its exact policy text; never write one from memory.
  - **The named end-reason check.**
    `alter table fixture_stream_sessions drop constraint <V410's name>, add constraint
    fixture_stream_sessions_end_reason_check check (end_reason in
    ('stopped','operator_stopped','auto_stopped','phone_lost','max_duration'));`
    Find V410's constraint name with `\d fixture_stream_sessions` on the fresh DB, and pin it in a comment.
  - **The events source.** Drop and recreate the `fixture_stream_events.source` check with `'phone'` added. The rest
    of the V410 list is copied exactly.
  - **The finished-at backfill.** The `update fixtures set finished_at = now() …` line must run **after** the
    trigger, or the trigger would stamp it again.

- [ ] **Step 2: Write the failing tests.**
  - `migration-shape.test.ts` gains a V430 block:
    - the four tables exist;
    - `fixture_stream_codes_one_active` and `fixture_stream_pairings_one_current` are partial unique indexes;
    - `tok_enc` is nullable, with the check `ended_at is null or tok_enc is null`;
    - the end-reason check admits exactly five values, derived from the parsed delta and compared with T6's
      `StreamEndReason.options` later;
    - `qr_issued_first_at` is absent and the two renamed columns are present.
  - `enc-boundary.test.ts`:
    - add `"tok_enc"` to `STREAM_COLUMNS`. The first case ("every declared `*_enc` column is owned") stays exactly as
      written and now passes with the new column;
    - add a case: "outside `server/relay/`, no file names `tok_enc`".
  - `fixture-finished-at.test.ts` (DB-backed):
    - for every pair in (the §3 finished set ∪ {scheduled, in_play})², an update from A to B leaves `finished_at`
      correct;
    - entering the set stamps it, staying inside keeps the first stamp, and leaving clears it;
    - the pairs come from the V214 CHECK list, parsed from the file. Assert `count === 49`;
    - **another sport (rule 6):** `forEachSportAsync` from `@seazn/engine/testkit` drives each sport's own finishing
      events through `appendEvent` on a fresh fixture, and asserts `finished_at` is set. Assert the sport count is
      the testkit's own `builtinModules.length`.

- [ ] **Step 3: Run** `pnpm db:apply` on your fresh DB, then the scope below, and confirm the new cases fail before
  Step 1's file exists and pass after it.

```bash
cd $WT/apps/web && rm -f /tmp/cq1-t3.json && pnpm vitest run src/server/relay/__tests__/migration-shape.test.ts src/server/relay/__tests__/enc-boundary.test.ts src/server/relay/__tests__/rls-static.test.ts src/server/relay/__tests__/port-boundary.test.ts src/server/usecases/__tests__/fixture-finished-at.test.ts src/server/api-v1/__tests__/stream-contract.test.ts --reporter=json --outputFile=/tmp/cq1-t3.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t3.json
```

- [ ] **Step 4: Mutate.**
  - The trigger without the `old.status not in (…)` guard. Red: "staying inside the set keeps the first stamp".
  - The backfill before the trigger. Red: a backfilled row's stamp moves on its next in-set update.
  - Drop `"tok_enc"` from `STREAM_COLUMNS`. Red: the ownership case.

- [ ] **Step 5: Commit** with `feat(capture): V430 stream codes, pairings, beat history, finished_at (T3)`, listing
  the mutations in the body.

Owes: unit (shape), use-case (trigger, every sport) and regression (the end-reason check admits five).

### Task 4a: Pure domain — code, pairing, slot, cadence

**Files:**

- Create: `apps/web/src/server/relay/domain/stream-code.ts`, `pairing.ts`, `slot.ts` and `poll-seconds.ts`
- Modify: `apps/web/src/server/relay/config.ts` (the constants, and `tunable`)
- Test: `apps/web/src/server/relay/domain/__tests__/{stream-code,pairing,slot,poll-seconds}.test.ts`

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
cd $WT/apps/web && rm -f /tmp/cq1-t4a.json && pnpm vitest run src/server/relay/domain/__tests__/stream-code.test.ts src/server/relay/domain/__tests__/pairing.test.ts src/server/relay/domain/__tests__/slot.test.ts src/server/relay/domain/__tests__/poll-seconds.test.ts src/server/relay/__tests__/config.test.ts --reporter=json --outputFile=/tmp/cq1-t4a.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t4a.json
```

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

- [ ] **Step 4: Run Step 2's command.** Expected: green, with five files.

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
- Test: `apps/web/src/server/relay/domain/__tests__/{beat-answer,end-reason,phone-lost}.test.ts`

**Interfaces:**

- Consumes `SlotState` and `decideClaim` (T4a), and `SessionState` and `FailReason` (`domain/session.ts`).
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
  - `wireEndReason(row: { endReason: DbEndReason | null; failReason: FailReason | null }): WireEndReason | null`
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
cd $WT/apps/web && rm -f /tmp/cq1-t4b.json && pnpm vitest run src/server/relay/domain/__tests__/beat-answer.test.ts src/server/relay/domain/__tests__/end-reason.test.ts src/server/relay/domain/__tests__/phone-lost.test.ts --reporter=json --outputFile=/tmp/cq1-t4b.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t4b.json
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
- Test:
  - `apps/web/src/server/usecases/__tests__/stream-codes.test.ts` (DB-backed);
  - `app/api/v1/fixtures/[id]/stream-code/__tests__/routes.test.ts`.

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
    - An envelope whose `sha256(open(tok_enc)) ≠ tok_hash`, forced by an UPDATE in the test, reissues and logs.
    - A finished fixture → `422 fixture_finished` (C4). An ACTIVE·FINISHING code inside the grace is re-shown.
  - **Reissue.** The old row is ENDED(reissued) with `tok_enc` null and the new code differs. Concurrency: two ensures
    at once under the advisory lock leave exactly one ACTIVE code (the `registration-concurrency.test.ts` gated-tx
    pattern).
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
cd $WT/apps/web && rm -f /tmp/cq1-t5.json && pnpm vitest run src/server/usecases/__tests__/stream-codes.test.ts "src/app/api/v1/fixtures/[id]/stream-code/__tests__/routes.test.ts" src/server/relay/__tests__/secret-columns.test.ts src/server/relay/__tests__/enc-boundary.test.ts src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-coverage.test.ts --reporter=json --outputFile=/tmp/cq1-t5.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t5.json
```

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
  - `apps/web/src/server/relay/domain/session.ts` (`AdmitInput.phonePresent`, `AdmitRefusal` gains
    `phone_not_paired`, `Command` `stop` gains `reason`, `Session.endReason` widens, `startCause`, `warmingAt`);
  - `apps/web/src/server/usecases/stream-sessions.ts` (`createSession` → `startBroadcast`, plus a thin organiser
    wrapper);
  - `apps/web/src/server/api-v1/schemas.ts` (`StreamEndReason` widens to the five DB reasons; `StreamSessionCurrent`
    gains `startCause`);
  - `apps/web/src/app/api/v1/fixtures/[id]/stream-sessions/route.ts` (saves the pre-pick on success).
- Test:
  - `server/relay/domain/__tests__/session.test.ts`;
  - `server/usecases/__tests__/stream-sessions.test.ts`;
  - `app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts`;
  - `server/api-v1/__tests__/stream-contract.test.ts`.

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
```

- `stop` command: `{ type: "stop"; reason: "stopped" | "operator_stopped" | "auto_stopped" | "phone_lost" }`. `ending ×
  stop` keeps the first reason.
- Admission order (§6.7.1): plan gates → `active_session` → `phone_not_paired` → `no_credits` → `target_not_found` →
  `storage_exhausted`.

- [ ] **Step 1: Write the failing tests.**
  - **`session.test.ts`.**
    - `stop` with each reason sets `endReason` to it.
    - A second `stop` in `ending` keeps the first reason.
    - `admit` refuses `phone_not_paired` after `active_session` and before `no_credits`. The ordering differential:
      with no phone **and** no credits, the refusal is `phone_not_paired`.
    - The warming deadline anchors on `warmingAt`: provisioning lasted 179 s, and the session still gets
      `WARMING_TIMEOUT_MINUTES` from warming entry.
  - **`stream-sessions.test.ts`** (DB-backed).
    - The organiser start with no present phone → `409 phone_not_paired`.
    - With a present phone it creates the session with `start_cause 'organiser'` and `pairing_id` set.
    - **Diff test (house rule "new write path"):** spy on `admit`, then call the organiser wrapper and
      `startBroadcast(…'operator'…)` on identical fixtures. Assert the two `AdmitInput` objects are deep-equal except
      `phonePresent`, which is the documented difference. Assert the same provider calls in the same order (a
      `FakeRecorder`).
    - `created_by` is the code's `issued_by` for `operator`.
    - The events row has `source 'phone'` and the pairing id.
  - **`stream-contract.test.ts`.** `StreamEndReason ↔ end_reason` now reads `lastCheckList` (T3) and passes with five.
    The relay-route pin ("ROUTES declares exactly the SEVEN relay operations", `stream-contract.test.ts:224`)
    filters on `STREAM_ROUTE = /\/(stream-sessions|stream-targets)(\/|$)/`, so T5's routes are invisible to it.
    Widen it to `/\/(stream-sessions|stream-targets|stream-code|stream-phone|stream-settings)(\/|$)/` and add T5's
    three entries (`POST /fixtures/:id/stream-code`, `POST /fixtures/:id/stream-code/reissue` and
    `PUT /fixtures/:id/stream-settings`). That makes ten, and T9's `GET /fixtures/:id/stream-phone` makes eleven,
    which is spec §9's "7 to 11". Rename the case title to match the count.
  - **`routes.test.ts`.** A Go live with `targetId` saves `fixture_stream_settings.target_id`.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f /tmp/cq1-t6.json && pnpm vitest run src/server/relay/domain/__tests__/session.test.ts src/server/usecases/__tests__/stream-sessions.test.ts "src/app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts" src/server/api-v1/__tests__/stream-contract.test.ts --reporter=json --outputFile=/tmp/cq1-t6.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t6.json
```

- [ ] **Step 3: Implement.**
  - Move the body of `createSession` (`stream-sessions.ts:1107` to the end of its admission and provisioning) into
    `startBroadcast` **unchanged**, except that it takes the actor and the new opts.
  - `createSession` becomes:
    1. resolve the auth;
    2. read slot 0's current pairing for the fixture's ACTIVE code and compute `isPresent` (T4a);
    3. call `startBroadcast` with `startCause: "organiser"`;
    4. save the pre-pick on success.
  - `stopSession` passes `reason: "stopped"`.
  - Set `warming_at` where the session enters `warming`. The anchor change is in `domain/session.ts`'s warming
    deadline.

- [ ] **Step 4: Run Step 2's command.** Expected: green.

- [ ] **Step 5: Mutate.**
  - Remove the `phone_not_paired` gate. Red: the organiser Go live with no phone.
  - Put `phone_not_paired` after `no_credits`. Red: the ordering differential.
  - Let `ending × stop` take the last reason. Red: "a second stop keeps the first reason".
  - Anchor warming on `createdAt`. Red: the 179 s case.

- [ ] **Step 6: Commit** with `feat(stream): one start path with startCause, phone_not_paired, stop reasons (T6)`,
  listing the mutations in the body.

Owes: unit, use-case and regression (the warming anchor, and the end-reason check admits five).

### Task 6b: Free restarts — three per reuse window (W23)

**Files:**

- Modify:
  - `apps/web/src/server/relay/domain/credits.ts` (`restartIsFree`);
  - `apps/web/src/server/relay/config.ts` (`FREE_RESTARTS_PER_WINDOW = 3`);
  - `apps/web/src/server/usecases/stream-credits.ts` (`restartAllowance`; `consumeForSession` uses it);
  - `apps/web/src/server/usecases/stream-sessions.ts` (admission at :1183 and the read at :1577 use it);
  - `apps/web/src/server/api-v1/schemas.ts` (`StreamSessionCurrent.restartFree` becomes `restart`).
- Test:
  - `server/usecases/__tests__/restart-allowance.test.ts` (new, DB-backed);
  - `server/relay/domain/__tests__/credits.test.ts`;
  - `server/usecases/__tests__/stream-credits.test.ts` and `stream-sessions.test.ts`.

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

- `StreamSessionCurrent.restart: RestartAllowance | null` (null when no window is open) replaces `restartFree`.
  Re-pin every reader of `restartFree` with `grep -rn -a restartFree $WT/apps/web/src` and move them all.

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
    - **Agreement:** at every step of the boundary sequence, admission's waiver, `consumeForSession`'s decision and
      `current.restart.free` are equal. Assert the count of compared steps is 5.
    - **The window closes:** 24 h after the anchor, `restart` is null and a Go live pays, as today.
  - **Sequence (rule 10):** a fast-check property over `{goLive, ingest, stop}` sequences of length ≤ 12 on one
    fixture. The expected number of consume rows is computed by a model that knows only the W23 rule text: the first
    live pays, every 4th counted restart after an anchor pays, and sessions without video never count. It is never
    computed from `restartAllowance`. Count the runs that reached a 4th restart and assert > 0.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f /tmp/cq1-t6b.json && pnpm vitest run src/server/usecases/__tests__/restart-allowance.test.ts src/server/relay/domain/__tests__/credits.test.ts src/server/usecases/__tests__/stream-credits.test.ts src/server/usecases/__tests__/stream-sessions.test.ts --reporter=json --outputFile=/tmp/cq1-t6b.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t6b.json
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

- [ ] **Step 6: Commit** with `feat(stream): three free restarts per reuse window, one authority (T6b)`, listing the
  mutations in the body.

Owes: unit, use-case, money and the sequence test.

### Task 7: The tick — `tickSession`, ask 10, W19, the sweep, the fake-ingest control

**Files:**

- Modify: `apps/web/src/server/usecases/stream-sessions.ts`. Extract `tickSession` from `currentSession`'s
  reconcile-and-poll block (from :1402); `currentSession` calls it.
- Modify: `apps/web/src/app/api/cron/relay-sweep/route.ts`, and the sweep use-case it calls. Every open session is
  ticked, and beat history older than `PHONE_BEAT_RETENTION_HOURS` is deleted.
- Modify: `apps/web/src/server/relay/fakes.ts` (`FakeIngest.setConnected(inputId, connected)`, overriding the timer).
- Create: `apps/web/src/app/api/internal/relay/fake-ingest/[inputId]/route.ts`
- Test:
  - `server/usecases/__tests__/stream-tick.test.ts` (new, DB-backed);
  - `app/api/internal/relay/fake-ingest/__tests__/route.test.ts`;
  - `app/api/cron/relay-sweep/route.test.ts`.

**Interfaces:**

- Produces:
  - `tickSession(sessionId: string, deps: SessionDeps, cause: "poll" | "beat" | "sweep"): Promise<Session | null>`
  - The order inside it: lazy expiry → the coalesced ingest read (`claimIngestPoll`, which writes a `poll` sample
    with `ingest_state`) → `warming → live` (consumes the credit) → `target_rejected` → ask 10 (`warmingPhoneLost` →
    `stop(phone_lost)`) → W19 (`livePhoneLost` → `stop(phone_lost)`).
- Consumes `warmingPhoneLost` and `livePhoneLost` (T4b), and `tunable` (T4a).

- [ ] **Step 1: Write the failing tests** (DB-backed, with an injected clock and the fake drivers).
  - **Advancing without a panel.** A beat-cause tick advances `warming → live` with no organiser poll.
  - **Coalescing.** Two organiser polls and one beat inside one `STREAM_POLL_MS` make exactly one `inputStatus` call,
    counted on `FakeRecorder` (Review Focus 3).
  - **Ask 10.**
    - A warming session with a silent phone and no ingest is ended `phone_lost`, and its credit rows sum to 0.
    - A session with `first_ingest_at` is never ended by ask 10.
  - **W19.**
    - Live, no beat, the fake set not connected, and the last connected sample at exactly
      `PHONE_LOST_LIVE_MINUTES`: ended `phone_lost`. No refund row and no second consume.
    - The same at 14 min 59 s on each clock alone: not ended (two cases).
    - Beating while the input is down, for 20 min: not ended.
    - Silent while the input is connected, for 20 min: not ended.
    - The expected minutes come from `PHONE_LOST_LIVE_MINUTES`.
  - **Sweep.**
    - The sweep ticks an open session and ends a W19 session.
    - It deletes beat history older than 24 h, and keeps `fixture_stream_sessions.phone_beat` and
      `fixture_stream_pairings.last_beat`.
  - **Fake-ingest route.** It is 404 unless `RELAY_DRIVERS=fake` and `ENV_NAME ∈ {local, ci}`, with one test per
    refused combination: stg+fake, local+real, ci+real, and unset+fake. With both set, it flips the connection that
    the next tick reads.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f /tmp/cq1-t7.json && pnpm vitest run src/server/usecases/__tests__/stream-tick.test.ts src/server/usecases/__tests__/stream-sessions.test.ts src/app/api/internal/relay/fake-ingest/__tests__/route.test.ts src/app/api/cron/relay-sweep/route.test.ts src/server/relay/__tests__/fakes.test.ts --reporter=json --outputFile=/tmp/cq1-t7.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t7.json
```

- [ ] **Step 3: Implement.**
  - The extraction moves code; it must not change the organiser poll's behaviour. `stream-sessions.test.ts` stays
    green **with no assertion edits**. If one needs an edit, stop and report it: that is a behaviour change.
  - W19's three reads:
    - `phone_beat_at` from the session row;
    - the fresh read from this tick's `claimIngestPoll`. When the claim is held by another caller, use that caller's
      sample if it is younger than `STREAM_POLL_MS`; otherwise skip W19 this tick and never guess;
    - `max(sampled_at) where source='poll' and ingest_state='connected'`.

- [ ] **Step 4: Run Step 2's command.** Expected: green.

- [ ] **Step 5: Mutate.**
  - Ask 10 without the `first_ingest_at IS NULL` check. Red: a live session ended at 60 s.
  - W19: drop each conjunct (three mutants) and `>=` → `>`. Red: their cases.
  - Drop the `ENV_NAME` gate on the fake route. Red: its 404 cases.
  - The purge deletes the session's final beat. Red: the purge case.

- [ ] **Step 6: Commit** with `feat(stream): tickSession with ask-10 and W19 phone-lost ends; sweep ticks (T7)`,
  listing the mutations in the body.

Owes: use-case, regression (the fake route outside local/ci) and money (no consume for `phone_lost` before ingest; no
refund after).

### Task 7b: The 5-minute `stream-tick` job (W22)

**Precondition:** the Cloudflare Cron plan has merged. `ls $WT/apps/cron-worker/src/schedule.ts` exists. If not, STOP.

**Files:**

- Create: `apps/web/src/app/api/cron/stream-tick/route.ts` and `route.test.ts` beside it
- Modify: `apps/web/src/server/usecases/stream-sessions.ts` (`tickOpenSessions`)
- Modify, in `apps/cron-worker`:
  - `src/schedule.ts`: a `{ kind: "every"; minutes: 5 }` `Due`, the `stream-tick` row and `FAST_TRIGGER_CRON`;
  - `src/index.ts`: `scheduled` passes `controller.cron` to `runDue`;
  - `wrangler.json`: both envs carry the two triggers;
  - `test/schedule.test.ts` and `test/drift.test.ts`.

**Interfaces:**

- Produces `tickOpenSessions(deps): Promise<{ ticked: number; ended: number; failed: number }>`. It reads every open
  session of every org, then runs `tickSession(id, deps, "sweep")` on each inside its own try/catch, so one bad
  session never stops the rest.
- Produces the route `POST /api/cron/stream-tick`, which is a copy of `relay-sweep/route.ts`'s guard order: 503 with
  no `CRON_SECRET`, 401 on a mismatched `x-cron-secret`, and `{disabled: true}` when `deps.drivers.disabled`.
- Produces, in `schedule.ts`:

```ts
export const FAST_TRIGGER_CRON = "*/5 * * * *";
// JOBS gains:
{ id: "stream-tick", path: "/api/cron/stream-tick", due: { kind: "every", minutes: 5 }, retry: true, manual: true },
// dueJobs(scheduledTime, cron): the FAST trigger runs only `every` jobs; TRIGGER_CRON runs only the others, as before.
export function dueJobs(scheduledTime: Date, cron: string): Job[];
// jobCrontab(stream-tick) === FAST_TRIGGER_CRON (its Sentry monitor schedule).
```

- [ ] **Step 1: Re-pin the merged cron Worker.** Read `schedule.ts`, `index.ts`, `run.ts` and `test/drift.test.ts` as
  they landed. Confirm three things:
  - the job header is still `x-cron-secret`;
  - the drift guard still requires one `JOBS` row per `/api/cron/*` route;
  - `relay-sweep` has a row (Premise 12).

  If the merged shape differs from this task's, follow the merged shape and record each difference in the commit
  body.

- [ ] **Step 2: Write the failing tests.**
  - **`route.test.ts`.**
    - No `CRON_SECRET` → 503. A wrong secret → 401, before any session is read (a spy on `tickSession` sees 0 calls).
    - With a live W19 session and a warming session past its deadline, the job ends both (`phone_lost` and
      `no_inbound_timeout`) and answers `{ticked: 2, ended: 2, failed: 0}`.
    - A session whose tick throws is counted in `failed`, and the next one is still ticked.
    - An ended session is never ticked.
    - With no open sessions → `{ticked: 0, …}`. This is the empty case, and it asserts 0 ticks rather than skipping.
  - **`schedule.test.ts`.**
    - `dueJobs(t, FAST_TRIGGER_CRON)` is exactly `[stream-tick]` at any minute.
    - `dueJobs(t, TRIGGER_CRON)` never contains `stream-tick`, and is otherwise unchanged from the merged table: the
      count of hourly jobs is read from the table, not typed.
  - **`drift.test.ts`.**
    - Both envs carry `[TRIGGER_CRON, FAST_TRIGGER_CRON]`.
    - The stream-tick row's path resolves to the new route file.
    - The route scan now finds one more route than before, and still matches `JOBS` one to one.

- [ ] **Step 3: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f /tmp/cq1-t7b.json && pnpm vitest run src/app/api/cron/stream-tick/route.test.ts src/app/api/cron/relay-sweep/route.test.ts src/server/usecases/__tests__/stream-tick.test.ts --reporter=json --outputFile=/tmp/cq1-t7b.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t7b.json
cd $WT/apps/cron-worker && rm -f /tmp/cq1-t7b-cw.json && npx vitest run --reporter=json --outputFile=/tmp/cq1-t7b-cw.json test/schedule.test.ts test/drift.test.ts test/run.test.ts; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t7b-cw.json
cd $WT && pnpm --filter @seazn/cron-worker typecheck; echo EXIT=$?
```

  The cron-worker's test file names are the merged plan's: `schedule`, `call`, `sentry`, `run`, `manual` and `drift`.

- [ ] **Step 4: Implement.** Make the smallest change to the cron Worker:
  - one `Due` kind;
  - one row;
  - one trigger constant;
  - `dueJobs` keyed on `(scheduledTime, cron)`.

  The `ACTIVE` gate, the retry policy, the Sentry check-ins and the 12-minute deadline apply to `stream-tick` as they
  do to every job.

- [ ] **Step 5: Run Step 3's commands.** Expected: green in both workspaces.

- [ ] **Step 6: Mutate.**
  - `dueJobs` ignores `cron`. Red: every hourly job also fires every 5 min.
  - The route skips the secret check. Red: the 401 case.
  - `tickOpenSessions` stops at the first throw. Red: the `failed` case.
  - Drop `FAST_TRIGGER_CRON` from `wrangler.json`. Red: the drift case.

- [ ] **Step 7: Commit** with `feat(stream): a 5-minute stream-tick job on the cron Worker (T7b, W22)`, listing the
  mutations in the body. The PR body (T13) notes the account now runs four Cron Triggers of the Free plan's five.

Owes: unit, use-case and regression (the hourly jobs are unchanged).

### Task 8a: The descriptor — `GET /api/v1/capture/codes/{code}`

**Files:**

- Create:
  - `apps/web/src/server/relay/ingest-cred.ts`;
  - `apps/web/src/server/api-v1/capture-http.ts` (it now holds `captureJson` and `captureRefusal`);
  - `apps/web/src/server/usecases/capture-phone.ts` (`getCode`);
  - `apps/web/src/app/api/v1/capture/codes/[code]/route.ts`.
- Modify: `apps/web/src/server/relay/config.ts`: `STREAM_INGEST_HOST`, `STREAM_PLAYBACK_HOST` and
  `STREAM_SRT_ENABLED` readers.
- Test:
  - `server/relay/__tests__/ingest-cred.test.ts`;
  - `server/usecases/__tests__/capture-get.test.ts` (DB-backed);
  - `app/api/v1/capture/codes/__tests__/get-route.test.ts`.

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
// capture-phone.ts
export async function getCode(rawCode: string, tok: string, q: { slot: number; phone: string | null }, deps: SessionDeps, now: Date): Promise<z.infer<typeof CaptureDescriptor>>;
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
      - `holdWindowSeconds.srt` = `INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS`, with both ≤ 999.
    - A real-driver deployment without `STREAM_PLAYBACK_HOST` → `503 playback_unconfigured`.
    - `credentials_served_count` increments only when `cred` was in the body.
  - **`get-route.test.ts`.**
    - The 2xx body is bare, with no `ok` key, and parses with `CaptureDescriptor`.
    - A malformed code → `404 {code:"not_a_stream_code", message}`.
    - The wrong tok → `401 {code:"code_ended", message}`.
    - `Cache-Control: private, no-store` on 200, 401 and 404.
    - `slot` omitted → treated as 0. `slot=1` → `422 {code:"invalid"}`.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f /tmp/cq1-t8a.json && pnpm vitest run src/server/relay/__tests__/ingest-cred.test.ts src/server/usecases/__tests__/capture-get.test.ts src/app/api/v1/capture/codes/__tests__/get-route.test.ts --reporter=json --outputFile=/tmp/cq1-t8a.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t8a.json
```

- [ ] **Step 3: Implement.**
  - The route reads the Bearer through `relay/bearer.ts` and calls `captureRoute(() => getCode(…))`.
  - `cred` comes from `readFirstInput` (`secret-columns.ts:195`), opened inside the request only.
  - The answer is built field by field, never by spreading a DB row.

- [ ] **Step 4: Run Step 2's command.** Expected: green.

- [ ] **Step 5: Mutate.**
  - Serve `cred` to any phone (drop the current check). Red: the two-phone case.
  - Rewrite SRT too. Red: the W21 case.
  - Make `srtEnabled()` default to false. Red: the default case.
  - Send `scheduledStart: null` on waiting. Red: the route's contract parse.
  - Drop `no-store` from the 401 path. Red: the header case.

- [ ] **Step 6: Commit** with `feat(capture): the descriptor GET — cred only to the current phone, SRT on Cloudflare
  (T8a)`, listing the mutations in the body.

Owes: unit, use-case and regression (overlayUrl is never header-derived).

### Task 8b: Beats — `POST /api/v1/capture/codes/{code}/beats`

**Files:**

- Modify: `apps/web/src/server/usecases/capture-phone.ts` (`postBeat`)
- Create: `apps/web/src/app/api/v1/capture/codes/[code]/beats/route.ts`
- Test:
  - `server/usecases/__tests__/capture-beat.test.ts` (DB-backed);
  - `app/api/v1/capture/codes/__tests__/beats-route.test.ts`.

**Interfaces:**

- Produces `postBeat(rawCode, tok, body: CaptureBeat, deps, now): Promise<z.infer<typeof CaptureBeatAnswer>>`.
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
  - **The answer.**
    - Every 2xx carries the waiting fields and `pollSeconds`.
    - `sid`, `startedBy` and `endReason` are omitted, never null, where they do not apply.
    - Never 410: assert over every case that `status !== 410`.
  - **Storage.**
    - The minute throttle at 59 s and 60 s.
    - A change row for each flag: `battery_low` from `LOW_BATTERY_PERCENT`, `hot` from `HOT_THERMAL_STATUS`,
      `stalled`, `not_ready` and `not_responding`.
    - `at` five hours ahead still uses the server clock (Review Focus 4).
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
cd $WT/apps/web && rm -f /tmp/cq1-t8b.json && pnpm vitest run src/server/usecases/__tests__/capture-beat.test.ts src/app/api/v1/capture/codes/__tests__/beats-route.test.ts src/server/usecases/__tests__/stream-tick.test.ts --reporter=json --outputFile=/tmp/cq1-t8b.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t8b.json
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
  - `apps/web/src/lib/http.ts` and `apps/web/src/server/api-v1/http.ts`: both set `err.headers` on the response;
  - `apps/web/src/lib/rate-limit.ts`: the 429 carries `Retry-After`, plus the presets `CAPTURE_CODE_LIMIT` (120/60 s),
    `CAPTURE_FAIL_LIMIT` (30/60 s per IP, failed 401s) and `CAPTURE_START_LIMIT` (6/60 s);
  - `apps/web/src/server/logger.ts`: `redact: ['req.headers.authorization','*.tok','*.cred','*.streamKey','*.passphrase']`;
  - `apps/web/src/server/api-v1/key-scopes.ts`: `NEVER_KEY_ROUTES` gains `GET /capture/codes/:code`,
    `POST /capture/codes/:code/beats` and `POST /capture/codes/:code/start`;
  - `apps/web/src/server/api-v1/openapi.ts`: the three routes in `ROUTES` under tag `capture`.
- Test:
  - `server/usecases/__tests__/capture-start.test.ts`;
  - `lib/__tests__/rate-limit.test.ts`;
  - `lib/__tests__/http.test.ts`;
  - `server/__tests__/logger-redact.test.ts`;
  - `key-scopes.test.ts` and `openapi-coverage.test.ts`.

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
  - **Retry-After.**
    - The limiter's 429 has `Retry-After` equal to the window's remaining seconds, through the existing
      `__setRateLimitCounterForTests` seam.
    - `handler()` and `v1()` both copy `HttpError.headers`.
    - The capture routes' 429 body is `{code:"rate_limited", message}`.
  - **Redaction.** A spy logger drives each phone route, success and every error path. No captured line contains the
    tok, a stream key or a passphrase, and the count of captured lines is > 0 (anti-vacuity).
  - **Registry.** `key-scopes.test.ts`: an org API key on each phone route is refused at the door.
    `stream-contract.test.ts` gains a sibling of the relay-route pin for the `capture` tag: exactly the three phone
    operations, each an explicit `NEVER_KEY_ROUTES` entry with `matchKeyRoute(...) === null` on a concrete path, and a
    `checked === 3` count.
    `openapi-coverage.test.ts`: the three routes are covered.

- [ ] **Step 2: Run** and see them fail.

```bash
cd $WT/apps/web && rm -f /tmp/cq1-t8c.json && pnpm vitest run src/server/usecases/__tests__/capture-start.test.ts src/lib/__tests__/rate-limit.test.ts src/lib/__tests__/http.test.ts src/server/__tests__/logger-redact.test.ts src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-coverage.test.ts src/server/api-v1/__tests__/stream-contract.test.ts --reporter=json --outputFile=/tmp/cq1-t8c.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t8c.json
```

  If `lib/__tests__/http.test.ts` or `server/__tests__/logger-redact.test.ts` does not exist, create it. Confirm it
  appears in `.files`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run Step 2's command.** Expected: green.

- [ ] **Step 5: Mutate.**
  - Route `already_live` through a bare `HttpError`. Red: the `sid` body case.
  - Drop `Retry-After`. Red: its case.
  - Remove `*.passphrase` from `redact`. Red: the spy case.
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
cd $WT/apps/web && rm -f /tmp/cq1-t9.json && pnpm vitest run src/server/usecases/__tests__/stream-phone.test.ts "src/app/api/v1/fixtures/[id]/stream-phone/__tests__/route.test.ts" src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-coverage.test.ts src/server/api-v1/__tests__/stream-contract.test.ts src/server/usecases/__tests__/stream-sessions.test.ts --reporter=json --outputFile=/tmp/cq1-t9.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t9.json
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

- Consumes the real use-cases (`ensureStreamCode`, `postBeat`, `postStart`, `getCode`, `createSession`,
  `stopSession`, `tickSession` and `reissueStreamCode`), the fake drivers, `FakeIngest.setConnected`, and an injected
  clock (`deps.now`).

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
cd $WT/apps/web && for i in 1 2 3; do rm -f /tmp/cq1-t10-$i.json; CAPTURE_MODEL_SEED=$RANDOM pnpm vitest run src/server/usecases/__tests__/capture-model.test.ts --reporter=json --outputFile=/tmp/cq1-t10-$i.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests}' /tmp/cq1-t10-$i.json; done
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
  - `stream-sessions.ts` (`currentSession`'s `reveal` and the QR transaction removed);
  - `app/api/v1/fixtures/[id]/stream-sessions/current/route.ts` (`?reveal=1` → 400);
  - every reader of the two renamed columns, re-pinned with `grep -a`;
  - `capture-qr.test.ts`, `stream-sessions.test.ts`, `stream-contract.test.ts`, `stream-session-view.test.ts` and
    `fixture-stream-panel.test.tsx` (the v1 cases removed).
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
cd $WT/apps/web && rm -f /tmp/cq1-t11.json && pnpm vitest run src/lib/__tests__/stream-session-view.test.ts src/components/v2/__tests__/fixture-stream-panel.test.tsx src/lib/__tests__/capture-qr.test.ts src/server/usecases/__tests__/stream-sessions.test.ts src/server/api-v1/__tests__/stream-contract.test.ts "src/app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts" src/server/relay/__tests__/migration-shape.test.ts --reporter=json --outputFile=/tmp/cq1-t11.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t11.json
```

- [ ] **Step 3: Implement** the signed-off option. Then:
  - `cd $WT && pnpm i18n:gen-keys && pnpm i18n:check`;
  - `grep -rn -a -E "CaptureQrV1|parseCaptureQr\b|qr_issued_first_at|credentials_reveal|reveal=1" $WT/apps/web/src`
    returns nothing.

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
  - `apps/web/e2e/walkthrough/stream-relay.spec.ts` (the v2 rewrite of the QR steps, and the A11 zoom case on the v2
    QR);
  - `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` (registers the new walkthrough);
  - `scripts/smoke.ts` (`captureV2Suite`, plus a `SELECTABLE_SUITES.captureV2` entry).

**Interfaces:**

- `fakeCapturePhone(page, request, { phone?: string })` returns `{ claim(kind), beat(partial), get(), start(),
  ended(), stoppedBeat(sid) }`. It reads the QR text **from the panel's paste-code field** (`stream-qr-text`), so the
  panel's own output drives the real routes. This is the inert-seam rule.

- [ ] **Step 1: Write the walkthroughs** from spec §11.1.5. Every case is listed there.
  - Budgets are derived from the constants (AGENTS.md #20).
  - The server runs with `ENV_NAME=local`, `DEAD_PHONE_TAKEOVER_SECONDS=3`, `PHONE_LOST_LIVE_MINUTES=1` and the
    silent floor shortened, so A14, ask 10 and W19 run in seconds.
  - **W24:** the W19 case also asserts the panel shows "Reconnecting…", then the countdown sentence after 30 s, and
    that the session ends when the countdown reaches zero (within one poll).
  - **W22:** a W19 case with the panel **closed** ends through a direct `POST /api/cron/stream-tick` with the local
    `x-cron-secret`, proving the job ends a session no one is watching.
  - **W23:** four restarts that reach video through the fake ingest. The panel shows "(3 of 3) — this one uses 1
    credit" before the 4th, and the balance drops by exactly 1 after it. Each spec asserts the env it needs at its top and
    fails loudly if the env is missing.
  - The W19 case drives `fake-ingest/{inputId}` to disconnected and stops beats. It asserts the panel's
    `phone_lost` copy and the DB `end_reason`.

- [ ] **Step 2: Write `captureV2Suite`** from §11.1.6. It asserts the headers and the absence of `cred` for a second
  phone.

- [ ] **Step 3: Run** against a prod build of this worktree. Both files run whole, then the re-run list.

```bash
cd $WT/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/walkthrough/capture-phone.spec.ts e2e/walkthrough/stream-relay.spec.ts --project=walkthrough --reporter=line; echo EXIT=$?
cd $WT/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/walkthrough/stream-credits.spec.ts e2e/stream-overlay.spec.ts --project=walkthrough --reporter=line; echo EXIT=$?
cd $WT && SMOKE_ONLY=captureV2 pnpm test:smoke; echo EXIT=$?
cd $WT/apps/web && rm -f /tmp/cq1-t12.json && pnpm vitest run src/lib/__tests__/e2e-ci-wiring.test.ts --reporter=json --outputFile=/tmp/cq1-t12.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/cq1-t12.json
cd $WT && ./packages/engine/node_modules/.bin/vitest run scripts/__tests__/smoke-select.test.ts; echo EXIT=$?
```

  The smoke script is the root `package.json`'s `test:smoke`. `smoke-select.test.ts` lives at the repo root and runs
  from there, as `ci.yml` runs it.

- [ ] **Step 4: Mutate.**
  - Comment out the fake phone's claim. Red: every pairing case, which proves the helper is load-bearing.
  - Make `fake-ingest` a no-op. Red: A14 and W19.

- [ ] **Step 5: Commit** with `test(capture): walkthroughs for the phone routes, fake phone, smoke capture-v2 (T12)`,
  listing the mutations in the body.

Owes: E2E and smoke.

### Task 13: Lane close — the scoped gate, the staging runbook, then STOP

- [ ] **Step 1: Re-check the migration number.** `ls db/migration/deltas | sort -V | tail -1` on `origin/main`, plus
  `git log --all --name-only | grep -a V430`. If main has moved past V428, renumber and re-run T3's scope.

- [ ] **Step 2: Run the scoped gate.** That is the union of every task's vitest path list in one JSON run, then
  typecheck and lint. **Never the full suite.**

- [ ] **Step 3: Write the PR body draft** to `docs/superpowers/plans/2026-10-01-capture-qr-v2-pr1-pr-body.md`. It
  holds:
  - the mutation table (T10);
  - the per-screen verdicts (T11);
  - the staging runbook S1–S11, copied from spec §12 with each step's command. S2 includes the
    `srt-live-transmit` UDP-relay note. S11 is the W19 real-Cloudflare run;
  - the open item: the account's Cron Trigger count (four of the Free plan's five)
    (Review Focus 5).

- [ ] **Step 4: STOP.** No push and no PR. Report the branch, the gate counts and the open items to the orchestrator.

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
- **Placeholders.**
  - Two items are deliberately read on the tree at execution time, because they are not knowable from here: V410's
    end-reason constraint name (T3 Step 1) and the exact tenant policy text (copied, not written).
  - Both name the command that reads them.
- **Type consistency.**
  - `SlotState` includes `live_dead` (T4a); T4b and T8b consume it.
  - `WireEndReason` = `CaptureEndReason` (T1) = the output of `wireEndReason` (T4b).
  - `CaptureRefusalError` is born in T5 and used by T8a–T8c.
  - `tunable` is born in T4a and read by T7 and T12's env.
- **Review Focus.** All five lines have a test in their owning task (T5, T8b ×2, T7, T8a).
