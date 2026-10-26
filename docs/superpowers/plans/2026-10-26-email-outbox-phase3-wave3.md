# Email outbox phase 3, wave 3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the eight account and invite emails onto the outbox: email verification, the funnel claim link, the
email-change confirmation and notice, the account-deletion notice, the org invite, the player claim invite and the
officiating invite. Reword the notices that read their send outcome so they stay true while the outbox retries.

**Architecture:** One migration widens the kind CHECK from 17 to 25 kinds. Each kind swaps its `send*` for a render
builder plus an enqueue in the same commit (the cutover rule). Every wave-3 kind is literal (L) and request-dispatched
(R). The enqueue joins the transaction that writes the fact the email carries: the verification token, the funnel
draft, the email-change request, the account anonymisation, the org invite, the person claim. Three small pieces of
shared machinery ride along: a cancel reason for superseded email-change confirmations, a third arm of the
account-deletion sweep for the account's own literal mail, and a worker step that scrubs the deletion notice's address
once its row ends.

**Tech Stack:** Next (repo fork, see `AGENTS.md`), TypeScript, postgres.js (`sql.begin`, `withTenant`), Postgres 17
with Flyway deltas, vitest (node environment), Playwright on CI only.

**Spec:** `docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md` (owner-approved 2026-10-25), the wave-3
rows of its kind table (inventory #1, #2, #3, #4, #11, #12, #13, #14), §5 (email change), §6 (account deletion), §11
(D3), §12, and the wave-3 row of its test table. Executors also read:
- the wave-1 plan, `docs/superpowers/plans/2026-10-25-email-outbox-phase3-wave1.md`, for Global Constraints (lines
  25–102) and the Task 5–8 shapes;
- the wave-2 plan, `docs/superpowers/plans/2026-10-26-email-outbox-phase3-wave2.md`, for the rulings it carried and
  `onceKey`;
- `docs/superpowers/plans/email-outbox-HANDOFF.md` and `docs/superpowers/specs/2026-10-26-email-service-phase4-note.md`.

**Kind count reconciled.** The spec's kind table gives wave 3 exactly 8 rows: `email_verification`, `funnel_claim`,
`email_change_confirmation`, `email_change_notice`, `account_deletion`, `org_invite`, `claim_invite`,
`official_invite`. That matches the wave-1 plan's "Next waves" list and the spec's count line ("wave 3 has 8"). No
difference.

## Owner rulings (2026-10-26) — every Owner question below is decided

The owner applied every recommendation in this plan's Owner questions: Q1 yes (also reword `claim.invite.sendFailed`, 4 locales); Q2 screenshots from a ONE-OFF local server with no Resend key, used only for the 3 widths and torn down after; Q3 yes (sign-in link in the account's language, T2e). Later the same day the owner added: check every wave-2 finding for product and customer value and build the ones that have it in this wave → Task 4d (three fixes), triage table below.

## Global Constraints

Everything in the wave-1 plan's Global Constraints applies, with the path, branch and label replaced as below. The
owner rules of 2026-10-26 (brief and HANDOFF) override anything heavier in the wave-1 and wave-2 plans.

- **Worktree.** `/Users/ashokhein/github/seazn.club/.claude/worktrees/outbox-p3-w3`, branch
  `feat/email-outbox-phase3-w3`, cut from `origin/main` after wave 2 merges (T0). Prefix every command with
  `cd <that path> &&` or `cd <that path>/apps/web &&`. Never check anything out in the main checkout. Never use
  `git stash` in a worktree.
- **Migration number.** After wave 2 the expected max is `V473` — re-pin at T0. This wave takes main's max + 1 at the
  time it is committed, written below as `V<N>`. W2d (another programme) also allocates numbers. Re-pin right before
  committing T1 and again right before opening the PR:
  `git fetch origin && git ls-tree --name-only origin/main db/migration/deltas/ | sort -V | tail -1`. If taken,
  `git mv` and amend while the branch is unmerged.
- **Running counts (after wave 2 — re-pin each at T0, never treat as fact):** `OUTBOX_KINDS` 17; sweep closes at
  `checked === 17`; `a-kind-body` `kindsChecked === 8`; `SENDER_ALLOWLIST` 34. **After this wave:** 25, 25, 8
  (every wave-3 kind is literal, so the body guard is unchanged), 26.
- **R1–R6, D1, D2, D4, D5** as in the spec. The ones that bite here:
  - **R1.** The row is written on the transaction that commits the fact it carries.
  - **R3.** Inside `withTenant`, the row's `org_id` is the tenant's org. Account and funnel mail have no org and go
    on a `sql.begin` on the privileged pool.
  - **R4.** Never catch an enqueue error inside a transaction and carry on.
  - **R5.** `dispatchNow` only after commit.
  - **D1.** A refused enqueue fails the action.
  - **D4.** Explicit pick, then the linked account's locale (through an existing link only), then the org default,
    then `en`.
  - **D5.** Deleting an account ends and scrubs only the account's own rows.
- **No pooled `sql` call inside `withTenant`** (#996). Every read a render needs inside a tenant transaction goes
  through `tx`.
- **The cutover rule.** A kind's `send*` is deleted in the same commit that adds its enqueue.
- **Each kind keeps its sender's `transactional` flag.** Seven are `true`. `org_invite` is `false`
  (`sendInviteEmail` passes none, `lib/email.ts:491-499`).
- **First attempt.** Every wave-3 kind is R:
  - awaited `dispatchNow` when the response reports the outcome (`email_sent`) or the person waits for a link:
    org, claim and official invites, the funnel claim, email change;
  - `deferred(() => dispatchNow([id]))` otherwise: verification (a staff action), account deletion;
  - inline `await dispatchNow([id])` on the registration claim-invite path, which already runs detached after its
    request's commit (`registrations.ts:1592-1596`).
- **Expiry.** `expiresAt: expiryWithin(<the link's own deadline>)` where the kind has one (spec §12). Every wave-3
  deadline is at least 24 h out (verification `TTL_HOURS = 24`, `lib/verification.ts:5`; email change 24 h; funnel
  `DRAFT_TTL_DAYS = 7`; `EMAIL_INVITE_TTL_DAYS = 7`; `CLAIM_DAYS = 14`), so each resolves to the bound. Pass the
  deadline anyway; no test pins which side wins.
- **Mainstream only (owner, 2026-10-26).** No key-fault, KEK-unset, provider-outage or narrow-race tests. A transport
  503 is used ONLY where the state it stages is the one the product copy or the spec rule is about (the reworded
  notice's "retrying" state, and the queued confirmation an email change must end). Rare cases go in one line under
  "Rare cases — recorded, not built".
- **No tooling.** Reuse `_kind-harness.ts`, `_kind-senders.ts`, `_registration-fixtures.ts`, `_invite-mail.ts`
  (`stubOutboxEnv`) and wave 2's `_money-fixtures.ts`. No new fixture framework, probe rig or scanner change.
- **Copy.** Every changed user-facing string goes into all four `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`,
  then `cd <worktree> && pnpm i18n:gen-keys && pnpm i18n:check` (a value-only change gives gen-keys no diff). Log lines
  stay English.
- **Test rules.** `docs/superpowers/TEST-STRATEGY.md` and `docs/superpowers/RULES.md` (four test types), proportionate:
  one test per behaviour; the sequence (a second call, an empty input); "another sport" is N/A except `funnel_claim`,
  whose body names the sport (spec, Test strategy 4) and runs two. Anti-vacuity on every sweep. Expected values from
  the spec, the dictionaries (read from the JSON file), or the database's own columns — never from the code under
  test. Mutate each guard once, with a named killer.
- **ENV.** `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`; `$S up --label outbox-p3-w3`, then
  `eval "$($S env --label outbox-p3-w3)"`. After a migration edit, `$S down --label outbox-p3-w3 && $S up --label outbox-p3-w3`.
  Never a bare `pnpm db:apply`. Confirm `show data_directory` is this label's.
- **VERIFY `<files>` → `tN`** means exactly:
  ```
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/outbox-p3-w3/apps/web && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label outbox-p3-w3)" && npx vitest run <files> --reporter=json --outputFile=$OUT/tN.json; echo EXIT=$?
  jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests, files: [.testResults[].name]}' $OUT/tN.json
  ```
  Green means `EXIT=0`, `failed == 0`, the stated `total`, and every file listed under this worktree's path. `$OUT`
  is the executor's own scratchpad subdirectory. Never trust an `rtk` summary.
- **TSC** = `cd <worktree>/apps/web && rtk proxy npx tsc --noEmit -p tsconfig.json; echo EXIT=$?`.
- **LINT `<files>`** = `cd <worktree>/apps/web && rtk proxy npx eslint <files>; echo EXIT=$?`. Read `✖ N problems`.
- **MUTATE** is the wave-1 recipe: `cp` backup, edit, VERIFY (the named test fails, `total` unchanged), `cp` restore,
  VERIFY green. Never `git checkout`/`git stash`/`git restore` a file. Env down/up around a SQL mutation.
- **Never locally:** the full vitest suite, the full e2e suite, `$S gate`, or a local web server. Smoke runs on the
  PR's CI smoke job. e2e runs only by CI dispatch, done by the controller:
  `gh workflow run e2e.yml --ref feat/email-outbox-phase3-w3 -f pr=<n>`.
- **No evidence PNGs in the repo.** Screenshots go on an Artifact page (see Q2 for how they are taken).
- **Kill only your own PIDs.**
- **Batching (owner, 2026-10-26).** T2 and T4 are batches of same-shape kinds: one implementer dispatch and one
  review per batch, ONE COMMIT PER KIND. Implementers and reviewers per `docs/superpowers/RULES.md` and
  `.claude/agents/*.md`; this plan names no model.
- **openapi.** No route's contract changes (`email_sent` keeps its shape). If one does, `pnpm openapi:gen` and commit.
- **Commit trailer.** Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XN3eUkHiV1TZpUy2phgxYv
  ```

**Rulings carried (binding here):**
- **R-T1f / `onceKey`.** The once-key index is global across orgs, so every key embeds a UUID; build it with wave 2's
  `onceKey(kind, refType, id, suffix?)`, which refuses a missing id.
- **R-T1e.** A cancel frees the once-key; a producer reads its fact's state before a re-enqueue.
- **`claimQueuedRow`.** Tests that stage a claim use `email-outbox/attempt.ts`'s export, never a hand copy.
- **Account vs literal.** `enqueueEmail` refuses `recipientUserId` on a literal kind (`OutboxKindMismatchError`). Every
  wave-3 kind is literal: no producer passes a user id, and the sweep harness checks `recipient_user_id is null`.
- **C1.** No new `E2E_PROD_TARGET` skip. **C2.** The no-second-path scan reads production sources only.
- **G-5.** The PR checklist carries "readiness log clean".
- **Phase-4 note.** No send path bypasses the outbox. Every wave-3 body renders at enqueue; every wave-3 `KIND_HOOKS`
  entry is `{}`. The one new core step (T3's scrub) is SQL only and imports no renderer.
- **Changed-while-queued (owner, 2026-10-26).** Each kind's row in "The eight kinds" names the body facts that can
  change while it waits and what refreshes them, or says none can. Code or a test only where the change is common;
  the rest is "rare — recorded".
- **Executors re-pin by symbol.** Every line number below is as of `67eb05aedd` (wave 1 merged, wave 2 not). Wave 2
  edits `lib/email.ts`, `_kind-senders.ts`, the sweep and the scan, so re-pin with `grep -an <symbol>` before editing.

## Plan decisions where the tree contradicts or underdetermines the spec

Each one is a finding to record in the wave's report. A controller who disagrees rules before its task runs.

| # | Spec says | The tree says | Plan does |
|---|---|---|---|
| P-W3-1 | `email_verification`: "Account access", R. | The only producer is the staff action `POST /api/admin/users/[id]/resend-verification` (`route.ts:17-33`; its comment `:26-28`: "This staff action is the only thing that emails a verify link now"). It passes no locale (`:30`), so the mail is English. | Move it as specified, `deferred` dispatch (a staff action; nobody reads the outcome). Locale through the account itself (`userId: user.id`, D4). `/admin` UI is unchanged, so no visual check. |
| P-W3-2 | Test row: "a second request replaces the first (verification, funnel, org invite)". | Only verification restates one document: each press deletes the old token and mints a new one for the same user (`:23-24`). Each funnel start inserts a new draft with its own token (`lib/funnel.ts:38-49`), and each email invite inserts a new single-use invite (`invites.ts:24-50`). Both earlier links still work. | Ref = the document (§5's ref rule): `user / <user id>`, `funnel_draft / <draft id>`, `org_invite / <invite id>`. Verification's second press supersedes. Funnel and org invite get a test that two requests give two rows and neither is replaced. |
| P-W3-3 | `email_change_notice` once-key: the request id. | The request is user-pressed; nothing replays it. Each request's id is new, so the key never collides. | Keep it as a belt (`onceKey(kind, "user", requestId)`), as wave 2 kept the invoice's. Ref `user / <user id>`: a newer request's notice to the same old address supersedes a still-queued older one through the replace trigger. |
| P-W3-4 | §5: the request's transaction ends the user's queued confirmations "using the cancel primitive in §7". | `cancelQueuedEmails` refuses a reason not in `CANCELLED_REASONS` (`cancel.ts:63-66`). On the pooled handle it matches only rows with no org (`cancel.ts:47-50`), which is exactly these rows. The route today runs on the bare pool (`change-email/route.ts:29-38`). | Add `EMAIL_CHANGE_SUPERSEDED_REASON = "email_change_superseded"` to `CANCELLED_REASONS` (T1). The route runs delete, insert, cancel and both enqueues in one `sql.begin`. |
| P-W3-5 | Test row: "the wave's account kinds fall inside wave 1's deletion sweep". | The sweep's arms are `recipient_user_id = <user>` and the legacy chess-invite address arm (`account-deletion.ts:96-101`). Every wave-3 kind is literal and carries no user id. So a queued verification or email-change mail would NOT be reached. | A third arm, `accountMail(tx, userId)`: `kind = any(ACCOUNT_MAIL_KINDS) and ref_type = 'user' and ref_id = <user>`, where `ACCOUNT_MAIL_KINDS = ["email_verification", "email_change_confirmation", "email_change_notice"]` (T3). It is ended and scrubbed like the other arms. It is served by `email_outbox_replace_idx` on `(kind, ref_type, ref_id)`, which an explicit kind list lets the planner use. Org invites, claim invites and other records' rows to the same address stay (D5). |
| P-W3-6 | §6: the deletion notice's address "is scrubbed to the placeholder when the row ends"; how is left to the builder. | A row ends on five paths: `attemptClaimed` (sent, dead, suppressed, expired), the worker's expiry step and its dead step, and a cancel. | One worker step, `scrubEndedRecipients`, runs before the retention purge (`worker.ts` step 7, `:326-333`), inside the same budget and the same logged try/catch. It sets `recipient = 'deleted-' \|\| ref_id \|\| '@deleted.invalid'` on rows of `SCRUBBED_WHEN_ENDED = ["account_deletion"]` that are no longer `queued` or `sending`. One step covers all five paths. The address lives at most one tick after the row ends. |
| P-W3-7 | `account_deletion`: queued "after the T5 sweep". | With P-W3-5's explicit kind list, the sweep does not match `account_deletion`, so the order has no observable effect. | Enqueue after `anonymiseAccountEmails` in the same transaction, for reading order. There is no guard to mutate; it is recorded. Once-key `onceKey("account_deletion", "user", user.id)` (spec): a belt, because a deleted account cannot request deletion again (`requireUser`). |
| P-W3-8 | F9: the claim invite "is fired from seven" places, and "all seven need wave 3's in-transaction enqueue". | Re-pinned, the seven calls are `registration-submit.ts:964` and `:1484`, `registration-approval.ts:158`, and `registrations.ts:3235`, `:6202`, `:6260`, `:6302`. Every one is `void inviteUnclaimedMembers(...)` after its own commit, by design (`registrations.ts:1592-1596`). Each converges on `maybeInviteClaim` (`:1549`), which mints the claim in its own transaction (`createSystemClaimInvite` → `db.begin`, `person-claims.ts:212-214`). The fact the email carries is the claim, not the registration. | One enqueue, in `maybeInviteClaim`: `sql.begin(tx => createSystemClaimInvite(tx, …) then enqueue on tx)`. All seven sites get it unchanged. A refusal rolls the claim back with its row and is logged (the function never throws, as today), so the next convergence re-invites. Tests drive two different entry points (submit and approval). T0 reads all seven and records that each still calls `inviteUnclaimedMembers` after its commit. |
| P-W3-9 | `claim_invite` / `official_invite`: R1. | The organiser's claim is minted inside `createClaimInvite`'s `withTenant` (`person-claims.ts:151-171`), and the routes mail after it returns (`claim-invites/route.ts:35`, `officials/[id]/invite/route.ts:27`). `inviteOfficial` reaches the same function (`officials.ts:236`). | `createClaimInvite` gains an optional `mail` descriptor and enqueues on its own `tx` (R3: `org_id = auth.orgId`). Both production callers pass it; tests that mint claims for other reasons do not. The routes compute `email_sent` from `dispatchNow`. One helper, `queueClaimInviteEmail`, serves all three paths. |
| P-W3-10 | Spec mutation row: "in-transaction enqueue, per kind → move it after commit → the rollback test finds an orphan row". | A fact transaction that rolls back after its enqueue is a rare case by the owner's 2026-10-26 rule, and no wave-3 kind moves money. | Not built. Each enqueue's placement inside the fact's transaction is a review item (Review Focus 6). Recorded under Rare cases. |
| P-W3-11 | D3 rewords two wave-3 notices: `officials.inviteEmailFailed`, `settings.team.inviteEmail.notSent`. | A third notice reads the claim invite's `email_sent` the same way: `claim.invite.sendFailed` ("The email couldn't be sent…", `en/ui.json:508`, rendered at `components/v2/invite-claim.tsx:176`). | Q1. T4c rewords it only if approved. |
| P-W3-12 | (test fallout) | `lib/__tests__/email-send-result.test.ts:464-509` uses `sendVerificationEmail` as the representative `send()` sender. Two e2e tests match the old officials copy by regex: `officials-directory.spec.ts:71` and `walkthrough/directory-officials-roles.spec.ts:271`. | Repoint the unit test to `sendFunnelReminderEmail` (transactional; it lives until wave 5 deletes `send()`). The two e2e tests read the dictionary value (T6). |
| P-W3-13 | (visual check) | The brief asks for screenshots at 1280, 768 and 320, and forbids a local web server. The notices appear only when `email_sent` is false, which stg (it has a Resend key) never shows. | Q2. |
| P-W3-14 | D4 for account mail. | Wave 1's T7 note says the `magic_link` locale "is wave 3's"; the sign-in route still renders `en` (`magic-link/route.ts:84`). | Q3. A one-line change if approved (T2e). |
| P-W3-15 | D4 for the funnel. | The funnel start carries no locale (`funnel/start/route.ts:12-15`, a strict schema), there is no account yet, and there is no org. | D4 gives `en`, as today. Recorded as a routed finding, not built. |

**Stale citations (re-verified at `67eb05aedd`).** The spec's `email.ts` lines are current (`:288`, `:316`, `:326`,
`:349`, `:461`, `:470`, `:479`, `:491`). The F9 call sites moved: spec `registrations.ts:1462`, `:3036`, `:5910`,
`:5967`, `:6008` are now `:1612`, `:3235`, `:6202`, `:6260`, `:6302`. The spec's `ui.json` lines moved:
`officials.inviteEmailFailed` is `en/ui.json:3408` (es/nl `:3363`), `settings.team.inviteEmail.notSent` is `:3467`
(es/nl `:3422`). Wave 2 moves all of these again; re-pin by symbol.

## Review Focus

The conditions the spec implies but no spec test exercises, most likely to hurt a person first. Each line's test lives
in its owning task.

1. **The deleted person's address does not outlive the account in the deletion notice's row.** Once that row ends,
   its `recipient` equals the deleted user's `users.email` (the placeholder), read from the database. A still-queued
   notice keeps its address, so it can still be sent. (T3b tests 2–3.)
2. **A second email-change request to another address ends the first address's still-queued confirmation.** That
   mail would arrive later at an address the person abandoned, carrying a token that no longer exists. (T2c test 2.)
3. **The claim and official invite emails carry the EMAIL secret, and the organiser's response never does** (a
   secret's value). This is the existing `email-secret.test.ts`, repointed from sender mocks to the queued rows'
   bodies. (T4b test 1, T4c test 1.)
4. **Deleting an account ends and scrubs its own verification and email-change mail, and leaves an org's invite to
   the same address untouched** (D5). (T3a.)
5. **A consented team member gets exactly one claim invite through the real submit and approval paths, and a second
   convergence queues none** (F9, R6). (T4b tests 3–4.)
6. **Review item, no test (P-W3-10).** Every enqueue sits inside the transaction that writes its fact, and every
   `dispatchNow` sits after that transaction returns. The reviewer reads each producer and says so in writing.

## The eight kinds

All are literal (`recipient_user_id` null). `transactional` is `true` except `org_invite`. Producers import from
`@/server/email-outbox` (the index), so tests' enqueue spies can see them.

| Kind (spec order) | Sender deleted (email.ts) | Builder added | Producer (re-pinned) | First | `ref_type / ref_id` | Once-key | Org | Locale (`recipientLocale`) | Changed while queued |
|---|---|---|---|---|---|---|---|---|---|
| `email_verification` | `sendVerificationEmail` :288 | `verificationEmail(link, locale)` | `api/admin/users/[id]/resend-verification/route.ts:17-33` | R, deferred | `user / <user id>` | — | null | pick null, `userId: user.id` | The token: a second staff press deletes it and re-enqueues, so the newer row supersedes (built, T2a test 2). The account's address changing while the row waits: rare — recorded. |
| `funnel_claim` | `sendFunnelClaimEmail` :316 | `funnelClaimEmail(args, locale)` | `api/funnel/start/route.ts:24-43` + `lib/funnel.ts:38` | R, awaited | `funnel_draft / <draft id>` | — | null | none → `en` (P-W3-15) | None can change: a draft has no edit path, and claiming it needs the link this mail carries. |
| `email_change_confirmation` | `sendEmailChangeConfirmation` :461 | `emailChangeConfirmationEmail(link, locale)` | `api/auth/change-email/route.ts:11-41` | R, awaited | `user / <user id>` | — | null | pick `user.locale`, `userId: user.id` | The token and address: a new request ends the older queued row, `email_change_superseded` (built, T2c test 2). Confirmation needs this link, so it cannot happen first. |
| `email_change_notice` | `sendEmailChangeNotice` :470 | `emailChangeNoticeEmail(newEmail, locale)` | same route | R, awaited | `user / <user id>` | `<request id>` (P-W3-3) | null | as above | The new address: a newer request's notice to the same old address supersedes it through the trigger (asserted in T2c test 2). |
| `account_deletion` | `sendAccountDeletionEmail` :479 | `accountDeletionEmail(locale)` | `api/users/me/route.ts` DELETE, `sql.begin` `:167-195` | R, deferred | `user / <user id>` | `<user id>` (P-W3-7) | null | pick `user.locale` (read before the anonymisation) | None: the account is gone. The address is scrubbed when the row ends (P-W3-6). |
| `org_invite` | `sendInviteEmail` :491 | `orgInviteEmail(args, locale)` | `api/orgs/[id]/invites/route.ts:31-53` + `invites.ts:24` | R, awaited → `email_sent` | `org_invite / <invite id>` | — | the org | org `default_locale` (no link; never looked up by address) | Revoking the invite, or renaming the org, while the row waits in retry: rare — recorded. A second invite is its own document (P-W3-2). |
| `claim_invite` | `sendClaimInviteEmail` :326 | `claimInviteEmail(args, locale)` | `api/v1/persons/[id]/claim-invites/route.ts:21-42` → `person-claims.ts:144`; `registrations.ts` `maybeInviteClaim` `:1549` (7 sites, P-W3-8) | R, awaited → `email_sent`; inline on the registration path | `person / <person id>` | — | the claim's org | org default (`persons.user_id` is null by precondition) | A re-invite to the same address supersedes it (trigger; built, T4b test 2). A re-invite to another address, or a revoke, while it waits in retry: rare — recorded. |
| `official_invite` | `sendOfficialInviteEmail` :349 | `officialInviteEmail(args, locale)` | `api/v1/officials/[id]/invite/route.ts:20-36` → `officials.ts:198` → `createClaimInvite` | R, awaited → `email_sent` | `official / <official id>` | — | `auth.orgId` | org default | As `claim_invite`. |

**Builder convention (wave 1 Task 8).** `<name>Email(args, locale: Locale): Promise<EmailContent>`, where
`EmailContent` is `lib/email.ts:298`. Each builder is `getDictionary(locale, "emails")` plus the existing template the
deleted sender used (`verificationTemplate`, `funnelClaimTemplate`, `emailChangeConfirmTemplate`,
`emailChangeNoticeTemplate`, `accountDeletionTemplate`, `inviteTemplate`, `claimInviteTemplate`,
`officialInviteTemplate`), byte for byte. `orgInviteEmail`'s args are `{ orgName: string; link: string }`.

**Subject keys** (for the sweep and the tests; read with `dictionarySubject`): `verification.subject`,
`funnelClaim.subject` `{competitionName}`, `emailChangeConfirm.subject`, `emailChangeNotice.subject`,
`accountDeletion.subject`, `invite.subject` `{orgName}`, `claimInvite.subject` `{orgName}`,
`officialInvite.subject` `{orgName}`.

**Interfaces consumed from waves 1 and 2** (merged before T0; re-pin each at T0):
- `enqueueEmail`, `enqueueEmailOnce`, `expiryWithin`, `dispatchNow`, `cancelQueuedEmails`, `CANCELLED_REASONS` and
  `recipientLocale(db, { pick, userId, orgDefault })`, from `@/server/email-outbox`; `onceKey` (wave 2 T1).
- `anonymiseAccountEmails`, `namesAccount`, `legacyInviteAt` and `deletedAccountPlaceholder`
  (`email-outbox/account-deletion.ts`).
- `purgeOldEmails` and `PurgeOptions` (`email-outbox/status.ts:180-209`); `runOutboxTick` step 7 (`worker.ts:326-333`).
- `forEachOutboxKind`, `KindScenario`, `bornAgo` and `dictionarySubject` (`__tests__/_kind-harness.ts`).
- `SENDER_ALLOWLIST`, `NOT_YET_MOVED`, `KIND_DIRECT_SENDER` and the allowlist-length rule (`__tests__/_kind-senders.ts`,
  as wave 2 left them).
- `checkOutboxRow` (`scripts/smoke.ts:9007`).
- `stubOutboxEnv` (`server/usecases/__tests__/_invite-mail.ts`); `_registration-fixtures.ts`.

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `db/migration/deltas/V<N>__email_outbox_phase3_wave3.sql` (create) | kind CHECK, 25 kinds | T1 |
| `apps/web/src/server/email-outbox/constants.ts` | `OUTBOX_KINDS` 25, `OUTBOX_KIND_FACTS` 25, `ACCOUNT_MAIL_KINDS`, `SCRUBBED_WHEN_ENDED` | T1, T3 |
| `apps/web/src/server/email-outbox/hooks.ts` | eight `{}` | T1 |
| `apps/web/src/server/email-outbox/cancel.ts`, `index.ts` | `EMAIL_CHANGE_SUPERSEDED_REASON` | T1 |
| `apps/web/src/server/email-outbox/account-deletion.ts` | the account-mail arm | T3a |
| `apps/web/src/server/email-outbox/status.ts`, `worker.ts` | `scrubEndedRecipients`, the tick step | T3b |
| `apps/web/src/lib/email.ts` | eight senders become eight builders | T2–T4 |
| `apps/web/src/lib/verification.ts`, `lib/funnel.ts`, `server/usecases/invites.ts` | an optional `db` handle on the fact writers | T2, T4 |
| `apps/web/src/app/api/admin/users/[id]/resend-verification/route.ts` | verification | T2a |
| `apps/web/src/app/api/funnel/start/route.ts` | funnel claim | T2b |
| `apps/web/src/app/api/auth/change-email/route.ts` | confirmation, notice | T2c, T2d |
| `apps/web/src/app/api/users/me/route.ts` | deletion notice | T3b |
| `apps/web/src/app/api/orgs/[id]/invites/route.ts` | org invite | T4a |
| `apps/web/src/server/usecases/claim-invite-mail.ts` (create) | `queueClaimInviteEmail` | T4b |
| `apps/web/src/server/usecases/person-claims.ts`, `registrations.ts`, `officials.ts`; the two v1 invite routes | claim and official invites | T4b, T4c |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` | three (or two) reworded notices | T4a, T4b (Q1), T4c |
| `apps/web/src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts`, `_kind-senders.ts`, `outbox-schema.test.ts`, `no-second-path.test.ts` | lists, scenarios, allowlist | T1–T4 |
| new and repointed suites (named per task) | per-kind tests | T2–T4 |
| `scripts/smoke.ts` | funnel and org-invite rows | T5 |
| `apps/web/e2e/funnel.spec.ts`, `officials-directory.spec.ts`, `player-accounts.spec.ts`, `walkthrough/settings-people-tabs.spec.ts`, `walkthrough/settings-admin.spec.ts`, `walkthrough/directory-officials-roles.spec.ts` (+ `walkthrough/directory-player-identity.spec.ts` if Q1) | row and copy assertions | T6 |

---

### Task 0: Preconditions and environment (no commit)

**Files:** none modified.

- [ ] **Step 1: Wave 2 has merged.** `cd /Users/ashokhein/github/seazn.club && git fetch origin && git log --oneline origin/main | grep -ai "outbox" | head -5`.
  Expected: wave 2's merge above #1035. If absent, STOP and report.
- [ ] **Step 2: Worktree.** `git -C /Users/ashokhein/github/seazn.club worktree add .claude/worktrees/outbox-p3-w3 -b feat/email-outbox-phase3-w3 origin/main`,
  then `pnpm install --frozen-lockfile` inside it. Link `.env.local` per the seazn-local-env skill.
- [ ] **Step 3: Pin `V<N>`** (Global Constraints). Record it.
- [ ] **Step 4: Re-pin the running counts and wave 2's names.** Record the merged values of: `OUTBOX_KINDS.length`
  (expected 17), the sweep's closing `checked` (17), `a-kind-body`'s `kindsChecked` (8), `SENDER_ALLOWLIST.length`
  (34), the allowlist-length rule's form in `_kind-senders.ts`, and `onceKey`'s export. A different merged value wins;
  record the difference and carry it through every "expected" below.
- [ ] **Step 5: Re-pin every producer and test citation in this plan by symbol.** Read each of the seven F9 call sites
  (P-W3-8) and record file:line and that each is `void inviteUnclaimedMembers(...)` after its commit.
- [ ] **Step 6: Pre-scan the mocks.** `grep -arln 'vi.mock("@/lib/email"' apps/web/src`. For each factory that does
  NOT spread `importOriginal`, record whether it drives a wave-3 producer. Known: `account-deletion-lichess.test.ts:28`
  and `lib/__tests__/account-deletion-billing.test.ts:36` (both mock only `sendAccountDeletionEmail`; they drive the
  DELETE route). The task that deletes a sender such a file reaches adds `...(await importOriginal())`.
  Also record which wave-3 producer tests set `RESEND_API_KEY` without `stubOutboxEnv()`: with a Resend key and no
  KEK, `sealBody` refuses (`seal.ts:31-36`), so such a test must call `stubOutboxEnv()`.
- [ ] **Step 7: Env.** `$S up --label outbox-p3-w3`. Confirm `show data_directory` is this label's.

### Task 1: Vocabulary, schema and the email-change cancel reason

**Files:**
- Create `db/migration/deltas/V<N>__email_outbox_phase3_wave3.sql`. It has one statement, in V472's shape:
  `alter table email_outbox drop constraint email_outbox_kind_valid, add constraint email_outbox_kind_valid check (kind in (<25>))`.
- Modify:
  - `email-outbox/constants.ts`: `OUTBOX_KINDS` appends the eight in spec order (verification, funnel claim,
    confirmation, notice, deletion, org invite, claim invite, official invite); `OUTBOX_KIND_FACTS` adds eight
    `{ to: "literal", transactional }` entries, `false` only for `org_invite`;
  - `hooks.ts`: eight `{}`;
  - `cancel.ts` and `index.ts`: `EMAIL_CHANGE_SUPERSEDED_REASON = "email_change_superseded"`, appended to
    `CANCELLED_REASONS` and exported.
- Test: `outbox-schema.test.ts` (the kinds literal), `outbox-kind-sweep.test.ts` (`SPEC_KINDS`, `SPEC_FACTS`, legend),
  `_kind-senders.ts` (`NOT_YET_MOVED`, `KIND_DIRECT_SENDER`), `hooks.test.ts` only if it enumerates kinds, and the
  existing cancel suite (`grep -arln cancelQueuedEmails apps/web/src/server/email-outbox/__tests__`).

- [ ] **Step 1: Write the failing tests.**
  - `outbox-schema.test.ts`: the typed list is the 17 plus the eight in spec order; retitle to
    `the kinds are the spec's twenty-five, in the spec's wave order`. Extend the live-CHECK read the same way.
  - `outbox-kind-sweep.test.ts`: `SPEC_KINDS` 25; `SPEC_FACTS` gains the eight, typed from the spec legend
    (`["literal", true]` ×7, `org_invite: ["literal", false]`). Retitle the legend test to
    `the legend has SEVENTEEN literal kinds, EIGHT account kinds and no staff kind`; it asserts
    - `by("literal")` is wave 2's nine followed by the eight wave-3 kinds in spec order;
    - `by("account")` is unchanged;
    - the transactional kinds are `["magic_link", "chess_invite", "trial_ending", "email_verification", "funnel_claim", "email_change_confirmation", "email_change_notice", "account_deletion", "claim_invite", "official_invite"]`.
  - `_kind-senders.ts`: `NOT_YET_MOVED` is the eight; `KIND_DIRECT_SENDER` maps each to its sender name from the
    kind table. The lists-agree test stays green, because no sender has moved yet.
  - Cancel suite: one case, `an email-change confirmation can be cancelled with its own reason, and the row reads as
    voided`. On a `sql.begin` handle, enqueue one `email_change_confirmation` (org null), call
    `cancelQueuedEmails(tx, { kind, refType: "user", refIds: [userId], reason: EMAIL_CHANGE_SUPERSEDED_REASON })`:
    1 ended row, `expired`, `last_error = 'email_change_superseded'`, body null. A second call returns `[]`.
- [ ] **Step 2: Run red.** VERIFY the files → `t1`.
- [ ] **Step 3: Implement**, then env down/up.
- [ ] **Step 4: Run green** → `t1b`. Expected `failed: 0`; the sweep still reports `checked: 17`.
- [ ] **Step 5: Mutations.**
  - Omit `official_invite` from the CHECK (env down/up): the schema test fails.
  - Flip `org_invite` to `transactional: true` in facts: the legend test fails.
  - Drop the new reason from `CANCELLED_REASONS`: the cancel case throws.
- [ ] **Step 6: TSC** (catches a missing `KIND_HOOKS` key), **LINT**, commit:
  `feat(email-outbox): wave-3 kinds in the vocabulary, and a cancel reason for a superseded email change`.

### Task 2 (batch A): the account's and the visitor's own mail, on a pool transaction

One implementer dispatch, one review, **four commits** (T2a–T2d; T2e only if Q3 is approved). Same shape for every
kind: the route's fact write and the enqueue share one `sql.begin` on the privileged pool, the row has no org, and
the first attempt is made after commit.

**Shared interfaces:**
- `createVerificationToken(userId: string, db: Tx | typeof sql = sql): Promise<string>` (`lib/verification.ts:8`).
- `createFunnelDraft(email: string, payload: FunnelPayload, db: Tx | typeof sql = sql): Promise<{ id: string; token: string }>`
  (`lib/funnel.ts:38`).
- The four builders (kind table).

**Shared test rules:** they mock only the transport (`email-outbox/transport.ts`) and call `stubOutboxEnv()`. Users
come from `makeUser` (`_registration-fixtures.ts`) with `users.locale` set per case. Expected subjects come from
`dictionarySubject`. Expected tokens are read from the fact's own table (`email_verifications`,
`email_change_requests`, `funnel_drafts`), never from the route's return.

#### T2a `email_verification`

**Files:** `resend-verification/route.ts`, `lib/verification.ts`, `lib/email.ts` (delete `sendVerificationEmail`, add
`verificationEmail`). Tests: `resend-verification/__tests__/route.test.ts` (repoint its sender mock to rows),
`lib/__tests__/scrub-login-token.test.ts` (its `sendVerificationEmail` mock becomes a `verificationEmail` spy that
records the link), `lib/__tests__/email-send-result.test.ts` (P-W3-12: repoint the three cases to
`sendFunnelReminderEmail`), the sweep, the scan.

**Interfaces:** In the route, after the 404/400 guards:
`const id = await sql.begin(async tx => { await tx\`delete from email_verifications where user_id = ${id}\`; const token = await createVerificationToken(id, tx); const link = …; return enqueueEmail(tx, { kind: "email_verification", refType: "user", refId: id, orgId: null, to: user.email, transactional: true, expiresAt: expiryWithin(new Date(Date.now() + 24 * 3600_000)), ...await verificationEmail(link, await recipientLocale(tx, { pick: null, userId: id, orgDefault: null })) }); })`.
Then `logStaffAction(...)` (unchanged, after commit), then `deferred(() => dispatchNow([id]))`.

- [ ] **Step 1: Failing tests** (in `route.test.ts`):
  1. `a staff resend queues one verification in the account's language and sends it`. `users.locale = 'fr'`.
     Expected: one row (kind `email_verification`, ref `user / <id>`, `org_id` null, `recipient_user_id` null,
     `transactional` true); after the deferred dispatch it is `sent` with no body and one transport call keyed
     `email-outbox/<id>`; subject `dictionarySubject("fr", "verification.subject", {})`; the transport call's text
     contains `/verify-email?token=<the one email_verifications token>` (the positive pair).
  2. `a second resend supersedes the first, and only the newest link works`. Two presses: 2 rows, the older
     `replaced`, the newer `sent`; `email_verifications` holds exactly 1 token, and it is the one in the newer body.
  3. `empty: an already-verified account or an unknown id queues nothing` (400 / 404, 0 rows).
- [ ] **Step 2: Sweep and scan.** Scenario `email_verification` (the staff POST with `requireStaff` mocked as the
  existing route test does; `fr`; `verification.subject`; `request`). Remove the kind from `NOT_YET_MOVED`, the sender
  from `SENDER_ALLOWLIST`, and null its `KIND_DIRECT_SENDER` entry. Allowlist 33.
- [ ] **Step 3: Red** → `t2a`. **Step 4: Implement.** **Step 5: Green** → `t2a-b`; the sweep reports `checked: 18`.
- [ ] **Step 6: Mutation.** Move the `delete from email_verifications` out of the `sql.begin` and after it: test 2
  fails (two tokens). Delete `deferred(...)`: test 1 fails (the row stays `queued`).
- [ ] **Step 7: TSC, LINT, commit** `feat(auth): the verification email goes through the outbox, in the account's language`.

#### T2b `funnel_claim`

**Files:** `funnel/start/route.ts`, `lib/funnel.ts`, `lib/email.ts`. Create
`app/api/funnel/start/__tests__/funnel-claim-outbox.test.ts`. Repoint `lib/__tests__/funnel.test.ts` only if it calls
`createFunnelDraft` positionally in a way the new optional arg breaks (it should not). Sweep, scan.

**Interfaces:** `const { id, link } = await sql.begin(async tx => { const draft = await createFunnelDraft(email, payload, tx); const link = …; return { id: await enqueueEmail(tx, { kind: "funnel_claim", refType: "funnel_draft", refId: draft.id, orgId: null, to: email, transactional: true, expiresAt: expiryWithin(<draft expiry>), ...await funnelClaimEmail({ competitionName: payload.name, sport: payload.sport, link }, "en") }), link }; })`,
then `await dispatchNow([id])`. `createFunnelDraft` returns `expiresAt` as well (an extra field, no caller breaks). The
PostHog capture and the `mayExposeDevLink` rule are unchanged.

- [ ] **Step 1: Failing tests** (rate limit mocked as `scrub-login-token.test.ts:25-28` does):
  1. `a start queues one claim email and sends it in the request`. One row: kind `funnel_claim`, ref
     `funnel_draft / <the funnel_drafts row's id>`, `org_id` null, `transactional` true, `sent`, no body; subject
     `dictionarySubject("en", "funnelClaim.subject", { competitionName })`; the transport text contains
     `/start/claim?token=<funnel_drafts.token>`.
  2. `another sport: the claim names the sport the visitor chose`. Two starts, `Badminton` and `Chess`: each
     transport call's text contains its own sport and not the other.
  3. `a second start is a second draft and a second email; neither replaces the other` (P-W3-2): 2 drafts, 2 rows,
     both `sent`.
  4. `empty: an invalid payload queues nothing` (400; no draft for the address, 0 rows).
- [ ] **Step 2: Sweep and scan.** Scenario `funnel_claim` (`en`, `funnelClaim.subject`, `{ competitionName }`,
  `request`). Allowlist 32.
- [ ] **Steps 3–5: Red → implement → green** → `t2b`, `t2b-b`; the sweep reports `checked: 19`.
- [ ] **Step 6: Mutation.** Drop the `await dispatchNow`: test 1 fails (`queued`).
- [ ] **Step 7: TSC, LINT, commit** `feat(funnel): the claim link goes through the outbox`.

#### T2c `email_change_confirmation`

**Files:** `change-email/route.ts`, `lib/email.ts`. Create
`app/api/auth/change-email/__tests__/change-email-outbox.test.ts`. Sweep, scan.

**Interfaces:** after the two guards (same address 400, taken 409), one `sql.begin(tx)`:
1. `delete from email_change_requests where user_id = … and not confirmed` (unchanged);
2. `insert … returning id` (adds `returning id`);
3. `cancelQueuedEmails(tx, { kind: "email_change_confirmation", refType: "user", refIds: [user.id], reason: EMAIL_CHANGE_SUPERSEDED_REASON })`;
4. `enqueueEmail(tx, { kind: "email_change_confirmation", refType: "user", refId: user.id, orgId: null, to: new_email, transactional: true, expiresAt: expiryWithin(expiresAt), ...await emailChangeConfirmationEmail(link, locale) })`,
   with `locale = await recipientLocale(tx, { pick: user.locale, userId: user.id, orgDefault: null })`.

Until T2d lands, the route still calls `sendEmailChangeNotice` after commit. After commit:
`await dispatchNow([confirmId])` (T2d widens it to both ids). The response message is unchanged.

- [ ] **Step 1: Failing tests:**
  1. `a change request queues one confirmation to the new address, in the account's language, and sends it`.
     `users.locale = 'es'`. One row: ref `user / <id>`, recipient `new_email`, `org_id` null, `sent`; subject
     `dictionarySubject("es", "emailChangeConfirm.subject", {})`; the transport text contains
     `change-email/confirm?token=<email_change_requests.token>`.
  2. `a second request to another address ends the first address's queued confirmation` (Review Focus 2). The
     transport answers 503 for the first request only, so its row is `queued` with `attempts = 1` (the state §5's
     rule exists for). The second request to another address: the first row is `expired`, `last_error =
     'email_change_superseded'`, body null; the second row is `sent` to the second address; `email_change_requests`
     holds one row, the second. (After T2d, this test also asserts the first notice is `replaced` and the second
     `sent`.)
  3. `empty: the same address or a taken one queues nothing` (400 / 409, 0 rows).
- [ ] **Step 2: Sweep and scan.** Scenario `email_change_confirmation` (`es`, `emailChangeConfirm.subject`,
  `request`, recipient = the new address). Allowlist 31.
- [ ] **Steps 3–5** → `t2c`, `t2c-b`; the sweep reports `checked: 20`.
- [ ] **Step 6: Mutation.** Remove the `cancelQueuedEmails` call: test 2 fails (the first row stays `queued`).
- [ ] **Step 7: TSC, LINT, commit** `feat(auth): the email-change confirmation goes through the outbox; a new request ends the old one`.

#### T2d `email_change_notice`

**Files:** `change-email/route.ts`, `lib/email.ts`, `change-email-outbox.test.ts`, sweep, scan.

**Interfaces:** inside the same `sql.begin`, after the confirmation:
`enqueueEmailOnce(tx, { kind: "email_change_notice", refType: "user", refId: user.id, dedupeKey: onceKey("email_change_notice", "user", requestId), orgId: null, to: user.email, transactional: true, expiresAt: expiryWithin(null), ...await emailChangeNoticeEmail(new_email, locale) })`.
After commit, `await dispatchNow([confirmId, noticeId])`.

- [ ] **Step 1: Failing tests:**
  1. `the old address gets one notice naming the new one`: one row to `user.email`, `dedupe_key` = the
     `email_change_requests.id`, `sent`; subject `emailChangeNotice.subject` (`es`); the transport text contains
     `new_email` (positive pair).
  2. Extend T2c test 2: the first notice is `replaced` and the second is `sent`. Both went to the same old address.
- [ ] **Step 2: Sweep and scan.** Scenario `email_change_notice` (recipient = the old address). Allowlist 30.
- [ ] **Steps 3–5** → `t2d`, `t2d-b`; the sweep reports `checked: 21`.
- [ ] **Step 6: Mutation.** Enqueue the notice with `to: new_email`: test 1 fails.
- [ ] **Step 7: TSC, LINT, commit** `feat(auth): the email-change notice to the old address goes through the outbox`.

#### T2e (only if Q3 is approved) `magic_link` in the account's language

**Files:** `api/auth/magic-link/route.ts:78-87`; the magic-link route test that pins `en`.
- `magicLinkEmail(email, link, await recipientLocale(tx, { pick: null, userId, orgDefault: null }))`.
- Test `an existing account with locale 'nl' gets a Dutch sign-in link`: the subject is
  `dictionarySubject("nl", "magicLink.subject", {})`. The sweep's `magic_link` scenario stays `en`, because a brand-new
  account has no locale.
- Mutation: pass `"en"`: the test fails. Commit `feat(auth): the sign-in link in the account's language (D4)`.

### Task 3: Account deletion — the account's own mail, the notice, and the scrub

One dispatch, one review, two commits.

#### T3a The deletion sweep's account-mail arm (P-W3-5)

**Files:** `email-outbox/constants.ts` (`ACCOUNT_MAIL_KINDS`), `email-outbox/account-deletion.ts`. Test:
`app/api/users/me/__tests__/account-deletion-sweep.test.ts`.

**Interfaces:**
- `ACCOUNT_MAIL_KINDS: readonly OutboxKind[] = ["email_verification", "email_change_confirmation", "email_change_notice"]`.
- `accountMail(tx, userId)` = `(kind = any(${ACCOUNT_MAIL_KINDS}) and ref_type = 'user' and ref_id = ${userId})`.
- `anonymiseAccountEmails` ends the queued rows and scrubs every row of this arm, as it does the other two. The
  header's "WHICH ROWS ARE THE ACCOUNT'S" gains one bullet: mail ABOUT the account (its verification and email
  change), found by its ref.

- [ ] **Step 1: Failing test.** Add `the account's own verification and email-change mail is ended and scrubbed; an
  org's invite to the same address is not` to `account-deletion-sweep.test.ts`. Seed for user U through
  `enqueueEmail` on a `sql.begin` handle:
  1. a queued `email_verification` (ref `user / U`);
  2. a queued `email_change_confirmation` (ref `user / U`, to another address);
  3. a `sent` `email_change_notice` (ref `user / U`);
  4. a queued `org_invite` to U's address (ref `org_invite / <random uuid>`);
  5. another user's queued `email_verification`.

  Delete U through the real DELETE handler. Expected:
  - rows 1–2 are `expired` / `account_deleted`, body null, and their recipient equals U's `users.email` after the
    deletion (read from the DB);
  - row 3 is still `sent`, with that same placeholder;
  - rows 4–5 are untouched;
  - the test reports `checked: 5`.

  If the file pins each arm's access path with EXPLAIN, add this arm to that same assertion. No new harness.
- [ ] **Step 2: Red** → `t3a`. **Step 3: Implement.** **Step 4: Green** → `t3a-b` (the file's other cases stay green).
- [ ] **Step 5: Mutation.** Drop the arm: rows 1–2 stay `queued`.
- [ ] **Step 6: TSC, LINT, commit** `feat(email-outbox): account deletion also ends the account's own verification and email-change mail (D5)`.

#### T3b `account_deletion`, and the scrub once its row ends (P-W3-6, P-W3-7)

**Files:**
- Modify: `users/me/route.ts`; `lib/email.ts` (delete `sendAccountDeletionEmail`, add `accountDeletionEmail`);
  `email-outbox/constants.ts` (`SCRUBBED_WHEN_ENDED`); `email-outbox/status.ts` (`scrubEndedRecipients`);
  `email-outbox/worker.ts` (step 7a); `index.ts`.
- Create `app/api/users/me/__tests__/account-deletion-notice.test.ts`.
- Repoint every DELETE-route test that mocks `sendAccountDeletionEmail`:
  - `account-deletion-session-revoke.test.ts` (`:266`, `:276` become row counts: one `account_deletion` row, and a
    second DELETE (401) adds none);
  - `account-deletion-outbox.test.ts`, `account-deletion-chess-invite.test.ts`, `account-deletion-sweep.test.ts`,
    `account-deletion-lichess.test.ts`;
  - `lib/__tests__/account-deletion-billing.test.ts`;
  - `app/api/auth/magic-link/__tests__/consume-deleted-account.test.ts`.

  Each drops the mock entry; the two non-spreading factories (T0 Step 6) spread `importOriginal`.
- The sweep and the scan.

**Interfaces:**
- In the route's `sql.begin`, after `anonymiseAccountEmails` and the `update users`:
  `noticeId = await enqueueEmailOnce(tx, { kind: "account_deletion", refType: "user", refId: user.id, dedupeKey: onceKey("account_deletion", "user", user.id), orgId: null, to: user.email, transactional: true, expiresAt: expiryWithin(null), ...await accountDeletionEmail(await recipientLocale(tx, { pick: user.locale, userId: null, orgDefault: null })) })`.
  The transaction returns `{ endedByDeletion, noticeId }`.
  - `userId: null`, because the account is deleted in this transaction, so the account step would skip it.
    `user.locale` was read by `requireUser` before.
  - After commit, `if (noticeId) deferred(() => dispatchNow([noticeId]))`, in place of the old send (`:200`).
  - `destroySession` and `afterEndedBadly` stay where they are.
- `SCRUBBED_WHEN_ENDED: readonly OutboxKind[] = ["account_deletion"]`.
- `scrubEndedRecipients(opts: PurgeOptions = {}): Promise<number>` in `status.ts`, beside `purgeOldEmails` and with
  its shape (bounded CTE, `for update skip locked`, the `onlyIds` / `db` test seams). It runs
  `update email_outbox set recipient = 'deleted-' || ref_id || '@deleted.invalid' where kind = any(${SCRUBBED_WHEN_ENDED}) and ref_type = 'user' and status not in ('queued', 'sending') and recipient <> 'deleted-' || ref_id || '@deleted.invalid'`
  and returns the count. A comment names `deletedAccountPlaceholder` as the same format; the test below binds the two
  through the database, not through the function.
- `runOutboxTick` step 7a: before the purge, under `!overBudget()`, in its own try/catch logged with `errFields`
  ("the recipient scrub failed; the next tick scrubs"). `OutboxTickReport` gains `scrubbed: number`, which counts
  toward the `log.info` condition.

- [ ] **Step 1: Failing tests** (`account-deletion-notice.test.ts`; the real DELETE handler, as
  `account-deletion-sweep.test.ts` drives it):
  1. `deleting an account queues one notice to its address, in its language, and sends it`. `users.locale = 'nl'`.
     Captured before the DELETE: the address. Expected:
     - one `account_deletion` row: ref `user / <id>`, `dedupe_key` `<id>`, `org_id` null, `recipient_user_id` null,
       `transactional` true;
     - after the deferred dispatch it is `sent`, and the transport call went to the captured address;
     - subject `dictionarySubject("nl", "accountDeletion.subject", {})`;
     - the sweep did not end it (`last_error` null).
  2. `once the notice's row ends, it keeps no address` (Review Focus 1; the spec's wave-3 regression). Continue from
     test 1: `runOutboxTick({ onlyIds: [id] })`. Expected: the row's `recipient` equals the deleted user's
     `users.email` (read from `users`); `report.scrubbed === 1`; a second tick reports 0 and changes nothing.
  3. `a notice still waiting to be sent keeps its address`, the negative pair. Seed an `account_deletion` row
     through `enqueueEmail` on a `sql.begin` handle, with `next_attempt_at` an hour out. Tick with its id: the
     recipient is unchanged and `scrubbed` is 0.
  4. `a scrub touches no other kind`: a `sent` `email_verification` row with `ref_type = 'user'` keeps its
     recipient through the tick.
- [ ] **Step 2: Sweep and scan.** Scenario `account_deletion` (the real DELETE, `nl`, `accountDeletion.subject`,
  `request`, recipient = the address captured before the DELETE). The harness finds the rows by recipient right after
  `run()`, before any tick, and judges them by id afterwards (`_kind-harness.ts:193`, `:229`), so the scrub does not
  hide them. Allowlist 29.
- [ ] **Steps 3–5** → `t3b`, `t3b-b`. VERIFY also covers `worker.test.ts` and `worker-purge-wiring.test.ts`, whose
  report shape gains `scrubbed`. The sweep reports `checked: 22`.
- [ ] **Step 6: Mutations.**
  - Remove step 7a from the tick: test 2 fails.
  - Drop `status not in ('queued', 'sending')`: test 3 fails.
  - Drop `kind = any(...)`: test 4 fails.
- [ ] **Step 7: TSC, LINT, commit**
  `feat(account): the deletion notice goes through the outbox, and its address is scrubbed once it has gone`.

### Task 4 (batch B): invites that report `email_sent`, and their notices

One implementer dispatch, one review, **three commits**. Same shape: the invite's fact transaction holds the enqueue
(R3 where it is `withTenant`); the response's `email_sent` becomes `(await dispatchNow([id])).get(id) === "sent"`;
the notice that reads `false` is reworded so it is true whether the outbox is retrying or has given up (D3). The
`frontend-design` skill is loaded for the copy, even though no layout changes.

**Shared test rules:** the transport mock answers 200 unless the case says 503. Orgs come from
`_registration-fixtures.ts` with `organizations.default_locale` set per case. Subjects come from `dictionarySubject`.
"Retrying" cases pull `next_attempt_at` to now and run `runOutboxTick({ onlyIds })`.

#### T4a `org_invite`

**Files:** `orgs/[id]/invites/route.ts`, `server/usecases/invites.ts` (`createInvite(orgId, createdBy, input, db = sql)`),
`lib/email.ts`; the four `ui.json` (`settings.team.inviteEmail.notSent`). Create
`app/api/orgs/[id]/invites/__tests__/org-invite-outbox.test.ts`. Repoint `scrub-login-token.test.ts`'s
`sendInviteEmail` mock to an `orgInviteEmail` spy that records the link. Check `invites.test.ts` still compiles. Sweep,
scan.

**Interfaces:** for an email invite, one `sql.begin(tx)`: `createInvite(id, user.id, input, tx)`; a select of `name,
default_locale` from `organizations` through `tx`; then
`enqueueEmail(tx, { kind: "org_invite", refType: "org_invite", refId: invite.id, orgId: id, to: invite.email, transactional: false, expiresAt: expiryWithin(<invite.expires_at>), ...await orgInviteEmail({ orgName, link }, await recipientLocale(tx, { pick: null, userId: null, orgDefault })) })`.
After commit, `email_sent` comes from `dispatchNow`. A link invite (no email) is unchanged and queues nothing.

**Copy** (match each file's register and punctuation):
- en: `The email didn't go out straight away. It may arrive late, or not at all: copy their personal link below and share it directly.`
- es: `El correo no salió de inmediato. Puede llegar más tarde o no llegar; copie su enlace personal a continuación y compártalo directamente.`
- fr: `L'e-mail n'est pas parti tout de suite. Il peut arriver en retard, ou pas du tout : copiez leur lien personnel ci-dessous et partagez-le directement.`
- nl: `De e-mail is niet meteen verstuurd. Hij kan later aankomen, of helemaal niet: kopieer de persoonlijke link hieronder en deel deze rechtstreeks.`

- [ ] **Step 1: Failing tests:**
  1. `an email invite queues one invite in the org's language and reports email_sent`. Org default `fr`. Expected:
     one row (kind `org_invite`, ref `org_invite / <response id>`, `org_id` the org, `transactional` false), `sent`;
     `email_sent: true`; subject `dictionarySubject("fr", "invite.subject", { orgName })`; the transport text
     contains `/join/<org_invites.token>`.
  2. `email_sent is false while the outbox retries, and the worker sends it later` (the state the reworded notice
     describes). Transport 503 once: `email_sent: false`, the row `queued` with `attempts = 1`; then the tick makes
     it `sent`.
  3. `two email invites to one address are two invites and two emails` (P-W3-2): 2 rows, neither `replaced`.
  4. `empty: a link invite queues nothing`: no `email` → 0 rows, and no `email_sent` in the response.
- [ ] **Step 2: Sweep and scan.** Scenario `org_invite` (`fr`, `invite.subject`, `{ orgName }`, `request`).
  Allowlist 28.
- [ ] **Step 3: Red** → `t4a`. **Step 4: Implement**, plus the copy, gen-keys and check.
- [ ] **Step 5: Green** → `t4a-b`, plus any component test that reads `settings.team.inviteEmail.notSent`
  (`grep -arln`). The sweep reports `checked: 23`.
- [ ] **Step 6: Mutation.** `email_sent = true`: test 2 fails.
- [ ] **Step 7: TSC, LINT, commit** `feat(orgs): the team invite goes through the outbox; the notice is true while it retries`.

#### T4b `claim_invite` — the organiser route and the registration path (F9)

**Files:**
- Create `server/usecases/claim-invite-mail.ts` and `server/usecases/__tests__/claim-invite-outbox.test.ts`.
- Modify `person-claims.ts` (`createClaimInvite`), `registrations.ts` (`maybeInviteClaim`), the claim-invites route
  and `lib/email.ts`.
- If Q1 is approved: the four `ui.json` (`claim.invite.sendFailed`).
- Repoint:
  - `claim-invites/__tests__/email-secret.test.ts`: its `sendClaimInviteEmail` / `sendOfficialInviteEmail` mocks
    become `claimInviteEmail` / `officialInviteEmail` spies (via `importOriginal`) that capture `claimUrl`. Every
    assertion stays as written;
  - `registrations.test.ts` (`emailMock.claimInvite`, `:68`): repoint to `claim_invite` rows;
  - `registration-submit.test.ts` and `registration-approval.test.ts`, where they assert the claim mail.
- Sweep, scan.

**Interfaces:**
- `queueClaimInviteEmail(tx: Tx, a: { kind: "claim_invite" | "official_invite"; refType: "person" | "official"; refId: string; orgId: string; to: string; claimUrl: string; personName: string; orgName: string }): Promise<string>`.
  - It reads `organizations.default_locale` through `tx`.
  - The locale is `recipientLocale(tx, { pick: null, userId: null, orgDefault })`.
  - It renders with `claimInviteEmail` or `officialInviteEmail`, by kind.
  - It calls `enqueueEmail(tx, { …, transactional: true, expiresAt: expiryWithin(<claim expires_at>) })`.
- `createClaimInvite(auth, personId, email, mail?: { kind: "claim_invite" | "official_invite"; refType: "person" | "official"; refId: string; origin: string; to: string })`.
  - With `mail`, it calls `queueClaimInviteEmail` inside its `withTenant`, after `reviveClaimInvite`.
  - The claim URL is `${origin}${routes.claim(secrets.emailSecret)}`.
  - The return gains `outboxId: string | null`. `emailSecret` is still returned, for the existing tests.
- The route passes `mail: { kind: "claim_invite", refType: "person", refId: id, origin: baseUrl(req), to: email }`.
  `to` is the address as typed, as today (`email-secret.test.ts:198`). The route then computes `email_sent` from
  `dispatchNow`.
- `maybeInviteClaim`:
  1. After the open-claim guard (unchanged), one `sql.begin(tx)`:
     `invite = await createSystemClaimInvite(tx, orgId, personId, email)` (the `Tx` branch, `person-claims.ts:212-214`);
     then, if `invite` is set, `id = await queueClaimInviteEmail(tx, { kind: "claim_invite", refType: "person", refId: personId, orgId, to: email, claimUrl: \`${fallbackOrigin()}${routes.claim(invite.emailSecret)}\`, … })`.
  2. After commit, `await dispatchNow([id])`.
  3. The outer catch is unchanged: it logs and never throws (P-W3-8).

**Copy (only if Q1 is approved):**
- en: `The email didn't go out straight away. It may arrive late, or not at all — copy the link below and share it with them yourself.`
- es: `El correo no salió de inmediato. Puede llegar más tarde o no llegar — copia el enlace de abajo y compártelo tú mismo con él.`
- fr: `L'e-mail n'est pas parti tout de suite. Il peut arriver en retard, ou pas du tout — copiez le lien ci-dessous et partagez-le vous-même avec lui.`
- nl: `De e-mail is niet meteen verstuurd. Hij kan later aankomen, of helemaal niet — kopieer de link hieronder en deel hem zelf met ze.`

- [ ] **Step 1: Failing tests** (`claim-invite-outbox.test.ts`, plus the repointed `email-secret.test.ts`):
  1. Route: `an organiser's invite queues one claim invite carrying the email secret, in the org's language, and
     reports email_sent`. Org default `es`. One row (ref `person / <id>`, `org_id` the org, `transactional` true),
     `sent`, `email_sent: true`; subject `dictionarySubject("es", "claimInvite.subject", { orgName })`. The transport
     text contains the claim URL whose secret hashes to `person_claims.email_token_hash`, and does not contain the
     response's `claim_url` secret (Review Focus 3; `email-secret.test.ts:141`, `:156`, `:249`, repointed).
  2. `a re-invite to the same address supersedes the first, and the first link no longer works` (repoints
     `email-secret.test.ts:215`): the older row is `replaced`, the newer one `sent`.
  3. Registration path (F9): `a consented team member with no account gets one claim invite through the real
     submit`. Drive the team submit from `_registration-fixtures.ts`, the path that reaches
     `registration-submit.ts:964`. Expect one `claim_invite` row to the member's email, ref `person / <person id>`,
     `sent`. A second convergence (call `inviteUnclaimedMembers` again for the same entrant) queues no second row:
     the open-claim guard is R6.
  4. `the approval path invites the same way`. Approve a pending team entry (`registration-approval.ts:158`): one
     row.
  5. `empty: a member with no email, or a person already claimed, queues nothing` (route 409; the system path
     returns early; 0 rows).
- [ ] **Step 2: Sweep and scan.** Scenario `claim_invite` (the route, `es`, `claimInvite.subject`, `{ orgName }`,
  `request`). Allowlist 27.
- [ ] **Steps 3–5** → `t4b`, `t4b-b`. If Q1 is approved, also gen-keys/check and any test reading
  `claim.invite.sendFailed`. The sweep reports `checked: 24`.
- [ ] **Step 6: Mutations.**
  - Drop the open-claim guard's early return: test 3's second convergence writes a second row.
  - Pass `secret` instead of `emailSecret` into the claim URL: test 1 fails.
  - Drop `mail` from the route's call: test 1 fails (no row).
- [ ] **Step 7: TSC, LINT, commit**
  `feat(claims): the claim invite goes through the outbox, from the console and from every registration path`.

#### T4c `official_invite`

**Files:** `v1/officials/[id]/invite/route.ts`, `officials.ts` (`inviteOfficial`), `lib/email.ts`; the four
`ui.json` (`officials.inviteEmailFailed`). Test: `claim-invite-outbox.test.ts`, `email-secret.test.ts` (its official
case), the sweep, the scan.

**Interfaces:** `inviteOfficial(auth, officialId, email, origin: string)` passes
`mail: { kind: "official_invite", refType: "official", refId: officialId, origin, to: email }` to `createClaimInvite`
and returns `outboxId`. The route passes `baseUrl(req)` and computes `email_sent` from `dispatchNow`. Update
`officials.ts`'s other callers of `inviteOfficial`, if any (`grep -arn "inviteOfficial("`).

**Copy:**
- en: `The email didn't go out straight away. It may arrive late, or not at all — share the link below to be sure.`
- es: `El correo no salió de inmediato. Puede llegar más tarde o no llegar — comparte el enlace de abajo para asegurarte.`
- fr: `L'e-mail n'est pas parti tout de suite. Il peut arriver en retard, ou pas du tout — partagez le lien ci-dessous pour en être sûr.`
- nl: `De e-mail is niet meteen verstuurd. Hij kan later aankomen, of helemaal niet — deel de link hieronder voor de zekerheid.`

- [ ] **Step 1: Failing tests:**
  1. `inviting an official queues one officiating invite in the org's language and reports email_sent`. Org default
     `nl`. One row: ref `official / <official id>`, `transactional` true, `sent`; subject
     `dictionarySubject("nl", "officialInvite.subject", { orgName })`; the email secret is in the body, not in the
     response (`email-secret.test.ts`'s official case, repointed).
  2. `email_sent is false while the outbox retries` (transport 503 once): `false`, the row `queued` with
     `attempts = 1`.
  3. `empty: an unknown official queues nothing` (404, 0 rows).
- [ ] **Step 2: Sweep and scan.** Scenario `official_invite` (`nl`, `officialInvite.subject`, `{ orgName }`,
  `request`).
- [ ] **Step 3: Close the lists.** `NOT_YET_MOVED` is `[]`; the sweep asserts `checked === 25`; `SENDER_ALLOWLIST`
  is 26 (49 − 5 − 10 − 8), by the derived length rule, with no number typed. `a-kind-body` still reports
  `kindsChecked: 8`.
- [ ] **Steps 4–6: Red → implement + copy + gen-keys/check → green** → `t4c`, `t4c-b`. VERIFY covers the sweep,
  scan, `a-kind-body.test.ts`, `outbox-schema.test.ts` and `claim-invite-outbox.test.ts`.
- [ ] **Step 7: Mutation.** Pass `kind: "claim_invite"` from `inviteOfficial`: test 1 fails (the subject and the ref).
- [ ] **Step 8: TSC, LINT, commit**
  `feat(officials): the officiating invite goes through the outbox; the notice is true while it retries`.

### Task 4d (batch C): wave-2 findings with customer value (owner, 2026-10-26)

The owner asked for every wave-2 finding to be checked for product and customer value, and for the ones that have value
to be built in this wave. The triage of all 27 is under "Wave-2 findings, triaged by customer value" below. Three
are built here. Each is one guard plus one test, and each is ONE commit. Lines are cited as of `badfee3fef`; re-pin by
symbol at T0.

**Files:** `apps/web/src/server/usecases/sponsors.ts`, `apps/web/src/server/usecases/registrations.ts`; tests in
`apps/web/src/server/usecases/__tests__/sponsor-dispute-outbox.test.ts`, `registration-dispute-outbox.test.ts`,
`sponsor-outbox.test.ts` (extend; reuse `_money-fixtures.ts`, `_registration-fixtures.ts`; no new fixture code).

- [ ] **4d-1. A closed inquiry un-parks the sponsor** (`handleSponsorDispute`, the `closed` phase, `sponsors.ts:1040`).
  *Customer value:* Stripe sends an inquiry (`warning_needs_response`) as `charge.dispute.created`, so the sponsor's
  placement is parked and the owner is alerted. When the inquiry closes without a chargeback, Stripe sends
  `charge.dispute.closed` with `status: "warning_closed"`. That matches neither `won` nor `lost`, so today the flag
  stays and the placement stays hidden FOREVER. The organiser cannot fix it either: `updateSponsor` refuses a manual
  reactivate with 409 "parked by an open payment dispute — it comes back automatically if the dispute is won". A sponsor
  who paid is invisible and nobody is told.
  *Change:* the `won` branch runs for `dispute.status === "won" || dispute.status === "warning_closed"`. A
  `warning_closed` means the money was never taken, which is what the won email already says ("closed in your favour.
  The money stays with you and the placement is back"), so the existing `sponsor_dispute_won` email and its once-key
  (`<dispute>:won`) are reused: no new kind, no migration, no new copy.
  *Test:* `a closed inquiry (warning_closed) clears the flag, re-activates the placement and queues the won notice once`.
  Expected values: `disputed_at` null, sponsor `status = 'active'`, one `sponsor_dispute_won` row; redelivery → still one.
  Mutant: drop the `warning_closed` arm → red.
- [ ] **4d-2. A closed inquiry clears the registrant's dispute flag** (`handleRegistrationDispute`, the `closed` phase,
  `registrations.ts:3413`).
  *Customer value:* same Stripe sequence on a registration cart. The registrant stays "disputed" for good in the
  registration hub (`registration-hub-registrant-derive.ts:176`) and in the division's dispute count
  (`registration-derive.ts:54`), so the organiser chases a dispute that ended.
  *Change:* the `won` branch also runs for `warning_closed` (clear `disputed_at`, the `registration.dispute_won` audit).
  No email: the registration won path sends none today.
  *Test:* `a closed inquiry (warning_closed) clears the cart's dispute flag`. Mutant: drop the arm → red.
- [ ] **4d-3. A replayed payment success cannot re-activate a refunded order** (`handleSponsorPaymentSucceeded`,
  `sponsors.ts:605`).
  *Customer value:* money. A refunded sponsor must never go back on boards and public pages. The handler's only guard
  is `order.status === "paid" || order.sponsor_id !== null`. A refunded order whose sponsor row was deleted has neither,
  so a re-run of its success (a crash re-claim of the event) inserts a NEW `active` sponsor row and marks the order
  `paid` again. Narrow to reach, but the owner's exception covers it (money), and the fix is one guard.
  *Change:* the guard becomes "only a `pending` or `failed` order activates" (confirm the order status enum at T0 and
  name every non-activating status in the test). Anything else returns `null`: no sponsor row, no receipt, no order write.
  *Test:* `a payment success re-run on a refunded order whose sponsor was deleted creates no sponsor and leaves the order
  refunded`. Expected: order `status = 'refunded'`, zero new `sponsors` rows for the org, zero new `sponsor_receipt`
  rows. Mutant: restore the old guard → red.

Changed while queued: nothing new. 4d-1 reuses a kind whose facts were recorded in wave 2.

### Task 5: Smoke

**Files:** `scripts/smoke.ts` only. No new selectable suite, so `smoke-select.test.ts` is unchanged.

- [ ] **Step 1: Add the checks.**
  - In `funnelSuite` (`:16670`), after the start: read the draft's id with the connection `checkSignInOutbox` uses
    (`select id from funnel_drafts where email = $1 order by created_at desc limit 1`), then
    `checkOutboxRow("funnel_claim", "funnel_draft", draftId)`.
  - In `main`'s invite-by-email block (`:304-324`): add `id: string` to the response type, then
    `checkOutboxRow("org_invite", "org_invite", emailInvite.id)`.
- [ ] **Step 2: Typecheck the scripts** with the repo's command for `scripts/`.
- [ ] **Step 3: CI runs it.** The PR's smoke job runs the full smoke; there is no local server. The controller pastes
  the six new check lines (three per kind) from the PR run. CI has no Resend key, so each row ends `dead`
  (`no_api_key`) at its first attempt, which is what "first attempt made, no body" asserts.
- [ ] **Step 4: Commit** `test(smoke): funnel start and team invite each leave one outbox row`.

### Task 6: E2E (CI dispatch only) and the visual check

**Files:**
- `apps/web/e2e/funnel.spec.ts`
- `apps/web/e2e/officials-directory.spec.ts`
- `apps/web/e2e/player-accounts.spec.ts`
- `apps/web/e2e/walkthrough/settings-people-tabs.spec.ts`
- `apps/web/e2e/walkthrough/settings-admin.spec.ts`
- `apps/web/e2e/walkthrough/directory-officials-roles.spec.ts`
- `apps/web/e2e/walkthrough/directory-player-identity.spec.ts`, only if Q1 is approved.

**Interfaces:**
- Row reads use each spec's own `withDb` (or the helper it already imports).
- Copy and subjects are read from `src/dictionaries/en/{ui,emails}.json` by import, never typed (the `requireEn`
  pattern of `walkthrough/scheduling-officials-handoff.spec.ts:63`).
- CI has no Resend key: an R row is "no longer waiting, no body", which is wave 1's `checkOutboxRow` shape.

- [ ] **Step 1: Add the assertions.**
  - `funnel.spec.ts`: after the claim link appears, there is one `funnel_claim` row for the draft (its id read by the
    visitor's address), no longer waiting, with no body, and the `en` subject.
  - `settings-people-tabs.spec.ts:331`: after "Send invite", the notice equals `settings.team.inviteEmail.notSent`
    (en), and there is one `org_invite` row for `org_invite / <the stored invite's id>`, no longer waiting.
  - `officials-directory.spec.ts:71`: replace `/Email failed to send/i` with the dictionary's
    `officials.inviteEmailFailed`, and add one `official_invite` row for the official, no longer waiting.
  - `directory-officials-roles.spec.ts:271`: the same regex replacement.
  - `player-accounts.spec.ts:104`: after the claim-invite POST, one `claim_invite` row for `person / <ada.id>`.
  - `settings-admin.spec.ts`, a new test, `a second email-change request ends the first's queued confirmation`
    (wave 1's P5 precedent: CI ends every first attempt at once, so the queued row is seeded):
    1. Through `withDb`, insert one `queued` `email_change_confirmation` for `user / <the signed-in user's id>`,
       org null, `next_attempt_at` an hour out, `expires_at` two hours out, and a one-byte `body_sealed`.
    2. POST `/api/auth/change-email` with a fresh `delivered+…@resend.dev` address.
    3. The seeded row reads `expired` / `email_change_superseded` with no body.
    4. There is one new confirmation row to the new address, and one notice row to the old one, both no longer
       waiting.
    5. In `finally`, delete the pending `email_change_requests` row.
  - If Q1 is approved, in `directory-player-identity.spec.ts:225`: the dialog shows `claim.invite.sendFailed` (en).
- [ ] **Step 2: Collect, never run.**
  `cd <worktree>/apps/web && npx playwright test --list e2e/funnel.spec.ts e2e/officials-directory.spec.ts e2e/player-accounts.spec.ts e2e/walkthrough/settings-people-tabs.spec.ts e2e/walkthrough/settings-admin.spec.ts e2e/walkthrough/directory-officials-roles.spec.ts; echo EXIT=$?`.
  Expected: `EXIT=0`, with the new title listed. Then TSC.
- [ ] **Step 3: Commit** `test(e2e): wave-3 outbox rows, and the reworded invite notices read from the dictionary`.
- [ ] **Step 4 (controller): dispatch.** `gh workflow run e2e.yml --ref feat/email-outbox-phase3-w3 -f pr=<n>`. The
  files run whole, never as a `-g` slice. For a serial file, treat the red count as a floor and re-run after each fix.
- [ ] **Step 5 (controller): the visual check**, as the owner rules in Q2. Load `frontend-design` first. The
  surfaces:
  - the team settings invite notice (`/o/<slug>/settings`, team tab, `org-team.tsx:151`);
  - the officials directory invite result (`/directory?tab=officials`, `officials-shared.tsx:121`);
  - the claim dialog (`invite-claim.tsx:176`), only if Q1 is approved.

  Take each at 1280, 768 and 320, and assert `document.documentElement.scrollWidth <= innerWidth` at each. Confirm
  the images exist and differ, and publish them on one Artifact page. The longer copy wraps inside the existing
  notice element; no layout change is expected.

### PR checklist (controller)

- Rebase onto `origin/main`; never merge main in. Re-pin `V<N>`.
- The scoped VERIFY for every file T1–T4 touched is green. Paste the counts: sweep 25, `a-kind-body` 8, allowlist 26.
- Smoke: the PR's smoke job shows T5's six check lines.
- e2e dispatched (T6 Step 4); the visual Artifact is linked (T6 Step 5).
- G-5: readiness log clean.
- Push, open the PR, hand back. Do not poll CI. Merge, stg and prod only on the owner's explicit go.

## Conflict scan (pairs of tasks sharing files or interfaces)

| Pair | Shared | Resolution |
|---|---|---|
| T1 → T2…T4 | `_kind-senders.ts`, `outbox-kind-sweep.test.ts` (each kind removes its entry) | Sequential. |
| T2a…T4c, every pair | `lib/email.ts` (one sender out, one builder in); `no-second-path.test.ts` (allowlist 33 → 26) | Sequential: the hunks are disjoint, but the allowlist is a running count. |
| T2c – T2d | `change-email/route.ts`, `change-email-outbox.test.ts` (T2d extends T2c's test 2) | T2c first. |
| T2a – T4a | `scrub-login-token.test.ts` (both repoint a mock in the same factory) | Sequential. |
| T3a → T3b | `account-deletion.ts` / `constants.ts`; `account-deletion-sweep.test.ts` (T3b drops its mock entry) | T3a first. |
| T3b – `worker.test.ts`, `worker-purge-wiring.test.ts` | the tick's report shape gains `scrubbed` | Inside T3b. |
| T4b → T4c | `createClaimInvite`'s `mail` descriptor, `queueClaimInviteEmail`, `email-secret.test.ts` | T4b first. |
| T4a, T4b (Q1), T4c | `ui.json` ×4 (three different keys) | Sequential, inside the batch. |
| T5 / T6 | `scripts/` vs `e2e/` | May run in parallel after T4c. |
| Peer branches | W2d (migration number); any session editing `registrations.ts`, `person-claims.ts`, `users/me/route.ts` or `worker.ts` since wave 2 | `git log origin/main --oneline -- <file>` at T0 and before the PR. |

**Execution order:** T0, T1, T2 (a, b, c, d, [e]), T3 (a, b), T4 (a, b, c), then T5 ∥ T6.

## Owner questions

1. **Q1: the player claim dialog's "couldn't be sent" notice.** `claim.invite.sendFailed` ("The email couldn't be
   sent — copy the link below and share it with them yourself.", `en/ui.json:508`) is shown when the claim invite's
   `email_sent` is false (`invite-claim.tsx:176`). D3 rewords the two officials and team notices, but not this one,
   and with the outbox it becomes untrue while the invite retries.
   - **Recommendation:** reword it in all four locales, like its two siblings (T4b's copy).
   - Owner value: an organiser whose player says "I never got it" is not told the email failed when it is about to
     arrive. It costs 4 strings, one e2e line and one screen in the visual check.
   - If declined, T4b skips the copy and the residual is recorded.
2. **Q2: how to take the screenshots of the reworded notices** without a local web server.
   - The notices show only when `email_sent` is false. Stg has a Resend key, so its first attempts succeed and the
     notices never appear there. CI's e2e run shows them (no key), but uploads no report on a green run.
   - **Recommendation:** a one-off exception for the visual check only: a local prod server with no Resend key
     (`$S up --label outbox-p3-w3 --server`), driven by Playwright MCP at 1280, 768 and 320, then stopped. Nothing
     else runs against it.
   - Owner value: the reworded copy is seen at phone width before merge (the longest string grows by about 40%). It
     costs one exception to the no-local-server rule, about 15 minutes.
   - Alternative: accept the e2e text assertions (T6) as the check for a copy-only change and skip the screenshots.
3. **Q3: the sign-in link in the account's language.** Wave 1 deferred it ("Locale for account email is wave 3's",
   wave-1 plan T7). `magic_link` still renders English for every account (`magic-link/route.ts:84`), while this wave
   gives the verification, email-change and deletion mails the account's language.
   - **Recommendation:** fold it in as T2e: one line and one test.
   - Owner value: a Dutch, French or Spanish user's most frequent email matches the rest of their account mail.
   - If declined, it is recorded for a later wave.

The controller rules on P-W3-1 to P-W3-15, or puts them to the owner, before T2.

## Rare cases — recorded, not built

One line each. None loses money or data or leaks a secret's value, except where noted as built.

- The outbox key is unset or the sample one on a box with a Resend key: every wave-3 action refuses (D1). There are no
  tests (owner rule; the readiness log reports it at boot).
- A fact transaction rolls back after its enqueue: the row rolls back with it (R1 by construction). There is no
  per-kind rollback test (P-W3-10).
- An org invite is revoked, or the org renamed, while its email waits in provider retry: it arrives with a dead link,
  or the old name.
- A claim or official invite is re-sent to another address, or withdrawn, or the person claims through another path,
  while the first email waits in retry: it arrives with a revoked or used link.
- Two registration convergences for one person race past the open-claim guard: the loser's invite is revoked by the
  winner's (the existing race, `person-claims.ts:84-105`).
- An account confirms an email change while a verification email waits in retry: the verification goes to the old
  address (literal kind).
- The deletion notice waits in provider retry: its row holds the real address for up to 7.35 h until it ends, and is
  scrubbed at the next tick after that.
- The tick's budget is spent before step 7a: the scrub runs next tick.
- A staff verification resend races the account's own email change: the newer token goes to whichever address the
  route read.

## Wave-2 findings, triaged by customer value (owner, 2026-10-26)

Source: the wave-2 ledger and final review (24 parked minors and 3 new). The question for each: does a customer
(organiser, sponsor, player, staff) see a difference? Built = Task 4d.

| # | Finding | Who sees it | Verdict |
|---|---|---|---|
| 1 | sponsor `warning_closed` falls through: placement hidden forever, manual reactivate refused | paying sponsor, organiser | **Build (4d-1)** |
| 2 | registration `warning_closed` twin: registrant "disputed" forever | organiser | **Build (4d-2)** |
| 3 | refunded order (sponsor deleted) re-activated by a re-run success (`sponsors.ts:605`) | public pages show a refunded sponsor | **Build (4d-3)**: money |
| 4 | platform-subscription `warning_closed` twin (`billing-events.ts:2433`) | nobody: no code reads `subscriptions.disputed_at` | Record |
| 5 | missing order/cart row counts as a transition (`sponsors.ts:1050`, `registrations.ts:3380`) | at worst one extra alert for a real dispute; rare | Record |
| 6 | pass revoke reads owner + locale on partial refunds; no log for an owner-less org | nobody (two indexed reads) | Record |
| 7 | `refId: dedupeKey` → `chargeId` in `queuePassRevokedEmail` | nobody today; a future suffix fails loudly | Record |
| 8 | `enqueue.ts:77` refusal says "empty or blank" for a missing id | developers only | Fold only if T1 touches `enqueue.ts` |
| 9 | evidence-pack comments ("language it was sent in", "exact sender inputs") | developers only | Record |
| 10 | test anchors / unasserted comments (`once-key-builder.test.ts:67`, `sponsor-dispute-outbox.test.ts:298`) | nobody; behaviour is killed by other tests | Record |
| 11 | hand-typed spec kind lists in 4 test files | developers only; hand-typing from the spec is deliberate | Record |
| 12 | three similar enqueue literals in `sponsors.ts` | nobody; below the abstraction bar | Record |
| 13 | lost branch: no no-owner / after-withdrawal test | nobody; TSC kills the guard mutant | Record |
| 14 | test rows left in local DBs | developers only; CI is fresh | Record |
| 15 | wave-1 dedupeKeys not on `onceKey` | nobody; each embeds a non-null id | Record |
| 16 | walkthrough / e2e wording, order and comments (T11/12 m1–m4), `hasBody:false` belt | nobody | Record |
| 17 | `registration_dispute_lost` has no e2e/smoke row check | nobody; unit + sweep + F7 cover it | Record |
| 18 | changed-while-queued plan text for won/lost; first-attempt timing checks; 149-char comment line | nobody | Record |
| 19 | walkthrough KEK concern | ruled void in wave 2 (CI witness) | Closed |

## Next waves and routed findings (not built here)

- a. **Funnel locale (P-W3-15).** A visitor browsing in Dutch gets an English claim email, because the start request
  carries no locale. A later wave could send the page's locale as D4's explicit pick (a schema field and the
  wizard).
- b. **Wave 4:** official assigned and assignment changed (F5), suspension confirmed and served, match report, and the
  four group-transfer kinds. Wave 4 repoints `email-send-result.test.ts` only if it deletes `sendFunnelReminderEmail`,
  and it does not: that is wave 5's.
- c. **Wave 5:** the funnel reminder (§9, F6) and the 16 staff alerts. It deletes `send()`, `sendWithResult` and the
  `email-send-result.test.ts` regression block.
- d. **Phase 4:** `scrubEndedRecipients` moves with the worker. It is SQL only, so it lifts out cleanly.

## Self-review

1. **Spec coverage.**
   - The 8 kinds map to T2a, T2b, T2c, T2d, T3b, T4a, T4b and T4c.
   - The wave-3 test row:
     - "sweep of 8" → each kind's scenario, closed at 25 in T4c Step 3;
     - "a second request replaces the first" → T2a test 2, and its false premise for funnel and org invite → T2b
       test 3 and T4a test 3 (P-W3-2);
     - "older email-change confirmations end" → T2c test 2;
     - "the wave's account kinds fall inside wave 1's deletion sweep" → T3a (P-W3-5);
     - "the deletion notice's address is gone once its row ends" → T3b tests 2–3;
     - E2E → T6; smoke → T5; the regression → T3b test 2.
   - D3 → T4a and T4c (+ T4b if Q1). F9 → T4b (P-W3-8). §12 → Global Constraints. D4 → the kind table. D5 → T3a.
   - The migration rule → T1.
2. **Owner rules.**
   - There are no key-fault, outage or race tests. The two 503 cases (T2c test 2, T4a test 2) stage the exact state
     that a spec rule or a reworded notice is about. T4c test 2 is the officials notice's state.
   - Changed-while-queued has one line per kind, in the kind table. Code exists only for the common changes: the
     verification resend, the email-change request, and the claim re-invite to the same address (the existing
     trigger).
   - Batches: T2 has four commits under one dispatch, and T4 three.
3. **Type consistency.** The following are spelled identically across tasks:
   - `queueClaimInviteEmail`;
   - `createClaimInvite(auth, personId, email, mail?)` and its `outboxId`;
   - `inviteOfficial(auth, officialId, email, origin)`;
   - `scrubEndedRecipients(opts)` and `report.scrubbed`;
   - `ACCOUNT_MAIL_KINDS`, `SCRUBBED_WHEN_ENDED` and `EMAIL_CHANGE_SUPERSEDED_REASON`;
   - the eight builder names.
4. **Review Focus.** Lines 1–5 have tests in their owning tasks. Line 6 is a written review item (P-W3-10).
5. **Proportion.** Bodies appear only as one-line SQL or call shapes. The rest is signatures, test names and expected
   values.
