# Email outbox phase 3, wave 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the five player emails (registration confirmation, payment reminder, promotion, refund, solo
assignment) onto the outbox. Land the shared machinery every later wave builds on: the once-key, the recipient
resolved at send time, the cancel primitive, the generalised deletion sweep, the kind harness and the
no-second-path scan.

**Architecture:** One migration (V472) adds `recipient_user_id`, `dedupe_key` with its unique index, the user-id
replace rule and `email_outbox_cancel`. It also moves the replace step to AFTER INSERT so a skipped duplicate
supersedes nothing (P2). `enqueueEmail` gains a kind-facts guard and a once-keyed sibling. `attemptClaimed` resolves
an account's recipient just before the gate. Each of the five kinds swaps its `send*` for a render builder plus an
enqueue in the same commit (the cutover rule). Every kind is proven through its real producer and the real
`dispatchNow` / `runOutboxTick`; only `transport.deliver` is replaced.

**Tech Stack:** Next (repo fork, see `AGENTS.md`), TypeScript, postgres.js (`sql.begin`, `tx.savepoint`,
`result.count`), Postgres 17 with Flyway deltas, vitest (node environment), Playwright on CI only, Stripe (mocked
in vitest).

**Spec:** `docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md` (owner-approved 2026-10-25). It extends
`docs/superpowers/specs/2026-10-19-email-outbox-design.md`. Executors read both.

## Global Constraints

- **Worktree.** Work only in `/Users/ashokhein/github/seazn.club/.claude/worktrees/outbox-p3` (branch
  `feat/email-outbox-phase3`). Prefix every command with `cd <that path> &&` or `cd <that path>/apps/web &&`. Never
  check anything out in the main checkout.
- **Precondition.** Phase 2 (`feat/arbiter-round-column`) has NOT merged on `origin/main` (`a622343cc8`, 2026-10-25).
  The spec says to build only after it merges (spec line 6). Task 0 gates every other task.
- **Migration number.** Main's max today is `V471__all_stages_free.sql`, so this wave takes **V472**. The W2d branch
  (`feat/format-matrix-w2d`) also holds a `V472__w2d_table_rules.sql`. Right before committing the migration, and
  again right before opening the PR, run `git fetch origin && git ls-tree --name-only origin/main db/migration/deltas/ | sort -V | tail -1`.
  If the number is taken, `git mv` the file to max + 1 and amend the commit while the branch is unmerged. Flyway
  outOfOrder is off, so you never land below main's max.
- **The retry rule is phase 1's and is unchanged:** 1, 5, 15, 60 and 360 minutes, 6 attempts, then `dead`
  (`constants.ts:57`, `:60`).
- **R1.** The row is written on the transaction that commits the fact, except where the spec's own facts make that
  impossible (P4).
- **R2.** No failure-reporting email in wave 1.
- **R3.** Inside `withTenant`, the row's `org_id` is the tenant's org.
- **R4.** Never catch an enqueue error inside a transaction and carry on. Use a savepoint.
- **R5.** `dispatchNow` runs only after commit.
- **R6.** Enqueue only on the transition.
- **D1.** A refused enqueue fails the action, outside a savepoint (spec §3).
- **D2.** A send that may have reached Resend keeps its first address.
- **D4.** The locale is the explicit pick, then the linked account's (through an existing link only), then the org
  default, then `en`.
- **D5.** Deleting an account ends and scrubs only the account's own rows.
- **No pooled `sql` call inside `withTenant`** (#996). Every read a render needs inside a tenant transaction goes
  through `tx`.
- **The cutover rule.** A kind's `send*` is deleted in the same commit that adds its enqueue.
- **Each kind keeps its sender's current `transactional` flag.** All five wave-1 kinds are N (`false`). `magic_link`
  and `chess_invite` stay T.
- **Copy.** Every changed user-facing string goes into all four of `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`.
  Then run `cd <worktree> && pnpm i18n:gen-keys && pnpm i18n:check`. A value-only change gives gen-keys no diff,
  which is expected. Log lines stay English.
- **Test rules.** `docs/superpowers/TEST-STRATEGY.md` is binding:
  - Test the sequence: a second call, an empty input, after a withdrawal or void.
  - "Another sport" is N/A: these emails do not vary by sport (spec, Test strategy 4).
  - Anti-vacuity: every sweep reports its count, and zero is a FAILURE.
  - Expected values come from the spec or the `emails` dictionary, never from the code under test.
  - Mutate every guard once.
- **ENV.** Use the seazn-local-env skill: `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`, with
  `$S up --label outbox-p3` (fresh pg + db:apply + sync:sports) and `eval "$($S env --label outbox-p3)"`.
  - After any migration edit, run `$S down --label outbox-p3 && $S up --label outbox-p3`.
  - Never run a bare `pnpm db:apply`: without the exported env it migrates the DEV database.
  - Confirm `show data_directory` is this label's.
- **VERIFY `<files>` → `tN`** means exactly this command, scoped to the listed files and never the full suite:
  ```
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/outbox-p3/apps/web && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label outbox-p3)" && npx vitest run <files> --reporter=json --outputFile=$OUT/tN.json; echo EXIT=$?
  jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests, files: [.testResults[].name]}' $OUT/tN.json
  ```
  - `$OUT` is the executor's own subdirectory of its scratchpad, never a shared directory.
  - Green means `failed == 0`, `total` equals the count the step states, and every listed file appears in `files`
    under this worktree's path.
  - Never trust an `rtk` summary.
- **TSC** = `cd <worktree>/apps/web && rtk proxy npx tsc --noEmit -p tsconfig.json; echo EXIT=$?` (`EXIT=0`).
- **LINT `<files>`** = `cd <worktree>/apps/web && rtk proxy npx eslint <files>; echo EXIT=$?`. Read `✖ N problems`;
  0 is expected.
- **MUTATE `<file>`** means:
  1. `cp <file> $OUT/mut.bak`.
  2. Make the stated edit.
  3. Run VERIFY on the step's files: the named test must fail and `total` must be unchanged. A smaller total means a
     parse failure, not a kill.
  4. `cp $OUT/mut.bak <file>`.
  5. Run VERIFY again, green.

  Never use `git checkout <file>`, `git stash` or `git restore`. For a SQL mutation, run the env down/up around steps
  2 and 4.
- **Never locally:** the full vitest suite, the full e2e suite, or `$S gate` (it runs the full suite). e2e runs only
  by CI dispatch: `gh workflow run e2e.yml --ref feat/email-outbox-phase3 -f pr=<n>`. The controller does this.
- **No evidence PNGs in the repo.** Screenshots go on an Artifact page.
- **Kill only your own PIDs.**
- **openapi.** No route contract changes in this wave. If one does, run `pnpm openapi:gen` and commit the result
  (CI's drift check).
- **Commit trailer.** Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XN3eUkHiV1TZpUy2phgxYv
  ```

## Plan decisions where the tree contradicts the spec

Each is a finding to record in the wave's report. A controller who disagrees with one rules before its task runs.

| # | Spec says | The tree says | Plan does |
|---|---|---|---|
| P1 | `enqueueEmail` inserts with `on conflict (kind, dedupe_key) where dedupe_key is not null do nothing` (§5) | Probed on PG 17.10: as `app_user` this fails with 42501. Conflict-target inference needs SELECT, and even with a column SELECT grant the insert fails RLS ("new row violates row-level security policy"). A target-less `on conflict do nothing` works for `app_user` (`INSERT 0 0`). | Target-less `on conflict do nothing`. Two guards: a catalogue test that `email_outbox`'s unique indexes are exactly the pkey, `email_outbox_provider_idx` and `email_outbox_once_idx`; and `enqueueEmail` throws if an insert with no once-key writes 0 rows. |
| P2 | The once-key check runs in the BEFORE INSERT trigger, before the supersede (§5). | Each trigger statement takes a fresh snapshot. If tx A (key k) commits between tx B's check and B's supersede, B's supersede marks A `replaced` (body nulled), then B's insert hits the unique index and does nothing. That leaves no live row: a silently lost email. | The supersede moves to an **AFTER INSERT** trigger. A row skipped by `on conflict` fires no AFTER trigger, so it supersedes nothing, in sequence or concurrently. The BEFORE check then has no work and is not built. The spec's mutation row "delete the once-key check" becomes "move the supersede back to BEFORE INSERT", and the replay-after-resend test (T1) kills it. |
| P3 | D3/§11 rewords `reg.remind.notSent` in wave 1. | That key is rendered nowhere: `/remind` has no UI caller. The notice a wave-1 `{sent}` actually drives is `reg.hub.registrants.detail.actions.resendNotSent` (`ui.json:772`, rendered at `components/registration-hub-registrant-actions.tsx:384`). | Reword both, in all four locales (T8, T9). |
| P4 | R1/D1: the row is written on the fact's transaction, and a refused enqueue fails the action. | `registration_confirmation` (submit) and `registration_promoted` carry a Checkout URL minted after the fact commits (route :101, `registrations.ts:1350`). The submit's token exists only in that request. `refund_issued` follows an irreversible Stripe refund, so D1 would roll back the record of money that has already moved. | **Submit:** `assertOutboxCanQueue()` runs before the submit transaction (D1's accepted cost: registrations fail under a key fault), then a pool enqueue after the mint. A later refusal is `log.error`'d and the 201 stands; a 5xx would make the registrant resubmit and create a second cart. **Promotion:** a pool enqueue after the mint, with a refusal `log.error`'d. **Refund:** an R4 savepoint inside each of the 5 refund-record transactions. |
| P5 | e2e: "unpairing an opened online round ends its queued invites `round_voided`". | CI has no Resend key, so every invite ends `dead` at the open's `dispatchNow`. Nothing is queued at Unpair, so the e2e as written passes vacuously. | The e2e seeds a queued row through `withDb`. Vitest drives the real open with the transport answering 503, then the real unpair (T6, T14). |
| P6 | The wave-1 sweep covers "5 kinds plus `chess_invite`". | The harness iterates `OUTBOX_KINDS` and fails any kind without a scenario. | 7 scenarios, including `magic_link`. The expected list is typed from the spec. |
| P7 | Payment reminder once-key `<id>:promotion`. | A lapsed promotion returns to the waitlist and can be promoted again. `promoteWaitlistedRow` resets `promotion_reminded_at` (`registrations.ts:1266-1271`, "every promotion opens a FRESH reminder window"). The spec's key would block the second cycle's reminder for 90 days. | `<id>:promotion:<promoted_at ISO>`. The submit key stays `<id>:submit`. |
| P8 | §7: the void ends rows that phase 2 shows; re-read its readers. | `latestEmailStatus` skips only `replaced` (`status.ts:25`). A voided `expired` row therefore reads as "Not delivered" on a seat re-paired to the same player before the re-open. Phase 2's `seatInviteWords` maps `expired` to `not_delivered`. | `current()` also skips `expired` rows whose `last_error` is a cancel reason (T6, Review Focus 5). |
| P9 | (new) | Under a key fault, the reminder sweep's claim → mint → refused enqueue lets the lease lapse every 5 minutes. Each lapse mints another Checkout session: F8 by another road. | The sweep checks `outboxKeyProblem()` once and skips both reminder passes, with one `log.error` (T9). |
| P10 | (new) | `carryRetryBudget` matches the retired row by `lower(recipient)` (`enqueue.ts:139`), a sibling of the replace rule. | It matches by `recipient_user_id` when both rows carry one (T4). |
| P11 | Mutation "restore the lease release → F8 test makes a second session". | The new flow stamps in the enqueue's transaction, so there is no send-failure branch left to release from. | The F8 test also forces the enqueue transaction to fail once. Restoring the release in that catch lets an immediate second sweep re-mint (T9). |

**Stale citations (re-verified against this tree, `a622343cc8` plus the spec commit):**
- `registration-assign.ts:378-381` / `:378` is the comment block.
  - The notice object is built in the transaction at `:368`.
  - The comment is `:378-383`.
  - The post-commit guard is `:384`.
  - The sender call is `:388`.
- `scripts/smoke.ts:8975-8977` is `:8974-8977`. `checkSignInOutbox` is at `:8978`, as cited.
- Every other spec citation checked is current.

## Review Focus

These are the conditions the spec implies but no spec test exercises, most likely to hurt a person first. Each line's
test lives in its owning task.

1. A refund whose receipt cannot be queued (key fault) still records `refunded_cents`. It must write no
   `registration.refund_failed` audit and send no staff refund-failed alert, because the money did move (T11, test 4).
2. A promotion that lapses and is promoted again gets its second reminder (P7) (T9, test 2).
3. The reminder sweep under a key fault mints no Checkout session and stamps nothing (P9) (T9, test 4).
4. A public submit under a key fault commits no cart: 5xx, no `registration_groups` row (P4) (T8, test 6).
5. After an Unpair and a re-pair of the same player into the same seat, the seat's latest email status has no
   voided row. The arbiter therefore reads "Not invited", not "Not delivered", until the round is reopened (P8)
   (T6, test 6).

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `db/migration/deltas/V472__email_outbox_phase3_wave1.sql` (create) | columns, indexes, kind CHECK, AFTER replace trigger, `email_outbox_cancel` | T1 |
| `apps/web/src/server/email-outbox/constants.ts` | `OUTBOX_KINDS` (7), `OUTBOX_KIND_FACTS` | T1 |
| `apps/web/src/server/email-outbox/hooks.ts` | `KIND_HOOKS` gains five `{}` | T1 |
| `apps/web/src/server/email-outbox/enqueue.ts` | facts guard, `recipientUserId`, `enqueueEmailOnce`, `expiryWithin`, insert guard, `carryRetryBudget` rule | T2, T4 |
| `apps/web/src/server/email-outbox/seal.ts`, `readiness.ts` | `assertOutboxCanQueue`; the readiness text | T2 |
| `apps/web/src/server/email-outbox/recipient.ts` (create) | `isKeyClean`, `resolveRecipient` | T3 |
| `apps/web/src/server/email-outbox/attempt.ts`, `worker.ts` | claimed-row columns, resolution before the gate, `reclaimed` | T3 |
| `apps/web/src/server/email-outbox/account-deletion.ts` | `deletedAccountPlaceholder`, `anonymiseAccountEmails` | T3, T5 |
| `apps/web/src/server/email-outbox/cancel.ts` (create) | `cancelQueuedEmails`, reasons | T6 |
| `apps/web/src/server/email-outbox/status.ts` | `current()` skips cancelled rows | T6 |
| `apps/web/src/server/email-outbox/locale.ts` (create) | `recipientLocale` | T7 |
| `apps/web/src/server/email-outbox/index.ts` | re-exports | T2, T3, T6, T7 |
| `apps/web/src/server/email-outbox/__tests__/_kind-harness.ts` (create) | `forEachOutboxKind`, `bornAgo`, `dictionarySubject` | T7 |
| `apps/web/src/server/usecases/external-play/guard.ts`, `invite.ts` | `chess_invite` becomes an A kind | T4 |
| `apps/web/src/server/usecases/stages.ts`, `withdrawal.ts` | void cancel, board-level cancel | T6 |
| `apps/web/src/app/api/users/me/route.ts` | the generalised deletion sweep | T5 |
| `apps/web/src/lib/email.ts` | five `send*` become render builders | T8–T12 |
| `apps/web/src/server/usecases/registrations.ts`, `registration-approval.ts`, `registration-assign.ts`, register route | the five producers | T8–T12 |
| `scripts/smoke.ts`, `scripts/__tests__/smoke-select.test.ts` | the outbox smoke check | T13 |
| `apps/web/e2e/registration-hub.spec.ts`, `apps/web/e2e/online-chess-desk.spec.ts` | two e2e tests | T14 |

---

### Task 0: Preconditions and environment (no commit)

**Files:** none modified.

**Interfaces:** Produces the pinned facts later tasks rely on: phase 2 merged, the migration number, a live env label.

- [ ] **Step 1: Confirm phase 2 has merged.**
  - Run `cd <worktree> && git fetch origin && git log --oneline origin/main | grep -ai "arbiter" | head -3`.
  - Expected: a merge of `feat/arbiter-round-column`. If absent, STOP and report: the spec forbids building before
    it (spec line 6).
- [ ] **Step 2: Rebase.**
  - Run `cd <worktree> && git rebase origin/main`. Expected: clean. The only commits ahead are the spec and this
    plan.
  - Re-read `scripts/smoke.ts`'s `SELECTABLE_SUITES` and `scripts/__tests__/smoke-select.test.ts`'s `KNOWN`. Phase 2
    edits both, and T13 appends to them.
- [ ] **Step 3: Re-read phase 2's readers.**
  - Read the merged `apps/web/src/lib/invite-status.ts` (`seatInviteWords`, `inviteWordOf`) and every merged caller
    of `latestEmailStatus` (`grep -arn "latestEmailStatus" apps/web/src`).
  - Write down in the task report how they read these three rows:
    1. an `expired` row with `last_error = round_voided`;
    2. a row whose `recipient` was rewritten by a clean resolution;
    3. a row D2 kept at the old address.
  - P8's change (T6) assumes 1 reads `not_delivered` today. If the merged reader already drops it, T6 Step 6 changes
    nothing and its test still runs.
- [ ] **Step 4: Pin the migration number.**
  - Run `git ls-tree --name-only origin/main db/migration/deltas/ | sort -V | tail -1`.
  - Record max + 1 (V472 unless something merged). Every later reference to V472 means this number.
- [ ] **Step 5: Bring up the env.**
  - Run `$S up --label outbox-p3`, then `cd <worktree> && pnpm install --frozen-lockfile`. A fresh worktree has no
    `node_modules`.
  - Symlink `apps/web/.env.local` as the seazn-local-env skill §0a says.
  - Then `eval "$($S env --label outbox-p3)" && psql "$DATABASE_URL" -c 'show data_directory'`. Expected: a path under
    the `outbox-p3` label.

---

### Task 1: The schema — kinds, once-key index, user-id replace after insert, the cancel function

**Files:**
- Create `db/migration/deltas/V472__email_outbox_phase3_wave1.sql`.
- Modify:
  - `apps/web/src/server/email-outbox/constants.ts:9-10`: `OUTBOX_KINDS`, plus the new `OUTBOX_KIND_FACTS`.
  - `apps/web/src/server/email-outbox/hooks.ts:39-42`: five new `{}` entries.
  - `apps/web/src/server/email-outbox/__tests__/outbox-schema.test.ts:50`: the kinds literal.
- Create `apps/web/src/server/email-outbox/__tests__/outbox-once-key.test.ts`.

**Interfaces:**
- Produces `OUTBOX_KINDS`, in this order (the spec table's wave order):
  ```ts
  ["magic_link", "chess_invite", "registration_confirmation", "payment_reminder", "registration_promoted",
   "refund_issued", "solo_signup_assigned"] as const
  ```
- Produces `OUTBOX_KIND_FACTS: Readonly<Record<OutboxKind, { to: "account" | "literal" | "staff"; transactional: boolean }>>`:
  - `magic_link` is literal and T.
  - `chess_invite` is account and T.
  - The five new kinds are literal and N.
- Produces these DB columns and indexes:
  - `email_outbox.recipient_user_id uuid null references users(id) on delete set null`
  - `email_outbox.dedupe_key text null`, constrained by `email_outbox_dedupe_key_nonempty`
  - `email_outbox_once_idx`, unique on `(kind, dedupe_key) where dedupe_key is not null`
  - `email_outbox_recipient_user_idx`, partial
- Produces `email_outbox_cancel(p_kind text, p_ref_type text, p_ref_ids text[], p_reason text) returns table (outbox_id uuid, outbox_kind text, outbox_ref_type text, outbox_ref_id text, outbox_meta jsonb)`.
  The output names avoid plpgsql's column/variable conflict.

- [ ] **Step 1: Write the failing tests.** In `outbox-schema.test.ts`, change the `:50` literal to the 7 kinds above,
  typed from the spec table. Do not import it. The test name stays. Then create `outbox-once-key.test.ts`. It uses
  the file's existing `insertRow` style, raw SQL, and `on conflict do nothing` with no target. It has these tests:
  - `kind CHECK accepts each wave-1 kind and refuses "registration_confirmations"`: 5 inserts succeed, a typo raises 23514.
  - `a duplicate once-key inserts nothing and leaves the original untouched`: insert A (k), then a second k; the
    second statement's `count === 0`, A is still `queued` with `body_sealed` not null, and the total row count for k is 1.
  - `a replay after a newer resend leaves the resend live`. Steps: A (k) is inserted. Z (same kind, ref and
    recipient, no key) is inserted, and A becomes `replaced`. A replay of k is inserted. Expected: `count === 0`, Z is
    still `queued`. Kills P2's mutation.
  - `a dedupe_key of '' is refused`: 23514.
  - `replace by user id`:
    - Two rows with the same kind, ref and user U, at addresses `old@` and `new@`: the older becomes `replaced`.
    - Two rows with users U and W at the same address: both stay `queued`.
    - A row with user U, then a row with no user id at the same address: the address rule applies, and the older
      becomes `replaced`.
  - `the org fence still holds for the user-id rule`: same user and ref, two orgs. Both stay `queued`.
  - `email_outbox's unique indexes are exactly the three the target-less on-conflict may swallow`. Read the unique
    indexes from `pg_index` / `pg_class` for `email_outbox`. The name set equals
    `{email_outbox_pkey, email_outbox_provider_idx, email_outbox_once_idx}`, and the test reports `checked: 3`.
  - `email_outbox_cancel`. Run it as `app_user` inside `withTenant(orgX)`. Seed rows in orgX (queued, sending, sent)
    and orgY (queued) for the same refs. Expected:
    - It returns exactly orgX's queued row.
    - That row reads `expired`, with `last_error='round_voided'`, `body_sealed is null` and `lease_until is null`.
    - The sending, sent and orgY rows are unchanged.
    - An empty `p_ref_ids` returns 0 rows.
    - A reason of `'Round Voided'` raises 22023.
    - `proacl` has no PUBLIC entry (no element starting with `=`), and `has_function_privilege('app_user', …, 'execute')` is true.
  - `app_user still holds INSERT only`: the existing test stays and must stay green.
- [ ] **Step 2: Run the tests red.**
  - Run VERIFY on `src/server/email-outbox/__tests__/outbox-schema.test.ts` and
    `src/server/email-outbox/__tests__/outbox-once-key.test.ts` → `t1`.
  - Expected: the kinds test fails on the literal, and the once-key tests fail on "column dedupe_key does not
    exist". Record `total`.
- [ ] **Step 3: Write the migration.** It is exactly this algorithm. Names and comments may grow; the logic may not.
  ```sql
  alter table email_outbox
    add column recipient_user_id uuid references users(id) on delete set null,
    add column dedupe_key text,
    add constraint email_outbox_dedupe_key_nonempty check (dedupe_key is null or dedupe_key <> '');
  create index email_outbox_recipient_user_idx on email_outbox (recipient_user_id) where recipient_user_id is not null;
  create unique index email_outbox_once_idx on email_outbox (kind, dedupe_key) where dedupe_key is not null;
  alter table email_outbox drop constraint email_outbox_kind_valid,
    add constraint email_outbox_kind_valid check (kind in ('magic_link', 'chess_invite', 'registration_confirmation',
      'payment_reminder', 'registration_promoted', 'refund_issued', 'solo_signup_assigned'));
  drop trigger email_outbox_replace_older on email_outbox;
  create or replace function email_outbox_replace_older() returns trigger
    language plpgsql security definer set search_path = ${flyway:defaultSchema}, pg_temp as $$
  begin
    update email_outbox
       set status = 'replaced', body_sealed = null, lease_until = null, status_at = now()
     where kind = new.kind and ref_type = new.ref_type and ref_id = new.ref_id and id <> new.id
       and case when new.recipient_user_id is not null and recipient_user_id is not null
                then recipient_user_id = new.recipient_user_id
                else lower(recipient) = lower(new.recipient) end
       and org_id is not distinct from new.org_id
       and status in ('queued', 'sending', 'sent', 'delayed');
    return null;
  end $$;
  -- AFTER, not BEFORE (plan P2): a row `on conflict do nothing` skipped fires no AFTER trigger, so a duplicate supersedes nothing.
  create trigger email_outbox_replace_older after insert on email_outbox
    for each row execute function email_outbox_replace_older();
  create function email_outbox_cancel(p_kind text, p_ref_type text, p_ref_ids text[], p_reason text)
    returns table (outbox_id uuid, outbox_kind text, outbox_ref_type text, outbox_ref_id text, outbox_meta jsonb)
    language plpgsql security definer set search_path = ${flyway:defaultSchema}, pg_temp as $$
  begin
    if p_reason is null or p_reason !~ '^[a-z][a-z_]*$' then
      raise exception 'email_outbox_cancel: the reason must be a snake_case word' using errcode = '22023';
    end if;
    return query
      update email_outbox o
         set status = 'expired', last_error = p_reason, body_sealed = null, lease_until = null, status_at = now()
       where o.kind = p_kind and o.ref_type = p_ref_type and o.ref_id = any(p_ref_ids) and o.status = 'queued'
         and o.org_id is not distinct from current_org_id()
      returning o.id, o.kind, o.ref_type, o.ref_id, o.meta;
  end $$;
  revoke all on function email_outbox_cancel(text, text, text[], text) from public;
  grant execute on function email_outbox_cancel(text, text, text[], text) to app_user;
  ```
- [ ] **Step 4: Update the code.** Add the 5 kinds to `OUTBOX_KINDS`, add `OUTBOX_KIND_FACTS` with the values in
  Interfaces, and add five `{}` entries to `KIND_HOOKS`. No phase-3 kind has a hook (spec §1).
- [ ] **Step 5: Run the tests green.**
  - Run `$S down --label outbox-p3 && $S up --label outbox-p3`.
  - VERIFY the two files plus `src/server/email-outbox/__tests__/hooks.test.ts`,
    `src/server/email-outbox/__tests__/no-import-cycle.test.ts`,
    `src/server/usecases/external-play/__tests__/invite-outbox.test.ts` and
    `src/server/email-outbox/__tests__/status.test.ts` → `t1b`. The four extra files check that phase 1's replace
    behaviour survives the AFTER move.
  - Expected: all green, and `total` = t1's total plus the four files' totals.
- [ ] **Step 6: Mutations.**
  - Make the trigger `before insert` again: `a replay after a newer resend` fails.
  - Replace the `case` with `lower(recipient) = lower(new.recipient)`: `replace by user id` fails.
  - Delete `and o.org_id is not distinct from current_org_id()`: the `email_outbox_cancel` org test fails.
  - Delete the `revoke … from public`: the `proacl` assertion fails.
- [ ] **Step 7: TSC and LINT.** LINT the touched `.ts` files, then commit.
  ```bash
  git add db/migration/deltas/V472__email_outbox_phase3_wave1.sql apps/web/src/server/email-outbox/{constants,hooks}.ts apps/web/src/server/email-outbox/__tests__/outbox-{schema,once-key}.test.ts
  git commit -m "feat(email-outbox): wave-1 schema: once-key, user-id replace after insert, cancel function"
  ```
  Re-check the migration number (Global Constraints) before this commit.

### Task 2: `enqueueEmail` — the facts guard, the once-keyed sibling, the expiry bound, the readiness text

**Files:**
- Modify:
  - `apps/web/src/server/email-outbox/enqueue.ts:14-67`
  - `apps/web/src/server/email-outbox/seal.ts` (after `:31`)
  - `apps/web/src/server/email-outbox/readiness.ts:13-20`
  - `apps/web/src/server/email-outbox/index.ts:3`, `:16`
- Create `apps/web/src/server/email-outbox/__tests__/enqueue-once.test.ts`.
- Modify `apps/web/src/server/email-outbox/__tests__/enqueue-expiry.test.ts`, `readiness.test.ts` and `seal.test.ts`.

**Interfaces:**
- Consumes `OUTBOX_KIND_FACTS` (T1).
- Produces:
  - `OutboxMessage` gains `recipientUserId?: string`.
  - `enqueueEmail(db: Tx | typeof sql, m: OutboxMessage): Promise<string>`, unchanged for callers.
  - `enqueueEmailOnce(db: Tx | typeof sql, m: OutboxMessage & { dedupeKey: string }): Promise<string | null>`. `null`
    means a duplicate once-key and no row.
  - `class OutboxKindMismatchError extends Error`, with `code = "EMAIL_OUTBOX_KIND_MISMATCH"`.
  - `class OutboxInsertSkippedError extends Error`, with `code = "EMAIL_OUTBOX_INSERT_SKIPPED"`.
  - `expiryWithin(deadline: Date | null, nowMs?: number): Date`.
  - `assertOutboxCanQueue(): void`, in `seal.ts`. It throws `new OutboxKeyUnavailableError(problem)` when
    `outboxKeyProblem()` returns non-null.

- [ ] **Step 1: Write the failing tests in `enqueue-once.test.ts`.** It uses `stubOutboxEnv()` from
  `src/server/usecases/__tests__/_invite-mail.ts`. Expected values come from the spec legend, never from
  `OUTBOX_KIND_FACTS`.
  - `the kind facts are the spec's legend`. Assert against this map:
    ```ts
    { magic_link: ["literal", true], chess_invite: ["account", true], registration_confirmation: ["literal", false], payment_reminder: ["literal", false], registration_promoted: ["literal", false], refund_issued: ["literal", false], solo_signup_assigned: ["literal", false] }
    ```
    `checked` is 7.
  - `a literal kind with recipientUserId is refused before any statement`: `registration_confirmation` with an id
    rejects with `OutboxKindMismatchError`, and the row count is unchanged.

    The guard is one-directional on purpose. An A kind without an id and a mismatched `transactional` flag are NOT
    refused here, because 31 phase-1 test sites enqueue `chess_invite` without a user id, and 8 enqueue T kinds with
    `transactional: false` to reach the suppression gate. The T7 harness pins both facts on every kind's REAL rows
    against the spec legend.
  - `enqueueEmailOnce writes recipient_user_id and dedupe_key and returns the id`.
  - `enqueueEmailOnce returns null on a duplicate and the original row is untouched`.
  - `two concurrent enqueueEmailOnce with one key: one row, neither transaction aborts, the original untouched`.
    1. Open tx A with `sql.begin`, enqueue k, and hold it open.
    2. In tx B (a second `sql.begin`), start enqueue k. Do not await it yet.
    3. Wait until `pg_stat_activity` shows B `wait_event_type = 'Lock'`.
    4. Commit A, then await B: it resolves `null`, and B's next statement (`select 1`) succeeds.
    5. Expected: one row with A's id, `status = 'queued'`.
  - `an insert with no once-key that writes nothing throws OutboxInsertSkippedError`. Use
    `vi.mock("node:crypto", importOriginal)` so `randomUUID` returns an existing row's id once. A dedicated
    `describe` holds the mock.
- [ ] **Step 2: Write the remaining tests.**
  - In `enqueue-expiry.test.ts`, add `expiryWithin`:
    - `null` gives `now + 24 h − 7 min`. Type it as `24 * 3_600_000 - 7 * 60_000`, from the spec, not from
      `MAX_EXPIRY_MS`.
    - An earlier deadline gives the deadline.
    - A later deadline gives the bound.
    - A deadline exactly at the bound gives the bound.
  - In `seal.test.ts`, test `assertOutboxCanQueue`. It throws `OutboxKeyUnavailableError` with code
    `EMAIL_OUTBOX_KEK_MISSING` when `RESEND_API_KEY` is set and the KEK is unset. It returns when both are unset.
  - In `readiness.test.ts`, the message for both problems contains `"every action that sends email will fail"` and
    no longer contains `"sign-in requests will fail"` (spec §8).
- [ ] **Step 3: Run the tests red.**
  - VERIFY `src/server/email-outbox/__tests__/{enqueue-once,enqueue-expiry,seal,readiness}.test.ts` → `t2`.
  - Expected: the new tests fail ("not a function", or a message mismatch). Record `total`.
- [ ] **Step 4: Implement.**
  - The facts check and the expiry check run before `sealBody`, so a refusal issues no statement.
  - Both functions share one private insert. It adds `recipient_user_id` and `dedupe_key` to the column list and
    ends with `on conflict do nothing`, with no target (P1). It reads `result.count`.
  - `enqueueEmailOnce` maps 0 to `null`. `enqueueEmail` maps 0 to `throw new OutboxInsertSkippedError(kind, refType)`.
    The error message names kind and ref type, never an address.
  - `expiryWithin` is `new Date(Math.min(deadline?.getTime() ?? Infinity, (nowMs ?? Date.now()) + MAX_EXPIRY_MS))`.
  - The readiness `WHAT` texts end `…will be refused, so every action that sends email will fail until it is set`.
    For `sample`, the ending is `…until a key of its own is set`.
  - Export the new names from `index.ts`.
- [ ] **Step 5: Run the tests green.**
  - VERIFY the same files plus `src/server/email-outbox/__tests__/{dispatch,worker}.test.ts` → `t2b`.
  - Expected: `failed: 0`. The callers are unchanged.
- [ ] **Step 6: Mutations.**
  - Delete the facts check: the refusal test fails.
  - Delete `on conflict do nothing`: the duplicate and concurrent tests fail (23505 aborts B).
  - Map 0 to an id in `enqueueEmail`: the skipped-insert test fails.
- [ ] **Step 7: TSC, LINT and commit.**
  `git commit -m "feat(email-outbox): kind facts guard, enqueueEmailOnce, expiryWithin, readiness names every email"`

### Task 3: The recipient is resolved at send time

**Files:**
- Create `apps/web/src/server/email-outbox/recipient.ts`.
- Modify:
  - `apps/web/src/server/email-outbox/attempt.ts`: `ClaimedRecord` and `ClaimedRow` at `:43-93`, after the expiry
    check at `:188-191`, the deliver call at `:219`, and the dispatchNow claim's RETURNING at `:433-434`.
  - `apps/web/src/server/email-outbox/worker.ts:162-179`.
  - `apps/web/src/server/email-outbox/account-deletion.ts`: add `deletedAccountPlaceholder`.
  - `apps/web/src/app/api/users/me/route.ts:165`: use the helper.
- Create `apps/web/src/server/email-outbox/__tests__/recipient-resolution.test.ts`.

**Interfaces:**
- Consumes `enqueueEmail` with `recipientUserId` (T2) and `ACCOUNT_DELETED_REASON` (`account-deletion.ts:31`).
- Produces:
  - `ClaimedRecord` gains `recipient_user_id: string | null`, `last_error: string | null` and `reclaimed: boolean`.
  - `ClaimedRow` gains `recipientUserId`, `lastError` and `reclaimed`.
  - `isKeyClean(row: Pick<ClaimedRow, "attempts" | "lastError" | "reclaimed">): boolean`.
  - `resolveRecipient(row: ClaimedRow): Promise<{ kind: "send"; to: string } | { kind: "deleted"; placeholder: string }>`.
  - `deletedAccountPlaceholder(userId: string): string`, which returns `deleted-${userId}@deleted.invalid`.

- [ ] **Step 1: Write the failing tests.** `recipient-resolution.test.ts` mocks only
  `@/server/email-outbox/transport`. It seeds users with `makeUser` from `_registration-fixtures.ts` and enqueues
  `chess_invite` rows with `recipientUserId`. A row is driven through `runOutboxTick({ onlyIds })` after it is aged
  past the first-attempt window (worker.test.ts's `bornAgo` pattern). It has these tests:
  - `isKeyClean follows the spec's table`. Each case is (attempts on the claimed row, lastError, reclaimed) → expected:
    - `(1, null, false)` → true
    - `(2, "http 429 rate_limit_exceeded", false)` → true
    - `(2, "http 503 x", false)` → false
    - `(3, "http 429 x", false)` → false
    - `(1, null, true)` → false
    - `(2, "http 429 x", true)` → false

    `checked` is 6.
  - `same address: sent to it`.
  - `changed address, key-clean: the row's recipient is rewritten and the new address is mailed under the same key`.
    Update `users.email` after enqueue. Expected: the transport receives `to = new` and
    `idempotencyKey = email-outbox/<id>`, and the row's `recipient` column equals `new`.
  - `changed address, not key-clean (a 503 attempt first): the first address is kept (D2)`.
  - `changed address after a lapsed lease is never key-clean`. Claim through the worker, and force the lease into
    the past with a privileged update. Change the email, then tick. Expected: the transport `to` is the old address.
  - `changed address after one 429: key-clean, the new address`.
  - `a deleted account is never mailed`. Set `users.deleted_at = now()` after enqueue, then tick. Expected:
    0 transport calls, and the row reads `expired`, `last_error = 'account_deleted'`,
    `recipient = deleted-<uid>@deleted.invalid`, `body_sealed is null`. The tick report shows `expired: 1`.
  - `an L kind is never resolved`: a `registration_confirmation` row whose address equals a user's old email, after
    that user changed it, is mailed at the row's address.
  - `dispatchNow's claim is key-clean`: the first attempt in a request after an email change mails the new address.
- [ ] **Step 2: Run the tests red.**
  - VERIFY `src/server/email-outbox/__tests__/recipient-resolution.test.ts` → `t3`.
  - Expected: failures on `isKeyClean` (not exported) and on the old address being mailed.
- [ ] **Step 3: Implement.**
  - In `claimOne`'s CTE, select `status as prior_status`. The RETURNING list adds `o.recipient_user_id`,
    `o.last_error` and `(picked.prior_status = 'sending') as reclaimed`.
  - dispatchNow's RETURNING adds `recipient_user_id, last_error, false as reclaimed`. It claims only `queued` rows
    with `attempts = 0`.
  - `toClaimedRow` maps the three new fields.
  - `resolveRecipient` reads `select email, deleted_at from users where id = $1` on the pool.
    - Null `recipientUserId` → send to `row.recipient`.
    - The user row is missing → `log.error({ outboxId })`, then send to `row.recipient`. The FK makes this
      impossible; the test reaches it through a replica-role insert of a row with an unknown user id. Add that case
      to Step 1 as `a recipient user id with no users row is sent literally and logged`.
    - The user is deleted → `deleted`.
    - The address is the same (`lower` equal) → send.
    - The address changed and `isKeyClean` → update `recipient` (fenced on `status = 'sending' and attempts = row.attempts`),
      then send to the new address.
    - Otherwise → send to `row.recipient`.
  - `attemptClaimed` calls `resolveRecipient` after the expiry check and before the gate. The gate and `deliver` use
    the resolved address.
  - A `deleted` result runs one fenced update to `expired` / `ACCOUNT_DELETED_REASON` / the placeholder, with body
    and lease nulled, and returns outcome `expired`. `endedRowFor` then hands it to the hook.
- [ ] **Step 4: Run the tests green.**
  - VERIFY `recipient-resolution.test.ts` plus
    `src/server/email-outbox/__tests__/{dispatch,dispatch-wire,dispatch-pacing,worker,worker-wire,hooks}.test.ts` → `t3b`.
  - Expected: `failed: 0`.
- [ ] **Step 5: Mutations.**
  - Skip the `deleted` branch: `a deleted account is never mailed` fails.
  - Make `isKeyClean` return `true`: the D2 test fails.
  - Ignore `reclaimed`: the lapsed-lease test fails.
  - Drop the `recipient` rewrite: the rewritten-column assertion fails.
- [ ] **Step 6: TSC, LINT and commit.**
  `git commit -m "feat(email-outbox): resolve an account's recipient at send time; a deleted account is never mailed"`

### Task 4: `chess_invite` becomes an A kind

**Files:**
- Modify:
  - `apps/web/src/server/usecases/external-play/guard.ts:28`, and the recipients map at `:410-412`.
  - `apps/web/src/server/usecases/external-play/invite.ts:205-230`.
  - `apps/web/src/server/email-outbox/enqueue.ts:127-143` (`carryRetryBudget`, P10).
- Create `apps/web/src/server/usecases/external-play/__tests__/invite-recipient.test.ts` and
  `apps/web/src/server/email-outbox/__tests__/a-kind-body.test.ts`.

**Interfaces:**
- Consumes T2 and T3.
- Produces `SidePlayer.recipients: { email: string; locale: string | null; userId: string }[]`.

- [ ] **Step 1: Write the failing tests in `invite-recipient.test.ts`.** Seed with `seedOnlineChessRound` from
  `_external-play-seed.ts`. Mock the transport with `deliverForTest` and `stubOutboxEnv`, then open the round with the
  real open (`open-round.ts`).
  - `an opened round's invites carry the player's user id`: every new row has `recipient_user_id` = the seat
    player's `userId`, and `checked` is the number of rows, which is at least 2.
  - `F3: an invite queued before an email change goes to the new address`. The open's attempt gets a 429, which is
    key-clean. Change `users.email`, make `next_attempt_at` due, and tick. Expected: the email goes to the new
    address. In the paired case the open's attempt gets a 503, and the old address is kept (D2).
  - `a deleted player's invite releases the seat`. The open answers 503. Set `deleted_at`, then tick. Expected: the
    row is `expired` / `account_deleted`, and the bridge's `<colour>_emailed_at` is null (the hook ran).
  - `a re-render (requeueUnsentInvites) after an email change carries the retry budget`: `carryRetryBudget` returns
    the count the caller expects, with no "differ" log.
- [ ] **Step 2: Write the A-kind body guard in `a-kind-body.test.ts`.**
  - For every kind with `OUTBOX_KIND_FACTS[k].to === "account"`, compare against an expected list typed from the
    spec, `["chess_invite"]`.
  - Render through the real producer (the open, as above). Open each row's body with `openBody`, and assert that the
    recipient's address (lower-cased) is absent from the subject, html and text.
  - `checked` must equal the expected list's length.
- [ ] **Step 3: Run the tests red.** VERIFY both files → `t4`. Expected: `recipient_user_id` is null on the
  open's rows, and F3 mails the old address.
- [ ] **Step 4: Implement.**
  - `guard.ts`'s map adds `userId: r.userId`. The filter's type guard narrows `userId` to `string`: a row with an
    email has a joined user.
  - `invite.ts`'s enqueue passes `recipientUserId: r.userId`.
  - In `carryRetryBudget`, the recipient conjunct becomes the trigger's `case` (T1 Step 3).
- [ ] **Step 5: Run the tests green.**
  - VERIFY both files plus `src/server/usecases/external-play/__tests__/invite-outbox.test.ts`,
    `src/server/usecases/__tests__/open-round.test.ts` (grep `-a` for its exact path) and every test file that names
    `queueFixtureInvite` or `requeueUnsentInvites` (`grep -arln`) → `t4b`.
  - Expected: `failed: 0`.
- [ ] **Step 6: Mutations.**
  - Make `externalPlayInviteEmail` append `to` to its text: the body guard fails.
  - Revert `carryRetryBudget` to `lower(recipient)`: the re-render test fails.
- [ ] **Step 7: TSC, LINT and commit.**
  `git commit -m "feat(external-play): chess invites name their account; recipient resolved at send"`

### Task 5: The generalised account-deletion sweep

**Files:**
- Modify:
  - `apps/web/src/server/email-outbox/account-deletion.ts:42-52`: replace `anonymiseChessInvites`.
  - `apps/web/src/app/api/users/me/route.ts:184-192`.
- Create `apps/web/src/app/api/users/me/__tests__/account-deletion-sweep.test.ts`.

**Interfaces:**
- Consumes `deletedAccountPlaceholder` (T3).
- Produces `anonymiseAccountEmails(tx: Tx, a: { userId: string; email: string; placeholder: string }): Promise<EndedRow[]>`.
  It does three things, in order:
  1. Deletes `magic_link` rows where `ref_id = userId or recipient = email`, as the route does today.
  2. Ends `queued` rows (to `expired` with `account_deleted`, body and lease nulled) where
     `recipient_user_id = userId or (kind = 'chess_invite' and recipient_user_id is null and recipient = email)`.
     The exact match is FU2's.
  3. Sets `recipient = placeholder` on every row matching that predicate, whatever its status.

  It returns the ended rows. `anonymiseChessInvites` is deleted.

- [ ] **Step 1: Write the failing tests.** Drive the real `DELETE` handler of `app/api/users/me/route.ts`, the way
  `account-deletion-outbox.test.ts` does. Seed for user U, then delete U:
  1. A `chess_invite` queued with `recipient_user_id = U` at U's OLD address (F3).
  2. A `chess_invite` `sent` with `recipient_user_id = U`.
  3. A pre-wave-1 `chess_invite` (no user id) at U's exact address.
  4. A pre-wave-1 `chess_invite` at a case-variant of U's address.
  5. A `registration_confirmation` queued to U's address.
  6. A `magic_link` for U.
  7. Another user's queued `chess_invite`.

  Assert:
  - Row 1 is `expired` / `account_deleted` with the placeholder.
  - Row 2 is still `sent`, with the placeholder.
  - Row 3 is `expired` with the placeholder.
  - Row 4 is untouched (FU2).
  - Row 5 is untouched: `queued`, its own address (D5).
  - Row 6 is gone.
  - Row 7 is untouched.
  - The ended count is 2.
  - The test reports `checked: 7`.
- [ ] **Step 2: Run the tests red.**
  - VERIFY the new file plus `src/app/api/users/me/__tests__/account-deletion-chess-invite.test.ts` and
    `src/app/api/users/me/__tests__/account-deletion-outbox.test.ts` → `t5`.
  - Expected: rows 1 and 2 fail.
- [ ] **Step 3: Implement.** The route calls `anonymiseAccountEmails(tx, { userId: user.id, email: user.email, placeholder: deletedAccountPlaceholder(user.id) })`
  in place of its `magic_link` delete and the `anonymiseChessInvites` call. It hands the returned rows to
  `afterEndedBadly` after commit, as today.
- [ ] **Step 4: Run the tests green.** VERIFY the same three files → `t5b`. Expected: `failed: 0`. The FU2 tests are
  unchanged and green.
- [ ] **Step 5: Mutations.**
  - Drop `recipient_user_id = userId`: row 1 fails.
  - Widen the match to any kind by address: row 5 fails.
  - Restrict the scrub to `queued`: row 2 fails.
- [ ] **Step 6: TSC, LINT and commit.**
  `git commit -m "feat(email-outbox): account deletion ends and scrubs the account's own rows (D5)"`

### Task 6: A void cancels the round's queued invites

**Files:**
- Create `apps/web/src/server/email-outbox/cancel.ts`.
- Modify:
  - `apps/web/src/server/email-outbox/index.ts`
  - `apps/web/src/server/email-outbox/status.ts:25`
  - `apps/web/src/server/usecases/stages.ts:2245-2256`, before the bridge delete at `:2255`
  - `apps/web/src/server/usecases/withdrawal.ts:264-449`
- Create `apps/web/src/server/usecases/external-play/__tests__/void-cancels-invites.test.ts`.

**Interfaces:**
- Consumes `email_outbox_cancel` (T1), plus `CHESS_SEAT_REF_TYPE` and `chessSeatRef` from
  `server/usecases/external-play/seat-stamp.ts:17`, `:21`. That file is a leaf with no usecase imports.
- Produces:
  - `ROUND_VOIDED_REASON = "round_voided"`
  - `BOARD_SETTLED_REASON = "board_settled"`
  - `CANCELLED_REASONS: readonly string[]`
  - `cancelQueuedEmails(tx: Tx, a: { kind: OutboxKind; refType: string; refIds: readonly string[]; reason: string }): Promise<EndedRow[]>`.
    Empty `refIds` returns `[]` and issues no statement.

- [ ] **Step 1: Write the failing tests.** Seed with `seedOnlineSwiss`. Open the round for real with the transport
  answering 503, so the invites are `queued` and retrying. Then:
  1. `unpair ends every queued invite of the round round_voided`. Run the real `unpairSwissRound`. Each of the
     round's invites reads `expired` / `round_voided` with no body. `checked` equals the row count, which is at
     least 4. A worker tick after making them due makes 0 transport calls.
  2. `a row already sending is left to finish`. Before unpair, set one row to `sending` with a lease. After unpair
     it is still `sending`.
  3. `deleting a seated entrant (unseat) ends that round's queued invites`. Run the real `deleteEntrant` from
     `entrants.ts:542`.
  4. `the chess hook does nothing once the bridge row is gone`.
     - `chessInviteEndedBadly(<an ended row>)` resolves, writes nothing and logs no error.
     - `findUnappliedChessEndings(50)` returns none of the voided rows.
  5. `re-opening after unpair queues fresh invites that stay queued`: a second call through the re-arm path,
     `open-round.ts:483`.
  6. `after Unpair and the same re-pair, the seat's latest status has no voided row` (P8, Review Focus 5).
     `latestEmailStatus(orgId, CHESS_SEAT_REF_TYPE, [ref])` returns `[]` for the re-paired seat before the re-open.
  7. `a withdrawal that walks over an opened board ends its queued invites board_settled`.
     - Run the real `withdrawEntrantCascade` on one entrant. Its board's rows are `expired` / `board_settled`, and
       the other boards' rows stay `queued`.
     - If the cascade refuses an opened online board, record that as a false premise. Replace this case with an
       assertion of the refusal, and list board-level cancel under residuals.
  8. `cancelQueuedEmails with no refs issues no statement`.
- [ ] **Step 2: Run the tests red.** VERIFY the new file → `t6`. Expected: tests 1, 3, 6 and 7 fail. Test 4 may pass
  already: it guards the existing `if (!bridge …)` at `invite-outbox-hook.ts:99`.
- [ ] **Step 3: Implement `cancel.ts`.** `cancelQueuedEmails` runs
  `select * from email_outbox_cancel(${kind}, ${refType}, ${refIds}::text[], ${reason})` and maps the rows to
  `EndedRow` with `status: "expired"`.
- [ ] **Step 4: Implement the void cancel.** In `clearSwissFixtureSeats`, after `lockBoardsRefusingOnlineGames` and
  before the bridge delete, call `cancelQueuedEmails` with
  `{ kind: "chess_invite", refType: CHESS_SEAT_REF_TYPE, refIds: ids.flatMap(id => [chessSeatRef(id, "white"), chessSeatRef(id, "black")]), reason: ROUND_VOIDED_REASON }`.
  Both callers are already `withTenant` transactions (`stages.ts:2347`, `entrants.ts:543`).
- [ ] **Step 5: Implement the board-level cancel.** `withdrawEntrantCascade` collects the fixture ids it passed to
  `applyUpdate` or `recordDoubleWalkover`. After the loop, in one `withTenant(auth.orgId, …)`, it calls
  `cancelQueuedEmails` for those boards' seat refs with `BOARD_SETTLED_REASON`.
- [ ] **Step 6: Change the status read.** `current()` in `status.ts:25` becomes
  `status <> 'replaced' and not (status = 'expired' and last_error = any(${CANCELLED_REASONS}))`.
  `latestEmailStatus` and `latestStatusesOfRows` share it.
- [ ] **Step 7: Run the tests green.**
  - VERIFY the new file plus `src/server/email-outbox/__tests__/status.test.ts` and every test file that names
    `unpairSwissRound`, `unseatSwissRoundsSeatingEntrant` or `withdrawEntrantCascade` (`grep -arln`) → `t6b`.
  - Expected: `failed: 0`.
- [ ] **Step 8: Mutations.**
  - Remove the call in `clearSwissFixtureSeats`: tests 1 and 3 fail.
  - Remove `!bridge ||` in `invite-outbox-hook.ts:99`: test 4 fails.
  - Remove the cascade's call: test 7 fails.
  - Restore `current()`: test 6 fails.
- [ ] **Step 9: TSC, LINT and commit.**
  `git commit -m "fix(external-play): voiding or walking over a board cancels its queued invites"`

### Task 7: The shared harness, the no-second-path scan, the locale helper

**Files:**
- Create:
  - `apps/web/src/server/email-outbox/locale.ts`
  - `apps/web/src/server/email-outbox/__tests__/locale.test.ts`
  - `apps/web/src/server/email-outbox/__tests__/_kind-harness.ts`
  - `apps/web/src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts`
  - `apps/web/src/server/email-outbox/__tests__/no-second-path.test.ts`

**Interfaces:**
- Produces `recipientLocale(db: Tx | typeof sql, a: { pick: string | null; userId: string | null; orgDefault: string | null }): Promise<Locale>`.
  - The order is `toLocale`-valid pick, then `users.locale` (with `deleted_at is null`), then `orgDefault`, then `en`.
  - An invalid value at any step falls through to the next.
- Produces this type:
  ```ts
  type KindScenario = {
    locale: Locale;
    subjectKey: string;
    subjectVars: Record<string, string>;
    recipient: string;
    firstAttempt: "request" | "worker";
    run: () => Promise<void>;
  };
  ```
  `subjectKey` is an `emails` dictionary key. `recipient` is the run-unique address the scenario mails.
- Produces `forEachOutboxKind(scenarios: Partial<Record<OutboxKind, KindScenario>>, opts: { notYetMoved: readonly OutboxKind[]; specFacts: Readonly<Record<OutboxKind, readonly ["account" | "literal" | "staff", boolean]>> }): Promise<{ checked: number; kinds: OutboxKind[] }>`.
  For each kind in `OUTBOX_KINDS`:
  1. If the kind is in `notYetMoved`, skip it. Otherwise a missing scenario throws `no scenario for outbox kind <k>`.
  2. Run `run()`.
  3. Find the rows with `kind = k and lower(recipient) = lower(recipient)`. There must be at least 1. Each row's
     `transactional` must equal `specFacts[k][1]`. Its `recipient_user_id` must be non-null exactly when
     `specFacts[k][0] === "account"`. This is the producer-level half of T2's one-directional guard.
  4. `request` → wait (`vi.waitFor`, 10 s) until no row is `queued` or `sending`. `worker` → assert that every row
     is still `queued` with `attempts = 0`, then `bornAgo(ids)` and `runOutboxTick({ onlyIds: ids })`.
  5. Assert the transport was called exactly once per row, with `email-outbox/<id>`. The subject equals
     `dictionarySubject(locale, subjectKey, subjectVars)`, which reads `src/dictionaries/<locale>/emails.json`
     directly and substitutes `{name}` tokens. Every row is `sent`, with `body_sealed is null`.
  6. A second `runOutboxTick({ onlyIds })` makes no transport call.
- Produces `bornAgo(ids: readonly string[], secs?: number): Promise<void>`.

- [ ] **Step 1: Write the failing tests.** These are not yet stated cases from the spec, so first write down the
  expected results for each locale case (D4):
  - `locale.test.ts`. Each case is (pick, account locale, account deleted, org default) → expected:
    - `("es", "fr", false, "nl")` → `es`
    - `(null, "fr", false, "nl")` → `fr`
    - `(null, "fr", true, "nl")` → `nl`
    - `(null, null, false, "nl")` → `nl`
    - `(null, null, false, null)` → `en`
    - `("xx", null, false, "fr")` → `fr`
    - `(null, "fr", false, null)` with `userId = null` → `en`, because there is no link (controller call §2).

    `checked` is 7.
  - `outbox-kind-sweep.test.ts`:
    - Typed from the spec: `const SPEC_KINDS = ["magic_link", "chess_invite", "registration_confirmation", "payment_reminder", "registration_promoted", "refund_issued", "solo_signup_assigned"]`.
    - `const NOT_YET_MOVED = ["registration_confirmation", "payment_reminder", "registration_promoted", "refund_issued", "solo_signup_assigned"]`.
      Each kind task removes its entry. T12 deletes the list.
    - `const SPEC_FACTS` is the spec legend map from T2 Step 1, typed again here. It is passed as
      `opts.specFacts`.
    - Scenarios for:
      - `magic_link`: the route POST of `app/api/auth/magic-link/route.ts`; `en`; `magicLink.subject`; `request`.
        It is `en` because the route passes no locale to `magicLinkEmail` (`route.ts:84`). Locale for account email
        is wave 3's.
      - `chess_invite`: the real open on a `seedOnlineChessRound` whose player has `users.locale = 'es'`;
        `externalPlayInvite.subject`; `request`.
    - Test `every outbox kind is swept through its real producer`. Assert `OUTBOX_KINDS` equals `SPEC_KINDS`, and
      `checked === SPEC_KINDS.length - NOT_YET_MOVED.length`, which is greater than 0.
    - Test `a kind with no scenario fails by name`. Call
      `forEachOutboxKind({}, { notYetMoved: [], specFacts: SPEC_FACTS })` and expect it to reject with
      `/no scenario for outbox kind magic_link/`.
    - Test `a row whose transactional flag disagrees with the spec fails`. Use a scenario that enqueues
      `magic_link` with `transactional: false`, and expect a rejection naming the kind.
  - `no-second-path.test.ts`:
    1. **Allowlist.** Collect every `export async function (send\w+)` in `src/lib/email.ts`, without
       `sendWithResult`. It equals the typed `SENDER_ALLOWLIST`: all 49 current names, copied once from the file,
       and its length must be 49 (spec "49 send* exports").
    2. **Imports.** No file under `src/` outside `src/server/email-outbox/` and `src/lib/email.ts` may import
       `deliver`, `sendWithResult` or `checkSendable` from `@/lib/email` or `@/server/email-outbox/transport`.
       Match the import specifier text with `readFileSync`. The test reports the number of files scanned, which must
       be greater than 0.
    3. **Resend URL.** No file under `src/` except `src/server/email-outbox/transport.ts` and `src/lib/email.ts`
       contains `api.resend.com`.
- [ ] **Step 2: Run the tests red.** VERIFY the three test files → `t7`. Expected: `recipientLocale` and
  `forEachOutboxKind` are not found.
- [ ] **Step 3: Implement** `locale.ts` and `_kind-harness.ts` to the Interfaces above.
- [ ] **Step 4: Run the tests green.** VERIFY → `t7b`. Expected: `failed: 0`, and the sweep reports `checked: 2`.
- [ ] **Step 5: Mutations.**
  - Drop the account step from `recipientLocale`: case 2 fails.
  - Make the harness skip a missing scenario silently: the no-scenario test fails.
  - Add `import { deliver } from "@/server/email-outbox/transport"` to `registrations.ts`: the scan fails.
- [ ] **Step 6: TSC, LINT and commit.**
  `git commit -m "test(email-outbox): kind sweep through real producers, no-second-path scan, recipient locale"`

### Task 8: `registration_confirmation`

**Files:**
- Modify:
  - `apps/web/src/lib/email.ts:565-570`: delete `sendRegistrationEmail`; add
    `registrationEmail(args: RegistrationEmailArgs, locale: Locale): Promise<EmailContent>`.
  - `apps/web/src/server/usecases/registrations.ts`: `buildCartMail` at `:1507`, `notifySubmitted` at `:1621-1638`,
    `resendRegistrationConfirmation` at `:1651-1702` and `resendRegistrationConfirmationPublic` at `:1718-1753`.
  - `apps/web/src/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route.ts:68`.
  - `apps/web/src/server/api-v1/openapi.ts:319` (a stale comment naming the sender).
  - `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`: `reg.hub.registrants.detail.actions.resendNotSent`.
- Create `apps/web/src/server/usecases/__tests__/registration-confirmation-outbox.test.ts`.
- Repoint every test that names `sendRegistrationEmail` (`grep -arln sendRegistrationEmail apps/web/src`):
  - `register-route.test.ts`
  - `resend-confirmation-route.test.ts`
  - `registration-status-read.test.ts`
  - `registrations.test.ts`
  - `registration-assign.test.ts`

  Each one asserts the outbox row (kind, ref, recipient, subject), not a mock call. A `vi.mock("@/lib/email")`
  factory in these files must spread `importOriginal`.

**Interfaces:**
- Consumes `enqueueEmail`, `dispatchNow`, `assertOutboxCanQueue`, `recipientLocale` and `deferred`
  (`lib/deferred.ts:14`).
- The ref is `ref_type = "registration_group"`, `ref_id = <group id>`, with no once-key. A resend fully restates the
  cart, so it supersedes the older row.
- `buildCartMail` returns `{ to, locale: Locale, orgId, competitionId, args }`. Its select adds `org_id` and
  `user_id`, and it resolves the locale through `recipientLocale(sql, { pick: group.locale, userId: group.user_id, orgDefault: ctx.default_locale })`.

- [ ] **Step 1: Write the failing tests.** They mock only the transport, run `stubOutboxEnv()`, and seed with `rig()`
  from `_registration-fixtures.ts`.
  1. `submit queues one confirmation in the registrant's locale and sends it`. The real route POST, with a free
     division and `locale: "es"`. Expected:
     - One row: kind `registration_confirmation`, ref `registration_group/<group_id>`, recipient = the contact.
     - The subject is `dictionarySubject("es", "registration.subject", { competitionName })`.
     - After the deferred dispatch the row is `sent`, with no body, and there was one transport call with its key.
  2. `the organiser's resend reports sent:false while the outbox retries, and the worker sends it later`.
     - With the transport answering 503, the result is `{ sent: false }` and the row is `queued` with
       `attempts = 1`.
     - With `next_attempt_at` pulled to now, the tick sends it.
  3. `a second resend supersedes the first`: two rows, the older `replaced` or `sent`, the newer `sent`, and two
     transport calls.
  4. `empty input: no group gives no row and no throw`. `notifySubmitted(randomUUID(), …)` resolves, and the row
     count is unchanged.
  5. `after withdrawal: resend on a withdrawn entry is refused and queues nothing`: a 422 and 0 rows.
  6. `a key fault refuses the submit before any cart is committed` (Review Focus 4). With `RESEND_API_KEY` set and the
     KEK unset, the route POST answers `status >= 500`. No `registration_groups` row has the contact email, and no
     outbox row exists.
  7. `rollback: the organiser's resend whose audit fails queues nothing`. `vi.mock("@/server/usecases/audit", importOriginal)`
     rejects once. The call throws and there are 0 rows.
  8. `D4: a cart with no locale and an nl org default is written in Dutch`.
  9. `a refused enqueue after the submit committed is logged, and the 201 stands` (P4). Make `enqueueEmail` throw
     once with a mocked module: the response is 201 and `log.error` was called with `groupId`.
- [ ] **Step 2: Add the sweep scenario.** In `outbox-kind-sweep.test.ts`, add `registration_confirmation` (route
  POST, `es`, `registration.subject`, `request`) and remove it from `NOT_YET_MOVED`. In `no-second-path.test.ts`,
  remove `sendRegistrationEmail` from `SENDER_ALLOWLIST` and change its length to 48.
- [ ] **Step 3: Run the tests red.** VERIFY the new file, the sweep, the scan and the five repointed files → `t8`.
  Expected: the new tests fail. Record `total`.
- [ ] **Step 4: Implement.**
  - `notifySubmitted` keeps its never-throws contract (P4). It runs `buildCartMail`, then
    `enqueueEmail(sql, { kind: "registration_confirmation", refType: "registration_group", refId: groupId, orgId: mail.orgId, to: mail.to, ...await registrationEmail(mail.args, mail.locale), transactional: false, expiresAt: expiryWithin(null) })`,
    then `deferred(() => dispatchNow([id]))`. Its catch is `log.error({ err, groupId }, …)`, as today.
  - The route calls `assertOutboxCanQueue()` before `submitRegistrationGroup`.
  - The organiser resend runs `buildCartMail` on the pool, then one `withTenant(auth.orgId, tx => { id = enqueueEmail(tx, …); audit(tx, …) })`.
    It reports `sent = (await dispatchNow([id])).get(id) === "sent"`. Delete the `:1680-1687` warn (spec §8).
  - The public resend wraps enqueue and audit in one `sql.begin` and reports `sent` the same way.
  - `registrationEmail` renders from the `emails` dictionary exactly as the deleted sender did.
  - Update the `openapi.ts:319` comment to name the outbox row.
- [ ] **Step 5: Reword the notice.** Set `reg.hub.registrants.detail.actions.resendNotSent` in each dictionary, then
  run `cd <worktree> && pnpm i18n:gen-keys && pnpm i18n:check`. Expected: no gen-keys diff, and check exits 0. Match
  each file's existing apostrophe and colon style.
  - en: `The confirmation email didn't go out straight away. It may arrive late, or not at all — if they don't receive it, contact them directly.`
  - es: `El correo de confirmación no salió de inmediato. Puede llegar más tarde o no llegar; si la persona no lo recibe, póngase en contacto con ella directamente.`
  - fr: `L'e-mail de confirmation n'est pas parti tout de suite. Il peut arriver en retard, ou pas du tout : si la personne ne le reçoit pas, contactez-la directement.`
  - nl: `De bevestigingsmail is niet meteen verstuurd. Hij kan later aankomen, of helemaal niet: als de persoon hem niet ontvangt, neem dan rechtstreeks contact op.`
- [ ] **Step 6: Run the tests green.**
  - VERIFY the `t8` set plus `src/components/__tests__/registration-hub-registrant-actions.test.tsx` → `t8b`. That
    file reads the key from the dictionary.
  - Expected: `failed: 0`, and the sweep reports `checked: 3`.
- [ ] **Step 7: Mutations.**
  - Remove `assertOutboxCanQueue()` from the route: test 6 fails.
  - Move the organiser resend's enqueue after its `withTenant`: test 7 fails.
  - Set `sent = true`: test 2 fails.
- [ ] **Step 8: TSC, LINT and commit.**
  `git commit -m "feat(registrations): the registration confirmation goes through the outbox"`

### Task 9: `payment_reminder` (F8)

**Files:**
- Modify:
  - `apps/web/src/lib/email.ts:572-583`: delete the sender; add `paymentReminderEmail(args, locale)`.
  - `apps/web/src/server/usecases/registrations.ts`: pass 1a at `:5008-5050`, pass 1b at `:5094-5140`, and
    `sendPaymentReminder` at `:6013-6042`.
  - `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`: `reg.remind.notSent`.
- Create `apps/web/src/server/usecases/__tests__/payment-reminder-outbox.test.ts`.
- Repoint `registrations.test.ts` and `registration-checkout-guards.test.ts`. The test near `registrations.test.ts:2798`
  asserts that a failed send releases the lease. That is F8 frozen as expected behaviour; replace it with test 1
  below.

**Interfaces:**
- Consumes `enqueueEmailOnce`, `enqueueEmail`, `expiryWithin`, `outboxKeyProblem` and `recipientLocale`.
- The ref is `registration/<reg id>`.
- Once-keys:
  - Pass 1a: `${reg.id}:submit`.
  - Pass 1b: `${reg.id}:promotion:${reg.promoted_at.toISOString()}` (P7).
  - Manual reminder: none (a press).
- Expiry:
  - Pass 1a: `expiryWithin(<the payDeadline pass 1a passes today>)`.
  - Pass 1b: `expiryWithin(reg.promotion_expires_at)`.
  - Manual: `expiryWithin(null)`.
- First attempt: the sweep leaves it to the worker. The manual press awaits `dispatchNow`.

- [ ] **Step 1: Write the failing tests.** They use `stripeRig()` and the file's existing
  `vi.mock("@/lib/stripe")` shape, and count `checkout.sessions.create` calls.
  1. `F8: a due reminder gives one row and one Checkout session; nothing is released`.
     - One sweep: 1 row, `queued` with `attempts = 0` (the transport is not called), 1 create call, and
       `submit_reminded_at` set in the same commit.
     - A second sweep: still 1 row and 1 create.
     - After `bornAgo`, a tick with the transport answering 503 gives `queued` with `attempts = 1`. A later tick
       gives `sent`.
  2. `a re-promoted entry gets its second-cycle reminder` (Review Focus 2). Promote, run the sweep (row 1), lapse
     back to the waitlist, promote again, and run the sweep. Expected: 2 rows with distinct once-keys, and 2 creates.
  3. `two concurrent sweeps give one reminder and one session`: `Promise.all` of two `sweepRegistrations` gives
     1 row and 1 create.
  4. `a key fault skips both reminder passes` (Review Focus 3). With `RESEND_API_KEY` set and the KEK unset: 0 creates,
     0 rows, both `*_reminded_at` and both `*_claimed_at` null, and one `log.error`.
  5. `a failed enqueue transaction keeps the lease`. Make `enqueueEmailOnce` throw once with a mocked module. The
     first sweep gives 0 rows, 1 create and `claimed_at` still set. An immediate second sweep gives still 1 create.
  6. `the manual reminder reports sent and records its audit in the same transaction`.
     - With the transport OK: `{ sent: true }`.
     - With the transport answering 503: `{ sent: false }` and the row `queued`.
     - With the audit rejecting once: the call throws and there are 0 rows.
  7. `empty input: fee 0 is refused and queues nothing`: a 422 and 0 rows.
  8. `after withdrawal: a non-pending entry is refused and queues nothing`.
  9. `the reminder is in the registrant's locale`: a `fr` group gives `paymentReminder.subject` in fr.
- [ ] **Step 2: Add the sweep scenario.** In `outbox-kind-sweep.test.ts`, add `payment_reminder` (sweep pass 1a,
  `fr`, `paymentReminder.subject`, `worker`) and remove it from `NOT_YET_MOVED`. In the scan, remove
  `sendPaymentReminderEmail` from the allowlist and change its length to 47.
- [ ] **Step 3: Run the tests red.** VERIFY the new file, the sweep, the scan and the two repointed files → `t9`.
- [ ] **Step 4: Implement the sweep passes.**
  - Each pass: claim as today, then mint. A throw from the mint releases the lease, because no session exists.
  - Once minted, run one `sql.begin(tx => { await enqueueEmailOnce(tx, …); await tx\`update registrations set <submit|promotion>_reminded_at = now(), updated_at = now() where id = …\` })`.
    The pass releases nothing after the mint (spec §8).
  - At the top of `sweepRegistrations`, before pass 1a: `const keyProblem = outboxKeyProblem()`. If it is
    non-null, `log.error({ problem: keyProblem }, "registrations: reminder passes skipped — the outbox cannot queue email")`
    and skip passes 1a and 1b only.
  - `reminded++` counts the transactions that committed.
- [ ] **Step 5: Implement the manual reminder.** `sendPaymentReminder` runs `withTenant(auth.orgId, tx => { id = enqueueEmail(tx, …); audit(tx, …) })`,
  then `sent = (await dispatchNow([id])).get(id) === "sent"`. `divisionCtx` and `loadSettings` stay before the
  transaction.
- [ ] **Step 6: Reword the notice.** Set `reg.remind.notSent` in each dictionary, then run gen-keys and check as in T8.
  - en: `The reminder didn't go out straight away. It may arrive late, or not at all — if they don't receive it, contact them directly.`
  - es: `El recordatorio no salió de inmediato. Puede llegar más tarde o no llegar; si la persona no lo recibe, póngase en contacto con ella directamente.`
  - fr: `Le rappel n'est pas parti tout de suite. Il peut arriver en retard, ou pas du tout : si la personne ne le reçoit pas, contactez-la directement.`
  - nl: `De herinnering is niet meteen verstuurd. Ze kan later aankomen, of helemaal niet: als de persoon haar niet ontvangt, neem dan rechtstreeks contact op.`
- [ ] **Step 7: Run the tests green.** VERIFY `t9`'s set → `t9b`. Expected: `failed: 0`, and the sweep reports
  `checked: 4`.
- [ ] **Step 8: Mutations.**
  - Move the stamp out of the enqueue transaction: tests 1 and 3 fail with 2 creates.
  - Restore the lease release in the transaction's catch: test 5 fails with 2 creates (P11).
  - Drop `promoted_at` from the 1b key: test 2 fails.
  - Delete the key pre-check: test 4 fails.
  - Move the manual enqueue out of the audit transaction: test 6's rollback fails.
- [ ] **Step 9: TSC, LINT and commit.**
  `git commit -m "fix(registrations): payment reminders through the outbox; one Checkout session per reminder (F8)"`

### Task 10: `registration_promoted`

**Files:**
- Modify:
  - `apps/web/src/lib/email.ts:585-596`: delete the sender; add `registrationPromotedEmail(args, locale)`.
  - `apps/web/src/server/usecases/registrations.ts:1330-1380` (`notifyPromoted`), and its callers at `:4798`,
    `:5227` and `:5320`.
  - `apps/web/src/server/usecases/registration-approval.ts:255`, `:418`.
- Create `apps/web/src/server/usecases/__tests__/registration-promoted-outbox.test.ts`.
- Repoint `registration-status-money-review-fixes.test.ts`.

**Interfaces:**
- Produces `notifyPromoted(promoted, ctx, settings, origin, opts: { firstAttempt: "request" | "worker" }): Promise<void>`.
  - Request callers pass `"request"`: `:4798`, and approval `:255` and `:418`.
  - The sweep callers pass `"worker"`: `:5227` and `:5320`.
- The ref is `registration/<promoted.id>`.
- The once-key is `${promoted.id}:${promoted.promoted_at.toISOString()}`.
- The expiry is `expiryWithin(promoted.promotion_expires_at)`.
- The locale is `recipientLocale(sql, { pick: promoted.locale, userId: promoted.user_id, orgDefault: ctx.default_locale })`.

- [ ] **Step 1: Write the failing tests.**
  1. `a promotion from a withdrawal queues one email in the registrant's locale and sends it`. In a full division
     with a waitlisted `nl` entry, run the real withdrawal of a confirmed entry. Expected: 1 row
     `registration_promoted`, ref `registration/<id>`, with `registrationPromoted.subject` in nl. It reaches `sent`
     through the deferred dispatch.
  2. `a replayed notifyPromoted for the same promotion queues one row`: called twice, the result is 1 row.
  3. `the sweep's promotion is left to the worker`: after the sweep the row is `queued` with `attempts = 0` and 0
     transport calls. After `bornAgo` and a tick it is `sent`.
  4. `a promoted row with no promoted_at is refused by name`. The guard says "cannot happen". The test calls
     `notifyPromoted` with `promoted_at: null`, and expects 0 rows and `log.error` with `"notifyPromoted: a promoted registration has no promoted_at"`.
  5. `a refused enqueue after the promotion committed is logged; the withdrawal stands` (P4). Under a key fault the
     withdrawal returns OK, `log.error` is called and there are 0 rows.
  6. `after a refund-bearing withdrawal the promotion still queues` (spec "after a withdrawal").
- [ ] **Step 2: Add the sweep scenario.** In `outbox-kind-sweep.test.ts`, add `registration_promoted` (withdrawal,
  `nl`, `registrationPromoted.subject`, `request`) and remove it from `NOT_YET_MOVED`. In the scan, remove the sender
  and change the length to 46.
- [ ] **Step 3: Run the tests red.** VERIFY the new file, the sweep, the scan and the repointed file → `t10`.
- [ ] **Step 4: Implement.**
  - After its mint, `notifyPromoted` runs `enqueueEmailOnce(sql, …)` on the pool (P4). For `"request"`, it adds
    `deferred(() => dispatchNow([id]))` when the id is not null.
  - The bare `catch {}` becomes `catch (err) { log.error({ err, registrationId: promoted.id }, "registration: promotion email could not be queued") }`.
  - The `promoted_at` guard throws inside the try.
- [ ] **Step 5: Run the tests green.**
  - VERIFY `t10`'s set plus `src/server/usecases/__tests__/registration-approval.test.ts` → `t10b`.
  - Expected: `failed: 0`, and the sweep reports `checked: 5`.
- [ ] **Step 6: Mutations.**
  - Use `enqueueEmail` with no key: test 2 fails with 2 rows.
  - Dispatch on the worker path: test 3 fails because the transport is called during the sweep.
  - Drop the `promoted_at` guard: test 4 fails, because the log then carries a TypeError, not the named refusal.
- [ ] **Step 7: TSC, LINT and commit.**
  `git commit -m "feat(registrations): the waitlist promotion email goes through the outbox"`

### Task 11: `refund_issued`

**Files:**
- Modify:
  - `apps/web/src/lib/email.ts:614-625`: delete the sender; add `refundIssuedEmail(args, locale)`.
  - `apps/web/src/server/usecases/registrations.ts`: `:4468-4481` replaces `notifyRefund`; the call sites are
    `:3086-3114` (webhook late and duplicate), `:4848-4865` (`withdrawCore`), `:5421-5439` (pool-deadline sweep)
    and `:6102-6123` (`refundRegistration`).
  - `apps/web/src/server/usecases/registration-approval.ts:262-279` (reject).
- Create `apps/web/src/server/usecases/__tests__/refund-issued-outbox.test.ts`.

**Interfaces:**
- Produces `queueRefundReceipt(tx: Tx, a: { reg: RegistrationWithGroupRow; ctx: DivisionCtx; amountCents: number; refundId: string }): Promise<string | null>`.
  - It renders and runs `tx.savepoint(sp => enqueueEmailOnce(sp, …))` (R4). The render and the savepoint call are
    both inside one try, so a render error is contained as well.
  - It returns the id. It returns `null` for a duplicate, or for a refusal caught at the savepoint, which logs
    `log.error({ err, registrationId, refundId }, "registration: refund receipt could not be queued")`.
  - `notifyRefund` is deleted.
- The ref is `refund/<refundId>`, and the once-key is `refundId`.
- Each call moves inside the site's existing refund-record transaction:
  - `withdrawCore`, the pool-deadline sweep and reject each use their `sql.begin`.
  - `refundRegistration` uses its `withTenant`, with `divisionCtx` read before it.
  - The webhook's late path uses its `sql.begin`. The duplicate path gets a new `sql.begin` around the call.
- The render's `ctx` is always read before the transaction.
- Request sites (`withdrawCore`, reject, `refundRegistration`) add `deferred(() => dispatchNow([id]))` after commit.
  The webhook and the sweep do not.

- [ ] **Step 1: Write the failing tests.** `refunds.create` is mocked to return `{ id: "re_<run>_<n>" }`.
  1. `an organiser refund queues one receipt in the registrant's locale and sends it`: ref `refund/re_…`, once-key
     `re_…`, `refundIssued.subject` in es, and `sent`.
  2. `the same Stripe refund twice gives one receipt`: `queueRefundReceipt` with one `refundId` in two transactions
     gives 1 row.
  3. `two partial refunds give two receipts` (the ref rule): 2 rows, neither `replaced`.
  4. `a refund whose receipt cannot be queued is still recorded, and is not a refund failure` (Review Focus 1).
     Under a key fault, `refundRegistration` resolves. `refunded_cents` increased. There is no
     `registration.refund_failed` audit row. The staff refund-failed alert mock is not called. `log.error` was
     called, and there are 0 rows.
  5. `the webhook's late refund leaves the first attempt to the worker`: a `queued` row with `attempts = 0`, and 0
     transport calls during the handler.
  6. `a withdrawal's auto-refund queues its receipt` (spec "a refund after a withdrawal").
  7. `rollback: refundRegistration whose audit fails queues nothing`: the audit rejects once, and there are 0 rows.
- [ ] **Step 2: Add the sweep scenario.** In `outbox-kind-sweep.test.ts`, add `refund_issued` (`refundRegistration`,
  `es`, `refundIssued.subject`, `request`) and remove it from `NOT_YET_MOVED`. In the scan, remove the sender and
  change the length to 45.
- [ ] **Step 3: Run the tests red.** VERIFY the new file, the sweep and the scan → `t11`.
- [ ] **Step 4: Implement** as in Interfaces.
- [ ] **Step 5: Run the tests green.**
  - VERIFY `t11`'s set plus `src/server/usecases/__tests__/registrations.test.ts`,
    `src/server/usecases/__tests__/registration-approval.test.ts`,
    `src/server/usecases/__tests__/credit-pack-refund.test.ts` and
    `src/server/usecases/__tests__/pass-credit-refund-reversal.test.ts` → `t11b`. The last two mock `@/lib/email`
    without `importOriginal` and drive `charge.refunded`.
  - Expected: `failed: 0`, and the sweep reports `checked: 6`.
- [ ] **Step 6: Mutations.**
  - Drop the savepoint: test 4 fails (the transaction aborts and `refunded_cents` is unrecorded, or `refund_failed`
    is written).
  - Use `enqueueEmail` with no key: test 2 fails.
  - Move the call after the transaction: test 7 fails.
- [ ] **Step 7: TSC, LINT and commit.**
  `git commit -m "feat(registrations): refund receipts through the outbox, in the refund's own transaction"`

### Task 12: `solo_signup_assigned`, and closing the wave's sweep

**Files:**
- Modify:
  - `apps/web/src/lib/email.ts:598-612`: delete the sender; add `soloSignUpAssignedEmail(args, locale)`.
  - `apps/web/src/server/usecases/registration-assign.ts`: the transaction body `:143-376`, and the post-commit block
    `:378-405`.
- Create `apps/web/src/server/usecases/__tests__/solo-assigned-outbox.test.ts`.
- Repoint `registration-assign.test.ts`.
- Modify `outbox-kind-sweep.test.ts` and `no-second-path.test.ts`.

**Interfaces:**
- The enqueue runs inside the assignment's `withTenant`, before its `audit` call at `:346`.
- It reads `divisionCtx(tx, …)` and `recipientLocale(tx, { pick: source.locale, userId: source.user_id, orgDefault: ctx.default_locale })`.
- The ref is `registration/<sourceId>`, with no once-key.
- It is skipped on the `alreadyPlaced` path and when `source.contact_email` is empty.
- After commit, `deferred(() => dispatchNow([id]))`.
- The transaction returns the outbox id, or null, in place of the two `notify` objects at `:241` and `:368`. Those
  objects and the `:378-405` block are deleted. `notify` never reaches the function's own return value (`:420-427`).

- [ ] **Step 1: Write the failing tests.**
  1. `an assignment queues one email in the person's locale and sends it`: a `fr` source gives
     `soloSignUpAssigned.subject` with `{teamName}`, then `sent`.
  2. `a double Assign sends one email`: the second call is `alreadyPlaced`, and there is still 1 row.
  3. `empty input: a source with no contact email assigns and queues nothing`.
  4. `rollback: an assignment whose audit fails queues nothing`.
  5. `after withdrawal: assigning a withdrawn source is refused and queues nothing`.
- [ ] **Step 2: Close the sweep and the scan.**
  - In `outbox-kind-sweep.test.ts`, add `solo_signup_assigned`, delete `NOT_YET_MOVED`, and assert
    `checked === SPEC_KINDS.length` (7).
  - In the scan, remove the sender. The allowlist length becomes **44**: 49 − 5, the spec's wave-1 count.
- [ ] **Step 3: Run the tests red.** VERIFY the new file, the sweep, the scan and `registration-assign.test.ts` →
  `t12`.
- [ ] **Step 4: Implement** as in Interfaces.
- [ ] **Step 5: Run the tests green.** VERIFY `t12`'s set → `t12b`. Expected: `failed: 0`, and the sweep reports
  `checked: 7`.
- [ ] **Step 6: Mutations.**
  - Move the enqueue after the audit (or after commit): test 4 fails.
  - Enqueue on the `alreadyPlaced` path: test 2 fails.
- [ ] **Step 7: Final scoped re-run.** Run the wave's own files only, in one VERIFY → `t12c`:
  - every test file this plan created or modified;
  - `src/server/email-outbox/__tests__/*.test.ts`;
  - `src/server/usecases/external-play/__tests__/invite-outbox.test.ts`.

  Paste `total`, `passed` and `failed`. Then run TSC.
- [ ] **Step 8: LINT and commit.**
  `git commit -m "feat(registrations): solo assignment email through the outbox; wave-1 kind sweep closed at 7"`

### Task 13: Smoke

**Files:**
- Modify `scripts/smoke.ts`:
  - add `checkOutboxRow` next to `checkSignInOutbox` (`:8978`);
  - in `registrationOpenFlowSuite`, after the free submit (`:24043-24064`), add `group_id` to its `SubmitOut` type;
  - in `SELECTABLE_SUITES` (`:23145`), add `registrationOpenFlow: () => registrationOpenFlowSuite()` at the end.
- Modify `scripts/__tests__/smoke-select.test.ts`: append `"registrationOpenFlow"` to `KNOWN` (`:10-24`) and to the
  comment's history.

**Interfaces:**
- `checkOutboxRow(kind: string, refType: string, refId: string): Promise<void>`. It uses the same keyless early
  return and the same connection as `checkSignInOutbox`, and polls for up to 20 s.
- Its checks:
  - `<kind>: one outbox row for the ref`
  - `<kind>: its first attempt was made (not waiting)`
  - `<kind>: no sealed body is left on the row`

- [ ] **Step 1: Write the failing test.** Append `registrationOpenFlow` to `KNOWN`. Run
  `cd <worktree> && npx vitest run scripts/__tests__/smoke-select.test.ts --reporter=json --outputFile=$OUT/t13.json; echo EXIT=$?`.
  Expected: the registry test fails.
- [ ] **Step 2: Implement.** Register the suite, add the helper, and call
  `checkOutboxRow("registration_confirmation", "registration_group", freeOut.group_id)` after the free submit's
  checks.
- [ ] **Step 3: Run the selector test again.** Expected: green.
- [ ] **Step 4: Run the smoke suite against the local prod server.**
  - Run `$S up --label outbox-p3 --server`, then `cd <worktree> && eval "$($S env --label outbox-p3)" && SMOKE_ONLY=registrationOpenFlow pnpm test:smoke; echo EXIT=$?`.
  - Expected: `EXIT=0`. The three new check lines print as passed.
  - Paste the `SMOKE_ONLY: ran 1 suite(s)` line.
- [ ] **Step 5: Commit.** `git commit -m "test(smoke): registration submit leaves one confirmation outbox row"`

### Task 14: e2e and the visual check (CI dispatch only)

**Files:**
- Modify `apps/web/e2e/registration-hub.spec.ts`: one new test, next to the resend test at `:1115`.
- Modify `apps/web/e2e/online-chess-desk.spec.ts`: one new test, after `:659`.

**Interfaces:**
- Consumes `withDb` and `apiJson` from `e2e/helpers.ts`, `seedOnlineRound` from `e2e/match-room-kit.ts:372`, and the
  existing helpers in each spec.
- Both tests skip on `PROD_TARGET`, as `passwordless-login.spec.ts:43-55` does.

- [ ] **Step 1: Write the registration test,
  `a submitted registration leaves one confirmation row, and Resend says the email may arrive late`.**
  1. Run `seedDivision`, the settings PUT (free, manual) and the public submit.
  2. `withDb` polls for one `registration_confirmation` row for `registration_group/<group_id>`, not
     `queued`/`sending`, with a null body.
  3. As the organiser, open the registrant row, click `[data-registration-hub-registrant-action="resend"]`, and
     expect `[data-registration-hub-registrant-actions-feedback]` to contain the T8 en copy for `resendNotSent`.
     CI has no key, so the first attempt dies.
  4. `withDb`: 2 rows, both non-waiting.
- [ ] **Step 2: Write the desk test, `unpairing an opened online round ends a still-queued invite round_voided`.**
  1. Open the round with `seedOnlineRound(request, names, { stage: "swiss" })` as the test at `:282` does.
  2. `withDb` inserts one `queued` `chess_invite` row for `fixture_seat/<boards[0].fixtureId>:white`, with the
     round's org, `next_attempt_at = now() + interval '1 hour'` (no tick can take it),
     `expires_at = now() + interval '2 hours'`, a one-byte `body_sealed`, and meta `{fixtureId, colour, stampedAt}`.
  3. Press Unpair as the test at `:659` does. No game is on file, so it succeeds.
  4. `withDb` polls the seeded row: `expired`, `last_error = 'round_voided'`, `body_sealed is null` (P5).
- [ ] **Step 3: Collect without running.** Run `cd <worktree>/apps/web && npx playwright test --list e2e/registration-hub.spec.ts e2e/online-chess-desk.spec.ts; echo EXIT=$?`.
  Expected: both new titles are listed. `--list` only collects. Then run TSC.
- [ ] **Step 4: Visual check.** Invoke the frontend-design skill first: the notice is UI copy.
  - With the T13 server up, use Playwright MCP against `localhost`: sign in, open a registrant's actions on
    `/<org>/…/registrants`, and press Resend.
  - Screenshot the feedback element at **1280, 320 and 768**. At each width, assert
    `document.documentElement.scrollWidth <= innerWidth` (no horizontal page scroll).
  - Confirm the three images exist and differ.
  - Publish them on one Artifact page. They never go in the repo.
- [ ] **Step 5: Commit and hand back.**
  - `git commit -m "test(e2e): confirmation row on submit; unpair ends a queued invite round_voided"`.
  - Do not push. The controller pushes, opens the PR, and dispatches
    `gh workflow run e2e.yml --ref feat/email-outbox-phase3 -f pr=<n>`. CI must cover all of `registration-hub.spec.ts`
    and `online-chess-desk.spec.ts`, never a `-g` slice. Smoke also runs on the PR.

## Next waves

- **Wave 2:** 10 kinds.
  - Dispute alert and dispute lost.
  - Sponsor invoice, receipt, refund, dispute alert, dispute won and dispute lost.
  - Pass revoked and trial ending.
  - F7 (`runEvent` replay gives one row per kind).
  - Its migration is main's max + 1, widening the CHECK.
- **Wave 3:** 8 kinds.
  - Email verification and funnel claim.
  - Email-change confirmation (older rows ended through `cancelQueuedEmails`) and email-change notice.
  - Account deletion (literal and scrubbed, queued after the T5 sweep).
  - Org invite, claim invite (all 7 sites, F9) and official invite.
  - It rewords `officials.inviteEmailFailed` and `settings.team.inviteEmail.notSent`.
- **Wave 4:** 9 kinds.
  - Official assigned and official assignment changed (F5 locale).
  - Suspension confirmed and suspension served (replacing the `xmin` check after the proof).
  - Match report submitted.
  - Group transfer offer, group transfer complete, group org removed and group org left.
- **Wave 5:** 17 kinds.
  - The funnel reminder with §9 (F6).
  - 16 staff alerts on the pool (R2), money alerts first.
  - It deletes `send()` and `sendWithResult`, and the T7 allowlist ends empty.

## Self-review

- **Spec coverage.** Every wave-1 row of the spec's test table has a task:
  - the sweep: T7 to T12;
  - the four resolution cases plus the reclaim: T3;
  - replace by user id: T1;
  - the duplicate and concurrent once-key: T1 and T2;
  - the void cancel and the hook with no bridge: T6;
  - the generalised deletion: T5;
  - e2e: T14;
  - smoke: T13;
  - F8: T9;
  - F3: T4 and T5;
  - a deleted account: T3 and T4;
  - FU2 kept green: T5.

  Each of the 11 mutation rows that applies to wave 1 is a step:
  - the once-key: P2 in T1;
  - `on conflict`: T2;
  - the user-id replace: T1;
  - the deleted case and key-clean: T3;
  - the void cancel: T6;
  - in-transaction enqueue: T8, T9, T11 and T12;
  - the lease release: T9 (P11);
  - the scan: T7.

  R2 and the funnel claim are wave 5.
- **Types.**
  - `enqueueEmailOnce`, `cancelQueuedEmails`, `recipientLocale`, `resolveRecipient`, `isKeyClean`,
    `anonymiseAccountEmails` and `queueRefundReceipt` keep one signature everywhere they appear.
  - `ClaimedRow` gains exactly `recipientUserId`, `lastError` and `reclaimed`.
- **Proportion.** Only the SQL (T1) and the copy (T8, T9) are given verbatim. Everything else is a signature, a test
  name and its assertions.
