# Email outbox phase 3, wave 5 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the last 17 emails onto the outbox: the funnel reminder (with spec §9, which closes F6) and the 16 staff
alerts. Then delete `send()` and `sendWithResult` from `lib/email.ts`, so the outbox is the only way an email leaves
and the no-second-path scan's `SENDER_ALLOWLIST` is empty. This leaves phase 4 its two obligations met and states what
phase 4 still owes.

**Architecture:** One migration widens the kind CHECK from 34 to 51 kinds. The funnel reminder is claimed and queued
per draft in one transaction (`update … where reminded_at is null returning`, then a once-keyed enqueue). The 16 staff
alerts share one writer, `queueStaffAlert` (new, `server/usecases/staff-alert.ts`). It reads `STAFF_ALERT_EMAIL`, writes on the
pooled connection with no org (R2), keys every row by a once-key that names the incident, and uses that once-key as the
`ref_id` too, so that two alerts never supersede each other. Each staff kind gets exactly one exported alert function, which its call
sites call and the kind sweep drives. Each kind swaps its `send*` for a render builder in the same commit (the cutover
rule). The last task deletes the private `send()` and `sendWithResult`.

**Tech Stack:** Next (repo fork, see `AGENTS.md`), TypeScript, postgres.js (`sql.begin`), Postgres 17 with Flyway
deltas, vitest (node environment), Playwright on CI only, Stripe (mocked in vitest).

**Spec:** `docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md` (owner-approved 2026-10-25). This wave
covers the wave-5 rows of its kind table (inventory #10, #33–#47 and #49), §9, §10, the wave-5 row of its test table
and the mutation rows "funnel claim" and "R2". Executors also read:
- the wave-1 plan, `docs/superpowers/plans/2026-10-25-email-outbox-phase3-wave1.md` (Global Constraints, T7 harness);
- the wave-2 plan, `docs/superpowers/plans/2026-10-26-email-outbox-phase3-wave2.md` (`onceKey`, `_money-fixtures.ts`,
  `checkQueuedOutboxRow`, the per-kind table shape);
- the merged wave-3 and wave-4 plans (written in parallel with this one; their names are re-pinned at T0);
- the phase-4 note, `docs/superpowers/specs/2026-10-26-email-service-phase4-note.md`.

## Global Constraints

Everything in the wave-1 plan's Global Constraints (its lines 25–102) applies, with the path, branch and label replaced
as below. This wave's Global Constraints are binding where they differ. The lines that bite here are restated.

- **Worktree.** `/Users/ashokhein/github/seazn.club/.claude/worktrees/outbox-p3-w5`, branch
  `feat/email-outbox-phase3-w5`, cut from `origin/main` after wave 4 merges (T0). Prefix every command with
  `cd <that path> &&` or `cd <that path>/apps/web &&`. Never check anything out in the main checkout. Never use
  `git stash` in a worktree.
- **Migration number.** It is written `V<N>` below. It is main's max + 1 at the time T1 is committed. After wave 4 it is
  expected to be around V476, but W2d also takes numbers, so re-pin at T0. Re-pin right before committing T1 and again right before opening the PR:
  `git fetch origin && git ls-tree --name-only origin/main db/migration/deltas/ | sort -V | tail -1`. If the number is
  taken, `git mv` and amend while the branch is unmerged.
- **R1–R6, D1, D4** are as in the spec. The ones that bite here:
  - **R2.** A staff alert reports a failure. It is written on the pooled connection, never on the transaction whose
    failure it reports.
  - **R3.** Staff alerts and the funnel reminder have no org: `orgId: null`, and they are written on `sql` or in a `sql.begin`.
  - **R4.** Never catch an enqueue error inside a transaction and carry on.
  - **R6.** Enqueue only on the transition. For the funnel reminder, the claim is the conditional update.
  - **D1.** A refused enqueue fails the action. Staff alerts are the exception proposed in Q1 (P-W5-3).
- **No pooled `sql` call inside `withTenant`** (#996). T0 confirms that none of the 19 staff sender sites sits inside a
  transaction callback.
- **The cutover rule.** A kind's `send*` is deleted in the same commit that adds its enqueue.
- **Transactional flag.** All 17 kinds are `transactional: true`, which is their senders' current flag (`lib/email.ts:458`,
  and every staff sender passes `true`).
- **First attempt.** All 17 kinds are W. There is no `dispatchNow`; the worker sends after the 30 s window (spec §4,
  §10).
- **Expiry.** Staff kinds use `expiryWithin(null)`. The funnel reminder uses `expiryWithin(new Date(draft.expires_at))`
  (spec §9, §12).
- **Copy.** This wave adds and changes no user-facing string. The funnel reminder reuses the `funnelReminder.*` keys,
  which exist in all four locales. The staff dispute alert keeps its `staffDisputeAlert.*` keys in `en`. The other 15
  staff alerts keep their inline English (spec F2). No i18n work and no screenshots are owed. If an executor finds
  otherwise, they stop and report.
- **Test rules.** `docs/superpowers/TEST-STRATEGY.md` and the four test types in `docs/superpowers/RULES.md` are binding.
  The owner's 2026-10-26 rules cut them down to:
  - One test per behaviour, on mainstream paths.
  - No key-fault or KEK-unset tests.
  - Every guard is mutated once, and its killer is named.
  - Sweeps print their count, and zero is a failure.
  - Expected values come from the spec, the `emails` dictionary on disk, a frozen literal typed from the sender's
    current source (staff subjects), or a mock's own value. They never come from the code under test.
  - "Another sport" applies only to the funnel reminder, which names a sport. It runs two (spec, Test strategy 4).
- **Changed while queued (owner, 2026-10-26).** For each kind, the per-kind table names which body facts can change while the row
  waits, and what refreshes it. Code or a test is added only for a change that is common. None is common in this wave
  (see the table), so no code or test is added for one.
- **ENV.** `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`; `$S up --label outbox-p3-w5`, then
  `eval "$($S env --label outbox-p3-w5)"`. After a migration edit, run `$S down … && $S up …`. Never run a bare
  `pnpm db:apply`. Confirm `show data_directory` is this label's.
- **VERIFY `<files>` → `tN`** is exactly the wave-2 command, with `outbox-p3-w5` in the path and label. Green means:
  - `failed == 0`;
  - `total` is unchanged, or grows as the step says;
  - every listed file appears under this worktree's path in `.testResults[].name`;
  - `EXIT=0`. The JSON reporter cannot see an unhandled rejection, so the exit code is checked as well.
- **TSC**, **LINT** and **MUTATE** are the wave-2 recipes. Never use `git checkout`, `git stash` or `git restore` on a file. Run
  the env down/up around a SQL mutation.
- **Never locally:**
  - the full vitest suite, the full e2e suite, `$S gate` or a local web server;
  - e2e (CI dispatch only, by the controller): `gh workflow run e2e.yml --ref feat/email-outbox-phase3-w5 -f pr=<n>`.

  Smoke runs on the PR's CI smoke job.
- **Agents.** Implementers and reviewers follow `docs/superpowers/RULES.md` and `.claude/agents/*.md`. Do not override a model.
- **No evidence PNGs in the repo. Kill only your own PIDs.**
- **Commit trailer.** Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- **Executors re-pin by symbol.** Every line number below is as of `67eb05aedd` (wave 1 merged). Waves 2–4 edit
  `lib/email.ts`, `billing-events.ts` and `registrations.ts`, so every line moves. Re-pin with `grep -an <symbol>`
  before editing.

**Rulings carried from earlier waves (binding here):**
- **R-T1f.** The once-key index is global across orgs, so a key embeds a UUID or a Stripe id. The one exception is
  `staff_earn_grant_volume`, which is global by nature (P-W5-15). `onceKey()` (wave 2, T1) refuses a missing id.
- **Account vs literal vs staff.** `OUTBOX_KIND_FACTS[kind].to` decides. A staff kind never carries `recipientUserId`.
- **C2.** The no-second-path scan reads production sources only.
- **C4.** A failure is witnessed by a failing SQL statement, never by a throw before any SQL. The exception is T3's
  rollback test, which tests transaction atomicity, not a savepoint.
- **Phase-4 note (owner, 2026-10-26).** No send path bypasses the outbox. Dispatch, the worker and the webhook keep no
  app-render dependency: every body renders at enqueue, and every new `KIND_HOOKS` entry is `{}`.

## Count reconciliation: 17 kinds

These counts were checked against the tree at `67eb05aedd`:
- `lib/email.ts` has 44 `send*` exports (`grep -an "^export async function send"`, excluding `sendWithResult`). That is
  49 less wave 1's 5.
- Waves 2–4 move 27 of them:
  - wave 2: 10 (the dispute, sponsor, pass and trial senders);
  - wave 3: 8 (verification, funnel claim, both email-change senders, account deletion, org invite, claim invite,
    official invite);
  - wave 4: 9 (both official notices, both suspension notices, report submitted, and the four group senders).
- That leaves **exactly 17**, and they are this wave's 17:
  - `sendFunnelReminderEmail` (:452);
  - 16 senders to `STAFF_ALERT_EMAIL`: `sendStaffDisputeAlertEmail` (:732), `sendStuckEventsAlertEmail` (:755),
    `sendCreditPackGrantFailedAlertEmail` (:789), `sendSizePackGrantFailedAlertEmail` (:829),
    `sendStreamCreditGrantFailedAlertEmail` (:881), `sendStreamCreditClawbackAlertEmail` (:944),
    `sendStreamPackPriceDriftAlertEmail` (:995), `sendPassCreditReversalIncompleteAlertEmail` (:1050),
    `sendPassRungMismatchAlertEmail` (:1145), `sendPassUnknownCompetitionAlertEmail` (:1233),
    `sendAiRunCostAlertEmail` (:1304), `sendEarnGrantVolumeAlertEmail` (:1368), `sendExtraOrgAllowanceAlertEmail` (:1421),
    `sendExtraOrgRepriceFailedAlertEmail` (:1500), `sendRegistrationRefundFailedAlertEmail` (:1567) and
    `sendConnectBankAlertEmail` (:1652).

The spec's kind-table rows for wave 5 name the same 17. The spec's `email.ts` line citations are as of `a622343cc`; wave 1
shifted each one by 23 lines. `billing-events.ts:2267` is current.

Callers in production code:
- **`send(`** is called only by the 44 senders inside `lib/email.ts`.
- **`sendWithResult(`** is called only by `send()` (`:281`). `transport.ts` calls `deliver` and never `sendWithResult`.
- No other production file names `api.resend.com` or imports a mail SDK. The scan's section 4 holds this at 1 file.
- **Staff sender call sites: 19**, which matches spec F1. They are reached from **33 trigger points**, because six helpers fan
  in:
  - `alertStreamClawback`: 4 callers;
  - `notifyStaffDispute`: 3;
  - `maybeAlertOrgRepriceFailed`: 4;
  - `maybeAlertRegistrationRefundFailed`: 4;
  - `maybeAlertExpensiveRun`: 3;
  - `passSessionRungMatchesPrice`: 2.

  The per-kind table names the helper, so a call site is never missed.

If T0 finds a number other than 17 (a wave 2–4 merge that left a sender, or a new `send*`), it stops and reports.

## Plan decisions where the tree contradicts or underdetermines the spec

Each one is a finding to record in the wave's report. A controller who disagrees with one rules before its task runs.
Q1 and Q2 are owner questions. The plan builds their recommendation unless the owner rules otherwise.

| # | Spec says | The tree says | Plan does |
|---|---|---|---|
| P-W5-1 | §10: "the once-key is the id the alert is about". | The replace trigger (V472:62-77) supersedes on kind + `ref_type` + `ref_id` + recipient, with org compared by `is not distinct from`. Every staff row has the same recipient and a null org. So two alerts of one kind with a shared ref replace each other while queued. Examples: two mispriced riders on one subscription in one sweep pass (`:1674`); a partial refund, then the full refund of the same charge (`:2127`, `:2148`). | A staff row's `ref_id` IS its once-key. Each incident gets its own ref, so the trigger never pairs two staff alerts. Killer: T2 test 4. |
| P-W5-2 | §10: staff alerts "stay transactional", "written on the pool with no org (R2)". | Every one of the 19 sites is a fire-and-forget `void send…().catch(() => {})` or an awaited never-throws helper. None is inside a transaction callback; T0 re-confirms this. | One writer, `queueStaffAlert`, on `sql`. Every `void` site becomes `await alert…()`. Webhooks and crons have no user waiting, and one insert is cheap. The two `deferred(...)` sites (`extra-orgs.ts:275`, the three AI-run callers) stay deferred. |
| P-W5-3 | D1: "a refused enqueue fails the action … everywhere". | Every staff site is documented NEVER THROWS, because an alert that threw "would turn 'a refund failed' into 'the webhook/request fails and retries forever'" (`registrations.ts:4742-4760`, `billing-events.ts:1329-1342`, `lib/billing.ts:1410-1424`, `extra-orgs.ts:366-376`, `ai-runs-admin.ts:229-235`, `credits.ts:1602-1610`). A staff enqueue is on the pool, so R4 does not apply. It can only be refused when the KEK is misconfigured or an id is missing. | **Q1.** Recommended: `queueStaffAlert` never throws. It catches, writes `log.error({ err, kind, refType })` with no address and no body, and returns `null`. The action it reports goes on. Killer: T2 test 5. If the owner rules D1 instead, T2 drops the catch, and each `maybeAlert*` keeps its own existing catch. |
| P-W5-4 | `staff_extra_org_reprice_failed` once-key: "subscription + price". | `sweepStaleOrgAddonPrices` says "REPEATS ITS ALERTS … the intended behaviour for a money fault — it should nag until someone acts" (`billing-events.ts:1475-1480`). It runs daily with `retry: true` (`apps/cron-worker/src/schedule.ts:77-87`). With the spec's key, a stale rider is alerted once in 90 days. | **Q2.** Recommended key: `onceKey(kind, "subscription", subscriptionId, "<itemId or 'plan'>:<UTC yyyy-mm-dd>")`. This is once per rider per UTC day, from the webhook and the sweep together. A same-day cron retry or webhook replay sends nothing new, and tomorrow's pass nags again. |
| P-W5-5 | `staff_stream_pack_price_drift` once-key: "lookup key + price". | `alertDriftOnce` (`lib/relay-checkout.ts:115-124`) dedupes per process in memory. A deploy re-alerts; a long-lived process never re-alerts. While the drift lasts, every checkout for the pack is refused. | **Q2**, same rule: `onceKey(kind, "stripe_price", priceId, "<lookupKey>:<UTC day>")`. The in-memory `Set` stays (it bounds `captureError`), keyed `<priceId>:<UTC day>`. |
| P-W5-6 | `staff_ai_run_cost` once-key: "AI run id". | There is no run id: the ledger inserts (`competition-schedule-ai.ts:~3150`, `schedule-ai.ts:~3500`, `officials-ai.ts:~1330`) have no `returning`. A run alerts once, from one `deferred`, with no replay path. A double press is two runs and two costs. | `id: randomUUID()`, minted inside `maybeAlertExpensiveRun`, with ref type `ai_run`. The once-key never repeats, by design. The three callers are not touched. |
| P-W5-7 | `staff_registration_refund_failed` once-key: "registration · refund attempt". | No attempt id exists. There are four sites, each with an audit `mode`: `confirmPaidRegistration` (`:3324`, webhook, `late`/`duplicate`), `withdrawCore` (`:5125`, `auto`), `sweepRegistrations` (`:5735`, `auto_pool_deadline`) and `rejectRegistration` (`registration-approval.ts:300`, `reject`). A webhook replay or a sweep re-run that fails the same refund again re-pages today. | `maybeAlertRegistrationRefundFailed` gains `mode: string`. The key is `onceKey(kind, "registration", registrationId, "<mode>:<amountCents>")`. The same unmoved refund failing again pages once; a different amount (the state moved) pages again. |
| P-W5-8 | `staff_stuck_events` once-key: the Stripe event id. "Today it already fires once per event". | The park is unconditional: `set replay_attempts = replay_attempts + 1` (`:2894`). Two overlapping sweeps can both park and both alert. The `billing-events` cron is `retry: true`. | R6: `update billing_events set replay_attempts = 4 where id = $1 and replay_attempts = 3 returning id`. Alert, and count `alerted++`, only when a row is returned. Key `onceKey(kind, "stripe_event", row.id, "parked")`. |
| P-W5-9 | `staff_stream_credit_clawback` once-key: "charge or dispute". | There are four shapes (`:2127` partial, `:2148` short, `:2177` ungranted, `:2360` lost dispute). The dispute shape passes `chargeId: dispute.id`. One charge can legitimately be partial-refunded and then fully refunded. | Keys: `<charge.id>:partial:<amount_refunded>`, `<charge.id>:short`, `<charge.id>:ungranted` (ref type `charge`), and `<dispute.id>:lost` (ref type `dispute`). `alertStreamClawback` gains `shape`, and its args are renamed `{ refType, refId }`. |
| P-W5-10 | `staff_credit_pack_grant_failed`: "checkout session". | The second site (`:2066-2075`) passes `sessionId: charge.id`, from a refund. | Site 1 is ref type `checkout_session` keyed by `session.id`. Site 2 is ref type `charge` keyed by `charge.id`. Both are Stripe ids, so they cannot collide. |
| P-W5-11 | `staff_pass_credit_reversal_incomplete`: "charge". | The redemption is keyed by payment intent, and the alert fires after the reversal transaction commits (`pass-credit.ts:722-752`). The transition (`reversed_at is null … returning`) already runs once. | Ref type `payment_intent`, key `<intent>:reversal`. It stays on the pool after the commit (R2, uniform). A crash between the commit and the insert is a rare case. |
| P-W5-12 | Rung mismatch and unknown competition: "checkout session". | Both fire from two sources: the webhook (`billing-events.ts:368`, `:395-407`) and reconcile-on-return (`lib/billing.ts:1497`, `:1517-1529`). The rung alert is already deduped by the refusal row (`lib/billing.ts:1305-1318`); the unknown-competition alert is not. | Key `session.id` for both. One alert per session across both sources. The rung gate stays, and the once-key backs it up. |
| P-W5-13 | `staff_dispute_alert`: `dispute · <id>:<phase>`, rendered from the dictionary in `en` (§10). | It is current: one sender call in `notifyStaffDispute` (`:2267`), reached from three branches (`:2323`, `:2369`, `:2423`). | The key is `onceKey(kind, "dispute", dispute.id, phase)`. The builder is `staffDisputeAlertEmail(args, "en")`. The best-effort `staff_audit_log` breadcrumb is untouched. |
| P-W5-14 | Kind `staff_connect_bank_changed`. | The site alerts only on `account.external_account.deleted` (`:2489`, "Only the DESTRUCTIVE half pages staff"), and the subject says "removed". | The spec's kind name is kept, because the vocabulary is the spec's. Key `onceKey(kind, "stripe_event", event.id)`. |
| P-W5-15 | `staff_earn_grant_volume`: "UTC day". | `earnGrantVolumeToday()` counts globally (`lib/credits.ts:1581-1586`). The cron runs daily with `retry: true`. | Key `onceKey(kind, "utc_day", "<yyyy-mm-dd>")`. This is the one key with no UUID or Stripe id: the alert is global by nature (R-T1f exception). Tests delete this kind's rows for the day before they drive it, because a shared test DB has seen the key. |
| P-W5-16 | `staff_extra_org_allowance`: "group + count". | `maybeAlertOrgAllowance` (`extra-orgs.ts:377-424`) is deferred after a purchase. | Key `onceKey(kind, "subscription", subscriptionId, String(extraOrgs))`. |
| P-W5-17 | §2/D4 locale for `funnel_reminder`. | `funnel_drafts` has no locale column (`V272__funnel_drafts_and_currency.sql:6-15`), no account link and no org. D4 therefore gives `en`, which is today's output. | Use the source wave 3 chose for `funnel_claim`, if it stored one on the draft (re-pin at T0), so the claim and the reminder share a language. Otherwise use `en`, and the owner gets Q3. |
| P-W5-18 | §9: the funnel fix. | The due select claims nothing (`funnel/remind/route.ts:25-32`), and the stamp follows the send (`:46`). A failed send is stamped and lost; two schedulers double-send (F6). `sent` counts sends that Resend accepted (`:43`). | Per draft: parse, then one `sql.begin` that runs the conditional stamp and then the once-keyed enqueue. `sent` counts queued rows (§8). A throw fails the run (D1), and `retry: true` re-runs it. The response shape `{ due, sent }` is unchanged. |
| P-W5-19 | Harness: the 15 inline-English staff kinds assert "a frozen literal subject, typed into the test". | `KindScenario` requires `subjectKey` (`_kind-harness.ts:31-45`). | Additive: `subjectLiteral?: string`. A scenario gives exactly one of `subjectKey` and `subjectLiteral`, or the harness throws by kind. The staff dispute alert uses `subjectKey` (`staffDisputeAlert.subject`, `en`). |
| P-W5-20 | Harness: "the kind's REAL producer". | Several alert sites sit behind deep branches: a reversal needing a balance history, a 20-run AI median, 20 earn grants, a converge loop. | Each staff kind has ONE exported alert function, which every site calls. The sweep drives that function, or the outer production entry where it is cheap (`sweepStuckEvents`). Each kind's site test drives a real call site to a row. That is the inert-seam proof: the call site writes the row; the sweep proves the row sends. |
| P-W5-21 | Wave-5 e2e: "one staff-alert path". | CI e2e has no `STAFF_ALERT_EMAIL` (`grep -an STAFF_ALERT_EMAIL .github/workflows/e2e.yml`: none). With it unset, no row is written, so the e2e would prove only the empty case. | T9 adds `STAFF_ALERT_EMAIL: staff-alerts@e2e.invalid` to the env of the e2e job that runs `payments-hardening.spec.ts` (re-pin the job at T0). This is a live CI edit. `.invalid` never resolves, and CI has no Resend key. The test fails, not skips, when the variable is unset. |
| P-W5-22 | Phase-4 note: phase 4 moves `checkSendable` and `deliver` out of `lib/email`. | The Resend webhook route also imports `suppress` from `@/lib/email` (`app/api/webhooks/resend/route.ts:3`). `classify.ts` imports the `SendResult` type from it. `checkSendable` uses `isSuppressed`. | Recorded in "Phase 4 still owes" below. Not built here. |
| P-W5-23 | "Wave 5 ends by deleting `send()` and `sendWithResult`". | `lib/__tests__/email-send-result.test.ts` is `sendWithResult`'s unit test. It is also the one test the scan exempts by path (`no-second-path.test.ts:751-756`). The scan's matcher skips `sendWithResult` on purpose (`OUTBOX_SENDER`, `:63`). | The test file is repointed to `checkSendable` + `deliver` and kept at its path, so the exemption stays exact. The `OUTBOX_SENDER` skip is removed: a re-added `sendWithResult` is then a new `send*` export and fails the allowlist test. |
| P-W5-24 | Wave-5 test row: "an alert written after a rolled-back transaction survives (R2)". Mutation: "write it on the failing transaction". | No staff alert is written inside a transaction today. The natural witness is `withdrawCore`: its refund-record `sql.begin` (`:5100-5110`) fails, its catch audits, and it alerts (`:5114-5129`). | One test (T4, `staff_registration_refund_failed`), using wave 2's failing-SQL seam `plantFailingUpdate("registration_groups", …)`. It is money: a registrant is owed a refund, and the alert is the only page. Mutation: call the alert inside the `sql.begin` on `tx`; the alert row is then lost. |
| P-W5-25 | Mutation "the funnel `reminded_at is null` claim → the concurrent test sends two". | With the once-key in place, dropping the claim still leaves one ROW. | The concurrent test also asserts the enqueue spy saw one call for the draft, which kills the claim alone. A separate reset-and-resweep test kills the once-key alone. |
| P-W5-26 | (stale citation) Spec §10: "16 kinds … 19 call sites", with `email.ts` lines `:755`–`:1675`. | These are wave-1-shifted (see Count reconciliation). | Re-pin by symbol. |

**Routed pre-existing finding (not built).** Suppose the Stripe refund in `withdrawCore`, `sweepRegistrations` or
`rejectRegistration` succeeded and then the record transaction failed. The catch then audits `registration.refund_failed`
and pages "still owed", although the money moved. That needs a DB fault after Stripe succeeded, which is rare. The R2
test (P-W5-24) stages exactly this shape, so its report must say that the page's wording is wrong there.

## Review Focus

These are the conditions most likely to hurt a person first. Each one's test lives in its owning task.

1. **Two alerts of one kind, queued seconds apart, both arrive.** Examples: two riders in one sweep pass; a partial and
   then a full refund of one charge. Neither may be `replaced` (P-W5-1). Tests: T2 test 4, and T5's clawback test 3.
2. **A webhook replay or a same-day cron retry of a money alert pages once.** The refund-failed key is P-W5-7, the
   reprice key P-W5-4, the stuck-event park P-W5-8. Tests: T4 refund test 2, T5 reprice test 2, T6 stuck test 2.
3. **A stale rider is still nagged tomorrow** (Q2). Test: T5 reprice test 3.
4. **A funnel reminder whose first send fails is retried, not lost** (§9). Two schedulers send one reminder (F6). Tests:
   T3 tests 2 and 3.
5. **An alert behind a rolled-back transaction survives** (R2, P-W5-24), and **a refused alert never fails the money
   action it reports** (Q1). Tests: T4 refund test 3, T2 test 5.

## The 17 kinds

All are `transactional: true`, `orgId: null` and W. Staff kinds are written by `queueStaffAlert` with
`expiresAt: expiryWithin(null)` and `ref_id` = once-key (P-W5-1). "Sweep producer" is what the T1 sweep scenario
drives (P-W5-20). "Site test" is the existing suite, repointed from the sender mock to rows, that drives a real call
site.

| Kind (spec order) | Sender deleted (email.ts @67eb05) | Builder added | Alert function (sites) | `ref_type` · once-key | Sweep producer · subject | Site test | Changed while queued |
|---|---|---|---|---|---|---|---|
| `funnel_reminder` | `sendFunnelReminderEmail` :452 | `funnelReminderEmail(args, locale)` | route `funnel/remind` POST (1 site) | `funnel_draft` · `<draft.id>:reminder` (ref_id = draft id) | the route; `funnelReminder.subject` {competitionName}, P-W5-17 locale | new `app/api/funnel/remind/__tests__/route.test.ts` | Name and sport cannot change: there is no edit path for a draft. A claim in the ~1.5 min between enqueue and send leaves a spent link (rare, recorded). Expiry is covered by `expiresAt`. |
| `staff_registration_refund_failed` | :1567 | `registrationRefundFailedAlertEmail(opts)` | `maybeAlertRegistrationRefundFailed` (`registrations.ts:4762`; 4 sites) | `registration` · `<regId>:<mode>:<amountCents>` | the function; literal `Registration refund failed — <money> still owed (registration <id>)` | `registration-refund-alert.test.ts`, `registration-approval.test.ts`, `registrations.test.ts` | A later successful refund does not unsay the incident. Staff read the console. Nothing refreshes it. |
| `staff_credit_pack_grant_failed` | :789 | `creditPackGrantFailedAlertEmail(opts)` | new `alertCreditPackGrantFailed` (`billing-events.ts`; 2 sites :294, :2068) | `checkout_session` · `session.id`, or `charge` · `charge.id` | the function; literal `Credit pack purchase could not be granted: <ref>` | `credit-pack-refund.test.ts`, plus a session test beside it | A manual grant later does not unsay it. Nothing refreshes it. |
| `staff_size_pack_grant_failed` | :829 | `sizePackGrantFailedAlertEmail(opts)` | new `alertSizePackGrantFailed` (1 site :510) | `checkout_session` · `session.id` | the function; literal `Size pack purchase could not be granted: <session>` | `size-pack-addon.test.ts` | As above. |
| `staff_stream_credit_grant_failed` | :881 | `streamCreditGrantFailedAlertEmail(opts)` | new `alertStreamCreditGrantFailed` (`stream-credits-checkout.ts`; 2 sites :121, :150, webhook only via `alertStaff`) | `checkout_session` · `session.id` | the function; literal `Match credits could not be granted: <session>` | `stream-credits-webhook.test.ts`, `stream-credits-reconcile.test.ts` (asserts no row) | As above. |
| `staff_pass_credit_reversal_incomplete` | :1050 | `passCreditReversalIncompleteAlertEmail(opts)` | new `alertPassCreditReversalIncomplete` (`pass-credit.ts`; 1 site :733-752, the org and competition reads move into it) | `payment_intent` · `<intent>:reversal` | the function; literal per `reason` (the executor types the `undetermined` subject from `:1053-1060`) | `pass-credit-refund-reversal.test.ts` | Staff resolution (§6, `pass-credit.ts:760-`) does not cancel it: the alert asks for that resolution. |
| `staff_pass_rung_mismatch` | :1145 | `passRungMismatchAlertEmail(opts)` | `maybeAlertPassRungMismatch` (`lib/billing.ts:1426`; 1 site, 2 sources) | `checkout_session` · `session.id` | the function; literal `Event Pass NOT granted — price/rung mismatch: <session>` | `pass-checkout-plan-gate.test.ts` | A staff grant later does not unsay it. |
| `staff_pass_unknown_competition` | :1233 | `passUnknownCompetitionAlertEmail(opts)` | new `alertPassUnknownCompetition` (`lib/billing.ts`; 2 sites `billing-events.ts:397`, `lib/billing.ts:1519`) | `checkout_session` · `session.id` | the function; literal `Event Pass NOT granted — unknown competition: <competitionId>` | `billing-pass-unknown-competition.test.ts` | As above. |
| `staff_stream_credit_clawback` | :944 | `streamCreditClawbackAlertEmail(opts)` | `alertStreamClawback`, exported and async (4 sites :2127, :2148, :2177, :2360) | `charge` / `dispute` · P-W5-9 | the function, `partial` shape; literal `Match credits claw-back needs review: <ref>` | `stream-credits-clawback.test.ts`, `billing-pass-stream-credits.test.ts` | Each shape is its own incident. A later full refund is a new key (P-W5-9). |
| `staff_extra_org_reprice_failed` | :1500 | `extraOrgRepriceFailedAlertEmail(opts)` | `maybeAlertOrgRepriceFailed` (`billing-events.ts:1343`; 4 sites) | `subscription` · P-W5-4 | the function; literal `Extra-org rider stuck on the wrong price (group <subscriptionId>)` | `org-addon-price-sweep.test.ts`, `extra-org-addon.test.ts` | A convergence later does not unsay it. The next day's pass is a new key. |
| `staff_dispute_alert` | :732 | `staffDisputeAlertEmail(args, locale)` | `notifyStaffDispute`, exported (3 sites) | `dispute` · `<id>:<phase>` | the function, phase `created`; `staffDisputeAlert.subject` `en` {orgName, kind label} | `platform-dispute.test.ts`, `dispute-unmatched-retry.test.ts`, `stream-credits-clawback.test.ts`, `billing-pass-stream-credits.test.ts` | `closed` is a new key, so `created` is never replaced (P-W5-1). |
| `staff_connect_bank_changed` | :1652 | `connectBankAlertEmail(opts)` | new `alertConnectBankRemoved` (`billing-events.ts`; 1 site :2497) | `stripe_event` · `event.id` | the function; literal `Connect bank account removed: <orgName>` | `billing-events-payout-health.test.ts` | A bank re-added later is a separate event, and it pages nothing (`.updated` is silent by design). |
| `staff_stuck_events` | :755 | `stuckEventsAlertEmail(opts)` | `sweepStuckEvents` park (1 site :2897) | `stripe_event` · `<event.id>:parked` | `sweepStuckEvents` (`STRIPE_SECRET_KEY` stubbed; the park path calls no Stripe); literal `Stuck webhook event needs review: <eventId>` | `billing-events-sweep.test.ts` | A parked event is never selected again (`< 4`). A staff replay does not cancel the alert. |
| `staff_stream_pack_price_drift` | :995 | `streamPackPriceDriftAlertEmail(opts)` | `alertDriftOnce`, exported as `alertStreamPackPriceDrift`, async (1 site :96) | `stripe_price` · P-W5-5 | the function; literal `Match-credit pack price differs from the table: <lookupKey>` | `relay-checkout.test.ts` (its `@/lib/email` mock gains `importOriginal`) | Fixing the price mints a new price id, which is a new key. |
| `staff_ai_run_cost` | :1304 | `aiRunCostAlertEmail(opts)` | `maybeAlertExpensiveRun` (`ai-runs-admin.ts:236`; 3 deferred callers) | `ai_run` · fresh UUID (P-W5-6) | the function, with 20 seeded `schedule.ai_officials_generated` rows; literal `Expensive AI run: $<cost.toFixed(4)> (org <orgId>)` | `ai-run-cost-alert.test.ts` | A run's cost is final. |
| `staff_earn_grant_volume` | :1368 | `earnGrantVolumeAlertEmail(opts)` | `checkEarnGrantVolumeAlert` (`lib/credits.ts:1611`; cron) | `utc_day` · `<yyyy-mm-dd>` (P-W5-15) | the function, with ≥20 seeded `earn_grant` ledger rows today; literal `Earn-grant volume alert: <count> today (threshold 20)` | `earn-grant-volume-alert.test.ts` | Later grants the same day are not re-paged. That is the point of a daily key. |
| `staff_extra_org_allowance` | :1421 | `extraOrgAllowanceAlertEmail(opts)` | `maybeAlertOrgAllowance` (`extra-orgs.ts:377`; 1 deferred site) | `subscription` · `<subscriptionId>:<extraOrgs>` | the function; literal `Large billing group: <total> organisations (group <subscriptionId>)` | `extra-org-addon.test.ts` | A later purchase is a new count, so a new key. A drop and a re-rise to the same count within 90 days is not re-paged (rare, recorded). |

**Builder convention.**
- `<name>AlertEmail(opts: Omit<<Sender>Opts, "to">): EmailContent` is synchronous. It is the sender body minus `send(...)`;
  the HTML and text are byte-identical to today's.
- `staffDisputeAlertEmail(args: StaffDisputeAlertArgs, locale: Locale = "en"): Promise<EmailContent>` and
  `funnelReminderEmail(args: FunnelEmailArgs, locale: Locale): Promise<EmailContent>` load the dictionary.
- `EmailContent` is `lib/email.ts:298`.
- The `*Email` option interfaces lose `to`.

**Interfaces consumed from waves 2–4** (merged before T0; re-pin each name and count at T0):
- `onceKey`, `expiryWithin`, `enqueueEmailOnce`, `recipientLocale` (if Q3/P-W5-17 needs it), from `@/server/email-outbox`.
- `forEachOutboxKind`, `KindScenario`, `KindFacts`, `bornAgo`, `dictionarySubject` (`__tests__/_kind-harness.ts`).
- In `outbox-kind-sweep.test.ts`: `SPEC_KINDS`, `SPEC_FACTS`, and the legend test.
- In `_kind-senders.ts`: `SENDER_ALLOWLIST`, `NOT_YET_MOVED`, `KIND_DIRECT_SENDER`, and the length rule.
- `SPEC_LEGEND` in `enqueue-once.test.ts`.
- `_money-fixtures.ts`: `plantFailingUpdate` and its seeds (wave 2).
- `checkQueuedOutboxRow` in `scripts/smoke.ts` (wave 2).
- Wave 3's `funnelClaimEmail` builder, and any locale it stores on `funnel_drafts`.

**Expected at T0, after wave 4:**
- `OUTBOX_KINDS` 34; the sweep closes at `checked === 34`;
- `SENDER_ALLOWLIST` 17, equal to the 17 names above;
- `NOT_YET_MOVED` empty;
- `a-kind-body` `kindsChecked` 15;
- the legend has 19 literal kinds, 15 account kinds, 0 staff kinds, and 15 transactional kinds.

A different merged number wins. Record the difference.

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `db/migration/deltas/V<N>__email_outbox_phase3_wave5.sql` (create) | the kind CHECK, 51 kinds | T1 |
| `apps/web/src/server/email-outbox/constants.ts`, `hooks.ts` | `OUTBOX_KINDS` 51, `OUTBOX_KIND_FACTS` (+1 literal, +16 staff), 17 `{}` | T1 |
| `apps/web/src/server/email-outbox/__tests__/_kind-harness.ts` | `subjectLiteral` | T1 |
| `…/__tests__/outbox-kind-sweep.test.ts`, `outbox-schema.test.ts`, `enqueue-once.test.ts`, `_kind-senders.ts` | lists, the legend, T2 m1's staff refusal row, scenarios | T1, T3–T7 |
| `apps/web/src/server/usecases/staff-alert.ts` (create) | `queueStaffAlert`, `StaffKind` | T2 |
| `apps/web/src/server/usecases/__tests__/staff-alert.test.ts` (create) | the writer's tests | T2 |
| `apps/web/src/app/api/funnel/remind/route.ts` and `__tests__/route.test.ts` (create) | §9 / F6 | T3 |
| `apps/web/src/lib/email.ts` | 17 senders become builders; delete `send`, `sendWithResult`; header comment | T3–T7 |
| `apps/web/src/server/usecases/billing-events.ts` | credit pack, size pack, clawback, reprice, staff dispute, connect, stuck | T4–T6 |
| `apps/web/src/server/usecases/registrations.ts`, `registration-approval.ts` | refund failed (`mode`) | T4 |
| `apps/web/src/server/usecases/stream-credits-checkout.ts`, `pass-credit.ts` | stream grant, reversal | T4 |
| `apps/web/src/lib/billing.ts`, `lib/relay-checkout.ts`, `lib/credits.ts` | rung, unknown competition, drift, earn grant | T4, T6 |
| `apps/web/src/server/usecases/ai-runs-admin.ts`, `extra-orgs.ts` | AI cost, allowance | T6 |
| `apps/web/src/server/usecases/__tests__/_money-fixtures.ts` | `plantFailingUpdate` accepts `"registration_groups"`; `staffRows(kind, refType)` | T4 |
| existing site suites (per-kind table) | repointed from sender mocks to rows | T4–T6 |
| `apps/web/src/lib/__tests__/*-alert-email.test.ts` (6 files) | call the builder, not the sender | T4–T6 |
| `apps/web/src/lib/__tests__/email-send-result.test.ts` | repointed to `checkSendable` + `deliver` | T7 |
| `…/__tests__/no-second-path.test.ts` | empty allowlist, `OUTBOX_SENDER` skip removed, `send`/`sendWithResult` absent | T7 |
| `scripts/smoke.ts`, `scripts/__tests__/smoke-select.test.ts` | the funnel reminder smoke | T8 |
| `apps/web/e2e/funnel.spec.ts`, `apps/web/e2e/payments-hardening.spec.ts`, `.github/workflows/e2e.yml` | e2e, plus `STAFF_ALERT_EMAIL` in the job env | T9 |

---

### Task 0: Preconditions and environment (no commit)

**Files:** none modified.

- [ ] **Step 1: Wave 4 has merged.** Run
  `cd /Users/ashokhein/github/seazn.club && git fetch origin && git log --oneline origin/main | grep -ai "outbox" | head -8`.
  Expected: merges for waves 2, 3 and 4. If one is missing, STOP.
- [ ] **Step 2: Worktree.** Run
  `git -C /Users/ashokhein/github/seazn.club worktree add .claude/worktrees/outbox-p3-w5 -b feat/email-outbox-phase3-w5 origin/main`,
  then `pnpm install --frozen-lockfile`. Link `.env.local` per the seazn-local-env skill.
- [ ] **Step 3: Pin `V<N>`** (Global Constraints).
- [ ] **Step 4: Reconcile 17.**
  - `grep -an "^export async function send" apps/web/src/lib/email.ts`: exactly the 17 names of the kind table, plus
    `sendWithResult`.
  - `grep -arn "sendWithResult(\|[^a-zA-Z]send(" apps/web/src --include=*.ts | grep -v __tests__`: only inside
    `lib/email.ts`.

  If either differs, STOP and report.
- [ ] **Step 5: Re-pin the consumed names** ("Interfaces consumed from waves 2–4") and the "Expected at T0" counts.
  Write the file:line of each into the report.
  - From wave 3, record two things: whether `funnel_drafts` gained a locale column (P-W5-17), and the name of the
    funnel claim builder.
  - Record wave 2's `checkQueuedOutboxRow` signature (T8 extends it).
- [ ] **Step 6: Re-pin all 19 staff sender sites and the 33 trigger points** by symbol. For each, record:
  - that it is not inside a `sql.begin` / `withTenant` callback. Open the enclosing function; a grep is not a read
    (P-W5-2);
  - whether a test stubs `STAFF_ALERT_EMAIL` for it.
- [ ] **Step 7: Pre-scan the mocks.** Run `grep -arln 'vi.mock("@/lib/email"' apps/web/src` and list the files whose factory
  does not spread `importOriginal`. Known so far: `lib/__tests__/relay-checkout.test.ts` (drift; T6 adds the spread). Any
  other such file that drives a wave-5 site gets the spread in that kind's commit.
- [ ] **Step 8: Re-pin the e2e job** that runs `payments-hardening.spec.ts` in `.github/workflows/e2e.yml` (P-W5-21).
- [ ] **Step 9: Env.** `$S up --label outbox-p3-w5`. Confirm `show data_directory` is this label's.

### Task 1: Vocabulary, the harness's literal subject, and T2 m1's staff refusal row

**Files:**
- Create `db/migration/deltas/V<N>__email_outbox_phase3_wave5.sql`, one statement in V472's shape (`:57-59`):
  `alter table email_outbox drop constraint email_outbox_kind_valid, add constraint email_outbox_kind_valid check (kind in (<51>))`.
- Modify:
  - `constants.ts`: `OUTBOX_KINDS` appends the 17 in spec table order: `funnel_reminder`,
    `staff_registration_refund_failed`, `staff_credit_pack_grant_failed`, `staff_size_pack_grant_failed`,
    `staff_stream_credit_grant_failed`, `staff_pass_credit_reversal_incomplete`, `staff_pass_rung_mismatch`,
    `staff_pass_unknown_competition`, `staff_stream_credit_clawback`, `staff_extra_org_reprice_failed`,
    `staff_dispute_alert`, `staff_connect_bank_changed`, `staff_stuck_events`, `staff_stream_pack_price_drift`,
    `staff_ai_run_cost`, `staff_earn_grant_volume`, `staff_extra_org_allowance`. `OUTBOX_KIND_FACTS` gains
    `funnel_reminder: { to: "literal", transactional: true }` and 16 `{ to: "staff", transactional: true }`.
  - `hooks.ts`: 17 `{}`.
  - `_kind-harness.ts`: `KindScenario.subjectKey` and `subjectVars` become optional, and `subjectLiteral?: string` is
    added. Before any scenario runs, `forEachOutboxKind` throws `outbox kind <k>: give subjectKey or subjectLiteral, exactly one`
    when both or neither are given. The expected subject is the literal when it is given, else `dictionarySubject(...)`.
- Test:
  - `outbox-schema.test.ts`: the kind literal (and the catalogue read).
  - `outbox-kind-sweep.test.ts`: `SPEC_KINDS` 51; `SPEC_FACTS` +17; the legend test.
  - `_kind-senders.ts`: `NOT_YET_MOVED` = the 17 kinds. `KIND_DIRECT_SENDER` gains 17 entries, each naming the sender
    of the kind table.
  - `enqueue-once.test.ts`: `SPEC_LEGEND` +17, and the refusal row.

**Interfaces:** `KindScenario` stays assignable for every existing scenario, so no existing scenario is edited.

- [ ] **Step 1: Write the failing tests.**
  - `outbox-schema.test.ts`: retitle to `the kinds are the spec's fifty-one, in the spec's wave order`. Add the typed
    17 and assert `SPEC_KINDS.length === 51` (spec Counts: "With `magic_link` and `chess_invite` that is 51").
  - `outbox-kind-sweep.test.ts`: retitle the legend test to
    `the legend has TWENTY literal kinds, FIFTEEN account kinds and SIXTEEN staff kinds; THIRTY-TWO are transactional`.
    The two numbers come from the spec legend: "the 19 N kinds", so 51 − 19 = 32. `by("staff")` equals the 16 staff
    kinds in table order.
  - Harness self-tests, beside `the subject must be the dictionary's…`:
    1. `a scenario's literal subject is judged against the row and the call`. A hand-made row whose subject is the
       literal passes. A different literal fails with `/subject/`.
    2. `a scenario that gives both subjectKey and subjectLiteral, or neither, fails by kind`.
  - `enqueue-once.test.ts` (T2 m1). Retitle the refusal test to
    `a kind not addressed to an account (literal or staff) with recipientUserId is refused by name before any statement, for EVERY such kind`.
    Iterate `to !== "account"`. The expected count is `(20 + 16) × 2 = 72`, typed with that comment. The legend test's
    `checked` becomes 51.
- [ ] **Step 2: Run red.** VERIFY the four test files → `t1`. Expected failures: the kind list, the legend, the two
  harness tests, and the refusal count of 72 (no staff kind exists yet).
- [ ] **Step 3: Implement** the migration, constants, facts, hooks and the harness change, then the env down/up.
- [ ] **Step 4: Run green.** VERIFY → `t1b`. Expected:
  - `failed: 0`;
  - the sweep still `checked: 34`, with all 17 new kinds in `NOT_YET_MOVED`;
  - the lists-agree test is green, because each new kind's sender is still in the allowlist.
- [ ] **Step 5: Mutations.**
  - In `insertQueued`, change the facts guard to `=== "literal"`: the refusal test fails on the staff rows.
  - In the migration, omit `staff_ai_run_cost` (env down/up around it): the schema test fails.
  - In the harness, ignore `subjectLiteral`: harness test 1 fails.
- [ ] **Step 6: TSC** (it catches a missing `KIND_HOOKS` key), **LINT**, then commit:
  `feat(email-outbox): wave-5 kinds in the vocabulary; the harness judges a literal subject; staff kinds refuse an account id`.

### Task 2: The staff alert writer

**Files:**
- Create `apps/web/src/server/usecases/staff-alert.ts` and `server/usecases/__tests__/staff-alert.test.ts`.

**Interfaces:**
- `export type StaffKind = Extract<OutboxKind, \`staff_${string}\`>;`
- `export async function queueStaffAlert(a: { kind: StaffKind; refType: string; id: string | null | undefined; suffix?: string; render: () => EmailContent | Promise<EmailContent> }): Promise<string | null>`.
  1. Read `process.env.STAFF_ALERT_EMAIL`. If it is unset or blank, return `null` before `render` runs and before any
     statement. This keeps the "cheap guards first" pattern the sites use today (`ai-runs-admin.ts:253-259`).
  2. In one `try`:
     - `const key = onceKey(a.kind, a.refType, a.id, a.suffix)`;
     - `const content = await a.render()`;
     - `return enqueueEmailOnce(sql, { kind: a.kind, refType: a.refType, refId: key, dedupeKey: key, orgId: null, to, transactional: true, expiresAt: expiryWithin(null), ...content })`.
  3. The catch (Q1) is `log.error({ err, kind: a.kind, refType: a.refType }, "staff alert could not be queued")` and
     returns `null`. It logs no address, no key and no content.
- It imports `sql` from `@/lib/db`, the three names from `@/server/email-outbox`, `type EmailContent` from `@/lib/email`
  and `log` from `@/server/logger`. It is a usecase, not a core file, so the core's pins and the "no render import"
  rule are untouched. T7 re-runs `no-import-cycle.test.ts`.

- [ ] **Step 1: Write the failing tests.** They use `stubOutboxEnv()` and mock only the transport. Each run gets its own
  `STAFF_ALERT_EMAIL` (`staff-<run>@x.test`) through `vi.stubEnv`.
  1. `unset: no row, no render, no statement`. The env is `""`, `render` is a `vi.fn`, and the result is `null`. There
     are 0 rows for the run's address and `render` was not called.
  2. `one alert: one queued staff row, no org, no account, transactional, for the worker`. Kind
     `staff_stuck_events`, ref type `stripe_event`, id `evt_<run>`, suffix `parked`. Expected row:
     - `ref_id` and `dedupe_key` both `evt_<run>:parked`;
     - `org_id` null, `recipient_user_id` null, `recipient` the env address;
     - `transactional` true, `queued` with `attempts` 0;
     - `expires_at` within 1 minute of `now + 24 h − 7 min`, typed from the spec;
     - 0 transport calls.
  3. `the same incident twice: one row, and the second call returns null`.
  4. `P-W5-1: two incidents of one kind and one id, different suffixes, both stay queued and neither is replaced`.
     Use `ch_<run>` with `partial:500`, then `short`. Expected: 2 rows, both `queued`, none `replaced`.
  5. `Q1: a render that throws, or a missing id, resolves null, logs the kind, and writes nothing`.
     - `render` throws: the result is `null` and `log.error` was called once with `kind`.
     - `id: undefined` (`onceKey` refuses): the result is `null`.
     - Neither log call's arguments contain the address. There are 0 rows.
- [ ] **Step 2: Run red** → `t2` (the module does not exist).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green** → `t2b` (`failed: 0`, 5 tests).
- [ ] **Step 5: Mutations.**
  - Drop the env gate: test 1 fails.
  - Use `refId: a.id ?? ""` in place of the key: test 4 fails (one row `replaced`).
  - Remove the try/catch: test 5 fails.
  - Call `render` before the gate: test 1 fails (`render` was called).
- [ ] **Step 6: TSC, LINT and commit.**
  `feat(staff-alerts): one writer for staff alerts — pooled, no org, once per incident, never superseded`.

### Task 3: `funnel_reminder` (§9, F6)

**Files:**
- Modify:
  - `apps/web/src/app/api/funnel/remind/route.ts` (`:18-50`);
  - `lib/email.ts`: delete `sendFunnelReminderEmail` (`:451-459`) and add `funnelReminderEmail`.
- Create `apps/web/src/app/api/funnel/remind/__tests__/route.test.ts`.
- Test:
  - the sweep: the scenario. Extend its `next/headers` mock so `headers()` also carries `x-cron-secret`, the value of a
    stubbed `CRON_SECRET`;
  - `_kind-senders.ts`: drop the kind from `NOT_YET_MOVED`, the sender from the allowlist, and null the map entry;
  - the scan.

**Interfaces:**
- The due select adds `expires_at`.
- Per draft:
  1. `const parsed = funnelPayloadSchema.safeParse(draft.payload)`.
  2. `const id = await sql.begin(async (tx) => { … })`. Inside it:
     - `const [won] = await tx\`update funnel_drafts set reminded_at = now() where id = ${draft.id} and reminded_at is null returning id\``;
     - if `!won || !parsed.success`, return `null`;
     - otherwise return `enqueueEmailOnce(tx, { kind: "funnel_reminder", refType: "funnel_draft", refId: draft.id, dedupeKey: onceKey("funnel_reminder", "funnel_draft", draft.id, "reminder"), orgId: null, to: draft.email, transactional: true, expiresAt: expiryWithin(new Date(draft.expires_at)), ...(await funnelReminderEmail({ competitionName, sport, link }, locale)) })`.
  3. `if (id) sent++`.
- The locale follows P-W5-17. There is no catch (D1), and no `dispatchNow` (W).
- The doc comment loses "Idempotent — reminded_at marks each draft" and states the claim.

- [ ] **Step 1: Write the failing tests** in `route.test.ts`.
  - Setup:
    - Mock only the transport.
    - Spy `enqueueEmailOnce` through `vi.mock("@/server/email-outbox", importOriginal)` (wave-2 pattern).
    - Spy `funnelReminderEmail` through `vi.mock("@/lib/email", importOriginal)`.
    - Stub `CRON_SECRET`. Mock `next/headers` with it.
    - Seed drafts with `createFunnelDraft(\`f-<run>@x.test\`, payload)`, then
      `update funnel_drafts set created_at = now() - interval '25 hours'`.
    - Every assertion filters rows by the run's address, because other tests' drafts may be due in the shared DB.
  - Tests:
    1. `a day-old draft queues one reminder for the worker and is stamped`. Expected:
       - one row: kind `funnel_reminder`, ref `funnel_draft / <id>`, `dedupe_key` `<id>:reminder`;
       - `recipient` the draft address, `recipient_user_id` null, `org_id` null, `transactional` true;
       - `queued` with `attempts` 0;
       - `expires_at <= draft.expires_at`;
       - subject `dictionarySubject(<P-W5-17 locale>, "funnelReminder.subject", { competitionName })`;
       - `reminded_at` is set, and the response `sent` is at least 1.
    2. `§9: with the transport failing, the draft is stamped, the row waits, and the worker retries it to sent`.
       - Transport 503. `bornAgo` + `runOutboxTick({ onlyIds })`: the row is `queued`, `attempts` 1,
         `last_error like 'http 503%'`, and `reminded_at` is set.
       - Set `next_attempt_at` in the past and the transport to `ok`, then tick: the row is `sent`, with no body.
    3. `F6: two runs at the same time queue one reminder`. `Promise.all` of two POSTs gives 1 row for the draft, and the
       enqueue spy saw exactly 1 call whose `refId` is the draft.
    4. `the once-key alone: a draft swept again after its stamp is cleared queues no second row`.
       `update … set reminded_at = null`, then POST: 1 row, and 2 spy calls for the draft.
    5. `a malformed payload is stamped and queues nothing`. Seed `payload = '{"bad":1}'` by SQL: `reminded_at` is set,
       0 rows.
    6. `an enqueue that throws leaves the draft unstamped, and the next run reminds it`. The spy rejects once. The POST
       rejects (or answers 500 through `handler`), `reminded_at` is null and there are 0 rows. The re-run gives 1 row.
    7. `another sport: a chess draft and a football draft each queue one reminder naming its own sport`. The builder
       spy was called with `sport: "chess"` and with `sport: "football"`, and there are 2 rows.
    8. `empty: a used draft, an expired draft and a 23-hour-old draft queue nothing`. 0 rows, and none of them is stamped.
- [ ] **Step 2: Sweep and scan.**
  - Sweep scenario `funnel_reminder`: the route POST over a day-old draft, the P-W5-17 locale,
    `funnelReminder.subject`, `{ competitionName }`, `worker`.
  - The lists: the kind leaves `NOT_YET_MOVED`, the sender leaves the allowlist (16 left), and the map entry is nulled.
- [ ] **Step 3: Run red** → `t3`. **Step 4: Implement.** **Step 5: Run green** → `t3b`. Expected: `failed: 0`, and
  the sweep `checked: 35`.
- [ ] **Step 6: Mutations.**
  - Drop `and reminded_at is null`: test 3 fails (2 spy calls).
  - Fresh once-key per call: test 4 fails (2 rows).
  - Move the enqueue after the `sql.begin` returns: test 6 fails (stamped, 0 rows).
  - `transactional: false`: the sweep's facts check fails.
- [ ] **Step 7: TSC, LINT and commit.**
  `fix(funnel): the reminder is claimed and queued in one transaction — a failed send is retried, two schedulers send one (F6)`.

### Task 4: Staff batch A — money not refunded, not granted, not reversed (7 kinds)

One implementer dispatch and one review for the batch. **One commit per kind**, in this order:
1. `staff_registration_refund_failed`
2. `staff_credit_pack_grant_failed`
3. `staff_size_pack_grant_failed`
4. `staff_stream_credit_grant_failed`
5. `staff_pass_credit_reversal_incomplete`
6. `staff_pass_rung_mismatch`
7. `staff_pass_unknown_competition`

**The per-kind shape** (every kind, every step):
1. **Builder.** In `lib/email.ts`, delete the sender and its `to`, and add the builder (Builder convention). Move the
   sender's rendering unit test (`lib/__tests__/*-alert-email.test.ts`, where one exists) to the builder: it calls the
   builder and asserts the same subject, html and text it asserted through `fetch` before.
2. **Alert function.** Create it, or convert it, as named in the kind table. Its body is
   `await queueStaffAlert({ kind, refType, id, suffix, render: () => <builder>(opts) })`. Any existing `try/catch` and
   env read around the sender is deleted, because the writer owns both. Any existing gate (a threshold, a refusal
   row) stays.
3. **Call sites.** Every `void send…(...).catch(() => {})` and its `const alertTo = …; if (alertTo)` becomes
   `await alert…(...)`. A site that kept `alertTo` for a counter (`sweepStuckEvents`, `:1672`) keeps reading the env
   for the counter only.
4. **Site test.** Repoint the kind's site suites from the sender mock to rows read with `staffRows(kind, refType)`
   (`_money-fixtures.ts`, added in this task's first commit:
   `select ref_id, dedupe_key, status, recipient, subject from email_outbox where kind = $1 and ref_type = $2`). A
   suite's `vi.mock("@/lib/email")` override of the deleted sender is removed.
5. **Sweep, lists, scan.** Add the sweep scenario (kind table: "Sweep producer", `firstAttempt: "worker"`,
   `recipient` = a run-unique `STAFF_ALERT_EMAIL` stubbed in `run`). The kind leaves `NOT_YET_MOVED`, its sender leaves
   the allowlist, and its map entry is nulled.
6. **VERIFY** the kind's site suites, its builder test, the sweep, `_kind-senders`-dependent tests and the scan → `t4.<n>`.
   Expected: `failed: 0`, the sweep `checked` up by 1, and the allowlist down by 1.
7. **Mutation:** a fresh once-key per call (append `randomUUID()` to the suffix). The kind's "second call" test fails.
8. **TSC, LINT, commit:** `feat(staff-alerts): <kind> through the outbox, once per <incident>`.

**Per-kind tests** (beyond the shape's repointed assertions). Each "row" assertion checks `ref_id`/`dedupe_key` against
the kind table's key, built from the test's own ids, and `status = 'queued'`.

- **`staff_registration_refund_failed`.**
  - Interface: `maybeAlertRegistrationRefundFailed(opts & { mode: "late" | "duplicate" | "auto" | "auto_pool_deadline" | "reject" })`.
    Each of the 4 sites passes the mode its audit already writes.
  - Tests:
    1. `a failed withdraw refund queues one staff alert keyed by registration, mode and amount`.
       `withdrawRegistrationPublic` on a paid stripe entry; `refunds.create` rejects. Key
       `<regId>:auto:<remaining>`. The subject is the literal with `money(remaining, currency)` as the sender formats it
       today (`lib/email.ts:1570`).
    2. `a replayed late-payment refund that fails again pages once`. `confirmPaidRegistration` reached twice through
       the existing `registrations.test.ts` rig, with the refund rejecting both times: 1 row, `<regId>:late:<amount>`.
    3. **R2 (P-W5-24)**: `an alert after the refund's record transaction rolled back survives`.
       - Use `plantFailingUpdate("registration_groups", groupId)`. Extend its table union by this one name.
       - `refunds.create` resolves, and the record `sql.begin` fails.
       - Expected: 1 `staff_registration_refund_failed` row (`queued`), 0 `refund_issued` rows for the registration,
         and `refunded_cents` unchanged.
       - Record the routed finding (the page's wording) in the report.
  - Mutation 2: call `maybeAlertRegistrationRefundFailed` inside the record `sql.begin`, before the failing statement,
    with a `tx`-handled `queueStaffAlert`. Test 3 fails (the alert is rolled back).
  - The existing never-throws test in `registration-refund-alert.test.ts` is repointed. It drives a render throw (through
    an `importOriginal` spy on the builder), not a mail failure.
- **`staff_credit_pack_grant_failed`.** The sweep producer is `alertCreditPackGrantFailed`.
  1. `a paid credit-pack session with no snapshot and no pack queues one alert`.
     `processStripeEvent(checkout.session.completed)` with `metadata { kind: "credit_pack", org_id, pack_key: "nope" }`
     and `payment_status: "paid"`. Key `cs_<run>`, ref type `checkout_session`.
  2. `the same event processed twice pages once` (`runEvent`, then clear `processed_at` and age the lease, as in wave-2
     T10): 1 row.
  3. `a refunded pack with no ledger row pages under the charge`. This is the `credit-pack-refund.test.ts` rig. Ref type
     `charge`, key `ch_<run>`.
- **`staff_size_pack_grant_failed`.**
  1. `a paid size-pack session with no usable snapshot and no catalog entry queues one alert` (`size-pack-addon.test.ts`
     rig).
  2. `a redelivered session pages once`.
- **`staff_stream_credit_grant_failed`.**
  1. `the webhook's session with no snapshot and no pack queues one alert` (`stream-credits-webhook.test.ts`).
  2. `the org-mismatch refusal pages once across two deliveries`.
  3. `the return-page reconcile never pages` (`alertStaff: false`, `stream-credits-reconcile.test.ts`): 0 rows.
- **`staff_pass_credit_reversal_incomplete`.**
  - Interface: `alertPassCreditReversalIncomplete(a: { intent: string; passKey: PassKey | null; redemption: { org_id: string; competition_id: string; amount_minor: number; currency: string }; reverseAmount: number; unsafe: boolean }): Promise<string | null>`.
    It does the org and competition name reads inside `render`.
  - Tests:
    1. `an undetermined reversal queues one alert under the intent` (the `pass-credit-refund-reversal.test.ts` rig).
    2. `a redelivered refund after the reversal pages nothing more`. The transition already returns nothing (`:713`):
       1 row.
- **`staff_pass_rung_mismatch`.**
  1. `a refused mint queues one alert under the session` (`pass-checkout-plan-gate.test.ts`).
  2. `the webhook and the return page for one session page once`. The refusal row and the key are each killed alone:
     - mutation "alert on every call" (drop `inserted || writeFailed`): still 1 row, because the key holds;
     - mutation "fresh key": still 1 row, because the refusal row holds.

     Record both as a belt equivalent under every reachable input. Kill the key alone with a third call made with
     `writeFailed` forced (the existing seam in that suite): 1 row.
- **`staff_pass_unknown_competition`.** Interface:
  `alertPassUnknownCompetition(a: { sessionId: string; orgId: string; competitionId: string; passKey: PassKey; paymentIntent: string | null; source: "webhook" | "reconcile" }): Promise<string | null>`.
  1. `a paid pass for a competition not in this database pages once` (`billing-pass-unknown-competition.test.ts`).
  2. `the webhook and then reconcile-on-return for the same session page once` (the P-W5-12 new behaviour): 1 row,
     `source` in its body is the webhook's.

- [ ] **Step 1–8 per kind**, in order. The batch closes with the sweep at `checked: 42` and the allowlist at 9.
- [ ] **Batch review.** The reviewer checks:
  - every site in the kind table still reaches its alert function (open each enclosing function);
  - no `STAFF_ALERT_EMAIL` read is left outside `staff-alert.ts`, except the counters
    (`grep -arn STAFF_ALERT_EMAIL apps/web/src --include=*.ts | grep -v __tests__`);
  - no alert runs inside a transaction callback.

### Task 5: Staff batch B — money adjustments, disputes and payouts (4 kinds)

Same shape as T4. One dispatch, one review, one commit per kind, in this order:
1. `staff_stream_credit_clawback`
2. `staff_extra_org_reprice_failed`
3. `staff_dispute_alert`
4. `staff_connect_bank_changed`

- **`staff_stream_credit_clawback`.**
  - Interface: `export async function alertStreamClawback(a: { shape: "partial" | "short" | "ungranted" | "lost"; refType: "charge" | "dispute"; refId: string; amountRefunded?: number; orgId: string; purchased?: number; clawedBack?: number; reason: string }): Promise<string | null>`.
    The suffix is `partial:<amountRefunded>`, `short`, `ungranted` or `lost` (P-W5-9). The four sites await it.
  - Tests (`stream-credits-clawback.test.ts`):
    1. `a partial refund pages once under the charge` (`<ch>:partial:<amount_refunded>`).
    2. `a redelivered partial refund pages nothing more`.
    3. `a partial and then a full short refund of one charge are two alerts, and neither replaces the other` (Review
       Focus 1).
    4. `a lost dispute's short claw-back pages under the dispute` (`<dp>:lost`, ref type `dispute`).
- **`staff_extra_org_reprice_failed`.**
  - Interface: `maybeAlertOrgRepriceFailed(opts)` is unchanged for its callers. The key is P-W5-4, with the UTC day
    from `new Date().toISOString().slice(0, 10)` and the suffix `<itemId ?? "plan">:<day>`.
  - Tests (`org-addon-price-sweep.test.ts`):
    1. `a stale rider pages once`.
    2. `the same day's second pass pages nothing more` (Review Focus 2).
    3. `the next day's pass pages again (Q2)`. Use `vi.setSystemTime` +1 day: 2 rows.
    4. `two stale riders in one pass are two alerts` (P-W5-1).
  - The `alerted` counter stays as it is (it counts attempts). If Q2 is ruled "spec key", tests 3 and 4's day part is
    dropped and test 3 asserts 1 row.
- **`staff_dispute_alert`.**
  - Interface: `export async function notifyStaffDispute(kind, orgId, dispute, phase)`. The signature is unchanged; it
    is exported. The breadcrumb stays. The email is
    `queueStaffAlert({ kind: "staff_dispute_alert", refType: "dispute", id: dispute.id, suffix: phase, render: () => staffDisputeAlertEmail({ kind, orgName, phase, status, amountCents, currency, disputeId }, "en") })`.
  - Tests (`platform-dispute.test.ts`):
    1. `a platform dispute created pages once, in English, from the dictionary`. The subject is
       `dictionarySubject("en", "staffDisputeAlert.subject", { orgName, kind: <en emails.json label for "subscription"> })`.
    2. `a redelivered created pages nothing more`.
    3. `created then closed are two alerts`.
    4. `a dispute on a charge that is not the platform's pages nothing` (the registration and sponsor branches return
       first): 0 rows.
  - Sweep: `subjectKey: "staffDisputeAlert.subject"`, `locale: "en"`.
- **`staff_connect_bank_changed`.** Interface:
  `alertConnectBankRemoved(a: { eventId: string; orgId: string; orgName: string; accountId: string; detail: string }): Promise<string | null>`.
  Tests (`billing-events-payout-health.test.ts`):
  1. `a deleted external account pages once under the event`.
  2. `the same event redelivered pages nothing more`.
  3. `an updated external account pages nothing` (0 rows; the existing guard at `:2489`).

- [ ] **Steps 1–8 per kind.** The batch closes with the sweep at `checked: 46` and the allowlist at 5.
- [ ] **Batch review**, as in T4.

### Task 6: Staff batch C — ops alerts (5 kinds)

Same shape. One commit per kind, in this order:
1. `staff_stuck_events`
2. `staff_stream_pack_price_drift`
3. `staff_ai_run_cost`
4. `staff_earn_grant_volume`
5. `staff_extra_org_allowance`

- **`staff_stuck_events`** (P-W5-8).
  - The park is `update billing_events set replay_attempts = 4 where id = ${row.id} and replay_attempts = 3 returning id`.
    Alert, and count `alerted++`, only when it returns a row.
  - Tests (`billing-events-sweep.test.ts`):
    1. `a third-attempt row is parked and pages once`.
    2. `two overlapping sweeps park and page once`. `Promise.all` of two `sweepStuckEvents()`: 1 row, and `alerted`
       sums to 1.
  - Mutation 2: drop `and replay_attempts = 3`. Test 2's `alerted` sum fails; the key still holds the row count.
- **`staff_stream_pack_price_drift`** (P-W5-5).
  - `alertStreamPackPriceDrift(err): Promise<void>` is exported and awaited before `throw err` at `:96`. The `Set` is
    keyed `<priceId>:<UTC day>`.
  - Tests (`relay-checkout.test.ts`; its mock gains `importOriginal`):
    1. `a drifted price refuses the checkout and pages once`.
    2. `a second refused checkout the same day pages nothing more` (after clearing the `Set` through a test export, so
       the key alone is witnessed).
- **`staff_ai_run_cost`** (P-W5-6). Tests (`ai-run-cost-alert.test.ts`):
  1. `an expensive run pages once, with a fresh ref`.
  2. `two expensive runs are two alerts`.
  3. `unset: the median is never read` (this test exists; repoint it).
- **`staff_earn_grant_volume`** (P-W5-15). Tests (`earn-grant-volume-alert.test.ts`). Each first deletes
  `email_outbox` rows of this kind with today's key.
  1. `a day over the threshold pages once`.
  2. `the cron's same-day retry pages nothing more`.
- **`staff_extra_org_allowance`** (P-W5-16). Tests (`extra-org-addon.test.ts`):
  1. `a purchase that crosses the threshold pages once`.
  2. `the same count again pages nothing more`.
  3. `a purchase below the threshold pages nothing`.

- [ ] **Steps 1–8 per kind.** The batch closes with the sweep at `checked: 51`, the allowlist at 0 and `NOT_YET_MOVED`
  empty.
- [ ] **Batch review**, as in T4, plus: `grep -an "send(" apps/web/src/lib/email.ts` shows only the private `send` and
  `sendWithResult` definitions, with no caller left.

### Task 7: Delete `send()` and `sendWithResult`; close the lists; the phase-4 obligations

**Files:**
- `lib/email.ts`:
  - delete `sendWithResult` (`:273-277`) and `send` (`:280-282`);
  - rewrite the "Core send — never throws" header (`:107-118`) to say that `checkSendable` and `deliver` are the two
    halves only the outbox calls (`attempt.ts`, `transport.ts`), and that every email is queued through
    `enqueueEmail*`;
  - keep `SendResult`, because `classify.ts` imports the type.
- `lib/__tests__/email-send-result.test.ts`: repoint (P-W5-23).
  - Every wire test that called `sendWithResult(msg)` calls `deliver(msg, "re_test")`.
  - Every gate test calls `checkSendable(...)`.
  - Delete the tests of the boolean `send()` (`:477-` "the two routes into send()"). Retitle the header.
- `_kind-senders.ts`:
  - `SENDER_ALLOWLIST = []`;
  - `NOT_YET_MOVED = []`;
  - every `KIND_DIRECT_SENDER` entry is `null`;
  - the header comment states the end state;
  - the length rule asserts 0, "the spec's 49 less 49".
- `no-second-path.test.ts`:
  - delete `OUTBOX_SENDER` and its filter (`:63`, `:70`);
  - in the matcher self-test (`:74-89`), `export async function sendWithResult` is now expected AMONG the found
    senders;
  - add one test (below).
- `outbox-kind-sweep.test.ts`: the "every kind is swept" test asserts `checked === 51`, typed from the spec's count.

- [ ] **Step 1: Write the failing tests.**
  - `no-second-path.test.ts`:
    `after wave 5 lib/email.ts sends nothing itself: no send* export, no private send(), no sendWithResult`. It
    asserts all of the following:
    - `senderExports(read("lib/email.ts"))` is `[]`;
    - the source matches neither `/\bfunction\s+send\s*\(/` nor `/\bsendWithResult\b/`;
    - the source still contains `export async function deliver` and `export async function checkSendable` (the
      positive pair).
  - The repointed `email-send-result.test.ts` still imports `deliver` and `checkSendable` from `../email`. The scan's
    exemption test (`:751`) stays green.
- [ ] **Step 2: Run red** → `t7`. The new scan test fails while `send` exists.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green.** VERIFY these files → `t7b`:
  - `no-second-path`, `no-import-cycle`, `outbox-kind-sweep`, `outbox-schema`, `enqueue-once`, `a-kind-body`;
  - `lib/__tests__/email-send-result.test.ts`;
  - every file T1–T6 created or modified.

  Expected: `failed: 0`, sweep 51, allowlist 0. Paste `total`, `passed`, `failed` and `EXIT`. Then TSC.
- [ ] **Step 5: Phase-4 obligations (read, then record in the report).**
  1. *No send path bypasses the outbox.* Point to the four facts that prove it: the new scan test; section 2's import
     pins (only `attempt.ts` and `transport.ts` import the gated names); section 4 (one host holder, no SDK); and
     `SENDER_ALLOWLIST` empty.
  2. *Dispatch, worker and webhook keep no app-render dependency.* Show three things:
     - Every new `KIND_HOOKS` entry is `{}`.
     - Every wave-5 body renders in its producer before `enqueueEmail*`.
     - `staff-alert.ts` is a usecase, and the core imports no usecase except the pinned hooks. `no-import-cycle` is
       green.
     - `grep -an "^import" apps/web/src/server/email-outbox/*.ts` shows no import from `lib/email-templates` and no
       render builder.
- [ ] **Step 6: Mutations.**
  - Re-add `async function send(o) { return (await deliver(o, "")).ok; }` to `lib/email.ts`: the new scan test fails.
  - Re-add `export async function sendWithResult…`: the allowlist test fails, now that the skip is gone.
- [ ] **Step 7: LINT and commit.**
  `feat(email): delete send() and sendWithResult — the outbox is the only way an email leaves; allowlist empty, sweep 51`.

### Task 8: Smoke — the funnel reminder through the cron route

**Files:** `scripts/smoke.ts` and `scripts/__tests__/smoke-select.test.ts`.

**Interfaces:**
- `checkQueuedOutboxRow(kind, refType, refId, opts?: { account?: boolean })` (wave 2). The new option defaults to
  `true`, which is wave 2's check. With `account: false`, the third check reads
  `<kind>: addressed to a literal address (no recipient_user_id)`.
- `funnelReminderSuite`:
  - It skips with a passing check line when `CRON_SECRET` is unset, as p72 does (`:1834-1870`).
  - POST `/api/funnel/start` with `delivered+funnel_remind_<tag>@resend.dev`.
  - Read the draft id through `smokeDb()` by email, and set `created_at = now() - interval '25 hours'`.
  - POST `/api/funnel/remind` with `x-cron-secret`. Expect 200 and `sent >= 1`.
  - `checkQueuedOutboxRow("funnel_reminder", "funnel_draft", draftId, { account: false })`.
  - POST again: 200, and still one row (a check line).
  - In `finally`, delete the draft and its outbox row (org null, so no org teardown reaches it).
- Register it in `main`, after `funnelSuite()` (`:947`), and append `funnelReminder` to `SELECTABLE_SUITES` and to
  `KNOWN`.

- [ ] **Step 1:** Append to `KNOWN`. Run the selector test red (the wave-2 command, path `outbox-p3-w5`).
- [ ] **Step 2: Implement.** **Step 3:** The selector test goes green. Typecheck `scripts/` with the repo's command.
- [ ] **Step 4:** Smoke runs on the PR's CI smoke job, which sets `CRON_SECRET` (`ci.yml:1519`). The controller pastes
  the `funnel reminder` check lines.
- [ ] **Step 5: Commit.** `test(smoke): a day-old funnel draft gets one queued reminder from the cron route, a second run none`.

### Task 9: e2e — the funnel reminder and the staff dispute alert (CI dispatch only)

**Files:**
- `apps/web/e2e/funnel.spec.ts`
- `apps/web/e2e/payments-hardening.spec.ts` (the T7 platform-dispute block, `:736-`)
- `.github/workflows/e2e.yml`: the job pinned at T0 Step 8.

**Interfaces:**
- The expected subjects are read from `src/dictionaries/en/emails.json` by import, never typed.
- There is no `E2E_PROD_TARGET` skip.

- [ ] **Step 1: e2e.yml.** Add `STAFF_ALERT_EMAIL: staff-alerts@e2e.invalid` to the pinned job's `env`, with a
  three-line comment: P-W5-21; `.invalid` never resolves; CI has no Resend key.
- [ ] **Step 2: Tests.**
  - `funnel.spec.ts`: `a day-old draft gets one queued reminder from the cron route, and a second run adds none`.
    1. POST `/api/funnel/start`.
    2. `withDb`: read the draft and age it 25 h.
    3. `request.post("/api/funnel/remind", { headers: { "x-cron-secret": process.env.CRON_SECRET } })` → 200.
    4. `withDb`: one `funnel_reminder` row for `funnel_draft/<id>`: `queued`, `transactional` true,
       `recipient_user_id` null, with the `en` subject (or the P-W5-17 locale).
    5. Post again: still one row.
  - `payments-hardening.spec.ts`, inside T7's `created` test: assert one `staff_dispute_alert` row with ref
    `dispute / <dp>:created`, `recipient` = `process.env.STAFF_ALERT_EMAIL`, `queued`, and the `en` dictionary subject.
    In its replay leg (the identical re-post), still one row. If `process.env.STAFF_ALERT_EMAIL` is unset,
    `expect(..., "P-W5-21: the e2e job must set STAFF_ALERT_EMAIL").toBeTruthy()`. It fails; it never skips.
- [ ] **Step 3: Collect, never run.** Run
  `cd <worktree>/apps/web && npx playwright test e2e/funnel.spec.ts e2e/payments-hardening.spec.ts --list; echo EXIT=$?`.
  Expected: `EXIT=0`, with the new titles listed. Then TSC.
- [ ] **Step 4: Commit.** `test(e2e): funnel reminder via the cron route; a platform dispute pages staff once`.
- [ ] **Step 5 (controller).** Dispatch `gh workflow run e2e.yml --ref feat/email-outbox-phase3-w5 -f pr=<n>`.
  `payments-hardening.spec.ts` is serial, so treat a red count as a floor and re-run after each fix. Cover both whole
  files, never a `-g` slice.

### PR checklist (controller)

- Rebase onto `origin/main`; never merge main in. Re-pin `V<N>`.
- The scoped VERIFY (T7 Step 4's set) is green; paste the counts.
- Smoke: the PR's smoke job shows the funnel reminder lines.
- e2e is dispatched (T9 Step 5).
- Readiness log clean (G-5).
- Push, open the PR, and hand back. Do not poll CI. Merging needs the owner's explicit go after their stg walk.

## Conflict scan (pairs of tasks sharing files or interfaces)

| Pair | Shared | Resolution |
|---|---|---|
| T1 → T2…T7 | `constants.ts` kinds and `StaffKind`; `_kind-senders.ts` and the sweep (each kind removes its entry) | Sequential. |
| T2 → T4, T5, T6 | interface `queueStaffAlert` | T2 first. |
| T3…T7, every pair | `lib/email.ts` (one sender out, one builder in); the sweep; `_kind-senders.ts` (allowlist 16 → 0, a running count) | Sequential. The hunks are disjoint, but the counts run. |
| T4 – T5 – T6 | `billing-events.ts` (T4: credit pack, size pack; T5: clawback, reprice, dispute, connect; T6: stuck) | Sequential batches. |
| T4 – T5 | `stream-credits-clawback.test.ts` and `billing-pass-stream-credits.test.ts` (T5 clawback and T5 dispute both repoint them) | Same batch, consecutive commits. |
| T4 – T6 | `lib/billing.ts` (T4) vs `lib/credits.ts`, `lib/relay-checkout.ts` (T6) | Disjoint. |
| T4 → T5…T6 | `_money-fixtures.ts` `staffRows` (T4 adds it), `plantFailingUpdate` union | T4 first. |
| T6 → T7 | T7 deletes `send()`, which is dead only after T6 | T7 after T6. |
| T8 / T9 | `scripts/` vs `e2e/` and `e2e.yml` | In parallel after T7. |
| Peer branches | W2d (migration numbers); any session editing `billing-events.ts`, `registrations.ts` or `e2e.yml` | Run `git log origin/main --oneline -- <file>` at T0 and before the PR. |

**Execution order:** T0, T1, T2, T3, T4, T5, T6, T7, then T8 ∥ T9.

## Owner questions

1. **Q1: may a staff alert that cannot be queued be logged and dropped, rather than failing the action it reports?**
   (P-W5-3)
   - **Recommendation:** yes, for the 16 staff alerts only. The writer logs the kind and goes on. Every site is
     documented "never throws" today because the alert sits on the failure path of money that already moved. Under
     D1, a misconfigured key would turn a "refund failed" page into a withdrawal that 500s after it committed, or a
     webhook that retries for three days.
   - Owner value: a staff alert can never make a player's or organiser's action fail.
   - Cost: under a misconfigured key (the readiness log already shouts) a page is lost. A `log.error` line, which
     Sentry catches, carries the kind.
   - If declined, the writer rethrows. Each never-throws helper keeps its own catch, and the bare `void` sites let a
     refusal reach the webhook.
2. **Q2: should a money fault that persists re-alert once a day?** This is a stale rider price (P-W5-4) or a drifted
   pack price (P-W5-5).
   - **Recommendation:** yes, once per rider (or price) per UTC day. The sweep's own design says it "should nag until
     someone acts", and while a price drifts every checkout of that pack is refused.
   - Owner value: a money fault never goes quiet after one email. A cron retry or a replay the same day still sends
     nothing new.
   - Cost: up to one email per affected rider per day, capped at 10 per pass, as today.
   - The spec's key (once per subscription + price) would send one email per 90 days.
3. **Q3 (only if wave 3 stored no locale on the funnel draft): should the draft remember the visitor's language?**
   (P-W5-17)
   - **Recommendation:** yes. One `locale` column on `funnel_drafts`, set at `/start` from the locale cookie, used by
     the claim and the reminder. The `funnelReminder.*` copy already exists in four languages.
   - Owner value: a Dutch visitor's only reminder arrives in Dutch.
   - Cost: one column, one line in the start route, and one test. It would ride in T3, with the migration in T1.
   - If declined, the reminder stays English, as today.

The controller rules on P-W5-1 to P-W5-26, or puts them to the owner, before T2.

## Rare cases — recorded, not built

1. The KEK is misconfigured: a staff alert is logged and dropped (Q1), and the funnel run fails and retries.
2. A crash between a committed fact and its pooled alert loses the page; the `log.error` line remains. This applies to
   the reversal, the stuck-event park and the refund-failed catch.
3. A funnel draft is claimed in the ~1.5 minutes between its reminder's enqueue and the send: the reminder carries a
   spent link.
4. A provider outage longer than the 24 h bound: the reminder or alert ends `expired`.
5. `STAFF_ALERT_EMAIL` changes while alerts wait: queued rows go to the old address (L, never resolved).
6. A staff member deletes the account whose address is `STAFF_ALERT_EMAIL`: staff rows are untouched (D5) and still
   sent.
7. A Stripe object with no id: `onceKey` refuses inside the writer, and the alert is logged and dropped.
8. An extra-org count falls and re-rises to the same value within 90 days: the second crossing is not re-paged
   (P-W5-16).
9. The same failed refund amount fails again after staff partly fixed something else on the entry: it is not re-paged
   (P-W5-7).
10. Two funnel schedulers both block on one draft's row lock under heavy load: the second waits, then matches nothing
    (correct, just slow).

## Phase 4 still owes (hand-off)

- **The `@/lib/email` split.** Move `checkSendable` and `deliver` out of the rendering module (phase-4 note). P-W5-22 adds
  three more things to move with them, so the Email Service carries no rendering code:
  - `isSuppressed` (used by the gate) and `suppress` (imported by `app/api/webhooks/resend/route.ts:3`);
  - the `SendOptions` / `DeliverResult` / `SendBlocked` / `SendResult` types (`classify.ts` imports `SendResult`);
  - `from()` and `replyTo()`.
- **`deliver`'s `logDetail` default.** The default-`true` branch (`lib/email.ts:207-212`) logs the recipient and Resend's
  raw response. It has no caller once `sendWithResult` is gone. The split drops it, so the service only has the R8
  logging.
- **Templates in the service (option B).** Each kind's facts snapshot and its contract test. This wave's builders are
  the templates that move.
- The prod Resend webhook events (`delivered`, `delivery_delayed`, `suppressed`) on the owner's go (HANDOFF).

## Self-review

1. **Spec coverage.**
   - The 17 kinds map to tasks: funnel T3; batch A (7) T4; batch B (4) T5; batch C (5) T6.
   - The wave-5 test row:
     - sweep of 17 → T3–T6, closed at 51 in T7;
     - unset staff address → T2 test 1;
     - R2 after a rollback → T4 refund test 3;
     - allowlist empty → T7;
     - e2e funnel and one staff path → T9;
     - smoke funnel → T8;
     - §9 regression → T3 test 2;
     - F6 → T3 test 3.
   - Mutation rows: the funnel claim → T3; R2 → T4; the scan → T7.
   - §9 bullets: the transaction (T3), malformed (test 5), stays dead (`{}` hook, T1), expiry (T3 Interfaces).
   - §10 bullets: on the outbox (T4–T6), worker-only (no `dispatchNow`), transactional (T1 facts), pool and no org
     (T2), once-key (kind table), 15 inline plus 1 dictionary (builder convention, T5), the unset gate (T2), money
     first (batch order).
   - "Deletes `send()` and `sendWithResult`" → T7.
2. **Brief items.**
   - T2 m1's staff refusal row → T1.
   - The staff dispute alert at `billing-events.ts:2267` → T5.
   - Count reconciliation → its own section, plus T0 Step 4.
   - Phase-4 obligations and what is owed → T7 Step 5 and "Phase 4 still owes".
   - Changed while queued → the kind table column.
3. **Type consistency.** These are spelled the same everywhere they appear:
   - `queueStaffAlert({ kind, refType, id, suffix?, render })`;
   - `StaffKind`;
   - `maybeAlertRegistrationRefundFailed(opts & { mode })`;
   - `alertStreamClawback({ shape, refType, refId, … })`;
   - `notifyStaffDispute(kind, orgId, dispute, phase)`;
   - `subjectLiteral`;
   - `checkQueuedOutboxRow(kind, refType, refId, { account })`.
4. **Review Focus.** Each of the five has its tests named in its owning task.
5. **Proportion.** Only the migration and the funnel claim's SQL are given as one-liners. The rest is signatures, test
   names and expected values.
