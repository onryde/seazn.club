# Email outbox phase 3, wave 4 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the nine officiating, discipline and billing-group emails onto the outbox: the two official notices
(assigned, assignment changed), the two suspension notices (confirmed, served), the match-report notice, and the four
billing-group notices (transfer offer, transfer complete, org removed, org left). This fixes F5 (an official's email
and its fixture labels in one language) and retires the served notice's `xmin` check once the in-transaction path is
proven.

**Architecture:** One migration widens the kind CHECK by nine. Each kind swaps its `send*` for a render builder plus an
enqueue on the transaction that commits its fact, in the same commit (the cutover rule). Two kinds are literal (the
official's address); seven are account kinds (`recipient_user_id`). Eight are request kinds (`deferred(dispatchNow)`
after commit); `suspension_served` is written by every serving pass, read paths included, and is left to the worker.
No UI or copy changes: every builder renders existing `emails.json` keys.

**Tech Stack:** Next (repo fork, see `AGENTS.md`), TypeScript, postgres.js (`sql.begin`, `withTenant`), Postgres 17
with Flyway deltas, vitest (node environment), Playwright on CI only, Stripe (mocked in vitest).

**Spec:** `docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md` (owner-approved 2026-10-25): the wave-4 rows
of its kind table (inventory #5–#9, #15–#18), F5, §8's `xmin` row, §12 and the wave-4 row of its test table. Executors
also read the wave-1 plan (`2026-10-25-email-outbox-phase3-wave1.md`, Global Constraints and Tasks 7–12) and the wave-2
plan (`2026-10-26-email-outbox-phase3-wave2.md`, its Global Constraints and rulings, which this plan carries).

**Kind count.** The spec's table lists exactly nine wave-4 rows (#5, #6, #7, #8, #9, #15, #16, #17, #18), matching
the wave-1 outline. 49 − 5 − 10 − 8 − 9 = 17 left for wave 5, which matches the spec's wave-5 count.

## Owner rulings (2026-10-26) — every Owner question below is decided

The owner applied every recommendation in this plan's Owner questions: Q1 an unassignment does NOT cancel a still-queued assignment notice (recorded, not built); Q2 the assignment notice uses the 24 h bound, not the fixture start.

## Global Constraints

Everything in the wave-2 plan's Global Constraints applies, with the path, branch and label below. The lines that bite
here are restated.

- **Worktree.** `/Users/ashokhein/github/seazn.club/.claude/worktrees/outbox-p3-w4`, branch
  `feat/email-outbox-phase3-w4`, cut from `origin/main` after wave 3 merges (T0). Prefix every command with
  `cd <that path> &&` or `cd <that path>/apps/web &&`. Never check anything out in the main checkout. Never use
  `git stash`.
- **Migration number.** Expected `V475` (wave 2 takes V473, wave 3 V474), written below as `V<N>`. Landed as `V477` (W2d took
  V475, the relay V476; Flyway has no outOfOrder, so lower numbers must reach main first). It is NOT a fact:
  W2d and other programmes also allocate numbers. Re-pin right before committing T1 and again before the PR:
  `git fetch origin && git ls-tree --name-only origin/main db/migration/deltas/ | sort -V | tail -1`, then max + 1.
  If taken, `git mv` and amend while unmerged.
- **Running counts are expectations, re-pinned at T0, never facts.** After wave 3: 25 kinds, the sweep closes at
  `checked === 25`, `a-kind-body` at `kindsChecked === 8` (wave 3's kinds are all literal), `SENDER_ALLOWLIST` 26.
  After this wave: 34, 34, 15, 17.
- **R1–R6, D1, D2, D4, D5** as in the spec. R1: the row is written on the fact's transaction. R4: no catch-and-continue
  inside a transaction. R5: `dispatchNow` only after commit. R6: enqueue only on the transition. D1: a refused enqueue
  fails the action. D4: pick, then the linked account's locale (existing link only), then the org default, then `en`.
- **No pooled `sql` call inside `withTenant`** (#996). Every render read inside a tenant transaction uses `tx`.
- **The cutover rule.** A kind's `send*` is deleted in the commit that adds its enqueue.
- **Transactional flag** stays the sender's: `true` for the two official kinds, both suspension kinds and the report
  (they pass `transactional: true` today, `lib/email.ts:359-449`); `false` for the four group kinds (`:504-559`).
- **First attempt.** R kinds: `deferred(() => dispatchNow(ids))` after the transaction resolves. `suspension_served`:
  no `dispatchNow` (spec: W, read path).
- **Expiry.** `expiryWithin(null)` (the bound) for every kind except `official_assignment_changed`, which uses
  `expiryWithin(nextAt)` (`null` when the move unscheduled it). `official_assigned` uses the bound, not the fixture's
  start (P-W4-3, owner question Q2).
- **Hooks.** Every `KIND_HOOKS` entry is `{}` (phase-4 note: no app-render dependency in dispatch, worker or webhook).
- **Changed while queued (owner, 2026-10-26).** A queued row is a snapshot. The kind table's last column names, per
  kind, the facts that can change while the row waits and what refreshes it, or why none can. Code and a test exist only
  for the one change that is common (a second move of a fixture, `official_assignment_changed`). The rest are listed
  under "Rare cases — recorded, not built".
- **Mainstream only (owner, 2026-10-26).** No key-fault / KEK-unset tests, no provider-outage tests, no race tests
  beyond the ones the served notice's existing suite already has. No new fixture framework: seeds are MOVED from the
  suite that owns them into an existing shared leaf (`_seed.ts`, wave 2's `_money-fixtures.ts`), never written anew.
- **Copy.** No user-facing string changes in this wave (every builder renders existing `emails.json` keys; the F5 fix
  uses the existing `ui.json` `schedule.vs` / `schedule.tbd`). If an executor finds one is needed, STOP and report: it
  goes into all four locales, then `pnpm i18n:gen-keys && pnpm i18n:check`.
- **No UI change**, so no screenshots. No route contract change, so no `openapi:gen`.
- **Test rules** (`docs/superpowers/TEST-STRATEGY.md`, four test types in `RULES.md`): test the sequence (second call,
  empty input, after a void/withdrawal where the kind has one); anti-vacuity (sweeps print counts, zero fails);
  expected subjects from `dictionarySubject` (reads the JSON), expected labels from `dictionaries/<l>/ui.json` by
  import, never from the code under test; mutate each guard once, alone, and name the test that kills it.
- **ENV.** `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`; `$S up --label outbox-p3-w4`,
  `eval "$($S env --label outbox-p3-w4)"`; env down/up after a migration edit; never a bare `pnpm db:apply`; confirm
  `show data_directory` is this label's.
- **VERIFY `<files>` → `tN`** exactly as in the wave-2 plan, with this worktree and label:
  ```
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/outbox-p3-w4/apps/web && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label outbox-p3-w4)" && npx vitest run <files> --reporter=json --outputFile=$OUT/tN.json; echo EXIT=$?
  jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests, files: [.testResults[].name]}' $OUT/tN.json
  ```
  Green = `EXIT=0`, `failed == 0`, `total` as the step says, every file listed under this worktree's path.
- **TSC** = `cd <worktree>/apps/web && rtk proxy npx tsc --noEmit -p tsconfig.json; echo EXIT=$?`.
  **LINT `<files>`** = `cd <worktree>/apps/web && rtk proxy npx eslint <files>; echo EXIT=$?` (read `✖ N problems`).
- **MUTATE** = the wave-1 recipe (`cp` backup, edit, VERIFY: the named test fails and `total` is unchanged, `cp`
  restore, VERIFY green). Never `git checkout`/`git stash`/`git restore` on a file.
- **Never locally:** the full vitest suite, the full e2e suite, `$S gate`, a local web server. e2e only by CI dispatch
  (controller): `gh workflow run e2e.yml --ref feat/email-outbox-phase3-w4 -f pr=<n>`. Smoke runs on the PR's CI job.
- **Kill only your own PIDs. No evidence PNGs in the repo.**
- **Commit trailer.** Every commit ends with the attribution lines the executing session's system prompt gives
  (today `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
- **Executors re-pin by symbol.** Every line number below is as of `67eb05aedd` (wave 1 merged). Waves 2 and 3 edit
  `lib/email.ts` and the shared test lists, so lines move. Re-pin with `grep -an <symbol>` before editing.

**Rulings carried (binding here):** R-T1f (every once-key embeds a UUID; use wave 2's `onceKey()`), R-T1e (a cancel
frees the key), `claimQueuedRow` for staged claims, account vs literal decided by `OUTBOX_KIND_FACTS[kind].to` (so every
A producer test asserts `recipient_user_id`), C1 (no `E2E_PROD_TARGET` skip), C2, C4 (a rollback is witnessed by a
failing SQL statement after the enqueue, never by a pre-SQL throw), G-5 (readiness log clean on the PR checklist).

## Plan decisions where the tree contradicts or underdetermines the spec

Each is a finding for the wave report. A controller who disagrees rules before the owning task runs.

| # | Spec says | The tree says | Plan does |
|---|---|---|---|
| P-W4-1 | `official_assigned`: ref `division_event:official`, once-key "same". | Two producers. `applyOfficialAssignments` (`officials.ts:539`) writes a `division_events` row (`:580-584`); `patchFixtureOfficials` (`:614`) writes none. Both are user presses; R6 already holds through the carry-over diff (`fresh`: only `(fixture, official, role)` triples absent before, `:568-571`, `:629-631`), so a re-apply notifies nobody. | Auto: `division_event / <divisionId>:<seq>:<officialId>` (the event's `seq` under the division's advisory lock). Manual: `fixture_official / <fixtureId>:<officialId>`. No once-key (spec §5: user presses leave it empty). The official id is in the ref so two officials sharing one address in one apply do not supersede each other. |
| P-W4-2 | `official_assignment_changed`: ref `fixture:official`; "two moves of one fixture give one". | `moveFixture`'s notice query (`schedule.ts:3320-3336`) returns one row per `(official, role)`; an official holding two roles on one fixture gets two emails today. With a `fixture:official` ref, the second row's AFTER INSERT replace would end the first in the same transaction: one email naming one role. The query selects no official id and no person link. | Ref `fixture_official / <fixtureId>:<officialId>:<roleKey>`. The query adds `o.id`, `o.person_id`'s `p.user_id`. A later move of the same fixture supersedes a still-queued earlier notice per role (spec). |
| P-W4-3 | §12: the two official notices expire at the fixture's start. | A match report needs an ACCEPTED assignment (`match-reports.ts:90-93`), and the accept/decline CTA is what the assigned notice carries. Assigning after the match (to let an official file a report or be marked) is a real flow; with the spec's expiry its notice would never be sent. | `official_assigned`: the bound. `official_assignment_changed`: `nextAt` (a move of a match that already started is not worth mailing). Owner question Q2. |
| P-W4-4 | F5 / D4: one locale per email. | `assignedNotices` builds every label with the ORG default (`officials.ts:697-702`) and the sender is called with none (`:761-768`, default `en`). `moveFixture` does the same (`schedule.ts:3364-3366`, send `:3367`). Officials are literal-address kinds but can be claimed: `officials.person_id` → `persons.user_id`. | Per official: `recipientLocale(tx, { pick: null, userId: <person's user_id or null>, orgDefault: org.default_locale })`, and the fixture labels' `lookup` is built with THAT locale, inside the transaction. Literal kind: no `recipientUserId`. |
| P-W4-5 | `suspension_served`: enqueued "in the transaction that flips the suspension". | The flip is `updateServing` (`discipline.ts:360-412`), reached through `detectSuspensions(tx)` from eight callers: four in `discipline.ts` (`putDisciplineRules`, `listSuspensions`, `decideSuspension`, `suspensionsForFixture`), the public strip `publicSuspensions` (`:849`), the organiser page's `activeSuspensionsByEntrant` (`:768`, inside its CALLER's transaction), and `scoring.ts` `refreshDiscipline` (`:788`). Every one is a `withTenant` on the division's org, so R3 holds. | Enqueue inside `updateServing`, on `tx`, right after the guarded flip returns a row. The 8 callers drop `notifyServedSuspensions`. `detectSuspensions` returns the flipped ids (`string[]`). Once the repointed race suite is green, `ServedFlip`, `xmin` and `notifyServedSuspensions` are deleted (spec §8). D1 now applies on read paths too (recorded rare). |
| P-W4-6 | `suspension_confirmed`: R6 with once-key `<id>:confirmed`. | The confirm update is unconditional (`discipline.ts:705-709`): the API can re-confirm any status, and a double press mails twice today. The notice is built after commit on the pool (`emailConfirmed`, `:733`). | The first select in `decideSuspension` gains `for update`; the enqueue runs in the same `withTenant`, only when the prior status was `pending`; once-key `<id>:confirmed` backs it. Render reads (persons → users, org, division) on `tx`. |
| P-W4-7 | `match_report_submitted`: once-key "report id". | Recipients are every owner AND admin (`match-reports.ts:225-228`), one email each. One key per report lets one row through. The submit update and the notice run on the pool, not in one transaction (`:155-161`). | One `sql.begin`: the `status = 'draft' … returning` update, then one row per recipient, only when the update returned a row (R6). Once-key `<reportId>:<userId>`. Recipients filtered `u.deleted_at is null`. D4 per recipient (today `u.locale ?? 'en'`, no org default). |
| P-W4-8 | `group_transfer_complete`: R1, ref `subscription:recipient · transfer`. | The fact commits in `handOverGroup`'s `sql.begin` (`billing-groups.ts:1893-1930`), which `acceptGroupTransfer` shares and which sends no email. The notice runs after `finishHandover` (Stripe calls, `:1944`), so a Stripe throw there loses it today. A double press is refused under the lock (403/409). | `handOverGroup` gains an optional `inHandover?: (tx: Tx, row: GroupRow) => Promise<void>` run after the swap (wave-2 P-W2-7 `inRevoke` shape); only the immediate path passes it. Ref `subscription / <subscriptionId>`, no once-key, `org_id` null (P-W2-12 precedent: a group spans orgs). |
| P-W4-9 | `group_transfer_offer`: R1. | The offer goes live at `update billing_group_transfers set setup_intent_id` (`:1504-1505`), on the pool, after the Stripe SetupIntent is created. | That update, the render reads and the enqueue in one `sql.begin`. Ref `subscription / <subscriptionId>` (a re-offer to the same person after a withdraw is a full restatement), no once-key, `org_id` null. A refused enqueue here is rare and recorded (the claim stays pending; the payer can withdraw). |
| P-W4-10 | `group_org_removed` / `group_org_left`: ref `group_org · detach`. | Both are sent after the detach's `sql.begin` (`:1174-1324`), best-effort, errors swallowed (`notifyDetachParties`, `:2035-2072`), with reads on the pool. Each detach inserts a fresh `subscriptions` row (`:1244-1248`), unique per detach. A double press is refused (`:1220-1221`). | Enqueue inside the detach transaction after the `organizations` update. Ref `group_detach / <fresh.id>`, no once-key, `org_id` = the detached org. `notifyContact` and `payerDisplayName` read on `tx`. The swallow goes (D1). |
| P-W4-11 | D4 for the group and report kinds. | `sendTransferOfferEmail`/`sendTransferCompleteEmail` are called with no locale (`:2088`, `:2105`): always English. The detach notices use `toLocale(u.locale)` with no org fallback. | `recipientLocale(tx, { pick: null, userId, orgDefault })` with orgDefault = the reachable org's (offer, complete), the detached org's (removed), the remaining org's `others[0]` (left). The ride-out date keeps `Intl.DateTimeFormat(locale, { dateStyle: "long" })`. |
| P-W4-12 | (tests) | Seven suites assert the senders through `vi.mock("@/lib/email")`. Two factories replace the whole module (`officials.test.ts:38`, `billing-group-offer-notify.test.ts:23`, `billing-group-transfer-notify-followups.test.ts:27`); `withdrawn-winner-walkover.test.ts:76-79` reads the assigned email's labels off the sender (R116-4). Five tests assert the deleted best-effort path ("send rejects → logged", `discipline.test.ts:960`, `:971`, `:991`; `billing-group-offer-notify.test.ts:105`, `:125`; detach `:147`; transfer-followups `:164`). | Factories spread `importOriginal`. Assertions move to outbox rows; R116-4 moves to a spy on the builder `officialAssignedEmail` (wrapping the original). The best-effort tests are deleted, each named in the task report with the reason ("delivery is the outbox's job"). `discipline.test.ts:887` (an `xmin`-specific case) is deleted with the plumbing. |

**Stale citations.** The spec's wave-4 sender lines (`email.ts:359`, `:387`, `:402`, `:418`, `:438`, `:504`, `:519`,
`:533`, `:548`) and F5's (`officials.ts:693-701`, `:763-767`; `schedule.ts:3355-3358`) are within a few lines at
`67eb05aedd`: labels `officials.ts:697-702`, send `:763`; `schedule.ts:3364-3367`. §8's `discipline.ts:448-455` is
`notifyServedSuspensions` at `:448`.

## Review Focus

1. **An official holding two roles on one fixture** gets one move notice per role, and neither ends the other
   (P-W4-2). Test: T2 test 8.
2. **A claimed official whose account language differs from the org's** gets one email whose fixture labels are in the
   email's language (F5, P-W4-4). Test: T2 test 6 (assigned) and test 11 (changed).
3. **A served notice exists only for a flip that committed:** a rolled-back read (the division page) writes nothing,
   and the next committed pass writes exactly one row (P-W4-5, replacing `xmin`). Tests: T3's repointed race suite.
4. **A match report reaches every owner and admin, one row each** (P-W4-7). Test: T3 test 12.
5. **A handover's notice survives a failing Stripe tidy-up after it** (P-W4-8), and a transfer to a French account
   arrives in French (P-W4-11). Tests: T4 tests 3 and 1.

## The nine kinds

Builders follow wave 1's convention: `<name>Email(args, locale: Locale): Promise<EmailContent>`, rendering the existing
template with `getDictionary(locale, "emails")`. A builder keeps the URL its sender built (`meUrl` = `${appOrigin()}/me`;
the report's console URL from the three slugs; the billing link passed in).

| Kind (spec order) | Sender deleted | Builder | Producer (`67eb05aedd`) | To | First | `ref_type / ref_id` | Once-key | Org | Locale | Expiry | Changed while queued |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `official_assigned` | `sendOfficialAssignedEmail` :359 | `officialAssignedEmail` | `officials.ts` `applyOfficialAssignments` :539, `patchFixtureOfficials` :614, via `assignedNotices` :681 | L: `officials.email` | R | auto `division_event / <div>:<seq>:<official>`; manual `fixture_official / <fixture>:<official>` | — | `auth.orgId` | official's linked account, org default | bound (P-W4-3) | Times, venues and labels can change by a move: the move queues its own `official_assignment_changed`, which is sent too. An unassignment or re-apply refreshes nothing. Window: the request's `dispatchNow` (about 16 rows in its 10 s budget) plus one worker tick for a larger apply. Rare — recorded (Q1). |
| `official_assignment_changed` | `sendOfficialAssignmentChangedEmail` :387 | `officialAssignmentChangedEmail` | `schedule.ts` `moveFixture` :3032 | L | R | `fixture_official / <fixture>:<official>:<role>` | — | `auth.orgId` | same | `nextAt` | New time/court/venue: a later move supersedes the queued row (same ref). **Built and tested** (T2 test 9). "Was" then names the intermediate time — rare, recorded. |
| `suspension_confirmed` | `sendSuspensionConfirmedEmail` :402 | `suspensionConfirmedEmail` | `discipline.ts` `decideSuspension` :679 | A: `persons.user_id` | R | `suspension / <id>` | `<id>:confirmed` | `auth.orgId` | account, org default | bound | Reason/length by "adjust", or a waive, right after confirming. Window: seconds (R). Rare — recorded. |
| `suspension_served` | `sendSuspensionServedEmail` :438 | `suspensionServedEmail` | `discipline.ts` `updateServing` :360 (8 callers, P-W4-5) | A | W | `suspension / <id>` | `<id>:served` | the suspension's org (= tenant) | account, org default | bound | Nothing: `served` is terminal (`updateServing` writes only `active` rows, `:362-364`, `:406-408`). |
| `match_report_submitted` | `sendReportSubmittedEmail` :418 | `reportSubmittedEmail` | `match-reports.ts` `submitMyReport` :142 | A: each owner/admin | R | `match_report / <reportId>` | `<reportId>:<userId>` | `a.org_id` | member's account, org default | bound | Nothing in the body: a submitted report is immutable (409, `:148-150`). A member demoted in the window still gets it — rare, recorded. |
| `group_transfer_offer` | `sendTransferOfferEmail` :504 | `transferOfferEmail` | `billing-groups.ts` `offerGroupTransfer` :1423 | A: `recipient.id` | R | `subscription / <subId>` | — | null | account, reachable org default | bound | A withdraw or expiry in the window: the link lands on the billing page, which shows the live state. Rare — recorded. |
| `group_transfer_complete` | `sendTransferCompleteEmail` :519 | `transferCompleteEmail` | `offerGroupTransfer` immediate path → `handOverGroup` :1893 | A | R | `subscription / <subId>` | — | null | same | bound | Nothing: a hand-back is a new event with its own row. |
| `group_org_removed` | `sendGroupOrgRemovedEmail` :533 | `groupOrgRemovedEmail` | `detachOrgFromGroup` :1167 | A: the org's owner | R | `group_detach / <fresh.id>` | — | detached org | account, detached org default | bound | A re-attach in the window: rare — recorded. The ride-out date is fixed at the detach. |
| `group_org_left` | `sendGroupOrgLeftEmail` :548 | `groupOrgLeftEmail` | same | A: the payer | R | `group_detach / <fresh.id>` | — | detached org | account, remaining org default | bound | As above. |

**Interfaces consumed from waves 1–3** (re-pin each at T0): `enqueueEmail`, `enqueueEmailOnce`, `onceKey` (wave 2),
`expiryWithin`, `dispatchNow`, `recipientLocale` from `@/server/email-outbox`; `deferred` (`lib/deferred.ts`);
`forEachOutboxKind`, `KindScenario`, `dictionarySubject`, `bornAgo`, `REQUEST_ATTEMPT_WAIT_MS` (`_kind-harness.ts`);
`SENDER_ALLOWLIST`, `NOT_YET_MOVED`, `KIND_DIRECT_SENDER`, the allowlist-length rule (`_kind-senders.ts`, as waves 2–3
left it); `SPEC_KINDS`, `SPEC_FACTS` (`outbox-kind-sweep.test.ts`); `SPEC_ACCOUNT_KINDS`, `PRODUCERS`,
`PRODUCERS_PENDING` (`a-kind-body.test.ts`, wave 2 shape); `plantFailingUpdate` (wave 2 `_money-fixtures.ts`);
`stubOutboxEnv` (`__tests__/_invite-mail.ts`). A different merged name wins; record it.

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `db/migration/deltas/V<N>__email_outbox_phase3_wave4.sql` (create) | kind CHECK, 34 kinds | T1 |
| `apps/web/src/server/email-outbox/constants.ts`, `hooks.ts` | `OUTBOX_KINDS` 34, `OUTBOX_KIND_FACTS`, nine `{}` | T1 |
| `apps/web/src/server/email-outbox/__tests__/outbox-schema.test.ts`, `outbox-kind-sweep.test.ts`, `_kind-senders.ts`, `a-kind-body.test.ts`, `no-second-path.test.ts` | lists, scenarios, allowlist | T1–T4 |
| `apps/web/src/lib/email.ts` | nine senders become nine builders | T2–T4 |
| `apps/web/src/server/usecases/officials.ts` | `queueAssignedNotices`, per-official locale | T2 |
| `apps/web/src/server/usecases/schedule.ts` | `moveFixture` change notices | T2 |
| `apps/web/src/server/usecases/discipline.ts`, `scoring.ts` | confirmed, served, `xmin` removal | T3 |
| `apps/web/src/server/usecases/match-reports.ts` | report notice | T3 |
| `apps/web/src/server/usecases/billing-groups.ts` | offer, complete (`inHandover`), removed, left | T4 |
| `apps/web/src/server/usecases/__tests__/_seed.ts` | MOVED seeds: `seedFootballDivision`, `claimPerson`, `makeFixture` (discipline), `makeClaimedOfficial`, `makeAssignment` (reports) | T3 |
| `apps/web/src/server/usecases/__tests__/_money-fixtures.ts` | MOVED seeds: `seedLiveGroup`, `seedCommunityGroup` (billing-group suites) | T4 |
| `officials.test.ts`, `schedule.test.ts`, `withdrawn-winner-walkover.test.ts`, `discipline.test.ts`, `match-reports.test.ts`, `billing-group-offer-notify.test.ts`, `billing-group-transfer-notify-followups.test.ts`, `billing-group-detach-notify.test.ts` (all in `server/usecases/__tests__/`) | repointed to outbox rows; new per-kind tests live here | T2–T4 |
| `scripts/smoke.ts` | one `checkOutboxRow` call | T5 |
| `apps/web/e2e/official-marks-reports.spec.ts`, `e2e/walkthrough/scheduling-officials-handoff.spec.ts`, `e2e/billing-groups-journey.spec.ts` | row assertions | T6 |

---

### Task 0: Preconditions and environment (no commit)

**Files:** none modified. **Produces:** the pinned facts later tasks use, written into the task report.

- [ ] **Step 1: Wave 3 has merged.** `cd /Users/ashokhein/github/seazn.club && git fetch origin && git log --oneline origin/main | grep -ai outbox | head -5`.
  Expected: wave 3's merge on top of wave 2's. Absent → STOP and report.
- [ ] **Step 2: Worktree.** `git -C /Users/ashokhein/github/seazn.club worktree add .claude/worktrees/outbox-p3-w4 -b feat/email-outbox-phase3-w4 origin/main`,
  then `pnpm install --frozen-lockfile` inside it; link `.env.local` per the seazn-local-env skill.
- [ ] **Step 3: Pin `V<N>`** (Global Constraints).
- [ ] **Step 4: Re-pin the consumed interfaces** ("Interfaces consumed") with `grep -an`. Record the four running counts
  (Global Constraints) as found. Expected 25 / 25 / 8 / 26; a difference is recorded, not fixed.
- [ ] **Step 5: Re-pin every producer and test citation in the kind table and P-W4-1..12 by symbol.** Also confirm two
  premises by reading, not grepping: the smoke official at `scripts/smoke.ts:5829-5888` has an email when
  `fixtures[1]` is set (the invite at `:5839` writes `officials.email`, `officials.ts:232`), and `app_user` can read
  `users` inside `withTenant` (precedent `external-play/guard.ts:389`).
- [ ] **Step 6: Mock pre-scan.** `grep -arln 'vi.mock("@/lib/email"' apps/web/src`. For each file whose factory does not
  spread `importOriginal`, record whether it drives a wave-4 producer (`applyOfficialAssignments`,
  `patchFixtureOfficials`, `moveFixture`, `decideSuspension`, `detectSuspensions` or any of its 8 callers,
  `submitMyReport`, `offerGroupTransfer`, `detachOrgFromGroup`). Known: the three named in P-W4-12. The task that
  deletes a sender such a file reaches adds the spread.
- [ ] **Step 7: Env.** `$S up --label outbox-p3-w4`; confirm `show data_directory`.

### Task 1: Vocabulary and schema

**Files:**
- Create `db/migration/deltas/V<N>__email_outbox_phase3_wave4.sql`: one statement in the shape of wave 3's,
  `alter table email_outbox drop constraint email_outbox_kind_valid, add constraint email_outbox_kind_valid check (kind in (<34>))`.
- Modify `email-outbox/constants.ts` (`OUTBOX_KINDS` appends the nine in the spec table's order, as in the kind table
  above; `OUTBOX_KIND_FACTS`), `hooks.ts` (nine `{}`).
- Test: `outbox-schema.test.ts`, `outbox-kind-sweep.test.ts`, `_kind-senders.ts`, `a-kind-body.test.ts`,
  `hooks.test.ts` only if it enumerates kinds.

**Interfaces — produces:** `OUTBOX_KIND_FACTS` additions: literal + transactional for `official_assigned`,
`official_assignment_changed`; account + transactional for `suspension_confirmed`, `suspension_served`,
`match_report_submitted`; account + not transactional for the four group kinds.

- [ ] **Step 1: Write the failing tests.**
  - `outbox-schema.test.ts`: the typed kind list is wave 3's 25 plus the nine; retitle to "… the spec's thirty-four, in
    the spec's wave order"; the live CHECK read (if present) extends the same way.
  - Sweep: `SPEC_KINDS` 34; `SPEC_FACTS` gains the nine from the spec legend (To / Tx columns). The legend test's
    account list gains the seven account kinds, its literal list the two official kinds, its transactional list the
    five T kinds (re-pin the exact lists at T0 and append; never reorder).
  - `_kind-senders.ts`: `NOT_YET_MOVED` = the nine; `KIND_DIRECT_SENDER` gains the nine with their `send*` names.
  - `a-kind-body.test.ts`: `SPEC_ACCOUNT_KINDS` gains the seven; `PRODUCERS_PENDING` = the seven.
- [ ] **Step 2: Run red.** VERIFY the four test files → `t1`: the kind list, legend and declared account kinds fail.
- [ ] **Step 3: Implement** the migration, constants, facts and hooks. Env down/up.
- [ ] **Step 4: Run green** → `t1b`: `failed: 0`; the sweep still reports `checked: 25`; a-kind-body `kindsChecked: 8`.
- [ ] **Step 5: Mutations.** Omit `suspension_served` from the CHECK (env down/up): the schema test fails. Flip
  `group_org_left` to `literal` in facts: the a-kind-body declared-kinds test fails.
- [ ] **Step 6: TSC** (catches a missing `KIND_HOOKS` key), **LINT**, commit
  `feat(email-outbox): wave-4 kinds in the vocabulary`.

### Task 2: The official notices (batch: 2 kinds, 2 commits)

One implementer, one review. Commit after each kind.

**Files:**
- Modify `officials.ts` (`applyOfficialAssignments`, `patchFixtureOfficials`, `assignedNotices`, delete
  `sendAssignedNotices`); `schedule.ts` (`moveFixture`); `lib/email.ts`.
- Test: `officials.test.ts` (factory spreads `importOriginal`; repoint `:541-592`), `schedule.test.ts` (repoint
  `:882-889`), `withdrawn-winner-walkover.test.ts` (R116-4 reads the builder spy), the sweep, `_kind-senders.ts`,
  `no-second-path.test.ts`.

**Interfaces — produces:**
- `queueAssignedNotices(tx: Tx, orgId: string, fresh: FreshAssignment[], ref: (officialId: string) => { refType: string; refId: string }): Promise<string[]>`
  in `officials.ts` (replaces `assignedNotices` + `sendAssignedNotices`). Per official with an email: resolve the
  locale (P-W4-4: `officials.person_id` → `persons.user_id`, then `org.default_locale`), build the labels' `lookup`
  with that locale, `enqueueEmail(tx, { kind: "official_assigned", orgId, to: email, transactional: true, expiresAt: expiryWithin(null), ...ref(officialId), ...await officialAssignedEmail(args, locale) })`.
  Returns the row ids. No row for an official without an email.
- Both producers call it inside their `withTenant` BEFORE `refreshOfficialsCache` (so the rollback test can fail the
  cache write after the enqueue), then `deferred(() => dispatchNow(ids))` after the transaction resolves. The auto path
  computes `seq` first and passes `` (id) => ({ refType: "division_event", refId: `${divisionId}:${seq + 1}:${id}` }) ``;
  the manual path `` (id) => ({ refType: "fixture_official", refId: `${fixtureId}:${id}` }) ``.
- `moveFixture`: the notice select adds `o.id as official_id` and `p.user_id` (`left join persons p on p.id = o.person_id`).
  Inside the transaction, before `appendDivisionEvent`, one `enqueueEmail(tx, …)` per row: kind
  `official_assignment_changed`, `fixture_official / ${fixtureId}:${official_id}:${role_key}`,
  `expiresAt: expiryWithin(nextAt === null ? null : new Date(nextAt))`, label built in the row's locale. The return
  carries ids; `deferred(dispatchNow)` after.

**Steps for `official_assigned`:**
- [ ] **Step 1: Failing tests** (`officials.test.ts`; transport mocked, `stubOutboxEnv()`; the builder is wrapped with an
  `importOriginal` spy to read its args):
  1. `an apply queues one notice per official with an email, listing that official's new fixtures`. Two officials (one
     with email), three fixtures. Expected: 1 row; `official_assigned`, `division_event`,
     `<divisionId>:<seq>:<officialId>`, recipient the email, `recipient_user_id` null, `transactional` true,
     `org_id` the org; subject `dictionarySubject("en", "officialAssigned.subject", { orgName })`;
     `expires_at - created_at` within 1 s of `MAX_EXPIRY_MS`; builder spy `fixtures.length === 2` for that official.
  2. `re-applying the same assignments queues nothing new`: still 1 row, spy 1 call.
  3. `two applies that each add a fixture give two notices`: 2 rows, both live (neither `replaced`).
  4. `a manual set notifies the newly set official, and a re-set keeping them does not`: 1 row with
     `fixture_official / <fixture>:<official>`, then still 1.
  5. `empty: an official with no email gets no row, and the assignment stands`.
  6. `F5: an official's labels and email share the official's language`. Org default `fr`; official A claimed with
     account locale `nl`; official B unclaimed. A: `nl` subject and the label's join word is `schedule.vs` from
     `dictionaries/nl/ui.json` (imported); B: `fr` for both.
  7. `rollback: a failing cache write after the enqueue leaves no notice`. `plantFailingUpdate` on `fixtures` (the
     cache write); `patchFixtureOfficials` rejects; 0 rows; `fixture_officials` unchanged.
  - `withdrawn-winner-walkover.test.ts`: R116-4 reads the withdrawn seat's label from the builder spy's args; its
    expected value stays the dictionary copy.
- [ ] **Step 2: Sweep, scan.** Scenario `official_assigned`: the real `patchFixtureOfficials`, org default `es`,
  `officialAssigned.subject`, `{ orgName }`, firstAttempt `request`. Remove from `NOT_YET_MOVED`; null its
  `KIND_DIRECT_SENDER`; remove `sendOfficialAssignedEmail` from `SENDER_ALLOWLIST` (length follows the rule).
- [ ] **Step 3: Run red** → `t2a`. **Step 4: Implement.** **Step 5: Run green** → `t2a2`: sweep `checked: 26`.
- [ ] **Step 6: Mutations.** Build labels with the org default instead of the official's locale → test 6. Enqueue
  after `refreshOfficialsCache`'s commit point (move it after `withTenant` resolves, on `sql`) → test 7. Drop the
  `fresh` filter (pass every assignment) → test 2.
- [ ] **Step 7: TSC, LINT, commit** `feat(officials): assignment notice through the outbox, in the official's language (F5)`.

**Steps for `official_assignment_changed`:**
- [ ] **Step 8: Failing tests** (`schedule.test.ts`):
  8. `a move queues one change notice per assignment role`. One official holding `referee` and `assistant` on the
     fixture: 2 rows, refs `<fixture>:<official>:referee` / `…:assistant`, both live; `expires_at` = the new kickoff.
  9. `a second move while the first notice waits leaves one notice, the second` (spec). Spy `dispatchNow` as a
     resolved no-op for this test so the first row stays `queued`. After move 2: the first row `replaced`, one live
     row, and the builder's last call has `nextAt` = move 2's time.
  10. `empty: a move that changes neither time nor court, or a declined official, queues nothing`.
  11. `F5: the change notice's label is in the official's language` (as test 6, one official).
- [ ] **Step 9: Sweep, scan.** Scenario: the real `moveFixture`, org default `nl`, `officialChanged.subject`,
  `{ orgName }`, `request`. Lists as Step 2 for `sendOfficialAssignmentChangedEmail`.
- [ ] **Step 10: Run red** → `t2b`. **Step 11: Implement.** **Step 12: Run green** → `t2b2`: sweep `checked: 27`.
- [ ] **Step 13: Mutations.** Ref without the role → test 8 (one live row). Ref with a random suffix → test 9 (two live
  rows).
- [ ] **Step 14: TSC, LINT, commit** `feat(schedule): fixture-move notice through the outbox; a later move supersedes a queued one`.

### Task 3: Discipline and the match report (batch: 3 kinds, 3 commits)

**Files:**
- Modify `discipline.ts`, `scoring.ts` (`refreshDiscipline`), `match-reports.ts`, `lib/email.ts`.
- Move (not write) into `_seed.ts`: `seedFootballDivision`, `claimPerson`, `makeFixture` from `discipline.test.ts`;
  `makeClaimedOfficial`, `makeAssignment` from `match-reports.test.ts`. Both suites import them back.
- Test: `discipline.test.ts`, `match-reports.test.ts`, the sweep, `a-kind-body.test.ts`, `_kind-senders.ts`, the scan.

**Interfaces — produces:**
- `queueSuspensionConfirmed(tx: Tx, suspensionId: string): Promise<string | null>` and
  `queueSuspensionServed(tx: Tx, suspensionId: string): Promise<string | null>` in `discipline.ts`. Each reads, on
  `tx`, `persons.user_id`, `users.email` (`deleted_at is null`), org name and `default_locale`, division name, reason
  (and `matches_total` for confirmed); returns `null` (no row) for an unclaimed person; otherwise
  `enqueueEmailOnce(tx, { kind, refType: "suspension", refId: id, dedupeKey: onceKey(kind, "suspension", id, "confirmed" | "served"), recipientUserId, to, transactional: true, orgId, expiresAt: expiryWithin(null), … })`.
- `decideSuspension`: first select `… for update`; on confirm, after the update, `if (prior === "pending")` call
  `queueSuspensionConfirmed(tx, id)`; after the transaction, `deferred(() => dispatchNow([id]))` when an id came back.
  `emailConfirmed` is deleted.
- `updateServing` calls `queueSuspensionServed(tx, s.id)` when the guarded update returned a row and the status is
  `served`. `detectSuspensions(tx, divisionId): Promise<string[]>` (the flipped ids). After proof (Step 9):
  `ServedFlip`, `xmin` and `notifyServedSuspensions` are deleted, the eight callers drop their notice calls, and
  `activeSuspensionsByEntrant` drops its `deferred`.
- `submitMyReport`: one `sql.begin(tx)`: the existing guarded update `returning`, then, only if it returned a row, the
  render reads on `tx` and per recipient
  `enqueueEmailOnce(tx, { kind: "match_report_submitted", refType: "match_report", refId: report.id, dedupeKey: onceKey(kind, "match_report", report.id, userId), recipientUserId: userId, … })`.
  `bridgeReportSuspensions` stays after the commit, as today. Then `deferred(() => dispatchNow(ids))`.

**Steps for `suspension_confirmed`:**
- [ ] **Step 1: Failing tests** (`discipline.test.ts`; repoint `:592`):
  1. `confirming queues one notice to the claimed player, in their language, from the request`. Account locale `es`:
     one row `suspension / <id>`, `dedupe_key` `<id>:confirmed`, `recipient_user_id` the claimed user,
     `transactional` true; subject `dictionarySubject("es", "suspensionConfirmed.subject", { division })`.
  2. `confirming twice queues one`: two sequential confirms → 1 row; the enqueue spy saw 1 call.
  3. `empty: an unclaimed player's ban is confirmed with no row`.
  4. `D4: no account language → the org's default` (`fr`).
  5. `waive and adjust queue nothing`.
  6. `the confirmed helper called twice for one ban writes one row` (direct `queueSuspensionConfirmed` ×2 in one
     `withTenant`).
- [ ] **Step 2:** sweep scenario (`decideSuspension` confirm, account `es`, `suspensionConfirmed.subject`,
  `{ division }`, `request`); a-kind-body producer (`positive` = the division name); lists for
  `sendSuspensionConfirmedEmail`.
- [ ] **Step 3–5:** red `t3a`, implement, green `t3a2` (sweep 28, body 9).
- [ ] **Step 6: Mutations.** Drop the `prior === "pending"` gate → test 2 (2 spy calls). Fresh once-key suffix per
  call → test 6.
- [ ] **Step 7: TSC, LINT, commit** `feat(discipline): confirmed-suspension notice through the outbox, once per confirmation`.

**Steps for `suspension_served`:**
- [ ] **Step 8: Repoint and add tests.** Every `emailMock.served` count becomes a count of `suspension_served` rows for
  the ban:
  - `:613` and `:654` → one row, `queued`, `attempts` 0, no transport call (W), `dedupe_key` `<id>:served`.
  - the race tests `:821`, `:828` → one row; add an enqueue-spy assertion of exactly 1 call.
  - `:835` ("exactly ONE of two racing passes reports the flip") → the flipped ids are `[banId]`.
  - `:846` (rollback) → 0 rows after the rolled-back pass, 1 after `listSuspensions`.
  - `:866` (entrant chip, caller rolls back / commits) → 0, then 1.
  - `:1009` (waive) and `:1232` (read-only) → 0 rows.
  - new: `the served helper called twice for one ban writes one row`.
  - delete `:887`, `:960`, `:971`, `:991` (P-W4-12), naming each in the report.
- [ ] **Step 9: Implement the enqueue in `updateServing`, run green** → `t3b` (sweep 29, body 10). This is the proof
  the spec asks for before `xmin` goes. Then delete `ServedFlip`, `xmin`, `notifyServedSuspensions` and the eight
  notice calls; VERIFY again → `t3b2`, same totals.
- [ ] **Step 10: Mutations** (one at a time). Drop `and status = 'active'` from the flip update → `:821` fails on the
  spy (2 calls). Fresh once-key suffix → the helper-twice test. Enqueue on `sql` instead of `tx` → `:846` (an orphan
  row after the rollback).
- [ ] **Step 11:** sweep scenario (`refreshDiscipline` on a decided fixture that serves a 1-match ban; org default
  `nl`, account locale null; `suspensionServed.subject`, `{ division }`, `worker`); a-kind-body producer; lists for
  `sendSuspensionServedEmail`. **TSC, LINT, commit**
  `feat(discipline): served notice queued with the flip; the xmin check is gone`.

**Steps for `match_report_submitted`:**
- [ ] **Step 12: Failing tests** (`match-reports.test.ts`; repoint `emailMock.report`):
  12. `a submitted report queues one notice per owner and admin, each in their own language`. Owner locale `fr`, admin
      locale null with org default `es`, a plain member: 2 rows, `dedupe_key` `<reportId>:<userId>`,
      `recipient_user_id` each; subjects `dictionarySubject(<l>, "reportSubmitted.subject", { fixture: "<home> vs <away>" })`.
  13. `a second submit is refused (409) and queues nothing`: still 2 rows.
  14. `empty: a deleted admin gets no row`.
- [ ] **Step 13:** sweep scenario (owner `fr`, `reportSubmitted.subject`, `request`); a-kind-body producer
  (`positive` = the official's name); lists for `sendReportSubmittedEmail`.
- [ ] **Step 14–16:** red `t3c`, implement, green `t3c2` (sweep 30, body 11).
- [ ] **Step 17: Mutations.** A once-key of the report id alone → test 12 (1 row). Drop the `deleted_at` filter →
  test 14.
- [ ] **Step 18: TSC, LINT, commit** `feat(match-reports): report notice to every owner and admin through the outbox`.

### Task 4: The billing-group notices (batch: 4 kinds, 4 commits), and closing the lists

**Files:**
- Modify `billing-groups.ts` (`offerGroupTransfer`, `handOverGroup`, `detachOrgFromGroup`; delete
  `notifyDetachParties`, `notifyTransferOfferRecipient`, `notifyTransferCompleteRecipient`; `notifyContact`,
  `payerDisplayName`, `recipientReachableOrg` take a `db: Tx | typeof sql` and the last also returns
  `default_locale`), `lib/email.ts`.
- Move into `_money-fixtures.ts`: `seedLiveGroup` / `seedLiveGroupTwoOrgs`, `seedCommunityGroup` and the suites'
  `makeUser` (they re-import).
- Test: the three billing-group suites (factories spread `importOriginal`), the sweep, a-kind-body, `_kind-senders.ts`,
  the scan.

**Interfaces — produces:**
- `handOverGroup(target, recipient, newPaymentMethodId, inHandover?: (tx: Tx, row: GroupRow) => Promise<void>): Promise<GroupRow>`;
  the callback runs after the swap, inside the transaction. Only the immediate path passes one, which enqueues
  `group_transfer_complete` and collects its id for `deferred(dispatchNow)` after `finishHandover`.
- Offer: `sql.begin(tx)` around the `setup_intent_id` update, the reads and the `group_transfer_offer` enqueue.
- Detach: the enqueue runs in the detach transaction right after `update organizations set subscription_id`, with the
  branch rule of `notifyDetachParties` unchanged (payer removed another owner's org → `group_org_removed` to the org's
  owner; the org's owner left → `group_org_left` to the payer; the actor owns both → nothing).
- Every row: `transactional: false`, `expiresAt: expiryWithin(null)`, `recipientUserId` the addressee, refs and orgs
  per the kind table, locale per P-W4-11.

**Per kind, the same step cycle** (failing tests → sweep scenario, a-kind-body producer, lists → red → implement →
green → mutation → TSC, LINT, commit). The tests:

- `group_transfer_offer` (`billing-group-offer-notify.test.ts`):
  1. `an offer queues one notice to the recipient, in their language`: recipient locale `es`; one row
     `subscription / <subId>`, `org_id` null, `recipient_user_id` the recipient; `dictionarySubject("es", "transferOffer.subject", {})`.
  2. `a second offer while one is pending is refused (409) and queues nothing`.
  - Delete `:105`, `:125`. Mutation: resolve the locale with `pick: "en"` → test 1. No R1 mutation here: the
    transaction is the update plus the enqueue, with no statement after it to fail, so the reviewer checks the handle
    (recorded in the report). Commit `feat(billing-groups): transfer-offer notice through the outbox, in the recipient's language`.
- `group_transfer_complete` (`billing-group-transfer-notify-followups.test.ts`):
  3. `the handover's notice is queued with it, so a failing Stripe tidy-up afterwards does not lose it`. The community
     group with a `stripe_customer_id`; the mocked `customers.update` rejects once; the call rejects, `owner_user_id`
     is the recipient, and one `group_transfer_complete` row exists.
  4. `empty: a second handover by the old payer is refused and queues nothing`.
  - Delete `:164`. Mutation: run the enqueue after `handOverGroup` resolves (today's position) → test 3. Commit
    `feat(billing-groups): transfer-complete notice queued with the handover`.
- `group_org_removed` (`billing-group-detach-notify.test.ts`, repoint `:103`):
  5. `the payer removing another owner's org queues one notice to that owner, ride-out date in the owner's language`:
     owner locale `fr`; `group_detach / <new subscription id>`; the builder spy's `ridesOutUntil` equals
     `new Intl.DateTimeFormat("fr", { dateStyle: "long" }).format(<group current_period_end>)`.
  6. `rollback: a failing statement after the enqueue leaves no notice and the org in its group`: `plantFailingUpdate`
     on the first table the detach writes after the enqueue (re-pin at T0; today the wallet audit or merge).
  - Delete `:147`. Mutation: enqueue on `sql` → test 6. Commit `feat(billing-groups): org-removed notice queued with the detach`.
- `group_org_left` (same suite, repoint `:118`, `:129`):
  7. `the owner leaving queues one notice to the payer, saying whether the seat was kept`: release → `seatFreed: true`;
     ride-out → `false` (builder spy).
  8. `empty: the actor owns both the org and the group — no row` (repoint `:141`).
  - Mutation: swap the two branches → tests 5 and 7. Commit `feat(billing-groups): org-left notice queued with the detach`.

**Sweep scenarios:** offer (mocked Stripe as the offer suite does; recipient `es`), complete (community group),
removed (owner `fr`), left (payer, remaining org default `nl`); subjects `transferOffer.subject`,
`transferComplete.subject`, `groupOrgRemoved.subject` (`{ orgName }`), `groupOrgLeft.subject` (`{ orgName }`); all
`request`. Producers for a-kind-body with `positive` = the group or org name.

- [ ] **Closing step (after the fourth commit):** delete `NOT_YET_MOVED`'s nine (the list is empty, as wave 1 left it);
  delete `PRODUCERS_PENDING`. VERIFY the sweep, a-kind-body and scan → `t4z`: sweep `checked: 34`, a-kind-body
  `kindsChecked: 15`, allowlist 17. Commit `test(email-outbox): wave-4 sweep closed at 34`.

### Task 5: Smoke

**Files:** `scripts/smoke.ts`.

- [ ] **Step 1:** right after the `fixtures[1]` officials PATCH (`smoke.ts:5888`), add
  `await checkOutboxRow("official_assigned", "fixture_official", `${fixtures[1].id}:${offId}`)`. No new suite, so
  `SELECTABLE_SUITES` and `smoke-select.test.ts` do not change.
- [ ] **Step 2:** typecheck the scripts project with the repo's command; run
  `npx vitest run scripts/__tests__/smoke-select.test.ts` (unchanged, green).
- [ ] **Step 3: Commit** `test(smoke): an officials assignment leaves one settled official_assigned row`. The controller
  pastes the three `official_assigned:` check lines from the PR's smoke job.

### Task 6: E2E (CI dispatch only)

**Files:** `e2e/official-marks-reports.spec.ts`, `e2e/walkthrough/scheduling-officials-handoff.spec.ts`,
`e2e/billing-groups-journey.spec.ts`. Each uses its own `withDb`/`db` helper; no `E2E_PROD_TARGET` skip (C1).

- [ ] **Step 1: Assertions.** CI has no Resend key, so an R row ends `dead`/`no_api_key` with no body.
  - `official-marks-reports.spec.ts:160` (report submitted): one `match_report_submitted` row per owner/admin of the org
    for the report, each with `recipient_user_id` set, not `queued`/`sending`, `body_sealed` null.
  - the walkthrough's apply leg (re-pin near `:681-729`): one `official_assigned` row per official with an email, ref
    type `division_event`, settled, no body.
  - `billing-groups-journey.spec.ts` 13: one `group_transfer_complete` row, `recipient_user_id` = the heir; 07: no
    `group_org_removed`/`group_org_left` row for that detach (the actor owns both).
- [ ] **Step 2: Collect, never run:** `cd <worktree>/apps/web && npx playwright test e2e/official-marks-reports.spec.ts e2e/walkthrough/scheduling-officials-handoff.spec.ts e2e/billing-groups-journey.spec.ts --list; echo EXIT=$?`
  (`EXIT=0`), then TSC.
- [ ] **Step 3: Commit** `test(e2e): wave-4 outbox rows for officials, reports and billing groups`.
- [ ] **Step 4 (controller):** `gh workflow run e2e.yml --ref feat/email-outbox-phase3-w4 -f pr=<n>`. All three files
  are serial: the red count is a floor; re-run after each fix.

### PR checklist (controller)

- Rebase onto `origin/main` (never merge main in); re-pin `V<N>`.
- Scoped VERIFY for every test file touched in T1–T4 green; paste the counts.
- Smoke lines from T5; e2e dispatched (T6).
- G-5: readiness log clean.
- Push, open the PR, hand back; do not poll CI. Merge only on the owner's explicit go.

## Conflict scan

| Pair | Shared | Resolution |
|---|---|---|
| T1 → T2, T3, T4 | `outbox-kind-sweep.test.ts`, `_kind-senders.ts`, `a-kind-body.test.ts` | Sequential. |
| T2, T3, T4 (every pair) | `lib/email.ts`, `no-second-path.test.ts` allowlist length | Sequential. |
| T2 — T3 | none in production; `_seed.ts` (T3 adds moved seeds) | Sequential anyway (lists). |
| T3 internal | `discipline.ts` served change touches 8 callers incl. `scoring.ts` | One implementer. |
| T4 → T6 | journey 13 relies on T4's `inHandover` | T6 after T4. |
| T5 / T6 | `scripts/` vs `e2e/` | Parallel after T4. |
| Peers | W2d or any session editing `officials.ts`, `schedule.ts`, `discipline.ts`, `billing-groups.ts`; migration number | `git log origin/main --oneline -- <file>` at T0 and before the PR. |

**Execution order:** T0, T1, T2, T3, T4, then T5 ∥ T6.

## Owner questions

1. **Q1: Should removing an official cancel their still-queued assignment notice?** The controller expected official
   changes to be a common "changed while queued" case. Measured against the tree: an assignment notice is an R kind,
   sent by the request within about 10 s for up to ~16 officials, and by the next worker tick (about 1.5 min on prod)
   for a larger apply. A move inside that window is handled (the change notice is sent too, and a second move
   supersedes a queued first). An unassignment inside it is not: the official gets a notice for a match that `/me` no
   longer shows.
   - **Recommendation:** do not build it; record it. A cancel would have to restate the remaining fixtures of a
     multi-fixture notice, which is new machinery for a window of seconds to a minute.
   - Owner value: no confusing email in that window. Cost: a restatement path plus its tests, about half a task.
2. **Q2: The assignment notice's expiry.** The spec (§12) says it expires at the fixture's start. An official assigned
   after the match (so they can accept and file a report, or be marked) would then never get it, because the row
   would expire before its first attempt.
   - **Recommendation:** use the 24 h bound for `official_assigned` (P-W4-3); keep the start (`nextAt`) for the move
     notice.
   - Owner value: back-filled assignments still reach the official. Cost: a notice delayed by an outage past kickoff
     can still arrive late (rare).

The controller rules on P-W4-1 to P-W4-12, or puts them to the owner, before T2.

## Rare cases — recorded, not built

1. KEK unset: every action in this wave fails (D1), including read paths that serve a ban (the public strip, the
   division page, the pad bootstrap) (P-W4-5).
2. A provider outage while a row retries: any of the "changed while queued" facts in the kind table can go stale.
3. An official unassigned while their assignment notice is queued (Q1).
4. A move while an assignment notice still waits for the worker: the change notice (sent by the request) can arrive
   before the stale assignment notice.
5. A superseded move notice: the newer one's "Was" names an intermediate time the official may never have seen.
6. A ban re-confirmed through the API from `waived` or `served` gets no confirmed notice, and a second served flip is
   swallowed by the once-key (the UI offers confirm only on pending rows, `discipline-panel.tsx:91-123`).
7. A waive or adjust within seconds of a confirm: the confirmed notice states the old facts.
8. An admin demoted, or an org or division renamed, between a write and its send.
9. A transfer offer whose enqueue is refused after its SetupIntent exists (a misconfigured key, code ahead of V477, or a
   DB fault): the claim stays `pending` and cannot be withdrawn (withdraw finds it by the SetupIntent id, which the
   rolled-back transaction never saved), so new offers on that group are refused until it lapses, up to 7 days. No
   money moves; the same stranded claim was already possible before this wave. Fix if ever needed: release the claim in
   a catch and rethrow, and check `assertOutboxCanQueue()` before the claim.
10. An offer withdrawn, or an org re-attached, within its notice's window.
11. Two concurrent manual sets of one fixture's officials (a pre-existing unique-violation race; unchanged).
12. The last org taken out of a group by an org owner who is not the payer: the group is cancelled and the payer gets
    no notice (`remaining` is null). Pre-existing; owner 2026-10-27: record, do not build (the payer's own org is
    normally in the group, and billing simply stops).
13. An admin added to the org in the milliseconds between a report's submit and the producer's member read gets no
    report notice.

## Next waves and routed findings (not built here)

- a. **Wave 5** is unchanged: the funnel reminder (§9, F6) and the 16 staff alerts on the pool (R2); it deletes `send()`
  and `sendWithResult`, and the allowlist ends empty.
- b. **Routed (pre-existing, product):** only `moveFixture` queues an officials move notice (one call site,
  `schedule.ts:3367`). Whether the bulk schedule apply moves fixtures that already have officials without telling them
  is unverified; route to the officials programme.
- c. **Routed (pre-existing, copy):** `payerDisplayName`'s fallback "The current payer" (`billing-groups.ts:2001`) and
  the report's `"TBD vs"` fixture line (`match-reports.ts:230`) are English inside non-English emails.
- d. **Routed (pre-existing):** `decideSuspension`'s confirm update is unconditional; the API can re-activate a waived or
  served ban. T3 only gates the email on it.
- e. **Phase 4:** every wave-4 body renders at enqueue; every hook is `{}`.

## Self-review

1. **Spec coverage.** The nine kinds map to T2 (assigned, changed), T3 (confirmed, served, report), T4 (offer,
   complete, removed, left). The wave-4 test row: "sweep of 9" → the per-kind scenarios, closed at 34 in T4;
   "a suspension is served exactly once across two concurrent flips" → T3's repointed race suite; "two applies give
   two emails" → T2 test 3; "two moves of one fixture give one" → T2 test 9; E2E → T6 (both named specs, plus the
   journey); smoke → T5; F5 regression → T2 tests 6 and 11. §8's `xmin` row → T3 Step 9. §12 expiry → Global
   Constraints and P-W4-3. D4 → every producer. The migration rule → T1.
2. **Step scan.** Each test names its fixture locale and expected subject key, ref and once-key. Each code step names
   its signature and handle. The one open seam (T4 test 6's failing table) is pinned at T0 by name, not left as "TBD".
3. **Type consistency.** `queueAssignedNotices`, `queueSuspensionConfirmed`, `queueSuspensionServed`,
   `detectSuspensions(tx, divisionId): Promise<string[]>`, `handOverGroup(…, inHandover?)` are spelled the same in
   every task.
4. **Review Focus.** Each of the five lines has its test in its owning task.
5. **Proportion.** Only one-line SQL and call shapes; no bodies. Per the owner's rules there are no key-fault tests,
   and R1 rollback tests exist only where a statement naturally follows the enqueue (T2 test 7, T3 `:846`, T4 test 6).
