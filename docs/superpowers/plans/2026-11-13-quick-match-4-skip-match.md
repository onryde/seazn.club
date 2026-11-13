# Quick Match 4: Skip One League Match ("Not played" / "Put back") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone with a quick match's link can mark an unplayed or in-progress league match **Not played** (from the row's ⋯ menu, after a confirm sheet) and **Put back** a Not played match until the league finishes. A league whose every match is played or Not played is finished: the leader wins, or, with nothing played, the home says "No matches were played".

**Architecture:** A skip is a direct, guarded status write `scheduled|in_play → cancelled` on the fixture, under the same fixture advisory lock the scoring path takes. No ledger event: `cancelled` is a LOCKED status (`lib/fixture-status.ts:22`), so the ledger refuses every append to it, a void included. The partial score stays in `score_events` and `match_states` untouched, as history. Put back re-derives the status from the ledger with the existing fold (`foldFixture` + `fixtureStatusFromFold`, the `refreeze.ts:72-95` pattern), so a match with nothing scored returns to `scheduled` and a partially scored one to `in_play` at the score it had. The home read gains a `notPlayed` phase and count, and a `finished` flag that replaces `allPlayed`. Every count consumer (home, Continue card, account list, admin) reads the one `playedOf`.

**Tech Stack:** Next.js 16 route handlers (303 form posts, the Score and Add-a-match pattern), server components with a native `<details>` menu and a small client island for the confirm `<dialog>`, `postgres` tagged SQL under `withTenant(QUICK_MATCH_SYSTEM_ORG_ID)`, vitest (`environment: "node"`, DB tests in `src/server/usecases/__tests__`), Playwright (`apps/web/e2e`), smoke (`scripts/smoke/suites/quickMatch.ts`).

**Spec:** `docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md` (APPROVED by the OWNER on 2026-11-13, including the §6 sign-off calls). The mockup is `/Users/ashokhein/seazn-artifacts/2026-11-13_quick-match-next-designs_qmd13a01/index.html`, sections 1 to 5, Option A. It is **layout only**: build in the house theme of `components/quick-match/*`. Decision log: `/Users/ashokhein/github/seazn.club/.superpowers/sdd/quick-match-decision-log.md`.

**Branch / worktree:** `feat/quick-match-skip` at `/Users/ashokhein/github/seazn.club-worktrees/quick-match-skip`, stacked on PR #1198 head `de65acf530`. **Every Bash call starts with `cd /Users/ashokhein/github/seazn.club-worktrees/quick-match-skip &&`.** TypeScript paths below are relative to `apps/web/` unless they start with `scripts/`, `db/` or `docs/`.

**Depends on:** PR #1198 (quick match lifecycle, V515). **Blocks:** League + Knockout (`2026-11-12-quick-match-league-knockout-design.md`), which needs a skipped match to count as done.

**Migration:** NONE. `cancelled` is already allowed by `fixtures_status_check` (`db/migration/deltas/V432__fixture_status_needs_decision.sql:7-8`), and `fixtures_track_finished` already stamps and clears `finished_at` for it (`V430__capture_stream_codes.sql:24-38`). No new column is read. If an implementer finds one is truly needed, stop and report: the working number is V516.

---

## Re-pin log (2026-11-13, HEAD de65acf530)

Every premise in the spec and the brief was re-read in the tree. **F** marks a false or misleading premise.

| # | Premise | Found in the tree | Verdict |
|---|---|---|---|
| P1 | "`cancelled` counts as done for stage completion, `scoring.ts:1236`" | The file is `src/server/usecases/scoring.ts:1236`, inside `maybeAutoAdvance` (`:1222`), which returns early unless `divisions.auto_progress` is set (`:1225-1226`). Quick match create never sets it (default false, `db/migration/jul3/V249__format_extensions.sql:20`; no reference in `quick-match-create.ts`). A quick match's "finished" is derived on the home (`allPlayed`, `quick-match-home.ts:508`), not by stage completion. | **F (not load-bearing).** The line is true, but this plan never relies on it. It becomes load-bearing for League + Knockout, which must turn `auto_progress` on. |
| P2 | "the fixture is marked cancelled": implies an existing path | Nothing in `apps/web/src` or the engine writes `fixtures.status = 'cancelled'` (`stages/bracket-seats.ts:159-163` says so; the engine dist has no `cancelled` literal). There is no cancel usecase and no cancel event type. `cancelled` is in `LOCKED_FIXTURE_STATUSES` (`lib/fixture-status.ts:22`), so `appendEvent` refuses ANY append with `ALREADY_DECIDED` (`engine-db/append-event.ts:325-330`), a `core.void` included. | **F.** The skip is a new direct status write (T3). Put back cannot go through the ledger. It re-derives the status from the fold instead (`engine-db/refreeze.ts:72-95` is the precedent). |
| P3 | A partially scored match can move to `cancelled` without breaking `match_states`/`score_events` | The status write touches only `fixtures.status` (plus `finished_at` by trigger). `match_states` and `score_events` are keyed by fixture and untouched. Readers that open a cancelled fixture already exist: the device link refuses to mint (`device-links.ts:121-141`, a 422), the pad's next append is refused `ALREADY_DECIDED`, and the run-sheet readers exclude it (`card-stats.ts:161`, `org-posts.ts:602`). | TRUE. |
| P4 | Standings exclude cancelled | The standings fold adds a delta only for a fixture with an `outcome` and a folded `state` (`engine-db/competition.ts:~471`, "Only decided fixtures with a folded state contribute"). A skippable match is `scheduled` or `in_play`, so it has no outcome. A skip changes no standings input, and no recompute is owed. | TRUE by construction. A test pins "the table is byte-identical before and after a skip". |
| P5 | Edit result path | `editable = phase === "settled" && !resultMovedOn` (`components/quick-match/home.tsx:257`). It posts the Score route, the pad undoes, and the fixture returns to `in_play`. | TRUE. An edited-open match becomes skippable (a sequence test pins it). |
| P6 | "existing 'can't change' copy" for a stale Put back | No quick match copy says this. The only quick match "can't change" string is `device.quickMatch.resultLocked` (`dictionaries/en/ui.json:3723`): "…the next round has already started", a pad and knockout line. | **F.** T1 adds `quickMatch.flash.leagueFinished`. |
| P7 | Admin Played/Finished SQL | "Played" = a standing sport event exists (`quick-match-admin.ts:124-133`). It is unaffected: a skipped match with real rallies did see play. "Finished" = `isFinished({decided,total})` = `decided === total` (`:135-138`), and the page hint reads "every match decided" (`app/admin/quick-matches/page.tsx:28`). A league finished by skips would read unfinished. | Needs change (T2). |
| P8 | Home "N of M played" | `playedOf` counts the `SETTLED_FIXTURE_STATUSES` (decided, forfeited, abandoned) among non-bye fixtures (`quick-match-home.ts:244-247`). `phaseOf` maps `cancelled` to `"waiting"` (`:344-345`, which shows "waits" on the row). `allPlayed` can then never become true (`:508`), so a league with a skip never finishes. | Needs change (T2). |
| P9 | Continue card / finished detection | `splitRecent` resumes the first row with `played < total` (`components/quick-match/continue-card.tsx:22`). A league finished by skips would be "continued" forever. | Needs change (T2). |
| P10 | expiry / `last_activity_at` | `touchQuickMatchActivity(id)` (`quick-match-activity.ts:78`). Score (`app/q/[token]/score/[fixtureId]/route.ts:82`) and Add (`add-match/route.ts:87`) touch after their write, best-effort. | TRUE. Skip and Put back touch the same way (PO rec). |
| P11 | Link-token authorisation, like Score/Edit result | `resolveQuickMatchToken` (the shape check, then the hash lookup, alive only: `quick-match-home.ts:87-95`), then the per-match check through the row's own competition (`device-links.ts:126-135`; `readQuickMatchHome` `:376-399`). | TRUE. T3 copies it. |
| P12 | Plain Knockout removed, so only a league | Create refuses any non-league format with 422 `FORMAT_NOT_OFFERED` (`quick-match-create.ts:318`). The home still renders legacy knockout rows (`home.tsx:215, 347, 359`). | TRUE. A skip on a knockout row is refused with `LEAGUE_ONLY` (crafted post only), and no knockout row draws the menu. |
| P13 | `scoring.ts` "status cancelled" re-derived elsewhere could silently un-skip | `fixtureStatusFromFold` callers: `nextStatus` (append path, refused on locked) and `refreezeFixture` (a rules change, an organiser path no guest reaches). | TRUE (no guest path un-skips). Recorded. |
| P14 | Offered sports (for the sport sweep) | `lib/quick-match-offer.generated.json` `offered[].sport_key`: badminton, boardgame, carrom, football, hockey, icehockey, tabletennis, tennis, volleyball (9). | Sweep source (T3). |
| P15 | Put back "restores it to unplayed" | It conflicts for a partially scored match. The ledger keeps its events (spec: "kept in the ledger as history"), so a fold-derived status is `in_play`, not `scheduled`. Mockup §3 shows it "reappears with Score". | **F (ambiguous).** Controller PO rec: Put back restores the match **exactly as it was before the skip** (nothing scored → unplayed, ready with Score; partly scored → live at its score, with Score/Continue). OWNER MAY REVERT; see Open questions. |

## Decisions this plan makes (controller, PO rec; log each in the decision log at execution)

- **D1, the status write and lock order.** Skip: `pg_advisory_xact_lock(hashtext('fixture:'||id))` (the same key appendEvent takes, `append-event.ts:311`), then `update fixtures set status='cancelled' where id=$1 and status in ('scheduled','in_play') returning id`. A pad tap racing the skip then waits on the lock and is refused `ALREADY_DECIDED`. It never lands a point on a Not played match.
- **D2, Put back is the exact inverse** (P15): `foldFixture(tx, id)`. When it returns null (no events) the status is `'scheduled'`. Otherwise it is `fixtureStatusFromFold(folded.outcome, folded.active, stageKind)`. A non-null `folded.outcome` is impossible (a skip refuses any match with a result). It is an assertion (throw, reported as a fault), not a comment.
- **D3, idempotent second taps.** Skipping an already-cancelled match, or putting back a match that is not cancelled, is a no-op success that lands on the bare home (`{changed:false}`). A stale Not played tap on a match that has since been settled is refused `NOT_SKIPPABLE`. A stale Put back tap once the league is finished is refused `LEAGUE_FINISHED`.
- **D4, "finished" has one authority.** `playedOf` returns `{played, notPlayed, total}`, and `isQuickMatchFinished({played, notPlayed, total}) = total > 0 && played + notPlayed === total` is exported from `quick-match-home.ts`. The home, Put back's server check, the Continue card, the account list and admin all call it.
- **D5, Skip and Put back are activity**: `touchQuickMatchActivity`, best-effort after the write, as Score and Add do.
- **D6, the last open match.** When the match being skipped is the last open one, the confirm sheet's body says so (`quickMatch.skip.bodyLast`: the league finishes now and the skip cannot be put back). It stops a one-match league from being finished by a mis-tap without a warning. It is a designer's call this plan adds, mitigating the §6 rule. OWNER MAY REVERT.
- **D7, no script.** The ⋯ menu is a native `<details>` (the house pattern: `standings.tsx:138`, `add-match.tsx:72`). Its "Not played" item is a real `<form method="post">` submit, so without a script it skips directly (Put back undoes it). A client island upgrades the item: it prevents the submit and opens a native `<dialog>` confirm. The `<dialog>` is a bottom sheet below `md`, a centred dialog at `md`+. The island carries the Score form's double-submit lock and bfcache unlock pattern (`score-form.tsx`).
- **D8, list order.** Open matches (live, ready, waiting) come first, then Not played, then settled. Mockup §3 shows "drops to the bottom of the open matches".

## Global Constraints

- Copy: every new guest string goes in all 4 locales (`dictionaries/{en,fr,es,nl}/ui.json`), then `npm run i18n:gen-keys` and `npm run i18n:check` (root `package.json:60,62`). Plurals use `plural()` with `.one`/`.other`. Numbers come from the data, never typed into copy. `/admin` strings stay English inline (desktop-only, the existing page's convention).
- UI: mobile-first. Verify at 320, 768 and 1280 with no horizontal page scroll, and every tap target at least 44px. The seven-width matrix (`mobile.spec.ts`) is the backstop. `/admin` is verified at 1280 only.
- Credential hygiene: any element whose `action`/`href` holds `/q/<token>/…` carries `ph-no-capture` (`scrub-secret-painters.test.ts`). New route builders join the scrub registries.
- Tests (`docs/superpowers/TEST-STRATEGY.md`): anti-vacuity (every sweep asserts how many it checked, and zero is a failure). Expected values come from the rulebook or the engine's declarations, never from the code under test. Mutate each new guard once. Test the SEQUENCE (second tap, after a void, another sport).
- Verify locally ONLY the files changed: `cd apps/web && npx vitest run <paths> --reporter=json --outputFile=<scratch>/r.json; echo EXIT=$?`. Read `numPassedTests`/`numTotalTests` and confirm `.testResults[].name` resolves into THIS worktree. For tsc, use changed files only, via the throwaway `tsconfig.changed.json` recipe in the SDD ledger. Never the full suite, never the full e2e. E2E runs in CI by `gh workflow run e2e.yml --ref feat/quick-match-skip`.
- DB tests need a fresh schema (`seazn-local-env` skill: `db:apply` + `sync:sports`; confirm `show data_directory` is yours).
- Every UI dispatch (T4) invokes the `frontend-design` skill and owes 320/768/1280 screenshots of each changed state, served for sign-off on local :8765 (never artifacts, never PNGs in the repo).
- No PostHog event is added (none is owed by the spec).

## Review Focus

1. **A scorer on the pad when someone else skips the match.** Their next tap must be refused and write nothing, and the home must show Not played. T3 owns the test: append after skip → `ALREADY_DECIDED`, `score_events` count unchanged.
2. **Put back on a clock sport mid-half (football, hockey, icehockey).** The stored `match_states` must be byte-identical after skip + put back (the ledger is untouched). What the clock then shows is the engine's. T3's sport sweep asserts the state row is unchanged for every offered sport.
3. **Skip, then Edit result elsewhere reopens the league.** Finished is derived, so Put back reappears when an Edit result reopens a played match. T2 pins the predicate. T3 pins "decided → void → skippable".
4. **A one-match league skipped by mistake** is finished at once, and Put back is refused. D6's last-match copy warns first. T4 pins that the sheet shows `bodyLast` on the last open match and `body` otherwise.
5. **Add a match after a league finished by skips.** It is not finished any more, so the hero returns and Put back is shown again. T2 pins it with a model-level case: finished, then one new scheduled fixture → not finished.

---

## Batches (parallel only where the file sets are provably disjoint)

- **B1: T1 ∥ T2.** T1 owns `lib/quick-match-constants.ts`, `lib/routes.ts`, the 4 `ui.json`, `lib/i18n-keys.ts` (generated), and the scrub registries `lib/__tests__/{routes,scrub-route-root,scrub-path-secrets,scrub-secret-painters}.test.ts` (builder lists only). T2 owns `server/usecases/quick-match-home.ts`, `quick-match-admin.ts`, `app/admin/quick-matches/page.tsx`, `components/quick-match/continue-card.tsx`, and the tests `server/usecases/__tests__/{quick-match-home,quick-match-admin}.test.ts`, `components/quick-match/__tests__/continue-card.test.tsx`, `app/admin/quick-matches/__tests__/quick-matches-page.test.tsx`, plus the mechanical `allPlayed → finished` rename in `components/quick-match/home.tsx` (2 lines) and `app/q/[token]/__tests__/page.test.tsx`.
- **B2: T3 ∥ T4.** T3 owns `server/usecases/quick-match-skip.ts`, `app/q/[token]/skip/[fixtureId]/route.ts`, `app/q/[token]/put-back/[fixtureId]/route.ts`, and the tests `server/usecases/__tests__/quick-match-skip.test.ts`, `app/q/[token]/__tests__/skip-route.test.ts`. T4 owns `components/quick-match/{home,match-list,standings,my-list}.tsx`, the new `components/quick-match/row-menu.tsx`, `app/q/[token]/page.tsx`, `app/[lang]/(marketing)/play/page.tsx`, their tests, and `lib/__tests__/scrub-secret-painters.test.ts` (painter lists). **No dictionary edits in B2.** A missing key goes to the controller, who adds it in one commit between batches.
- **B3: T5 ∥ T6 ∥ T7.** T5 owns `e2e/quick-match-home.spec.ts` and `e2e/mobile.spec.ts`. T6 owns `e2e/walkthrough/quick-match.spec.ts`. T7 owns `scripts/smoke/suites/quickMatch.ts`. Then push and run CI e2e by dispatch.
- After each batch: the per-task review closes, and the controller re-runs the scoped gate (the union of that batch's test paths). After B3: the whole-branch review, the sign-off screens, then ONE PR.

---

### Task 1: Codes, routes and every string

**Files:**
- Modify: `src/lib/quick-match-constants.ts` (`QUICK_MATCH_ERRORS`, `:57`)
- Modify: `src/lib/routes.ts:159-162` (beside `quickMatchScore`/`quickMatchAddMatch`)
- Modify: `src/dictionaries/{en,fr,es,nl}/ui.json` (the `quickMatch.*` block, `en` `:8394-8457`)
- Regenerate: `src/lib/i18n-keys.ts` (`npm run i18n:gen-keys`)
- Test: `src/lib/__tests__/routes.test.ts`, `scrub-route-root.test.ts` (`SECRET_BUILDERS`, `:41`), `scrub-path-secrets.test.ts` (`:526-540` list), `scrub-secret-painters.test.ts` (`secretBuilderNames` expectation, `:586-594`, ONLY)

**Interfaces:**
- Produces: `QUICK_MATCH_ERRORS.NOT_SKIPPABLE = "QUICK_MATCH_NOT_SKIPPABLE"` (a match with a result, or one that is not this league's to skip); `QUICK_MATCH_ERRORS.LEAGUE_FINISHED = "QUICK_MATCH_LEAGUE_FINISHED"` (Put back after the league finished). Each gets a doc comment in the file's style.
- Produces: `routes.quickMatchSkip(token, fixtureId) => \`/q/${token}/skip/${fixtureId}\`` and `routes.quickMatchPutBack(token, fixtureId) => \`/q/${token}/put-back/${fixtureId}\``.
- Produces these keys (English shown; fr/es/nl translated with real agreement, never English):

| key | en |
|---|---|
| `quickMatch.home.moreActions` | `More actions for match {n}` |
| `quickMatch.home.notPlayed` | `Not played` |
| `quickMatch.home.notPlayedHint` | `Skip it. No points for either side.` |
| `quickMatch.home.putBack` | `Put back` |
| `quickMatch.home.notPlayedPart.one/.other` | `{n} not played` (plural on n) |
| `quickMatch.home.playedSkipped.one/.other` | `{played} of {count} match(es) played · {skipped} · deleted {days} days after the last score unless saved` (plural on count; `{skipped}` = the notPlayedPart text) |
| `quickMatch.home.playedSkippedSaved.one/.other` | `{played} of {count} match(es) played · {skipped}` |
| `quickMatch.home.countsPlayedOnly` | `Counts played matches only` |
| `quickMatch.home.finalTable` | `Final table` |
| `quickMatch.home.winnerAfter.one/.other` | `Top of the table after {played} played match(es).` |
| `quickMatch.home.winnerSkipped.one/.other` | `1 match was not played.` / `{n} matches were not played.` |
| `quickMatch.home.leagueFinished` | `League finished` |
| `quickMatch.home.noPlay` | `No matches were played` |
| `quickMatch.home.noPlayHint.one/.other` | `The only match was marked Not played, so there is no winner.` / `All {count} matches were marked Not played, so there is no winner.` |
| `quickMatch.skip.title` | `Skip {home} v {away}?` |
| `quickMatch.skip.body` | `It gives no points to either side, and the table counts only played matches. You can put it back until the league finishes.` |
| `quickMatch.skip.bodyLast` | `It gives no points to either side. This is the last match left, so the league finishes now and this can't be put back.` (D6) |
| `quickMatch.skip.partial` | `{score} is already scored. It will not count in the table; it stays in the match history.` |
| `quickMatch.skip.confirm` | `Mark not played` |
| `quickMatch.skip.keep` | `Keep this match` |
| `quickMatch.flash.notSkippable` | `That match already has a result, so it can't be skipped. Use Edit result to change it.` |
| `quickMatch.flash.leagueFinished` | `The league has finished, so its matches can't change.` |

  "Start a new quick match" reuses `quickMatch.dead.startNew` (`en/ui.json:8457`, the same words).

- [ ] **Step 1: Write the failing tests.** In `routes.test.ts`: `routes.quickMatchSkip("qm_abc","f1")` is `"/q/qm_abc/skip/f1"` and starts with `routes.quickMatch("qm_abc")`, and the same for `quickMatchPutBack` → `/put-back/`. Add both names to `SECRET_BUILDERS` (scrub-route-root) and to the sorted `secretBuilderNames()` expectation (scrub-secret-painters), and add `/q/${t}/skip/<uuid>` and `/q/${t}/put-back/<uuid>` to scrub-path-secrets' list of paths whose token must be scrubbed.
- [ ] **Step 2: Run them.** They fail (the builders are missing).
- [ ] **Step 3: Implement** the constants, the two builders, and the keys in all 4 locales. Then `npm run i18n:gen-keys`.
- [ ] **Step 4: Verify.** The 4 test files pass. `npm run i18n:check` exits 0. **Mutate once:** delete `quickMatch.skip.bodyLast` from `nl` → `i18n:check` goes red. Restore.
- [ ] **Step 5: Commit** `feat(quick-match): skip and put-back codes, routes and copy in four locales`.

---

### Task 2: One count, one "finished": the read model and every count consumer

**Files:**
- Modify: `src/server/usecases/quick-match-home.ts` (`QuickMatchPhase` `:297`, `phaseOf` `:344`, `playedOf` `:244`, `QuickMatchHome` `:299-331`, `RecentQuickMatchWithCounts` `:110`, `MyQuickMatch` `:180`, the return `:488-509`)
- Modify: `src/server/usecases/quick-match-admin.ts` (`isFinished` `:135-138`, the callers `:184-185, :252-262`, the `QuickMatchAdminRow` shape)
- Modify: `src/app/admin/quick-matches/page.tsx` (`:28` the hint, `:172` the "x of y" cell)
- Modify: `src/components/quick-match/continue-card.tsx:22`
- Modify (mechanical rename only): `src/components/quick-match/home.tsx:233,346` (`home.allPlayed` → `home.finished`); `src/app/q/[token]/__tests__/page.test.tsx:339,977,1031,1062`
- Test: `src/server/usecases/__tests__/quick-match-home.test.ts`, `quick-match-admin.test.ts`, `src/components/quick-match/__tests__/continue-card.test.tsx`, `src/app/admin/quick-matches/__tests__/quick-matches-page.test.tsx`

**Interfaces:**
- Produces: `export type QuickMatchPhase = "settled" | "live" | "ready" | "waiting" | "notPlayed"`. `phaseOf` maps `status === "cancelled"` to `"notPlayed"`, checked FIRST (before settled).
- Produces: `playedOf(rows): { played: number; notPlayed: number; total: number }`, where `notPlayed` counts non-bye rows with status `cancelled`. `total` is unchanged (all non-bye rows: §6 "M stays the full total").
- Produces: `export function isQuickMatchFinished(c: { played: number; notPlayed: number; total: number }): boolean` returning `c.total > 0 && c.played + c.notPlayed === c.total`.
- Produces on `QuickMatchHome`: `notPlayed: number` and `finished: boolean` (= `isQuickMatchFinished`). `allPlayed` is REMOVED: its name would lie. `RecentQuickMatchWithCounts` and `MyQuickMatch` gain `notPlayed: number`.
- Produces: `quick-match-admin.ts` drops its own `isFinished` and calls `isQuickMatchFinished`. `QuickMatchAdminRow` gains `notPlayed: number`.
- Produces: `splitRecent` resumes the first row where `!isQuickMatchFinished(row)`.

- [ ] **Step 1: Write the failing tests.**
  - Pure (`quick-match-home.test.ts`, no DB section). Each case builds `MatchLineRow`s by hand, with statuses from `FIXTURE_STATUSES`. Expected numbers are counted by the test from the rows, never from `playedOf`:
    - `[decided, cancelled, scheduled]` → `{played:1, notPlayed:1, total:3}`, not finished.
    - `[decided, cancelled]` → finished.
    - `[cancelled, cancelled]` → `{played:0, notPlayed:2}`, finished (the no-play case).
    - `[]` → not finished: **state the empty case first**.
    - A bye row with status `forfeited` is excluded from all three counts.
    - "Finished, then Add a match": append a `scheduled` row to a finished set → not finished (Review Focus 5).
    - Anti-vacuity: assert the case table's length.
  - `phaseOf` for every value of `FIXTURE_STATUSES` (sweep the list, assert the count is 8). `cancelled` → `notPlayed` whatever its seats; the other statuses keep today's phases.
  - DB (`quick-match-home.test.ts`): create a league of 3 with `createQuickMatchAnyFormat`. Play match 1 with `playToDecided`. Set match 2 to `cancelled` by raw SQL (the test names that this stands in for T3's writer; T3 drives the real one). `readQuickMatchHome` gives `played 1`, `notPlayed 1`, `total 3`, `finished false`, and match 2's phase `notPlayed`. Cancel match 3 → `finished true`, and `next` null.
  - Admin (`quick-match-admin.test.ts`): a row with `decided 1`, `notPlayed 2`, `total 3` counts as finished in the stats. Mutate: revert to `decided === total` → red.
  - Continue card: two recent rows. The newer is finished by skips (`played 1, notPlayed 1, total 2`), the older is open. `resume` is the OLDER one. With every row finished, `resume` is null.
  - Admin page test: the cell reads `1 of 3 · 2 not played` when `notPlayed > 0`, and `1 of 3` when it is 0. The Finished hint reads `every match played or not played`.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement** the signatures above. In the existing `played < total` callers, nothing else changes. The renamed `finished` keeps `home.tsx`'s two reads compiling. T4 owns everything else in `home.tsx`.
- [ ] **Step 4: Verify** the 5 test files pass and tsc passes on the changed files. **Mutate once each:** delete the `cancelled` branch of `phaseOf` → the status sweep goes red (it falls back to `waiting`); make `isQuickMatchFinished` ignore `notPlayed` → the finished-by-skips cases go red; drop `total > 0` → the empty case goes red.
- [ ] **Step 5: Commit** `feat(quick-match): a Not played match counts as done; one finished predicate for home, continue card and admin`.

---

### Task 3: Skip and Put back: the usecase and its two routes

**Files:**
- Create: `src/server/usecases/quick-match-skip.ts`
- Create: `src/app/q/[token]/skip/[fixtureId]/route.ts`, `src/app/q/[token]/put-back/[fixtureId]/route.ts`
- Test: `src/server/usecases/__tests__/quick-match-skip.test.ts` (DB), `src/app/q/[token]/__tests__/skip-route.test.ts` (both routes, usecase mocked)

**Interfaces:**
- Consumes: T1's `QUICK_MATCH_ERRORS.{NOT_SKIPPABLE, LEAGUE_FINISHED, NOT_FOUND, LEAGUE_ONLY, EXPIRED, ACTION_FAILED}` and `routes.quickMatch`; T2's `playedOf`, `isQuickMatchFinished`; `resolveQuickMatchToken`, `QuickMatchRow` (`quick-match-home.ts`); `foldFixture(tx, fixtureId): Promise<FoldedFixture | null>` (`engine-db/fold.ts:205`, imported from the module directly; the `engine-db/index.ts` barrel exports only its type); `fixtureStatusFromFold` (`engine-db/append-event.ts:188`); `rateLimit`, `MUTATION_LIMIT` (`lib/rate-limit.ts:116`); `touchQuickMatchActivity`.
- Produces: `skipQuickMatchFixture(row: QuickMatchRow, fixtureId: string): Promise<{ changed: boolean }>` and `putBackQuickMatchFixture(row: QuickMatchRow, fixtureId: string): Promise<{ changed: boolean; status: string }>`.
- Checks, in this order (each throws `HttpError` with its code before the next runs). The order is the same for both:
  1. the rate limit `qm-skip:<row.id>` (a code-less 429);
  2. `assertUuid(fixtureId)` → 404 `NOT_FOUND`;
  3. one `withTenant(QUICK_MATCH_SYSTEM_ORG_ID)` transaction. Take the `fixture:<id>` advisory lock FIRST (D1). Then read the fixture joined to its division and stage, `where f.id = $1 and d.competition_id = row.competitionId`. No row → 404 `NOT_FOUND` (the per-match check, P11). `row.format !== "league"` or the stage kind is not `league` → 422 `LEAGUE_ONLY`. A bye row (`isBye`) → 404 `NOT_FOUND`.
  4. **Skip:** status `cancelled` → `{changed:false}` (D3). Status not in `scheduled|in_play` → 422 `NOT_SKIPPABLE`. Otherwise run the conditional update (D1) → `{changed:true}`.
     **Put back:** status not `cancelled` → `{changed:false, status}` (D3). Read the stage's fixtures (the `MatchLineRow` columns, in the same tx). `isQuickMatchFinished(playedOf(rows))` → 422 `LEAGUE_FINISHED`. Otherwise `foldFixture`: null → `scheduled`; an outcome → throw `Error` (D2's guard); else `fixtureStatusFromFold(...)`. Update with `where status = 'cancelled'`.
- Routes: copy `add-match/route.ts` exactly in shape. `POST`, `handler`, trim the token, `home = routes.quickMatch(encodeURIComponent(token))`, `resolveQuickMatchToken` → null: 303 bare home. The usecase, then a best-effort `touchQuickMatchActivity` (D5), then 303 bare home. `REFUSALS` (closed list): 429 → `ACTION_FAILED`; 404 `NOT_FOUND`; 422 `LEAGUE_ONLY`; 422 `NOT_SKIPPABLE`; 422 `LEAGUE_FINISHED`. Anything else is a fault: Sentry + log, then `?e=ACTION_FAILED`. The header comment states the order and the authorisation (the token is the credential; anyone with the link, §3, call 3).

- [ ] **Step 1: Write the failing DB sequence tests** (`quick-match-skip.test.ts`). Build each league through `createQuickMatchAnyFormat`, score through `scoreEvent` with `firstRallyFor` and `playToDecided` (`_quick-match-probe.ts`), and read back through `readQuickMatchHome`. Expected counts come from the rows the test made.
  1. **skip → put back → score:** a league of 3 with match 1 scheduled. Skip → `{changed:true}`, `fixtures.status` is `cancelled`, `finished_at` is not null, and the home shows phase `notPlayed`, `notPlayed 1`. Put back → `scheduled`, `finished_at` null. Then `playToDecided` → `decided`, and the stored standings name one played match for each of its two sides.
  2. **skip partially scored:** after `firstRallyFor` (one rally), snapshot the `score_events` rows and `match_states.state/summary`, and `getStandings(...).rows`. Skip. The snapshots are deep-equal after the skip and after a put back, the standings rows are deep-equal to before, and put back gives `in_play` (D2: derived, so assert it equals `fixtureStatusFromFold` over that fold, the engine's own rule).
  3. **a pad tap after a skip** (Review Focus 1): skip an `in_play` match, then `scoreEvent` with the next rally → `EngineError` `ALREADY_DECIDED`, and the `score_events` count is unchanged.
  4. **skip the last match → winner:** a league of 3. Play matches 1 and 2 (the same side wins both), skip 3 → `finished true`. The leader is that side (its points from the stored table, not computed here).
  5. **skip all → no play:** a league of 2 (one match). Skip → `finished true`, `played 0`, and the stored table is level (`isLevelTable` true).
  6. **refuse finished:** skip a `decided` match → 422 `NOT_SKIPPABLE`, status unchanged.
  7. **refuse put back after finish:** from case 4, put back match 3 → 422 `LEAGUE_FINISHED`, still `cancelled`.
  8. **second taps:** skip twice → the second is `{changed:false}` with one status write (assert `finished_at` unchanged between the two). Put back twice → the second is `{changed:false}`.
  9. **Edit result reopens:** decided → `scoreEvent` `core.void` of the deciding event → `in_play` → skip succeeds.
  10. **per-match check:** a fixture id of ANOTHER quick match → 404 `NOT_FOUND`, and the other match is untouched. A non-uuid → 404.
  11. **sport sweep** (P14, Review Focus 2): for every `sport_key` in `quick-match-offer.generated.json` `offered` (dedup; the test asserts the count is 9 and is > 0): a league of 2, one rally, skip, put back. `match_states` is deep-equal across, the status returns to the fold's own, and the table is unchanged. Report the count of sports checked.
  12. **knockout row (legacy):** `createQuickMatchAnyFormat(format:"knockout")` → skip → 422 `LEAGUE_ONLY`.
- [ ] **Step 2: Write the failing route tests** (`skip-route.test.ts`, with the usecase and the token read mocked, as `add-match-route.test.ts` does). Success → 303 to the bare home and one touch. Each REFUSALS row → 303 `?e=<code>`, not reported. An unknown error → `?e=QUICK_MATCH_ACTION_FAILED`, reported to Sentry once. An unknown token → 303 bare home, with no usecase call. A failed touch still → 303 home. Run every case on both routes (assert both arrays are non-empty and equal in length).
- [ ] **Step 3: Run them.** They fail (the module is missing).
- [ ] **Step 4: Implement** `quick-match-skip.ts` and the two routes.
- [ ] **Step 5: Verify** both test files pass and tsc passes on the changed files. **Mutate once each:** (a) drop `status in ('scheduled','in_play')` from the skip guard → case 6 goes red; (b) make the put back finished check `false` → case 7 goes red; (c) move the advisory lock after the read (code review only: not testable deterministically; record it); (d) remove the competition predicate → case 10 goes red.
- [ ] **Step 6: Commit** `feat(quick-match): mark a league match Not played and put it back, from the home link`.

---

### Task 4: The home: ⋯ menu, confirm sheet, Not played rows, finished-by-skips and no-play

**Files:**
- Create: `src/components/quick-match/row-menu.tsx` (`"use client"`: the `<details>` menu plus the `<dialog>` confirm, D7)
- Modify: `src/components/quick-match/home.tsx` (the view model `buildHomeView` `:212-411`, `FLASH` `:108-120`, the body `:485-557`)
- Modify: `src/components/quick-match/match-list.tsx` (`listOrder` `:60`, `rowEnd` `:154-187`, `MatchView` `:24`)
- Modify: `src/components/quick-match/standings.tsx` (caption and title props)
- Modify: `src/components/quick-match/my-list.tsx:180` (the line with skipped)
- Modify: `src/app/q/[token]/page.tsx:107-161` (slots), `src/app/[lang]/(marketing)/play/page.tsx:95` (the Continue line)
- Modify: `src/lib/__tests__/scrub-secret-painters.test.ts` (`app/q/[token]/page.tsx` handoff list `:526-535`, the painter map, `QUICK_MATCH_PAINTERS` `:552`)
- Test: `src/components/quick-match/__tests__/row-menu.test.tsx` (create), `src/app/q/[token]/__tests__/page.test.tsx`, `src/components/quick-match/__tests__/my-list.test.ts`

**Interfaces:**
- Consumes: T1's keys and `routes.quickMatchSkip/PutBack`; T2's `phase "notPlayed"`, `home.notPlayed`, `home.finished`.
- Produces: `MatchView` gains `skippable: boolean` (league, and phase `ready` or `live`, D8/§6), `putBack: boolean` (phase `notPlayed` and `!home.finished`), `skipCopy: { title: string; body: string; partial: string | null }` (built in `buildHomeView`: `body` is `bodyLast` when this match is the only non-bye match neither settled nor notPlayed; `partial` = `quickMatch.skip.partial` with `{score}` = the row's live `scoreText` when `phase === "live"` and a score exists).
- Produces on `QuickMatchSlots`: `skip?: (fixture: {id: string; n: number}, copy: MatchView["skipCopy"]) => ReactNode` and `putBack?: (fixtureId: string) => ReactNode`. The page fills them with `QuickMatchRowMenu` and a plain Put back `<form method="post" className="ph-no-capture">`.
- Produces: `QuickMatchRowMenu({ skipAction, scoreSlot, labels: { more, notPlayed, notPlayedHint, title, body, partial, confirm, keep } })`. `<details data-testid="qm-row-menu">`, summary ⋯ (`aria-label` = `moreActions`, 44px). The panel holds the row's Score (`scoreSlot`) and a "Not played" `<form method="post" action={skipAction}>` submit (`data-testid="qm-skip"`) with its hint. Hydrated, the submit opens `<dialog data-testid="qm-skip-sheet">` with title, partial (when non-null), body, `qm-skip-confirm` (submits the same form) and `qm-skip-keep` (closes). A double-submit lock plus bfcache unlock is copied from `score-form.tsx`. `ph-no-capture` on both forms.
- Built view (`Built`) gains `noPlay: { kicker: string; title: string; hint: string } | null` (set when `finished && played === 0`) and `winnerNote: string | null` (`winnerAfter` + `winnerSkipped`, joined by a space, when `finished && notPlayed > 0 && played > 0`).
- Behaviour, all from the mockup's sections 1-5:
  - The played line uses `playedSkipped`/`playedSkippedSaved` when `notPlayed > 0`, with `{skipped}` = `plural(notPlayedPart, notPlayed)`; otherwise today's keys.
  - The hero is null when `finished`.
  - The winner card shows when `finished && played > 0` (leaders, as today) plus `winnerNote`.
  - When `noPlay`: the standings are hidden, and a card `data-testid="qm-no-play"` shows the kicker `leagueFinished`, the title `noPlay`, the hint `noPlayHint` (plural on total) and a link `qm-no-play-start` → `routes.quickMatchSetup(locale)` with `quickMatch.dead.startNew`.
  - Standings: the title is `finalTable` when `finished`, else `standings`. A caption `data-testid="qm-standings-note"` reads `countsPlayedOnly` when `notPlayed > 0`.
  - Rows: phase `notPlayed` → dashed border (`border-dashed`), `data-state="notPlayed"`, sides line "A v B", the end shows the `notPlayed` label and, when `putBack`, the Put back form (`qm-put-back`, 44px, outlined like `edit`). `listOrder` = open, then notPlayed, then settled (D8). A knockout row never draws the menu (P12).
  - `FLASH` gains `NOT_SKIPPABLE → quickMatch.flash.notSkippable` and `LEAGUE_FINISHED → quickMatch.flash.leagueFinished` (tone `refusal`).
  - The Continue card and the account list say the skipped variant when `notPlayed > 0` (the home's own words, so the three never disagree).

- [ ] **Step 1: Invoke the `frontend-design` skill.** Read mockup sections 1-5 (layout only; build in the house night theme of `home.tsx`/`match-list.tsx`).
- [ ] **Step 2: Write the failing tests.**
  - `page.test.tsx` (server render, with `QuickMatchHome` literals as the file already builds them):
    - (a) a ready row has `qm-row-menu` with `qm-skip` whose form action `="/q/<token>/skip/<id>"` (anchor on `="`); a settled row and a knockout row have none;
    - (b) a notPlayed row before finish: `data-state="notPlayed"`, the "Not played" text and `qm-put-back` posting `/put-back/<id>`; after finish: the label stays and there is no `qm-put-back`;
    - (c) the played line equals `t(playedSkipped…)` built from the counts in the literal;
    - (d) finished with `played 2, notPlayed 1`: `qm-winner` plus the note, no `qm-hero`, and the `Final table` title;
    - (e) finished with `played 0`: `qm-no-play` with the start link, and no standings, winner or hero;
    - (f) `notPlayed > 0` → `qm-standings-note`;
    - (g) the `bodyLast` vs `body` choice: one open match left → `bodyLast`; two → `body`;
    - (h) a live row with a score → `partial` contains that score text; a ready row → `partial` null;
    - (i) `homeFlash("QUICK_MATCH_LEAGUE_FINISHED")` → the `leagueFinished` key, and the same for `NOT_SKIPPABLE`;
    - (j) the order: open, notPlayed, settled.
  - `row-menu.test.tsx` (the `renderIsland` harness, `components/__tests__/_hook-harness.tsx`): a submit when not hydrated is not prevented (no-script path, D7). Hydrated, the first submit is prevented and opens the sheet (`showModal` stubbed and called once); confirm submits once; a second confirm is prevented (the lock); `pageshow` persisted unlocks.
  - `my-list.test.ts` and the play page: the skipped line when `notPlayed > 0`.
  - `scrub-secret-painters.test.ts`: `row-menu.tsx` is listed `{ verdict: true }` and in `QUICK_MATCH_PAINTERS`, and the page's handoff list includes it.
- [ ] **Step 3: Run them.** They fail.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Verify** the test files pass and tsc passes on the changed files. **Mutate once:** set `putBack` to ignore `finished` → (b) goes red; make `skippable` include `settled` → (a) goes red.
- [ ] **Step 6: Screens owed** (served on :8765 for sign-off, matching mockup frames 1-5): the menu open, the sheet (no score / partial score / last match), after a skip, finished by skips, no play. Each at 320, 768 and 1280, with `scrollWidth <= innerWidth`. These come from CI e2e artifacts (T5) or a local dev capture. Never committed.
- [ ] **Step 7: Commit** `feat(quick-match): Not played from the row menu, Put back, and a league finished by skips`.

---

### Task 5: E2E: the home spec and the seven widths

**Files:**
- Modify: `e2e/quick-match-home.spec.ts` (add tests after `:443`)
- Modify: `e2e/mobile.spec.ts` (the quick match block, from `:8374`)

**Interfaces:**
- Consumes: T4's test ids `qm-row-menu`, `qm-skip`, `qm-skip-sheet`, `qm-skip-confirm`, `qm-skip-keep`, `qm-put-back`, `qm-no-play`, `qm-no-play-start`, `qm-standings-note`, and `data-state="notPlayed"`; the existing `guest` fixture and the setup helper.

- [ ] **Step 1: Add the tests to `quick-match-home.spec.ts`.**
  - "Not played (skip): a league of 4 at 320, 768 and 1280: ⋯ opens, the sheet asks, Keep closes with nothing changed, Mark not played lands the row as Not played with Put back; the played line says 1 not played; 44px targets; no sideways scroll".
  - "Put back: the row returns with Score, and Score lands in the pad on that match".
  - "Finished by skips: play 1 match of a league of 3 through the pad, skip the other 2 → winner card, Final table, no Put back; a stale Put back post (fetch with the old action) lands `?e=` and shows the leagueFinished line".
  - "No play: a league of 2, skip its only match (the sheet shows the last-match body) → qm-no-play, no table; Start a new quick match goes to /<lang>/play".
  - Use `elementFromPoint` for hit-testing the ⋯ and the sheet buttons (AGENTS.md class 2), not `boundingBox` alone.
- [ ] **Step 2: Extend `mobile.spec.ts`** with one test in the quick match block: at this width, a league of 3, open ⋯ on a row, open the sheet. The sheet and its two buttons are fully on screen (not clipped, `qmNotClipped`), there is no horizontal scroll, the buttons are at least 44px, and a hit-test lands on each. Confirm, then the Not played row and Put back hold at this width. Count and assert the elements scanned (anti-vacuity).
- [ ] **Step 3: Run the WHOLE two spec files** (never a `-g` slice; AGENTS.md class 21) in CI: push, then `gh workflow run e2e.yml --ref feat/quick-match-skip`. Treat a serial-file red as a floor and re-run after each fix.
- [ ] **Step 4: Commit** `test(quick-match): e2e for Not played, Put back, finished by skips and no play, at every width`.

---

### Task 6: Walkthrough (E): a night where matches can't be played

**Files:**
- Modify: `e2e/walkthrough/quick-match.spec.ts` (a new test after `(D)`, `:1090`)

- [ ] **Step 1: Add the test.** "(E) a guest's league of three loses two matches: one skipped mid-rally and put back, then both skipped, the league finishes on the one match played and names its winner; a second league of two is skipped entirely and says no matches were played". At 390, every action by tap: the pad rallies by tap; ⋯ → Not played → Mark not played; Put back; Score again resumes at the same score. Read the final state from the DB (`fixtures.status`, the `score_events` count unchanged by the skip) as well as the screen. Assert the winner is the side the walkthrough made win (derived from the taps it made).
- [ ] **Step 2: Run the whole walkthrough file in CI** (the dispatch above).
- [ ] **Step 3: Commit** `test(quick-match): walkthrough E, skipped matches end a league`.

---

### Task 7: Smoke: skip and the finished refusal on a real server

**Files:**
- Modify: `scripts/smoke/suites/quickMatch.ts` (a new step after the live match, `:114+`, using the existing `createMatch`, `own`, `page`, `testidText`, `words`)

- [ ] **Step 1: Add the step.**
  1. Create a tagged league of 2.
  2. Read the skip action from the home HTML (`action="/q/qm_…/skip/<uuid>"`).
  3. POST it → 303 to the bare home.
  4. The home's `qm-played` equals `words("quickMatch.home.playedSkipped.one", …)` built from `played 0, count 1`, and `qm-no-play` is present.
  5. POST put back → 303 with `?e=QUICK_MATCH_LEAGUE_FINISHED`.
  6. The DB status is `cancelled`.
  Each `check(...)` names what it got. Teardown goes through the existing `made` list. The target guard stays local/CI only.
- [ ] **Step 2: Run the smoke suite locally** against a local prod server (the `seazn-local-env` recipe), or leave it to the PR's smoke CI. Record which.
- [ ] **Step 3: Commit** `test(smoke): quick match skip lands Not played and refuses put back after finish`.

---

## Self-review notes

- **Spec coverage:** §3 who/what/undo/edge → T3 (server), T2 (counts), T4 (screens). §3 knockout never skippable → T3 case 12, T4 (a). §4 copy ×4 → T1. Mobile-first → T4, T5. Sequences → T3 1-9. E2E, walkthrough and smoke → T5-T7. Admin → T2. §6 calls: the ⋯ menu + sheet (T4), "N of M played · K not played" with M full (T2/T4), Put back hidden after finish + the stale-tap copy (T3/T4), no play hides the table + new quick match (T4), finished not skippable (T3 case 6).
- **Proportion:** no function bodies beyond the lock/update order and the fold derivation that the signatures cannot determine.
- **Type consistency:** `isQuickMatchFinished`, `playedOf` → `{played, notPlayed, total}`, `QuickMatchPhase "notPlayed"`, `routes.quickMatchSkip/PutBack`, `QUICK_MATCH_ERRORS.NOT_SKIPPABLE/LEAGUE_FINISHED` are used with the same names in T1-T7.

## Open questions for the owner (the plan proceeds on the PO rec; each is reversible)

1. **Put back on a partly scored match (P15):** the rec restores it as it was (live at 8–5). The alternative is to return it unplayed with the 8–5 voided in the ledger. The spec says "restores it to unplayed"; the mock says "reappears with Score".
2. **The last open match (D6):** the rec warns in the sheet that the league finishes and the skip can't be put back. The alternative is to allow Put back of the match that finished the league, which would amend §6.
