# Email outbox phase 3, wave 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the ten organiser and sponsor money emails onto the outbox: the two registration dispute notices, the six
sponsor emails, the pass-revoked notice and the trial-ending warning. This closes F7: a replayed or re-claimed Stripe
webhook no longer re-sends its emails.

**Architecture:** One migration widens the kind CHECK from 7 to 17 kinds. Each kind swaps its `send*` for a render
builder plus an enqueue, in the same commit (the cutover rule). The organiser-addressed (A) kinds carry the owner's user
id from one new leaf lookup. The sponsor (L) kinds carry the contact's literal address. Every webhook-path row is
written on the transaction that commits its transition, with a once-key that embeds a Stripe or order id. So a
redelivered event, a re-claimed lease or a staff replay writes no second row. Two money paths do not fit R1/D1 as
written: the invoice is minted after its order commits, and the sponsor refund follows money that already moved. They
follow the precedents the owner accepted in wave 1's P4 (P-W2-1, P-W2-2).

**Tech Stack:** Next (repo fork, see `AGENTS.md`), TypeScript, postgres.js (`sql.begin`, `tx.savepoint`), Postgres 17
with Flyway deltas, vitest (node environment), Playwright on CI only, Stripe (mocked in vitest, sandbox in the
walkthrough).

**Spec:** `docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md` (owner-approved 2026-10-25), the wave-2 rows
of its kind table (inventory #24–#32, #48) and the wave-2 row of its test table. Executors also read:
- the wave-1 plan, `docs/superpowers/plans/2026-10-25-email-outbox-phase3-wave1.md`, for Global Constraints, P1–P11 and
  the Task 7–12 shapes this plan reuses;
- the wave-1 ledger, `.superpowers/sdd/2026-10-25-email-outbox-phase3-wave1/progress.md`, for the rulings carried
  below.

## Global Constraints

Everything in the wave-1 plan's Global Constraints (its lines 25–102) applies, with the path, branch and label
replaced as below. The lines that bite in this wave are restated.

- **Worktree.** `/Users/ashokhein/github/seazn.club/.claude/worktrees/outbox-p3-w2`, branch
  `feat/email-outbox-phase3-w2`, cut from `origin/main` after wave 1 merges (T0). Prefix every command with
  `cd <that path> &&` or `cd <that path>/apps/web &&`. Never check anything out in the main checkout. Never use
  `git stash` in a worktree.
- **Migration number.** Main's max today is `V471` (wave 1 holds an unmerged `V472`, and so does W2d). This wave takes
  main's max + 1 at the time it is committed, written below as `V<N>`. Re-pin it right before committing T1 and again
  right before opening the PR:
  `git fetch origin && git ls-tree --name-only origin/main db/migration/deltas/ | sort -V | tail -1`. If the number is
  taken, `git mv` the file and amend while the branch is unmerged.
- **R1–R6, D1, D2, D4, D5** are as in the spec. In particular:
  - **R1.** The row is written on the transaction that commits the fact.
  - **R4.** Never catch an enqueue error inside a transaction and carry on. Use a savepoint.
  - **R5.** `dispatchNow` only after commit.
  - **R6.** Enqueue only on the transition.
  - **D1.** A refused enqueue fails the action.
  - **D4.** The locale is the explicit pick, then the linked account's (through an existing link only), then the org
    default, then `en`.
- **No pooled `sql` call inside `withTenant`** (#996).
- **The cutover rule.** A kind's `send*` is deleted in the same commit that adds its enqueue.
- **Each kind keeps its sender's current `transactional` flag.** The nine non-trial senders pass none (`false`).
  `sendTrialEndingEmail` passes `true` (`lib/email.ts:1654`).
- **First attempt (spec column "First").** W kinds get no `dispatchNow`; the worker takes them after the 30 s window.
  R kinds get `deferred(() => dispatchNow([id]))` after commit (`lib/deferred.ts`).
- **Expiry.** Every wave-2 kind uses `expiryWithin(null)`, the bound (spec §12: "Every other kind uses the bound").
  The bound is `RESEND_IDEMPOTENCY_TTL_MS` (24 h) less a margin (`constants.ts:96`, `:104`). That is earlier than the
  sponsor Checkout session's 24 h default expiry (no `expires_at` is set at `sponsors.ts:490`). It is also earlier than
  `trial_end`, because `trial_will_end` fires 3 days ahead. So §12 needs no exception here.
- **Copy.** Every changed user-facing string goes into all four `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`.
  Then run `pnpm i18n:gen-keys && pnpm i18n:check`. Log lines stay English.
- **Test rules.** `docs/superpowers/TEST-STRATEGY.md` and `docs/superpowers/RULES.md` (four test types) are binding:
  - Test the sequence: a second call, an empty input, after a withdrawal or void.
  - "Another sport" is N/A, because these emails do not vary by sport.
  - Anti-vacuity: every sweep prints its count, and zero is a failure.
  - Expected values come from the spec, the `emails` dictionary (read from the JSON file) or a Stripe mock's own
    value, never from the code under test.
  - Mutate every guard once. Two guards that cover each other are each killed alone.
- **ENV.** Use `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`:
  - `$S up --label outbox-p3-w2`, then `eval "$($S env --label outbox-p3-w2)"`.
  - After a migration edit, run `$S down --label outbox-p3-w2 && $S up --label outbox-p3-w2`.
  - Never run a bare `pnpm db:apply`.
  - Confirm `show data_directory` is this label's.
- **VERIFY `<files>` → `tN`** means exactly this, scoped to the listed files:
  ```
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/outbox-p3-w2/apps/web && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label outbox-p3-w2)" && npx vitest run <files> --reporter=json --outputFile=$OUT/tN.json; echo EXIT=$?
  jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests, files: [.testResults[].name]}' $OUT/tN.json
  ```
  - `$OUT` is the executor's own subdirectory of its scratchpad.
  - Green means `failed == 0`, `total` is unchanged or grows as the step says, and every file appears under this
    worktree's path.
- **TSC** = `cd <worktree>/apps/web && rtk proxy npx tsc --noEmit -p tsconfig.json; echo EXIT=$?`.
- **LINT `<files>`** = `cd <worktree>/apps/web && rtk proxy npx eslint <files>; echo EXIT=$?`. Read `✖ N problems`.
- **MUTATE** is the wave-1 recipe: `cp` backup, edit, VERIFY (the named test fails and `total` is unchanged), `cp`
  restore, VERIFY green. Never use `git checkout`, `git stash` or `git restore` on a file. Run the env down/up around a
  SQL mutation.
- **Never locally:**
  - the full vitest suite, the full e2e suite, or `$S gate`;
  - a local web server (standing rule, 2026-10-24: verify a web build on CI). Smoke runs on the PR's CI smoke job.
  - e2e runs only by CI dispatch, done by the controller:
    `gh workflow run e2e.yml --ref feat/email-outbox-phase3-w2 -f pr=<n>`.
- **No evidence PNGs in the repo.** Screenshots go on an Artifact page.
- **Kill only your own PIDs.**
- **Commit trailer.** Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XN3eUkHiV1TZpUy2phgxYv
  ```

**Rulings carried from the wave-1 ledger (binding here):**
- **R-T1f.** The once-key index is global across orgs, so every key embeds a UUID or a Stripe id. This wave enforces it
  with `onceKey()` (T1), which refuses a missing id. That is a sharper failure than `OutboxDedupeKeyError`'s blank check
  alone: `` `${undefined}:created` `` is not blank.
- **R-T1e.** A cancel frees the once-key, so producers check the thing's state before a re-enqueue. No wave-2 kind is
  cancelled, but each producer still reads its transition under lock before enqueueing (P-W2-5).
- **`claimQueuedRow`.** Tests that stage a claim use the exported `claimQueuedRow` (`email-outbox/attempt.ts:392`),
  never a hand copy of the claim statement.
- **Account vs literal.** `OUTBOX_KIND_FACTS[kind].to` decides. `enqueueEmail` refuses `recipientUserId` on a literal
  kind (`OutboxKindMismatchError`). It does not refuse an account kind that lacks one (the guard is one-directional),
  so every A producer test asserts `recipient_user_id` is the owner's id.
- **C1.** No `E2E_PROD_TARGET` skip in new e2e tests.
- **C2.** The no-second-path scan reads production sources only.
- **C4.** A savepoint is witnessed only by a failing SQL statement inside it, never by a pre-SQL throw.
- **T2 m1.** A staff-kind refusal row belongs to wave 5. Not here.
- **G-5.** The PR checklist carries "readiness log clean".
- **Phase-4 note (owner, 2026-10-26).** No send path bypasses the outbox. Dispatch, the worker and the webhook keep no
  app-render dependencies: every wave-2 body renders at enqueue time, and every wave-2 `KIND_HOOKS` entry is `{}`.
- **Changed-while-queued (owner, 2026-10-26).** A queued row is a snapshot: nothing updates it when the fact it
  carries changes. For every kind, the "Supersede / cancel story" column below must name (1) which facts in the body can
  change while the row waits, and (2) which code path re-enqueues (supersede) or cancels it when they do, or state why
  none can change. Each kind's task owes one test that changes such a fact after enqueue and asserts the row that sends
  carries the new value (or that the old row is cancelled). A kind whose facts cannot change states that, and the
  reviewer checks the claim against the producer.
- **Executors re-pin by symbol.** Wave 1's T8–T12 edit `lib/email.ts` and `registrations.ts`, so every line number
  below is as of `663857e865` and will move. Re-pin with `grep -an <symbol>` before editing.

## Plan decisions where the tree contradicts or underdetermines the spec

Each one is a finding to record in the wave's report. A controller who disagrees with one rules before its task runs.
P-W2-1 and P-W2-2 extend the owner's wave-1 P4 acceptance to sponsor kinds. The controller rules whether that
acceptance covers them (ledger C12) or asks the owner.

| # | Spec says | The tree says | Plan does |
|---|---|---|---|
| P-W2-1 | `sponsor_invoice`: R1/D1. | The order commits in its own `withTenant` (`sponsors.ts:479-487`). The Checkout URL the email carries is minted after that (`:490`). A refusal at that point cannot roll the order back. A 5xx would make the organiser retry, which creates a second order and session. | P4's submit pattern: `assertOutboxCanQueue()` before the order insert, then a pool enqueue after the mint. A refusal there is `log.error`'d and the 201 stands; the organiser already sees the payment link (`sponsor-packages.tsx:274-286`). Then `deferred(() => dispatchNow([id]))`. |
| P-W2-2 | `sponsor_refund`: R1/D1. | The console path calls `refunds.create` (`:642`) before the transition. The webhook path follows a refund that already happened. D1 would roll back the record that money moved. | P4's refund pattern: an R4 savepoint inside the transition transaction (`:674-697`). A refusal is logged and the refund stays recorded. |
| P-W2-3 | `sponsor_refund` once-key: "refund id". | The console path hands `handleSponsorChargeRefunded` a synthetic charge `{ payment_intent, refunded: true }` (`:650`). A webhook `Charge` on API `2026-06-24.dahlia` carries no `refunds` list. Neither path has a refund id. | Key `<order id>:refunded`. Sponsor refunds are full-only (the `charge.refunded` gate, `:673`), and an order goes `paid → refunded` once (`where status = 'paid'`, `:691`), so the key is one-to-one with the refund. |
| P-W2-4 | The lost notices: `<id>:lost`. | Both are gated on `!recovery.already` (`registrations.ts:3210`, `sponsors.ts:883`). Under D1, a first run whose enqueue is refused throws after the reversal was created. On the replay, the metadata guard hits (`dispute-recovery.ts:76-77`), `already` is true, and the notice would never be written. | Drop the gate. The once-key is the guard. `recoverDisputedTransfer` returns the matching prior reversal's amount when `already`, so a notice written by the replay states the real recovered amount, not 0. |
| P-W2-5 | R6. | The registration created path updates unconditionally and mails every time (`registrations.ts:3157-3176`, F7). The sponsor paths read their transition flags outside any transaction (`sponsors.ts:808-815`, then `:825`, `:851`). | Each created/won transition runs in one `sql.begin`: a `for update` read of the prior `dispute_id` / `disputed_at`, the existing update, then the enqueue, gated on the transition. The once-key backs it up. Each guard is killed alone (T2, T7). |
| P-W2-6 | "A = an account" (the owner). | There are three owner lookups. `registrations.ts:3235` and `sponsors.ts:734` use `limit 1` with no order, so with two owners the pick is arbitrary. `billing-events.ts:1958` orders by `m.created_at, m.user_id`, as `billing-groups.ts:1199-1202` does. | One leaf, `orgOwnerRecipient` (T2), ordered `m.created_at, m.user_id`, skipping deleted accounts. All three copies go. This is pending owner question Q2. |
| P-W2-7 | `pass_revoked`: R1. | The fact (the pass delete) is in `lib/billing.ts:1057-1059` on the pool, outside any transaction, in a lib module with seven test callers. | `revokePassForRefundedCharge` gains an optional `inRevoke(tx, revoked)` callback, run inside a new `sql.begin` around the delete. `lib/billing.ts` imports nothing from the outbox. |
| P-W2-8 | `trial_ending` once-key: the Stripe event id. | The dispatch does not pass the event to the handler (`billing-events.ts:2737-2741`). The handler swallows every send error on purpose (`:2585-2596`; doc `:2527-2529`): "a throw would … re-send the same warning up to three more times". | Pass `event.id`. Remove the try/catch so a refused enqueue parks the event (D1). The old reason no longer holds, because the once-key is the event id, so a re-run writes nothing. The three no-op cases (no group, no live owner, no `trial_end`) still return without a row and without a throw. |
| P-W2-9 | Wave-2 test: "`runEvent` on the same event twice gives one row per kind". | As written this cannot fail. The second `runEvent` returns `false` at the ledger claim and never re-runs the handler (`billing-events.ts:2818-2833`). | Keep it as a ledger pin. Pair it with the real replay: clear `processed_at` and age `processing_started_at` past the 10-minute lease, so the handler re-runs, and there is still one row (T10). |
| P-W2-10 | D4. | Sponsor orders carry no locale and link to no account. The dispute evidence pack rebuilds the receipt in English on purpose (`sponsors.ts:954-969`: "sponsor emails are sent in en"). | The sponsor kinds use the org default (D4). The evidence pack rebuilds the receipt with the same resolver, so it quotes what was sent. Residual: an org that changes its default language between the receipt and the dispute gets a pack in the new language. |
| P-W2-11 | (wave-1 guard) | `a-kind-body.test.ts` selects rows with the chess-only `split_part(ref_id, ':', 1)` filter, and producers return fixture ids. | Producers return their own row ids and a positive-pair pattern. The chess producer keeps its filter internally (T1). |
| P-W2-12 | (row org) | A billing group can span several orgs (`billing-events.ts:2552-2560`). | `trial_ending` rows carry `org_id = null`. R3 does not apply, because the handler is outside `withTenant`. |

**Stale citations (re-verified at `663857e865`).** The spec's wave-2 citations are current:
- `lib/email.ts` `:634`, `:647`, `:659`, `:671`, `:683`, `:695`, `:710`, `:725`, `:740`, `:1643`;
- `billing-events.ts:2704-2715` and `:2815-2835`.

Spec F7's `registrations.ts:3158-3168` is the update (`:3158-3160`) and the send (`:3168`), which is current. All of
these move once wave 1 merges, so re-pin by symbol.

## Review Focus

These are the conditions the spec implies but no spec test exercises, most likely to hurt a person first. Each line's
test lives in its owning task.

1. **A Stripe object with no id** (a hand-built or synthetic charge: `sponsors.ts:650` builds one, and the pass tests
   build them without an `id`) must be refused by name. It must never be keyed `"undefined"` or `"undefined:created"`:
   that key would be global (R-T1f) and would silently swallow every later email of the kind. Tests: T1 (builder) and
   T8 test 6 (through the producer).
2. **A dispute-lost notice whose first enqueue was refused** must still reach the organiser on the replay, stating the
   amount the first run actually recovered (P-W2-4). Tests: T3 test 3 and T7 test 7.
3. **A sponsor refund whose notice cannot be queued** is still recorded: the order is `refunded`, the placement is
   off, and the console refund call does not 5xx after money moved (P-W2-2). Test: T6 test 4.
4. **An org with two owners**, or one whose owner was transferred, mails exactly one deterministic owner: the oldest
   current owner, never a deleted account (P-W2-6, Q2). Tests: T2's `org-owner.test.ts` and T2 test 9.
5. **The sponsor evidence pack** quotes the receipt in the language it was sent in, not English (P-W2-10). Test: T5
   test 6.

## The ten kinds

All are `transactional: false` except `trial_ending`. Each is written with `expiresAt: expiryWithin(null)`. Producers
import from `@/server/email-outbox` (the index), so the tests' enqueue spy can see them.

| Kind (spec order) | Sender deleted (email.ts) | Builder added | Producer (re-pinned) | To | First | `ref_type / ref_id` | Once-key (`onceKey(...)`) | Org | Locale (`recipientLocale`) | Supersede / cancel story |
|---|---|---|---|---|---|---|---|---|---|---|
| `registration_dispute_alert` | `sendDisputeAlertEmail` :634 | `disputeAlertEmail` | `registrations.ts` `handleRegistrationDispute`, created `:3155-3180` | A: org owner | W | `dispute / <dispute.id>` | `<dispute.id>:created` | `reg.org_id` | pick null, owner id, `ctx.default_locale` | One row per dispute. No cancel: a closed dispute does not unsay the alert. The lost row is another kind, so it replaces nothing. |
| `registration_dispute_lost` | `sendDisputeLostEmail` :647 | `disputeLostEmail` | same, lost `:3189-3229` | A: org owner | W | `dispute / <dispute.id>` | `<dispute.id>:lost` | `reg.org_id` | same | As above. A replay is deduped by the key (P-W2-4). |
| `sponsor_invoice` | `sendSponsorInvoiceEmail` :659 | `sponsorInvoiceEmail` | `sponsors.ts` `startSponsorCheckout` `:453-535` | L: `input.sponsor_email` | R | `sponsor_order / <order.id>` | `<order.id>` | `auth.orgId` | pick null, user null, org default | Each checkout is a new order, so nothing is superseded. No cancel path exists for an unpaid order. |
| `sponsor_receipt` | `sendSponsorReceiptEmail` :671 | `sponsorReceiptEmail` | `handleSponsorPaymentSucceeded` `:549-600` | L: `order.sponsor_email` | W | `sponsor_order / <order.id>` | `<intent.id>` | `order.org_id` | org default | It is a different kind from the invoice, so the invoice row stays. |
| `sponsor_refund` | `sendSponsorRefundEmail` :683 | `sponsorRefundEmail` | `handleSponsorChargeRefunded` `:668-713`, console `refundSponsorOrder` `:620-666` | L | R (console) / W (webhook) | `sponsor_order / <order.id>` | `<order.id>:refunded` (P-W2-3) | `order.org_id` | org default | The webhook after a console refund finds the order already `refunded`, so it makes no call. |
| `sponsor_dispute_alert` | `sendSponsorDisputeAlertEmail` :695 | `sponsorDisputeAlertEmail` | `handleSponsorDispute` created `:820-846` | A: org owner | W | `dispute / <dispute.id>` | `<dispute.id>:created` | `order.org_id` | owner, org default | As the registration alert. |
| `sponsor_dispute_won` | `sendSponsorDisputeWonEmail` :725 | `sponsorDisputeWonEmail` | won `:849-871` | A | W | `dispute / <dispute.id>` | `<dispute.id>:won` | `order.org_id` | same | Another kind from the alert, so the alert row stays. |
| `sponsor_dispute_lost` | `sendSponsorDisputeLostEmail` :710 | `sponsorDisputeLostEmail` | lost `:873-901` | A | W | `dispute / <dispute.id>` | `<dispute.id>:lost` | `order.org_id` | same | P-W2-4. |
| `pass_revoked` | `sendPassRevokedEmail` :740 | `passRevokedEmail` | `billing-events.ts` `revokePassForRefundedChargeAndNotify` `:1977-2013` + `lib/billing.ts` `revokePassForRefundedCharge` `:1051-1062` | A: org owner | W | `charge / <charge.id>` | `<charge.id>` | `ctx.org_id` | owner, org default | A later refund event for the same charge deletes nothing, so it makes no call. |
| `trial_ending` | `sendTrialEndingEmail` :1643 | `trialEndingEmail` | `handleTrialWillEnd` `:2531-2597`, dispatch `:2737-2741` | A: `subscriptions.owner_user_id` | W | `subscription / <group id>` | `<event.id>` | null (P-W2-12) | payer, billing org default | A second warning event for the same trial supersedes a still-queued first one (kind + ref + `recipient_user_id`, the wave-1 replace rule). |

**Builder convention (wave 1 Task 8).** `<name>Email(args: <Template>Args, locale: Locale): Promise<EmailContent>`,
where `EmailContent` is `lib/email.ts:298`. It is `getDictionary(locale, "emails")` plus the existing template from
`lib/email-templates/*`. `trialEndingEmail` keeps the `billingUrl` computation from `lib/email.ts:1645-1653`, and its
args are `{ planName: string; trialEnd: string; hasPaymentMethod: boolean; orgSlug: string | null }`.

**Interfaces consumed from wave 1** (merged before T0; re-pin each at T0):
- `enqueueEmailOnce`, `expiryWithin`, `assertOutboxCanQueue`, `dispatchNow` and `OutboxDedupeKeyError`, from
  `@/server/email-outbox`.
- `recipientLocale(db, { pick, userId, orgDefault }): Promise<Locale>` (wave 1 Task 7, `email-outbox/locale.ts`).
- `forEachOutboxKind`, `KindScenario`, `bornAgo` and `dictionarySubject` (wave 1 Task 7, `__tests__/_kind-harness.ts`).
- `SPEC_KINDS`, `SPEC_FACTS` and `NOT_YET_MOVED` in `outbox-kind-sweep.test.ts` (wave 1 Task 7; Task 12 deletes
  `NOT_YET_MOVED`).
- `SENDER_ALLOWLIST` in `no-second-path.test.ts`: 44 names after wave 1.
- `checkOutboxRow` in `scripts/smoke.ts` (wave 1 Task 13).
- The C4 failing-SQL seam in `refund-issued-outbox.test.ts` (wave 1 Task 11).
- `stubOutboxEnv` (`__tests__/_invite-mail.ts`).

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `db/migration/deltas/V<N>__email_outbox_phase3_wave2.sql` (create) | kind CHECK, 17 kinds | T1 |
| `apps/web/src/server/email-outbox/constants.ts` | `OUTBOX_KINDS` 17, `OUTBOX_KIND_FACTS` 17 | T1 |
| `apps/web/src/server/email-outbox/hooks.ts` | `KIND_HOOKS` gains ten `{}` | T1 |
| `apps/web/src/server/email-outbox/enqueue.ts`, `index.ts` | `onceKey` | T1 |
| `apps/web/src/server/usecases/org-owner.ts` (create) | `orgOwnerRecipient` (leaf) | T2 |
| `apps/web/src/server/usecases/dispute-recovery.ts` | the prior amount on `already` | T3 |
| `apps/web/src/server/usecases/registrations.ts` | dispute alert and lost; delete `currentOwnerEmail` | T2, T3 |
| `apps/web/src/server/usecases/sponsors.ts` | invoice, receipt, refund, three disputes, evidence locale; delete `currentOrgOwnerEmail` | T4–T7 |
| `apps/web/src/lib/billing.ts` | `inRevoke` seam | T8 |
| `apps/web/src/server/usecases/billing-events.ts` | pass revoked (delete `orgOwnerEmail`), trial ending, dispatch passes `event.id` | T8, T9 |
| `apps/web/src/lib/email.ts` | ten senders become ten builders | T2–T9 |
| `apps/web/src/server/usecases/__tests__/_money-fixtures.ts` (create) | `seedSponsorOrg`, `seedSponsorOrder`, `seedPassOrg`, `seedTrialingGroup`, `plantFailingUpdate` | T4, T8, T9 |
| `apps/web/src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts`, `a-kind-body.test.ts`, `no-second-path.test.ts`, `outbox-schema.test.ts` | lists, scenarios, allowlist | T1–T10 |
| new suites under `apps/web/src/server/usecases/__tests__/` | per-kind producer tests, F7 replay | T2–T10 |
| `scripts/smoke.ts`, `scripts/__tests__/smoke-select.test.ts` | the trial-warning smoke | T11 |
| `apps/web/e2e/payments-hardening.spec.ts`, `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts` | row assertions | T12 |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` | `sponsors.order.sent`, only if Q1 is approved | T4 |

---

### Task 0: Preconditions and environment (no commit)

**Files:** none modified.

**Interfaces:** Produces the pinned facts later tasks rely on.

- [ ] **Step 1: Wave 1 has merged.** Run
  `cd /Users/ashokhein/github/seazn.club && git fetch origin && git log --oneline origin/main | grep -ai "outbox" | head -5`.
  Expected: wave 1's merge. If it is absent, STOP and report.
- [ ] **Step 2: Worktree.**
  - Run `git -C /Users/ashokhein/github/seazn.club worktree add .claude/worktrees/outbox-p3-w2 -b feat/email-outbox-phase3-w2 origin/main`,
    then `pnpm install --frozen-lockfile` inside it. Link `.env.local` per the seazn-local-env skill.
- [ ] **Step 3: Pin the migration number** (Global Constraints). Record `V<N>`.
- [ ] **Step 4: Re-pin wave 1's merged names.** For each name in "Interfaces consumed from wave 1", run
  `grep -an` on the merged tree and write the file:line into the task report.
  - Expected counts: `SENDER_ALLOWLIST` has 44 entries; `NOT_YET_MOVED` is gone; the sweep closes at
    `checked === 7`; `SPEC_ACCOUNT_KINDS` is `["chess_invite"]`.
  - A different merged name wins. Record the difference.
- [ ] **Step 5: Re-pin every producer in the kind sheet by symbol.** Also re-pin every test citation in T2–T9's
  Files. Record them.
- [ ] **Step 6: Pre-scan the mocks.** Run `grep -arln 'vi.mock("@/lib/email"' apps/web/src`.
  - For every file whose factory does not spread `importOriginal`, record whether it drives a wave-2 producer:
    `processStripeEvent`, `runEvent`, `replayEvent`, `handleRegistrationDispute`, `handleSponsor*`,
    `startSponsorCheckout`, `refundSponsorOrder` or `revokePassForRefundedCharge`.
  - Known so far: `credit-pack-refund.test.ts` and `relay-checkout.test.ts`.
  - The task that deletes a sender such a file reaches adds `...(await importOriginal())` to its factory.
- [ ] **Step 7: Env.** `$S up --label outbox-p3-w2`. Confirm `show data_directory` is this label's.

### Task 1: Vocabulary, schema and the once-key builder

**Files:**
- Create `db/migration/deltas/V<N>__email_outbox_phase3_wave2.sql`. It has one statement, in the shape of V472's
  (`:57-59`):
  `alter table email_outbox drop constraint email_outbox_kind_valid, add constraint email_outbox_kind_valid check (kind in (<17>))`.
- Modify:
  - `email-outbox/constants.ts`: `OUTBOX_KINDS` appends the ten kinds in spec table order (registration alert,
    registration lost, invoice, receipt, refund, sponsor alert, won, lost, pass, trial), plus `OUTBOX_KIND_FACTS`;
  - `hooks.ts`: ten `{}`;
  - `enqueue.ts` and `index.ts`: `onceKey`.
- Test:
  - `__tests__/outbox-schema.test.ts` (the `:50` literal);
  - `outbox-kind-sweep.test.ts` (`SPEC_KINDS`, `SPEC_FACTS`, `NOT_YET_MOVED`, legend);
  - `a-kind-body.test.ts`;
  - create `__tests__/once-key-builder.test.ts`;
  - `hooks.test.ts` only if it enumerates kinds (the wave-1 R-T1d precedent).

**Interfaces:**
- Produces `onceKey(kind: OutboxKind, refType: string, id: string | null | undefined, suffix?: string): string`.
  - It returns `id`, or `` `${id}:${suffix}` ``.
  - It throws `new OutboxDedupeKeyError(kind, refType)` unless `typeof id === "string" && id.trim() !== ""`.
- `OUTBOX_KIND_FACTS` additions:
  - account: `registration_dispute_alert`, `registration_dispute_lost`, `sponsor_dispute_alert`,
    `sponsor_dispute_won`, `sponsor_dispute_lost`, `pass_revoked`, `trial_ending`;
  - literal: `sponsor_invoice`, `sponsor_receipt`, `sponsor_refund`;
  - `transactional` is `false` for all ten except `trial_ending: true`.

- [ ] **Step 1: Write the failing tests.**
  - `outbox-schema.test.ts`: retitle the test to `the kinds are the spec's seventeen, in the spec's wave order`. The
    typed list is the 7 plus the ten in table order, and `SPEC_KINDS.length` is 17. If the file also reads the live
    CHECK from `pg_constraint`, extend its expected list the same way.
  - `outbox-kind-sweep.test.ts`:
    - `SPEC_KINDS`: 17 in that order.
    - `SPEC_FACTS` gains the ten, typed from the spec legend.
    - `NOT_YET_MOVED` is the ten (re-added).
    - Retitle the legend test to `the legend has NINE literal kinds, EIGHT account kinds and no staff kind`. It
      asserts:
      - `by("literal")` equals `["magic_link", "registration_confirmation", "payment_reminder", "registration_promoted", "refund_issued", "solo_signup_assigned", "sponsor_invoice", "sponsor_receipt", "sponsor_refund"]`;
      - `by("account")` equals `["chess_invite", "registration_dispute_alert", "registration_dispute_lost", "sponsor_dispute_alert", "sponsor_dispute_won", "sponsor_dispute_lost", "pass_revoked", "trial_ending"]`;
      - the transactional ones are `["magic_link", "chess_invite", "trial_ending"]`.
  - `a-kind-body.test.ts`:
    - `SPEC_ACCOUNT_KINDS` is the eight account kinds above.
    - Add `PRODUCERS_PENDING`: the seven new ones. Each kind task deletes its entry, and T10 deletes the list.
    - `PRODUCERS` becomes `Readonly<Partial<Record<OutboxKind, () => Promise<{ rowIds: string[]; positive: RegExp }>>>>`.
      The chess producer keeps its own `split_part` select and its `>= 2` premise, and returns the ids.
    - The loop runs over `SPEC_ACCOUNT_KINDS` minus `PRODUCERS_PENDING`. It asserts that `PRODUCERS` has exactly
      those keys, selects rows `where id = any(rowIds)`, and requires `rows.length >= 1` per kind. It asserts
      `body.text` or `body.html` matches `positive` as the positive pair. Finally
      `kindsChecked === SPEC_ACCOUNT_KINDS.length - PRODUCERS_PENDING.length`, which is 1 now and greater than 0.
  - `once-key-builder.test.ts`. The cases are (id, suffix) → expected:
    - `("dp_1", "created")` → `"dp_1:created"`;
    - `("ch_1", undefined)` → `"ch_1"`;
    - `(undefined, "created")` → throws `OutboxDedupeKeyError`;
    - `(null, "lost")` → throws;
    - `("  ", undefined)` → throws.

    It asserts `checked === 5`. A sixth case asserts that the thrown error's message names neither the id nor the
    suffix.
- [ ] **Step 2: Run red.** VERIFY the five files → `t1`. Expected failures: the kind list, the legend, the declared
  account kinds, and `onceKey` not exported.
- [ ] **Step 3: Implement** the migration, constants, facts, hooks, `onceKey` and the index export. Then run the env
  down/up.
- [ ] **Step 4: Run green.** VERIFY → `t1b`. Expected: `failed: 0`; the sweep still reports `checked: 7`;
  `a-kind-body` reports `kindsChecked: 1`.
- [ ] **Step 5: Mutations.**
  - In `onceKey`, drop the `typeof` check: the `undefined` case returns `"undefined:created"` and fails.
  - In the migration, omit `trial_ending` from the CHECK (env down/up around it): the schema test fails.
  - In facts, flip `pass_revoked` to `literal`: the a-kind-body declared-kinds test fails.
- [ ] **Step 6: TSC** (it catches a missing `KIND_HOOKS` key), **LINT**, then commit:
  `feat(email-outbox): wave-2 kinds in the vocabulary, and a once-key builder that refuses a missing id`.

### Task 2: `registration_dispute_alert`, and the one owner lookup

**Files:**
- Create:
  - `apps/web/src/server/usecases/org-owner.ts`;
  - `server/usecases/__tests__/org-owner.test.ts`;
  - `server/usecases/__tests__/registration-dispute-outbox.test.ts`.
- Modify:
  - `registrations.ts`: the created branch of `handleRegistrationDispute` (`:3155-3180`);
  - `lib/email.ts`: delete `DisputeAlertEmail` and `sendDisputeAlertEmail` (`:628-638`); add `disputeAlertEmail`.
- Test: the sweep, `a-kind-body.test.ts`, `no-second-path.test.ts`.

**Interfaces:**
- Produces `orgOwnerRecipient(db: Tx | typeof sql, orgId: string): Promise<{ userId: string; email: string } | null>`.
  - It runs
    `select m.user_id, u.email from org_members m join users u on u.id = m.user_id and u.deleted_at is null where m.org_id = $1 and m.role = 'owner' order by m.created_at, m.user_id limit 1`.
  - It imports only `@/lib/db`, so it is a leaf. The registration, sponsor and billing modules import it without the
    cycle that kept `currentOrgOwnerEmail` a copy (`sponsors.ts:731-733`).
- The created branch:
  1. Read the owner and `recipientLocale(sql, { pick: null, userId: owner.userId, orgDefault: ctx.default_locale })`
     before the transaction.
  2. In one `sql.begin(tx)`:
     1. `select dispute_id from registration_groups where id = ${reg.group_id} for update`.
     2. The existing update, unchanged.
     3. If `prior.dispute_id !== dispute.id` and there is an owner: `enqueueEmailOnce(tx, …)` with kind
        `registration_dispute_alert`, ref `dispute / dispute.id`, `dedupeKey: onceKey(kind, "dispute", dispute.id, "created")`,
        `orgId: reg.org_id`, `to: owner.email`, `recipientUserId: owner.userId`, `transactional: false`,
        `expiresAt: expiryWithin(null)`, and the content of `disputeAlertEmail(args, locale)`.
     4. The existing `audit(tx, …)`, now on `tx` and still unconditional (see Next waves, item b).
  3. No `dispatchNow` (W).
- Order inside the transaction: the enqueue comes before the audit, so the rollback test can fail the audit.

- [ ] **Step 1: Write the failing tests.** They mock only the transport and run `stubOutboxEnv()`. Rigs come from
  `_registration-fixtures.ts` (`stripeRig`, `seedRegistration`, `fakeSession`, `makeUser`). The enqueue spy is
  `vi.mock("@/server/email-outbox", async (io) => { const m = await io(); return { ...m, enqueueEmailOnce: vi.fn(m.enqueueEmailOnce) }; })`.
  - `org-owner.test.ts` (`checked === 5`):
    1. One owner → that owner.
    2. Two owners. The OLDER one (explicit earlier `created_at`) is inserted SECOND, so heap order differs from the
       answer → the older one.
    3. Two owners with equal `created_at` → the lower `user_id`.
    4. The only owner's account is deleted → `null`. With a second live owner → that one.
    5. Only an admin → `null`.
  - `registration-dispute-outbox.test.ts`:
    1. `a dispute queues one alert to the org owner, in the owner's language, for the worker`. The owner's
       `users.locale` is `fr`. Expected: one row with
       - kind `registration_dispute_alert`, `ref_type` `dispute`, `ref_id` `dp_<run>`;
       - `dedupe_key` `dp_<run>:created`;
       - `recipient_user_id` the owner's id, `recipient` the owner's email, `transactional` false;
       - `status` `queued` with `attempts` 0;
       - subject `dictionarySubject("fr", "disputeAlert.subject", { competitionName })`;
       - 0 transport calls.
    2. `the same dispute delivered twice queues one alert`: 1 row, and the spy saw 1 call.
    3. `an older dispute's created, arriving after a newer one's, does not alert twice`. Dispute `a`, then `b`, then
       `a` again: 2 rows (`a:created`, `b:created`) and 3 spy calls. This kills the once-key alone.
    4. `empty: a dispute on a charge that is not an entry fee queues nothing`. An unknown intent returns `false`, and
       no `payment_intent` returns `false`. 0 rows.
    5. `an org with no owner records the dispute and queues nothing`: `dispute_id` is set, 0 rows, no throw.
    6. `D4: an owner with no language gets the org's default`: `users.locale` null, org `default_locale` `nl` → the
       `nl` subject.
    7. `D1: an alert that cannot be queued fails the handler and leaves no flag`. With `RESEND_API_KEY` set and the
       KEK unset, the handler rejects with `OutboxKeyUnavailableError`, `dispute_id` is still null, and there are 0
       rows. With the env restored, a re-run gives 1 row and the flag set.
    8. `rollback: a failing audit leaves no alert`. `vi.mock("@/server/usecases/audit", importOriginal)` rejects
       once. The handler rejects, there are 0 rows and `dispute_id` is null.
    9. `ownership transfer: the alert goes to the current owner`. Flip the roles as `registrations.test.ts:3248`
       does: `recipient_user_id` is the new owner.
    10. `after a withdrawal: a dispute on a withdrawn, refunded entry still alerts`: 1 row. The chargeback is about
        money, whatever the entry's state.
- [ ] **Step 2: Sweep, body guard, scan.**
  - Sweep scenario `registration_dispute_alert`: the real created handler on a stripeRig cart, owner `fr`,
    `disputeAlert.subject`, `{ competitionName }`, `worker`. Remove the kind from `NOT_YET_MOVED`.
  - a-kind-body producer: the same rig. It returns the row ids, with `positive` = the competition name. Remove the
    kind from `PRODUCERS_PENDING`.
  - Scan: remove `sendDisputeAlertEmail`; the length becomes 43.
- [ ] **Step 3: Run red.** VERIFY the two new files, the sweep, a-kind-body and the scan → `t2`.
- [ ] **Step 4: Implement** to the Interfaces.
- [ ] **Step 5: Run green.** VERIFY → `t2b`. Expected: `failed: 0`; the sweep reports `checked: 8`; a-kind-body
  reports `kindsChecked: 2`; `org-owner` reports `checked: 5`.
- [ ] **Step 6: Mutations.**
  - Drop `prior.dispute_id !== dispute.id`: test 2 fails (2 spy calls).
  - Give `onceKey` a fresh suffix per call: test 3 fails (3 rows).
  - Enqueue on `sql` instead of `tx`: test 8 fails (an orphan row).
  - Drop `order by` in `orgOwnerRecipient`: owner case 2 fails.
  - Drop `u.deleted_at is null`: owner case 4 fails.
- [ ] **Step 7: TSC, LINT and commit.**
  `feat(registrations): dispute alert through the outbox, once per dispute, to one deterministic owner`.

### Task 3: `registration_dispute_lost`

**Files:**
- Modify:
  - `dispute-recovery.ts:76-77`;
  - `registrations.ts`: the lost branch (`:3189-3229`); delete `currentOwnerEmail` (`:3233-3240`);
  - `lib/email.ts`: delete `DisputeLostEmail` and `sendDisputeLostEmail` (`:640-651`); add `disputeLostEmail`.
- Test:
  - `registration-dispute-outbox.test.ts`;
  - `registrations.test.ts`: repoint `:3092`, `:3122`, `:3146`, `:3242` and `:3268` from `emailMock.disputeLost` to
    outbox rows, and drop `disputeLost` from the mock (`:80`);
  - the recovery suite (`grep -arln recoverDisputedTransfer apps/web/src/server/usecases/__tests__`);
  - the sweep, a-kind-body, the scan.

**Interfaces:**
- Produces `recoverDisputedTransfer(...)`. On a guard hit it now returns
  `{ recoveredCents: prior.amount, already: true }`, where `prior` is the reversal whose `metadata.dispute_id` equals
  `dispute.id` (`some` becomes `find`). T7 consumes this through `recoverSponsorDispute`.
- The lost branch, after the recovery:
  - read the owner and the locale as in T2;
  - `enqueueEmailOnce(sql, …)` with kind `registration_dispute_lost`, `dedupeKey: onceKey(kind, "dispute", dispute.id, "lost")`,
    and `disputeLostEmail({ …, recoveredCents: recovery.recoveredCents, consoleUrl }, locale)`. `consoleUrl` is
    unchanged.
  - There is no `already` gate (P-W2-4) and no catch (D1).

- [ ] **Step 1: Write the failing tests.** Wrap `disputeLostEmail` with an `importOriginal` spy on `@/lib/email`, so
  the recovered amount is read at the builder's input. The value comes from the reversal mock, not from the code.
  1. `a lost dispute queues one outcome notice carrying the recovered amount`. `reversalCreate` resolves and the
     reversal amount is 1900. Expected: one row (`dedupe_key` `dp_<run>:lost`, `queued`), and the spy was called with
     `recoveredCents: 1900`.
  2. `a replayed lost event queues no second notice` (repoints `:3127`): `reversalCreate` 1 call and 1 row.
  3. `a lost notice refused on the first run is queued by the replay, with the first run's recovered amount`
     (Review Focus 2).
     - Under a key fault the handler rejects. `group_refunded_cents` is 2000, `reversalCreate` has 1 call, and there
       are 0 rows.
     - Restore the env. `reversalList` now returns `[{ id: "trr_prior", amount: 1900, metadata: { dispute_id } }]`.
       Re-run.
     - Expected: 1 row, the spy called with `recoveredCents: 1900`, and `reversalCreate` still 1 call.
  4. `the write-off lands when the reversal throws` (repoints `:3102`): 1 row, spy `recoveredCents: 0`.
  5. `the current owner after a transfer` (repoints `:3248`): `recipient_user_id` is the new owner.
  6. `won never queues a lost notice` (repoints `:3242`): 0 lost rows.
  7. `one dispute's alert and lost notice are two rows, and neither replaces the other`: created, then lost. Both rows
     are `queued`.
  8. Recovery unit: `a guard hit returns the matching prior reversal's amount`. With reversals
     `[{ amount: 500, metadata: { dispute_id: "other" } }, { amount: 1900, metadata: { dispute_id } }]` → 1900.
- [ ] **Step 2: Sweep, body guard, scan.**
  - Sweep scenario: a lost dispute with no `charge`, so the recovery is skipped and Stripe is not called. The owner
    has `users.locale` null and the org default is `es`. `disputeLost.subject`, `worker`.
  - a-kind-body producer.
  - Scan length: 42.
- [ ] **Step 3: Run red** → `t3`. **Step 4: Implement.** **Step 5: Run green** → `t3b`. Expected: the sweep
  reports `checked: 9` and a-kind-body reports `kindsChecked: 3`.
- [ ] **Step 6: Mutations.**
  - Restore the `if (!recovery.already)` gate: test 3 fails.
  - Fresh once-key per call: test 2 fails.
  - Return 0 on `already`: test 3's amount and the unit test fail.
- [ ] **Step 7: TSC, LINT and commit.**
  `feat(registrations): dispute-lost notice through the outbox; a replay states the real recovered amount`.

### Task 4: `sponsor_invoice`

**Files:**
- Create `server/usecases/__tests__/_money-fixtures.ts` and `server/usecases/__tests__/sponsor-outbox.test.ts`.
  `_money-fixtures.ts` holds:
  - `seedSponsorOrg`: the Connect-enabled org, the plan and the package, from `sponsor-checkout.test.ts`'s setup;
  - `seedSponsorOrder`, moved from `sponsor-dispute.test.ts:44-80`; `sponsor-dispute.test.ts` imports it;
  - `plantFailingUpdate`.
- Modify `sponsors.ts` `startSponsorCheckout` (`:453-535`). Modify `lib/email.ts`: delete the invoice sender
  (`:653-663`) and add `sponsorInvoiceEmail`.
- Test: `sponsor-checkout.test.ts` (`:287`), the sweep, the scan.
- Only if Q1 is approved: `dictionaries/{en,es,fr,nl}/ui.json` `sponsors.order.sent`.

**Interfaces:**
- `seedSponsorOrg(opts?: { defaultLocale?: Locale }): Promise<{ orgId: string; ownerId: string; packageId: string; auth: AuthCtx }>`.
- `seedSponsorOrder(opts: { status: "pending" | "paid"; intent?: string; defaultLocale?: Locale }): Promise<{ orderId: string; orgId: string; sponsorId: string | null; intent: string; sponsorEmail: string; ownerId: string }>`.
- `plantFailingUpdate(table: "sponsors" | "sponsor_orders", id: string): Promise<() => Promise<void>>`.
  - It creates a plpgsql function and a `before update` trigger that raises `planted failure` when `new.id = <id>`,
    and returns its dropper.
  - Callers drop it in `finally`.
  - First check the env's role can create triggers (`select rolsuper, rolcreaterole from pg_roles where rolname = current_user`).
    If it cannot, record that, and the "rollback" tests that use it become "recorded equivalent".
- `startSponsorCheckout`:
  1. The org select adds `default_locale`.
  2. `assertOutboxCanQueue()` runs after the Connect gate and before the order insert.
  3. After the `session.url` check:
     `try { id = await enqueueEmailOnce(sql, { kind: "sponsor_invoice", refType: "sponsor_order", refId: order.id, dedupeKey: onceKey("sponsor_invoice", "sponsor_order", order.id), orgId: auth.orgId, to: input.sponsor_email, transactional: false, expiresAt: expiryWithin(null), ...content }) } catch (err) { log.error({ err, orderId: order.id }, "sponsors: invoice email could not be queued") }`.
  4. `if (id) deferred(() => dispatchNow([id]))`.

  The return shape is unchanged.

- [ ] **Step 1: Write the failing tests.** The Stripe mock is the `stripeMock` pattern of `sponsor-checkout.test.ts:8-20`.
  1. `a checkout queues one invoice to the sponsor contact in the org's language, and sends it in the request`.
     Org default `fr`. Expected:
     - ref `sponsor_order / <order id>`, `dedupe_key` the order id, `recipient_user_id` null, `transactional` false;
     - after the deferred dispatch: `sent`, no body, one transport call with `email-outbox/<id>`;
     - subject `dictionarySubject("fr", "sponsorInvoice.subject", { orgName })`.
  2. `two checkouts for one package are two invoices, and neither replaces the other`: both `sent`.
  3. `a key fault refuses the checkout before any order or Checkout session exists`: it rejects
     `OutboxKeyUnavailableError`, there are 0 `sponsor_orders` rows for the contact, and `checkout.sessions.create`
     was not called.
  4. `an invoice refused after the mint is logged, and the checkout still answers with its link`. The spy throws
     once. It resolves with `checkout_url`, `log.error` was called with `orderId`, and there are 0 rows.
  5. `empty: an inactive package refuses before any order or row` (422, 0 rows).
  - The once-key has no killer here: no path re-enqueues one order's invoice. Record it as a belt by spec, equivalent
    under every reachable input.
- [ ] **Step 2: Sweep and scan.** Sweep scenario `sponsor_invoice` (`startSponsorCheckout`, `fr`,
  `sponsorInvoice.subject`, `request`). The sweep file hoists the same `getStripe` mock. Scan length: 41.
- [ ] **Step 3: Run red** → `t4`. **Step 4: Implement.** **Step 5: Run green** → `t4b`. Expected: the sweep
  reports `checked: 10`.
- [ ] **Step 6: Mutations.**
  - Move `assertOutboxCanQueue()` after the order insert: test 3 fails.
  - Remove the try/catch: test 4 fails.
  - Drop the deferred dispatch: test 1 fails (the row stays `queued`).
- [ ] **Step 7: Copy (only if Q1 is approved).** Reword `sponsors.order.sent` in the four locales, then run gen-keys
  and check. Screenshot the order-created notice (`sponsor-packages.tsx:274-286`) at 1280, 320 and 768 onto an
  Artifact page. There must be no horizontal scroll.
- [ ] **Step 8: TSC, LINT and commit.** `feat(sponsors): the invoice email through the outbox`.

### Task 5: `sponsor_receipt`, and the evidence pack's language

**Files:**
- Modify `sponsors.ts`: `handleSponsorPaymentSucceeded` (`:549-600`) and `buildSponsorDisputeEvidence` (`:921-`,
  the `getDictionary("en", "emails")` at `:968`). Modify `lib/email.ts`: delete the receipt sender and add
  `sponsorReceiptEmail`.
- Test:
  - `sponsor-outbox.test.ts`;
  - `sponsor-checkout.test.ts` (`:335`, `:469`);
  - `sponsor-order-delete-guards.test.ts` (the evidence pack's existing reader);
  - the sweep, the scan.

**Interfaces:**
- Produces `queueSponsorReceipt(tx: Tx, a: { order: { id: string; org_id: string; sponsor_name: string; sponsor_email: string; amount_cents: number; currency: string }; packageName: string; intentId: string }): Promise<string | null>`.
  - It reads the org (`slug`, `name`, `default_locale`) through `tx`.
  - The locale is `recipientLocale(tx, { pick: null, userId: null, orgDefault })`.
  - `publicUrl` is unchanged (`sponsorEmailOrigin()`).
  - It calls `enqueueEmailOnce(tx, { kind: "sponsor_receipt", refType: "sponsor_order", refId: order.id, dedupeKey: onceKey("sponsor_receipt", "sponsor_order", intentId), orgId: order.org_id, ... })`.
- Call it inside the activation transaction, after the `insert into sponsors` and before the
  `update sponsor_orders … paid`. There is no catch (D1). `fireOrgRevalidate` stays after commit.
- The evidence pack resolves the locale the same way (org `default_locale`) and renders with `sponsorReceiptEmail`.

- [ ] **Step 1: Write the failing tests.**
  1. `a paid sponsor order queues one receipt for the worker, in the org's language`.
     `processStripeEvent(payment_intent.succeeded, metadata { kind: "sponsor", order_id })`, org default `nl`.
     Expected: `dedupe_key` the intent id, ref `sponsor_order / <order id>`, `queued` with `attempts` 0, and 0
     transport calls.
  2. `a redelivered success queues nothing new`: 1 row, and the spy saw 1 call.
  3. `the receipt's once-key alone`: `queueSponsorReceipt` twice, in two transactions, with one intent → 1 row.
  4. `D1: a receipt that cannot be queued leaves the order unpaid, and the retry activates it and queues once`.
     Under a key fault: it rejects, the order is `pending`, and no `sponsors` row exists. Restore and re-run: the
     order is `paid` and there is 1 row.
  5. `rollback: a failing order update leaves no receipt`. `plantFailingUpdate("sponsor_orders", orderId)`: it
     rejects with 0 rows.
  6. `the evidence pack quotes the receipt in the language it was sent in` (Review Focus 5). Org default `fr`: the
     pack's HTML contains `dictionarySubject("fr", "sponsorReceipt.subject", { orgName })` and not the `en` subject.
  7. `the invoice row survives the receipt`: invoice then receipt for one order gives 2 rows, invoice not `replaced`.
  8. `empty: a payment that is not a sponsor's queues nothing` (`metadata.kind` other → 0 rows).
  9. `a redelivered success after a refund re-activates nothing and queues no receipt`. Take a paid order through
     `handleSponsorChargeRefunded`: `status` is `refunded` and `sponsor_id` stays. Redeliver: no new `sponsors` row
     and 0 receipt rows. This kills the `sponsor_id !== null` guard alone.
  10. `a redelivered success after the organiser deleted the sponsor queues no second receipt`. Activate the order
      through the real handler (1 receipt row). Delete the `sponsors` row: the FK is `on delete set null`
      (`V283__sponsor_crm.sql:72`), so the order is `paid` with `sponsor_id` null. Redeliver: no new `sponsors` row,
      still exactly 1 receipt row, and 1 spy call in total. This kills the `status === "paid"` guard alone.
- [ ] **Step 2: Sweep and scan.** Sweep scenario `sponsor_receipt` (`nl`, `worker`). Scan length: 40.
- [ ] **Step 3: Run red** → `t5`. **Step 4: Implement.** **Step 5: Run green** → `t5b`. Expected: the sweep
  reports `checked: 11`.
- [ ] **Step 6: Mutations.**
  - Drop `order.status === "paid"`: test 10 fails.
  - Drop `order.sponsor_id !== null`: test 9 fails.
  - Fresh once-key: test 3 fails.
  - Enqueue on `sql`: test 5 fails.
  - Evidence back to `getDictionary("en")`: test 6 fails.
- [ ] **Step 7: TSC, LINT and commit.**
  `feat(sponsors): the receipt through the outbox, in the org's language, and the evidence pack quotes it`.

### Task 6: `sponsor_refund`

**Files:**
- Modify `sponsors.ts`: `handleSponsorChargeRefunded` (`:668-713`) and `refundSponsorOrder` (`:620-666`). Modify
  `lib/email.ts`: delete the refund sender and add `sponsorRefundEmail`.
- Test: `sponsor-outbox.test.ts`, `sponsor-checkout.test.ts` (`:424`), the sweep, the scan.

**Interfaces:**
- Produces `queueSponsorRefundReceipt(tx: Tx, order: { id: string; org_id: string; sponsor_name: string; sponsor_email: string; amount_cents: number; currency: string; package_id: string }): Promise<string | null>`.
  - It reads the org and package through `tx` and renders.
  - It runs `tx.savepoint((sp) => enqueueEmailOnce(sp, { kind: "sponsor_refund", refType: "sponsor_order", refId: order.id, dedupeKey: onceKey("sponsor_refund", "sponsor_order", order.id, "refunded"), ... }))`.
  - The render and the savepoint call share one try. The catch is
    `log.error({ err, orderId }, "sponsors: refund notice could not be queued")` and returns `null`.
- `handleSponsorChargeRefunded(charge: Stripe.Charge): Promise<string | null>` calls it after the order update and
  before `update sponsors set status = 'inactive'`, and returns the id. `billing-events.ts:2709` ignores the value.
- `refundSponsorOrder` does `if (id) deferred(() => dispatchNow([id]))`. The webhook path does not dispatch.

- [ ] **Step 1: Write the failing tests.**
  1. `an organiser refund queues one notice to the sponsor, and sends it in the request`. `refunds.create` is mocked
     and the org default is `es`. Expected: `dedupe_key` `<order>:refunded`, then `sent`, and one transport call.
  2. `the webhook after a console refund queues no second notice`. `refundSponsorOrder`, then
     `processStripeEvent(charge.refunded)` for that intent: 1 row, 1 spy call.
  3. `a dashboard refund (webhook only) leaves the first attempt to the worker`: `queued`, `attempts` 0, 0 transport
     calls.
  4. `a refund whose notice cannot be queued is still recorded` (Review Focus 3). Under a key fault:
     `refundSponsorOrder` resolves, the order is `refunded`, the sponsor is `inactive`, there are 0 rows, and
     `log.error` was called with `orderId`.
  5. C4: `a failing SQL statement inside the notice's savepoint rolls back only the savepoint`. Use wave 1 T11's seam
     (re-pinned at T0): the order is `refunded`, there are 0 rows, and it resolves.
  6. `the refund notice's once-key alone`: `queueSponsorRefundReceipt` twice for one order → 1 row.
  7. `rollback: a failing placement update after the notice queued leaves no row`.
     `plantFailingUpdate("sponsors", sponsorId)`: the handler rejects, the order is still `paid`, and there are 0
     rows.
  8. `empty: a partial refund or an unknown intent queues nothing` (`refunded: false`, `pi_unknown` → 0 rows).
- [ ] **Step 2: Sweep and scan.** Sweep scenario `sponsor_refund` (`refundSponsorOrder`, `es`,
  `sponsorRefund.subject`, `request`). Scan length: 39.
- [ ] **Step 3: Run red** → `t6`. **Step 4: Implement.** **Step 5: Run green** → `t6b`. Expected: the sweep
  reports `checked: 12`.
- [ ] **Step 6: Mutations.**
  - Drop the savepoint (enqueue on `tx`): test 5 fails.
  - Enqueue on `sql`: test 7 fails.
  - Fresh once-key: test 6 fails.
  - Widen the transition to `status in ('paid', 'refunded')`: test 2 fails (2 spy calls).
- [ ] **Step 7: TSC, LINT and commit.**
  `feat(sponsors): refund notice through the outbox; a refund is recorded even when its notice cannot queue`.

### Task 7: `sponsor_dispute_alert`, `sponsor_dispute_won`, `sponsor_dispute_lost`

**Files:**
- Modify `sponsors.ts` `handleSponsorDispute` (`:801-905`). Delete `currentOrgOwnerEmail` (`:734-739`). The
  `resolveOrgName` and `resolvePackageName` reads move into `tx` where they render inside one.
- Modify `lib/email.ts`: delete the three senders (`:690-733`) and add three builders.
- Create `server/usecases/__tests__/sponsor-dispute-outbox.test.ts`.
- Test:
  - `sponsor-dispute.test.ts` (the mocks at `:108-190` become row assertions; it imports `seedSponsorOrder`);
  - `dispute-unmatched-retry.test.ts` (`:15`);
  - the sweep, a-kind-body, the scan.

**Interfaces:**
- Consumes `orgOwnerRecipient` (T2), `onceKey` (T1) and the prior amount on `already` (T3).
- **Created.** In `sql.begin(tx)`:
  1. `select dispute_id from sponsor_orders where id = ${order.id} for update`.
  2. The existing update.
  3. If the prior `dispute_id !== dispute.id`: the enqueue (`<id>:created`), then `update sponsors set status = 'pending'`.
- **Won.** In `sql.begin(tx)`:
  1. `select disputed_at … for update`.
  2. The existing update.
  3. If the prior `disputed_at !== null`: the enqueue (`<id>:won`).
  4. Then the sponsors `active` update, unchanged.
- **Lost.** The write-off as today, then the recovery, then `enqueueEmailOnce(sql, …)` (`<id>:lost`) with
  `recoveredCents` from the recovery. No `already` gate.
- The locale for all three is `recipientLocale(sql, { pick: null, userId: owner.userId, orgDefault })`, with the org
  default read with the order.

- [ ] **Step 1: Write the failing tests** (spy as in T2).
  1. `created queues one alert to the owner, for the worker`: owner `fr`, ref `dispute / <id>`, key `<id>:created`.
  2. `a redelivered created queues nothing new`: 1 spy call.
  3. `an older dispute's created after a newer one's does not alert twice`: `a`, `b`, `a` → 2 rows. This kills the
     once-key alone.
  4. `won after created queues one won notice; a redelivered won queues nothing`: 1 won row, 1 won spy call.
  5. `won's once-key alone`: created `a`, won `a`, created `a` again (it re-flags, `coalesce`), won `a` → 1 won row.
  6. `lost queues one notice; a replay with the metadata guard hit queues none`.
  7. `a lost notice refused on the first run is queued by the replay with the prior amount` (Review Focus 2; as T3
     test 3, with `sponsor_order_id` reversal metadata).
  8. `D1: an alert that cannot be queued leaves the placement live`. Under a key fault: it rejects, `sponsors.status`
     is still `active`, and `dispute_id` is unchanged.
  9. `rollback: a failing placement update after the alert queued leaves no row` (`plantFailingUpdate("sponsors", …)`).
  10. `created then lost are two rows, neither replaced`.
  11. `empty: a dispute on a charge that is not a sponsor's queues nothing`.
- [ ] **Step 2: Sweep, body guard, scan.**
  - Sweep scenarios: alert (`fr`), won (owner locale null, org `es`), lost (`nl`). Each is `worker`.
  - Three a-kind-body producers, each with `positive` = the package name.
  - Scan length: 36.
- [ ] **Step 3: Run red** → `t7`. **Step 4: Implement.** **Step 5: Run green** → `t7b`. Expected: the sweep
  reports `checked: 15` and a-kind-body reports `kindsChecked: 6`.
- [ ] **Step 6: Mutations.**
  - Drop `firstFlag`: test 2 fails.
  - Drop `firstClear`: test 4 fails.
  - Fresh once-key on created: test 3 fails. On won: test 5 fails.
  - Restore the `already` gate: test 7 fails.
  - Enqueue on `sql` in created: test 9 fails.
- [ ] **Step 7: TSC, LINT and commit.** `feat(sponsors): dispute alert and outcome notices through the outbox`.

### Task 8: `pass_revoked`

**Files:**
- Modify `lib/billing.ts` `revokePassForRefundedCharge` (`:1051-1062`).
- Modify `billing-events.ts`: `revokePassForRefundedChargeAndNotify` (`:1977-2013`); delete `orgOwnerEmail`
  (`:1956-1964`), which has no other caller (`:2004` is its only one).
- Modify `lib/email.ts`: delete the pass sender (`:735-744`) and add `passRevokedEmail`.
- Move `seedPassOrg` from `lib/__tests__/billing-pass-revoke.test.ts:46-70` into `_money-fixtures.ts`.
- Create `server/usecases/__tests__/pass-revoked-outbox.test.ts`.
- Test:
  - `billing-pass-revoke.test.ts` (`:15`, `:128-166`, repointed to rows);
  - `billing-pass-stream-credits.test.ts` (`:63`, drop the mock);
  - `credit-pack-refund.test.ts` if T0 Step 6 flagged it;
  - the sweep, a-kind-body, the scan.

**Interfaces:**
- `revokePassForRefundedCharge(charge: Stripe.Charge, opts?: { inRevoke?: (tx: Tx, revoked: { org_id: string; competition_id: string }) => Promise<void> }): Promise<boolean>`.
  - `recordPassRefund(intent)` stays first, as today.
  - The delete moves into `sql.begin`, and `inRevoke` runs inside it only when a row was deleted.
  - `invalidateOrgEntitlements` runs after commit.
  - No outbox import in `lib/billing.ts`.
- Produces `queuePassRevokedEmail(tx: Tx, a: { chargeId: string | undefined; orgId: string; owner: { userId: string; email: string }; locale: Locale; args: PassRevokedArgs }): Promise<string | null>`
  (exported from `billing-events.ts`). It uses kind `pass_revoked`, ref `charge / chargeId` and
  `onceKey("pass_revoked", "charge", chargeId)`.
- `revokePassForRefundedChargeAndNotify` reads the owner (`orgOwnerRecipient`) and the locale (org `default_locale`
  added to its ctx select) before the revoke. It passes `inRevoke` only when both `ctx` and an owner exist.
  `reversePassCreditOnRefund` stays after, unchanged.

- [ ] **Step 1: Write the failing tests.**
  1. `a fully refunded pass charge queues one notice to the org owner, for the worker`. Use
     `processStripeEvent(charge.refunded, { id: "ch_<run>", … })` with an owner whose locale is `nl`. Expected:
     - subject `dictionarySubject("nl", "passRevoked.subject", { rung: <nl emails.json "passRevoked.rung.m"> })`;
     - key `ch_<run>`, ref `charge / ch_<run>`;
     - `recipient_user_id` the owner, not `created_by` (`seedPassOrg`'s trap user).
  2. `a later refund event for the same charge queues nothing` (a new event, the same charge): 0 spy calls on the
     second.
  3. `the pass notice's once-key alone`: `queuePassRevokedEmail` twice with one charge → 1 row.
  4. `a partial refund keeps the pass and queues nothing`.
  5. `D1: a notice that cannot be queued keeps the pass, and the retry revokes it and queues once`.
     - Under a key fault: it rejects and the pass row is present.
     - Restore and re-run: the pass is gone, there is 1 row, and there is exactly one `pass_refund` ledger row.
  6. `a charge with no id is refused by name and keeps the pass` (Review Focus 1): `charge.id` undefined →
     `OutboxDedupeKeyError`, the pass is present, 0 rows.
  7. `empty: an org with no owner loses the pass and queues nothing`.
  8. `an L pass names its rung`: `pass_key` `event_pass_l` → `passRevoked.rung.l`.
  9. lib: `inRevoke runs inside the delete's transaction, and only when a pass was deleted`.
     - A callback that throws leaves the pass present.
     - A non-pass charge never calls it.
- [ ] **Step 2: Sweep, body guard, scan.** Sweep scenario `pass_revoked` (`nl`, worker). a-kind-body producer, with
  `positive` = the competition name. Scan length: 35.
- [ ] **Step 3: Run red** → `t8`. **Step 4: Implement.** **Step 5: Run green** → `t8b`. Expected: the sweep
  reports `checked: 16` and a-kind-body reports `kindsChecked: 7`.
- [ ] **Step 6: Mutations.**
  - Call `inRevoke` even when nothing was deleted: test 2 fails.
  - Fresh once-key: test 3 fails.
  - Run `inRevoke` after the commit: test 5 fails (the pass is gone with no row).
- [ ] **Step 7: TSC, LINT and commit.** `feat(billing): pass-revoked notice through the outbox, in the revoke's transaction`.

### Task 9: `trial_ending`

**Files:**
- Modify `billing-events.ts`: `handleTrialWillEnd` (`:2531-2597`; also fix the doc comment at `:2527-2529`) and the
  dispatch (`:2737-2741`). Modify `lib/email.ts`: delete `TrialEndingEmail` and `sendTrialEndingEmail`
  (`:1624-1655`), and add `trialEndingEmail`.
- Move `trialingGroup` from `billing-events-payout-health.test.ts:332-354` into `_money-fixtures.ts` as
  `seedTrialingGroup(opts: { hasPaymentMethod: boolean; planKey?: string; ownerLocale?: string | null; orgDefaultLocale?: Locale })`.
- Create `server/usecases/__tests__/trial-ending-outbox.test.ts`.
- Test: `billing-events-payout-health.test.ts` (`:327-446`, repointed from the mock to rows), the sweep, a-kind-body,
  the scan.

**Interfaces:**
- `handleTrialWillEnd(stripeSub: Stripe.Subscription, eventId: string): Promise<void>`.
- The select adds `s.owner_user_id` and the chosen org's `default_locale`, with the same coalesce choice as `org_slug`.
- The enqueue is
  `enqueueEmailOnce(sql, { kind: "trial_ending", refType: "subscription", refId: resolved.subscriptionId, dedupeKey: onceKey("trial_ending", "subscription", eventId), orgId: null, to: row.owner_email, recipientUserId: row.owner_user_id, transactional: true, expiresAt: expiryWithin(null), ...await trialEndingEmail(args, locale) })`.
- The locale is `recipientLocale(sql, { pick: null, userId: owner_user_id, orgDefault })`.
- The try/catch is removed (P-W2-8).

- [ ] **Step 1: Write the failing tests.**
  1. `a no-card trial queues one transactional warning to the payer, in the payer's language, for the worker`. The
     owner is `fr`. Expected:
     - subject `dictionarySubject("fr", "trialEnding.subject.card", { planName: planLabel("pro"), date })`, where
       `date = new Intl.DateTimeFormat("fr", { dateStyle: "long", timeZone: "UTC" }).format(trialEnd)`;
     - `transactional` true, `recipient_user_id` the payer, ref `subscription / <group>`, `dedupe_key` the event id;
     - `queued` with `attempts` 0.
  2. `a card-on-file trial gets the charge variant` (`trialEnding.subject.charge`).
  3. `the same event processed twice queues one row` (`processStripeEvent` twice with one event).
  4. `a second warning event for the same trial replaces the still-queued first`: two event ids → the first
     `replaced`, the second `queued`, 1 live row.
  5. `D1: a warning that cannot be queued parks the event, and the replay queues it once`.
     - `runEvent` under a key fault rejects, and `billing_events.processed_at` is null.
     - Restore, age the lease past 10 minutes, and `runEvent` → 1 row.
  6. `D4: a payer with no language gets the billing org's default` (`nl`).
  7. `a payer whose account is deleted gets no row, and the event is not parked`.
  8. The two existing no-op cases (unresolvable group, no `trial_end`) assert 0 rows and a resolved promise.
- [ ] **Step 2: Sweep, body guard, scan.**
  - Sweep scenario `trial_ending` (`fr`, the card variant, worker). This is the first sweep row that checks
    `transactional: true` on a wave-2 kind.
  - a-kind-body producer, with `positive` = `/\/settings\/billing/`.
  - Scan length: 34.
- [ ] **Step 3: Run red** → `t9`. **Step 4: Implement.** **Step 5: Run green** → `t9b`. Expected: the sweep
  reports `checked: 17` and a-kind-body reports `kindsChecked: 8`.
- [ ] **Step 6: Mutations.**
  - Producer `transactional: false`: the sweep fails at its facts check.
  - Fresh once-key: test 3 fails.
  - Key on `stripeSub.id` instead of the event id: test 4 fails (no second row).
  - Restore the try/catch: test 5 fails (the event is stamped processed).
- [ ] **Step 7: TSC, LINT and commit.** `feat(billing): trial-ending warning through the outbox, once per Stripe event`.

### Task 10: F7, the replay suite, and closing the lists

**Files:**
- Create `server/usecases/__tests__/billing-events-outbox-replay.test.ts`.
- Modify `outbox-kind-sweep.test.ts` (delete `NOT_YET_MOVED`), `a-kind-body.test.ts` (delete `PRODUCERS_PENDING`) and
  `no-second-path.test.ts`.

**Interfaces:** consumes every T2–T9 producer through `runEvent` (`billing-events.ts:2815`).

- [ ] **Step 1: Write the tests.**
  - **A.** `every webhook kind writes one row, whether its event is redelivered or re-run after a crash`. This covers
    all 9 webhook kinds, which is every wave-2 kind except `sponsor_invoice`. Each uses the `_money-fixtures` /
    `_registration-fixtures` rig and its real Stripe event shape:
    - `charge.dispute.created` / `charge.dispute.closed` with `status` won or lost, and no `charge`, so there is no
      Stripe call;
    - `payment_intent.succeeded` (sponsor metadata);
    - `charge.refunded` (sponsor and pass);
    - `customer.subscription.trial_will_end`.

    For each kind:
    1. `runEvent(e)` is `true`.
    2. `runEvent(e)` is `false` (the P-W2-9 ledger pin).
    3. `update billing_events set processed_at = null, processing_started_at = now() - interval '11 minutes' where id = ${e.id}`.
    4. `runEvent(e)` is `true` (the handler re-ran).
    5. The rows for `(kind, ref_type, ref_id)` number exactly 1.

    A won or lost kind first runs its created event. The suite asserts `checked === 9`, and zero is a failure.
  - **B.** `charge.refunded re-run after a later handler threw gives one notice per product`.
    - `vi.mock("@/lib/credits", importOriginal)`: `recordPackRefund` rejects once (it runs for every refunded charge,
      `billing-events.ts:2045`).
    - For a sponsor charge and a pass charge: `runEvent` rejects, `processed_at` is null, and there is already 1 row,
      because the earlier handler committed it. Age the lease, and `runEvent` resolves `true`. There is still 1 row.
    - For an entry-fee charge: read what the merged `syncRegistrationRefund` queues. If it queues `refund_issued`,
      include it the same way. If it queues nothing, assert 0 rows on both runs as the empty case.
    - The suite asserts `checked >= 2` and states the number.
  - Close the lists:
    - delete `NOT_YET_MOVED` (the sweep asserts `checked === 17`);
    - delete `PRODUCERS_PENDING` (`kindsChecked === 8`);
    - the scan's allowlist is 34 names (49 − 5 − 10) and asserts its length.
- [ ] **Step 2: Run.** VERIFY the new file, the sweep, a-kind-body and the scan → `t10`. Expected: `failed: 0`,
  A `checked: 9`, B `checked: 2` or 3, sweep 17, body 8, allowlist 34.
- [ ] **Step 3: Mutations** (a true red is impossible here, because the producers already exist).
  - `onceKey` returns a fresh key per call: A fails on the kinds guarded by the key alone (expected: `trial_ending`,
    `registration_dispute_lost`, `sponsor_dispute_lost`). Record which legs went red.
  - In `runEvent`, drop the lease condition (`or … < now() - interval '10 minutes'`): step 4 returns `false` and A
    fails. This proves the re-run really re-ran the handler.
- [ ] **Step 4: TSC, LINT and commit.**
  `test(billing): F7 — a redelivered or re-claimed webhook writes no second email row; wave-2 sweep closed at 17`.

### Task 11: Smoke

**Files:**
- Modify `scripts/smoke.ts`:
  - `postSignedStripeWebhook` (`:12008`) gains an optional third parameter `id?: string`;
  - add `checkQueuedOutboxRow` next to `checkOutboxRow`;
  - add `outboxTrialWarningSuite`, called in `main` right after `addonChurnWebhookSuite()`;
  - add `outboxTrialWarning: () => outboxTrialWarningSuite()` at the end of `SELECTABLE_SUITES`.
- Modify `scripts/__tests__/smoke-select.test.ts`: append `"outboxTrialWarning"` to `KNOWN` and its history comment.

**Interfaces:**
- `checkQueuedOutboxRow(kind: string, refType: string, refId: string): Promise<void>`. It uses the keyless early
  return and the connection of `checkSignInOutbox`. Its checks:
  - `<kind>: one outbox row for the ref`
  - `<kind>: left to the worker (queued, no attempt yet)`
  - `<kind>: addressed to the account (recipient_user_id set)`
- `outboxTrialWarningSuite`:
  - It skips with a passing check line when `STRIPE_WEBHOOK_SECRET` is unset, as `addonChurnWebhookSuite` does
    (`:5302-5310`).
  - It signs in a fresh org. Through `smokeDb()` it sets the group's
    `stripe_subscription_id = 'sub_smoke_trial_<tag>'`, `status = 'trialing'` and `has_payment_method = false`.
  - It posts `customer.subscription.trial_will_end` (`trial_end` = now + 3 days) with id
    `evt_smoke_<tag>_trial`, which the teardown's `evt_smoke_` sweep covers, and asserts 200.
  - Then `checkQueuedOutboxRow("trial_ending", "subscription", groupId)`.
  - It re-posts the SAME id: 200, and still one row.
  - In `finally` it deletes `email_outbox` rows `where kind = 'trial_ending' and ref_id = groupId`, because the row's
    org is null and no org teardown reaches it.

- [ ] **Step 1: Write the failing test.** Append to `KNOWN`, then run
  `cd <worktree> && npx vitest run scripts/__tests__/smoke-select.test.ts --reporter=json --outputFile=$OUT/t11.json; echo EXIT=$?`.
  Expected: the registry test fails.
- [ ] **Step 2: Implement** the helper, the suite and the registration.
- [ ] **Step 3: Run the selector test again** (green), and typecheck the scripts project with the repo's command for
  `scripts/`: the image typechecks `scripts/`.
- [ ] **Step 4: Smoke runs on CI.** No local server (standing rule, 2026-10-24). The PR's smoke job runs it. The
  controller pastes its `outbox trial warning` check lines from the PR run. If CI's smoke server has no
  `STRIPE_WEBHOOK_SECRET`, the skip line shows: record it. `ci.yml` sets `whsec_ci_smoke` at `:827`, so the check is
  expected to run.
- [ ] **Step 5: Commit.** `test(smoke): a signed trial_will_end leaves one queued trial_ending row, and a replay none`.

### Task 12: E2E

**Files:** `apps/web/e2e/payments-hardening.spec.ts`, `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts`.

**Interfaces:**
- A local `outboxRows(kind: string, refType: string, refId: string)` in `payments-hardening.spec.ts`, built on its own
  `withDb` (`:90`).
- Expected subjects are read from `src/dictionaries/en/emails.json` by import, never typed.
- No `E2E_PROD_TARGET` skip (C1).

- [ ] **Step 1: Add the assertions and tests.**
  - `T3 · Event Pass refund` (`:516`): after the revoke, one `pass_revoked` row. It has ref `charge / <charge id>`,
    `recipient` = `org.ownerEmail`, `recipient_user_id` not null, `queued`, and the `en` subject with rung
    `passRevoked.rung.m`.
  - `T6` (`:629-735`): created → one `sponsor_dispute_alert` row; lost → one `sponsor_dispute_lost`; won → one
    `sponsor_dispute_won`.
  - `Replay` (`:854`): after the identical re-post, still exactly one `sponsor_dispute_alert` row for the dispute.
  - New `registration dispute: created alerts the owner once`:
    1. `seedStripeDivision` and `submitPublicRegistration`.
    2. Set the group's `payment_intent_id` through `withDb`.
    3. Post `charge.dispute.created` twice with one id, then once with a new event id and the same dispute.
    4. Exactly one `registration_dispute_alert` row.
  - New `trial_will_end queues one transactional warning`. Seed the org's group as trialing through `withDb` and
    post. Expect one `trial_ending` row with `transactional` true and `recipient_user_id` = the owner.
  - Walkthrough (real Stripe sandbox):
    - the invoice leg (`:473`): one `sponsor_invoice` row for the order, no longer waiting (R; CI has no Resend key,
      so it ends `dead`/`no_api_key`), with no body;
    - the paid leg (`:567`): one `sponsor_receipt` row, `queued`;
    - the refund leg (`:696`): one `sponsor_refund` row, no longer waiting.
    - Read its `SKIP_REASON` (`:121-132`) and record whether CI supplies `STRIPE_SECRET_KEY`. If it does not, these
      legs are the spec's "covered on the owner's stg walk": record that.
- [ ] **Step 2: Collect locally, never run.** `cd <worktree>/apps/web && npx playwright test e2e/payments-hardening.spec.ts e2e/walkthrough/settings-sponsor-monetize.spec.ts --list; echo EXIT=$?`.
  Expected: `EXIT=0` with the two new titles listed. Then TSC.
- [ ] **Step 3: Commit.** `test(e2e): wave-2 outbox rows on refund, dispute, trial and the sponsor walkthrough`.
- [ ] **Step 4 (controller).** Dispatch e2e on the PR:
  `gh workflow run e2e.yml --ref feat/email-outbox-phase3-w2 -f pr=<n>`. `payments-hardening.spec.ts` and the
  walkthrough are serial, so treat the red count as a floor and re-run after each fix.

### PR checklist (controller)

- Rebase onto `origin/main`; never merge main in. Re-pin `V<N>`.
- The scoped VERIFY for every file touched by T1–T10 is green. Paste the counts.
- Smoke: the PR's smoke job shows the three `trial_ending` check lines.
- e2e is dispatched (T12 Step 4).
- G-5: readiness log clean.
- Push, open the PR, and hand back. Do not poll CI.

## Conflict scan (pairs of tasks sharing files or interfaces)

| Pair | Shared | Resolution |
|---|---|---|
| T1 → T2…T9 | `outbox-kind-sweep.test.ts`, `a-kind-body.test.ts` (each kind removes its entry) | Sequential. |
| T2…T9, every pair | `lib/email.ts` (each deletes one sender, adds one builder) and `no-second-path.test.ts` (allowlist 43 → 34) | Sequential. The hunks are disjoint, but the allowlist length is a running count. |
| T2 – T3 | `registrations.ts`, `registration-dispute-outbox.test.ts`; T3 deletes `currentOwnerEmail` only after T2 stopped calling it from the created branch | Sequential. |
| T2 → T7, T8 | interface `orgOwnerRecipient` | T2 first. |
| T3 → T7 | interface: the prior amount on `already` (`dispute-recovery.ts`) | T3 first. |
| T4 – T5 – T6 – T7 | `sponsors.ts`; `sponsor-outbox.test.ts` (T4–T6); `sponsor-checkout.test.ts` (T4–T6); `_money-fixtures.ts` (T4 creates; T7 consumes; T8, T9 extend) | Sequential. |
| T7 – (test file) | `sponsor-dispute.test.ts` imports `seedSponsorOrder` (moved by T4) | T4 first. |
| T8 – T9 | `billing-events.ts`, `_money-fixtures.ts` | Sequential. |
| T9 → T10 | T10 drives T2–T9 through `runEvent` | T10 after T9. |
| T10 / T11 / T12 | none of them share a file (`__tests__`, `scripts/`, `e2e/`) | May run in parallel after T9. |
| T4 only | `ui.json` ×4 (if Q1) | None. |
| Wave 1 T13/T14 (merged) → T11/T12 | `scripts/smoke.ts` `SELECTABLE_SUITES`, `smoke-select.test.ts` `KNOWN` (wave 1 appended `registrationOpenFlow`); wave 1's e2e files are disjoint from T12's | Re-read both lists at T0. |
| Peer branches | W2d holds a `V472` too (migration number); any session editing `billing-events.ts` or `sponsors.ts` since wave 1 | `git log origin/main --oneline -- <file>` at T0 and before the PR. Re-pin `V<N>`. |

**Execution order:** T0, T1, T2, T3, T4, T5, T6, T7, T8, T9, then T10 ∥ T11 ∥ T12.

## Owner questions

1. **Q1: the sponsor order notice.** `sponsors.order.sent` reads "Invoice sent — payment link:" (`en/ui.json:472`).
   It is shown after every checkout (`sponsor-packages.tsx:274-286`). It was already untrue when a send failed, and
   with the outbox the invoice may still be retrying when the organiser reads it. D3 rewords three such notices, but
   not this one (the spec's D3 table lists only `reg.remind.notSent`, `officials.inviteEmailFailed` and
   `settings.team.inviteEmail.notSent`).
   - **Recommendation:** reword it in all four locales so it is true in every state. For example: "We're emailing the
     invoice to the sponsor. You can also share this payment link:".
   - Owner value: an organiser whose sponsor says "I never got it" is not misled by the screen. It costs 4 strings
     and one visual check (T4 Step 7).
   - If declined, T4 skips Step 7 and the residual is recorded.
2. **Q2: which owner gets the owner-addressed notices when an org has several owners.**
   - Today two of the three lookups pick an arbitrary owner (`limit 1`, no order).
   - **Recommendation:** the oldest current owner (`order by m.created_at, m.user_id`), never a deleted account. That
     is what `billing-events.ts:1958` and `billing-groups.ts:1199-1202` already do.
   - Owner value: the same person gets every dispute and pass notice, and a transfer moves them all at once.
   - The alternative is mailing every owner, one row each: more mail and a wider replace key. T2 builds the
     recommendation unless the owner rules otherwise.

The controller rules on P-W2-1 to P-W2-12, or puts them to the owner, before T2.

## Next waves and routed findings (not built here)

- a. **Pre-existing (route).** A replayed `won` for an OLDER sponsor dispute clears a NEWER dispute's flag and
  re-activates the placement. `handleSponsorDispute` never compares `dispute.id` with `order.dispute_id` on close
  (`sponsors.ts:849-856`). T7's won once-key keeps the email right; the flag defect is not this wave's.
- b. **Pre-existing (route).** Every replay of a registration `created` writes another `registration.disputed` audit
  row (`registrations.ts:3161-3165`, unconditional). T2 keeps that behaviour.
- c. **Wave 5.** The staff dispute alert (`billing-events.ts:2267`) and T2 m1's staff-kind refusal row.
- d. **Phase 4** (owner, 2026-10-26): no send path bypasses the outbox. Dispatch, the worker and the webhook keep no
  app-render dependencies.

## Self-review

1. **Spec coverage.**
   - The 10 kinds map to T2–T9: alert T2, lost T3, invoice T4, receipt T5, refund T6, three sponsor disputes T7,
     pass T8, trial T9.
   - The wave-2 test row:
     - "sweep of 10" → T2–T9 sweep scenarios, closed at 17 in T10;
     - "`runEvent` twice" → T10 A (with P-W2-9);
     - "`charge.refunded` replayed after a later handler throws" → T10 B;
     - E2E → T12;
     - smoke → T11;
     - F7 regression → T10.
   - The migration rule ("only drops and re-adds `email_outbox_kind_valid`", the `outbox-schema.test.ts:50` literal)
     → T1.
   - §12 expiry → Global Constraints.
   - D4 → every Interfaces block.
2. **Step scan.** Every test step names its test, the fixture locale and the expected values. Every code step names
   the signature, the file and the once-key.
3. **Type consistency.** The following are spelled identically across T1–T10: `onceKey(kind, refType, id, suffix?)`,
   `orgOwnerRecipient(db, orgId) → { userId, email } | null`, `queueSponsorReceipt`, `queueSponsorRefundReceipt`,
   `queuePassRevokedEmail`, `revokePassForRefundedCharge(charge, { inRevoke })` and
   `handleTrialWillEnd(stripeSub, eventId)`.
4. **Review Focus.** Each of the five lines has a test in its owning task: T1 and T8 test 6; T3 test 3 and T7 test 7;
   T6 test 4; `org-owner.test.ts` and T2 test 9; T5 test 6.
5. **Proportion.** Bodies appear only as one-line SQL or call shapes. The rest is signatures, test names and values.
