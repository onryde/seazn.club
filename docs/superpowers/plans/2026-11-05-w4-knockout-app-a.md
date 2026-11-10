# W4 Knockout — App PR A (no engine change) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship every W4 knockout-family behaviour that lives in seazn.club and needs no `@onryde/seazn-engine` release (design §6.2, every row): one "started" predicate, byes off the courts, Rebuild by bracket role, a shared position-keyed bracket reconcile, a random stored draw, late entry after Start with automatic arrivals waiting on a desk flag, the lucky loser, stale knockout sources, format gates, the standalone stepladder/page-playoff refusal and their withdrawal fixes, the AN-1/AN-2 guards, the bracket tiles and the finished-bracket public surfaces, plus the matrix and test debt that rides with them.

**Architecture:** All work is in `apps/web` and `tools/matrix`, plus one companion docs commit in the engine repo after merge (Task 26). Client-safe pure modules (`lib/bracket-role.ts`, `lib/bracket-reconcile.ts`, `lib/knockout-late-entry.ts`, `lib/lucky-loser.ts`, `lib/knockout-refusals.ts`, `lib/format-size-gates.ts`, `lib/stage-standalone.ts`, `lib/bye-line.ts`) hold every decision the UI shows or the matrix reads, because `apps/web` vitest is node-only. The server applies them: a new `server/usecases/bracket-lines.ts` owns the three line surgeries (reopen a bye, reverse a walkover, vacate to a bye) that both the pre-Start reconcile (Task 8) and late entry (Tasks 10–11) use, so the two cannot disagree about what a bracket line is. The reconcile takes a per-format identity function (knockout: round counted from the final, index in round) — the seam W5 extends to round-robin without touching the driver.

**Tech Stack:** TypeScript 7 / Node 26, Next.js (the repo's non-standard version: read `node_modules/next/dist/docs/` before adding the Task 11 route), postgres.js, zod, vitest (JSON reporter), Playwright (CI dispatch only), Flyway deltas.

**Spec:** `docs/superpowers/specs/2026-11-04-format-matrix-w4-knockout-design.md` (APPROVED, ruling 274; X-CH-5 narrowed by ruling 275). Scope: §6.2, every row; §4, §5.4 (draw), §5.5, §6.5, §6.6 (the PR-A share), §7 (AN-1, AN-2 app half). Signed rulebook: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W4-knockout.md` — the source of every expected value below. Programme rules: `_RULES.md` beside it; brief `W4-knockout.md` (traps 1–5). Rule rows (signed, awaiting proof): engine worktree `/Users/ashokhein/github/seazn.club.engine-worktrees/w4-rule-rows` `rules/cross-sport.md`; 39 `AWAITING_PROOF` entries valued "W4 app PR A" (`test/rules-reference.ts:56-72`). Recon with file:line at 97d22c8acd: `/Users/ashokhein/seazn-artifacts/w4-recon/` (`00-GAP-REGISTER`, `A`, `B`, `E`, `F`); Task 0 copies it into the repo.

**Out of scope (App PR B / engine PR):** every `finalRanks` reader handling ties; the plate's first-loss feed and its proposal after round 2 (so T8-b's allowlist removal — see "Premises found false" 2); the third-place control; Declare joint winners and the automatic vacant title; Q8 history re-rank; L3 re-baseline (T8-d, beyond what Task 16 forces); the full per-row e2e and the badminton doubles walkthrough; bench gates (recorded ⏳). K11 and K24 are W9's; D4 is the clubs follow-up (ruling 272); QM-1 and K6 are refused, not built.

---

## Batch status (the owner tracks this table)

| Batch | Tasks | Gaps closed | Rule ids proved | Status |
|---|---|---|---|---|
| B0 Pre-flight + R24 options | 0, 1 | — (census for V492/V493; owner layout picks) | — | ⏳ |
| B1 Started + integrity | 2, 3, 4, 5, 6 | K4, K2, K3, K1, AN-2 (app half) | X-LE-9, X-CH-2, X-CH-5 | ⏳ |
| B2 Draw + reconcile | 7, 8 | K5, FX-G17 (half), FX-G2, WD-CASC (500 half: MB-004/005) | X-SD-1, X-SD-2, X-SD-6, X-SD-7, X-SD-8, X-SD-9, X-SD-10 | ⏳ |
| B3 Late entry (server) | 9, 10, 11, 12 | LE-1, LE-2, K7, K13, T8-e, T8-a | X-LE-1 … X-LE-8, X-LE-10 … X-LE-13 | ⏳ |
| B4 Qualifiers + gates | 13, 14, 15 | K9, FX-G16, FX-G18, FX-G14 (gate half), QM-2 | X-LL-1 … X-LL-5, X-QM-1 … X-QM-5, X-PL-1 | ⏳ |
| B5 Stepladder / page playoff + wording | 16, 17, 18 | SP-UI, FX-G7, SL-1, K12 | X-SP-3 … X-SP-7 | ⏳ |
| B6 Desk + public UI | 19, 20, 21, 22, 23 | LE-1 (UI), K7 (flag UI), K5 (seed shown), AN-1, N-1, ST-G7, ST-G26 | X-CH-8 | ⏳ |
| B7 Matrix + test debt | 24, 25 | T8-c (PR-A share), T8-f, T8-g, stale triage rules, MB fence | — | ⏳ |
| B8 PR + rule rows | 26 | — | (companion engine proof commit for all 39) | ⏳ |

LIKELY / UNVERIFIED gaps (K1, K2, K3, K4, K7, K13, QM-2, SL-1, FX-G7 on a final stage, AN-1/AN-2 on main) open with a driving test that proves the defect. **If that test passes on today's main, the task records "no defect, pinned" in its commit body and in `_INDEX.md` "False premises found (W4)", keeps the test as the pin, and stops** — no fix is written for a defect nobody saw.

---

## Global Constraints

- **Worktree:** `/Users/ashokhein/github/seazn.club-worktrees/w4-app-a`, branch `feat/w4-knockout-app-a`, cut from fresh `origin/main` after this plan's docs PR merges. Never write in `~/github/seazn.club` (its `node_modules/@seazn/engine` points at an untracked `packages/engine/`; design §3). Never `git stash` (the stack is shared). `$WT` = that worktree. `$S` = the executor's own scratchpad subdirectory (`<scratchpad>/w4a-<task>/`); never `rm` outside it. Shell cwd resets between calls: prefix every command with `cd $WT/... &&`.
- **Re-pin first.** Line numbers below were read at 97d22c8acd (recon re-pinned 2026-11-04 and spot-checked 2026-11-05). Every task opens its cited lines before editing (AGENTS.md class 5). A moved pin is not a finding; a changed behaviour is — record it in the commit body.
- **Environment:** the `seazn-local-env` skill: fresh DB, `db:apply`, then `sync:sports`; confirm `show data_directory` is yours. DB-backed suites are red without it, and that red is environmental.
- **Scoped vitest only** (never the full suite, gate or e2e locally):
  - `VERIFY-WEB <name> <files…>` = `cd $WT/apps/web && npx vitest run <files…> --reporter=json --outputFile=$S/<name>.json; echo EXIT=$?`, then `node -e 'const r=require(process.argv[1]);console.log(r.numPassedTests+"/"+r.numTotalTests);for(const t of r.testResults)console.log(t.status,t.name)' $S/<name>.json`.
  - **Green** = `EXIT=0`, passed = total, total > 0, every listed file in `.testResults[].name` under `$WT`.
  - Positionals are literal filename filters: whole files only. Never an empty list (zsh then runs the FULL suite). Never through `rtk`. Never `--root`.
  - `VERIFY-MATRIX <name> <files…>` = the same from `$WT/tools/matrix` with its own vitest config.
- **tsc:** `cd $WT/apps/web && npx tsc --noEmit -p .` (and `cd $WT/tools/matrix && npx tsc --noEmit -p .` when matrix files change), never through `rtk`.
- **Lint:** `cd $WT/apps/web && rtk proxy npm run lint`; read `✖ N problems`; it must not rise.
- **Status literals:** a task that edits a fixture-status literal set adds `src/lib/__tests__/status-set-sweep.test.ts` to its VERIFY-WEB and re-keys `status-set-ledger.ts` if anchors moved.
- **OpenAPI:** a route or schema change runs `npm run openapi:gen` in `$WT`, then `git status --porcelain openapi/`; only the intended change may appear, and it is committed.
- **Locale (R23):** every new string goes into all four `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then `npm run i18n:gen-keys` and `npm run i18n:check`. Never hand-edit `lib/i18n-keys.ts`. Refusal copy: an English sentence beside its code in `lib/knockout-refusals.ts` (Task 3 creates it, modelled on `lib/swiss-refusals.ts`), plus a `knockout.refusal.<CODE>` key the desk renders.
- **Migrations:** `db/migration/deltas/V<next>__<name>.sql`; the highest on main at pin is **V491** (`V491__divisions_org_id_index.sql`), so this plan expects **V492** (Task 3) and **V493** (Task 11). Re-check on `origin/main` at task time. **Renumbered 2026-11-09** (lane merge, merge-lanes-1): R4's `V492__sponsor_rotation.sql` reached main first, so Task 3's delta is now **V493** (`V493__w4_bracket_bye_lines_off_court.sql`) and Task 11's **V494** (`V494__w4_entrants_knockout_waiting.sql`); task headings and commit messages below keep the numbers they were written with. A data-moving migration carries a `-- DATA CHANGE (LOUD)` header, is listed in the PR body's "Data changes", runs pre-deploy, and never ships a compat shim.
- **Tests (TEST-STRATEGY.md; `_RULES.md` R9/R13/R15/R17/R25/R27/R28): all four types per task.**
  - **Unit:** vitest, DB-backed (`describe.runIf(HAS_DB)`) wherever SQL is involved.
  - **E2E:** a `test.describe` per task in `apps/web/e2e/w4-knockout-app-a.spec.ts` (Task 2 creates it), run only by CI dispatch.
  - **Smoke:** counted checks in `scripts/smoke/suites/w4KnockoutA.ts` (Task 2 creates it; `EXPECTED_CHECKS` grows by each task's "+N"; 24 at the end).
  - **Regression:** the task's first test fails on today's main for the gap it closes.
  - **Expected values** come from the rulebook (cite the RB4 id in the assertion message) or the engine's declarations (`generateSingleElim`, module `entrantModel`), never from the app code under test.
  - **Anti-vacuity:** every sweep asserts its count > 0, prints it, and — where the axes are enumerable — equals the product.
  - **Mutation:** mutate each new guard once (delete the predicate / `return true`), see a named test go red, restore, record `mutant → killer test` in the commit body. Two guards covering for each other are mutated one at a time.
  - **Sequence (R27):** every late-entry, reconcile and lucky-loser task covers a second call, an empty input, after a withdrawal or void, after an Undo, and a second sport (badminton plus one of football/chess, chosen by `sportFor` from engine declarations).
  - **Seats, never shell counts:** assertions name who plays whom (`home_entrant_id`/`away_entrant_id`), never "the stage completed" (brief trap 3).
- **Rule ids:** each task names the rows it proves. Its proving test's `describe`/`it` title carries the id as a whole token (`X-LE-3 …`). Never put `-KO-` in an id or a title token. The table at the end maps all 39.
- **Read before touching:** attention/phase code (`lib/division-phase.ts`) → `docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md` and `_RULES.md` (a red attention outranks the phase; state the empty case first). Rail/fixture-console at a phone width → `docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md`.
- **UI tasks (19–23, and 15's builder line):**
  - Blocked on the owner's pick from Task 1's options page (R24) for every new control or new visual. Invoke the `frontend-design` skill first; house theme (mocks are layout only).
  - Mobile-first: one DOM, `max-md:*` branches; no second phone tree.
  - Verify at 1280, 320 and 768 with no horizontal page scroll; compare the control SET at 320 against 1280. Screenshots go to the local sign-off server on `:8765` with a per-screen verdict, and a copy under `~/seazn-artifacts/w4-app-a/` — never into the repo, never an Artifact.
  - A new rail control: grep `apps/web/e2e/mobile.spec.ts` for the rail testids and keep its control-set and clipping scans true.
  - `/admin` is untouched.
- **E2E by CI dispatch only:** `gh workflow run e2e.yml --ref feat/w4-knockout-app-a -f pr=<N>`, at batch ends. Judge the new spec FILE whole, never a `-g` slice. A push cancels a running dispatch. Dispatch, then hand back; the main thread watches the run.
- **Smoke wiring:** one `suite("w4KnockoutA", …)` in `scripts/smoke/main.ts` after the last `await suite(`; the owner `delivered+w4a_${tag}@resend.dev` in `scripts/smoke/harness.ts`'s cleanup list (beside `w3a`); a `SELECTABLE_SUITES` entry in `scripts/smoke/index.ts`. Run `SMOKE_ONLY=w4KnockoutA npm run test:smoke` against a live local server; count must equal `EXPECTED_CHECKS`; zero checked fails.
- **R27 PR body:** `Matrix rows: knockout, knockout_third_place, ko_plate, qualifying_main, stepladder_only, page_playoff_only, league_ko, groups_ko, group_stepladder, group_playoffs, swiss, swiss_knockout, swiss_playoff × all` (this PR touches `stages.ts`, the cut for table sources, and the Swiss started predicate).
- **Never touch:** `packages/engine/**` and the engine repo (except Task 26's companion commit, run by the controller), `stryker-*.json`, the spec and rulebook, `_INDEX.md` rulings (tasks append to "W4 status" and "False premises found (W4)" only; the next free ruling number was 276 on 2026-11-05 — re-check before claiming one).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The PR body ends with the Claude Code line.

## Review Focus

1. **A payment webhook retried into a started knockout** (the same registration confirmed twice). Exactly one entrant, one waiting marker, one desk flag; never two placements. Pinned in Task 11: `X-LE-10 a webhook retry flags one waiting entrant once`.
2. **Two "Add to bracket" taps on two waiting players with one open bye** (a double tap, or two organisers). The first takes the bye; the second gets case (2) or the named refusal; never two newcomers on one line. Pinned in Task 11: `X-LE-10 two taps, one bye: the second never lands on the same line`.
3. **The bye holder's round-2 match called to a court on Match Day but not scored.** That bye is closed to case (1) (it has started, X-LE-9); the add falls to case (2) or (3). Pinned in Task 10: `X-LE-9 a called round-2 match closes its bye to case (1)`.
4. **The late entrant placed by case (1) withdraws before playing.** The line walks over to the former bye holder, who advances into the round-2 seat they held before; ranks and seats agree. Pinned in Task 10: `X-LE-3 sequence: late entry by the bye, then the late entrant withdraws`.
5. **Generate pressed twice with no roster change, and Generate after every entrant withdrew pre-Start.** The second is a no-op that says so; the empty one is a named refusal; neither is a 500 nor "up to date" over an empty bracket. Pinned in Task 8: `X-SD-1 every entrant gone before Start refuses by name` and `FX-G2 a second Generate with no roster change is a named no-op`.

---

## Task 0: Pre-flight (read-only, controller-run) and recon copy

**Files:** none in the product. `cp -R /Users/ashokhein/seazn-artifacts/w4-recon .superpowers/handoff/2026-11-04-w4` (design "Inputs"), committed with the plan's first code commit. Counts go to `$S/preflight.md`, later quoted in the PR body and an `_INDEX.md` "W4 status" note.

- [ ] **Step 1: stg (standing read OK).** URL from the commented `REMOTE_DATABASE_URL` in `seazn.club/.env.local:9`, passed by env only (never argv, logs or chat); `default_transaction_read_only=on`, `search_path=seazn_club`. Counts, each grouped by division id and sport:
  1. Bracket bye lines holding a slot: fixtures of `kind in ('knockout','double_elim','stepladder','page_playoff')` stages that are a system bye (`outcome->>'reason'='bye'`, one seat) or a pre-award bye line (`status='scheduled'`, `outcome is null`, a slot label key `bye`), with `scheduled_at` or `court_id` not null. → Task 3's V492 clears them; quote the count.
  2. Active entrants of a started division whose root knockout has fixtures and who are seated in none of them (K7 evidence). → Task 11's V493 backfills these as waiting (LOUD) if > 0.
  3. Bracket stages not `complete` whose final (`isFinal` row) is decided (AN-1 shape).
  4. Bracket stages `complete` with any fixture in a pending status (AN-2 shape).
  5. Standalone `stepladder` / `page_playoff` stages (`progression is null`). Task 16's refusal applies to new creates only; these keep running (X-LE-8 reaches them).
  6. Progressions whose source is a knockout stage and whose `rankRange` width is not a power of two (X-QM-2). Refused only at create/patch; quote the count.
- [ ] **Step 2: prod.** Ask the owner in chat for an OK and the connection route (prod reads need it; the census was his). Run counts 1, 3 and 4 only, one statement, against prod's schema version. If the owner declines, the PR body says "prod not read" and the migrations stay idempotent.
- [ ] **Step 3: Decide and record.** Count 2 > 0 → V493 carries a LOUD backfill. Count 3 > 0 on main's code → Task 21 is a live fix, else a pin. Count 4 > 0 → AN-2's repair is the owner's call at deploy (design §7), noted in the PR body.

## Task 1: R24 options page for PR A's new UI (owner picks before any UI task builds)

**Why:** R24 / design §11 "the R24 options page for every new control": the late-entry notices and the "late player waiting" flag with its tap, the draw-seed line, the AN-1 Complete-competition warning with its "Complete stage" offers, the Knockout + Plate below-4 reason line in the builder, and the bracket-only OG card (designer's call 21). The third-place control and Declare joint winners are PR B's.

**Files:** none in the repo. A static page served from the local sign-off server on `:8765` (copy in `~/seazn-artifacts/w4-app-a/r24/`), built with the `frontend-design` skill in the house theme.

- [ ] **Step 1:** For each of the six items, at least two layouts, each drawn at 1280, 768 and 320. Candidates (designer's, for the page, not decisions):
  - Waiting flag: (A) an amber attention row on the desk plus a per-entrant "Add to bracket" button in the stage card's notice strip; (B) a chip on the Entrants tab row ("Waiting — add to bracket") plus the desk attention row linking to it.
  - Late-entry notices: (A) one toast line per case; (B) the Swiss late-entry notice block (`lib/swiss-late-entry-notice.ts`) reused with knockout lines.
  - Draw seed: (A) a muted "Draw #<seed>" line under the stage header; (B) inside the stage card's More → "About this draw".
  - AN-1 warning: (A) an inline warning panel under the status select listing open stages, each with "Complete stage"; (B) a confirm dialog on choosing Completed.
  - Plate reason: (A) the Knockout + Plate card shown disabled with "Needs at least 4 entrants"; (B) the card hidden and one line under the grid naming it.
  - Bracket-only OG: (A) champion name large with the trophy glyph; (B) champion plus runner-up line.
- [ ] **Step 2:** Post the link in chat with a recommendation per item (owner value stated). Record the owner's picks in `$S/r24-picks.md` and the PR body. Tasks 15 (Step 6), 19, 20, 21 and 23 read this file; none starts its UI step before the pick exists.

---

## Task 2: One "started" predicate — score, live, decided, or a Match Day call (K4)

**Rules:** X-LE-9.
**Gap:** K4 (LIKELY). Take-back re-seats a called match (`server/engine-db/fed-seats.ts:167-169` `hasStarted` ignores calls; used at `:450-452,460-463`); Rebuild's guard and drift counts ignore calls (`stages.ts:4317-4335`, `:4136-4146`) while calls cascade on delete (`V484__match_day_fixture_calls.sql:20`).

**Files:**
- Create: `apps/web/src/server/usecases/fixture-started-sql.ts`.
- Modify: `apps/web/src/server/usecases/swiss-rounds-admin.ts:97-125` (`swissBoardStartedSql` delegates to the new predicate; its doc comment moves with it); `apps/web/src/server/engine-db/fed-seats.ts` (`Node` + its loader + `hasStarted`); `apps/web/src/server/usecases/stages.ts` (Rebuild's result guard `:4317-4335`).
- Test: `apps/web/src/server/usecases/__tests__/fixture-started.test.ts`; extend `apps/web/src/server/usecases/__tests__/knockout-void-unfill.test.ts` and `rebuild-one-transaction.test.ts`.
- Create (shared harnesses): `apps/web/e2e/w4-knockout-app-a.spec.ts` (modelled on `e2e/w3-swiss-app-a.spec.ts`), `scripts/smoke/suites/w4KnockoutA.ts` (modelled on `suites/w3SwissA.ts`) plus its wiring.

**Interfaces:**
- Produces:
  - `fixtureStartedSql(tx: Tx, on = "f")` — the four arms of today's `swissBoardStartedSql` (result/evidence, external play, a live call via `liveCallSql`, decided-but-not-a-bye), with the bye exemption widened from `swissByeShellSql` to `systemByeSql(tx, on) or swissByeShellSql(tx, on)`. Keeps the alias guard (`LIVE_CALL_ALIASES`).
  - `stageHasStarted(tx: Tx, stageId: string): Promise<boolean>` = any fixture of the stage matching `fixtureStartedSql`.
  - `fed-seats.ts` `Node` gains `called: boolean` (a live call holds); `hasStarted(t)` adds `|| t.called`.
- Consumes: `liveCallSql`, `LIVE_CALL_ALIASES` (`match-day-call.ts`), `systemByeSql` (`engine-db/system-bye-sql.ts`).

- [ ] **Step 1: Driving tests (regression, red on main if K4 is real).**
  - `X-LE-9 take-back never re-seats a next match called to a court`: 4-entrant badminton knockout; decide SF1; call the final to a court (Match Day call, no event); void SF1. Assert the final's seats are unchanged and the void answers the take-back refusal the code already uses for a started next match.
  - `X-LE-9 Rebuild refuses a stage whose only start is a live call`: root knockout before results, one R1 match called; `rebuildStageFixtures` refuses `STAGE_HAS_RESULTS` (or the code the guard uses) and the call row survives.
  - Run: `VERIFY-WEB t2a src/server/usecases/__tests__/knockout-void-unfill.test.ts src/server/usecases/__tests__/rebuild-one-transaction.test.ts`. Expected FAIL on both. If either passes, record "K4 half X: no defect" and keep it as the pin.
- [ ] **Step 2: Unit tests for the predicate** in `fixture-started.test.ts`, one row per arm and per exemption: score event; `in_play`; decided; live call; a call that Undo call deleted (not started); a call whose fixture moved court (not started); a system bye (not started); a Swiss bye shell (not started); a device link only (not started). Empty case first: a stage with no fixtures → `stageHasStarted` false. Each row asserts the SQL against the same row through `swissBoardStartedSql` too (equal answers), so the Swiss callers cannot drift.
- [ ] **Step 3: Implement** the module; make `swissBoardStartedSql` a re-export of `fixtureStartedSql`; load `called` in the fed-seats tree query; Rebuild's guard reads `stageHasStarted`.
- [ ] **Step 4: Run PASS:** the Step 1 files, `fixture-started.test.ts`, plus `swiss-rounds-admin.test.ts`, `swiss-late-entry.test.ts` and `swiss-late-entry-matrix.test.ts` (the Swiss consumers). tsc.
- [ ] **Step 5: Mutate** the call arm out of `fixtureStartedSql` → `X-LE-9 Rebuild refuses …` red; drop `|| t.called` → the take-back test red.
- [ ] **Step 6: Harness + E2E + smoke.** Create the spec with describe `X-LE-9 a called match is started`; create the suite with `EXPECTED_CHECKS = 1` (check 1: a called final survives a void of its feeder) and a zero-checked failure; wire `main.ts`, `harness.ts`, `index.ts`; run `scripts/__tests__/smoke-{paths,select,manifest}.test.ts` via VERIFY-WEB.
- [ ] **Step 7: Commit** `fix(w4): one "started" predicate — a Match Day call starts a match (K4, X-LE-9)`.

## Task 3: A bracket bye line never takes or keeps a court (K2) — V492

**Rules:** none of the 39 (the engine-PR row X-SD-5 says "never a fixture on a court"; add `X-SD-5` as an extra title token on the regression test so the engine PR can cite it).
**Gap:** K2 (LIKELY). Setup-path bye lines are inserted `scheduled` with a BYE slot label and no outcome (`stages.ts:4657-4679`, label `:4736-4743`); `isMovable`/`movableFixtureSql` (`schedule.ts:186-210`) exempt only Swiss shells; `awardSeededByes` (`stages.ts:4937-4965`) flips them to `forfeited` without clearing the slot; `forfeited` is in `OCCUPYING` (`schedule.ts:171`); history's `slotTaker` (`history.ts:95`) is Swiss-only.

**Files:**
- Create: `apps/web/src/lib/bye-line.ts`; `apps/web/src/lib/knockout-refusals.ts` (+ `lib/__tests__/knockout-refusals.test.ts`, which pins the table against the four dictionaries, as `swiss-refusals.test.ts` does); `apps/web/src/server/usecases/knockout-refusal.ts` (the thrower, as `swiss-refusal.ts`); `db/migration/deltas/V492__w4_bracket_bye_lines_off_court.sql` (DATA CHANGE, LOUD).
- Modify: `apps/web/src/server/engine-db/system-bye-sql.ts` (add `byeLineSql`); `schedule.ts` (`isMovable`, `heldInPlace`, `movableFixtureSql`, `moveFixture`'s refusal); `history.ts:95` (`slotTaker`); `stages.ts` `awardSeededByes`.
- Test: `apps/web/src/server/usecases/__tests__/bracket-bye-line-slot.test.ts`; `apps/web/src/lib/__tests__/bye-line.test.ts`; `apps/web/src/server/__tests__/w4-migration.test.ts`.

**Interfaces:**
- Produces:
  - `isByeLine(f: { ext_key: string | null; status: string; outcome: unknown; home_entrant_id: string | null; away_entrant_id: string | null; home_slot_label: unknown; away_slot_label: unknown }): boolean` — a Swiss bye shell (`isSwissByeShellExtKey`), a system bye (the TS twin of `systemByeSql`), or a pre-award bye line (`scheduled`, no outcome, one side's slot label key = `BYE_SLOT_LABEL.key`).
  - `byeLineSql(tx, on = "f")` — its SQL twin; `movableFixtureSql` and `slotTaker` use it.
  - `type KnockoutRefusalCode` (union, grown by later tasks), `KNOCKOUT_REFUSALS: Record<KnockoutRefusalCode, { status: 400 | 409 | 422; en: string; key: MessageKey }>`, `knockoutRefusalKey(code)`, `isKnockoutRefusalCode(code)`; first code `BYE_LINE_NOT_PLACEABLE` (422, "A bye is not played, so it never takes a court or a time.").
  - `knockoutRefusal(code, details?)` in `server/usecases/knockout-refusal.ts` → `HttpError`.
- Consumes: `systemByeSql`, `swissByeShellSql`, `BYE_SLOT_LABEL`.

- [ ] **Step 1: Driving test (regression)** `X-SD-5 a knockout bye line placed before seeding keeps no court after the award`: `league_ko` badminton with q=3 (the KO has one bye); auto-schedule the whole division before the league completes; assert the bye line got a court (premise, proves K2's first half), then complete the league and confirm the proposal; assert the now-`forfeited` bye line has `scheduled_at`, `court_id` null and `schedule_locked` false. Run FAIL. If the auto-schedule never placed it, record half 1 as no defect and keep the assertion.
- [ ] **Step 2: Unit tests** `bye-line.test.ts`: every shape both ways (a two-seated award with reason `bye` is not a bye line; a `withdrew` award is not one; an empty-seat orphan bye is one) — empty input first (`isByeLine` of a row with all nulls is false). DB: `byeLineSql` agrees with `isByeLine` on the same rows. `moveFixture` onto a bye line refuses `BYE_LINE_NOT_PLACEABLE`.
- [ ] **Step 3: Migration test** in `w4-migration.test.ts`: seed a bye line with a slot, run V492's statement, assert cleared; run it again, assert idempotent; a real fixture's slot is untouched.
- [ ] **Step 4: Implement.** V492: `update fixtures set scheduled_at = null, court_id = null, schedule_locked = false where <byeLineSql shape> and (scheduled_at is not null or court_id is not null)`, header quoting Task 0's count 1. Wire the predicate into the four call sites; `awardSeededByes` nulls the slot in its `update`.
- [ ] **Step 5: Run PASS:** the three test files, plus `schedule-bye-shell.test.ts`, `stages-schedule-lock.test.ts`, `status-set-sweep.test.ts`. tsc. Locale + gen-keys for the new key.
- [ ] **Step 6: Mutate** the pre-award arm out of `byeLineSql` → Step 1 red; drop the slot nulls from `awardSeededByes` → Step 1 red.
- [ ] **Step 7: E2E + smoke.** Describe `X-SD-5 a bye holds no court on the run sheet`; smoke +1 (a KO bye line after award holds no court).
- [ ] **Step 8: Commit** `fix(w4): a bracket bye line never holds a court (K2); V492 clears stored ones (LOUD)`.

## Task 4: Rebuild carries slots by bracket role; a line that becomes a bye frees its slot (K3)

**Rules:** none of the 39 (extends X-RB-1; title token `X-RB-1`).
**Gap:** K3 (LIKELY). `lib/rebuild-slots.ts:110-135` keys on `(pool, round_no, seq)`; KO `round_no` = round index + 1 (`stages.ts:1275`), so 8→9 lands the old final's slot on a new semi-final; `:153,184-195` exempt only Swiss shells, so a new bye inherits a court.

**Files:**
- Create: `apps/web/src/lib/bracket-role.ts`.
- Modify: `apps/web/src/lib/rebuild-slots.ts` (`carrySlots` takes key functions and a `bye` flag per row); `stages.ts` `rebuildStageFixtures` (`:4200-4400`: pass the knockout role keys and `isByeLine`).
- Test: `apps/web/src/lib/__tests__/bracket-role.test.ts`; extend `apps/web/src/lib/__tests__/rebuild-slots.test.ts` and `rebuild-one-transaction.test.ts`.

**Interfaces:**
- Produces:
  - `bracketRoleKey(row: { pool_id: string | null; round_no: number; seq_in_round: number; ext_key: string | null }, finalRound: number): string` — `${pool}:3p` for a third-place line (`ext_key` ends `-3p`), else `${pool}:${finalRound - round_no}:${seq_in_round}` (the final is `…:0:1`).
  - `finalRoundOf(rows): number` — the highest `round_no` among non-third-place rows.
  - `carrySlots(before, after, keys?: { before: (r) => string; after: (r) => string })`; each row gains `bye: boolean`; a `bye` row neither gives nor takes a slot. Default keys = today's position key, so league, group and Swiss callers are unchanged.
- Consumes: `isByeLine` (Task 3).

- [ ] **Step 1: Driving tests (regression)** in `rebuild-one-transaction.test.ts`:
  - `X-RB-1 knockout 8→9 Rebuild: the final keeps the final's slot`: 8-entrant badminton KO; pin distinct times/courts on every line; enrol a 9th pre-Start; Rebuild. Assert the new final (role `…:0:1`) has the old final's time and court and each semi-final has a semi-final's; the new round-1 lines are unscheduled. Expected FAIL on main.
  - `X-RB-1 knockout 8→6 Rebuild: a line that becomes a bye frees its slot`: assert no bye line holds a court and `slots.freed` counts it. Expected FAIL.
- [ ] **Step 2: Unit tests:** `bracketRoleKey` for 2, 3, 8, 9, 16 entrants against the engine's own `generateSingleElim` output (R9: the engine declares the shape) — final always `0:1`, semis `1:1`/`1:2`, third place `3p`; empty case first (`finalRoundOf([])` throws a named error, a guard not a comment). `carrySlots` with role keys: shrink, grow, equal; a `bye` row never carries.
- [ ] **Step 3: Implement.** In `rebuildStageFixtures`, a `knockout` stage passes the role keys (each side its own `finalRoundOf`); every other kind passes none (add a case asserting a double-elim Rebuild is byte-for-byte today's carry).
- [ ] **Step 4: Run PASS:** the three files plus `stage-roster-drift.test.ts`, `swiss-withdrawal-reconcile.test.ts`. tsc.
- [ ] **Step 5: Mutate:** default the knockout keys back to position → the 8→9 test red; drop the `bye` exemption → the 8→6 test red.
- [ ] **Step 6: E2E + smoke.** Describe `X-RB-1 the final keeps its court across 8→9`; smoke +1 (8→9 Rebuild keeps the final's slot).
- [ ] **Step 7: Commit** `fix(w4): Rebuild carries knockout slots by bracket role (K3)`.

## Task 5: Undo cannot cross a seed confirm (K1)

**Rules:** none of the 39.
**Gap:** K1 (LIKELY). `confirmSeedProposal` (`stages.ts:6548-6556`) fills a `timing:"setup"` bracket through `fillSlot` and writes no ledger row (`:6862-6875` writes one only for a carry); history barriers are Swiss-only (`history.ts:103-106`). An Undo after a confirm may invert the older reversible step and delete the seeded bracket.

**Files:**
- Modify: `stages.ts` `confirmSeedProposal` (append a `seed_confirmed` row under the division lock, without moving the watermark — the `appendLateEntryRow` pattern, `swiss-late-entry.ts:199-214`); `history.ts` (`UNDO_BARRIER_TYPES` gains `seed_confirmed`; its `satisfies` widens to `SwissRefusalCode | KnockoutRefusalCode`; the refusal's message key dispatches by family); `lib/knockout-refusals.ts` (+ `SEED_CONFIRM_NOT_UNDOABLE`, 409, "A confirmed draw can't be undone. Recompute the proposal instead.").
- Test: `apps/web/src/server/usecases/__tests__/seed-confirm-undo.test.ts`.

**Interfaces:**
- Produces: `UNDO_BARRIER_TYPES.seed_confirmed = "SEED_CONFIRM_NOT_UNDOABLE"`; `undoRefusalKey(code: SwissRefusalCode | KnockoutRefusalCode): MessageKey` in `history.ts`.

- [ ] **Step 1: Driving test (regression)** `K1 Undo after a plate confirm`: `ko_plate` n=8 badminton, Main draw played out and completed, proposal confirmed (plate seated). Press Undo. Assert the plate's seats and fixtures are unchanged and Undo answers `SEED_CONFIRM_NOT_UNDOABLE`. Expected FAIL on main (record what main actually did — deleted the plate, or inverted a schedule edit — in the commit body).
- [ ] **Step 2: Sequence cases:** a schedule edit made AFTER the confirm is still undoable (the barrier blocks only stepping across it); Redo across it refuses the same code; `groups_ko` confirm behaves the same (a second format).
- [ ] **Step 3: Implement**, then **Run PASS:** the file plus `history-undo.test.ts` (or the history suite that exercises `undoBarrierRefusal`; grep `undoBarrierRefusal` under `__tests__`), `stage-progression.test.ts`. tsc. Locale + gen-keys.
- [ ] **Step 4: Mutate** `seed_confirmed` out of `UNDO_BARRIER_TYPES` → Step 1 red.
- [ ] **Step 5: E2E + smoke.** Describe `K1 Undo refuses across a confirmed draw`; smoke +1.
- [ ] **Step 6: Commit** `fix(w4): Undo refuses across a confirmed seed proposal (K1)`.

## Task 6: A bracket stage completes only with every fixture decided; the final's walkover and "never decided automatically" pinned (AN-2 app half)

**Rules:** X-CH-2, X-CH-5 (and title token `X-CH-7` on the AN-2 test as the app half of that engine-PR row).
**Gap:** AN-2 (PRESENT in prod data; re-verify on main). `completeStage` (`stages.ts:5683-`) has no undecided-fixture check of its own; the engine guard ships in the engine PR.

**Files:**
- Modify: `stages.ts` `completeStage` (a pre-check for bracket kinds); `lib/knockout-refusals.ts` (+ `STAGE_HAS_UNDECIDED_FIXTURES`, 409, "This bracket still has matches without a result. Finish or settle them first." with `fixture_ids`).
- Test: `apps/web/src/server/usecases/__tests__/bracket-complete-guard.test.ts`.

**Interfaces:**
- Produces: `undecidedBracketFixtures(tx: Tx, stageId: string): Promise<string[]>` — fixtures of a bracket-kind stage in a pending status, excluding `cancelled`, `abandoned` already settled, and `conditional` lines the engine marks unneeded (a double-elim reset not triggered).

- [ ] **Step 1: Driving test (regression)** `X-CH-7 AN-2 a 4-bracket with its final in play cannot be completed`: both semis decided, the final `in_play` with no outcome; `completeStage` refuses `STAGE_HAS_UNDECIDED_FIXTURES` naming the final, and the stage stays `active`. If main refuses already (the AN-2 prod row came from an older tag), record "AN-2: main refuses; pinned".
- [ ] **Step 2: Pins (existing behaviour, R28):**
  - `X-CH-2 one finalist withdraws: the final walks over and the other is champion`: assert the final's outcome is a `withdrew` walkover to the remaining finalist, the stage completes, and `divisionChampion` (`server/public-site/champion.ts`) names them. Run it for an individual (badminton) and a pair (badminton doubles) division.
  - `X-CH-5 an unplayed final is never decided automatically`: an 8-bracket with `auto_progress` on and the final `scheduled`: every pass of `maybeAutoAdvance` leaves it undecided and the stage active; no outcome mentions seed or table. Then an organiser's explicit settle (X-ST-1, on an abandoned final) still decides it — the settle path stays offered.
- [ ] **Step 3: Implement** the pre-check (bracket kinds only: `BRACKET_KINDS`, not league/group/swiss), then **Run PASS:** the file plus `auto-advance-finished.test.ts`, `dead-feeder-cascade.test.ts`, `placement-snapshots.test.ts`. tsc. Locale + gen-keys.
- [ ] **Step 4: Mutate** the pre-check to `return []` → the AN-2 test red.
- [ ] **Step 5: E2E + smoke.** Describe `X-CH-7 Complete refuses an unfinished bracket`; smoke +1 (complete over an in-play final → 409).
- [ ] **Step 6: Commit** `fix(w4): a bracket completes only with every match decided (AN-2 app half; X-CH-2, X-CH-5 pinned)`.

---

## Task 7: The unseeded are drawn at random with the stage's stored seed (K5, FX-G17 half)

**Rules:** X-SD-6, X-SD-7, X-SD-8, X-SD-9, X-SD-10.
**Gap:** K5 (PRESENT): KO generate reads `swissActiveEntrants` ordered `seed nulls last, created_at, id` (`stages.ts:1596-1601`) and the engine keeps input order for the unseeded, so byes go to the earliest registrants.

**Files:**
- Modify: `stages.ts` — the root-knockout branch of `generateStageFixturesTx` (`:3481-`) orders `entrants` through the draw before `generate()` (`:2607`), and the `fixtures_generated` payload records `draw_seed`; `apps/web/src/server/api-v1/schemas/stages.ts` `StageConfig` (`:1230-`) gains `countrySeparation`; `lib/knockout-refusals.ts` (+ `COUNTRY_SEPARATION_NOT_OFFERED`, 400, "Country separation isn't offered: Seazn holds no country for players or teams.").
- Test: `apps/web/src/server/usecases/__tests__/knockout-draw.test.ts`; `apps/web/src/lib/__tests__/stage-config-api-only.test.ts`.

**Interfaces:**
- Produces:
  - `knockoutDrawOrder(stageId: string, active: readonly ActiveEntrant[], cfg: Record<string, unknown>): ActiveEntrant[]` (exported from `stages.ts` for the test): `swissRoundOneOrder(swissDrawSeed(stageId), active)` mapped back to the entrant objects; returns `active` unchanged when `cfg.slotOrder` is an array (X-SD-9) or the stage draws from `config.qualified` (its order is the seeding).
  - `readStageDrawSeed(tx: Tx, stageId: string): Promise<number | null>` — the newest `fixtures_generated` row's `draw_seed` for the stage (Task 20 shows it).
  - `StageConfig.countrySeparation: z.never({ error: COUNTRY_SEPARATION_NOT_OFFERED_MESSAGE }).optional()`; `api-v1/http.ts` answers the named 400 as it does `SWISS_REQUESTED_BYES_DEFERRED`.
- Consumes: `swissDrawSeed`, `swissRoundOneOrder` (`lib/swiss-draw.ts:33-58`).

- [ ] **Step 1: Failing tests** in `knockout-draw.test.ts` (DB):
  - `X-SD-6 the earliest registrants do not get the byes`: 6 unseeded entrants created in a known order; generate. Expected bye holders = the first two of `swissRoundOneOrder(swissDrawSeed(stageId), …)` fed to the engine's `generateSingleElim` (R9: the draw function and the engine, not the stage code). Assert the stored bye holders equal that and — for a stage id chosen so the shuffle differs from registration order (assert the premise) — differ from the first two registrants. Red on main.
  - `X-SD-6 seeds stay on the fold and take the byes first`: seeds 1–2 set, 4 unseeded, n=6: the byes go to seeds 1 and 2 (RB4-D2) and their lines match the engine's fold.
  - `X-SD-7 same seed and same entrants give the same bracket`: generate, read the seats, delete the fixtures, generate again → identical seats; `fixtures_generated.payload.draw_seed = swissDrawSeed(stageId)`.
  - `X-SD-8 Rebuild reuses the stored seed`: generate, Rebuild with the roster unchanged → every role (Task 4's key) holds the same seats.
  - `X-SD-9 an API slotOrder overrides the draw`: with `config.slotOrder` set, the seats follow the slot order exactly and `draw_seed` is absent.
  - Sequence: a fed knockout (`league_ko`) is never shuffled (its proposal order is the seeding); a second sport (chess, by `sportFor`).
- [ ] **Step 2: Failing tests** in `stage-config-api-only.test.ts` (no DB):
  - `X-SD-9 byes and slotOrder stay API-only`: a counted scan of every `.tsx` under `apps/web/src/components` and `apps/web/src/app` for a write of a `byes` or `slotOrder` stage-config key (`/\b(byes|slotOrder)\s*:/`, `grep -a` semantics in TS); assert the files scanned > 0 and the hits = 0.
  - `X-SD-10 a country-separation request is refused by name`: `StageConfig.safeParse({ countrySeparation: true })` fails with the named message; the HTTP layer maps it to 400 `COUNTRY_SEPARATION_NOT_OFFERED` (assert through the route test helper W3 T18 used, `server/api-v1/__tests__/swiss-requested-byes.test.ts`).
- [ ] **Step 3: Run FAIL:** `VERIFY-WEB t7 src/server/usecases/__tests__/knockout-draw.test.ts src/lib/__tests__/stage-config-api-only.test.ts`.
- [ ] **Step 4: Implement**; `openapi:gen` (the new never-key).
- [ ] **Step 5: Run PASS:** the two files plus `bracket-placement-sweep.test.ts` (its day-one sweep must still place every entrant), `rebuild-one-transaction.test.ts`, `swiss-round-one-draw.test.ts`. tsc. Locale + gen-keys.
- [ ] **Step 6: Mutate:** skip the shuffle → `X-SD-6 …earliest…` red; ignore `slotOrder` in the skip → `X-SD-9 …overrides…` red.
- [ ] **Step 7: E2E + smoke.** Describe `X-SD-7 the draw replays`; smoke +1 (two generates, same seats).
- [ ] **Step 8: Commit** `feat(w4): the unseeded are drawn at random with the stage's stored seed (K5)`.

## Task 8: The shared position-keyed bracket reconcile for Generate before Start (FX-G2, MB-004/005)

**Rules:** X-SD-1, X-SD-2.
**Gap:** FX-G2 (OPEN): Generate inserts by `ext_key` only (`stages.ts:3737-3738`); 6→7 inserts nothing and says "up to date"; 8→9 seats entrants twice and keeps the old final beside a new one with no drift banner. MB-004/005: the bye-award bulk update throws "would strand home_slot_label" (`:3869-3920`) once a real line becomes a bye. WD-CASC's 500 half is the same throw after a roster change.

**Files:**
- Create: `apps/web/src/lib/bracket-reconcile.ts` (pure planner + the knockout identity); `apps/web/src/server/usecases/bracket-lines.ts` (line surgeries); `apps/web/src/server/usecases/bracket-reconcile.ts` (the driver, called from `generateStageFixturesTx` for a root knockout that already has fixtures).
- Modify: `stages.ts` `generateStageFixturesTx` (branch to the driver before the insert pass); `rebuildStageFixtures` (extract its delete + regenerate + carry body as `regenerateStageInTx`, unchanged behaviour); `lib/knockout-refusals.ts` (+ `KO_GENERATE_AFTER_START`, 409, "Play has started, so Generate won't change the bracket. Use Add late player."); `tools/matrix/lib/model/fences.ts:30,38-39,55-84` (lift `ko-generate-after-roster-change` for `knockout`).
- Test: `apps/web/src/lib/__tests__/bracket-reconcile.test.ts`; `apps/web/src/server/usecases/__tests__/bracket-reconcile.test.ts`.

**Interfaces:**
- Produces:
  - `interface LineIdentity<L> { key(line: L): string }` and `KNOCKOUT_IDENTITY` (Task 4's `bracketRoleKey` over each side's `finalRoundOf`). W5 adds a round-robin identity (unordered pair + leg) without changing the planner.
  - `type ReconcilePlan = { kind: "noop" } | { kind: "in_place"; place: string[]; vacate: { lineId: string; seat: "home" | "away" }[] } | { kind: "regenerate" }`.
  - `planReconcile<L, G>(existing: readonly L[], fresh: readonly G[], ids: { existing: LineIdentity<L>; fresh: LineIdentity<G> }, roster: { active: ReadonlySet<string>; seated: ReadonlyMap<string, { lineId: string; seat: "home" | "away" }> }): ReconcilePlan` — equal key sets and an equal roster → `noop`; equal key sets, roster differs → `in_place` (newcomers to `place`, a seated entrant no longer active to `vacate`); different key sets → `regenerate`.
  - `bracket-lines.ts`: `reopenByeLine(tx, lineId, newcomerId): Promise<{ fixtureId: string; holderId: string }>` (reverses the award, seats the newcomer in the empty seat, clears the BYE label, takes the holder back out of the next line's seat and restores that seat's `slot.winner_match` label, all in the caller's transaction); `vacateLineToBye(tx, lineId, seat)` (empties the seat, awards the bye to the other side, propagates it, and clears BOTH labels in one statement — the 500's cause); `chooseByeLine(lines, seeds): string | null` — the lowest-seeded bye holder's line, ties by draw position (RB4-L4; shared with Task 10).
  - `reconcileRootBracket(tx, auth, stage, active): Promise<ReconcileOutcome>`, `ReconcileOutcome = { kind: "noop" | "in_place" | "regenerated"; placed: string[]; vacated: string[]; slots?: { kept: number; freed: number; unscheduled: number } }`; `GenerateWrite` gains `reconcile?: ReconcileOutcome`.
  - `regenerateStageInTx(tx, auth, stageId): Promise<RebuildOutcome>`.
- Consumes: Tasks 2 (`stageHasStarted`), 3 (`isByeLine`), 4 (role keys, `carrySlots`), 7 (the draw).

- [ ] **Step 1: Driving tests (regression, red on main)** in `server/…/bracket-reconcile.test.ts`, badminton, before Start:
  - `FX-G2 6→7: Generate seats the newcomer on the lowest-seeded bye line`: expected line = the one the engine's fresh `generateSingleElim` of 7 (same seeds, same draw seed) gives the 7th entrant (R9); no row inserted; the displaced bye holder's round-2 seat is TBD again.
  - `FX-G2 7→6: a removed entrant's line becomes a bye and Generate answers 200` (MB-004/005; main answers 500).
  - `FX-G2 8→9 regenerates once: every active entrant seated exactly once, one final` (trap 1, side one) and `FX-G2 9→8 regenerates once` (side two). Assert counts per role from the engine's own bracket of 9 / 8, and the final keeps its slot (Task 4).
  - `FX-G2 a second Generate with no roster change is a named no-op` (`reconcile.kind = "noop"`, the desk's "up to date" copy only here).
  - `X-SD-1 every entrant gone before Start refuses by name` (0 active → `STAGE_NOT_READY` with the copy the desk renders; never "up to date", never an empty bracket) and `X-SD-2 one entrant refuses "a knockout needs at least 2 entrants"`. If main already refuses both by name, record "holds; pinned" (they are proof-owed pins).
  - `FX-G2 after Start Generate never reshapes`: division started, an entrant added by SQL (an automatic arrival before Task 11) → `KO_GENERATE_AFTER_START`, fixtures unchanged.
  - R27: the same 6→7 and 8→9 cases for every module in `builtinModules` (no scoring needed pre-Start); assert the sports checked = the registry size > 0.
- [ ] **Step 2: Unit tests** for `planReconcile` with a toy identity and `KNOCKOUT_IDENTITY`: empty existing (→ `regenerate` is never returned for a first generate: the driver is only called when fixtures exist — assert the driver's own guard), equal, grow-in-size, shrink-in-size, cross either way; `chooseByeLine` against RB4-L4 (two unseeded holders: the later draw position).
- [ ] **Step 3: Run FAIL** both files.
- [ ] **Step 4: Implement** the planner, the surgeries and the driver; lift the model fence (with the fence's own test file updated: `tools/matrix/lib/model/__tests__/fences.test.ts` or the file that pins it — grep `ko-generate-after-roster-change`).
- [ ] **Step 5: Run PASS:** both files, `stage-roster-drift.test.ts`, `rebuild-one-transaction.test.ts`, `bracket-placement-sweep.test.ts`, `knockout-void-unfill.test.ts`; `VERIFY-MATRIX t8 <the fences test>`. tsc both.
- [ ] **Step 6: Mutate:** make `planReconcile` return `regenerate` for an equal key set → the 6→7 "no row inserted" assertion red; drop the label clear in `vacateLineToBye` → 7→6 red (the 500).
- [ ] **Step 7: R27 four answers in writing** (commit body and, later, the review): second call (named no-op), empty input (X-SD-1/2), after a withdrawal or void (pre-Start the line becomes a bye; after Start Task 10's case (2)), another sport (the registry sweep).
- [ ] **Step 8: E2E + smoke.** Describe `FX-G2 Generate places the eighth player in the bye`; smoke +2 (6→7 placed, 8→9 one final).
- [ ] **Step 9: Commit** `feat(w4): the shared bracket reconcile — Generate before Start places, vacates or regenerates by role (FX-G2, MB-004/005)`.

---

## Task 9: LateEntryResult gains a format; the client mirror and the Start copy say the knockout truth (LE-1, LE-2)

**Rules:** X-LE-1, X-LE-2.
**Gap:** LE-2 (`api-v1/schemas/` is Swiss-shaped: `case a|b|c`, `round ≥ 1`); LE-1 (`entrants.ts:421-431` answers a bare 422; `lib/open-entry-stages.ts` agrees with it, and the Start dialog says "Entrant list closes", `en/ui.json:3025`).

**Files:**
- Modify: `api-v1/schemas/entrants.ts` (`LateEntryResult` → a discriminated union; every Swiss producer adds `format: "swiss"`: `swiss-late-entry.ts` and its callers); `lib/open-entry-stages.ts`; `components/v2/start-confirm-dialog.tsx` (the `startEntrantsLine` branch); `entrants.ts:421-431` (the lock reads the new predicate); `lib/knockout-refusals.ts` (+ `KO_LATE_ENTRY_FED_STAGE`, 422, "This knockout is filled from {stage}. Add the player there."); `swiss-late-entry.ts` `hasRootSwissStage` neighbour `hasRootKnockoutStage`.
- Test: extend `apps/web/src/lib/__tests__/open-entry-stages.test.ts` (the drift test); `apps/web/src/server/usecases/__tests__/knockout-entry-stage.test.ts`; `components/v2/__tests__/start-confirm-dialog.test.tsx` (or the file that pins the line; grep `startEntrantsLine`).

**Interfaces:**
- Produces:
  - `SwissLateEntryResult` (today's shape + `format: z.literal("swiss")`), `KnockoutLateEntryResult = z.object({ format: z.literal("knockout"), entrant_id: Uuid, stage_id: Uuid, case: z.enum(["bye", "withdrawn_slot", "waiting", "refused", "rebuild_offered"]), fixture_id: Uuid.optional(), opponent_id: Uuid.optional(), scheduled: z.boolean().optional(), reason: z.string().optional() })`, `LateEntryResult = z.discriminatedUnion("format", [...])`. (`waiting` is the plan's addition to the design's four names: it is what an automatic arrival answers, ruling 271.)
  - `isRootKnockoutStage(stage: EntryStage): boolean` — kind `knockout`, `stepladder` or `page_playoff`, progression null, no `config.qualified` (a legacy standalone stepladder/page playoff is root too: X-LE-8).
  - `isRunningRootKnockout(stage & { status })`; `entrantListLocked` and `startClosesEntrantList` exempt a division with a running root knockout; `StartEntrantsLine` adds `"knockout_late"` ("Late players can still join round 1 while it has a free slot."), said when a root knockout exists and no root Swiss does.
  - `hasRootKnockoutStage(tx, divisionId): Promise<boolean>` filtering through `isRootKnockoutStage` (the ONE predicate).
- Consumes: nothing new.

- [ ] **Step 1: Failing tests.**
  - `open-entry-stages.test.ts`: `X-LE-1 a root knockout keeps the list open after Start` for `knockout`, `ko_plate`, `qualifying_main` (built from `STAGE_TEMPLATES`, filtered by "first stage is a root knockout", pinned to those three keys); `X-LE-2 a fed knockout keeps it closed` for `league_ko`, `groups_ko` (and `swiss_knockout` answers `swiss_late`, not `knockout_late`); the drift test still pins client = server for every template.
  - `knockout-entry-stage.test.ts` (DB): `X-LE-2 a late add to a started league_ko is refused and seated nowhere in the knockout`; `X-LE-2 a swiss_knockout late add joins the Swiss, never the knockout` (X-SW-12 holds); `X-LE-2 ko_plate's plate and qualifying_main's main draw never take one` (the admission picks the root stage only — assert the late entrant's only seat is in the first stage).
  - The Start dialog renders the `knockout_late` line for a knockout division and the closes line for `league_ko`.
- [ ] **Step 2: Run FAIL.**
- [ ] **Step 3: Implement**; `openapi:gen` (the union) and confirm only `LateEntryResult` moved.
- [ ] **Step 4: Run PASS:** the three files plus `swiss-late-entry.test.ts`, `swiss-late-entry-matrix.test.ts`, `entrant-enroll.test.ts`. tsc. Locale + gen-keys.
- [ ] **Step 5: Mutate** `isRootKnockoutStage` to `return false` → `X-LE-1 …` red.
- [ ] **Step 6: Commit** `feat(w4): LateEntryResult carries its format; a knockout entry stage keeps the list open (LE-1, LE-2)`.

## Task 10: "Add late player" on a knockout entry stage — cases (1), (2), (3), Rebuild offered, no Undo

**Rules:** X-LE-3, X-LE-4, X-LE-5, X-LE-6, X-LE-7, X-LE-8, X-LE-12, X-LE-13.
**Gap:** LE-1's server half (no knockout admission exists).

**Files:**
- Create: `apps/web/src/lib/knockout-late-entry.ts` (pure decision); `apps/web/src/server/usecases/knockout-late-entry.ts` (admission + apply).
- Modify: `bracket-lines.ts` (+ `reverseWithdrawnWalkover`); `entrants.ts:539` (the organiser door calls the knockout admitter after the Swiss one); `history.ts` (`UNDO_BARRIER_TYPES.knockout_late_entry`); `lib/knockout-refusals.ts` (+ `KO_LATE_ENTRY_NO_SLOT`, 409, "Round 1 complete; no slot left." with `can_rebuild`; + `KO_LATE_ENTRY_NOT_UNDOABLE`, 409, "Adding a late player can't be undone. Withdraw the player instead.").
- Test: `apps/web/src/lib/__tests__/knockout-late-entry.test.ts`; `apps/web/src/server/usecases/__tests__/knockout-late-entry.test.ts`.

**Interfaces:**
- Produces:
  - `type LateLine = { id: string; seq: number; drawPos: number; home: string | null; away: string | null; status: string; reason: "bye" | "withdrew" | "disqualified" | null; holderSeed: number | null; nextStarted: boolean; withdrawnSeat: "home" | "away" | null }` (round-1 lines only).
  - `decideKnockoutLateEntry(input: { lines: readonly LateLine[]; stageStarted: boolean; caseTwoOnly: boolean }): KnockoutLateDecision`, `KnockoutLateDecision = { case: "bye"; lineId: string } | { case: "withdrawn_slot"; lineId: string; seat: "home" | "away"; reverse: boolean } | { case: "refused"; canRebuild: boolean }`. Order: (1) unless `caseTwoOnly` → `chooseByeLine` over bye lines whose holder has `!nextStarted`; (2) a withdrawn seat in round 1 whose walkover winner has `!nextStarted` (`reverse` = the line was walked over); (3) refused, `canRebuild = !stageStarted`. A withdrawn **bye holder's** line is never case (2): it would seat the newcomer in round 2 (X-LE-7).
  - `admitKnockoutLateEntrant(tx: Tx, auth: AuthCtx | null, divisionId: string, entrantId: string, source: LateEntrySource): Promise<KnockoutLateEntryResult | null>` — null before Start or with no running root knockout; takes the `division:` lock; `source === "organiser"` applies the decision (refused → throws `KO_LATE_ENTRY_NO_SLOT` with `can_rebuild`, rolling the create back); every other source is Task 11's.
  - `applyKnockoutLateDecision(tx, stage, entrantId, decision, actorId): Promise<KnockoutLateEntryResult>` — case (1) → `reopenByeLine`; case (2) → `reverseWithdrawnWalkover(tx, lineId, newcomerId, seat)`; then the line takes `nextFreeRoundSlot` (`swiss-late-entry.ts:170-197`, generalised to read bye lines through `isByeLine`), else stays unscheduled with `scheduled: false` (X-LE-12); then a `knockout_late_entry` ledger row (barrier, `appendLateEntryRow`'s pattern) with `{ source, case, fixture_id }`.
  - `UNDO_BARRIER_TYPES.knockout_late_entry = "KO_LATE_ENTRY_NOT_UNDOABLE"` (every source that writes the row is an organiser action).
- Consumes: Task 2 `fixtureStartedSql`/`stageHasStarted`, Task 3 `isByeLine`, Task 8 `reopenByeLine`, `chooseByeLine`, Task 9 predicates.

- [ ] **Step 1: Pure tests** `knockout-late-entry.test.ts`, the decision table, empty case first (no round-1 lines → refused, `canRebuild` from `stageStarted`): one open bye; two open byes (RB4-L4 — the expected line is the one the engine's `generateSingleElim` gives an (n+1)th unseeded entrant, a differential case where it differs from "the first bye"); a bye whose holder started round 2 (→ case 2 or 3); a withdrawn seat, walked over, winner not started (→ case 2, `reverse`); winner started (→ 3); a withdrawn bye holder (→ never 2); `caseTwoOnly` with an open bye (→ 2 or 3, never 1); nothing started → `canRebuild: true`.
- [ ] **Step 2: DB tests** (badminton, then chess by `sportFor`), each asserting SEATS:
  - `X-LE-3 case (1): the newcomer plays the bye holder; nothing else moves` (every other fixture's seats and slots byte-equal before/after).
  - `X-LE-4 two open byes: the lowest-seeded holder's bye is taken`.
  - `X-LE-5 case (2) after the withdrawal walked the line over: the walkover is reversed`; and `… the case closes once the walkover winner starts round 2`.
  - `X-LE-6 round 1 complete: refused "Round 1 complete; no slot left"`, the entrant is not created; `X-LE-6 nothing started: the refusal offers Rebuild` (`can_rebuild: true`), and with only a called match it does not (X-LE-9).
  - `X-LE-7 a late entrant is never seated beyond round 1` (assert over every case).
  - `X-LE-8 a legacy standalone stepladder takes case (2) only`: create the stage by direct SQL insert (the API refuses it after Task 16; the test says so), an open bye-like rung → never case (1).
  - `X-LE-12 no free slot: the new match is unscheduled and flagged` (`scheduled: false`; with a free court/time it takes the first one).
  - `X-LE-13 Undo after Add late player refuses and points to Withdraw`.
  - `X-LE-9 a called round-2 match closes its bye to case (1)` (Review Focus 3).
  - `X-LE-3 sequence: late entry by the bye, then the late entrant withdraws` (Review Focus 4): the line walks over to the former holder, who is back in the round-2 seat.
  - Sequence: a second late player after the first took the only bye (→ case 2/3); a late player after an Undo of an unrelated schedule edit; a late player after a withdrawal.
- [ ] **Step 3: Run FAIL**, **Step 4: Implement**, **Step 5: Run PASS:** both files plus `swiss-late-entry.test.ts`, `withdrawal-w2b.test.ts`, `knockout-void-unfill.test.ts`. tsc. `openapi:gen` (the 409 detail). Locale + gen-keys.
- [ ] **Step 6: Mutate:** drop the `!nextStarted` test from case (1) → `X-LE-9 …called…` red; remove the bye-holder exclusion from case (2) → `X-LE-7 …` red; drop the barrier type → `X-LE-13 …` red.
- [ ] **Step 7: E2E + smoke.** Describe `X-LE-3 a late player takes the bye` (API-level until Task 19 adds the desk); smoke +2 (case 1 seated; case 3 refused with its code).
- [ ] **Step 8: Commit** `feat(w4): late entry into a drawn knockout — bye, withdrawn slot, or a named refusal (X-LE-3…8, 12, 13)`.

## Task 11: Automatic arrivals wait on the entrant list with a desk flag; one organiser tap runs the cases (K7, K13) — V493

**Rules:** X-LE-10.
**Gaps:** K7 (LIKELY: `registrations.ts:1026-1029` inserts with no started check and admits only Swiss at `:1105`; `imports.ts:722-733` the same), K13 (LIKELY: `entrants.ts:1012-1046` a KO Reinstate is a bare flip).

**Files:**
- Create: `db/migration/deltas/V493__w4_entrants_knockout_waiting.sql` (`alter table entrants add column knockout_waiting_stage_id uuid null references stages(id) on delete set null` + a partial index on it; a LOUD backfill only if Task 0 count 2 > 0); `apps/web/src/app/api/v1/stages/[id]/late-entrants/[entrantId]/place/route.ts`.
- Modify: `knockout-late-entry.ts` (automatic sources mark waiting; `placeWaitingKnockoutEntrant`); the four doors — `registrations.ts:1105`, `imports.ts:732`, `entrants.ts:1044` (Reinstate), and the enrol door; `lib/division-phase.ts` (`Attention` + `late_players_waiting`, severity `amber`; `PhaseInput.lateWaiting`); the desk loader that builds `PhaseInput` (grep `resolveAttention(` callers); `stages.ts` `rebuildStageFixtures` (clears the stage's waiting markers: Rebuild seats everyone active); `lib/knockout-refusals.ts` (+ `KO_LATE_ENTRY_NOT_WAITING`, 409).
- Test: `apps/web/src/server/usecases/__tests__/knockout-late-arrival.test.ts`; extend `apps/web/src/lib/__tests__/division-phase.test.ts` (or the attention suite; grep `resolveAttention`); route test `apps/web/src/app/api/v1/stages/[id]/late-entrants/__tests__/place.test.ts`.

**Interfaces:**
- Produces:
  - Automatic `admitKnockoutLateEntrant` → sets `knockout_waiting_stage_id`, returns `{ format: "knockout", case: "waiting", … }`; never throws a refusal (ruling 271); idempotent on a retry (an entrant already waiting or seated returns null).
  - `placeWaitingKnockoutEntrant(auth: AuthCtx, stageId: string, entrantId: string): Promise<KnockoutLateEntryResult>` — under the `division:` lock; refuses `KO_LATE_ENTRY_NOT_WAITING` unless the entrant waits on this stage; runs `decideKnockoutLateEntry` and `applyKnockoutLateDecision`; placed → clears the marker; refused → leaves it and answers `refused` / `rebuild_offered` (200, not a throw).
  - `POST /api/v1/stages/{id}/late-entrants/{entrantId}/place` → `KnockoutLateEntryResult` (organiser auth, as `/stages/{id}/rebuild`).
  - `Attention` `{ kind: "late_players_waiting"; count: number; stageName: string }`; copy `knockout.lateWaiting.one/other`: "{count} late player waiting — add to bracket" / "{count} late players waiting — add to bracket".
- Consumes: Task 10.

- [ ] **Step 1: Driving tests (regression, red on main)**, each an arrival into a started root knockout:
  - `X-LE-10 a paid confirmation into a started knockout waits with a flag`: `confirmRegistration` commits, the entrant exists, is seated nowhere, `knockout_waiting_stage_id` = the stage, and `resolveAttention` holds `late_players_waiting` count 1. Main: the entrant exists, unseated, no flag (K7 proved) — record it.
  - The same for a waitlist promotion, an import, and a Reinstate (`X-LE-10 … reinstate …`, K13): a reinstated entrant whose round-1 line walked over waits; their old seat is NOT re-seated automatically.
  - `X-LE-10 the arrival is never refused`: round 1 complete, the confirmation still commits (a payment must never fail).
- [ ] **Step 2: Tap tests:** `X-LE-10 one tap runs the cases in order` (bye → seated, marker cleared, barrier row with `source: "organiser"`); `… a refused tap leaves the player waiting with the reason`; `… a reinstated player's tap reverses their own walkover (case 2)`; `X-LE-10 a webhook retry flags one waiting entrant once` (Review Focus 1); `X-LE-10 two taps, one bye: the second never lands on the same line` (Review Focus 2, two concurrent calls); `… Rebuild clears every waiting marker`; a pair division (the late pair is the entrant). Attention: empty case first (`lateWaiting: []` → no row); amber never outranks a red.
- [ ] **Step 3: Migration test** in `w4-migration.test.ts`: the column exists, nullable, `on delete set null` (delete the stage → marker null).
- [ ] **Step 4: Run FAIL**, **Step 5: Implement** (read `node_modules/next/dist/docs/` for the route handler conventions first), **Step 6: Run PASS:** the three files, `swiss-late-arrival.test.ts`, `registrations*.test.ts` touching confirm (grep `confirmRegistration(` under `__tests__`), `imports*.test.ts`, the attention suite. tsc. `openapi:gen`. Locale + gen-keys.
- [ ] **Step 7: Mutate:** remove the marker write at the registration door → the confirmation test red; let an automatic source apply the decision → `X-LE-10 … waits …` red (it gets seated); drop the lock in the tap → the two-taps test red (run it three times; a flaky pass is not green).
- [ ] **Step 8: E2E + smoke.** Describe `X-LE-10 a paid player waits, then one tap places them` (API-level; Task 19 drives the desk); smoke +1.
- [ ] **Step 9: Commit** `feat(w4): automatic arrivals into a started knockout wait with a desk flag; one tap places them (K7, K13; V493)`.

## Task 12: The counted knockout late-entry sweep — every entry template × every entrant kind × every case (T8-e, T8-a)

**Rules:** X-LE-11 (and every X-LE id of Tasks 9–11 as extra tokens in the cell titles).

**Files:**
- Create: `apps/web/src/server/usecases/__tests__/knockout-late-entry-matrix.test.ts`, modelled on `swiss-late-entry-matrix.test.ts` (`:80-140` axes and `sportFor`, `:712-750` the main matrix and its last-`it` product assertion, `:868-923` the tail refusal).

**Interfaces:** consumes Tasks 9–11 and the real usecases only (createCompetition, createDivision, createEntrants, createStages, startDivision, generateStageFixturesTx via generateStageFixtures, scoreEvent, withdrawEntrantCascade, confirmRegistration, placeWaitingKnockoutEntrant, rebuildStageFixtures).

- [ ] **Step 1: Write the sweep.**
  - Header: "A coverage sweep: it builds nothing. Expected values come from the rulebook (RB4-L3…L12) and the rows before the add, never from the code under test."
  - Axes: `ENTRY_TEMPLATES` = `STAGE_TEMPLATES` whose first built stage is a root knockout, pinned to `["knockout", "ko_plate", "qualifying_main"]`; `KINDS` = `EntrantKind.options` pinned to `individual, pair, team`, each kind's sport from `sportFor` (engine declarations; a sport offered every entry template); `CASES` = `["bye", "withdrawn_slot", "refused", "rebuild_offered", "automatic_waiting", "automatic_tapped"]`.
  - A `CELL` per case builds its rig at the n it needs (bye: an odd n; withdrawn_slot: even n with one round-1 withdrawal; refused: round 1 played out; rebuild_offered: drawn, nothing started; automatic_waiting: a `confirmRegistration`; automatic_tapped: the same, then the tap) and asserts seats and the result's `case`.
  - `describe.runIf(HAS_DB)("X-LE-11 matrix: … ")` with cell titles `${template} × ${kind} (${sport}) × (${case}) X-LE-3 X-LE-5 X-LE-6 X-LE-10` as applicable; the pair cells assert the late PAIR is the entrant and no partner row is created (X-LE-11).
  - Fed-tail block: `league_ko`, `groups_ko`, `swiss_knockout` × kinds → the knockout never seats the late entrant (X-LE-2); `refused.size === product`.
  - Last `it`: `checked.size > 0`, `=== ENTRY_TEMPLATES.length * KINDS.length * CASES.length`, and `=== 54` (a `-t` slice reds it).
- [ ] **Step 2: Run** `VERIFY-WEB t12 src/server/usecases/__tests__/knockout-late-entry-matrix.test.ts` → 54 cells + pins + the fed block + the anti-vacuity `it`, all green. A red cell is a defect in Tasks 9–11: fix it in the owning task's files, never by editing the expectation.
- [ ] **Step 3: Mutate** one case's apply (e.g. make case (2) seat the newcomer in the walkover winner's seat) → the matching cells red for all three templates and kinds.
- [ ] **Step 4: Commit** `test(w4): the counted knockout late-entry sweep, 3 × 3 × 6 (T8-e, T8-a pairs)`.

---

## Task 13: A departed qualifier takes a lucky loser; table sources backfill too (K9)

**Rules:** X-LL-1, X-LL-2, X-LL-3, X-LL-4, X-LL-5.
**Gap:** K9 (PRESENT): `stage-seeding.ts:75,88-93` `CUT_SKIPS_DEPARTED_KINDS` is Swiss-only (`lib/table-withdrawal.ts`); a KO destination keeps the departed qualifier and the opponent walks over (`stages.ts:3514-3530`, F14; `:5999-6003`).

**Files:**
- Create: `apps/web/src/lib/lucky-loser.ts`; `apps/web/src/server/usecases/lucky-loser.ts`.
- Modify: `lib/table-withdrawal.ts` (`CUT_SKIPS_DEPARTED_KINDS` += `league`, `group`); `stage-seeding.ts` (a knockout source's cut orders the pool below q through `luckyLoserOrder`); `withdrawal.ts` `withdrawEntrantCascade` (before walking over a main-draw round-1 seat held by a qualifier, try `replaceDepartedQualifier`).
- Test: `apps/web/src/lib/__tests__/lucky-loser.test.ts`; `apps/web/src/server/usecases/__tests__/lucky-loser.test.ts`.

**Interfaces:**
- Produces:
  - `type LuckyCandidate = { id: string; rank: number; seed: number | null; lostBy: "played" | "retired" | "walkover" | "withdrew" | "disqualified" }`.
  - `luckyLoserOrder(pool: readonly LuckyCandidate[], drawSeed: number): string[]` — drops `walkover`/`withdrew`/`disqualified` (RB4-V5); orders by `rank` (q+1, q+2 … from the qualifying stage's final ranks, RB4-V4), then within a rank group seeded by seed and the unseeded shuffled with `mulberry32(drawSeed)` (RB4-V2). Empty in → empty out.
  - `replaceDepartedQualifier(tx: Tx, auth: AuthCtx, entrantId: string): Promise<{ replacedBy: string; fixtureId: string } | null>` — the entrant is a qualifier seated in a round-1 main-draw line of a knockout fed by a knockout source (`rankRange`), that line has not started (X-LE-9) and the pool is non-empty → seat the first of `luckyLoserOrder(pool, swissDrawSeed(destStageId))` in the vacated seat (`fillSlot`) and update the destination's `config.qualified`; else null (the cascade walks over, X-LL-2).
- Consumes: Task 2, Task 7 (`swissDrawSeed` of the destination), `cutEligiblePools`, the qualifying stage's placement snapshot.

- [ ] **Step 1: Pure tests:** empty pool first; RB4-V5 exclusions (each `lostBy`); rank then seed; two unseeded at the same rank → `mulberry32` order, replayable, with a differential case where id order differs.
- [ ] **Step 2: DB tests (regression first)** on `qualifying_main` badminton, qualifying 8 → q=4:
  - `X-LL-1 a qualifier withdraws before their first main-draw match: the best loser below the cut takes the slot` — expected = rank 5 of the qualifying stage's final ranks (its quarter-final losers; RB4-V4), not a walkover. Red on main.
  - `X-LL-2 once that match has started (a Match Day call), it is a walkover`; `X-LL-2 an empty pool walks over` (every QF loser lost by walkover).
  - `X-LL-3 the lucky loser is read from the qualifying stage's final ranks` (assert the read, rank q+1, against the placement snapshot).
  - `X-LL-4 a walkover loser is not eligible; the tiebreak uses the destination's draw seed`.
  - `X-LL-1 a vacancy in round 2 stays a walkover` (RB4-V1).
  - `X-LL-5 a departed league qualifier is replaced by the next-ranked entrant` and the same for a group source (`groups_ko`), at the cut (before confirm), as W3 does for Swiss.
  - Sequence: two qualifiers withdraw (the first and second lucky losers in order); a lucky loser who then withdraws (the next one, while unstarted); a pair division.
- [ ] **Step 3: Run FAIL**, **Step 4: Implement**, **Step 5: Run PASS:** both files plus `withdrawal-w2b.test.ts`, `departed-qualifier-void.test.ts`, `qualification-from-any-stage.test.ts`, `stage-progression.test.ts`, `swiss-late-entry-matrix.test.ts` (its cut sweep). tsc.
- [ ] **Step 6: Mutate:** skip the exclusion filter → `X-LL-4 …` red; drop `league`/`group` from the set → `X-LL-5 …` red; skip the started check → `X-LL-2 … started …` red.
- [ ] **Step 7: E2E + smoke.** Describe `X-LL-1 a lucky loser fills the main draw`; smoke +1.
- [ ] **Step 8: Commit** `feat(w4): a departed qualifier takes a lucky loser; league and group cuts backfill (K9)`.

## Task 14: A correction inside a completed knockout source stales its proposals; a cross-stage void un-fills (FX-G16, FX-G18)

**Rules:** X-QM-4.
**Gaps:** FX-G16 (`markDependentSeedProposalsStale` `stages.ts:6952-6994` stales drafts only, `:6983`; `scoring.ts:1136-1145` calls it for `TABLE_KINDS` only); FX-G18 (`fed-seats.ts:42-43` "SAME STAGE ONLY").

**Files:**
- Create: `apps/web/src/lib/knockout-cut-drift.ts` and `apps/web/src/server/usecases/knockout-cut-drift.ts` (adapted from `lib/swiss-cut-drift.ts` and `server/usecases/swiss-cut-drift.ts:51-56`, which return null off Swiss).
- Modify: `scoring.ts:1136-1145` (call for a bracket source too, when the source stage is `complete`); `stages.ts` `markDependentSeedProposalsStale` (gains `{ includeConfirmed: true }` for a destination that has not started — Task 2 — and un-fills the seats the confirmed proposal filled); `fed-seats.ts` (an `unfillProposalSeats(tx, proposalId)` helper restoring slot labels); the desk warning wiring where `swissCutDrift` is shown (grep `swissCutDriftOf(`).
- Test: `apps/web/src/server/usecases/__tests__/knockout-source-correction.test.ts`; `apps/web/src/lib/__tests__/knockout-cut-drift.test.ts`.

**Interfaces:**
- Produces: `markDependentSeedProposalsStale(auth, sourceStageId, opts?: { includeConfirmed?: boolean })`; `unfillProposalSeats(tx: Tx, proposalId: string): Promise<string[]>`; `getKnockoutCutDrift(auth, sourceStageId): Promise<KnockoutCutDrift | null>` (`KnockoutCutDrift` = the Swiss shape: who the cut names now vs who was seated).

- [ ] **Step 1: Regression tests** (`qualifying_main` and `ko_plate`, badminton):
  - `X-QM-4 a corrected quarter-final before the main draw starts: the confirmed proposal goes stale and its seats empty` — correct a decided QF result so a different player qualifies; the proposal reads `stale`, the main-draw seats it filled are TBD with their labels back, and recompute + confirm seats the new qualifier.
  - `X-QM-4 a draft goes stale too` (knockout source; main stales nothing for a KO source).
  - `X-QM-4 after the main draw starts, the bracket stands and the desk warns` (the drift names the player).
  - The same for `ko_plate`'s Main draw → Plate (a corrected round-1 result changes a plate entrant).
  - `FX-G18 a cross-stage void un-fills the seat it fed` (void the decided QF before the main draw starts → the qualifier's seat empties).
  - Empty case: a correction that changes no qualifier stales nothing.
- [ ] **Step 2: Run FAIL**, **Step 3: Implement**, **Step 4: Run PASS:** both files plus `stage-progression.test.ts`, `swiss-cut-drift*.test.ts`, `knockout-void-unfill.test.ts`. tsc. Locale + gen-keys for the warning copy (reuse the Swiss key family's shape: `knockout.cutDrift.warning`).
- [ ] **Step 5: Mutate:** drop `includeConfirmed` at the scoring call → the first test red; skip `unfillProposalSeats` → its seats assertion red.
- [ ] **Step 6: E2E + smoke.** Describe `X-QM-4 a corrected qualifier is re-proposed`; smoke +1.
- [ ] **Step 7: Commit** `fix(w4): a correction inside a knockout source stales its proposals and un-fills them before play (FX-G16, FX-G18)`.

## Task 15: Format gates — Knockout + Plate from 4, qualifying_main where it completes, whole-round cuts (FX-G14 gate half, QM-2)

**Rules:** X-PL-1, X-QM-1, X-QM-2, X-QM-3, X-QM-5.
**Gaps:** FX-G14's gate (no n gate: `templatesForSport` `format-templates.ts:326-337`; the estimate `lib/division-builder/format-estimate.ts:44-46` and the server disagree); QM-2 (UNVERIFIED: qualifying_main at small n, q=4 fixed by `format-choice.ts:77`, `rankRange 1..4` at `format-templates.ts:299-306`).

**Files:**
- Create: `apps/web/src/lib/format-size-gates.ts`.
- Modify: `stages.ts` (the gate at Start and at the root Generate of a division whose stage graph matches); `stage-seeding.ts` `validateStageProgression` (`:211`, the whole-round cut); `lib/division-builder/format-choice.ts` `formatPickerView` and `components/v2/format-picker.tsx` (the below-4 handling per the owner's Task 1 pick); `lib/knockout-refusals.ts` (+ `KO_PLATE_TOO_FEW`, 422, "Knockout + Plate needs at least 4 entrants."; + `QUALIFYING_MAIN_TOO_FEW`, 422, "Qualifying + Main draw needs at least {min} entrants."; + `KO_CUT_NOT_WHOLE_ROUND`, 422, "From a knockout, qualify a whole round: 1, 2, 4, 8 …").
- Test: `apps/web/src/lib/__tests__/format-size-gates.test.ts`; `apps/web/src/server/usecases/__tests__/qualifying-main-sizes.test.ts` (the QM-2 driving sweep); `apps/web/src/server/usecases/__tests__/format-size-gates.test.ts`; extend `lib/division-builder/__tests__/format-estimate.test.ts` and `components/v2/__tests__/format-picker*.test.tsx`.

**Interfaces:**
- Produces:
  - `stageGraphSizeRefusal(stages: readonly { kind: string; progression: unknown }[], n: number): KnockoutRefusalCode | null` — a root knockout feeding a `roundLosers` stage and n < 4 → `KO_PLATE_TOO_FEW`; a root knockout feeding a knockout by `rankRange` and n < `QUALIFYING_MAIN_MIN` → `QUALIFYING_MAIN_TOO_FEW`. Read off the stage GRAPH, so API-built divisions are gated too.
  - `QUALIFYING_MAIN_MIN: number` — set by Step 1's sweep, never guessed.
  - `isWholeRoundCut(width: number): boolean` (a power of two ≥ 1).
- Consumes: `estimateTemplate` (the builder's own n).

- [ ] **Step 1: QM-2 driving sweep** `qualifying-main-sizes.test.ts`: for every n from 2 to 17 (badminton, q=4 as the builder sends), drive qualifying → complete → propose → confirm → main generate → play out → complete through the real usecases; record per n "completes" or the exact refusal. Assert the n checked = 16. Name the smallest n from which every n completes as `QUALIFYING_MAIN_MIN` in the commit body and `_INDEX.md`; the test then asserts every n below it is refused up front (after Step 4) and every n ≥ it completes. If every n completes, `QUALIFYING_MAIN_MIN = 2`, X-QM-5 is pinned as holding, and the record says so.
- [ ] **Step 2: Failing tests:**
  - `X-PL-1 Knockout + Plate below 4 entrants is refused by the server by name` (Start and Generate, n=2 and 3) and `… is offered from 4` (n=4 starts; the plate's completion at 5–7 is PR B's — this test asserts only the up-front gate).
  - `X-PL-1 the builder hides it below 4 with the reason, and the estimate agrees` — `formatPickerView` at `plan.entrants` 3 vs 4; `estimateTemplate("ko_plate", n)` and `stageGraphSizeRefusal` give the same verdict for n = 0…40 (counted).
  - `X-QM-5 qualifying_main below its bound is refused by name` (server + builder).
  - `X-QM-2 a knockout source's cut must be a whole round`: `validateStageProgression` refuses widths 3, 5, 6 from a knockout source and accepts 1, 2, 4, 8; a table source (league) still accepts 3.
  - `X-QM-1 qualifying_main is two knockout stages joined by rankRange` (template pin, no direct acceptance).
  - `X-QM-3 qualifiers are seeded into the main draw by qualifying rank on the fold` (DB: confirm → main-draw seed i holds qualifying rank i, lines per the engine's fold for 4).
- [ ] **Step 3: Run FAIL**, **Step 4: Implement** the server gates and the pure predicate.
- [ ] **Step 5: UI (after the Task 1 pick):** the below-4 Knockout + Plate card per the chosen layout, `frontend-design` skill, 1280/320/768 screenshots to `:8765`, no horizontal scroll. Locale + gen-keys.
- [ ] **Step 6: Run PASS:** all the Files' tests plus `bracket-placement-sweep.test.ts` (its day-one fields `[2,4,9,17,33]` now meet the n<4 plate refusal: add those two named cases to its KNOWN_REFUSALS as the NEW rule, with a `why` citing X-PL-1 — this is the product refusing up front, not a frozen defect), `format-templates.test.ts`. tsc.
- [ ] **Step 7: Mutate:** `stageGraphSizeRefusal` → `return null` → `X-PL-1 … server …` red; `isWholeRoundCut` → `return true` → `X-QM-2 …` red.
- [ ] **Step 8: E2E + smoke.** Describe `X-PL-1 the builder explains the plate at 3 entrants`; smoke +2 (plate n=3 refused; whole-round cut refused).
- [ ] **Step 9: Commit** `feat(w4): format gates — Knockout + Plate from 4, qualifying_main where it completes, whole-round cuts (FX-G14 gate, QM-2)`.

---

## Task 16: Standalone stepladder and page playoff are refused with a named reason (SP-UI)

**Rules:** X-SP-6, X-SP-7.
**Gap:** SP-UI (RED L1 🚫 ×11 each): `stepladder_only` / `page_playoff_only` are API-only rows (`tools/matrix/lib/catalogue.ts:166-169`, `api-only-ui.ts:17-19`).

**Files:**
- Create: `apps/web/src/lib/stage-standalone.ts` (pure, import-free so plain node loads it from the matrix, `boundary.test.ts`).
- Modify: `stages.ts` `createStages` (`:588`) and the stage patch that can clear a progression; `lib/knockout-refusals.ts` (+ `STAGE_NEEDS_TABLE_SOURCE`, 422, "A {kind} needs a table to seed from. Add a league or groups first."); `tools/matrix/lib/catalogue.ts` `refusedCell` (`:186-201`, a second product predicate and reason constant `STANDALONE_REFUSED_REASON`); `tools/matrix/lib/api-only-ui.ts` (drop the two rows' 🚫 routes); `tools/matrix/catalogue/triage-rules.json` (retire `stepladder-withdraw-wrong-phase`, `page-playoff-withdraw-voids`, `no-builder-stepladder-only-f1`, `no-builder-stepladder-only-m1`, `no-builder-page-playoff-only-m1`: their cells are no longer planned).
- Test: `apps/web/src/lib/__tests__/stage-standalone.test.ts`; `apps/web/src/server/usecases/__tests__/standalone-stage-refusal.test.ts`; `tools/matrix/lib/__tests__/catalogue-refused.test.ts` (or the file that pins `refusedCell`; grep it).

**Interfaces:**
- Produces: `standaloneStageRefusal(stage: { kind: string; progression: unknown }): "STAGE_NEEDS_TABLE_SOURCE" | null` (stepladder or page_playoff with a null progression).
- Consumes: nothing.

- [ ] **Step 1: Failing tests:** `X-SP-6 a standalone stepladder is refused by name` and the same for a page playoff (create through the API; nothing written); `X-SP-7 league then stepladder, league then page playoff and Swiss then page playoff stay offered` (`templatesForSport` offers `group_stepladder`, `group_playoffs`, `swiss_playoff` on every sport whose kinds allow them — counted — and `createStages` accepts each built body); the matrix: `stepladder_only` and `page_playoff_only` cells are refused with `STANDALONE_REFUSED_REASON` on all 11 sports (count 22), and no other row's verdict moves (assert `refusedCell` for every other row × sport is unchanged — counted).
- [ ] **Step 2: Run FAIL**, **Step 3: Implement**, **Step 4: Run PASS:** the three files plus the matrix suites that read `refusedCell` / `api-only-ui` / triage (`VERIFY-MATRIX t16 …`, grep their names), `bracket-placement-sweep.test.ts` (its standalone `page_playoff` sizes now refuse at create: re-key its 31 `PP` refusals to the new code with a `why` citing X-SP-6). tsc both. Locale + gen-keys.
- [ ] **Step 5: Baseline check.** The 22 L3 reds on the two rows are now unplanned. If the regression judge treats a baseline case it can no longer find as a failure, re-baseline those 22 entries in this commit (the first slice of T8-d) and say so in the PR body; otherwise leave `baseline.json` to PR B.
- [ ] **Step 6: Mutate** the predicate to `null` → `X-SP-6 …` red.
- [ ] **Step 7: E2E + smoke.** Describe `X-SP-6 the API refuses a standalone playoff`; smoke +1.
- [ ] **Step 8: Commit** `feat(w4): standalone stepladder and page playoff are refused by name; matrix cells → ⛔ (SP-UI, X-SP-6, X-SP-7)`.

## Task 17: Stepladder and page-playoff withdrawals, as final stages (FX-G7, SL-1)

**Rules:** X-SP-3, X-SP-4, X-SP-5.
**Gaps:** FX-G7 and SL-1 are RED on the STANDALONE rows only. On the final-stage rows `group_stepladder`, `group_playoffs` and `swiss_playoff`, L3 R4 is ✅ ×11 each in `truth-runs/w3-final/ci/L3/results.json` — but R4 withdraws seed 3 after round 1 of the TABLE stage, so a withdrawal inside the final stage has never been driven (see "Premises found false" 1).

**Files:**
- Modify (only what Step 1 proves): `withdrawal.ts` (`:57-60`, `:375-404`, `:426-432`) and/or the placement snapshot writer `server/engine-db/competition.ts:1063-1070`.
- Test: `apps/web/src/server/usecases/__tests__/final-stage-withdrawal.test.ts`.

- [ ] **Step 1: Driving tests** (league → stepladder k=4; league → page playoff; badminton, then football by `sportFor`), each asserting who plays whom and the final ranks:
  - `X-SP-3 a stepladder seed withdrawing before their rung walks it over; nothing is voided` (no `abandoned` row).
  - `X-SP-4 a withdrawn stepladder seed is ranked as the loser of the rung they were due to enter, and every seed is ranked`: seed 2 withdraws while rung 2's other seat is still TBD (the X-WD-3 dead seat); after play, `finalRanks` holds all 4 and seed 2 sits where the rung-2 loser sits.
  - `X-SP-5 a Q1 withdrawal walks Q1 over, then Q2 over to E's winner; the withdrawn entrant ranks last`: Final = Q1's other side v E's winner; the withdrawn entrant ranks 4th; ranks and seats agree (never seated after being ranked out).
  - Run. **Record each:** green on main → "no defect as a final stage; pinned" (the rows are then proved by holding behaviour). Red → find the cause before fixing: in the app's seat or snapshot write → fix here; in the engine's `bracketRanks` (`stage.ts:456-534`) → do NOT patch around it: move X-SP-4's proof to the engine PR (Task 26 changes its `AWAITING_PROOF` value), keep this test as the app-side reproduction handed to the engine PR's brief, and report the 39 → 38 change.
- [ ] **Step 2: Implement** only an app-side cause; **Run PASS:** the file plus `withdrawal-w2b.test.ts` (`:174-199`, `:254-283`, `:1232`), `placement-snapshots.test.ts` (`:347`, `:378`). tsc.
- [ ] **Step 3: Mutate** any guard added → its test red.
- [ ] **Step 4: E2E + smoke.** Describe `X-SP-5 a page-playoff withdrawal walks over`; smoke +2 (stepladder ranks all seeds; page-playoff Q2 walkover).
- [ ] **Step 5: Commit** `fix(w4): stepladder and page-playoff withdrawals as final stages (FX-G7, SL-1; X-SP-3/4/5)` (or `test(w4): … pinned` when green on main).

## Task 18: A disqualification walkover is worded as a disqualification (K12)

**Rules:** none of the 39 (ruling 259).
**Gap:** K12 (PRESENT): `withdrawal.ts:288-296` settles a DQ with reason `withdrew`; the pad reads `pad.ribbon.core.forfeit.withdrew` = "Withdrawal recorded" (`en/ui.json:3640`); a `…forfeit.disqualified` key already exists (`:3639`).

**Files:** `withdrawal.ts`, and the readers of the forfeit reason the step chooses. Test: extend `apps/web/src/server/usecases/__tests__/disqualify-cascade.test.ts`.

- [ ] **Step 1: Decide the representation by reading, not guessing:** open the engine's forfeit reasons and walkover credit (`@seazn/engine` `competition/points.ts` forfeit rows, ruling 115) in the installed package. If `disqualified` and `withdrew` are credited identically → the cascade writes reason `disqualified`. If not → keep `withdrew` stored and word the pad and run sheet by the loser's entrant status (`disqualified`). Record the read and the choice in the commit body.
- [ ] **Step 2: Failing test** `K12 a DQ walkover reads "Disqualification recorded"` (the pad ribbon key the fixture resolves to; a withdrawal still reads "Withdrawal recorded" — the negative pair); the credit (points, standings) is byte-equal to today's.
- [ ] **Step 3: Implement, Run PASS** (the file plus `withdrawal-w2b.test.ts`, `walkover-credit*.test.ts`), **Mutate** the branch → red, **Smoke** +1, **Commit** `fix(w4): a disqualification walkover says so (K12)`.

---

## Task 19: Late entry on the desk — "Add late player", one notice per case, the waiting flag and its tap (UI)

**Rules:** X-LE-10 (UI half; extra token on the spec's describe).
**Gap:** LE-1 UI (`stage-rail.tsx:264` gates "Add late player" by `swissLateEntryOffered`; `:705` the item), K7's flag.

**Files:** `components/v2/desk/stage-rail.tsx`; `lib/open-entry-stages.ts` (+ `knockoutLateEntryOffered({ stage, divisionStatus, generated })`); the late-entry notice (`lib/swiss-late-entry-notice.ts` grows knockout lines, or a sibling `lib/knockout-late-entry-notice.ts` — the owner's pick decides); the waiting-flag component per the pick; the Entrants tab add form (the SAME form, W3 T10; never a second form). Tests: `lib/__tests__/knockout-late-entry-notice.test.ts`, `components/v2/__tests__/stage-rail-knockout-late.test.tsx`; e2e describe in `w4-knockout-app-a.spec.ts`; walkthrough `apps/web/e2e/walkthrough/w4-knockout-late-entry.spec.ts`.

- [ ] **Step 1:** `frontend-design` skill; build the owner's picked layouts. Copy (4 locales + gen-keys): `knockout.lateEntry.tookBye` "{name} plays {holder}, who had a bye.", `.tookWithdrawnSlot` "{name} takes {withdrawn}'s place against {opponent}.", `.newMatchUnscheduled` (reuse Swiss's), `.refused` (the refusal key), `.rebuildOffered` "No slot is left, but nothing has started: Rebuild the bracket to add {name}.", and the waiting flag strings from Task 11.
- [ ] **Step 2: Failing tests:** the rail offers "Add late player" on a started root knockout with fixtures, not on a fed knockout, not before Start, and not on a complete stage (`knockoutLateEntryOffered` table, empty case first); the notice text per `KnockoutLateEntryResult.case` (all five); the tap button posts to Task 11's route and renders the result line.
- [ ] **Step 3: E2E:** describe `X-LE-10 the desk flags a paid player and one tap places them` (create a registration through the API, see the flag, tap, see the seat on the bracket) and `X-LE-3 Add late player from the rail takes the bye`. Walkthrough: an organiser adds a late pair to a drawn badminton doubles bracket, then a paid single arrives and is tapped in.
- [ ] **Step 4: Verify** at 1280, 320 and 768 (screenshots to `:8765`, per-screen verdict; control-set diff 320 vs 1280; `mobile.spec.ts` rail scans kept true).
- [ ] **Step 5: Run PASS** (the unit files, `stages-panel*.test.tsx` touching the rail), **Mutate** `knockoutLateEntryOffered` → `true` → the fed-knockout case red, **Commit** `feat(w4): late entry and the waiting flag on the desk (LE-1, K7)`.

## Task 20: The draw seed is shown (K5 "shown")

**Files:** the stage header / desk location per the owner's pick; `readStageDrawSeed` (Task 7). Tests: a component test that the seed renders as `="…"`-anchored markup for a drawn root knockout and is absent for a fed one; e2e describe `X-SD-7 the stage shows its draw seed`.
- [ ] **Step 1:** Build per the pick (`frontend-design`), copy in 4 locales + gen-keys ("Draw #{seed}"). **Step 2:** failing test, implement, PASS. **Step 3:** 1280/320/768 screenshots, no horizontal scroll. **Step 4: Commit** `feat(w4): the stage shows its draw seed`.

## Task 21: AN-1 — "Final decided — complete the stage", and Complete competition warns (never refuses)

**Rules:** X-CH-8.
**Gap:** AN-1 (prod: 8-bracket all decided, stage active, competition completed). Completing a competition is the status select in `components/v2/competition-settings.tsx:35` (`STATUSES`) → `patchCompetition` (`competitions.ts:512-521` keeps the retire path open even for frozen competitions); re-pin every other writer of `status: "completed"` by grep.

**Files:** `lib/division-phase.ts` (+ `Attention` `{ kind: "final_decided"; stageName: string }`, severity `red`: the bracket never ranks until acted on — same rationale as `needs_decision`; state the empty case first); the desk loader; `competition-settings.tsx` (the warning per the owner's pick, listing open stages, each bracket whose final is decided offering "Complete stage" via the existing complete route); `server/usecases/competitions.ts` (a read `openStagesOf(auth, competitionId)` for the warning; `patchCompetition` unchanged — it never refuses). Tests: the attention suite; `components/v2/__tests__/competition-settings-complete-warning.test.tsx`; `server/usecases/__tests__/competition-open-stages.test.ts`.

- [ ] **Step 1: Driving test on main** `X-CH-8 a decided final on an active stage raises "Final decided — complete the stage"` (reproduce AN-1: 8-bracket, `auto_progress` off, all 7 decided; red on main = no such attention). `X-CH-8 completing the competition warns, lists the open stage, and still completes` (the patch succeeds; the warning lists exactly that stage; its "Complete stage" completes it and the champion appears on the public banner).
- [ ] **Step 2:** implement per the pick (`frontend-design`), copy in 4 locales + gen-keys; **Run PASS**; **Mutate** the attention arm → red; screenshots at 1280/320/768; e2e describe `X-CH-8 the desk asks to complete a finished bracket`; smoke +1; **Commit** `feat(w4): a decided final asks to complete its stage; completing a competition warns (AN-1, X-CH-8)`.

## Task 22: Bracket tiles — no result over a name, no "TBD" on a finished bye (N-1, rulings 116/117)

**Files:** `components/v2/bracket-panel.tsx:358-362` (also `:490`, `:664`: the `absolute right-2 top-1.5` headline). Tests: `components/v2/__tests__/bracket-panel-tiles.test.tsx`.
- [ ] **Step 1: Failing tests:** a decided badminton tile renders its headline in its own box, not absolutely over the top name (assert the markup's structure, anchored on `="`); a finished bye tile renders the bye label and no `TBD` (ruling 116/117's wording). **Step 2:** fix (no new control: layout repair only); e2e hit-test with `elementFromPoint` on the name at 320 (paint ≠ hit area); screenshots 320/768/1280, with a realistic 43-character name. **Step 3: Commit** `fix(w4): bracket tiles keep the result off the names and drop TBD from finished byes (N-1)`.

## Task 23: Finished brackets are never drawn as tables; the OG card reads an ordered query (ST-G7, ST-G26)

**Files:** `app/embed/divisions/[id]/[widget]/page.tsx:207-235` (standings widget skips bracket stages: `TABLE_KINDS`); `server/slideshow-data.ts:721-737` (`buildPublicDivisionSlides` skips them, as the organiser slideshow does at `:422`); `server/public-site/data.ts:1062-1066` (order: stage order, then pool order); `app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/opengraph-image.tsx:34` (the first TABLE snapshot; a bracket-only division shows its champion per the owner's pick). Tests: `server/__tests__/embed-data.test.ts` (extend), `server/__tests__/slideshow-public-brackets.test.ts`, `server/public-site/__tests__/standings-order.test.ts`, `app/(public)/live/__tests__/opengraph-champion.test.tsx`.
- [ ] **Step 1: Failing tests:** `ST-G7 a finished knockout is not a standings table in the embed` and `… in /present`; `ST-G26 standings are read in stage then pool order` (two pools inserted B before A, and a KO placement snapshot inserted first — trap 4: assert order across pools and the KO, never one sample); `ST-G26 a bracket-only division's OG card names its champion` (anchored on `="`; React serialises an omitted prop as `"$undefined"`).
- [ ] **Step 2:** implement; OG layout per the pick (`frontend-design`); screenshots of the embed and `/present` at 1280/320/768; e2e describe `ST-G7 the embed shows a finished bracket as a bracket`; smoke +1 (public standings order). **Commit** `fix(w4): finished brackets leave the tables; the OG card reads an ordered query (ST-G7, ST-G26)`.

---

## Task 24: Matrix debt — the PR-A share of T8-c, T8-g, and the placement sweep

**Files:** `tools/matrix/lib/scenario-catalogue.ts:150-151` (`KNOWN_NO_PATH`: Q4 → split: Q4b ⛔ refused, reason "an unplayed final is never decided by seed or table automatically (X-CH-5)"; Q4a stays → PR B; D4: D4b ⛔ refused (X-SD-10), D4a re-routed ⏳ to the clubs follow-up, ruling 272); scenario scripts for R2 (late entry after Start), R10 (automatic arrival waits, then the tap) and R6 (lucky loser) under `tools/matrix/lib/scenarios/` (modelled on `r4-withdrawal.ts`, each check counting what it examined); `tools/matrix/lib/applicability.ts:294,328` (T8-g: verify M6 on boardgame against W2a's BG-KO-1 by driving one boardgame knockout M6 case locally through the HTTP driver; lift the drop if it passes, else record why it stays); `apps/web/src/server/usecases/__tests__/bracket-placement-sweep.test.ts:274` (seed every n the builder offers for ko_plate and qualifying_main — n = 4…19, 33–35 — counted, n=5, 6, 7, 9, 17 named).
- [ ] **Step 1:** the catalogue changes and their pinning tests (counted: the cells moved from 🚫 to ⛔ / ⏳, by id); the three scenario scripts with unit tests against recorded fixtures; `VERIFY-MATRIX t24 …`.
- [ ] **Step 2: The placement sweep.** Widen the seeded pass. The ko_plate n where round-1 losers < 4 (5–7, 9–11, 17–19, 33–35) still refuse until PR B's feed: they STAY in `KNOWN_REFUSALS`, the n=5 entry's count grows to the full set, and its `why` names "owed: W4 PR B first-loss feed (FX-G14 close)" — this plan does not remove the allowlist (premise 2). qualifying_main n per Task 15's bound.
- [ ] **Step 3:** tsc both; lint; **Commit** `test(w4): matrix — Q4b/D4b refused, D4a to clubs, R2/R10/R6 scripts, M6 boardgame verified; the placement sweep seeds every offered n`.

## Task 25: All four test types for qualifying_main, stepladder and page playoff as final stages (T8-f)

**Files:** smoke checks in `w4KnockoutA.ts` (+3: qualifying_main n=8 qualifies 4 and completes; league → stepladder completes with every seed ranked; league → page playoff asserts Q1 = 1v2, E = 3v4, Q2, Final); walkthrough `apps/web/e2e/walkthrough/w4-final-stages.spec.ts` (an organiser builds League + Stepladder finals and League + Playoffs through the builder, plays them out, withdraws one finalist); vitest already in Tasks 15 and 17.
- [ ] **Step 1:** write; run smoke locally (count = `EXPECTED_CHECKS` = 24); the walkthrough runs in the CI dispatch. **Commit** `test(w4): smoke and walkthroughs for qualifying_main, stepladder and page playoff (T8-f)`.

---

## Task 26: PR, CI, review, owner sign-off, and the rule rows

- [ ] **Step 1:** open the PR (body: Summary per batch; "Data changes" V492, V493 with Task 0's counts; "Matrix rows: …" (Global Constraints); R27's four answers for the reconcile; the R24 picks; bench gates All England / Wimbledon / WTTC ⏳ deferred, no pack in `tools/bench/packs/`; the 39-row table; premises found false). Dispatch e2e (`--ref`), judge the spec file whole.
- [ ] **Step 2:** final `reviewer` pass over the whole branch (never skipped, class 12), its findings written to disk; per-screen owner sign-off for Tasks 15, 19–23 (class 11).
- [ ] **Step 3: `_INDEX.md`:** the W4 row (PR A status), "False premises found (W4)" (this plan's list plus each "no defect, pinned" record), and the **note to W5**: "The reconcile (`lib/bracket-reconcile.ts`) is `planReconcile(existing, fresh, ids, roster)` over a `LineIdentity`; knockout supplies `bracketRoleKey` (round from the final, index in round). W5 adds a round-robin identity (unordered pair + leg) and its own new-pair slot policy; the planner and `regenerateStageInTx` are unchanged."
- [ ] **Step 4: Rule rows (companion engine commit, controller-run, after this PR merges — W3's precedent is engine commit `7aad874` "W3 close-out rows" on engine PR #18).** On the W4 engine PR's branch (or, if it has merged, a `docs/w4-app-a-proofs` engine PR merged before the release): for each of the 39 ids, fill `proved by` with the app test paths from the table below (repo-relative, `apps/web/...`), fill `enforced at` with the production paths, drop the citation's "not yet implemented (W4 app PR A)" / "proof owed (W4 app PR A)" note, and delete its `AWAITING_PROOF` entry in `test/rules-reference.ts`; add `apps/web/src/components/v2/format-picker.tsx` to X-SW-16's paths (owed to the W4 rules close-out); a `patch` changeset. The engine checker reads only engine paths; the app checker (`scripts/__tests__/rules-reference.test.ts`, which reads rows from the installed `@seazn/engine/testkit`) verifies the app paths when PR B bumps — so PR B must copy the engine's remaining `AWAITING_PROOF` entries (PR B's own rows) into `scripts/lib/rules-reference.ts:37`, which is empty today. PR A itself edits no rule file and no checker map: the installed 3.0.2 holds no W4 row.

---

## Batches (execution order and parallelism)

| Batch | Tasks | Order and why |
|---|---|---|
| B0 | 0, 1 | 0 is read-only; 1 waits on nothing. Both may run beside B1. |
| B1 | 2 → 3 → 4 → 5 → 6 | All touch `stages.ts`; sequential. 2 is the "started" every later task reads; 3 creates `knockout-refusals.ts` and `isByeLine`; 4 the role keys Task 8 needs. |
| B2 | 7 → 8 | 8 consumes 2, 3, 4, 7. |
| B3 | 9 → 10 → 11 → 12 | Strictly sequential (one admission seam). |
| B4 | 13 → 14 → 15 | 13 and 14 both touch `stage-seeding.ts`/`stages.ts`; 15's QM-2 sweep may start first as a read-only run. |
| B5 | 16 ‖ 18, then 17 | 16 (`createStages`, `tools/matrix`) and 18 (`withdrawal.ts` reason) are disjoint; 17 touches `withdrawal.ts` after 18. |
| B6 | 19, 20, 21, 22, 23 | After the Task 1 picks. 22 and 23 are disjoint from 19–21 and from each other: may run in parallel worktrees (`isolation: "worktree"`). |
| B7 | 24, 25 | After B5 (24 reads the refused cells and the scenarios). |
| B8 | 26 | Last. |

Each batch ends with an Opus `reviewer` pass over the batch diff, a push and an e2e dispatch; the controller reruns the batch's scoped VERIFY-WEB itself and pastes the raw counts (never "done, tests pass").

## Decisions recorded in this plan (my calls; recommendations stated)

1. **Case (1) re-opens the bye line itself** rather than inserting a "new round-1 match" row: the bye line IS the round-1 line, and a new row would need an `ext_key` outside the bracket's identity (breaking Task 8's role key). Recommend yes.
2. **A withdrawn bye holder's line is never case (2):** taking it would seat the newcomer in round 2 (X-LE-7 outranks case (2)).
3. **`waiting` joins the knockout case names** (design §4.1 lists four): it is the result an automatic arrival answers under ruling 271.
4. **The waiting set is stored** (`entrants.knockout_waiting_stage_id`, V493), not derived from roster drift: drift's `unplaced` reads the unfiltered fixture set (`stages.ts:4106-4115`), so a reinstated entrant — referenced by their own walkover — would never be flagged (K13).
5. **The seed is `swissDrawSeed(stage.id)`**, recorded as `draw_seed`; Rebuild keeps the stage id, so it keeps the seed by construction (X-SD-8 asserts it rather than storing a second copy).
6. **The AN-2 guard is bracket kinds only:** a league may still be completed with unplayed fixtures as today; X-CH-7 is a bracket rule.
7. **`final_decided` is a red attention** (like `needs_decision`: the bracket never ranks until acted on); the owner may down-grade it at the Task 1 review.

## Premises found false or stale (to `_INDEX.md` "False premises found (W4)")

1. **FX-G7 and SL-1 are red only on the standalone rows Q7 refuses.** In `truth-runs/w3-final/ci/L3/results.json`, R4 is ✅ ×11 on each of `group_stepladder`, `group_playoffs` and `swiss_playoff`; the design's "RED (R4 ×11)" (§9) is `stepladder_only` / `page_playoff_only` only. R4 there withdraws during the table stage, so the final-stage withdrawal was never driven: Task 17 drives it before calling anything a defect.
2. **T8-b's allowlist removal cannot land in PR A** (§6.2 last row → §6.6): the `ko_plate n=5` refusal (`bracket-placement-sweep.test.ts:133-137`) is the q=4 round-1 feed, n=5 is above PR A's n≥4 gate, and only the engine's first-loss feed (PR B) fixes it. Removing the entry in PR A reds the sweep; PR A widens the seeding instead (Task 24) and the removal rides with PR B's feed.
3. **`systemByeSql` alone cannot exclude a knockout bye from the courts** (§6.2 K2 "generalise X-SW-29's exclusion onto `systemByeSql`"): a setup-path bye line before seeding is `scheduled` with no outcome and only a BYE slot label (`stages.ts:4657-4679`, label `:4736-4743`); it is not a system bye until `awardSeededByes` runs. Task 3's `byeLineSql` adds that arm.
4. **X-SD-1 / X-SD-2 may already hold:** generate refuses n<2 by name today (`stages.ts:1609`, `:3552-3553`, `STAGE_NOT_READY` "need at least 2 active entrants"). Task 8 drives both and pins them if they hold; only the desk copy may be owed.
5. **There is no "Complete competition" control:** completion is the status select (`competition-settings.tsx:35`) through `patchCompetition`; AN-1's warning sits there (Task 21).
6. **The K13 flag cannot come from roster drift** (Decision 4).
7. Pins re-checked 2026-11-05 at the worktree (97d22c8acd + docs): unchanged from the recon; next migration V492; next ruling 276.

## Rule-id table (the 39 "W4 app PR A" rows; for Task 26's companion commit)

| Id | Rule (short) | Proving test(s) — `apps/web/src/…` (+ e2e) :: title token | Task |
|---|---|---|---|
| X-SD-1 | 0 entrants: Generate refused by name | `server/usecases/__tests__/bracket-reconcile.test.ts` | 8 |
| X-SD-2 | 1 entrant: refused "needs at least 2" | `server/usecases/__tests__/bracket-reconcile.test.ts` | 8 |
| X-SD-6 | Unseeded drawn at random | `server/usecases/__tests__/knockout-draw.test.ts` | 7 |
| X-SD-7 | Seed stored, shown, reproducible | `knockout-draw.test.ts`, `e2e/w4-knockout-app-a.spec.ts` | 7, 20 |
| X-SD-8 | Rebuild reuses the seed | `knockout-draw.test.ts` | 7 |
| X-SD-9 | API slotOrder overrides; byes/slotOrder API-only | `knockout-draw.test.ts`, `lib/__tests__/stage-config-api-only.test.ts` | 7 |
| X-SD-10 | Country separation refused by name | `lib/__tests__/stage-config-api-only.test.ts` | 7 |
| X-LE-1 | Late entry only at the entry stage | `lib/__tests__/open-entry-stages.test.ts`, `server/usecases/__tests__/knockout-entry-stage.test.ts` | 9 |
| X-LE-2 | Fed knockout / plate / main draw never take one | `knockout-entry-stage.test.ts`, `knockout-late-entry-matrix.test.ts` | 9, 12 |
| X-LE-3 | Case (1) bye | `lib/__tests__/knockout-late-entry.test.ts`, `server/usecases/__tests__/knockout-late-entry.test.ts`, matrix | 10, 12 |
| X-LE-4 | Lowest-seeded bye first | `knockout-late-entry.test.ts` (both) | 10 |
| X-LE-5 | Case (2) withdrawn slot, walkover reversed | `knockout-late-entry.test.ts`, matrix | 10, 12 |
| X-LE-6 | Case (3) refused; Rebuild if nothing started | `knockout-late-entry.test.ts`, matrix | 10, 12 |
| X-LE-7 | Never round 2 | `knockout-late-entry.test.ts` | 10 |
| X-LE-8 | Stepladder / page playoff: case (2) only | `server/usecases/__tests__/knockout-late-entry.test.ts` | 10 |
| X-LE-9 | One "started" predicate incl. a Match Day call | `server/usecases/__tests__/fixture-started.test.ts`, `knockout-void-unfill.test.ts`, `rebuild-one-transaction.test.ts`, `knockout-late-entry.test.ts` | 2, 10 |
| X-LE-10 | Automatic arrivals wait; one tap runs the cases | `server/usecases/__tests__/knockout-late-arrival.test.ts`, matrix, `e2e/w4-knockout-app-a.spec.ts` | 11, 12, 19 |
| X-LE-11 | A late pair is the entrant | `server/usecases/__tests__/knockout-late-entry-matrix.test.ts` | 12 |
| X-LE-12 | Next free slot, else unscheduled + flagged | `server/usecases/__tests__/knockout-late-entry.test.ts` | 10 |
| X-LE-13 | No Undo; refusal points to Withdraw | `server/usecases/__tests__/knockout-late-entry.test.ts` | 10 |
| X-LL-1 | Lucky loser for an unplayed qualifier slot | `lib/__tests__/lucky-loser.test.ts`, `server/usecases/__tests__/lucky-loser.test.ts` | 13 |
| X-LL-2 | Started → walkover; empty pool → walkover | `server/usecases/__tests__/lucky-loser.test.ts` | 13 |
| X-LL-3 | Read from the qualifying stage's final ranks | `server/usecases/__tests__/lucky-loser.test.ts` | 13 |
| X-LL-4 | WO/WD/DQ losers ineligible; draw-seed tiebreak | both `lucky-loser.test.ts` | 13 |
| X-LL-5 | League / group sources backfill | `server/usecases/__tests__/lucky-loser.test.ts` | 13 |
| X-PL-1 | Knockout + Plate below 4 hidden and refused | `lib/__tests__/format-size-gates.test.ts`, `server/usecases/__tests__/format-size-gates.test.ts` | 15 |
| X-QM-1 | Two knockout stages by rankRange | `lib/__tests__/format-size-gates.test.ts` | 15 |
| X-QM-2 | Whole-round cut from a knockout source | `server/usecases/__tests__/format-size-gates.test.ts` | 15 |
| X-QM-3 | Qualifiers seeded by rank on the fold | `server/usecases/__tests__/format-size-gates.test.ts` | 15 |
| X-QM-4 | Correction stales draft and confirmed | `server/usecases/__tests__/knockout-source-correction.test.ts` | 14 |
| X-QM-5 | qualifying_main only where it completes | `server/usecases/__tests__/qualifying-main-sizes.test.ts`, `format-size-gates.test.ts` | 15 |
| X-CH-2 | One finalist out → walkover champion | `server/usecases/__tests__/bracket-complete-guard.test.ts` | 6 |
| X-CH-5 | Never decided automatically; settle stays | `server/usecases/__tests__/bracket-complete-guard.test.ts` | 6 |
| X-CH-8 | Final decided → attention; Complete competition warns | the attention suite, `server/usecases/__tests__/competition-open-stages.test.ts`, `components/v2/__tests__/competition-settings-complete-warning.test.tsx` | 21 |
| X-SP-3 | Stepladder withdrawal walks over | `server/usecases/__tests__/final-stage-withdrawal.test.ts` | 17 |
| X-SP-4 | Withdrawn stepladder seed ranked | `final-stage-withdrawal.test.ts` (or the engine PR, Task 17 Step 1) | 17 |
| X-SP-5 | Page-playoff withdrawal: no second life | `final-stage-withdrawal.test.ts` | 17 |
| X-SP-6 | Standalone stepladder / page playoff refused | `lib/__tests__/stage-standalone.test.ts`, `server/usecases/__tests__/standalone-stage-refusal.test.ts` | 16 |
| X-SP-7 | Both stay offered as final stages | `server/usecases/__tests__/standalone-stage-refusal.test.ts` | 16 |

39 ids: X-SD 7, X-LE 13, X-LL 5, X-PL 1, X-QM 5, X-CH 3, X-SP 5. Conditional: X-SP-4 moves to the engine PR if Task 17 finds its cause in `bracketRanks` (then 38 here). Extra tokens (not counted, engine-PR rows' app halves): X-SD-5 (Task 3), X-CH-7 (Task 6), X-RB-1 (Task 4).
