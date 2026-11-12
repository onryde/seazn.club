# Quick Match 3: Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** What happens around a quick match over its seven days: the link mail at creation, one reminder before expiry, the sweep that deletes unsaved matches and leaves no orphan, saving one match at a time on sign-in, the account's "Quick matches" list with rename and delete for the saver, and a smoke suite covering create, score and sweep.

**Architecture:** Two outbox kinds on the existing email outbox, enqueued in the same transaction as the row they describe. One cron route gated by the cron secret, scheduled by the in-repo worker. Saving is a single hook that runs before `postAuthLanding` in the three places a verified identity lands, plus a signed-in route the Save button lands on. Nothing moves between orgs.

**Tech Stack:** email outbox (`apps/web/src/server/email-outbox`), `apps/cron-worker/src/schedule.ts` + `wrangler.json`, Next.js route handlers, vitest DB suites, the smoke harness under `scripts/smoke`.

**Spec:** `docs/superpowers/specs/2026-11-03-quick-match-design.md` §7.6, §7.7, §7.8, C1, C2, C3, C9, C13, C15, C21, §9.

**Depends on:** plan 1 (all) and plan 2 Tasks 1, 3, 5 to 8 and 11 (the create route, the home page, the dictionaries and the smoke suite). The per-task order is in Pre-flight amendments → Ordering gates and Batches.

**Repo root for every path below:** the seazn.club checkout (`/Users/ashokhein/github/seazn.club`); TypeScript paths are relative to `apps/web/` unless they start with `apps/cron-worker/`, `db/` or `scripts/`.

**Re-pinned against origin/main 1b224951d4 on 2026-11-07 (drift accepted).** Every change is listed in the Re-pin log at the end.

## Pre-flight amendments (2026-11-08)

This section records the rulings on the 51 non-OK rows of the pre-flight scan (`.superpowers/sdd/2026-11-06-quick-match-3-lifecycle/preflight-scan.md`). The ledger beside the scan, under "Pre-flight rulings (2026-11-08)", has one line per row. Every ruling is **controller (PO rec, autonomous mandate)** (owner, 2026-11-07: "Apply rec if you have questions as a product owner"). **Where this section and a task body below differ, this section wins.** Each task heading carries a pointer back here. Row ids in brackets are the scan's. The spec was amended in the same commit: C19, §7.7, §7.1 point 4 and §11.

### Ordering gates (plan 2 dependencies)

Plan 2's amendments (commit 6c3c024a99) run in batches P2-B1 (T1 ∥ T2 ∥ T3), P2-B2 (T4 ∥ T5), P2-B3 ((T6 → T7 → T8) ∥ T9) and P2-B4 (T10 ∥ T11).

- **G1.** P2-B1 is closed before plan 3 Task 1 starts. Plan 2 T1 owns `i18n-keys.ts`, `quick-match-create.ts` and `lib/quick-match-constants.ts` (where `QUICK_MATCH_ERRORS` now lives). T3 owns `app/api/quick-match/**` and `lib/rate-limit.ts`. Task 1 edits all of these, and its kind-sweep scenario drives T3's route [C11, A12]. Two rules hold while Task 1 is open:
  - no controller key commit for plan 2 may land, because `i18n-keys.ts` is generated and shared;
  - Task 1 may run beside P2-B2 or P2-B3, whose lanes write no dictionary.
- **G2.** P2-B3 is closed before plan 3 Task 5 starts. P2-B2 T5 brings `"/q/"` in `SECRET_PATH_ROUTES`, the `q/[token]` verdict and `routes.quickMatch`, and without that scrub no surface may put the token in `next` [C12, D1]. P2-B3's T6, T7 and T8 all write `home.tsx`, which Task 5 also writes. Task 5's single `e2e/quick-match.spec.ts` line waits until P2-B4's T10 closes.
- **G3.** Plan 2 T11 (the new create → score smoke suite, P2-B4) is closed before plan 3 Task 7, which EXTENDS that suite.
- **G4.** Task 6 adds the saved-list finder to `server/usecases/quick-match-home.ts`, per the ledger carry "never a third token_enc owner". Plan 2 T5 and T9 also write that file, so Task 6 starts only after P2-B3 closes. Tasks 5 and 6 never run concurrently (`ui.json`, `i18n-keys.ts`). No plan 3 task edits a dictionary while a plan 2 lane is open.
- **G5.** No push of `feat/quick-match` while Task 1 or Task 2 has landed and Task 3 has not. Between them, the DB kind sweep and `apps/cron-worker/test/drift.test.ts` are red by name [A2, A3].
- **G6.** Plan 2's own "Pre-flight amendments" govern plan 2's files, and plan 3 adapts to them. Use `routes.quickMatch(token)` for every `/q/` URL, never concatenation. Follow plan 2's refusal pattern: a 303 to the home with `?e=<code>`, rendered as `quickMatch.flash.*`. Never edit plan 2's plan. If a plan 3 task reads fixture order, it uses plan 2 T5's `QuickMatchFixture.seqInRound` (none does today).
- **CI e2e.** Use `gh workflow run e2e.yml --ref feat/quick-match` (no PR number is needed). It is the only e2e run; there is no local Playwright.
- **UI screenshots.** Task 5 and Task 6 are UI dispatches. They invoke the `frontend-design` skill and list as owed the 320, 768 and 1280 screenshots of each changed screen, taken from the CI e2e run's artifacts and served for sign-off on local :8765. No PNG goes into the repo (plan 2 E6, D8).

### Batches (plan 3)

The rules are the same worktree, each implementer committing only its own paths (`git commit -- <paths>`, retrying on `index.lock`), one task review per task, the next batch starting only after the batch's reviews close, and the scoped gate re-run at each boundary. Any shared file puts the tasks in sequence.

- **P3-B1: T4 ∥ T8.** It may start now, beside plan 2's lanes, because neither task touches a plan 2 file or a dictionary.
  - T4 owns `server/usecases/quick-match-save.ts`, the six sign-in route files, `app/api/users/me/route.ts`, `server/email-outbox/cancel.ts`, `lib/analytics-events.ts`, `lib/posthog-server.ts` and its quick-match test, and its own new tests.
  - T8 owns `server/usecases/org-posts.ts` and `org-posts-digest.test.ts`.
  - Before dispatch, confirm that no open plan 2 lane lists any of these paths.
- **P3-B2: T1.** Gated on G1. It owns:
  - `server/email-outbox/{constants,hooks}.ts`, the five kind test files and `_kind-senders.ts`;
  - `V493__quick_match_lifecycle.sql`;
  - `lib/email-templates/{quick-match,index}.ts` and `lib/email.ts`;
  - `emails.json` ×4 and `i18n-keys.ts`;
  - `quick-match-create.ts` with its test, `lib/quick-match-constants.ts` and `app/api/quick-match/route.ts` (it reuses the existing `EMAIL_LIMIT`, so `lib/rate-limit.ts` is unchanged);
  - `quick-match-email.test.ts`.

  T1 is alone because `outbox-kind-sweep.test.ts` is shared with T2.
- **P3-B3: T2 → T3**, one implementer or two in turn.
  - T2 owns `quick-match-sweep.ts`, `app/api/cron/quick-match-expiry/route.ts`, `quick-match-delete.ts`, `outbox-kind-sweep.test.ts` (after T1), `quick-match-sweep.test.ts` and `_quick-match-orphans.ts`.
  - T3 owns `apps/cron-worker/**`.
  - Push only after T3 (G5). Then dispatch the CI e2e run.
- **P3-B4: T5 → T6**, gated on G2 and G4, after P3-B1 (T5 consumes T4) and P3-B3 (T6 consumes T2's delete result and orphan helper). They run in sequence because both write `ui.json` ×4 and `i18n-keys.ts`.
  - T5 owns `app/q/[token]/save/**`, `home.tsx`, `lib/__tests__/scrub-quick-match-next.test.ts` and (only if absent) the bare `qm_` rule in `scrub-score-url.ts`.
  - T6 owns `app/me/page.tsx`, `components/quick-match/my-list.tsx`, `app/api/quick-match/[id]/route.ts` and `quick-match-home.ts`.
- **P3-B5: T7 ∥ P3-B4.** Gated on G3 and P3-B3. T7 owns `scripts/smoke/suites/quickMatch.ts` only, which is disjoint from P3-B4.
- **Close.** Push, run `gh workflow run e2e.yml --ref feat/quick-match`, open the plan-3 PR (smoke runs on PRs only, E3), and run the final review. Merging to main is OWED TO THE OWNER.

### Amend T1 (link mail)

- **Where the enqueue runs [B1, T1].** It goes inside `createQuickMatchTree`'s last `withTenant(QUICK_MATCH_SYSTEM_ORG_ID)` transaction (`quick-match-create.ts:158-179`), right after the `quick_matches` insert. It does NOT go in `createQuickMatch`, which opens no transaction. The tree's ctx gains `baseUrl?: string`. The email is already on the input and the token is `ctx.home`'s plaintext. `CreatedQuickMatch` (`:49-60`) gains `outboxRowId: string | null`, returned from the tree upward. The route calls `dispatchNow([outboxRowId])` after the call returns, and only when the id is non-null.
- **`baseUrl` is optional [A12, B2].** `createQuickMatch`'s ctx gains `baseUrl?: string`, so 19 of the 20 call sites stay as they are. An email with no `baseUrl` is a programmer error and must never silently send no mail. It throws `HttpError(500, …, QUICK_MATCH_ERRORS.BASE_URL_MISSING)` at step 0, before any write, and a test reaches it. The new code `"QUICK_MATCH_BASE_URL_MISSING"` goes in `lib/quick-match-constants.ts`, where plan 2 T1 moved `QUICK_MATCH_ERRORS`. Plan 2's form maps an unmapped code to `errors.generic`. The one existing caller that passes an email, `quick-match-create.test.ts:373`, gains `baseUrl`.
- **Send limit [B4].** The guest-typed name stays in the subject, bounded by the limits below. When `email` is non-null, the route also takes a second, separate bucket: `rateLimit("quick-match-email:" + ip, EMAIL_LIMIT)` (`lib/rate-limit.ts:60,96`; 5 per 300 s). It runs after plan 2's `QUICK_MATCH_CREATE_LIMIT` and before any DB touch. Plan 2's create limit (20 per 10 min, fail-open) is too loose for mail to addresses a stranger typed. `EMAIL_LIMIT` is fail-closed, as is the house rule for every mail-sending endpoint, so during a limiter outage only emailed creates refuse. Its 429 carries no code, and plan 2's form maps that to `errors.rateLimited`. Tests:
  - a sixth emailed create inside the window is refused and writes no `quick_matches` row;
  - an emailless create in the same window passes.
- **Reminder arguments [D4, B12].** Defined here, so Task 2 never reopens Task 1's template files. `QuickMatchEmailArgs { name; link; expiresAt }` serves the link mail. `QuickMatchReminderArgs extends QuickMatchEmailArgs { saveLink: string }` serves the reminder. The reminder has two buttons: the home link, and "Save it" to `${baseUrl}/q/<token>/save`, which is a path and never a query. New `emails.json` keys go in all 4 locales (`quickMatchReminder.save` = "Save it", plus the subject and body keys). Then run `npm run i18n:gen-keys` and `npm run i18n:check`.
- **The by-email index [B20].** The migration also creates `create index quick_matches_unsaved_email_idx on quick_matches (lower(email)) where saved_by_user_id is null and email is not null;`, because Task 4's by-email save runs on every verified sign-in, site-wide. This index does NOT go into V492, because the `qm` env and the parallel plan-2 databases have already applied V492, and editing it would break Flyway's checksum. The file is renamed `db/migration/deltas/V493__quick_match_lifecycle.sql`, still a working number (E4). The `constants.ts:5-7` header names that file.
- **Ref type [C3].** Import `QUICK_MATCH_OUTBOX_REF_TYPE` (`quick-match-delete.ts:15`). Never write the literal.
- **Expected red [A2].** Step 4's run of `outbox-kind-sweep.test.ts` is expected to fail, and only with `no scenario for outbox kind quick_match_reminder`. Record that red in the report. Tasks 1 and 2 share one green gate at the end of Task 2 (G5).
- **Smoke address [A8].** The kind-sweep scenario and any smoke use `delivered+qm_${tag}@resend.dev`.

### Amend T2 (reminder and sweep)

- **Report shape [B11, D6, B9, B10].**
  - `export interface QuickMatchSweepReport { checked; rearmed; reminded; expired; orphans; failed; deferred }`, all `number`.
  - `sweepQuickMatches(opts: { baseUrl: string; now?: Date; onlyIds?: readonly string[]; _failDeleteForTests?: (competitionId: string) => boolean })`.
  - `onlyIds` is test-only. It restricts every step to rows whose `quick_matches.id` or `competitions.id` is in the list, after the `grantMonthlyForAllWallets({ walletIds })` precedent (`lib/credits.ts:453-467`). The route never reads it from the request.
  - Each step selects at most `QUICK_MATCH_SWEEP_LIMIT = 200` rows (exported). Rows past the limit add to `deferred`, which is not a failure: the next hourly firing reaches them.
  - A per-row throw adds to `failed`, is logged with the id and the error code (never the token or the email), and never stops the other rows.
  - The route answers the report. It imports the type from `@/server/usecases/quick-match-sweep` itself, because `drift.test.ts:53-72` reads only the route's direct `@/` imports for a `failed: number` (precedent `api/cron/external-play/route.ts:5-7`).
- **Step 0: orphans [D5, B7, ledger D1].** Before re-arm, the sweep finds system-org competitions that have no `quick_matches` row and `created_at < now - interval '1 hour'`, and calls `hardDeleteQuickMatchCompetition` on each. Each one counts in `orphans` only when the call answers `deleted: true`. Tests:
  - A quick match whose `quick_matches` row was deleted by SQL, with its competition's `created_at` set 2 h back, is gone after the sweep.
  - The same shape aged 59 minutes survives.
- **Delete result [C1, D7, A4].** `hardDeleteQuickMatchCompetition(competitionId): Promise<{ deleted: boolean }>`, where `deleted` means the competitions delete removed at least one row. The plan-1 void callers ignore it. `expired` and `orphans` count only `deleted: true`. A test deletes the same id twice and expects `{ deleted: false }` the second time.
- **The org filters [C2].** The sweep test seeds a foreign-org competition by SQL, with a `quick_matches` row and an outbox row by ref. `hardDeleteQuickMatchCompetition` of that competition must leave all three. Mutate once each, one at a time: the `org_id` filter at `quick-match-delete.ts:25`, then the one at `:30`. Both mutations must red. If the schema refuses that shape, cite the constraint as the guard in the test instead.
- **Per-id assertions [B8, D6, A16].** Every sweep test passes `onlyIds` with its own ids and asserts per id. A run-wide count is asserted only as `>=`. "A second sweep reminds 0" becomes: a second sweep over the same `onlyIds` answers `reminded: 0`, and exactly one `quick_match_reminder` row exists for that ref. The kind-sweep scenario POSTs the real route with no `onlyIds` and asserts only its own ref's row.
- **The failing row.** With `_failDeleteForTests` set for one row, the sweep answers `failed: 1` and the other row is deleted. Then remove the `failed++` and confirm the test reds.
- **The orphan helper [A5].** It lives in `src/server/usecases/__tests__/_quick-match-orphans.ts`, exporting `idsOf(qm)` and `expectNoOrphans(ids)`, which fails on zero and prints its table and row counts. Task 6 imports it.
- **Two sports [E8].** The orphan test runs `it.each` over badminton and football (the team sport offered, with the widest fixture-side tables). Each prints its own count. Zero fails.
- **The re-arm backstop [D8, B13].** The re-arm also sets `email = null`. Once a saver is soft-deleted, the address cannot be compared any more, so the row loses it and gets no reminder. Task 4's account-deletion step is the primary path.
- **Mutations, one at a time,** on top of Step 5:
  - change the orphan threshold to `< now()`: the 59-minute test must red;
  - drop the `failed` count: the failing-row test must red.

### Amend T3 (schedule)

- **The row [B9, D6].** It gains `failureCounts: ["data.failed"]`, and `deferred` is not a failure.
  - `apps/cron-worker/test/drift.test.ts:74` moves `toBe(12)` to `toBe(13)`, with "+ quick-match-expiry's data.failed" added to its comment.
  - The `withCounts` map in `apps/cron-worker/test/schedule.test.ts:402-419` gains `"quick-match-expiry": ["data.failed"]`, commented as its siblings are.
- **Pins.** Use the drift table at the end of this section.
- **Order [A3].** This task runs right after Task 2, in the same batch. Push only after it lands (G5).

### Amend T4 (save on sign-in)

- **Six sign-in points [D3, B18].** `saveQuickMatchesForVerifiedUser(userId)` runs after `createSession` and before the route's landing or redirect, at all six:
  - `api/auth/verify-email/route.ts:44`
  - `api/auth/magic-link/consume/route.ts:32`
  - `api/auth/google/callback/route.ts:117`
  - `api/funnel/claim/route.ts:63`
  - `api/invites/[token]/claim/route.ts:31`
  - `api/claims/[token]/accept/route.ts:57`

  It never runs in `app/admin/impersonate/page.tsx:32`. The helper never throws past the route (it logs and continues).
- **The sign-in scan test [D3].** `src/server/usecases/__tests__/quick-match-save-doors.test.ts`, a source scan with no DB:
  - Every non-test file under `src/app` that imports `createSession` from `"@/lib/auth"` must call `saveQuickMatchesForVerifiedUser`, except under `app/admin/`.
  - It keys on the import source: `api/v1/fixtures/[id]/stream-sessions/route.ts` calls a different `createSession` (`@/server/usecases/stream-sessions`).
  - Strip comments first (`drift.test.ts` `stripComments`).
  - Assert at least 6 sign-in routes checked (anti-vacuity), and that the impersonation page does NOT call the helper.
- **Verified only [B19].** The helper reads `users.email_verified` (and `deleted_at is null`) and does nothing when the email is unverified. A test with an unverified user who owns a matching row expects `savedByEmail: 0`.
- **Alive only [C10, D13].** The by-email SQL adds `and (expires_at is null or expires_at > now())`. A test: an expired, unswept row with a matching email stays unsaved.
- **One save SQL [D9, A7].**
  - Both paths, `saveQuickMatchesForVerifiedUser` and `saveQuickMatchForUser`, go through one internal function. It sets `saved_by_user_id`, `expires_at = null` and `reminder_sent_at = coalesce(reminder_sent_at, now())`.
  - The same function cancels any queued `quick_match_reminder` for the saved ids with `cancelQueuedEmails(tx, { kind: "quick_match_reminder", refType: QUICK_MATCH_OUTBOX_REF_TYPE, refIds, reason: QUICK_MATCH_SAVED_REASON })`.
  - The new reason `QUICK_MATCH_SAVED_REASON = "quick_match_saved"` is added to `CANCELLED_REASONS` (`server/email-outbox/cancel.ts:34-39`).
  - **The cancel must run on a `withTenant(QUICK_MATCH_SYSTEM_ORG_ID)` handle.** On the pooled client it ends only org-less rows (`cancel.ts:55-57`), so it would silently end nothing. Run the whole save in that one tenant transaction.
  - Test: after either save path, a queued reminder for the match ends `cancelled` with that reason.
- **The single save's answers.** `saveQuickMatchForUser(userId, quickMatchId)` returns `"saved" | "already_yours" | "taken" | "gone"`. `"gone"` means the row is missing, or expired and unswept (C9 alive rule).
- **Account deletion [D8, B13].** `releaseQuickMatchesOfDeletedAccount(tx, { userId, email })` lives in `quick-match-save.ts`. `DELETE /api/users/me` calls it inside its own transaction, beside `anonymiseAccountEmails` (`app/api/users/me/route.ts:179`), before the users update, while the real address is still known. It:
  - un-saves the account's rows (`saved_by_user_id = null`, `expires_at = last_activity_at + interval '7 days'`);
  - nulls `email` on every row whose `lower(email)` equals the account's address.

  The test goes in `src/app/api/users/me/__tests__/account-deletion-quick-match.test.ts`: a saved row is re-armed, a row typed with the address loses it, and another user's saved row is untouched.
- **Analytics [D10].**
  - `EVENTS.QUICK_MATCH_SAVED = "quick_match_saved"` goes in `lib/analytics-events.ts` beside `:93`.
  - It fires once per saved row from the save function, with `{ quick_match_id, via: "button" | "email" }` and no email, token or name, on the system org as `QUICK_MATCH_CREATED` does (`quick-match-create.ts:261-267`).
  - `lib/posthog-server.ts:46` lets through a set `{ QUICK_MATCH_CREATED, QUICK_MATCH_SAVED }`.
  - `lib/__tests__/posthog-server-quick-match.test.ts` gains: saved passes, and an organizer event is still dropped.
- **Mutations, one at a time [E7]:**
  - remove `saved_by_user_id is null` (Review Focus 4 must red);
  - remove the `email_verified` gate;
  - remove the expiry predicate;
  - delete one sign-in route's call (the scan test must red);
  - run the cancel on the pool (the cancel test must red).

### Amend T5 (Save button and its landing)

- **Two paths [D2, B22].** Next forbids a `page.tsx` and a `route.ts` in one segment, so the save uses two paths.
  - `src/app/q/[token]/save/page.tsx` (GET) **never writes**:
    - an unknown or expired token shows plan 2's dead screen (`qm-dead-link`, `quickMatch.dead.*`);
    - signed in and already yours redirects to `routes.quickMatch(token)`;
    - saved by someone else shows `quickMatch.flash.taken` with `quickMatch.save.backHome`;
    - anything else shows a one-button confirm page: the match name in `quickMatch.save.title`, then `quickMatch.save.hint`, then a `<form method="post" action={routes.quickMatch(token) + "/save/confirm"}>` button labelled `quickMatch.home.save`.

    The page has `robots: { index: false }` and its locale comes from `resolveLocale()` with no `orgDefault` (plan 2 T5).
  - `src/app/q/[token]/save/confirm/route.ts` exports POST only:
    - an `Origin` that does not match the host gets 403, because `proxy.ts:145` checks only `/api/` paths;
    - signed out gets 303 to `/login?next=/q/<token>/save`;
    - signed in calls `saveQuickMatchForUser`. `saved` or `already_yours` gets 303 home. `taken` gets 303 home with `?e=taken`, rendered through plan 2's flash mapping as `quickMatch.flash.taken`. `gone` gets 303 home, which renders the dead screen. That is plan 2's refusal pattern (G6).
  - The home's Save button is that same form. It goes in the actions row that plan 2 D13 left without Save. When `savedByUserId` is the current user, the home shows `quickMatch.home.saved` instead. When it is someone else, the home shows nothing. The reminder's "Save it" opens the GET page.
- **The `next` scrub [D1, B23].** Token-in-`next` is the only exception to C19, amended.
  - New test file `src/lib/__tests__/scrub-quick-match-next.test.ts` uses real tokens from plan 1's `mintHomeToken()`.
  - Cases: `/login?next=` with `/q/<token>/save` encoded 1, 2 and 3 times, plus the magic-link consume URL that carries that `next`.
  - Each scrubbed output contains no token substring. The test reports how many cases it checked, at least 4, and zero checked fails.
  - Also assert that a signed-in visitor at `/login?next=/q/<token>/save` lands on the save page.
- **A bare `qm_` rule [E9].** If plan 2 Task 5 did not add a bare `qm_` rule beside the `dl_` one in `scrub-score-url.ts`, this task adds it, with a test. Check the tree first, and never add it twice.
- **Copy [B24, D11, A10].** These `ui.json` keys go in all 4 locales:
  - `quickMatch.home.saved` = "Saved"
  - `quickMatch.flash.taken` = "Someone else has already saved this match."
  - `quickMatch.save.title` = "Keep {name} in your account?"
  - `quickMatch.save.hint` = "It stays until you delete it. Anyone with the link can still score."
  - `quickMatch.save.backHome` = "Back to the match"

  Then run `npm run i18n:gen-keys` and `npm run i18n:check`.
- **Painters [B25].** The save form, the confirm page and the home form carry `ph-no-capture`. Plan 2 T5's painter-file assertion gains `save/page.tsx`. Step 4 also runs `scrub-secret-painters.test.ts` and `scrub-path-secrets.test.ts`. The `q/[token]` verdict covers both new subroutes [C12].
- **Tests.** `src/app/q/[token]/__tests__/save-route.test.ts` and `save-page.test.tsx` cover:
  - GET never writes (signed in, unsaved row: the row is unchanged after the GET);
  - POST signed out, signed in, taken, gone, and cross-origin.
- **Mutations, one at a time [E7]:**
  - the taken branch saves anyway;
  - the Origin check is removed;
  - the GET page calls the save.
- **Widths.** The save page and the home's "Saved" state must show no horizontal scroll at 320, 768 and 1280.
  - Add `expectNoHorizontalScroll` on `/q/<token>/save` to plan 2's `e2e/quick-match.spec.ts`. That file has been free since P2-B4 closed.
  - The screenshots are owed from the CI run (see "UI screenshots" above).

### Amend T6 (account list, rename, delete)

- **Not found [B28].** "Not yours" and "no such id" both answer 404. A second DELETE answers 404, and so does a PATCH after a delete. Both cases are tested.
- **Rename [D14, B27].** One transaction of plain UPDATEs renames:
  - `quick_matches.name`;
  - `competitions.name`;
  - `divisions.name` (copied at `quick-match-create.ts:143-144`);
  - the stage's name where `quickMatchStageInput` copied it (`:149`).

  The slug never changes. The body is validated by `CreateQuickMatch.shape.name` (trimmed, 1 to 80; `server/api-v1/schemas.ts:6726`). A refusal is a 422 with the `quickMatch.me.renameInvalid` copy in all 4 locales. Tests: all four names change, no `slug_history` row appears, and 81 characters or whitespace only are refused.
- **A row without a link [B29].** `listMyQuickMatches` lives in `quick-match-home.ts` (ledger carry, G4). It catches `openHomeToken`'s 503 per row and returns `url: null`, so the type becomes `url: string | null`, and that row renders with no link. A test runs with no KEK.
- **The `/me` section [B26].**
  - The empty case comes first: with no saved matches there is no section and no heading.
  - The section goes into the second `Promise.all` (`app/me/page.tsx:66-89`).
  - Screenshots at 320, 768 and 1280 are owed from the CI run.
  - The `/me` e2e specs (`me-career.spec.ts`, `player-accounts.spec.ts`, `mobile.spec.ts`'s `/me` row) run in CI via `gh workflow run e2e.yml --ref feat/quick-match`, never a local run.
- **Painters [B25].** The list's links come from `routes.quickMatch` and carry `ph-no-capture`. Plan 2 T5's painter-file assertion gains `my-list.tsx`. Step 4 runs `scrub-secret-painters.test.ts`.
- **Orphans [A5].** The delete's orphan check imports `_quick-match-orphans.ts` (Task 2).
- **Mutations, one at a time [E7]:**
  - remove PATCH's saver check;
  - remove DELETE's saver check;
  - remove the rename bound.

### Amend T7 (smoke)

- **Extend, do not create (plan 2 amendment D9, new plan 2 T11).** Plan 2 T11 already creates `scripts/smoke/suites/quickMatch.ts` (`quickMatchSuite`), registers it in `scripts/smoke/index.ts` `SELECTABLE_SUITES` and in `main.ts` after `funnelReminder`, and runs create → home "0 of 1" → Score → one rally → home Live with cleanup in `finally`.
  - Task 7 modifies only `scripts/smoke/suites/quickMatch.ts`. After the Live check it POSTs `/api/cron/quick-match-expiry` with `CRON_SECRET` (skipping with a passing line when that is absent, as `funnelReminder.ts:18-25` does), checks the answer carries a numeric `failed` and `deferred`, and checks that the suite's own row survives. Its `finally` keeps T11's cleanup, with the outbox rows by ref added if T11 sent no email.
  - Task 7 does not touch `index.ts` or `main.ts`. The Files lines for them in the task body below are void.
- **Proof.** The PR's smoke run is the proof. There is no local run against stg without the owner's go (plan 2 T11), so Step 2's stg run below is replaced by the PR run.
- **One sport [E8].** The suite header states why it uses one sport: smoke proves the route is alive, while Task 2's orphan test proves the cascade closure over two sports.
- **Address [A8].** Use no email, or `delivered+qm_${tag}@resend.dev`.
- **Never prod [A9].** The sweep leg sweeps every quick match on its target. Never point it at prod.
- **Gate.** G3.

### Amend T8 (new): the weekly news digest excludes the system org [E1]

- **Files:** `src/server/usecases/org-posts.ts` (`sweepWeeklyDigests`'s candidate query, the two `select f.org_id` arms at `:1770-1782`), plus its test in `src/server/usecases/__tests__/org-posts-digest.test.ts`.
- **Change:** both arms add `and f.org_id <> ${QUICK_MATCH_SYSTEM_ORG_ID}`.
- **Test.** The system org, with fresh fixture activity, is never a candidate, while a control org with the same activity is one.
  - Assert at the candidate selection, not through `news.auto`. If the candidate list is not separately readable, extract it as an exported function in the same file.
  - The test reports how many orgs it checked.
  - Mutation: drop the predicate, and the test must red.
- **Billing grant [D12].** No code. The system org's 5 AI credits a month are accepted (spec §7.1 point 4, corrected).

### Re-pin drift (2026-11-08)

Pins drifted since 2026-11-07. Use the right column.

| Plan pin | Now |
|---|---|
| `lib/auth.ts:92` getCurrentUser | `:97` |
| `lib/auth.ts:434` / `:434-450` safeNextPath | `:439` / `:439-455` |
| `lib/auth.ts:458` / `:462-471` postAuthLanding | `:463` / `:467-476` |
| `api/auth/magic-link/route.ts:76,84` | `:82` (`nextQuery`), `:90` (link) |
| `lib/email.ts:9-62` template imports | `:9-70` |
| `app/me/page.tsx:54-89` one `Promise.all` | two: `:50-53` and `:66-89` |
| `google/callback/route.ts:163` "sets email_verified" | `:160-167`, link branch only; by-sub `:134-144` sets nothing (hence the B19 gate) |
| `run.test.ts:76-91,133-138,140-153,170-178` | `:75-91,134-139,141-153,171-183` |
| `index.test.ts:33-52` | `:34-41`, `:43-52` |
| `schedule.test.ts:76-85` | `:76-86` |
| `outbox-schema.test.ts:72`, `:246-261` | `:69-72`, `:260` |
| `outbox-kind-sweep.test.ts:472`, `:2192` | `:469-473`, `:2191-2192` |

## Global Constraints

- Plan 1's Global Constraints apply in full.
- **Outbox kinds** are typed in three code places plus the DB check, and five test files pin them (a missed one reds in CI only). Code: `src/server/email-outbox/constants.ts:9-65` (`OUTBOX_KINDS`) and `:80-132` (`OUTBOX_KIND_FACTS`), `src/server/email-outbox/hooks.ts:42-94` (`KIND_HOOKS`; the `Record<OutboxKind, …>` types make a missing entry a tsc error in all three). DB: the `email_outbox_kind_valid` CHECK, last redefined in `db/migration/deltas/V478__email_outbox_phase3_wave5.sql:20-33` (51 kinds; `constants.ts:5-7` names that file). Tests, all under `src/server/email-outbox/__tests__/`:
  - `outbox-schema.test.ts:47-61` (`SPEC_KINDS`), `:72` (count 51), `:246-261` (the live CHECK read back against it);
  - `outbox-kind-sweep.test.ts:297-352` (`SPEC_KINDS`), `:356-411` (`SPEC_FACTS`), `:472` (count 51), `:475-579` (the legend: TWENTY literal kinds, THIRTY-TWO transactional), `:2133-2188` (one real-producer scenario per kind) and `:2192` (51 swept);
  - `enqueue-once.test.ts:50-102` (`SPEC_LEGEND`) and `:163` (51);
  - `_kind-senders.ts:49-106` (`KIND_DIRECT_SENDER`) and `:111-114` (`allowlistLengthFor`, asserted 0 by `no-second-path.test.ts:104-107` and `outbox-kind-sweep.test.ts:635`);
  - `a-kind-body.test.ts:88` (`SPEC_ACCOUNT_KINDS`) does not change: both new kinds are literal.
- **The tenant may only enqueue for its own org** (`V470__email_outbox.sql:18-22,119-123`: `app_user` holds INSERT only, `with check (org_id = current_org_id())`; an org-less row can only be written by the privileged role). Both kinds are therefore written with `orgId: QUICK_MATCH_SYSTEM_ORG_ID`: the link inside `createQuickMatch`'s `withTenant(SYSTEM_ORG)` transaction, where `orgId: null` is refused, and the reminder on the privileged pool, so one rule covers both.
- **Mail content** (§7.6): the link and the friendly name only; no marketing copy. Keys are flat (`"funnelReminder.subject"` shape) in `src/dictionaries/{en,fr,es,nl}/emails.json`. `src/lib/i18n-keys.ts` is GENERATED (`:1-2`): run `npm run i18n:gen-keys` after adding the en keys, never edit it by hand; then `npm run i18n:check`.
- **Cron** (§7.8): a row in `apps/cron-worker/src/schedule.ts` `JOBS` (`:64`) with `trigger: TRIGGER_CRON` (`:42`, `"17 * * * *"`, hourly). That trigger is already registered in both envs (`apps/cron-worker/wrangler.json:24,29`), so `wrangler.json` does not change; `test/drift.test.ts:93-96` pins the two. The route gates on the secret exactly as `api/cron/email-outbox/route.ts:23-26` (503 with no `CRON_SECRET` before 401 on a mismatch) and, because the reminder carries a link, takes `req` and builds its base URL the way `api/funnel/remind/route.ts:23-28,64` does (`baseUrl(req)`, `src/lib/oauth.ts:35`). Any route under `/api/cron/` is cron-shaped to `test/drift.test.ts:32-35` ("every cron-shaped route has exactly one schedule row"), so the route (Task 2) is red there until its row (Task 3) lands.
- **Expiry** (C1): `expires_at = last_activity_at + 7 days`; saved rows have `expires_at null`. **Reminder** (C2): once, when `expires_at - now <= 24h`, only when `email` is set, tracked by `reminder_sent_at`.
- **Saving** (O8, C3, C13): one match at a time; by email only rows whose `lower(email) = lower(user email)` and `saved_by_user_id is null`; rename and delete only by the saver; the link keeps scoring after a save.
- **Account deletion is a soft delete** on main: `DELETE /api/users/me` anonymises the row and stamps `deleted_at` and `purge_after` (`src/app/api/users/me/route.ts:182-191`), and nothing on main ever hard-deletes a `users` row (no reader of `purge_after`). So `quick_matches.saved_by_user_id`'s `on delete set null` (plan 1 Task 1) does not fire when a saver deletes their account; the sweep handles it (Task 2, Review Focus 3).
- **Hard delete** (§7.8): `hardDeleteQuickMatchCompetition` from plan 1 Task 5 deletes the outbox rows by ref, the `quick_matches` row and the competition; the database cascades the rest. The orphan test sweeps the closure below plus the keyless list, and reports how many tables and rows it checked (zero is a failure).

### Hard-delete closure on origin/main 1b224951d4

Read from `pg_constraint` of a database migrated to V491 (recursive over `on delete cascade` from `competitions`), each edge pinned to the line that defines it on main. `V` numbers are `db/migration/**/V<n>__*.sql`.

- **competitions →** CASCADE: `divisions` (V209:3), `competition_events` (V208:5), `api_keys` (V265:8), `competition_passes` (V271:7), `pass_credit_redemptions` (V335:30), `registration_groups` (V363:52), `sponsors` (V283:12), `sponsor_packages` (V283:40); SET NULL: `org_posts.competition_id` (V295:20). `competitions.frozen_at` (V489:47) rides the row; the system org's `competitions.max_active` is unlimited, so the freeze never applies to it.
- **divisions →** CASCADE: `stages` (V210:3), `entrants` (V212:6), `schedule_settings` (V219:5), `division_events` (V220:3), `registration_settings` (V223:8), `registrations` (V223:25), `division_checkpoints` (V244:24), `player_stat_snapshots` (V248:7), `player_stat_folds` (V409:29), `discipline_rules` (V293:15), `suspensions` (V293:25), `event_imports` (V376:36), `import_locks` (V376:108), `imports.pin_division_id` (V242:38); SET NULL: `org_posts.division_id` (V295:21).
- **stages →** CASCADE: `pools` (V211:3), `fixtures` (V214:6), `standings_snapshots` (V218:5), `stage_seed_proposals` (V360:34), `stage_round_court_tags` (V375:72), `stage_round_opens` (V451:85), `stage_lots_draws` (V475:79); SET NULL: `entrants.swiss_first_round_stage_id` (V487:25-26).
- **entrants →** CASCADE: `entrant_members` (V213:2), `lineups` (V215:3); SET NULL: `fixtures.home_entrant_id`/`away_entrant_id` (V214:12-13), `officials.entrant_id` (V243:12), `registrations.entrant_id` (V223:43), `suspensions.entrant_id` (V293:27).
- **pools →** SET NULL: `fixtures.pool_id` (V214:9), `officials.home_pool_id` (V243:15).
- **fixtures →** CASCADE: `score_events` (V216:6), `lineups` (V215:2), `match_states` (V217:2), `device_links` (V222:9), `fixture_officials` (V243:23), `fixture_availability` (V276:37), `official_marks` (V294:31), `match_reports` (V294:45), `event_imports.fixture_id` (V376:38), `fixture_stream_codes` (V430:46), `fixture_stream_settings` (V430:69), `capture_records` (V437:19), `fixture_external_play` (V451:93), `fixture_video_meetings` (V451:250), `fixture_play_flags` (V451:298), `online_chess_audit` (V451:331), `fixture_seat_asks` (V458:25), `fixture_seat_line` (V461:36), `youtube_broadcasts` (V479:176), `fixture_calls` (Match Day, V484:20), `fixtures.parent_fixture_id` (V214:18); SET NULL: `winner_to_fixture`/`loser_to_fixture` (V214:14,16), `fixture_stream_sessions.fixture_id` (V410:113), `suspensions.fixture_id` (V293:38).
- **Second level, CASCADE:** `registrations.group_id` (V364:53); `registration_players` (V363:139, V388:87); `official_marks`/`match_reports` by `fixture_official_id` (V294:29,43); `fixture_stream_pairings` (V430:81) → `fixture_stream_phone_beats` (V430:149); `capture_records.code_id` (V437:20) → `capture_record_sessions` (V437:45); `fixture_video_participants`/`fixture_video_guard_faults` (V459:77,88). **Second level, SET NULL:** `score_events.device_link_id` (V222:22), `sponsor_orders.sponsor_id` (V283:72), `fixture_stream_sessions.code_id`/`pairing_id`/`youtube_broadcast_id` (V430:108-109, V479:278).
- **Clauses that could refuse the delete, none reachable by a guest:** `sponsor_orders.package_id` RESTRICT (V299:15-17; guests have no sponsors); `fixture_external_play.round_open_id` RESTRICT → `stage_round_opens` (V451:133; online chess only, opened by `server/usecases/external-play/open-round.ts:384`, and the system org never offers online chess); `score_events.voids_event_id` (V216:13) and `fixture_stream_pairings.replaced_by` (V430:97) are NO ACTION self-references inside one fixture's cascade, checked at statement end.
- **One delete trigger** in the closure: `fixture_video_meetings_park_room` parks a row in `video_rooms_to_end` (V460:29-44). Guests never have a video meeting.
- **Keyless: no foreign key reaches these.** `email_outbox` by `ref_type`/`ref_id` (V470:38-39) and `quick_matches` are deleted by `hardDeleteQuickMatchCompetition` itself. `slug_history.entity_id` (V263:16) is written only by a slug-regenerating rename (`server/usecases/competitions.ts:662-664`, `server/usecases/slugs.ts:124`), which Task 6's rename deliberately avoids. Never written for a guest: `fixture_stream_sessions.competition_id`/`division_id` (V410:200-201), `capture_records.competition_id` (V437:18), `pass_mint_refusals.competition_id` (V342:39), `video_rooms_to_end.fixture_id` (V460:31), `org_addons.target_competition_id` (V323:27), `ai_parse_previews.division_ids` (V346:27), `stream_provider_calls.subject_id`, `staff_audit_log.target_id` (staff audit is retained by design). The orphan test asserts every one of them anyway.

## Review Focus

1. **A reminder for a match whose email was mistyped as someone else's.** Expected: the mail still goes (the address was given), but it carries only the link and the name, and the recipient can delete the match once signed in (C13); the test for the rename/delete routes covers the delete by a saver who never created it. (Task 6)
2. **The sweep runs while a match is being scored.** Expected: a match with activity in the last 7 days is never deleted, and `touchQuickMatchActivity` on every score post keeps a long evening alive; the sweep test includes a row touched 1 minute ago. (Task 2)
3. **A saver's account is deleted.** On main that is a soft delete (Global Constraints), so the FK's `on delete set null` does not fire. Expected: the match keeps scoring, and the next sweep treats a row whose saver is soft-deleted (`users.deleted_at is not null`), or whose saver row is gone (`saved_by_user_id is null and expires_at is null`), as unsaved: it clears `saved_by_user_id` and re-arms `expires_at` from `last_activity_at`, after which the ordinary expiry rules apply. (Task 2)
4. **The same email on two quick matches, one already saved by someone else.** Expected: sign-in with that email saves only the unsaved one; the other keeps its saver. (Task 4)
5. **Sign-in with no cookie, no email on the row, and no Save button pressed.** Expected: nothing is saved and nothing errors; the hook is a no-op. (Task 4)

---

### Task 1: The link mail at creation

> **Amended by "Pre-flight amendments (2026-11-08)" → Amend T1. Those lines override this task's text where they differ.**

**Files:**
- Modify: `src/server/email-outbox/constants.ts:9-65,80-132` (and its header's `V478` reference at `:5-7`, which now names V493), `src/server/email-outbox/hooks.ts:42-94`
- Create: `db/migration/deltas/V493__email_outbox_quick_match_kinds.sql` (number at merge, main's max + 1 after plan 1's V492; Flyway runs with no `outOfOrder`, `V478:16-17`; redefines `email_outbox_kind_valid` with `quick_match_link` and `quick_match_reminder`, SQL below)
- Create: `src/lib/email-templates/quick-match.ts` (exports `quickMatchLinkTemplate(args, dict)` and `quickMatchReminderTemplate(args, dict)`, shaped as `funnel.ts:14-38`); modify `src/lib/email-templates/index.ts` (re-export them, as `:26` does for the funnel); modify `src/lib/email.ts` (append `quickMatchLinkEmail`, `quickMatchReminderEmail` after `funnelReminderEmail` `:413`, each `getDictionary(locale, "emails")` then its template; `lib/email.ts` imports templates from `@/lib/email-templates`, `:9-62`)
- Modify: `src/dictionaries/{en,fr,es,nl}/emails.json`; regenerate `src/lib/i18n-keys.ts` with `npm run i18n:gen-keys`
- Modify: `src/server/usecases/quick-match-create.ts` (plan 1 Task 5): its `ctx` gains `baseUrl: string` and it enqueues inside its final transaction; `src/app/api/quick-match/route.ts` (plan 2 Task 3) passes `baseUrl(req)` and calls `dispatchNow([rowId])` after it returns (as `api/funnel/start/route.ts:65`)
- Modify the kind-pinning tests listed in Global Constraints: each typed list gains the two kinds after `staff_extra_org_allowance`, typed from the quick-match design (§7.6, C2), not from the phase-3 spec; every count 51 becomes 53; the legend's literal list and its transactional list each gain both (TWENTY → TWENTY-TWO literal, THIRTY-TWO → THIRTY-FOUR transactional); `KIND_DIRECT_SENDER` maps both to `null`. `allowlistLengthFor` (`_kind-senders.ts:111-114`) counts every map key except `KINDS_BEFORE_PHASE_3` (`:33`) as a phase-3 kind that took a `send*` with it, so two new keys make it `49 - 51 = -2` and red `no-second-path.test.ts:106` and `outbox-kind-sweep.test.ts:635`: add `KINDS_AFTER_PHASE_3: readonly OutboxKind[] = ["quick_match_link", "quick_match_reminder"]` (kinds born on the outbox, never a direct sender) beside `:33` and filter it out at `:112` as well.
- Modify the DB kind sweep (`outbox-kind-sweep.test.ts:1975-2197`): add a `quick_match_link` scenario that drives the real producer, `POST /api/quick-match` (plan 2 Task 3), with `firstAttempt: "request"` and a non-`en` locale whose subject differs from the English one (the sweep's own pattern, `:1977-1980`). The `quick_match_reminder` scenario is Task 2 Step 1's. Between the two tasks the DB sweep fails by name, `no scenario for outbox kind quick_match_reminder` (`_kind-harness.ts:177` `forEachOutboxKind`); that is Task 2's red, not a regression.
- Test: `src/server/usecases/__tests__/quick-match-email.test.ts`

The migration restates V478's fifty-one kinds in V478's order (copied from `V478:21-33`), then the two new ones:

```sql
-- V493 — quick match (docs/superpowers/specs/2026-11-03-quick-match-design.md §7.6, C2): the link mail at creation and the one
-- reminder before expiry join the outbox's vocabulary. The CHECK restates V478's fifty-one, in V478's order, then these two.
-- outbox-schema.test.ts reads it back and requires it to equal constants.ts and the typed list.
alter table email_outbox drop constraint email_outbox_kind_valid,
  add constraint email_outbox_kind_valid check (kind in ('magic_link', 'chess_invite', 'registration_confirmation',
    'payment_reminder', 'registration_promoted', 'refund_issued', 'solo_signup_assigned',
    'registration_dispute_alert', 'registration_dispute_lost', 'sponsor_invoice', 'sponsor_receipt', 'sponsor_refund',
    'sponsor_dispute_alert', 'sponsor_dispute_won', 'sponsor_dispute_lost', 'pass_revoked', 'trial_ending',
    'email_verification', 'funnel_claim', 'email_change_confirmation', 'email_change_notice', 'account_deletion',
    'org_invite', 'claim_invite', 'official_invite',
    'official_assigned', 'official_assignment_changed', 'suspension_confirmed', 'suspension_served', 'match_report_submitted',
    'group_transfer_offer', 'group_transfer_complete', 'group_org_removed', 'group_org_left',
    'funnel_reminder', 'staff_registration_refund_failed', 'staff_credit_pack_grant_failed', 'staff_size_pack_grant_failed',
    'staff_stream_credit_grant_failed', 'staff_pass_credit_reversal_incomplete', 'staff_pass_rung_mismatch',
    'staff_pass_unknown_competition', 'staff_stream_credit_clawback', 'staff_extra_org_reprice_failed', 'staff_dispute_alert',
    'staff_connect_bank_changed', 'staff_stuck_events', 'staff_stream_pack_price_drift', 'staff_ai_run_cost',
    'staff_earn_grant_volume', 'staff_extra_org_allowance',
    'quick_match_link', 'quick_match_reminder'));
```

**Interfaces:**
- Consumes: `enqueueEmail(db, m: OutboxMessage)` (`src/server/email-outbox/enqueue.ts:152`; `OutboxMessage` `:19-41`), `expiryWithin` (`:113`), `recipientLocale(db, { pick, userId: null, orgDefault: null })` (`locale.ts:20`), `dispatchNow` (`attempt.ts:426`), all four from `@/server/email-outbox` (`index.ts:9-15,35,46`); `renderEmail`/`paragraph`/`button`/`linkFallback` (`src/lib/email-templates/compose.ts:142,48,53,69`) as `src/lib/email-templates/funnel.ts:1,14-38` uses them; `baseUrl(req)` (`src/lib/oauth.ts:35`); `QUICK_MATCH_SYSTEM_ORG_ID` (plan 1 Task 1). The precedent for "row and mail commit together, first attempt after commit" is `api/funnel/start/route.ts:45-65`.
- Produces:
  ```ts
  export interface QuickMatchEmailArgs { name: string; link: string; expiresAt: Date }
  export async function quickMatchLinkEmail(args: QuickMatchEmailArgs, locale: Locale): Promise<EmailContent>;      // subject key emails "quickMatchLink.subject" = "Your quick match: {name}"
  export async function quickMatchReminderEmail(args: QuickMatchEmailArgs, locale: Locale): Promise<EmailContent>;  // "quickMatchReminder.subject" = "{name} is kept until tomorrow"
  ```
  Kinds: `quick_match_link: { to: "literal", transactional: true }`, `quick_match_reminder: { to: "literal", transactional: true }`; `refType: "quick_match"`, `refId: <quick_matches.id>`, `orgId: QUICK_MATCH_SYSTEM_ORG_ID` (Global Constraints: the tenant insert policy refuses `null`), `expiresAt: expiryWithin(row.expiresAt)`, link `${ctx.baseUrl}/q/${token}` (the token just minted, in hand). `createQuickMatch` returns `outboxRowId: string | null` in `CreatedQuickMatch` so the route can dispatch after commit.

- [ ] **Step 1: Write the failing tests**: a create with an email leaves one `email_outbox` row of kind `quick_match_link` with `ref_type 'quick_match'`, the row id and `org_id` = the system org, recipient = the email, subject containing the name, body containing the `/q/qm_` link and nothing else link-like; a create without an email leaves no row; the kind-pinning tests fail until the lists are updated (run them and read the diff).
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the kinds (constants, hooks, migration), the template, its re-export and builders, the enqueue inside `createQuickMatch`'s final transaction, the dispatch in the route, and the four locale files; `npm run i18n:gen-keys`.
- [ ] **Step 4: Run to verify pass**: the new test and the five kind test files (`outbox-schema`, `outbox-kind-sweep`, `enqueue-once`, `no-second-path`, `a-kind-body`), then `npm run i18n:check`.

---

### Task 2: The reminder and the expiry sweep route

> **Amended by "Pre-flight amendments (2026-11-08)" → Amend T2. Those lines override this task's text where they differ.**

**Files:**
- Create: `src/app/api/cron/quick-match-expiry/route.ts`
- Create: `src/server/usecases/quick-match-sweep.ts`
- Modify: `src/server/email-outbox/__tests__/outbox-kind-sweep.test.ts` (the `quick_match_reminder` scenario, see Step 1)
- Test: `src/server/usecases/__tests__/quick-match-sweep.test.ts`

**Interfaces:**
- Consumes: Task 1 `quickMatchReminderEmail`; `enqueueEmailOnce(db, m & { dedupeKey })` and `onceKey("quick_match_reminder", "quick_match", id, "reminder")` (`src/server/email-outbox/enqueue.ts:173,88`); `expiryWithin`, `recipientLocale` (as Task 1); plan 1 `openHomeToken` (to rebuild `/q/<token>` from `token_enc`) and `hardDeleteQuickMatchCompetition` (Task 5); `baseUrl(req)` (`src/lib/oauth.ts:35`); the secret gate from `api/cron/email-outbox/route.ts:23-26`; the claim-then-enqueue shape of `api/funnel/remind/route.ts:44-69` (the claim at `:45-48`, `orgId` and recipient at `:54-55`).
- Produces:
  ```ts
  export interface SweepReport { expired: number; reminded: number; rearmed: number; checked: number }
  export async function sweepQuickMatches(opts: { baseUrl: string; now?: Date }): Promise<SweepReport>;
  // rearmed (runs first): rows whose saver is soft-deleted (saved_by_user_id in users with deleted_at is not null) or gone
  //   (saved_by_user_id is null and expires_at is null) → saved_by_user_id = null, expires_at = last_activity_at + 7 days (Review Focus 3)
  // expired: rows with saved_by_user_id is null and expires_at < now → hardDeleteQuickMatchCompetition per row (own sql.begin each; a failure on one row does not stop the others; counted only when deleted)
  // reminded: rows with saved_by_user_id is null, email not null, reminder_sent_at is null, expires_at between now and now + 24h → claim with `update ... set reminder_sent_at = now() where id = $1 and reminder_sent_at is null returning id`, then enqueueEmailOnce with orgId QUICK_MATCH_SYSTEM_ORG_ID, the row's locale as the pick and the link `${baseUrl}/q/${openHomeToken(token_enc)}`; on refusal roll back the claim
  // POST /api/cron/quick-match-expiry (req) → SweepReport, 401 on a bad secret, 503 with no CRON_SECRET
  ```

- [ ] **Step 1: Write the failing tests** (mutate `last_activity_at`/`expires_at` by SQL to set the clock):

```ts
it("deletes a scored, unsaved match older than 7 days of inactivity and keeps the rest", async () => {
  const old = await scoredQuickMatch(); await age(old.id, "8 days");
  const recent = await scoredQuickMatch(); await age(recent.id, "6 days");
  const touched = await scoredQuickMatch(); await age(touched.id, "8 days"); await touchQuickMatchActivity(touched.id);  // Review Focus 2
  const saved = await scoredQuickMatch(); await age(saved.id, "8 days"); await sql`update quick_matches set saved_by_user_id = ${user}, expires_at = null where id = ${saved.id}`;
  const r = await sweepQuickMatches({ baseUrl: BASE });
  expect(r.expired).toBe(1); expect(r.checked).toBeGreaterThanOrEqual(4);
  expect(await rows([old.id])).toHaveLength(0); expect(await rows([recent.id, touched.id, saved.id])).toHaveLength(3);
});
it("leaves no orphan row in any table (§7.8)", async () => {
  // idsOf: every (table, column) of the closure in Global Constraints, read from pg_constraint at run time and required to contain the
  // typed list there (fixtures, score_events, device_links, match_states, standings_snapshots, competition_events, division_events, ...),
  // plus the keyless list (email_outbox.ref_id, quick_matches, slug_history.entity_id, fixture_stream_sessions.competition_id, ...);
  // it records the rows that exist for this quick match before the delete.
  const qm = await scoredQuickMatch(); const ids = await idsOf(qm);
  expect(ids.length).toBeGreaterThan(0);
  await age(qm.id, "8 days"); await sweepQuickMatches({ baseUrl: BASE });
  for (const [table, column, id] of ids) expect(await sql.unsafe(`select 1 from ${table} where ${column} = $1`, [id]), table).toHaveLength(0);
  console.info(`orphan check covered ${ids.length} rows across ${new Set(ids.map((i) => i[0])).size} tables`);
});
it("reminds once, 24h before expiry, only with an email", async () => { /* two rows at 23h to expiry, one with email: reminded 1, one outbox row kind quick_match_reminder, org_id the system org; a second sweep reminds 0 */ });
it("a saver's deleted account re-arms expiry (Review Focus 3)", async () => { /* saved row; soft-delete the saver as DELETE /api/users/me does (users.deleted_at = now(), route.ts:182-191); sweep: rearmed 1, saved_by_user_id null, expires_at = last_activity_at + 7 d; the row survives when within 7 days of last activity and is deleted when older. A second case hard-deletes the users row (the FK sets null) and expects the same re-arm. */ });
it("never deletes on a date: a saved match with ends_on in the past still scores (C21)", async () => { /* set competitions.ends_on = yesterday, sweep, then scoreEvent through the guest link → 201 */ });
it("the route refuses a bad secret", async () => { /* POST with wrong header → 401 */ });
```

  And the kind sweep's `quick_match_reminder` scenario in `outbox-kind-sweep.test.ts`, modelled on `funnelReminderScenario` (`:1170-1186`): a quick match with an email in a non-`en` locale, aged to 23 h before expiry by SQL, then the real `POST /api/cron/quick-match-expiry` with the run's secret; `firstAttempt: "worker"`; added to the scenarios map (`:2133-2188`).
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the use case and the route.
- [ ] **Step 4: Run to verify pass** (expected: PASS, 6 tests; the orphan test prints a count above zero), plus `outbox-kind-sweep.test.ts` (53 kinds swept). `apps/cron-worker/test/drift.test.ts` stays red on the new `/api/cron/` route until Task 3.
- [ ] **Step 5: Mutate once:** change the age predicate from `<` to `<=` on `expires_at` with a row at exactly `now`, confirm a test fails, restore. (TEST-STRATEGY rule 5)

---

### Task 3: Schedule the sweep

> **Amended by "Pre-flight amendments (2026-11-08)" → Amend T3. Those lines override this task's text where they differ.**

**Files:**
- Modify: `apps/cron-worker/src/schedule.ts:75` (the new row right after `funnel-remind`, in `JOBS` `:64`)
- `apps/cron-worker/wrangler.json`: no change. `TRIGGER_CRON` (`"17 * * * *"`) is already in both envs (`:24,29`), and `test/drift.test.ts:93-96` pins that each env registers exactly the table's triggers.
- Modify the tests that type the hourly every-firing rows (each list of `registrations, billing-events, funnel-remind` gains `quick-match-expiry` after `funnel-remind`, in table order):
  - `apps/cron-worker/test/schedule.test.ts:24` (`HOURLY`) and `:76-85` (the week's counts: `"quick-match-expiry": 168`);
  - `apps/cron-worker/test/index.test.ts:33-52` (Monday 08:17 runs five, `jobs: 5`; Tuesday 14:17 runs four, `Array(4)`);
  - `apps/cron-worker/test/run.test.ts:76-91` (four results, posts and job lines, `jobs: 4`), `:121-132`, `:133-138` (`[true, undefined, undefined, undefined]`), `:140-153`, `:155-164`, `:170-178` ("4 jobs + 4 events + 1 probe" = 9 calls);
  - `apps/cron-worker/test/e2e.local.test.ts:14` (`SLOT_JOBS`).
- Test: the row assertion below, in `apps/cron-worker/test/schedule.test.ts`

**Interfaces:**
- Produces the row: `{ id: "quick-match-expiry", path: "/api/cron/quick-match-expiry", trigger: TRIGGER_CRON, due: { kind: "every" }, retry: true, manual: true }` (the `Job` shape, `schedule.ts:21-39`; `failureCounts` omitted, see the Re-pin log's findings).

- [ ] **Step 1: Write the failing assertion** that a job with `id "quick-match-expiry"` exists with that path, `TRIGGER_CRON`, `due: { kind: "every" }` and `retry: true`, and update the typed hourly lists above.
- [ ] **Step 2: Run to verify failure** (`cd apps/cron-worker && npx vitest run`)
- [ ] **Step 3: Add the row.**
- [ ] **Step 4: Run to verify pass**, including `test/drift.test.ts` (green only now that Task 2's route has its row).

---

### Task 4: Saving on sign-in

> **Amended by "Pre-flight amendments (2026-11-08)" → Amend T4. Those lines override this task's text where they differ.**

**Files:**
- Create: `src/server/usecases/quick-match-save.ts`
- Modify (call the hook right before `postAuthLanding`): `src/app/api/auth/verify-email/route.ts:43-46` (after `email_verified = true` `:43` and `createSession` `:44`, before `:46`), `src/app/api/auth/magic-link/consume/route.ts:32-34`, `src/app/api/auth/google/callback/route.ts:117-123` (after `createSession` `:117` and the `next` cookie read `:121-122`, before `:123`). These are the only three `postAuthLanding` call sites on main. All three have already set `users.email_verified = true` by then (`verify-email/route.ts:43`, `src/lib/login-link.ts:61`, `google/callback/route.ts:163`).
- Test: `src/server/usecases/__tests__/quick-match-save.test.ts`, plus one route test per sign-in path beside the existing ones: `src/app/api/auth/verify-email/__tests__/route.test.ts`; `src/app/api/auth/magic-link/__tests__/` (consume has no folder of its own; `consume-deleted-account.test.ts` drives the consume route); `src/app/api/auth/google/__tests__/` (harness `_google-callback.ts`, as `callback-email-verified.test.ts` uses it)

**Interfaces:**
- Consumes: `postAuthLanding(userId, next?)` (`src/lib/auth.ts:458`); `safeNextPath` (`:434`); `sql`.
- Produces:
  ```ts
  export async function saveQuickMatchesForVerifiedUser(userId: string): Promise<{ savedByEmail: number }>;
  // loads the user's email; update quick_matches set saved_by_user_id = $user, expires_at = null, reminder_sent_at = coalesce(reminder_sent_at, now()) where lower(email) = lower($email) and saved_by_user_id is null; returns the count
  export async function saveQuickMatchForUser(userId: string, quickMatchId: string): Promise<"saved" | "already_yours" | "taken">;
  ```
  The hook is one line in each route: `await saveQuickMatchesForVerifiedUser(userId);` before `postAuthLanding`. It never throws past the route (log and continue): a save failure must not block sign-in.

- [ ] **Step 1: Write the failing tests**: two rows with the same email, one already saved by another user, sign-in saves one and leaves the other (Review Focus 4); case-folded email matches; a user with no matching rows gets `savedByEmail 0` and no error (Review Focus 5); each of the three routes, driven as the existing route tests drive them, ends with the row saved and the user signed in; a thrown error inside the hook still returns the landing redirect.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the use case and the three one-line calls.
- [ ] **Step 4: Run to verify pass**, plus the three routes' existing suites.

---

### Task 5: The Save button and its landing

> **Amended by "Pre-flight amendments (2026-11-08)" → Amend T5. Those lines override this task's text where they differ.**

**Files:**
- Create: `src/app/q/[token]/save/route.ts` (GET; `src/app/q/` does not exist on main, plan 2 Task 5 creates it)
- Modify: `src/components/quick-match/home.tsx` (plan 2 Task 5): the Save button links to `/login?next=/q/<token>/save`; when `row.savedByUserId` is set and equals the current user, show "Saved" instead; when set by someone else, show nothing
- Test: `src/app/q/[token]/__tests__/save-route.test.ts`

**Interfaces:**
- Consumes: `getCurrentUser()` (`src/lib/auth.ts:92`); Task 4 `saveQuickMatchForUser`. `safeNextPath` (`src/lib/auth.ts:434-450`) is a same-origin check, not a prefix allowlist, so `/q/...` passes as it is and nothing is added; the login page validates `next` with it and sends a signed-in visitor straight there (`src/app/login/page.tsx:31-33`); `postAuthLanding` honors a safe `next` without provisioning an org (`src/lib/auth.ts:462-471`).
- Produces: `GET /q/[token]/save` → signed out: 302 to `/login?next=/q/<token>/save`; signed in: `saveQuickMatchForUser` then 303 to `/q/<token>`; an unknown token → the dead screen's 404.

- [ ] **Step 1: Write the failing tests**: signed out redirects to login with the `next`; signed in saves and redirects home; a second user hitting save on a saved match is redirected home with the row unchanged ("taken").
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass**

---

### Task 6: The account's "Quick matches" list, rename and delete

> **Amended by "Pre-flight amendments (2026-11-08)" → Amend T6. Those lines override this task's text where they differ.**

**Files:**
- Modify: `src/app/me/page.tsx` (a section after the existing ones, same `<section className="mb-8">` pattern at `:225`; the page signs a visitor in at `:47-48` and reads its data in one `Promise.all` at `:54-89`)
- Create: `src/components/quick-match/my-list.tsx`
- Create: `src/app/api/quick-match/[id]/route.ts` (PATCH rename, DELETE)
- Modify: `src/dictionaries/{en,fr,es,nl}/ui.json` (`quickMatch.me.title` "Quick matches", `quickMatch.me.rename` "Rename", `quickMatch.me.delete` "Delete", `quickMatch.me.deleteConfirm` "Delete this quick match for everyone? The link stops working."), then `npm run i18n:gen-keys`
- Test: `src/app/api/quick-match/__tests__/owner-routes.test.ts`, `src/app/me/__tests__/quick-matches-section.test.tsx`

**Interfaces:**
- Consumes: plan 1 `openHomeToken`, `hardDeleteQuickMatchCompetition`; `getCurrentUser`; `listCompetitions(auth, query)` (`src/server/usecases/competitions.ts:104`) and `countActiveCompetitions(orgId)` (`src/server/usecases/entitlement-freeze.ts:202-204`, the exported reader of the private `quotaCount` at `:177`) for the C9 assertions.
- Produces:
  ```ts
  export async function listMyQuickMatches(userId: string): Promise<{ id: string; name: string; url: string; played: number; total: number; format: QuickMatchFormat }[]>;
  // PATCH /api/quick-match/[id] { name } → 200; 403 unless saved_by_user_id = current user; updates quick_matches.name and competitions.name
  //   with plain UPDATEs in one transaction, NOT through updateCompetition: its rename regenerates the slug and writes slug_history
  //   (competitions.ts:662-664, slugs.ts:124), a keyless row the hard delete would orphan. A private guest competition has no public URL to keep.
  // DELETE /api/quick-match/[id] → 204; 403 unless saver; hardDeleteQuickMatchCompetition
  ```
  The list never appears among the user's competitions (`listCompetitions` reads the user's own org; the system org is not theirs), and `countActiveCompetitions` of the user's org is unaffected (C9).

- [ ] **Step 1: Write the failing tests**: a saver sees their match in the list with a working `/q/` url; a non-saver gets 403 on PATCH and DELETE; the saver's rename changes both names and writes no `slug_history` row; the saver's delete leaves no rows (reuse the orphan check); after saving, the user's own org `countActiveCompetitions` is unchanged and `listCompetitions` for their org does not include it (C9); a user who saved a match they never created can delete it (Review Focus 1).
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run to verify pass**, then `npm run i18n:check`.

---

### Task 7: Smoke suite

> **Amended by "Pre-flight amendments (2026-11-08)" → Amend T7. Those lines override this task's text where they differ.**

**Files:**
- Create: `scripts/smoke/suites/quickMatch.ts` exporting `quickMatchSuite()` (suite files and keys are camelCase; a key is the function name without `Suite`, `scripts/smoke/index.ts:39-40`)
- Modify: `scripts/smoke/index.ts:41` (`SELECTABLE_SUITES`, key `quickMatch`; import in the block at `:14-34`), `scripts/smoke/main.ts:879` (`await suite("quickMatch", …)` right after `funnelReminder`; import beside `:80`)

**Interfaces:**
- Consumes: `check(label, cond)` and `tag` from `scripts/smoke/harness.ts:86,132`; `BASE` (`:10`), `smokeDb()` (`:943`), `checkQueuedOutboxRow` (`:299`); the event body shape of `appendScoreEvent` (`:1300-1316`: `expected_seq` from `/state`, a per-call `idempotency_key`), which is session-keyed, so the suite posts its own request with `authorization: Bearer <device link secret>`; the deployed routes. Model: `scripts/smoke/suites/funnelReminder.ts` (skips with a passing line when `CRON_SECRET` is absent, `:18-25`; deletes its own rows in `finally`, `:70-76`).
- Produces: a suite that, against the target base URL, creates a quick match (2 sides, league, name suffixed with `tag`), opens the home and checks "0 of 1", posts Score and follows the 303 to `/score/dl_`, posts one rally through `/api/v1/fixtures/{id}/events` with the device link, checks the home reads Live, then calls the sweep route with the secret and checks the row survives (it is 7 days from expiry), and finally deletes what it made through SQL in `finally` (the harness allows direct DB access through `smokeDb()`): the outbox rows by `ref_type 'quick_match'` and ref, then the competition, which cascades per the closure in Global Constraints and takes `quick_matches` with it. The run's `cleanup(tag)` (`harness.ts:1440`) purges only the run's users and their orgs and never reaches the system org.

- [ ] **Step 1: Write the suite with its checks.**
- [ ] **Step 2: Run `SMOKE_ONLY=quickMatch npm run test:smoke`** (`package.json:47`; needs `CRON_SECRET` and `DATABASE_URL`, as the funnel reminder suite does) against a staging target and record the pass in the suite header.

---

### Task 8: The weekly news digest excludes the system org

Added at pre-flight (E1). The whole task is in "Pre-flight amendments (2026-11-08)" → Amend T8.

---

## Self-review notes

- **Spec coverage, plan 3 scope:** §7.6 (Task 1), C2 (Task 2), §7.8 (Tasks 2, 3), §7.7 (Tasks 4, 5), C9 and C13 (Task 6), §9 expiry, save, smoke (Tasks 2, 4 to 7), C21's "no date closes a match" (Task 2).
- **Across the three plans, every §9 line has an owner:** create-and-score sweep and knockout offer (plan 1 Task 6), atomicity (1.5), started division (1.5), format row (2.4), scoring seam (1.8, 2.6), knockout progression (1.5, 1.7, 2.5), token re-display (1.9, 2.9, 3.6), isolation (1.7), visibility (C7 is pinned by the private views; add one assertion in 1.5 that `public_competitions_v` has no row for the created competition), quota and slugs (1.1, 1.5 "two sides may share a name" plus a same-name-twice create), expiry (3.2), no date (3.2), save (3.4, 3.5, 3.6), limits (1.5, 2.3), e2e (2.10), smoke (3.7).
- **Two assertions to fold into plan 1 Task 5 when executing** (found in this review): the `public_competitions_v` absence check, and a second create with the same name in the same org producing a distinct slug.
- **Type consistency:** `QuickMatchFormat`, `CreatedQuickMatch.outboxRowId` (added here, used by plan 2 Task 3's route), `createQuickMatch`'s `ctx.baseUrl` (added here, passed by plan 2 Task 3's route), `SweepReport.rearmed` (added here), `hardDeleteQuickMatchCompetition`, `touchQuickMatchActivity`, `openHomeToken` match plans 1 and 2.

## Re-pin log (2026-11-07)

Re-pinned against origin/main 1b224951d4. The hard-delete closure was read from `pg_constraint` of a local database at V491 (main's level; read only) and every edge then pinned to its defining migration line in the worktree.

| # | Where | Old | New |
|---|---|---|---|
| 1 | Header | "Repo root …: the seazn.club checkout" | adds the checkout path, `db/` to the path rule, and the re-pin line |
| 2 | GC outbox kinds | `constants.ts:9`, `:80` | `src/server/email-outbox/constants.ts:9-65`, `:80-132` (start lines held) |
| 3 | GC outbox kinds | `hooks.ts:42` | `src/server/email-outbox/hooks.ts:42-94` (held) |
| 4 | GC outbox kinds | `V478__email_outbox_phase3_wave5.sql:20` | `:20-33` (held; still the latest definer on main, 51 kinds) |
| 5 | GC outbox kinds | `outbox-schema.test.ts:52` | `:47-61` (`SPEC_KINDS`), `:72` (count), `:246-261` (live CHECK) |
| 6 | GC outbox kinds | `outbox-kind-sweep.test.ts:318/376` | `:297-352`, `:356-411`, `:472`, `:475-579`, `:2133-2188`, `:2192` |
| 7 | GC outbox kinds | `enqueue-once.test.ts:69` | `:50-102`, `:163` |
| 8 | GC outbox kinds | `_kind-senders.ts:69` | `:49-106` (`KIND_DIRECT_SENDER`), `:111-114` (`allowlistLengthFor`) |
| 9 | GC outbox kinds | "four places … four tests" | three code places + the CHECK; five test files (adds `no-second-path.test.ts:104-107`, notes `a-kind-body.test.ts:88` unchanged) |
| 10 | GC mail content | "the key union in `lib/i18n-keys.ts`" | generated file (`:1-2`): `npm run i18n:gen-keys`, never hand-edited |
| 11 | GC cron | `api/cron/email-outbox/route.ts:21-29` | `:23-26` (the gate itself), plus `api/funnel/remind/route.ts:23-28,64` for `req`/`baseUrl` |
| 12 | GC cron | `trigger: TRIGGER_CRON`, wrangler "if not already listed" | `schedule.ts:42` (`"17 * * * *"`), `JOBS` `:64`; already in `wrangler.json:24,29`; drift test `:93-96`, `:32-35` |
| 13 | GC hard delete | "every table in §7.8 plus email_outbox and quick_matches" | the re-enumerated closure (new subsection) plus the keyless list |
| 14 | Task 1 files | `constants.ts:9,80`, `hooks.ts:42` | ranges as rows 2-3, plus the `constants.ts:5-7` V478 comment |
| 15 | Task 1 files | template + `lib/email.ts` | adds `src/lib/email-templates/index.ts` re-export (`:26` pattern) and `lib/email.ts:413` placement |
| 16 | Task 1 consumes | `enqueue.ts:152`, `:19`, `locale.ts:20`, `funnel.ts:14` | held; adds `expiryWithin` `:113`, `dispatchNow` `attempt.ts:426`, `index.ts` re-exports, `compose.ts:142,48,53,69`, `funnel.ts:1,14-38`, `oauth.ts:35`, `funnel/start/route.ts:45-65` |
| 17 | Task 2 consumes | `enqueue.ts:173,88`; `email-outbox/route.ts:21-29`; `funnel/remind/route.ts:44-48` | held / `:23-26` / `:44-69` (claim `:45-48`) |
| 18 | Task 3 files | `schedule.ts:75` (after `funnel-remind`) | held |
| 19 | Task 3 tests | "add a row assertion to the schedule test" | plus the typed hourly lists in `schedule.test.ts`, `index.test.ts`, `run.test.ts`, `e2e.local.test.ts` (pins in the task) |
| 20 | Task 4 files | `verify-email/route.ts:44-46`, `consume/route.ts:32-34`, `google/callback/route.ts:122-124` | `:43-46`, `:32-34` (held), `:117-123`; test folders named |
| 21 | Task 4 consumes | `lib/auth.ts:458` | held (`safeNextPath` `:434` added) |
| 22 | Task 5 consumes | `lib/auth.ts:92`; "`safeNextPath` … `:434`; add the prefix if its allowlist is narrower" | `:92` held; `:434-450` is a same-origin check with no allowlist, nothing to add; `login/page.tsx:31-33`, `auth.ts:462-471` |
| 23 | Task 6 files | `me/page.tsx:225` | held |
| 24 | Task 6 tests | "`quotaCount` of the user's org" | `countActiveCompetitions` (`entitlement-freeze.ts:202-204`); `quotaCount` (`:177`) is private |
| 25 | Task 7 files | `scripts/smoke/suites/quick-match.ts`; `index.ts:39`; main "after the funnel suite" | `suites/quickMatch.ts` (`quickMatchSuite`); `index.ts:41` (`:39` is its comment); `main.ts:879`, import `:80` |
| 26 | Task 7 command | `SMOKE_ONLY=quick-match` | `SMOKE_ONLY=quickMatch` (the key is the function name without `Suite`) |
| 27 | Task 7 consumes | `harness.ts:86,132` | held; adds `:10`, `:943`, `:299`, `:1300-1316`, `:1440` |

### Drift adaptations

1. **Hard-delete closure re-enumerated.** §7.8's list stopped at the tables of early 2026. Main now also cascades `division_checkpoints`, `discipline_rules`, `suspensions`, `registration_settings`, `import_locks`, `imports.pin_division_id`, `stage_round_court_tags`, `stage_round_opens`, `stage_lots_draws` (W2d), `fixture_availability`, `fixture_stream_*`, `capture_records`/`capture_record_sessions`, `fixture_external_play`, `fixture_video_*`, `fixture_play_flags`, `online_chess_audit`, `fixture_seat_asks`, `fixture_seat_line`, `youtube_broadcasts`, `fixture_calls` (Match Day V484), and SET NULLs `entrants.swiss_first_round_stage_id` (W3 V487) and `fixture_stream_sessions.youtube_broadcast_id`. A new RESTRICT (`fixture_external_play.round_open_id`, V451:133) and a delete trigger (`fixture_video_meetings_park_room`, V460) were found; neither is reachable by a guest. V485 and V490 (W3 bye cleanup) are data-only and change no key; V489 adds `competitions.frozen_at`, which rides the row. The orphan test now sweeps the closure from the catalog plus a keyless list that includes `slug_history`.
2. **Account deletion is soft** (`app/api/users/me/route.ts:182-191`; nothing reads `purge_after`). Review Focus 3's "set null by the FK" never happens in production, so the sweep gained a `rearmed` step that un-saves a row whose saver is soft-deleted or gone and re-arms its expiry. Intent of Review Focus 3 kept.
3. **The kind registry has more pins than "four tests"**, and `allowlistLengthFor` assumes every kind past the two phase-1 kinds once had a direct `send*`. Two kinds born on the outbox would make it −2; Task 1 now adds `KINDS_AFTER_PHASE_3` and lists every typed pin, including the legend counts and the per-kind real-producer scenarios the DB sweep requires.
4. **The outbox tenant policy refuses an org-less row** (`V470:119-123`). The link is enqueued inside a `withTenant(SYSTEM_ORG)` transaction, so both kinds now carry `orgId: QUICK_MATCH_SYSTEM_ORG_ID` instead of `null`.
5. **The mails need a base URL.** The funnel precedent builds links with `baseUrl(req)` in the route. `createQuickMatch`'s `ctx` gains `baseUrl`, and `sweepQuickMatches` takes `{ baseUrl, now? }` from its route (which therefore takes `req`).
6. **`lib/i18n-keys.ts` is generated** on main; the plan now regenerates it rather than editing the union.
7. **The cron worker's tests type the hourly every-firing rows** in four files; Task 3 lists them. `wrangler.json` already carries the hourly trigger, so it is not modified. The drift test makes the Task 2 route red until Task 3's row lands.
8. **Task 6's rename** goes through plain UPDATEs, because `updateCompetition`'s rename writes a keyless `slug_history` row that the hard delete would orphan.
9. **Smoke naming** follows the harness's camelCase key rule, and cleanup uses the harness's direct DB access (`smokeDb()`), which the original text had left open.
10. **Migration number.** Main's latest is V491 and V492/V493 are free there, so V493 is kept (plan 1 takes V492). The unmerged check-in capacity plans (`2026-11-05-checkin-capacity-1-presence.md`, `-2-premint-proof.md`) also name V492 and V493. The number is assigned at merge as main's max + 1, and the constraint restated must be copied from whichever migration last redefines `email_outbox_kind_valid` at that moment (V478 today).

### Blockers

None. No drift made an owner decision impossible; every O and C decision stands as written.

### Findings outside the re-pin (not applied; for the controller)

These predate the drift and are not changed here, because each changes behavior or scope:

1. **C19 against the Save flow.** C19 says the home token never rides a query string. Task 5's `/login?next=/q/<token>/save` puts it in the login URL, and the magic-link mail carries `next` in its URL as well (`src/app/api/auth/magic-link/route.ts:76,84`). Resolving it needs a controller or owner call (for example, a POST that sets an HttpOnly "pending save" cookie and a `next` that carries no token).
2. **Other verified-email sign-ins never reach `postAuthLanding`:** `api/funnel/claim/route.ts:63`, `api/invites/[token]/claim/route.ts:31`, `api/claims/[token]/accept/route.ts:57`. §7.7 says "on any verified sign-in", but names only the three sites this plan hooks.
3. **The sweep surfaces no failure.** A per-row delete that throws is skipped and only counted by its absence. The worker's R3 counters (`schedule.ts:33-38`, `failureCounts`) would make that a degraded run with a Sentry event if `SweepReport` gained `failed` and the row `failureCounts: ["data.failed"]`.
