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
  below;
- this wave's ledger, `.superpowers/sdd/2026-10-26-email-outbox-phase3-wave2/` (`progress.md`, `t0-repin.md`).

**Revision (2026-10-26, wave-2 session).** This text folds in the owner's rulings and trims, the T0 re-pin
(`t0-repin.md`, against `67eb05aedd`) and the controller's T0 rulings (`progress.md`, "T0 complete"). T2–T9 are
regrouped into Batches A–D, still one commit per email. Emails are numbered 1–10 in kind-table order, so a ledger can
say "Batch A / email 1". T1 was dispatched from the pre-revision text plus the controller's T0 rulings; its section
below records the corrected facts its review holds it to.

## Owner ruling (2026-10-26): screenshots

- Q1's screenshots (1280/768/320) come from a ONE-OFF local server (`$S up --label outbox-p3-w2 --server`), used only for that visual check and torn down right after. An exception to the no-local-server rule for this visual check only.

## Owner rulings (2026-10-26, wave-2 session)

- **Q1: yes.** `sponsors.order.sent` becomes en "We're emailing the invoice to the sponsor. You can also share this
  payment link:", with es/fr/nl (Batch B, email 3, Step 7).
- **Q2: the oldest current owner** (`order by m.created_at, m.user_id`), never a deleted account (Batch A, email 1).
- **P-W2-1 / P-W2-2: yes.** Wave 1's P4 exception covers the sponsor invoice (pool enqueue after the mint, logged on
  refusal) and the sponsor refund (R4 savepoint; the refund stays recorded).
- **Mainstream paths only, no test tooling.** The approved trims are folded into the task text. What they leave
  unbuilt is in "Rare cases — recorded, not built". P-W2-4 is not built.
- **Batch same-shape tasks.** One implementer and one review per batch, one commit per email.

## Global Constraints

Everything in the wave-1 plan's Global Constraints (its lines 25–102) applies, with the path, branch and label
replaced as below. The lines that bite in this wave are restated.

- **Worktree.** `/Users/ashokhein/github/seazn.club/.claude/worktrees/outbox-p3-w2`, branch
  `feat/email-outbox-phase3-w2`, cut from `origin/main` at `67eb05aedd` (T0). Prefix every command with
  `cd <that path> &&` or `cd <that path>/apps/web &&`. Never check anything out in the main checkout. Never use
  `git stash` in a worktree.
- **Migration number: `V473`.** Main's max at T0 is `V472` (wave 1). W2d holds a local, unpushed
  `V472__w2d_table_rules.sql`, so W2d will reach for `V473` too. Re-pin right before opening the PR:
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
  `sendTrialEndingEmail` passes `true` (`lib/email.ts:1632`).
- **First attempt (spec column "First").** W kinds get no `dispatchNow`; the worker takes them after the 30 s window.
  R kinds get `deferred(() => dispatchNow([id]))` after commit (`lib/deferred.ts:14`).
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
  - **Mainstream only (owner, 2026-10-26).** No key-fault / KEK-unset tests, no planted-trigger rollbacks, no tests
    for narrow races or for a rare change while a row waits. Such a case gets one line in "Rare cases", not a test.
- **ENV.** Use `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`:
  - `$S up --label outbox-p3-w2`, then `eval "$($S env --label outbox-p3-w2)"`.
  - After a migration edit, run `$S down --label outbox-p3-w2 && $S up --label outbox-p3-w2`.
  - Never run a bare `pnpm db:apply`.
  - Confirm `show data_directory` is this label's (`/tmp/seazn-env/outbox-p3-w2/pg` at T0).
- **VERIFY `<files>` → `tN`** means exactly this, scoped to the listed files (paths relative to `apps/web`):
  ```
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/outbox-p3-w2/apps/web && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label outbox-p3-w2)" && npx vitest run <files> --reporter=json --outputFile=$OUT/tN.json; echo EXIT=$?
  jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests, files: [.testResults[].name]}' $OUT/tN.json
  ```
  - `$OUT` is the executor's own subdirectory of its scratchpad.
  - Green means `EXIT=0`, `failed == 0`, `total` is unchanged or grows as the step says, and every file appears under
    this worktree's path.
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

**Rulings carried from the wave-1 ledger and the T0 ledger (binding here):**
- **R-T1f.** Every key embeds a UUID or a Stripe id, because the once-key index is `(kind, dedupe_key)` with no org.
  This wave enforces it with `onceKey()` (T1), which refuses a missing id. That is a sharper failure than
  `OutboxDedupeKeyError`'s blank check alone: `` `${undefined}:created` `` is not blank.
- **R-T1e.** A cancel frees the once-key, so producers check the thing's state before a re-enqueue. No wave-2 kind is
  cancelled, but each producer still reads its transition under lock before enqueueing (P-W2-5).
- **`claimQueuedRow`** is `email-outbox/attempt.ts:392` and is NOT exported from the index. A test that stages a claim
  imports it from `@/server/email-outbox/attempt`, never a hand copy of the claim statement. No wave-2 test is expected
  to need it.
- **Account vs literal.** `OUTBOX_KIND_FACTS[kind].to` decides. `enqueueEmail` refuses `recipientUserId` on a literal
  kind (`OutboxKindMismatchError`). It does not refuse an account kind that lacks one (the guard is one-directional),
  so every A producer test asserts `recipient_user_id` is the owner's id.
- **C1.** No `E2E_PROD_TARGET` skip in new e2e tests.
- **C2.** The no-second-path scan reads production sources only.
- **C4.** A savepoint is witnessed only by a failing SQL statement inside it, never by a pre-SQL throw. Wave 1 left no
  SQL seam to reuse: `auditGate` (`refund-issued-outbox.test.ts:25-37`) throws in JS before any SQL. Controller ruling
  (T0): email 5's savepoint test spies `enqueueEmailOnce` with a one-shot implementation that runs `select 1/0` on the
  handle it receives. No new helper.
- **T2 m1.** A staff-kind refusal row belongs to wave 5. Not here.
- **G-5.** The PR checklist carries "readiness log clean".
- **Phase-4 note (owner, 2026-10-26).** No send path bypasses the outbox. Dispatch, the worker and the webhook keep no
  app-render dependencies: every wave-2 body renders at enqueue time, and every wave-2 `KIND_HOOKS` entry is `{}`.
- **Changed while queued (owner, 2026-10-26).** A queued row is a snapshot: nothing updates it when a fact it carries
  changes. Each email states in one line which body facts can change while the row waits and what refreshes it
  (re-enqueue → supersede, or cancel), or why nothing can. Code or a test only for a change that is common in normal
  use; the rest is marked "rare — recorded" and listed in Rare cases. No wave-2 email has a common one, so this wave
  adds no supersede or cancel code. Email 10 keeps its one test of the wave-1 replace trigger, because that test is
  also its once-key's only killer. The reviewer checks each line against the producer.
- **Executors re-pin by symbol.** Every line number below is as of `67eb05aedd`. Each email's commit moves the next
  one's lines, so re-pin with `grep -an <symbol>` before editing.

## Plan decisions where the tree contradicts or underdetermines the spec

Each one is a finding to record in the wave's report. All were ruled on 2026-10-26 (see Owner rulings).

| # | Spec says | The tree says | Plan does |
|---|---|---|---|
| P-W2-1 | `sponsor_invoice`: R1/D1. | The order commits in its own `withTenant` (`sponsors.ts:479-487`). The Checkout URL the email carries is minted after that (`:490`). A refusal at that point cannot roll the order back. A 5xx would make the organiser retry, which creates a second order and session. | P4's submit pattern: `assertOutboxCanQueue()` before the order insert, then a pool enqueue after the mint. A refusal there is `log.error`'d and the 201 stands; the organiser already sees the payment link (`components/sponsor-packages.tsx:274-286`). Then `deferred(() => dispatchNow([id]))`. Owner: yes. |
| P-W2-2 | `sponsor_refund`: R1/D1. | The console path calls `refunds.create` (`:642`) before the transition. The webhook path follows a refund that already happened. D1 would roll back the record that money moved. | P4's refund pattern: an R4 savepoint inside the transition transaction (`:674-697`). A refusal is logged and the refund stays recorded. Owner: yes. |
| P-W2-3 | `sponsor_refund` once-key: "refund id". | The console path hands `handleSponsorChargeRefunded` a synthetic charge `{ payment_intent, refunded: true }` (`:650-653`). A webhook `Charge` on API `2026-06-24.dahlia` carries no `refunds` list. Neither path has a refund id. | Key `<order id>:refunded`. Sponsor refunds are full-only (the `charge.refunded` gate, `:673`), and an order goes `paid → refunded` once (`where … status = 'paid'`, `:689`), so the key is one-to-one with the refund. |
| P-W2-4 | The lost notices: `<id>:lost`. | Both are gated on `!recovery.already` (`registrations.ts:3414`, `sponsors.ts:883`). A first run whose enqueue is refused after a reversal was created never writes the notice: the replay hits the metadata guard (`dispute-recovery.ts:75-77`). | **Not built (owner, 2026-10-26).** The `already` gate stays and `dispute-recovery.ts` is unchanged. Rare case 2. |
| P-W2-5 | R6. | The registration created path updates unconditionally and mails every time (`registrations.ts:3360-3383`, F7). The sponsor paths read their transition flags outside any transaction (`sponsors.ts:808-819`, then `firstFlag :825`, `firstClear :851`). | Each created/won transition runs in one `sql.begin`: a `for update` read of the prior `dispute_id` / `disputed_at`, the existing update, then the enqueue, gated on the transition. The once-key backs it up. Each guard is killed alone (emails 1, 6, 7). |
| P-W2-6 | "A = an account" (the owner). | There are three owner lookups. `registrations.ts:3439` and `sponsors.ts:734` use `limit 1` with no order, so with two owners the pick is arbitrary. `billing-events.ts:1958-1964` orders by `m.created_at, m.user_id`, as `billing-groups.ts:1199-1202` does. | One leaf, `orgOwnerRecipient` (email 1), ordered `m.created_at, m.user_id`, skipping deleted accounts. All three copies go (emails 2, 8, 9). Owner Q2: yes. |
| P-W2-7 | `pass_revoked`: R1. | The fact (the pass delete) is in `lib/billing.ts:1056-1058` on the pool, outside any transaction, in a lib module with several test callers. | `revokePassForRefundedCharge` gains an optional `inRevoke(tx, revoked)` callback, run inside a new `sql.begin` around the delete. `lib/billing.ts` imports nothing from the outbox. |
| P-W2-8 | `trial_ending` once-key: the Stripe event id. | The dispatch does not pass the event to the handler (`billing-events.ts:2740`). The handler swallows every send error on purpose (`:2585-2596`; doc `:2527-2529`): "a throw would … re-send the same warning up to three more times". | Pass `event.id`. Remove the try/catch so a refused enqueue parks the event (D1). The old reason no longer holds, because the once-key is the event id, so a re-run writes nothing. The three no-op cases (no group, no live owner, no `trial_end`) still return without a row and without a throw. The refusal itself is not tested (Rare case 1). |
| P-W2-9 | Wave-2 test: "`runEvent` on the same event twice gives one row per kind". | As written this cannot fail. The second `runEvent` returns `false` at the ledger claim (`billing-events.ts:2832`) and never re-runs the handler. | Keep it as a ledger pin. Pair it with the real replay: clear `processed_at` and age `processing_started_at` past the 10-minute lease (`:2830`), so the handler re-runs, and there is still one row (T10). |
| P-W2-10 | D4. | Sponsor orders carry no locale and link to no account. The dispute evidence pack rebuilds the receipt in English on purpose (`sponsors.ts:954-969`: "sponsor emails are sent in en"). | The sponsor kinds use the org default (D4). The evidence pack rebuilds the receipt with the same resolver, so it quotes what was sent. Residual: Rare case 9. |
| P-W2-11 | (wave-1 guard) | `a-kind-body.test.ts` selects rows with the chess-only `split_part(ref_id, ':', 1)` filter (`:70`), and producers return fixture ids (`:51`). | Producers return their own row ids and a positive-pair pattern. The chess producer keeps its filter internally (T1). |
| P-W2-12 | (row org) | A billing group can span several orgs (`billing-events.ts:2552-2561`). | `trial_ending` rows carry `org_id = null`. R3 does not apply, because the handler is outside `withTenant`. |

## Review Focus

These are the conditions the spec implies but no spec test exercises, most likely to hurt a person first. Each line's
test lives in its owning email.

1. **A Stripe object with no id** (a hand-built or synthetic charge: `sponsors.ts:650-653` builds one) must be refused
   by name. It must never be keyed `"undefined"` or `"undefined:created"`: that key would be global per kind (R-T1f)
   and would silently swallow every later email of the kind. Test: T1's `once-key-builder.test.ts`. The
   through-the-producer test was dropped (owner, 2026-10-26; Rare case 6).
2. **A sponsor refund whose notice cannot be queued** is still recorded: the order is `refunded`, the placement is
   off, and the console refund call does not 5xx after money moved (P-W2-2). Test: Batch B, email 5, test 4.
3. **An org with two owners**, or one whose owner was transferred, mails exactly one deterministic owner: the oldest
   current owner, never a deleted account (P-W2-6, Q2). Tests: `org-owner.test.ts` and Batch A, email 1, test 8.
4. **The sponsor evidence pack** quotes the receipt in the language it was sent in, not English (P-W2-10). Test:
   Batch B, email 4, test 4.

## Rare cases — recorded, not built

Owner rule (2026-10-26): mainstream paths only. A misconfigured server, a provider outage, a narrow race, or a fact
changing while a row waits in retry is not designed, built or tested. Each gets one line here. Fix one only if money or
data is lost or a secret's value leaks.

1. **Key fault** (the KEK unset or bad on a box with a Resend key; it is set on stg and prod). Every D1 producer
   refuses and Stripe retries the event. The sponsor checkout refuses before any order (`assertOutboxCanQueue`). The
   trial warning parks its event (no try/catch). The code shapes stay; no test.
2. **A lost-dispute notice (registration or sponsor) whose first enqueue was refused after a reversal was created.**
   The replay hits the reversal guard (`already`) and does not queue it (P-W2-4 not built). Without a reversal (no
   charge, no transfer, nothing to reverse, recovery failed), the replay does queue it.
3. **A sponsor invoice refused after its order and Checkout session exist** is `log.error`'d and the 201 stands. The
   organiser has the link to share. Nothing re-queues it, and no test drives it.
4. **A sponsor refund notice refused inside its savepoint** is lost after a `log.error`. The refund is recorded
   (email 5, test 4), but nothing re-queues the notice.
5. **A later statement in the same transaction failing after the row queued (rollback).** This is witnessed only for
   email 1 (the audit gate) and email 5 (the savepoint). The receipt and the sponsor alert are checked by the enqueue
   handle (not the pool), not by a rollback.
6. **A Stripe charge with no id reaching the pass producer.** `onceKey` refuses it by name (T1's unit test). It is
   not driven through the producer.
7. **`charge.refunded` re-run after a later handler in the same dispatch threw.** Each earlier handler's row has
   committed, and its once-key holds on the re-run. Not tested (the old T10 B is dropped).
8. **Changed while queued** (each email's line). A rename (org, competition, entrant, package) while a row waits. A
   sponsor paying through the shared link while the invoice is in provider retry. A refund landing before the worker
   sends the receipt (the refund notice can arrive first). The payer adding a card inside the trial warning's worker
   window. An ownership transfer while an owner-addressed row waits (it goes to the previous owner).
9. **An org that changes its default language between the receipt and a dispute** gets an evidence pack in the new
   language (P-W2-10).

## The ten kinds

All are `transactional: false` except `trial_ending`. Each is written with `expiresAt: expiryWithin(null)`. Producers
import from `@/server/email-outbox` (the index), so the tests' enqueue spy can see them. Lines are as of `67eb05aedd`.

| # | Kind (spec order) | Sender deleted (email.ts) | Builder added | Producer | To | First | `ref_type / ref_id` | Once-key (`onceKey(...)`) | Org | Locale (`recipientLocale`) | Changed while queued |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `registration_dispute_alert` | `sendDisputeAlertEmail` :611 | `disputeAlertEmail` | `registrations.ts` `handleRegistrationDispute` :3342, created :3360-3383 | A: org owner | W | `dispute / <dispute.id>` | `<dispute.id>:created` | `reg.org_id` | pick null, owner id, `ctx.default_locale` | A rename only: rare — recorded. The close is days later and is its own kind. |
| 2 | `registration_dispute_lost` | `sendDisputeLostEmail` :624 | `disputeLostEmail` | same, lost :3391-3433 | A: org owner | W | `dispute / <dispute.id>` | `<dispute.id>:lost` | `reg.org_id` | same | Write-off and recovered amount are fixed at the close. A rename only: rare — recorded. |
| 3 | `sponsor_invoice` | `sendSponsorInvoiceEmail` :636 | `sponsorInvoiceEmail` | `sponsors.ts` `startSponsorCheckout` :453-536 | L: `input.sponsor_email` | R | `sponsor_order / <order.id>` | `<order.id>` | `auth.orgId` | pick null, user null, org default | R, so it waits only on a provider failure. The link cannot outlive its session (the row expires first). Paid via the shared link during a retry: rare — recorded. |
| 4 | `sponsor_receipt` | `sendSponsorReceiptEmail` :648 | `sponsorReceiptEmail` | `handleSponsorPaymentSucceeded` :549-598 | L: `order.sponsor_email` | W | `sponsor_order / <order.id>` | `<intent.id>` | `order.org_id` | org default | A refund inside the worker window (its R notice may arrive first): rare — recorded. |
| 5 | `sponsor_refund` | `sendSponsorRefundEmail` :660 | `sponsorRefundEmail` | `handleSponsorChargeRefunded` :668-712, console `refundSponsorOrder` :620-659 | L | R (console) / W (webhook) | `sponsor_order / <order.id>` | `<order.id>:refunded` (P-W2-3) | `order.org_id` | org default | Terminal: an order goes `paid → refunded` once. Nothing can change. |
| 6 | `sponsor_dispute_alert` | `sendSponsorDisputeAlertEmail` :672 | `sponsorDisputeAlertEmail` | `handleSponsorDispute` :801, created :822-847 | A: org owner | W | `dispute / <dispute.id>` | `<dispute.id>:created` | `order.org_id` | owner, org default | As email 1. |
| 7 | `sponsor_dispute_won` | `sendSponsorDisputeWonEmail` :702 | `sponsorDisputeWonEmail` | won :849-871 | A | W | `dispute / <dispute.id>` | `<dispute.id>:won` | `order.org_id` | same | Terminal for the dispute; a later dispute is a new id and new rows. Nothing can change. |
| 8 | `sponsor_dispute_lost` | `sendSponsorDisputeLostEmail` :687 | `sponsorDisputeLostEmail` | lost :873-898 | A | W | `dispute / <dispute.id>` | `<dispute.id>:lost` | `order.org_id` | same | Terminal; the recovered amount is fixed at the close. Nothing can change. |
| 9 | `pass_revoked` | `sendPassRevokedEmail` :717 | `passRevokedEmail` | `billing-events.ts` `revokePassForRefundedChargeAndNotify` :1977-2012 + `lib/billing.ts` `revokePassForRefundedCharge` :1051-1062 | A: org owner | W | `charge / <charge.id>` | `<charge.id>` | `ctx.org_id` | owner, org default | Terminal: the pass row is gone. A pass bought again does not make the notice untrue. |
| 10 | `trial_ending` | `sendTrialEndingEmail` :1620 | `trialEndingEmail` | `handleTrialWillEnd` :2531-2597, dispatch :2740 | A: `subscriptions.owner_user_id` | W | `subscription / <group id>` | `<event.id>` | null (P-W2-12) | payer, billing org default | A changed trial (a second `trial_will_end`, new event id) writes a new row that replaces a still-queued first one through the wave-1 replace trigger (kind + ref + `recipient_user_id`): no new code. A card added inside the worker window: rare — recorded. |

Owner-addressed (A) rows resolve the account's address at send, so an owner's email change while a row waits is
already handled. An ownership transfer while it waits is Rare case 8.

**Builder convention (wave 1 Task 8).** `<name>Email(args: <Template>Args, locale: Locale): Promise<EmailContent>`,
where `EmailContent` is `lib/email.ts:298`. It is `getDictionary(locale, "emails")` plus the existing template from
`lib/email-templates/*` (`refundIssuedEmail`, `lib/email.ts:600-603`, is the model). `trialEndingEmail` keeps the
`billingUrl` computation from `lib/email.ts:1621-1631`, and its args are
`{ planName: string; trialEnd: string; hasPaymentMethod: boolean; orgSlug: string | null }`.

**Interfaces consumed from wave 1** (re-pinned at T0, `67eb05aedd`):
- From `@/server/email-outbox`: `enqueueEmailOnce` (`enqueue.ts:161`), `expiryWithin` (`:102`),
  `OutboxDedupeKeyError` (`:74`), `assertOutboxCanQueue` (`seal.ts:71`), `dispatchNow` (`attempt.ts:426`),
  `recipientLocale(db, { pick, userId, orgDefault }): Promise<Locale>` (`locale.ts:20`).
- `forEachOutboxKind` (`:162`), `KindScenario` (`:30`), `bornAgo` (`:50`) and `dictionarySubject` (`:66`), in
  `email-outbox/__tests__/_kind-harness.ts`. `dictionarySubject` reads any key of `emails.json`, not only subjects.
- `SPEC_KINDS` (`:74`) and `SPEC_FACTS` (`:85`) in `outbox-kind-sweep.test.ts`. `outbox-schema.test.ts` keeps its own
  local `SPEC_KINDS` (`:51`).
- In `email-outbox/__tests__/_kind-senders.ts` (not in `no-second-path.test.ts`, which imports them at `:28`):
  `SENDER_ALLOWLIST` (`:30-75`, 44 names), `NOT_YET_MOVED` (`:79`, `[]`), `KIND_DIRECT_SENDER` (`:82`) and the derived
  `allowlistLengthFor` (`:26`).
  - **Moving a kind** (HANDOFF): drop it from `NOT_YET_MOVED`, drop its `send*` from `SENDER_ALLOWLIST` and from
    `lib/email.ts`, and set its `KIND_DIRECT_SENDER` entry to `null`. The allowlist length is derived. Never type a
    length.
- `checkOutboxRow` (`scripts/smoke.ts:9007`) and `checkSignInOutbox` (`:8978`).
- `stubOutboxEnv` (`server/usecases/__tests__/_invite-mail.ts:114`).
- The `auditGate` mock pattern (`refund-issued-outbox.test.ts:25-37`), a JS throw from `audit`. Email 1's rollback
  test uses it. It is not a savepoint seam (C4).

## File map

| File | Responsibility | Where |
|---|---|---|
| `db/migration/deltas/V473__email_outbox_phase3_wave2.sql` (create) | kind CHECK, 17 kinds | T1 |
| `apps/web/src/server/email-outbox/constants.ts` | `OUTBOX_KINDS` 17, `OUTBOX_KIND_FACTS` 17 | T1 |
| `apps/web/src/server/email-outbox/hooks.ts` | `KIND_HOOKS` gains ten `{}` | T1 |
| `apps/web/src/server/email-outbox/enqueue.ts`, `index.ts` | `onceKey` | T1 |
| `apps/web/src/server/email-outbox/__tests__/_kind-senders.ts` | the ten in `NOT_YET_MOVED` and `KIND_DIRECT_SENDER`; `allowlistLengthFor` re-derived (T1); each email's three-list move | T1, emails 1–10 |
| `apps/web/src/server/usecases/org-owner.ts` (create) | `orgOwnerRecipient` (leaf) | email 1 |
| `apps/web/src/server/usecases/registrations.ts` | dispute alert and lost; delete `currentOwnerEmail` | emails 1, 2 |
| `apps/web/src/server/usecases/sponsors.ts` | invoice, receipt, refund, three disputes, evidence locale; delete `currentOrgOwnerEmail` | emails 3–8 |
| `apps/web/src/lib/billing.ts` | `inRevoke` seam | email 9 |
| `apps/web/src/server/usecases/billing-events.ts` | pass revoked (delete `orgOwnerEmail`), trial ending, dispatch passes `event.id` | emails 9, 10 |
| `apps/web/src/lib/email.ts` | ten senders become ten builders | emails 1–10 |
| `apps/web/src/server/usecases/__tests__/_money-fixtures.ts` (create) | `seedSponsorOrg`, `seedSponsorOrder`, `seedPassOrg`, `seedTrialingGroup` (moved or generalised from existing suites; no new tooling) | emails 3, 4, 9, 10 |
| `apps/web/src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts`, `a-kind-body.test.ts`, `outbox-schema.test.ts`, `once-key-builder.test.ts` (create) | lists, scenarios, producers | T1, emails, T10 |
| new suites under `apps/web/src/server/usecases/__tests__/` | per-email producer tests, F7 replay | Batches A–D, T10 |
| `scripts/smoke.ts`, `scripts/__tests__/smoke-select.test.ts` | the trial-warning smoke | T11 |
| `apps/web/e2e/payments-hardening.spec.ts`, `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts` | row assertions | T12 |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` | `sponsors.order.sent` (Q1 approved) | email 3 |

---

### Task 0: Preconditions and environment (no commit) — DONE 2026-10-26

Results are in `.superpowers/sdd/2026-10-26-email-outbox-phase3-wave2/` (`progress.md`, `t0-repin.md`).

- [x] **Step 1: Wave 1 has merged.** PR #1035, `67eb05aedd`.
- [x] **Step 2: Worktree.** `.claude/worktrees/outbox-p3-w2` on `feat/email-outbox-phase3-w2` at `origin/main`.
- [x] **Step 3: Migration number.** `V473` (main's max `V472`). W2d's local `V472` will collide: re-pin before the PR.
- [x] **Step 4: Wave 1's merged names.** Re-pinned above ("Interfaces consumed from wave 1"). Differences from the
  pre-revision text: the three lists live in `_kind-senders.ts`; `NOT_YET_MOVED` still exists (empty);
  `claimQueuedRow` is not in the index; there is no wave-1 SQL savepoint seam. `SENDER_ALLOWLIST` has 44 names,
  the sweep closes at `SPEC_KINDS.length` (7), and `SPEC_ACCOUNT_KINDS` is `["chess_invite"]`.
- [x] **Step 5: Producers and test citations re-pinned by symbol** (this text).
- [x] **Step 6: Mocks.** Every `vi.mock("@/lib/email")` that reaches a wave-2 producer spreads `importOriginal`
  (`credit-pack-refund.test.ts:28` spreads; `relay-checkout.test.ts:30` does not, and drives no wave-2 producer). No
  mock needs an `importOriginal` fix.
- [x] **Step 7: Env.** Label `outbox-p3-w2`, `data_directory` `/tmp/seazn-env/outbox-p3-w2/pg`.

### Task 1: Vocabulary, schema and the once-key builder

> T1 was dispatched from the pre-revision text plus the controller's T0 rulings. The facts below are the corrected
> ones (the re-pin proved the pre-revision file citations wrong). The T1 review holds it to this text.

**Files:**
- Create `db/migration/deltas/V473__email_outbox_phase3_wave2.sql`. It has one statement, in the shape of V472's
  (`V472__email_outbox_phase3_wave1.sql:57-59`):
  `alter table email_outbox drop constraint email_outbox_kind_valid, add constraint email_outbox_kind_valid check (kind in (<17>))`.
- Modify:
  - `email-outbox/constants.ts`: `OUTBOX_KINDS` appends the ten kinds in kind-table order (emails 1–10), plus
    `OUTBOX_KIND_FACTS`;
  - `hooks.ts`: ten `{}`;
  - `enqueue.ts` and `index.ts`: `onceKey`;
  - `__tests__/_kind-senders.ts`:
    - `NOT_YET_MOVED` becomes the ten;
    - `KIND_DIRECT_SENDER` gains ten entries, each naming its kind's current `send*` (kind-table column 3);
    - `allowlistLengthFor` is re-derived so the length stays derived: 44 with ten unmoved, 34 with none
      (49 − 5 − 10). For example, a typed `KINDS_MOVED_IN_WAVE_2 = 10` beside `KINDS_MOVED_IN_WAVE_1`.
      `SENDER_ALLOWLIST` itself is unchanged (44).
- Test:
  - `__tests__/outbox-schema.test.ts`: the local `SPEC_KINDS`, title and `toBe(7)` (`:49-56`). The live-CHECK test
    (`:228-242`) compares against `OUTBOX_KINDS`, so it follows by itself.
  - `outbox-kind-sweep.test.ts`: `SPEC_KINDS` (`:74`), `SPEC_FACTS` (`:85`), the registry test (`:135-138`), the
    legend (`:140-147`), the lists-agree test's two "wave 1 is closed" asserts (`:173-174`), and the final count
    (`:464-466`).
  - `a-kind-body.test.ts`: `SPEC_ACCOUNT_KINDS` (`:33`), `PRODUCERS` (`:51`), the `split_part` select (`:70`).
  - create `__tests__/once-key-builder.test.ts`.
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
    typed list is the 7 plus the ten in table order, and its length is 17.
  - `outbox-kind-sweep.test.ts`:
    - `SPEC_KINDS`: 17 in that order; the registry test asserts 17.
    - `SPEC_FACTS` gains the ten, typed from the spec legend.
    - Retitle the legend test to `the legend has NINE literal kinds, EIGHT account kinds and no staff kind`. It
      asserts:
      - `by("literal")` equals `["magic_link", "registration_confirmation", "payment_reminder", "registration_promoted", "refund_issued", "solo_signup_assigned", "sponsor_invoice", "sponsor_receipt", "sponsor_refund"]`;
      - `by("account")` equals `["chess_invite", "registration_dispute_alert", "registration_dispute_lost", "sponsor_dispute_alert", "sponsor_dispute_won", "sponsor_dispute_lost", "pass_revoked", "trial_ending"]`;
      - the transactional ones are `["magic_link", "chess_invite", "trial_ending"]`.
    - The lists-agree test: the `NOT_YET_MOVED` `toEqual([])` and the "none still names a direct sender" asserts
      (`:173-174`) hold only once every kind has moved. While the list is non-empty, drop them; T10 restores them.
      The equivalence loop and the derived-length assert stay as they are.
    - The sweep's final count (`:464-466`): `checked` is `SPEC_KINDS.length - NOT_YET_MOVED.length` (7 now), and
      `kinds` is `SPEC_KINDS` minus `NOT_YET_MOVED`, in order.
  - `a-kind-body.test.ts`:
    - `SPEC_ACCOUNT_KINDS` is the eight account kinds above.
    - Add `PRODUCERS_PENDING`: the seven new account kinds. Each email removes its entry, and T10 deletes the list.
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
- [ ] **Step 3: Implement** the migration, constants, facts, hooks, `onceKey`, the index export and the
  `_kind-senders.ts` edits. Then run the env down/up.
- [ ] **Step 4: Run green.** VERIFY → `t1b`. Expected: `failed: 0`; the sweep reports `checked: 7`; the lists-agree
  test passes with ten unmoved kinds and a 44-name allowlist; `a-kind-body` reports `kindsChecked: 1`.
- [ ] **Step 5: Mutations.**
  - In `onceKey`, drop the `typeof` check: the `undefined` case returns `"undefined:created"` and fails.
  - In the migration, omit `trial_ending` from the CHECK (env down/up around it): the schema test fails.
  - In facts, flip `pass_revoked` to `literal`: the a-kind-body declared-kinds test fails.
- [ ] **Step 6: TSC** (it catches a missing `KIND_HOOKS` or `KIND_DIRECT_SENDER` key), **LINT**, then commit:
  `feat(email-outbox): wave-2 kinds in the vocabulary, and a once-key builder that refuses a missing id`.

---

## Batches A–D: the ten emails

Each batch goes to one implementer and one review. Inside a batch the emails run in the order given, **one commit per
email**: its producer, its builder, its sender deletion, its three-list move and its tests together (the cutover
rule). Every email follows the same steps:

1. Write the failing tests.
2. Add the sweep scenario (and the a-kind-body producer for an A kind), and make the three-list move.
3. Run red.
4. Implement.
5. Run green, with the stated counts.
6. Mutate each listed guard once.
7. TSC, LINT and commit.

**Shared by every batch:**
- **Enqueue spy** (one line, no helper):
  `vi.mock("@/server/email-outbox", async (io) => { const m = await io<typeof import("@/server/email-outbox")>(); return { ...m, enqueueEmailOnce: vi.fn(m.enqueueEmailOnce) }; })`.
  Tests mock only the transport (`@/server/email-outbox/transport`) and run `stubOutboxEnv()` in `beforeEach`.
- **Sweep scenarios** live in `outbox-kind-sweep.test.ts`. Their recipients must start with the sweep's `RUN` prefix,
  and their org and user ids go in its `made` lists, because its cleanup finds rows that way. Fixture seeders therefore
  take an address prefix.
- **Do NOT touch, in any batch:** the migration, `constants.ts`, `hooks.ts`, `enqueue.ts`, `index.ts` (T1);
  `email-outbox/*.ts` production modules; `_kind-harness.ts`; `dispute-recovery.ts` (P-W2-4 not built); any `send*` or
  builder in `lib/email.ts` other than the batch's own; another batch's producer or test file; `scripts/`, `e2e/`.
  A batch that finds it must touch one of these stops and reports.
- **Output cap for the batch report:** final message under 15 lines — per email: commit sha, the VERIFY counts pasted
  (`total/passed/failed`), sweep `checked`, a-kind-body `kindsChecked`, the derived allowlist length, each mutation and
  the test that killed it; then deviations and blockers. No file contents or diffs.

Expected running counts after each email (the sweep's `checked`, a-kind-body's `kindsChecked`, the derived allowlist):

| After | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| sweep `checked` | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 |
| `kindsChecked` | 2 | 3 | 3 | 3 | 3 | 4 | 5 | 6 | 7 | 8 |
| allowlist | 43 | 42 | 41 | 40 | 39 | 38 | 37 | 36 | 35 | 34 |

### Batch A — registration disputes (emails 1–2; old T2, T3)

**Dispatch.**
- **Files:**
  - create `apps/web/src/server/usecases/org-owner.ts`;
  - create `apps/web/src/server/usecases/__tests__/org-owner.test.ts` and `registration-dispute-outbox.test.ts`;
  - modify `apps/web/src/server/usecases/registrations.ts` (`handleRegistrationDispute` and `currentOwnerEmail` only),
    `apps/web/src/lib/email.ts` (two senders → two builders), `_kind-senders.ts`, `outbox-kind-sweep.test.ts`,
    `a-kind-body.test.ts`, `server/usecases/__tests__/registrations.test.ts`.
- **Acceptance:** two commits; each email's VERIFY green with the counts in the table above; every listed mutation
  killed by its named test; TSC `EXIT=0`; LINT `0 problems` on the touched files.
- **Do NOT touch:** `sponsors.ts`, `billing-events.ts`, `lib/billing.ts`. Batches C and D replace their own owner
  lookups with `orgOwnerRecipient`. Also nothing from the shared list.
- **VERIFY (scoped):**
  `src/server/usecases/__tests__/org-owner.test.ts src/server/usecases/__tests__/registration-dispute-outbox.test.ts src/server/usecases/__tests__/registrations.test.ts src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts src/server/email-outbox/__tests__/a-kind-body.test.ts src/server/email-outbox/__tests__/no-second-path.test.ts`
- **Output cap:** as in "Shared by every batch".

#### Batch A / email 1: `registration_dispute_alert`, and the one owner lookup

**Files:**
- Create `org-owner.ts`, `org-owner.test.ts` and `registration-dispute-outbox.test.ts`.
- Modify `registrations.ts`: the created branch of `handleRegistrationDispute` (`:3360-3383`; owner lookup `:3370`,
  send `:3372`). `currentOwnerEmail` stays until email 2 (the lost branch still calls it).
- Modify `lib/email.ts`: delete `DisputeAlertEmail` and `sendDisputeAlertEmail` (`:605-615`); add
  `disputeAlertEmail`.
- Test: the sweep, `a-kind-body.test.ts`, `_kind-senders.ts` (the scan reads it).

**Interfaces:**
- Produces `orgOwnerRecipient(db: Tx | typeof sql, orgId: string): Promise<{ userId: string; email: string } | null>`.
  - It runs
    `select m.user_id, u.email from org_members m join users u on u.id = m.user_id and u.deleted_at is null where m.org_id = $1 and m.role = 'owner' order by m.created_at, m.user_id limit 1`.
  - It imports only `@/lib/db`, so it is a leaf. The registration, sponsor and billing modules import it without the
    cycle that kept `currentOrgOwnerEmail` a copy (`sponsors.ts:730-733`).
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

**Changed while queued:** org, competition, entrant name, amount and ref code are fixed when the dispute opens. A rename
while it waits is rare — recorded. The close is days later and is its own kind. No code, no test.

- [ ] **Step 1: Write the failing tests.** Rigs come from `_registration-fixtures.ts` (`stripeRig`,
  `seedRegistration`, `fakeSession`, `makeUser`).
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
    7. `rollback: a failing audit leaves no alert`. The `auditGate` mock pattern (`refund-issued-outbox.test.ts:25-37`)
       fails `audit` once. The handler rejects, there are 0 rows and `dispute_id` is null.
    8. `ownership transfer: the alert goes to the current owner`. Flip the roles as `registrations.test.ts:3132`
       does: `recipient_user_id` is the new owner.
    9. `after a withdrawal: a dispute on a withdrawn, refunded entry still alerts`: 1 row. The chargeback is about
       money, whatever the entry's state.
- [ ] **Step 2: Sweep, body guard, three lists.**
  - Sweep scenario `registration_dispute_alert`: the real created handler on a stripeRig cart, owner `fr`,
    `disputeAlert.subject`, `{ competitionName }`, `worker`.
  - a-kind-body producer: the same rig. It returns the row ids, with `positive` = the competition name. Remove the
    kind from `PRODUCERS_PENDING`.
  - The three-list move for `sendDisputeAlertEmail` (derived allowlist 43).
- [ ] **Step 3: Run red.** VERIFY Batch A's files → `a1`.
- [ ] **Step 4: Implement** to the Interfaces.
- [ ] **Step 5: Run green.** VERIFY → `a1b`. Expected: `failed: 0`; the sweep reports `checked: 8`; a-kind-body
  reports `kindsChecked: 2`; `org-owner` reports `checked: 5`.
- [ ] **Step 6: Mutations.**
  - Drop `prior.dispute_id !== dispute.id`: test 2 fails (2 spy calls).
  - Give `onceKey` a fresh suffix per call: test 3 fails (3 rows).
  - Enqueue on `sql` instead of `tx`: test 7 fails (an orphan row).
  - Drop `order by` in `orgOwnerRecipient`: owner case 2 fails.
  - Drop `u.deleted_at is null`: owner case 4 fails.
- [ ] **Step 7: TSC, LINT and commit.**
  `feat(registrations): dispute alert through the outbox, once per dispute, to one deterministic owner`.

#### Batch A / email 2: `registration_dispute_lost`

**Files:**
- Modify `registrations.ts`: the lost branch (`:3391-3433`; recovery `:3411`, the `if (!recovery.already)` gate
  `:3414` STAYS, send `:3417`). Delete `currentOwnerEmail` and its doc comment (`:3437-3444`): no caller remains.
- Modify `lib/email.ts`: delete `DisputeLostEmail` and `sendDisputeLostEmail` (`:617-628`); add `disputeLostEmail`.
- Test:
  - `registrations.test.ts`:
    - drop `disputeLost` from `emailMock` (`:50`) and from the factory (`:66`);
    - add `disputeLostEmail: vi.fn(actual.disputeLostEmail)` to that factory (it already spreads `importOriginal`),
      so the recovered amount is read at the builder's input;
    - repoint every `emailMock.disputeLost` assertion (`:2976-2977`, `:3006`, `:3030`, `:3126`, `:3152-3153`) to
      outbox rows plus that spy.
  - `registration-dispute-outbox.test.ts`, the sweep, a-kind-body, `_kind-senders.ts`.

**Interfaces:**
- The lost branch, after the recovery and inside the kept `!recovery.already` gate:
  - read the owner and the locale as in email 1;
  - `enqueueEmailOnce(sql, …)` with kind `registration_dispute_lost`, `dedupeKey: onceKey(kind, "dispute", dispute.id, "lost")`,
    `orgId: reg.org_id`, `to: owner.email`, `recipientUserId: owner.userId`, `transactional: false`,
    `expiresAt: expiryWithin(null)`, and `disputeLostEmail({ …, recoveredCents: recovery.recoveredCents, consoleUrl }, locale)`.
    `consoleUrl` is unchanged.
  - There is no catch (D1). A refusal after a reversal is Rare case 2.

**Changed while queued:** the write-off and the recovered amount are fixed at the close. A rename while it waits is
rare — recorded.

- [ ] **Step 1: Write the failing tests.** Tests 1–5 are the existing `registrations.test.ts` tests, repointed. Their
  titles stay, and the expected amounts come from the reversal mock, never from the code.
  1. (`:2925` `lost dispute reverses the club's net share…`) One `registration_dispute_lost` row: `dedupe_key`
     `<dispute id>:lost`, `queued`, `attempts` 0, `recipient_user_id` the owner. The builder spy is called with
     `recoveredCents` equal to the reversal mock's amount.
  2. (`:3011` `replayed lost event short-circuits on the metadata guard…`) The reversal is created once, there is 1 row,
     and the builder spy was called once.
  3. (`:2986` `write-off lands even when the reversal throws…`) 1 row; the spy has `recoveredCents: 0`.
  4. (`:3132` `dispute-lost email goes to the CURRENT owner…`) `recipient_user_id` is the new owner.
  5. (`:3101` `won dispute never touches transfers`) 0 lost rows.
  6. New in `registration-dispute-outbox.test.ts`:
     `one dispute's alert and lost notice are two rows, and neither replaces the other`. Created, then lost: both
     rows are `queued`.
- [ ] **Step 2: Sweep, body guard, three lists.**
  - Sweep scenario: a lost dispute with no `charge`, so the recovery is skipped and Stripe is not called. The owner
    has `users.locale` null and the org default is `es`. `disputeLost.subject`, `worker`.
  - a-kind-body producer, with `positive` = the competition name.
  - The three-list move for `sendDisputeLostEmail` (42).
- [ ] **Step 3: Run red** → `a2`. **Step 4: Implement.** **Step 5: Run green** → `a2b`. Expected: the sweep
  reports `checked: 9` and a-kind-body reports `kindsChecked: 3`; `registrations.test.ts`'s total is unchanged.
- [ ] **Step 6: Mutations.**
  - Drop the `!recovery.already` gate: test 2 fails (the spy sees 2 calls; the once-key still keeps 1 row).
  - A fresh once-key per call has no killer in this commit, because with a reversal the gate stops the replay first.
    T10 A's no-charge replay kills it. Record that.
- [ ] **Step 7: TSC, LINT and commit.** `feat(registrations): dispute-lost notice through the outbox, once per dispute`.

### Batch B — sponsor invoice, receipt, refund (emails 3–5; old T4–T6)

**Dispatch.**
- **Files:**
  - create `apps/web/src/server/usecases/__tests__/_money-fixtures.ts` and `sponsor-outbox.test.ts`;
  - modify `apps/web/src/server/usecases/sponsors.ts`: `startSponsorCheckout`, `handleSponsorPaymentSucceeded`,
    `buildSponsorDisputeEvidence`, `refundSponsorOrder`, `handleSponsorChargeRefunded` only;
  - modify `apps/web/src/lib/email.ts` (three senders → three builders), `_kind-senders.ts`,
    `outbox-kind-sweep.test.ts`, `server/usecases/__tests__/sponsor-checkout.test.ts`,
    `sponsor-dispute.test.ts` (the seeder import only), `sponsor-order-delete-guards.test.ts`;
  - modify `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (`sponsors.order.sent` only), then regenerate the
    i18n keys.
- **Acceptance:** three commits; each email's VERIFY green with the counts in the table; every listed mutation killed;
  `pnpm i18n:check` clean; TSC `EXIT=0`; LINT `0 problems`. The controller collects the email 3 screenshots.
- **Do NOT touch:** `handleSponsorDispute` and `currentOrgOwnerEmail` (Batch C), `registrations.ts`,
  `billing-events.ts` (it ignores `handleSponsorChargeRefunded`'s new return value), `a-kind-body.test.ts` (these
  are L kinds), and nothing from the shared list.
- **VERIFY (scoped):**
  `src/server/usecases/__tests__/sponsor-outbox.test.ts src/server/usecases/__tests__/sponsor-checkout.test.ts src/server/usecases/__tests__/sponsor-dispute.test.ts src/server/usecases/__tests__/sponsor-order-delete-guards.test.ts src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts src/server/email-outbox/__tests__/no-second-path.test.ts`
- **Output cap:** as in "Shared by every batch", plus the four `sponsors.order.sent` strings as committed.

#### Batch B / email 3: `sponsor_invoice`

**Files:**
- Create `_money-fixtures.ts` with `seedSponsorOrg`, generalised from `sponsor-checkout.test.ts`'s `seedOrg` (`:52`).
  Create `sponsor-outbox.test.ts`.
- Modify `sponsors.ts` `startSponsorCheckout` (`:453-536`): the org select (`:470-475`), the order insert (`:479-487`),
  the send (`:525-533`).
- Modify `lib/email.ts`: delete `SponsorInvoiceEmail` and `sendSponsorInvoiceEmail` (`:630-640`); add
  `sponsorInvoiceEmail`.
- Test: `sponsor-checkout.test.ts` (drop `invoice` from the mock, `:29`; repoint `:287-288` to a row), the sweep,
  `_kind-senders.ts`.
- Copy: `dictionaries/{en,es,fr,nl}/ui.json` `sponsors.order.sent` (`:472` in each).

**Interfaces:**
- `seedSponsorOrg(opts?: { defaultLocale?: Locale; prefix?: string }): Promise<{ orgId: string; ownerId: string; packageId: string; auth: AuthCtx }>`.
- `startSponsorCheckout`:
  1. The org select adds `default_locale`.
  2. `assertOutboxCanQueue()` runs after the Connect gate and before the order insert (P-W2-1; Rare case 1).
  3. After the `session.url` check:
     `try { id = await enqueueEmailOnce(sql, { kind: "sponsor_invoice", refType: "sponsor_order", refId: order.id, dedupeKey: onceKey("sponsor_invoice", "sponsor_order", order.id), orgId: auth.orgId, to: input.sponsor_email, transactional: false, expiresAt: expiryWithin(null), ...content }) } catch (err) { log.error({ err, orderId: order.id }, "sponsors: invoice email could not be queued") }`
     (Rare case 3).
  4. `if (id) deferred(() => dispatchNow([id]))`.

  The return shape is unchanged.

**Changed while queued:** package, amount and Checkout link. It is R, so it waits only on a provider failure. The link
cannot outlive its Checkout session, because the row expires first (Global Constraints, Expiry). A sponsor who pays
through the shared link while the invoice retries is rare — recorded.

- [ ] **Step 1: Write the failing tests.** The Stripe mock is the `stripeMock` pattern of `sponsor-checkout.test.ts:8-20`.
  1. `a checkout queues one invoice to the sponsor contact in the org's language, and sends it in the request`.
     Org default `fr`. Expected:
     - ref `sponsor_order / <order id>`, `dedupe_key` the order id, `recipient_user_id` null, `transactional` false;
     - after the deferred dispatch: `sent`, no body, one transport call with `email-outbox/<id>`;
     - subject `dictionarySubject("fr", "sponsorInvoice.subject", { orgName })`.
  2. `two checkouts for one package are two invoices, and neither replaces the other`: both `sent`.
  3. `empty: an inactive package refuses before any order or row` (422, 0 rows).
  - The once-key has no killer here: no path re-enqueues one order's invoice. Record it as a belt by spec, equivalent
    under every reachable input.
- [ ] **Step 2: Sweep and three lists.** Sweep scenario `sponsor_invoice` (`startSponsorCheckout`, `fr`,
  `sponsorInvoice.subject`, `request`). The sweep's existing `stripeMock.checkoutCreate` serves it. The three-list move
  for `sendSponsorInvoiceEmail` (41).
- [ ] **Step 3: Run red** → `b3`. **Step 4: Implement.** **Step 5: Run green** → `b3b`. Expected: the sweep
  reports `checked: 10`.
- [ ] **Step 6: Mutations.**
  - Drop the deferred dispatch: test 1 fails (the row stays `queued`).
  - `assertOutboxCanQueue()` placement and the try/catch have no test (owner trim). The reviewer reads both against
    P-W2-1.
- [ ] **Step 7: Copy (Q1 approved).** Set `sponsors.order.sent` to:
  - en: `We're emailing the invoice to the sponsor. You can also share this payment link:`
  - es: `Estamos enviando la factura al patrocinador por correo. También puedes compartir este enlace de pago:`
  - fr: `Nous envoyons la facture au sponsor par e-mail. Vous pouvez aussi partager ce lien de paiement :`
  - nl: `We mailen de factuur naar de sponsor. Je kunt ook deze betaallink delen:`

  Then run `pnpm i18n:gen-keys && pnpm i18n:check`. No test asserts the old text (`grep -arn "Invoice sent"` finds
  only `en/ui.json`). The notice (`components/sponsor-packages.tsx:274-286`) is screenshotted at 1280, 768 and 320
  onto an Artifact page, with no horizontal scroll. There is no local server (2026-10-24), so the controller takes
  them from the PR's e2e run or the owner's stg walk.
- [ ] **Step 8: TSC, LINT and commit.** `feat(sponsors): the invoice email through the outbox`.

#### Batch B / email 4: `sponsor_receipt`, and the evidence pack's language

**Files:**
- Modify `sponsors.ts`:
  - `handleSponsorPaymentSucceeded` (`:549-598`; activation transaction `:556-584`; send `:589-597`);
  - `buildSponsorDisputeEvidence` (`:921-`; the comment `:954-955`, the template call `:959-969`, and
    `getDictionary("en", "emails")` at `:968`).
- Modify `lib/email.ts`: delete `SponsorReceiptEmail` and `sendSponsorReceiptEmail` (`:642-652`); add
  `sponsorReceiptEmail`.
- `_money-fixtures.ts`: add `seedSponsorOrder`, generalised from `seedPaidSponsorOrder` (`sponsor-dispute.test.ts:43-84`).
  `sponsor-dispute.test.ts` imports it instead of its local copy.
- Test:
  - `sponsor-outbox.test.ts`;
  - `sponsor-checkout.test.ts` (drop `receipt` from the mock, `:30`; repoint `:335-339` and `:469`);
  - `sponsor-order-delete-guards.test.ts` (the evidence pack's existing reader);
  - `sponsor-dispute.test.ts` (the import);
  - the sweep, `_kind-senders.ts`.

**Interfaces:**
- `seedSponsorOrder(opts: { status: "pending" | "paid"; intent?: string; defaultLocale?: Locale; ownerLocale?: string | null; prefix?: string }): Promise<{ orderId: string; orgId: string; sponsorId: string | null; intent: string; sponsorEmail: string; ownerId: string; ownerEmail: string; orgName: string; packageName: string }>`.
  A `pending` order has no `sponsors` row and no `paid_at`.
- Produces `queueSponsorReceipt(tx: Tx, a: { order: { id: string; org_id: string; sponsor_name: string; sponsor_email: string; amount_cents: number; currency: string }; packageName: string; intentId: string }): Promise<string | null>`.
  - It reads the org (`slug`, `name`, `default_locale`) through `tx`.
  - The locale is `recipientLocale(tx, { pick: null, userId: null, orgDefault })`.
  - `publicUrl` is unchanged (`sponsorEmailOrigin()`).
  - It calls `enqueueEmailOnce(tx, { kind: "sponsor_receipt", refType: "sponsor_order", refId: order.id, dedupeKey: onceKey("sponsor_receipt", "sponsor_order", intentId), orgId: order.org_id, ... })`.
- Call it inside the activation transaction, after the `insert into sponsors` and before the
  `update sponsor_orders … paid`. There is no catch (D1). `fireOrgRevalidate` stays after commit.
- The evidence pack resolves the locale the same way (org `default_locale`) and renders with
  `sponsorReceiptEmail(args, locale)`. It still quotes the body's `.text`. The comment "sponsor emails are sent in en"
  goes.

**Changed while queued:** package, amount paid and public link. A refund inside the worker window would let the refund
notice (R) arrive first: rare — recorded. Nothing refreshes it.

- [ ] **Step 1: Write the failing tests.**
  1. `a paid sponsor order queues one receipt for the worker, in the org's language`.
     `processStripeEvent(payment_intent.succeeded, metadata { kind: "sponsor", order_id })`, org default `nl`.
     Expected:
     - `dedupe_key` the intent id, ref `sponsor_order / <order id>`, `queued` with `attempts` 0, and 0 transport
       calls;
     - the enqueue spy's first argument is not the pool `sql` (R1: the row is on the activation's transaction).
  2. `a redelivered success queues nothing new`: 1 row, and the spy saw 1 call.
  3. `the receipt's once-key alone`: `queueSponsorReceipt` twice, in two transactions, with one intent → 1 row.
  4. `the evidence pack quotes the receipt in the language it was sent in` (Review Focus 4). Org default `fr`, with an
     org and package name free of `&<>`. The pack's HTML contains
     `dictionarySubject("fr", "sponsorReceipt.textLine", { packageName, orgName })` and not the `en` line. The pack
     quotes the receipt's text (`sponsors.ts:959-969`), not its subject.
  5. `the invoice row survives the receipt`: invoice then receipt for one order gives 2 rows, invoice not `replaced`.
  6. `empty: a payment that is not a sponsor's queues nothing` (`metadata.kind` other → 0 rows).
  7. `a redelivered success after a refund re-activates nothing and queues no receipt`. Take a paid order through
     `handleSponsorChargeRefunded`: `status` is `refunded` and `sponsor_id` stays. Redeliver: no new `sponsors` row
     and 0 receipt rows. This kills the `sponsor_id !== null` guard alone.
  8. `a redelivered success after the organiser deleted the sponsor queues no second receipt`. Activate the order
     through the real handler (1 receipt row). Delete the `sponsors` row: the FK is `on delete set null`
     (`V283__sponsor_crm.sql:72`), so the order is `paid` with `sponsor_id` null. Redeliver: no new `sponsors` row,
     still exactly 1 receipt row, and 1 spy call in total. This kills the `status === "paid"` guard alone.
- [ ] **Step 2: Sweep and three lists.** Sweep scenario `sponsor_receipt` (`nl`, `worker`). The three-list move for
  `sendSponsorReceiptEmail` (40).
- [ ] **Step 3: Run red** → `b4`. **Step 4: Implement.** **Step 5: Run green** → `b4b`. Expected: the sweep
  reports `checked: 11`.
- [ ] **Step 6: Mutations.**
  - Drop `order.status === "paid"`: test 8 fails.
  - Drop `order.sponsor_id !== null`: test 7 fails.
  - Fresh once-key: test 3 fails.
  - Enqueue on `sql`: test 1's handle assertion fails.
  - Evidence back to `getDictionary("en")`: test 4 fails.
- [ ] **Step 7: TSC, LINT and commit.**
  `feat(sponsors): the receipt through the outbox, in the org's language, and the evidence pack quotes it`.

#### Batch B / email 5: `sponsor_refund`

**Files:**
- Modify `sponsors.ts`:
  - `handleSponsorChargeRefunded` (`:668-712`; transaction `:674-697`; the post-commit reads and send `:698-711`);
  - `refundSponsorOrder` (`:620-659`; the synthetic-charge call `:650-653`).
- Modify `lib/email.ts`: delete `SponsorRefundEmail` and `sendSponsorRefundEmail` (`:654-664`); add
  `sponsorRefundEmail`.
- Test: `sponsor-outbox.test.ts`, `sponsor-checkout.test.ts` (drop `refund` from the mock, `:31`; repoint
  `:424-425`), the sweep, `_kind-senders.ts`.

**Interfaces:**
- Produces `queueSponsorRefundReceipt(tx: Tx, order: { id: string; org_id: string; sponsor_name: string; sponsor_email: string; amount_cents: number; currency: string; package_id: string }): Promise<string | null>`.
  - It reads the org and package through `tx` and renders.
  - It runs `tx.savepoint((sp) => enqueueEmailOnce(sp, { kind: "sponsor_refund", refType: "sponsor_order", refId: order.id, dedupeKey: onceKey("sponsor_refund", "sponsor_order", order.id, "refunded"), ... }))`.
  - The render and the savepoint call share one try. The catch is
    `log.error({ err, orderId }, "sponsors: refund notice could not be queued")` and returns `null` (Rare case 4).
- `handleSponsorChargeRefunded(charge: Stripe.Charge): Promise<string | null>` calls it after the order update and
  before `update sponsors set status = 'inactive'`, and returns the id. `billing-events.ts:2709` ignores the value.
- `refundSponsorOrder` does `if (id) deferred(() => dispatchNow([id]))`. The webhook path does not dispatch.

**Changed while queued:** nothing can change. An order goes `paid → refunded` once, and the notice states that final
state.

- [ ] **Step 1: Write the failing tests.**
  1. `an organiser refund queues one notice to the sponsor, and sends it in the request`. `refunds.create` is mocked
     and the org default is `es`. Expected: `dedupe_key` `<order>:refunded`, then `sent`, and one transport call.
  2. `the webhook after a console refund queues no second notice`. `refundSponsorOrder`, then
     `processStripeEvent(charge.refunded)` for that intent: 1 row, 1 spy call.
  3. `a dashboard refund (webhook only) leaves the first attempt to the worker`: `queued`, `attempts` 0, 0 transport
     calls.
  4. C4 and Review Focus 2: `a refund whose notice fails inside its savepoint is still recorded`. Controller ruling
     (T0): `enqueueEmailOnce` is spied with
     `mockImplementationOnce(async (h) => { handles.push(h); await h\`select 1/0\`; })`. Expected:
     - `refundSponsorOrder` resolves;
     - the order is `refunded` and the sponsor is `inactive`;
     - there are 0 `sponsor_refund` rows, and `log.error` was called with `orderId`;
     - after the call, `handles[0]` is not the pool `sql`. The spy only records it, because an `expect` inside the
       spy would be swallowed by the producer's catch.
  5. `the refund notice's once-key alone`: `queueSponsorRefundReceipt` twice for one order → 1 row.
  6. `empty: a partial refund or an unknown intent queues nothing` (`refunded: false`, `pi_unknown` → 0 rows).
- [ ] **Step 2: Sweep and three lists.** Sweep scenario `sponsor_refund` (`refundSponsorOrder`, `es`,
  `sponsorRefund.subject`, `request`). The three-list move for `sendSponsorRefundEmail` (39).
- [ ] **Step 3: Run red** → `b5`. **Step 4: Implement.** **Step 5: Run green** → `b5b`. Expected: the sweep
  reports `checked: 12`.
- [ ] **Step 6: Mutations.**
  - Drop the savepoint (enqueue on `tx`): test 4 fails, because the aborted transaction makes the placement update
    reject.
  - Enqueue on `sql`: test 4's handle assertion fails.
  - Remove the catch: test 4 fails (the call rejects).
  - Fresh once-key: test 5 fails.
  - Widen the transition to `status in ('paid', 'refunded')`: test 2 fails (2 spy calls).
- [ ] **Step 7: TSC, LINT and commit.**
  `feat(sponsors): refund notice through the outbox; a refund is recorded even when its notice cannot queue`.

### Batch C — sponsor disputes (emails 6–8; old T7)

**Dispatch.**
- **Files:**
  - modify `apps/web/src/server/usecases/sponsors.ts` (`handleSponsorDispute`, `currentOrgOwnerEmail`,
    `resolveOrgName`, `resolvePackageName` only);
  - modify `apps/web/src/lib/email.ts` (three senders → three builders), `_kind-senders.ts`,
    `outbox-kind-sweep.test.ts`, `a-kind-body.test.ts`, `server/usecases/__tests__/sponsor-dispute.test.ts`,
    `dispute-unmatched-retry.test.ts`;
  - create `server/usecases/__tests__/sponsor-dispute-outbox.test.ts`.
- **Acceptance:** three commits (alert, then won, then lost); each email's VERIFY green with the counts in the table;
  every listed mutation killed; TSC `EXIT=0`; LINT `0 problems`.
- **Do NOT touch:** the invoice, receipt and refund paths (Batch B), `_money-fixtures.ts` beyond importing
  `seedSponsorOrder`, `registrations.ts`, `billing-events.ts`, and nothing from the shared list.
- **VERIFY (scoped):**
  `src/server/usecases/__tests__/sponsor-dispute-outbox.test.ts src/server/usecases/__tests__/sponsor-dispute.test.ts src/server/usecases/__tests__/dispute-unmatched-retry.test.ts src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts src/server/email-outbox/__tests__/a-kind-body.test.ts src/server/email-outbox/__tests__/no-second-path.test.ts`
- **Output cap:** as in "Shared by every batch".

Common to the three emails:
- They consume `orgOwnerRecipient` (email 1), `onceKey` (T1) and `seedSponsorOrder` (email 4).
- The owner, the locale (`recipientLocale(sql, { pick: null, userId: owner.userId, orgDefault })`, with the org default
  read with the order) and the org and package names are read before any transaction. Rendering needs no handle.
- Tests use the enqueue spy from "Shared by every batch". `sponsor-dispute.test.ts`'s mock entries (`:26-28`) and its
  assertions go one per email.

#### Batch C / email 6: `sponsor_dispute_alert`

**Files:**
- `sponsors.ts`: the order select (`:808-819`) and the created branch (`:822-847`; `firstFlag :825`, send `:835`).
- `lib/email.ts`: delete `SponsorDisputeAlertEmail` and `sendSponsorDisputeAlertEmail` (`:666-678`); add
  `sponsorDisputeAlertEmail`.
- Create `sponsor-dispute-outbox.test.ts`.
- Test:
  - `sponsor-dispute.test.ts`: drop `alert` from the mock (`:26`); repoint `:108-109`, `:130-131`, `:190`;
  - `dispute-unmatched-retry.test.ts`: drop the mock entry (`:15`);
  - the sweep, a-kind-body, `_kind-senders.ts`.

**Interfaces:**
- **Created.** In `sql.begin(tx)`:
  1. `select dispute_id from sponsor_orders where id = ${order.id} for update`.
  2. The existing update.
  3. If the prior `dispute_id !== dispute.id` and there is an owner: the enqueue on `tx` (`<id>:created`).
  4. Then, under the same condition, `update sponsors set status = 'pending'` (as today).
- `bustPublicSponsors` stays after commit.

**Changed while queued:** as email 1. A rename while it waits is rare — recorded. The close is its own kind.

- [ ] **Step 1: Write the failing tests.**
  1. `created queues one alert to the owner, for the worker`. Owner `fr`, ref `dispute / <id>`, key `<id>:created`,
     `recipient_user_id` the owner. The enqueue spy's first argument is not the pool `sql` (R1).
  2. `a redelivered created queues nothing new`: 1 spy call (repoints `:119-131`).
  3. `an older dispute's created after a newer one's does not alert twice`: `a`, `b`, `a` → 2 rows. This kills the
     once-key alone.
  4. `empty: a dispute on a charge that is not a sponsor's queues nothing` (repoints `:186-191`).
- [ ] **Step 2: Sweep, body guard, three lists.** Sweep scenario: alert (`fr`, `worker`). a-kind-body producer, with
  `positive` = the package name. The three-list move for `sendSponsorDisputeAlertEmail` (38).
- [ ] **Step 3: Run red** → `c6`. **Step 4: Implement.** **Step 5: Run green** → `c6b`. Expected: the sweep
  reports `checked: 13` and a-kind-body reports `kindsChecked: 4`.
- [ ] **Step 6: Mutations.**
  - Drop the prior `dispute_id` check (`firstFlag`): test 2 fails.
  - Fresh once-key: test 3 fails.
  - Enqueue on `sql`: test 1's handle assertion fails.
- [ ] **Step 7: TSC, LINT and commit.** `feat(sponsors): dispute alert through the outbox, once per dispute`.

#### Batch C / email 7: `sponsor_dispute_won`

**Files:**
- `sponsors.ts`: the won branch (`:849-871`; `firstClear :851`, send `:859`).
- `lib/email.ts`: delete `SponsorDisputeWonEmail` and `sendSponsorDisputeWonEmail` (`:695-708`); add
  `sponsorDisputeWonEmail`.
- Test: `sponsor-dispute.test.ts` (drop `won` from the mock, `:28`; repoint `:182-183`),
  `sponsor-dispute-outbox.test.ts`, the sweep, a-kind-body, `_kind-senders.ts`.

**Interfaces:**
- **Won.** In `sql.begin(tx)`:
  1. `select disputed_at … for update`.
  2. The existing update.
  3. If the prior `disputed_at !== null`: the enqueue on `tx` (`<id>:won`).
  4. Then the sponsors `active` update, unchanged.

**Changed while queued:** nothing can change. The outcome is final for this dispute, and a later dispute is a new id with
new rows.

- [ ] **Step 1: Write the failing tests.**
  1. `won after created queues one won notice; a redelivered won queues nothing`: 1 won row and 1 won spy call
     (repoints `:168-184`).
  2. `won's once-key alone`: created `a`, won `a`, created `a` again (it re-flags, `coalesce`), won `a` → 1 won row.
- [ ] **Step 2: Sweep, body guard, three lists.** Sweep scenario: won (owner locale null, org `es`, `worker`).
  a-kind-body producer (`positive` = the package name). The three-list move for `sendSponsorDisputeWonEmail` (37).
- [ ] **Step 3: Run red** → `c7`. **Step 4: Implement.** **Step 5: Run green** → `c7b`. Expected: the sweep
  reports `checked: 14` and a-kind-body reports `kindsChecked: 5`.
- [ ] **Step 6: Mutations.**
  - Drop `firstClear`: test 1 fails.
  - Fresh once-key on won: test 2 fails.
- [ ] **Step 7: TSC, LINT and commit.** `feat(sponsors): dispute-won notice through the outbox`.

#### Batch C / email 8: `sponsor_dispute_lost`

**Files:**
- `sponsors.ts`:
  - the lost branch (`:873-898`; the `!recovery.already` gate `:883` STAYS; send `:886`);
  - delete `currentOrgOwnerEmail` and its doc comment (`:730-739`), because no caller remains;
  - delete `resolveOrgName` / `resolvePackageName` (`:741-751`) if no caller remains.
- `lib/email.ts`: delete `SponsorDisputeLostEmail` and `sendSponsorDisputeLostEmail` (`:680-693`); add
  `sponsorDisputeLostEmail`.
- Test: `sponsor-dispute.test.ts` (drop `lost` and the now-empty mock; repoint `:151-152`, `:179`),
  `sponsor-dispute-outbox.test.ts`, the sweep, a-kind-body, `_kind-senders.ts`.

**Interfaces:**
- **Lost.** The write-off as today, then the recovery. Inside the kept `!recovery.already` gate:
  `enqueueEmailOnce(sql, …)` (`<id>:lost`) with `recoveredCents` from the recovery. No catch (D1). A refusal after a
  reversal is Rare case 2.

**Changed while queued:** nothing can change. The write-off and the recovered amount are fixed at the close.

- [ ] **Step 1: Write the failing tests.**
  1. `lost queues one notice carrying the recovered amount; a replay with the metadata guard hit queues none`: 1 row,
     1 spy call (repoints `:134-166`).
  2. `created then lost are two rows, neither replaced`.
- [ ] **Step 2: Sweep, body guard, three lists.** Sweep scenario: lost (`nl`, no `charge`, `worker`). a-kind-body
  producer (`positive` = the package name). The three-list move for `sendSponsorDisputeLostEmail` (36).
- [ ] **Step 3: Run red** → `c8`. **Step 4: Implement.** **Step 5: Run green** → `c8b`. Expected: the sweep
  reports `checked: 15` and a-kind-body reports `kindsChecked: 6`.
- [ ] **Step 6: Mutations.**
  - Drop the `!recovery.already` gate: test 1 fails (2 spy calls).
  - A fresh once-key on lost is killed by T10 A's no-charge replay, as for email 2.
- [ ] **Step 7: TSC, LINT and commit.** `feat(sponsors): dispute-lost notice through the outbox`.

### Batch D — pass revoked, trial ending (emails 9–10; old T8, T9)

**Dispatch.**
- **Files:**
  - modify `apps/web/src/lib/billing.ts` (`revokePassForRefundedCharge` only);
  - modify `apps/web/src/server/usecases/billing-events.ts` (`orgOwnerEmail`, `revokePassForRefundedChargeAndNotify`,
    `handleTrialWillEnd` and the `trial_will_end` dispatch line only);
  - modify `apps/web/src/lib/email.ts` (two senders → two builders), `_money-fixtures.ts` (two moved seeders),
    `_kind-senders.ts`, `outbox-kind-sweep.test.ts`, `a-kind-body.test.ts`,
    `src/lib/__tests__/billing-pass-revoke.test.ts`, `src/lib/__tests__/billing-pass-stream-credits.test.ts`,
    `server/usecases/__tests__/billing-events-payout-health.test.ts`;
  - create `server/usecases/__tests__/pass-revoked-outbox.test.ts` and `trial-ending-outbox.test.ts`.
- **Acceptance:** two commits; each email's VERIFY green with the counts in the table; every listed mutation killed;
  TSC `EXIT=0`; LINT `0 problems`.
- **Do NOT touch:** the other `charge.refunded` handlers (`syncRegistrationRefund`, `handleSponsorChargeRefunded`,
  `handlePackChargeRefunded`), `reversePassCreditOnRefund`, `runEvent`, `sponsors.ts`, `registrations.ts`, and nothing
  from the shared list.
- **VERIFY (scoped):**
  `src/server/usecases/__tests__/pass-revoked-outbox.test.ts src/lib/__tests__/billing-pass-revoke.test.ts src/lib/__tests__/billing-pass-stream-credits.test.ts src/server/usecases/__tests__/trial-ending-outbox.test.ts src/server/usecases/__tests__/billing-events-payout-health.test.ts src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts src/server/email-outbox/__tests__/a-kind-body.test.ts src/server/email-outbox/__tests__/no-second-path.test.ts`
- **Output cap:** as in "Shared by every batch".

#### Batch D / email 9: `pass_revoked`

**Files:**
- Modify `lib/billing.ts` `revokePassForRefundedCharge` (`:1051-1062`; the delete `:1056-1058`).
- Modify `billing-events.ts`:
  - `revokePassForRefundedChargeAndNotify` (`:1977-2012`; revoke `:1996`, owner `:2004`, send `:2006-2011`);
  - delete `orgOwnerEmail` and its doc comment (`:1956-1964`), whose only caller is `:2004`.
- Modify `lib/email.ts`: delete `PassRevokedEmail` and `sendPassRevokedEmail` (`:710-721`); add `passRevokedEmail`.
- Move `seedPassOrg` from `lib/__tests__/billing-pass-revoke.test.ts:50-` into `_money-fixtures.ts` (with an address
  prefix).
- Create `pass-revoked-outbox.test.ts`.
- Test:
  - `billing-pass-revoke.test.ts` (drop the mock, `:13-15`, `:78`; repoint `:128-129`, `:149`, `:166` to rows);
  - `billing-pass-stream-credits.test.ts` (drop the mock entry, `:63`);
  - the sweep, a-kind-body, `_kind-senders.ts`.

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

**Changed while queued:** nothing can change. The pass row is gone, and buying a pass again does not make the notice
untrue.

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
  5. `empty: an org with no owner loses the pass and queues nothing`.
  6. `an L pass names its rung`: `pass_key` `event_pass_l` → `passRevoked.rung.l`.
  7. lib: `inRevoke runs inside the delete's transaction, and only when a pass was deleted`.
     - A callback that throws leaves the pass present.
     - A non-pass charge never calls it.
- [ ] **Step 2: Sweep, body guard, three lists.** Sweep scenario `pass_revoked` (`nl`, `worker`). a-kind-body producer,
  with `positive` = the competition name. The three-list move for `sendPassRevokedEmail` (35).
- [ ] **Step 3: Run red** → `d9`. **Step 4: Implement.** **Step 5: Run green** → `d9b`. Expected: the sweep
  reports `checked: 16` and a-kind-body reports `kindsChecked: 7`.
- [ ] **Step 6: Mutations.**
  - Call `inRevoke` even when nothing was deleted: test 2 fails.
  - Fresh once-key: test 3 fails.
  - Run `inRevoke` after the commit: test 7 fails (a throwing callback leaves the pass gone).
- [ ] **Step 7: TSC, LINT and commit.** `feat(billing): pass-revoked notice through the outbox, in the revoke's transaction`.

#### Batch D / email 10: `trial_ending`

**Files:**
- Modify `billing-events.ts`:
  - `handleTrialWillEnd` (`:2531-2597`; the select `:2540-2564`; the try/catch `:2585-2596`);
  - its doc comment (`:2527-2529`), which no longer holds;
  - the dispatch call (`:2740`).
- Modify `lib/email.ts`: delete `TrialEndingEmail` and `sendTrialEndingEmail` (`:1601-1633`); add `trialEndingEmail`.
- Move `trialingGroup` (an inner function, `billing-events-payout-health.test.ts:332-`) into `_money-fixtures.ts` as
  `seedTrialingGroup(opts: { hasPaymentMethod: boolean; planKey?: string; ownerLocale?: string | null; orgDefaultLocale?: Locale; prefix?: string })`.
- Create `trial-ending-outbox.test.ts`.
- Test:
  - `billing-events-payout-health.test.ts`: the `TrialEndingEmail` type import and mock (`:25-29`), the
    `mockClear`s (`:152`, `:329`), and the assertions `:375-446`, repointed from the mock to rows;
  - the sweep, a-kind-body, `_kind-senders.ts`.

**Interfaces:**
- `handleTrialWillEnd(stripeSub: Stripe.Subscription, eventId: string): Promise<void>`.
- The select adds `s.owner_user_id` and the chosen org's `default_locale`, with the same coalesce choice as `org_slug`.
- The enqueue is
  `enqueueEmailOnce(sql, { kind: "trial_ending", refType: "subscription", refId: resolved.subscriptionId, dedupeKey: onceKey("trial_ending", "subscription", eventId), orgId: null, to: row.owner_email, recipientUserId: row.owner_user_id, transactional: true, expiresAt: expiryWithin(null), ...await trialEndingEmail(args, locale) })`.
- The locale is `recipientLocale(sql, { pick: null, userId: owner_user_id, orgDefault })`.
- The try/catch is removed (P-W2-8). The refusal is not tested (Rare case 1).

**Changed while queued:** plan, end date, card or no-card variant, and billing link. A changed trial sends a second
`trial_will_end` with a new event id. Its row replaces a still-queued first one through the wave-1 replace trigger, so
no code is added. Test 4 pins it, because it is also the once-key's only killer. A card added inside the worker window
is rare — recorded.

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
  5. `D4: a payer with no language gets the billing org's default` (`nl`).
  6. `a payer whose account is deleted gets no row, and the event is not parked`.
  7. The two existing no-op cases (unresolvable group, no `trial_end`; repointed from `:418-446`) assert 0 rows and a
     resolved promise.
- [ ] **Step 2: Sweep, body guard, three lists.**
  - Sweep scenario `trial_ending` (`fr`, the card variant, `worker`). This is the first sweep row that checks
    `transactional: true` on a wave-2 kind.
  - a-kind-body producer, with `positive` = `/\/settings\/billing/`.
  - The three-list move for `sendTrialEndingEmail` (34).
- [ ] **Step 3: Run red** → `d10`. **Step 4: Implement.** **Step 5: Run green** → `d10b`. Expected: the sweep
  reports `checked: 17` and a-kind-body reports `kindsChecked: 8`.
- [ ] **Step 6: Mutations.**
  - Producer `transactional: false`: the sweep fails at its facts check.
  - Fresh once-key: test 3 fails.
  - Key on `stripeSub.id` instead of the event id: test 4 fails (no second row).
  - Restoring the try/catch has no test (owner trim). The reviewer reads it against P-W2-8.
- [ ] **Step 7: TSC, LINT and commit.** `feat(billing): trial-ending warning through the outbox, once per Stripe event`.

---

### Task 10: F7, the replay suite, and closing the lists

**Files:**
- Create `server/usecases/__tests__/billing-events-outbox-replay.test.ts`.
- Modify `outbox-kind-sweep.test.ts` (restore the closing asserts T1 relaxed) and `a-kind-body.test.ts` (delete
  `PRODUCERS_PENDING`). `_kind-senders.ts` is already closed by email 10: `NOT_YET_MOVED` is `[]` (the list stays, as
  wave 1 left it), and every `KIND_DIRECT_SENDER` entry is `null`.

**Interfaces:** consumes every Batch A–D producer through `runEvent` (`billing-events.ts:2815`).

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
  - Close the lists:
    - the sweep: `expect(NOT_YET_MOVED).toEqual([])`, no `KIND_DIRECT_SENDER` entry names a sender, and
      `out.checked === SPEC_KINDS.length` (17);
    - delete `PRODUCERS_PENDING` (`kindsChecked === 8`);
    - the scan's allowlist is 34 names, through `allowlistLengthFor(0)`. No number is typed.
- [ ] **Step 2: Run.** VERIFY the new file, the sweep, a-kind-body and `no-second-path.test.ts` → `t10`. Expected:
  `failed: 0`, A `checked: 9`, sweep 17, body 8, allowlist 34.
- [ ] **Step 3: Mutations** (a true red is impossible here, because the producers already exist).
  - `onceKey` returns a fresh key per call: A fails on the kinds guarded by the key alone (expected: `trial_ending`,
    `registration_dispute_lost`, `sponsor_dispute_lost`). Record which legs went red. This is the killer emails 2 and
    8 defer to.
  - In `runEvent`, drop the lease condition (`or … < now() - interval '10 minutes'`, `:2830`): step 4 returns `false`
    and A fails. This proves the re-run really re-ran the handler.
- [ ] **Step 4: TSC, LINT and commit.**
  `test(billing): F7 — a redelivered or re-claimed webhook writes no second email row; wave-2 sweep closed at 17`.

### Task 11: Smoke

**Files:**
- Modify `scripts/smoke.ts`:
  - `postSignedStripeWebhook` (`:12045`; its id is generated at `:12051`) gains an optional third parameter
    `id?: string`;
  - add `checkQueuedOutboxRow` next to `checkOutboxRow` (`:9007`);
  - add `outboxTrialWarningSuite`, called in `main` right after `addonChurnWebhookSuite()` (`:1207`);
  - add `outboxTrialWarning: () => outboxTrialWarningSuite()` at the end of `SELECTABLE_SUITES` (`:23473`).
- Modify `scripts/__tests__/smoke-select.test.ts`: append `"outboxTrialWarning"` to `KNOWN` (`:10`) and its history
  comment (`:81`).

**Interfaces:**
- `checkQueuedOutboxRow(kind: string, refType: string, refId: string): Promise<void>`. It uses the keyless early
  return and the connection of `checkSignInOutbox` (`:8978`). Its checks:
  - `<kind>: one outbox row for the ref`
  - `<kind>: left to the worker (queued, no attempt yet)`
  - `<kind>: addressed to the account (recipient_user_id set)`
- `outboxTrialWarningSuite`:
  - It skips with a passing check line when `STRIPE_WEBHOOK_SECRET` is unset, as `addonChurnWebhookSuite` does
    (`:5302-`).
  - It signs in a fresh org. Through `smokeDb()` it sets the group's
    `stripe_subscription_id = 'sub_smoke_trial_<tag>'`, `status = 'trialing'` and `has_payment_method = false`.
  - It posts `customer.subscription.trial_will_end` (`trial_end` = now + 3 days) with id
    `evt_smoke_<tag>_trial`, which the teardown's `evt_smoke_` sweep covers (`:23264-23266`), and asserts 200.
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
  `STRIPE_WEBHOOK_SECRET`, the skip line shows: record it. `ci.yml` sets `whsec_ci_smoke` (`:845`, `:1514`), so the
  check is expected to run.
- [ ] **Step 5: Commit.** `test(smoke): a signed trial_will_end leaves one queued trial_ending row, and a replay none`.

### Task 12: E2E

**Files:** `apps/web/e2e/payments-hardening.spec.ts`, `apps/web/e2e/walkthrough/settings-sponsor-monetize.spec.ts`.

**Interfaces:**
- A local `outboxRows(kind: string, refType: string, refId: string)` in `payments-hardening.spec.ts`, built on its own
  `withDb` (`:90`).
- Expected subjects are read from `src/dictionaries/en/emails.json` by import, never typed.
- No `E2E_PROD_TARGET` skip (C1).

- [ ] **Step 1: Add the assertions and tests.**
  - `T3 · Event Pass refund revokes the pass` (`:516`): after the revoke, one `pass_revoked` row. It has ref
    `charge / <charge id>`, `recipient` = `org.ownerEmail`, `recipient_user_id` not null, `queued`, and the `en`
    subject with rung `passRevoked.rung.m`.
  - `T6 · sponsor package disputes pull the placement` (`:629-738`): created (`:630`) → one `sponsor_dispute_alert`
    row; lost (`:655`) → one `sponsor_dispute_lost`; won (`:697`) → one `sponsor_dispute_won`.
  - `Replay · re-posting a processed event is a clean no-op` (`:854`): after the identical re-post, still exactly one
    `sponsor_dispute_alert` row for the dispute.
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
    - Its `SKIP_REASON` (`:126-138`) needs `CONNECT_WALKTHROUGH`, `STRIPE_CONNECT_TEST_ACCOUNT`, a test-mode
      `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. `e2e.yml` passes the real key only to the `walkthrough`
      project (`:666`) and warns when the secrets are absent (`:940-942`). Record which way the dispatched run went.
      If it skipped, these legs are the spec's "covered on the owner's stg walk".
- [ ] **Step 2: Collect locally, never run.** `cd <worktree>/apps/web && npx playwright test e2e/payments-hardening.spec.ts e2e/walkthrough/settings-sponsor-monetize.spec.ts --list; echo EXIT=$?`.
  Expected: `EXIT=0` with the two new titles listed. Then TSC.
- [ ] **Step 3: Commit.** `test(e2e): wave-2 outbox rows on refund, dispute, trial and the sponsor walkthrough`.
- [ ] **Step 4 (controller).** Dispatch e2e on the PR:
  `gh workflow run e2e.yml --ref feat/email-outbox-phase3-w2 -f pr=<n>`. `payments-hardening.spec.ts` and the
  walkthrough are serial, so treat the red count as a floor and re-run after each fix.

### PR checklist (controller)

- Rebase onto `origin/main`; never merge main in. Re-pin `V473` (W2d).
- The scoped VERIFY of T1, each batch and T10 is green. Paste the counts.
- Smoke: the PR's smoke job shows the three `trial_ending` check lines.
- e2e is dispatched (T12 Step 4).
- G-5: readiness log clean.
- Push, open the PR, and hand back. Do not poll CI.

## Conflict scan (pairs sharing files or interfaces)

| Pair | Shared | Resolution |
|---|---|---|
| T1 → every batch | `_kind-senders.ts`, `outbox-kind-sweep.test.ts`, `a-kind-body.test.ts` (each email removes its entry) | Sequential. |
| Every email pair | `lib/email.ts` (each deletes one sender, adds one builder) and `_kind-senders.ts` (the derived allowlist shrinks by one per email) | Sequential. The hunks are disjoint, but the lists are one running state. |
| Batch A, emails 1 – 2 | `registrations.ts`, `registration-dispute-outbox.test.ts`; email 2 deletes `currentOwnerEmail` only after email 1 stopped calling it | Sequential. |
| Batch A → C, D | interface `orgOwnerRecipient` | A first. |
| Batch B → C | `sponsors.ts`; `_money-fixtures.ts` (`seedSponsorOrder`, moved by email 4); `sponsor-dispute.test.ts` (B changes its import, C its mocks) | Sequential. |
| Batch B, emails 3 – 4 – 5 | `sponsors.ts`, `sponsor-outbox.test.ts`, `sponsor-checkout.test.ts`, `_money-fixtures.ts` | Sequential. |
| Batch C, emails 6 – 7 – 8 | `handleSponsorDispute`, `sponsor-dispute.test.ts`, `sponsor-dispute-outbox.test.ts`; email 8 deletes `currentOrgOwnerEmail` after 6 and 7 stopped calling it | Sequential. |
| Batch D, emails 9 – 10 | `billing-events.ts`, `_money-fixtures.ts` | Sequential. |
| Batch D → T10 | T10 drives every producer through `runEvent` | T10 after D. |
| T10 / T11 / T12 | none of them share a file (`__tests__`, `scripts/`, `e2e/`) | May run in parallel after D. |
| Email 3 only | `ui.json` ×4 | None. |
| Wave 1 T13/T14 (merged) → T11/T12 | `scripts/smoke.ts` `SELECTABLE_SUITES`, `smoke-select.test.ts` `KNOWN` (wave 1 appended `registrationOpenFlow`, `:24`); wave 1's e2e files are disjoint from T12's | Re-read both lists before editing. |
| Peer branches | W2d holds a local `V472` and will want `V473`; any session editing `billing-events.ts` or `sponsors.ts` (0 commits since the plan's pin at T0) | `git log origin/main --oneline -- <file>` before each batch and before the PR. Re-pin `V473`. |

**Execution order:** T0 (done), T1, Batch A, Batch B, Batch C, Batch D, then T10 ∥ T11 ∥ T12.

## Next waves and routed findings (not built here)

- a. **Pre-existing (route).** A replayed `won` for an OLDER sponsor dispute clears a NEWER dispute's flag and
  re-activates the placement. `handleSponsorDispute` never compares `dispute.id` with `order.dispute_id` on close
  (`sponsors.ts:849-856`). Email 7's won once-key keeps the email right; the flag defect is not this wave's.
- b. **Pre-existing (route).** Every replay of a registration `created` writes another `registration.disputed` audit
  row (`registrations.ts:3365-3369`, unconditional). Email 1 keeps that behaviour.
- c. **Wave 5.** The staff dispute alert (`billing-events.ts:2267`) and T2 m1's staff-kind refusal row.
- d. **Phase 4** (owner, 2026-10-26): no send path bypasses the outbox. Dispatch, the worker and the webhook keep no
  app-render dependencies.

## Self-review

1. **Spec coverage.**
   - The 10 kinds map to emails 1–10 in Batches A–D: alert 1, lost 2, invoice 3, receipt 4, refund 5, the three
     sponsor disputes 6–8, pass 9, trial 10.
   - The wave-2 test row:
     - "sweep of 10" → each email's sweep scenario, closed at 17 in T10;
     - "`runEvent` twice" → T10 A (with P-W2-9);
     - "`charge.refunded` replayed after a later handler throws" → not built (owner, 2026-10-26; Rare case 7);
     - E2E → T12;
     - smoke → T11;
     - F7 regression → T10 A.
   - The migration rule ("only drops and re-adds `email_outbox_kind_valid`", checked by `outbox-schema.test.ts`)
     → T1.
   - §12 expiry → Global Constraints.
   - D4 → every Interfaces block.
2. **Step scan.** Every test step names its test, the fixture locale and the expected values. Every code step names
   the signature, the file and the once-key. No step references a dropped test (key-fault, `plantFailingUpdate`,
   P-W2-4, the producer-level no-id test, T10 B).
3. **Type consistency.** The following are spelled identically across T1–T10: `onceKey(kind, refType, id, suffix?)`,
   `orgOwnerRecipient(db, orgId) → { userId, email } | null`, `queueSponsorReceipt`, `queueSponsorRefundReceipt`,
   `queuePassRevokedEmail`, `revokePassForRefundedCharge(charge, { inRevoke })` and
   `handleTrialWillEnd(stripeSub, eventId)`.
4. **Review Focus.** Each of the four lines has a test in its owning email: T1 `once-key-builder.test.ts`; email 5
   test 4; `org-owner.test.ts` and email 1 test 8; email 4 test 4.
5. **Proportion.** Bodies appear only as one-line SQL or call shapes. The only test support added is
   `_money-fixtures.ts`, which moves or generalises four existing seeders for the sweep and T10. There is no new
   harness, trigger or probe.
6. **Test counts after the revision** (before → after). Email 1: 10 → 9, plus `org-owner` 5. Email 2: 8 → 6.
   Email 3: 5 → 3. Email 4: 10 → 8. Email 5: 8 → 6. Emails 6–8: 11 → 8 (4 + 2 + 2). Email 9: 9 → 7. Email 10: 8 → 7.
   T10: A + B → A.
