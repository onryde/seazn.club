# W3 Swiss — App PR A (no engine change) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship every W3 Swiss behaviour that lives in seazn.club and needs no `@onryde/seazn-engine` release: late entry after pairing (ruling 250), a Rebuild that keeps times and courts in one transaction, a working Undo of Pair next, safe byes, round guidance and caps, per-stage rounds with Finish / Add a round, the chess and draw defaults, the DQ cascade and the public "Round X of N".

**Architecture:** All work is in `apps/web`. The Swiss pairing orchestration (`swissGen`, `stages.ts`) gains a field model: each entrant gets a first Swiss round (`entrants.swiss_first_round`), which drives late entry, the zero-credit missed rounds, and the case (c) exclusion. A new usecase module, `swiss-late-entry.ts`, chooses and applies cases (a), (b) and (c) under the division advisory lock. It reuses `swissGen`, `clearSwissFixtureSeats` and `reconcileSwissRoundShells`, all exported from `stages.ts`. Late entries and round-count changes are written to the ledger as **undo barriers**: `history.ts` refuses to step back across them and names the refusal. Client-safe pure modules (`lib/swiss-*.ts`) hold every derivation the UI shows, because `apps/web` vitest is node-only.

**Tech Stack:** TypeScript 7 / Node 26, Next.js (the repo's non-standard version: read `node_modules/next/dist/docs/` before adding a route), postgres.js, zod, vitest (JSON reporter), Playwright (CI dispatch only), Flyway deltas.

**Spec:** `docs/superpowers/specs/2026-10-31-format-matrix-w3-swiss-design.md` (approved 2026-10-31; §12 added at 9d190f7ce0). Scope: §4 (all of it) and §6.2 (every row). Rulings 250–252 are in `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md:1995-2030`. The signed rulebook is `rulebook-W3-swiss.md` in the same directory; it is the source of every expected value below. Evidence with file:line at 920d7a9a22: `/Users/ashokhein/github/seazn.club/.superpowers/handoff/2026-10-31-w3/gaps.md` and `recs.md`. Read the spec section a task cites before starting it.

**Out of scope (the App-B / engine plan):**
- SW-H1's refusal surfaced on the desk.
- SW-M11 (score groups from table points).
- ST-G21.
- The full Swiss→KO e2e (SW-L10).
- The ruling-70 retirement.
- Every §6.1 engine row, including the topscorer colour exception (RB3-10's engine half) and art. 16 unplayed categories.

Requested ½ / 0 byes (RB3-7(c)) and RB3-19 have no product path in this PR.

---

## Global Constraints

- **Worktree:** `/Users/ashokhein/github/seazn.club-worktrees/w3-app-a`, branch `feat/w3-swiss-app-a`, cut from fresh `origin/main`. Never write in `~/github/seazn.club`. Never `git stash` (the stack is shared). `$WT` = that worktree. `$S` = the executor's own scratchpad subdirectory (`<scratchpad>/w3a-<task>/`); never `rm` outside it.
- **Re-pin first.** Line numbers below were read at 920d7a9a22. The branch is cut later, so every task opens its cited lines before editing (AGENTS.md class 5). A pin that has moved is not a finding. A pin whose behaviour has changed is: record it in the task's commit body.
- **Environment:** install and stand up the DB per the `seazn-local-env` skill: fresh DB, `db:apply`, then `sync:sports`. Confirm that `show data_directory` is yours. DB-backed suites are red without it, and that red is environmental.
- **Scoped vitest only.** Never run the full suite, the full gate or the full e2e locally.
  - `VERIFY-WEB <name> <files…>` = `cd $WT/apps/web && npx vitest run <files…> --reporter=json --outputFile=$S/<name>.json; echo EXIT=$?`.
  - Then: `node -e 'const r=require(process.argv[1]);console.log(r.numPassedTests+"/"+r.numTotalTests);for(const t of r.testResults)console.log(t.status,t.name)' $S/<name>.json`.
  - **Green** means `EXIT=0`, passed = total, total > 0, and every listed file appears in `.testResults[].name` under `$WT`. The JSON reporter cannot see an Unhandled Rejection, so EXIT=0 is required as well.
  - Positionals are literal filename filters: name whole files. Never pass an empty list (zsh then runs the FULL suite).
  - Never through `rtk`. Never `--root`.
- **Status literals:** when a task edits a fixture-status literal set (`DECIDED`, `OCCUPYING`, `PRINTABLE_STATUSES`, any `status in (…)`), add `src/lib/__tests__/status-set-sweep.test.ts` to its VERIFY-WEB. Re-key the ledger rows in `src/lib/__tests__/status-set-ledger.ts` if the anchors moved.
- **tsc** is scoped: `cd $WT/apps/web && npx tsc --noEmit -p .`, never through `rtk`.
- **Lint:** `cd $WT/apps/web && rtk proxy npm run lint`. Read `✖ N problems`; it must not rise.
- **OpenAPI:** a route or schema change runs `npm run openapi:gen` in `$WT`, then `git status --porcelain openapi/`. Only the intended change may appear, and it is committed.
- **Locale:**
  - Every new user-facing string goes into all four of `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`.
  - Then run `npm run i18n:gen-keys` and `npm run i18n:check`. Never hand-edit `lib/i18n-keys.ts`.
  - Refusal copy: an English sentence beside its code in `apps/web/src/lib/swiss-refusals.ts` (Task 4 creates it), plus a `swiss.refusal.<CODE>` key the desk renders.
- **Migrations:** `db/migration/deltas/V<next>__<name>.sql`. Re-check the next free number on `origin/main` at task time; it was V483 at pin. A migration that moves stored data must:
  - say so in a `-- DATA CHANGE (LOUD)` header;
  - be listed in the PR body's "Data changes" section;
  - run pre-deploy (owner rule 2026-10-28). Never a compat shim.
- **Tests (TEST-STRATEGY.md, `_RULES.md` R13/R16/R17/R25/R28): all four types per task.**
  - **Unit:** vitest. Add DB-backed cases where SQL is involved.
  - **E2E:** a `test.describe` per task in `apps/web/e2e/w3-swiss-app-a.spec.ts` (Task 1 creates it), run only by CI dispatch.
  - **Smoke:** counted checks in `scripts/smoke/suites/w3SwissA.ts` (Task 1 creates it).
  - **Regression:** a test that fails on today's `main` for the gap being closed.
  - **Expected values** come from the rulebook (cite the section in the test) or the engine's/sport's own declarations, never from `swissGen`'s constants.
  - **Anti-vacuity:** every sweep and property asserts its count is > 0 and prints it.
  - **Mutation:** mutate each new guard once (delete the predicate, or `return true`/`false`), see a named test go red, restore it, and record `mutant → killer test` in the commit body. Two guards covering for each other are mutated one at a time.
  - **Sequence:** every late-entry and undo task covers:
    - a second late player;
    - a late player after a withdrawal;
    - a late player after an Undo;
    - the same case in **chess** (sport `boardgame`) as well as badminton.
  - **Undo tests** assert the SEATS (`home_entrant_id`/`away_entrant_id`), never a shell count (brief trap 2).
- **Rule ids (spec §12):** each task names the §12 rule it implements. Its proving test's `describe`/`it` title carries the future row id as a whole token (`X-SW-<TAG>-<n>`), so the engine "rules close-out" PR can cite it. An id never contains `-KO-`. The table at the end lists every id.
- **UI tasks:**
  - Invoke the `frontend-design` skill first and build in the house theme (mocks are layout only).
  - Mobile-first: one DOM, `max-md:*` branches (AGENTS.md "phone composition").
  - Verify at 1280, 320 and 768 with no horizontal page scroll, and compare the control SET at 320 against 1280.
  - Screenshots go to an Artifact page with a per-screen verdict, never into the repo.
  - A new control on the stage rail: grep `apps/web/e2e/mobile.spec.ts` for the rail's testids and keep that spec's control-set and clipping scans true.
  - `/admin` is untouched.
- **E2E by CI dispatch only:** `gh workflow run e2e.yml --ref feat/w3-swiss-app-a -f pr=<N>`.
  - The dispatch runs the whole suite. Judge the new spec FILE whole, never a `-g` slice.
  - A push to the branch cancels a running dispatch.
  - Dispatch at batch ends (below), then hand back. The main thread watches the run.
- **Smoke wiring:**
  - One `suite("w3SwissA", …)` call in `scripts/smoke/main.ts`, after the last `await suite(` call.
  - The owner `delivered+w3a_${tag}@resend.dev` in `scripts/smoke/harness.ts`'s cleanup list (beside `w2e`, ~`:1589`).
  - A `SELECTABLE_SUITES` entry in `scripts/smoke/index.ts`.
  - Run: `SMOKE_ONLY=w3SwissA npm run test:smoke` against a live local server (per `seazn-local-env`). Its count must equal `EXPECTED_CHECKS`, and zero checks fails.
  - Never recreate `scripts/smoke.ts`.
- **R27:** the PR body carries `Matrix rows: swiss, swiss_playoff, swiss_knockout × all` (it touches `stages.ts`).
- **Never touch:** `packages/engine/**` and the engine repo, `tools/matrix/catalogue/baseline.json`, `stryker-*.json`, the spec, `_INDEX.md` rulings (Task 0 appends a data-findings note only).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The PR body ends with the Claude Code line.

## Review Focus

1. **A late player added while a current-round board has an online-chess game being created, or a device link open with no event yet.** Case (a) must not fire; the action must fall to (b) or (c) cleanly, never 500 from `lockBoardsRefusingOnlineGames`. Pinned in Task 9: `case (a) never runs over a board an online game stands behind`.
2. **Undo pressed right after "Add late player" (wrong person), then Withdraw of the late player who took the bye (case b).** Undo must refuse by name and point to Withdraw. The Withdraw must walk the board over to the former bye holder, who then holds win points and is bye-ineligible (rulebook §4 walkover row). Pinned in Task 9: `X-SW-LE-1 sequence: (b) then Undo then Withdraw`.
3. **A Rebuild whose regenerate throws (e.g. `STAGE_NOT_READY`).** The old board must still exist with its times and courts; no empty stage may be left behind. Pinned in Task 1: `X-SW-RB-1 a regenerate that throws rolls the delete back`.
4. **A payment webhook confirming a registration on a Swiss division whose last round has started.** The confirmation must commit, the entrant must be recorded and named on the desk, and nothing must re-pair. Pinned in Task 9: `X-SW-LE-2 an automatic arrival with no round left never fails the confirmation`.
5. **An odd-field Pair of round 1 BEFORE Start, once byes freeze their config.** Rules must stay editable, Unpair and Rebuild must still work, and the rule locks must not trip on a bye. Pinned in Task 3: `a frozen bye is not PLAYED: stage rules stay editable, Unpair clears it`.

---

## Task 0: Live-data pre-flight (read-only; controller-run, no code)

**Files:** none in the repo. Write output to `$S/preflight.md` only. Its findings later go into the PR body and a short dated note under `_INDEX.md` "W3 status" (not a ruling).

**Why:** spec §7, the brief, and RB3-15 ("confirm that no live Swiss division holds an ad-hoc fixture"). Several tasks below change behaviour for live divisions mid-round.

- [ ] **Step 1: stg (standing read OK).**
  - URL: the commented `REMOTE_DATABASE_URL` in `seazn.club/.env.local:9`. Pass it via env only, never argv, logs or chat. Connect with `default_transaction_read_only=on`, `search_path=seazn_club`. Use the `postgres` package via a `createRequire` of `apps/web`.
  - Run six counts, each grouped by division id and sport:
    1. **Byes paid a custom forfeit row ≠ win points.** Before writing the SQL, read the rule's shape at `apps/web/src/server/engine-db/competition.ts:419-431` and `server/engine-db/table-rules.ts:339-357`, and the engine's `competition/points.ts:358-395` (in `~/github/seazn.club.engine`). Then list Swiss bye rows (`ext_key like 'sw-r%-bye' and outcome->>'reason' = 'bye'`) whose effective points rule (the pinned stage rule, else the stage `config.points`, else the division `config.points`) carries a `forfeit` row whose winner points ≠ `win`.
    2. **Ad-hoc fixtures in Swiss stages:** `fixtures f join stages s … where s.kind='swiss' and f.ext_key like 'adhoc-%'`.
    3. **Bye shells holding a slot:** `ext_key like 'sw-r%-bye' and (scheduled_at is not null or court_id is not null)`.
    4. **Entrants created after the division started, in a division with a Swiss stage.** Use the earliest `fixtures_generated` event that carries `seated_fixture_ids` as the start proxy, and list each with the rounds it was absent from.
    5. **Swiss stages whose `config.rounds` > hard max of the current active field** (rulebook §3.1: n−1 if n even, n if odd). These would be refused at their next Pair by Task 11.
    6. **Boardgame Swiss stages with `config.chess` unset** (Task 8 turns their colours on).
- [ ] **Step 2: prod (approved 2026-10-31, read-only, one query).**
  - Prod is held at v1.0.7-beta, Flyway V417. Write the query against **V417's schema**: no `stage_table_rules`, so the points rule is the stage or division config only.
  - Run count 1 only, plus counts 2 and 3 if they fit the same statement.
  - The prod connection route is not on record in memory. Ask the owner for it in chat. Never put it in argv, a log or chat.
- [ ] **Step 3: Decide and record.**
  - **Count 1 = 0 on both:** the PR body says so (§7). If > 0: a LOUD note plus a pre-deploy migration, owned by the **engine bump PR** (the bye-points change is engine-side). Record it there; nothing in this PR.
  - **Count 2 > 0:** stop and raise to the owner before Task 4, because RB3-15 A assumed none.
  - **Count 3:** cleared by Task 3's migration. Quote the count in the PR body.
  - **Count 4 > 0:** Task 6's migration backfills `swiss_first_round` for exactly those entrants (LOUD).
  - **Count 5 > 0:** raise to the owner before Task 11 merges; the refusal would land mid-event.
  - **Count 6:** quote it in the PR body.

---

## Task 1: Rebuild keeps times and courts, in one transaction, format-agnostic (#840, FX-G13)

**Rules (§12):** "Rebuild keeps times and courts, in one transaction" (design G3) → **X-SW-RB-1**.

**Files:**
- Create: `apps/web/src/lib/rebuild-slots.ts` (pure, client-safe).
- Modify: `apps/web/src/server/usecases/stages.ts`:
  - `rebuildStageFixtures` at `:3330-3509`;
  - extract the body of `generateStageFixturesWrite`'s main `withTenant` (`:2629-~3115`) into `generateStageFixturesTx`.
- Test:
  - `apps/web/src/lib/__tests__/rebuild-slots.test.ts`;
  - `apps/web/src/server/usecases/__tests__/stage-roster-drift.test.ts` (extend);
  - `apps/web/src/server/usecases/__tests__/rebuild-one-transaction.test.ts`.
- Create (shared harness for later tasks):
  - `apps/web/e2e/w3-swiss-app-a.spec.ts`;
  - `scripts/smoke/suites/w3SwissA.ts`, plus the wiring in `scripts/smoke/{main,harness,index}.ts`.

**Interfaces:**
- Produces:
  - `type SlotKey = { round_no: number; seq_in_round: number; pool_id: string | null }`.
  - `type CarriedSlot = { scheduled_at: string | null; court_id: string | null; venue_id: string | null; schedule_locked: boolean }`.
  - `carrySlots(before: ReadonlyArray<SlotKey & CarriedSlot & { ext_key: string | null }>, after: ReadonlyArray<SlotKey & { id: string; ext_key: string | null }>): { assign: Map<string, CarriedSlot>; freed: CarriedSlot[]; unscheduled: string[] }`. Matching is by `(pool_id, round_no, seq_in_round)`. A row whose `ext_key` ends `-bye` never gives or takes a slot (RB3-23). `freed` lists slots with no match that held a time or court. `unscheduled` lists new ids with no match.
  - `generateStageFixturesTx(tx: Tx, auth: AuthCtx, stageId: string, opts: GenerateOptions): Promise<GenerateWrite>`. This is the old main-transaction body, unchanged in behaviour. The caller holds `tx`, and the function takes the advisory lock idempotently.
  - `RebuildOutcome` gains `slots: { kept: number; freed: number; unscheduled: number }`.
- Consumes: nothing new.

- [ ] **Step 1: Write failing unit tests** in `rebuild-slots.test.ts`:
  - `X-SW-RB-1 carrySlots keeps every slot whose (pool, round, seq) survives`;
  - `… frees a slot whose position no longer exists and reports it`. A 6-board round 1 becoming 5 frees exactly the round-1 seq-6 slot;
  - `… a bye row neither gives nor takes a slot`;
  - `… empty before → every new row unscheduled, freed = []` (empty case first, R13).
  - Cover a league (pool null), a group (two pools, the same `(round, seq)` in each must not cross pools) and a Swiss shell set.
- [ ] **Step 2: Write failing DB tests** in `rebuild-one-transaction.test.ts`. The first two are the regression, red on main:
  - `X-SW-RB-1 a Swiss pre-Start Rebuild keeps every board's scheduled_at and court_id`. Set it up by pinning times and courts on rounds 1–3 shells, withdrawing one entrant (roster drift), and pressing Rebuild.
  - `X-SW-RB-1 a league Rebuild keeps slots by position`. This is the format-agnostic case W5 consumes.
  - `X-SW-RB-1 a regenerate that throws rolls the delete back`. Make the regenerate throw (a group stage with too few entrants per group, `group_too_few_entrants`). Assert the old fixture ids still exist with their slots, and the stage fixture count is unchanged.
  - `Rebuild still refuses STAGE_HAS_RESULTS and SCHEDULE_LOCKED before any delete`: a guard regression; both existing refusals keep their codes.
- [ ] **Step 3: Run, verify FAIL:** `VERIFY-WEB t1 src/lib/__tests__/rebuild-slots.test.ts src/server/usecases/__tests__/rebuild-one-transaction.test.ts`. The two keep-slots tests fail on null slots, and the rollback test fails with the old fixtures gone.
- [ ] **Step 4: Implement.**
  - Write `carrySlots`.
  - Extract `generateStageFixturesTx`; `generateStageFixturesWrite` keeps its pre-flight block and now calls it inside its `withTenant`.
  - In `rebuildStageFixtures`, keep every existing guard in its order. Then, in the SAME transaction:
    1. read the before-slots;
    2. run the delete;
    3. call `generateStageFixturesTx`;
    4. read the new rows and apply `carrySlots` with one `update … from (values …)`;
    5. return `slots`.
  - The publish moves after commit. Analytics and `recomputeStandings` stay outside the transaction, as `generateStageFixtures` does them today.
  - Rewrite the doc comment at `:3316-3329`, which says "two transactions".
- [ ] **Step 5: Desk copy.** The roster-drift Rebuild notice (`stages-panel.tsx`, `progression.rosterDrift.*`) says "N slots kept, M freed, K unscheduled" when `freed + unscheduled > 0`. Add the keys in 4 locales and run `i18n:gen-keys`. Add `src/components/v2/__tests__/stages-panel-roster-drift.test.tsx` cases for the notice string.
- [ ] **Step 6: Run, verify PASS.** Run the Step 3 files plus `src/server/usecases/__tests__/stage-roster-drift.test.ts`, `src/server/usecases/__tests__/stages-schedule-lock.test.ts` and `src/components/v2/__tests__/stages-panel-roster-drift.test.tsx`. Run tsc.
- [ ] **Step 7: Mutate once each.**
  - Split the transaction again (move the delete back into its own `withTenant`). The rollback test must go red.
  - Make `carrySlots` return an empty `assign`. The keep-slots tests must go red.
- [ ] **Step 8: Shared harnesses.**
  - Create `w3-swiss-app-a.spec.ts`, modelled on `apps/web/e2e/stage-roster-drift.spec.ts`. Its first describe, `X-SW-RB-1 rebuild keeps the board`, pins a court and time, withdraws an entrant, presses Rebuild, and reads the slot back on the run sheet.
  - Create `w3SwissA.ts`, modelled on `suites/w2dTables.ts`, with its own owner email, `EXPECTED_CHECKS = 2` and a zero-checked failure. Check 1: rebuild keeps 3 slots. Check 2: `slots.freed` counted. Wire it into `main.ts`, `harness.ts` and `index.ts`, then run `scripts/__tests__/smoke-{paths,select,manifest}.test.ts` via VERIFY-WEB from `$WT`.
- [ ] **Step 9: Commit** `feat(w3): Rebuild keeps times and courts in one transaction (#840, FX-G13)`.

## Task 2: Pre-Start reshape keeps pinned slots (SW-L8)

**Rules (§12):** the same row → **X-SW-RB-1**. The spec §4 "Before Start" paragraph says the reshape inherits G3.

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts`:
  - `reconcileSwissRoundShells` at `:1706-1830`: surplus deleted `:1765-1768`; mint names `:1810-1813`;
  - `SwissExistingFixture` at `:1222` gains `scheduled_at`, `court_id` and `schedule_locked`, plus every `select` that loads it (`:2707`, `:2461`).
- Test: `apps/web/src/server/usecases/__tests__/swiss-withdrawal-reconcile.test.ts` (extend).

**Interfaces:**
- Produces: `chooseDoomedBoards(rows: SwissExistingFixture[], keep: number): { survivors: SwissExistingFixture[]; doomed: SwissExistingFixture[] }`, exported for the test. A board is doomed first if it has no time and no court, then if it is not `schedule_locked`, then by highest seq. Survivors are re-packed to `seq_in_round` 1..keep in their prior order, and keep their `ext_key`. A minted board takes the smallest unused `b` index.

- [ ] **Step 1: Write failing tests.**
  - `X-SW-RB-1 a shrinking pre-Start round deletes the unscheduled board, not the pinned seq-4 board`. Set up 8 entrants with times and courts on boards 1, 2 and 4 of round 2 and board 3 unscheduled. Withdraw one entrant pre-Start, so round 2 needs 3 boards plus a bye. Assert boards 1, 2 and 4 survive with their slots.
  - `ext_keys stay unique and seqs contiguous after a shrink then a grow`. Shrink, enrol two entrants, and Pair. Every `sw-rN-bK` must be unique and `seq_in_round` must be 1..k.
  - `all boards pinned → the highest-seq board goes and the delta counts it`. The ordering differential: the existing behaviour stays the fallback.
- [ ] **Step 2: Run FAIL:** `VERIFY-WEB t2 src/server/usecases/__tests__/swiss-withdrawal-reconcile.test.ts`.
- [ ] **Step 3: Implement** `chooseDoomedBoards` and use it in place of `slice(0, boards)`. Re-pack survivor seqs (with one `update` per moved row, before the mint), and change the mint naming.
- [ ] **Step 4: Run PASS.** Run the Step 2 file plus `swiss-shell-fixtures.test.ts`, `swiss-delete-entrant.test.ts` and `swiss-walkover-saturday.test.ts`.
- [ ] **Step 5: Mutate** the first sort key (drop the unscheduled-first rule). The first test must go red.
- [ ] **Step 6: E2E + smoke.** Add a describe `X-SW-RB-1 pre-Start reshape keeps pinned boards`, and smoke check 3 (`EXPECTED_CHECKS` = 3).
- [ ] **Step 7: Commit** `fix(w3): a pre-Start Swiss reshape keeps the boards that hold a slot (SW-L8)`.

## Task 3: A bye is frozen at award, never on a court, never printed (SW-M7, SW-M13)

**Rules (§12):**
- "A bye shell is never on a court and never printed" (RB3-23) → **X-SW-BY-1**.
- "frozen at award" is RB3-7(a)'s app half, part of the engine PR's bye row → test token **X-SW-BY-2** (see the id table).

**Files:**
- Modify:
  - `apps/web/src/server/usecases/fixture-results-sql.ts`:
    - add `systemByeSql`;
    - `fixtureEvidenceSql` at `:61-71`: its `config_snapshot` clause exempts a system bye.
  - `apps/web/src/server/engine-db/format-standing.ts`: `playedSql` at `:20-24` gets the same exemption.
  - `apps/web/src/server/usecases/stages.ts`:
    - the bye seat at `:1533-1549` writes `config_snapshot` and `config_snapshot_at`, and nulls `scheduled_at` and `court_id`;
    - `clearSwissFixtureSeats` at `:2335-2360` also nulls `config_snapshot` and `config_snapshot_at`.
  - `apps/web/src/server/usecases/schedule.ts`:
    - `movableFixtureSql` at `:200-202` and `isMovable` at `:186` exclude Swiss bye shells;
    - `moveFixture` at `:3033` refuses `SWISS_BYE_NOT_PLACEABLE`.
  - `apps/web/src/lib/scorer-sheets.ts`: `isPrintable` at `:103` and its `SheetDayRow` (+ `ext_key`).
  - `apps/web/src/server/usecases/scorer-sheets.ts`: the candidate select and `listSheetDays` at `:232-247`.
- Create: `db/migration/deltas/V<next>__w3_bye_shells_off_court.sql` (DATA CHANGE, LOUD): `update fixtures set scheduled_at = null, court_id = null where ext_key like 'sw-r%-bye' and (scheduled_at is not null or court_id is not null)`. It is idempotent.
- Test:
  - `apps/web/src/server/usecases/__tests__/swiss-bye-snapshot.test.ts`;
  - `apps/web/src/lib/__tests__/scorer-sheets.test.ts` (extend);
  - `apps/web/src/server/usecases/__tests__/schedule-bye-shell.test.ts`;
  - `apps/web/src/server/__tests__/w3-migration.test.ts`.

**Interfaces:**
- Produces:
  - `isSwissByeShellExtKey(extKey: string | null): boolean` in `apps/web/src/lib/swiss-shell.ts` (true for `/^sw-r\d+-bye$/`);
  - `swissByeShellSql(tx, on = "f")` (= `${f}.ext_key ~ '^sw-r[0-9]+-bye$'`) in `fixture-results-sql.ts`;
  - `systemByeSql(tx, on = "f")` = one seat null and `outcome->>'reason' = 'bye'`;
  - `SWISS_BYE_NOT_PLACEABLE` in `lib/swiss-refusals.ts` (Task 4 creates the file; if Task 3 lands first, create it here with this one code).
- Consumes: `resolveFixtureCfg` (`engine-db/fixture-cfg.ts:101`) and `resolveModule` for the frozen cfg. The cfg is exactly what `append-event.ts:457` would freeze at a first event.

**Premise found:** "snapshot at award" is not a one-line write. `config_snapshot is not null` is PLAYED in `fixtureEvidenceSql` (`fixture-results-sql.ts:64`) and in `playedSql` (`format-standing.ts:23`). Without the exemption, an odd-field Pair would:
- lock the stage's and division's rules (`rule-locks.ts`);
- make Unpair, the reshape, Rebuild and Undo refuse every round that has a bye.

- [ ] **Step 1: Write failing tests** (`swiss-bye-snapshot.test.ts`; sports badminton AND boardgame through the same body):
  - `X-SW-BY-2 a seated bye carries config_snapshot equal to the stage cfg at award`. The expected value is `resolveFixtureCfg` of the stage and division as read before Pair, not the product's output. Then change the stage `config.points.win` (pre-Start) and assert the bye row's snapshot is unchanged.
  - `a frozen bye is not PLAYED: stage rules stay editable, Unpair clears it`. Pair an odd round 1 pre-Start. `PUT` the stage rules and get 200. Unpair, and assert the bye row's seats, outcome AND snapshot are null.
  - `a frozen bye does not block Rebuild or Undo`.
  - `a real walkover over a dead seat (ruling 116) is still evidence`. This is the guard's positive pair: an `awardSeededByes`-shaped row with `reason != 'bye'` stays in `fixtureEvidenceSql`.
- [ ] **Step 2: Write failing schedule and print tests.**
  - `X-SW-BY-1 the auto pass never places a Swiss bye shell` (`schedule-bye-shell.test.ts`): pre-Start shells, an odd field, `autoSchedule`. Zero rows with `ext_key ~ -bye` hold a court; count > 0 boards placed (anti-vacuity).
  - `X-SW-BY-1 moveFixture onto a bye shell refuses SWISS_BYE_NOT_PLACEABLE`.
  - `X-SW-BY-1 seating a bye clears a slot the shell held`.
  - `X-SW-BY-1 an unseated Swiss bye shell with a time does not print` (`scorer-sheets.test.ts`). Its positive pair: an unlabelled Swiss BOARD shell with a time still prints (W8 owns sheet content).
- [ ] **Step 3: Run FAIL:** `VERIFY-WEB t3 src/server/usecases/__tests__/swiss-bye-snapshot.test.ts src/server/usecases/__tests__/schedule-bye-shell.test.ts src/lib/__tests__/scorer-sheets.test.ts`.
- [ ] **Step 4: Implement** the files above. In `swissGen`, load the division's `sport_key`, `module_version` and `config` once, under the lock.
- [ ] **Step 5: Migration test** (`w3-migration.test.ts`): seed two bye shells with slots and one board with a slot. After the migration, the byes are slotless and the board is untouched. A second run changes 0 rows.
- [ ] **Step 6: Run PASS:** the Step 3 files plus `w3-migration.test.ts`, `src/server/usecases/__tests__/fixture-results-sql.test.ts` (if present; else the evidence cases live in `swiss-bye-snapshot.test.ts`), `src/server/usecases/__tests__/rule-locks*.test.ts` (name the files) and `src/lib/__tests__/status-set-sweep.test.ts`. Run tsc.
- [ ] **Step 7: Mutate**, one at a time:
  - drop the exemption in `fixtureEvidenceSql` → `Unpair clears it` goes red;
  - drop the exemption in `playedSql` → `stage rules stay editable` goes red;
  - drop the bye filter in `movableFixtureSql` → the auto-pass test goes red;
  - drop the `ext_key` test in `isPrintable` → the print test goes red.
- [ ] **Step 8: E2E + smoke.**
  - E2E describe `X-SW-BY-1 a bye has no court and no sheet`: an odd field, auto-schedule, the board shows the bye without a court, and the sheet PDF list excludes it.
  - Smoke checks 4 and 5 (a bye snapshot present; a bye row with no court). `EXPECTED_CHECKS` = 5.
- [ ] **Step 9: Commit** `fix(w3): a Swiss bye freezes at award and never takes a court or a sheet (SW-M7, SW-M13)`. List the migration in the commit body as a DATA CHANGE.

## Task 4: Refuse "Add match" on a Swiss stage (RB3-15 A; #846, SW-M3/M4/M5)

**Rules (§12):** "Ad-hoc 'Add match' refused on a Swiss stage" (RB3-15) → **X-SW-AH-1**.

**Files:**
- Create: `apps/web/src/lib/swiss-refusals.ts`. It is client-safe and holds every W3 code, its English sentence and `swissRefusalKey(code): MessageKey`.
- Modify:
  - `apps/web/src/server/usecases/stages.ts:6315` (`ADHOC_STAGE_KINDS` loses `swiss`) and `addFixture` at `:6317-6345` (an explicit Swiss refusal BEFORE the generic bracket refusal);
  - `apps/web/src/components/v2/desk/stage-rail.tsx`: the `stage-add-match` trigger is not rendered for `kind === "swiss"`; in its place the rail's overflow shows the guidance line.
- Test:
  - `apps/web/src/server/usecases/__tests__/add-fixture.test.ts` (extend);
  - `apps/web/src/lib/__tests__/swiss-refusals.test.ts`;
  - `apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx` (extend).

**Interfaces:**
- Produces:
  - `SWISS_REFUSALS: Record<SwissRefusalCode, { status: 409 | 422; message: string; key: MessageKey }>`;
  - `swissRefusal(code, details?): HttpError` (server side, in `apps/web/src/server/usecases/swiss-refusal.ts`, importing the client-safe table).
  - Codes defined here, for every later task:
    - `SWISS_ADHOC_REFUSED`;
    - `SWISS_BYE_NOT_PLACEABLE`;
    - `SWISS_UNDO_ROUND_STARTED`;
    - `SWISS_LATE_ENTRY_NOT_UNDOABLE`;
    - `SWISS_ROUNDS_CHANGE_NOT_UNDOABLE`;
    - `SWISS_NO_ROUND_LEFT`;
    - `SWISS_OVER`;
    - `SWISS_ROUNDS_ABOVE_MAX`;
    - `SWISS_ROUNDS_LOCKED`;
    - `SWISS_ROUNDS_BELOW_SEATED`;
    - `SWISS_FINISH_ROUND_UNDECIDED`;
    - `SWISS_FINISH_NOTHING_PLAYED`;
    - `STAGE_NOT_SWISS`.
  - Copy for `SWISS_ADHOC_REFUSED` (RB3-15, verbatim intent): "Swiss rounds are paired by the system. Add friendlies in another stage."

- [ ] **Step 1: Write failing tests.**
  - `X-SW-AH-1 Add match on a Swiss stage refuses SWISS_ADHOC_REFUSED and writes nothing`: count the fixtures before and after.
  - `league and group still accept an ad-hoc fixture`: the positive pair; the existing cases stay green.
  - `every SwissRefusalCode has a key present in all 4 dictionaries`: iterate the table and fail on a count of 0.
  - In the rail test: `a Swiss stage renders no stage-add-match trigger; a league stage does`.
- [ ] **Step 2: Run FAIL**, implement, add the copy in 4 locales, run `i18n:gen-keys` and `i18n:check`, then run PASS: `VERIFY-WEB t4 src/server/usecases/__tests__/add-fixture.test.ts src/lib/__tests__/swiss-refusals.test.ts src/components/v2/desk/__tests__/stage-rail.test.tsx`. Run `openapi:gen` (the 422 is documented).
- [ ] **Step 3: Mutate:** restore `swiss` into `ADHOC_STAGE_KINDS` and drop the explicit check. The refusal test must go red.
- [ ] **Step 4: E2E + smoke.** Describe `X-SW-AH-1 no Add match on a Swiss stage` (the rail has no trigger, and an API POST gets 422). Smoke check 6. `EXPECTED_CHECKS` = 6.
- [ ] **Step 5: Commit** `feat(w3): refuse ad-hoc matches on a Swiss stage (RB3-15 A, #846)`.

## Task 5: Undo of Pair next clears the seats; undo barriers (SW-M2/#835, RB3-22, design §10.8)

**Rules (§12):** "Undo of Pair next clears seats if no result, else a named refusal; Add late player has no Undo" → **X-SW-UN-1**.

**Premise found:** gaps.md labels SW-M2 BOTH. It is app-only. The engine's inverse carries `__undo_of: <seq>` (engine `history/history.ts:248-264`), so the app reads `seated_fixture_ids` from the undone event in its own ledger.

**Files:**
- Modify:
  - `apps/web/src/server/usecases/history.ts`:
    - `stepWrite` at `:615-735`, after `engineUndo`/`engineRedo` and before `execute`;
    - add `undoBarrierRefusal`.
  - `apps/web/src/server/usecases/stages.ts`: export `clearSwissFixtureSeats`.
  - `apps/web/src/components/v2/history-panel.tsx`: labels for the event types `swiss_late_entry` and `swiss_rounds_changed` (find the type→label map; 4 locales).
  - The Undo control's error toast maps the new codes via `swissRefusalKey`. Find it with `grep -rl "history/undo" apps/web/src/components`.
- Test:
  - `apps/web/src/server/usecases/__tests__/swiss-playoff-pairing.test.ts:640-659` (rewrite that case);
  - `apps/web/src/server/usecases/__tests__/swiss-undo-pair-next.test.ts`.

**Interfaces:**
- Produces:
  - `UNDO_BARRIER_TYPES = { swiss_late_entry: "SWISS_LATE_ENTRY_NOT_UNDOABLE", swiss_rounds_changed: "SWISS_ROUNDS_CHANGE_NOT_UNDOABLE" } as const`.
  - `undoBarrierRefusal(ledger: LedgerEvent[], targetSeq: number): SwissRefusalCode | null`. It returns the code of the newest barrier with `seq > targetSeq`. A `swiss_late_entry` is a barrier only when `payload.source === "organiser"`. It applies to both Undo and Redo targets.
  - Ledger payloads later tasks write:
    - `swiss_late_entry {stage_id, entrant_id, case: "a"|"b"|"c", round: number, source: "organiser"|"registration"|"waitlist"|"import"}`;
    - `swiss_rounds_changed {stage_id, from: number, to: number, via: "edit"|"add_round"|"finish"}`.
- Consumes: `clearSwissFixtureSeats`, `fixtureHasResultSql`, `recomputeStandings`.

- [ ] **Step 1: Rewrite the old test.** Its name becomes `X-SW-UN-1 Undo of Pair next clears round 1's seats and keeps the shells`. It asserts:
  - every round-1 row has `home_entrant_id` and `away_entrant_id` null, `status` `scheduled` and `outcome` null;
  - the bye row's snapshot is null;
  - the shell count is unchanged, and so are the ids and the slots.
  It also keeps the old shell-count assertion.
- [ ] **Step 2: Write further failing tests** in `swiss-undo-pair-next.test.ts` (badminton + boardgame):
  - `X-SW-UN-1 a started board refuses SWISS_UNDO_ROUND_STARTED and clears nothing`: one board has a `core.start` event.
  - `X-SW-UN-1 Redo after Undo seats round 1 again`, with the same pairing (deterministic).
  - `X-SW-UN-1 Undo walks back round 2 then round 1, seats cleared each time`: the sequence.
  - `X-SW-UN-1 Undo after a withdrawal re-pairs nobody until Pair next`.
  - `X-SW-UN-1 an organiser swiss_late_entry is a barrier; an automatic one is not`. Insert the two ledger rows by hand: `undoBarrierRefusal` is unit-tested on literal ledgers, and the route is tested with a DB row.
  - `standings drop the cleared bye's points` (`recomputeStandings` with `emptyFold: "drop"`, as Unpair does).
- [ ] **Step 3: Run FAIL:** `VERIFY-WEB t5 src/server/usecases/__tests__/swiss-playoff-pairing.test.ts src/server/usecases/__tests__/swiss-undo-pair-next.test.ts`.
- [ ] **Step 4: Implement.** In `stepWrite`:
  1. Find the event being inverted (`result.event.payload.__undo_of`, or `__redo_of` for redo).
  2. Barrier check first; a barrier throws `swissRefusal(code)` before any write.
  3. If the inverted event is `fixtures_generated` with a non-empty `seated_fixture_ids` (undo only): select those ids under `fixtureHasResultSql`. If any has a result, throw `SWISS_UNDO_ROUND_STARTED`. Otherwise call `clearSwissFixtureSeats(tx, seatedIds)` and push the ids into `fixtureIds`.
  4. After commit, `recomputeStandings(…, { emptyFold: "drop" })` for the stage.
  Restore Checkpoint loops `step`, so it inherits both behaviours; add one case `restore across a late entry refuses SWISS_LATE_ENTRY_NOT_UNDOABLE`.
- [ ] **Step 5: Run PASS:** the Step 3 files plus `src/server/usecases/__tests__/history*.test.ts` (name each) and `src/server/usecases/__tests__/swiss-shell-fixtures.test.ts`. Run tsc.
- [ ] **Step 6: Mutate**, one at a time:
  - skip the seat clear → the X-SW-UN-1 seats test goes red;
  - drop the started guard → the refusal test goes red;
  - make `undoBarrierRefusal` return null → the barrier test goes red.
- [ ] **Step 7: E2E + smoke.**
  - E2E describe `X-SW-UN-1 Undo clears a paired round`: Pair, press Undo on the history panel, and the board shows empty seats.
  - Smoke check 7 (Undo leaves 0 seated round-1 rows). `EXPECTED_CHECKS` = 7.
- [ ] **Step 8: Commit** `fix(w3): Undo of Pair next clears the seats; late entries and round changes are undo barriers (#835)`.

**Batch 1 ends here** (Tasks 1–5). Run an Opus `reviewer` pass over the batch diff, push, then dispatch the e2e.

## Task 6: Field model — first Swiss round per entrant; missed rounds credit 0 (§4 scoring, ruling 251)

**Rules (§12):**
- "Late entrant: 0 per missed round, no score" is the engine PR's row. This task is its app half: the pairing score in `swissGen`. Test token **X-SW-MR-1**.
- "Late entry cases" → **X-SW-LE-1** (the case (c) exclusion).

**Files:**
- Create: `db/migration/deltas/V<next>__w3_swiss_first_round.sql`:
  - `alter table entrants add column swiss_first_round int check (swiss_first_round >= 1)`;
  - if Task 0's count 4 > 0, an `update` backfilling exactly those entrants (DATA CHANGE, LOUD, idempotent).
- Modify: `apps/web/src/server/usecases/stages.ts`:
  - `ActiveEntrant` and the active select at `:2635-2638` carry `swiss_first_round`;
  - `swissGen`: the field filter at `:1253` entry and the implicit-bye loop at `:1401-1427`.
- Test:
  - `apps/web/src/server/usecases/__tests__/swiss-late-field.test.ts`;
  - `apps/web/src/server/__tests__/w3-migration.test.ts` (extend).

**Interfaces:**
- Produces:
  - `swissFieldForRound(entrants: ActiveEntrant[], target: number): ActiveEntrant[]` (drops `swiss_first_round > target`), exported;
  - the implicit-bye loop credits and bye-marks an entrant for round `r` only when `(swiss_first_round ?? 1) <= r`.
- Consumes: none.

- [ ] **Step 1: Write failing tests** (badminton + boardgame, the same body):
  - `X-SW-MR-1 an entrant created after round 2 was seated scores 0, not +2, in round 3's score groups`. Expected (rulebook §4 late-entry row, A2 2.4): 0 per missed round. Assert through the pairing: with 7 players after 2 rounds and one 0-point latecomer, the latecomer is paired inside the 0-point group (or takes the bye), never the 2-point group. Spy on `pairRound`'s standings input via `vi.spyOn` on the module export, plus the seated result.
  - `X-SW-MR-1 a missed round is not a bye: the latecomer is still bye-eligible` (P-A4).
  - `X-SW-LE-1 an entrant whose first round is 4 is not seated in round 3`. A Pair of round 3 never seats them; this is the after-Undo path.
  - `entrants with swiss_first_round null behave exactly as today`: the legacy pair, with the implicit bye from a round with no bye row still credited (owner value: live rounds keep their pairings).
- [ ] **Step 2: Run FAIL:** `VERIFY-WEB t6 src/server/usecases/__tests__/swiss-late-field.test.ts`.
- [ ] **Step 3: Implement**, then the migration test (`w3-migration.test.ts`): the column exists, the check rejects 0, and a second run is a no-op.
- [ ] **Step 4: Run PASS:** the Step 2 file plus `w3-migration.test.ts`, `swiss-shell-fixtures.test.ts`, `swiss-withdrawal-reconcile.test.ts` and `swiss-walkover-saturday.test.ts`. Run tsc.
- [ ] **Step 5: Mutate:** remove the `swiss_first_round` condition in the implicit-bye loop → `X-SW-MR-1 … scores 0` goes red. Separately, remove `swissFieldForRound` → `… not seated in round 3` goes red.
- [ ] **Step 6: Smoke** check 8 (an entrant with `swiss_first_round` set is not on a round below it). E2E is owed through Task 10's describe, which drives the same path from the UI. `EXPECTED_CHECKS` = 8.
- [ ] **Step 7: Commit** `fix(w3): a Swiss latecomer's missed rounds score 0, not +1 each (ruling 251)`. The migration is listed.

## Task 7: Unplayed pairs may meet again (RB3-2, RB3-14; `stages.ts:1376`)

**Rules (§12):** "Unplayed pairs (double walkover) may meet again; a walkover winner stays bye-ineligible" → **X-SW-UP-1**.

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts`, `swissGen`'s history loop at `:1360-1400`.
- Test:
  - `apps/web/src/server/usecases/__tests__/swiss-two-sided-walkover-pairing.test.ts` (update: it pins today's "met" rule);
  - `apps/web/src/server/usecases/__tests__/swiss-unplayed-rematch.test.ts`.

**Interfaces:**
- Consumes: `forfeitPlayedFacts(db, fixtures, module)` (`engine-db/forfeit-played.ts:26`) for the stage's two-seated award fixtures, under the division's module.
- Produces: in `swissGen`, a two-seated fixture adds its pair to `played` unless its outcome is `double_walkover`, or an `award` whose forfeit played-fact is `false`. `byes.add(winner)` for an award winner is unchanged (P-A4).

- [ ] **Step 1: Read** `swiss-two-sided-walkover-pairing.test.ts` and list every assertion that pins "a walkover counts as met". Each is updated to the signed rule, and the commit body names each one (AGENTS.md class 4: a test that froze a now-overruled rule).
- [ ] **Step 2: Write failing tests** (rulebook §2.1 P-A2 and the §4 rows):
  - `X-SW-UP-1 a double walkover pair may meet again`: 4 players, 3 rounds. Force the only legal round-3 pairing to be the double-walkover pair, and assert it is seated.
  - `X-SW-UP-1 a pre-play walkover (reason walkover) pair may meet again`.
  - `X-SW-UP-1 a retirement after play is met: no rematch`: the positive pair.
  - `X-SW-UP-1 a walkover winner is still never given the bye`.
  - The same four for boardgame, where `startIsPlay` is true: a forfeit after `core.start` IS played (ruling 118).
- [ ] **Step 3: Run FAIL**, implement, run PASS: `VERIFY-WEB t7 src/server/usecases/__tests__/swiss-unplayed-rematch.test.ts src/server/usecases/__tests__/swiss-two-sided-walkover-pairing.test.ts src/server/usecases/__tests__/swiss-colour-history-double-walkover.test.ts src/server/usecases/__tests__/swiss-walkover-saturday.test.ts`.
- [ ] **Step 4: Mutate:** treat every two-seated row as met again → the double-walkover test goes red. Separately, treat a retirement as unplayed → the retirement test goes red.
- [ ] **Step 5: Smoke** check 9 (a double-walkover pair is re-paired in a forced 4×3). `EXPECTED_CHECKS` = 9. There is no UI change; e2e is owed via the Task 10 describe, which records a double walkover through `forfeit-dialog.tsx` and pairs again.
- [ ] **Step 6: Commit** `fix(w3): unplayed Swiss pairs may meet again (RB3-2)`.

## Task 8: Seeded random round 1, chess colours default on, round-1 colour by lot (SW-L6, SW-H3)

**Rules (§12):**
- "Seeded random draw for an unseeded round 1" (RB3-16) → **X-SW-DR-1**.
- "Chess colours on by default for boardgame Swiss; round-1 colour by lot" (RB3-10) → **X-SW-CC-1**.

**Files:**
- Create: `apps/web/src/lib/swiss-draw.ts` (pure, client-safe).
- Modify: `apps/web/src/server/usecases/stages.ts`:
  - `swissGen` at `:1430-1446`: the round-1 order and `chess:`;
  - the post-`pairRound` round-1 colour swap;
  - the audit payload at `:2730-2738` gains `draw_seed` and `colour_lot`.
- Test:
  - `apps/web/src/lib/__tests__/swiss-draw.test.ts`;
  - `apps/web/src/server/usecases/__tests__/swiss-round-one-draw.test.ts`.

**Interfaces:**
- Produces:
  - `swissDrawSeed(stageId: string): number`: a stable 32-bit hash of the id, so a draw can be replayed.
  - `swissRoundOneOrder(seed: number, entrants: { id: string; seed: number | null }[]): string[]`. Seeded entrants come first, by seed; the unseeded ones follow, Fisher–Yates shuffled with `mulberry32(seed)`. Move `mulberry32` from `lib/marketing/club-names.ts:15` into `lib/swiss-draw.ts` and import it back; do not copy it.
  - `swissColourLot(seed: number): "white" | "black"`: the upper player on board 1 takes this colour, and boards alternate (FIDE C.04.3 A3 5.1).
  - `swissChessColoursOn(cfg: Record<string, unknown>, sportKey: string): boolean` = `cfg.chess ?? sportKey === "boardgame"`.
  - `applyRoundOneColourLot(pairings: {home: string; away: string}[], lot): {home; away}[]`: board i (0-based) keeps upper-at-home iff `(i % 2 === 0) === (lot === "white")`.
- Consumes: `pairRound`'s round-1 pairings, which have the upper player at home (engine `swiss.ts:325`).

- [ ] **Step 1: Write failing unit tests:**
  - `X-SW-DR-1 an unseeded round 1 does not follow registration order`: register 8 in a known order, and assert the drawn order differs from it under the stage's seed;
  - `… is identical for the same seed and the same field`: the replay;
  - `… seeded entrants keep their seed order ahead of the draw`;
  - `X-SW-CC-1 the colour lot alternates by board`: enumerate boards 1–4 for both lots (8 rows, count asserted);
  - `X-SW-CC-1 chess is on for boardgame unless config.chess is false; off for every other sport`. Iterate the sport registry (`forEachSport` from `@seazn/engine/testkit`), assert count > 0, and derive the expected value from the sport key.
- [ ] **Step 2: Write failing DB tests:**
  - `X-SW-CC-1 a boardgame Swiss with no config.chess alternates colours in round 2`: SW-H3's regression. After round 1, every player with White in round 1 gets Black in round 2 where the pairing allows; assert over all boards, with the count printed.
  - `X-SW-DR-1 the audit payload records draw_seed and colour_lot`.
  - `a badminton Swiss keeps upper-at-home in round 1`: no lot outside chess.
- [ ] **Step 3: Run FAIL**, implement, run PASS: `VERIFY-WEB t8 src/lib/__tests__/swiss-draw.test.ts src/server/usecases/__tests__/swiss-round-one-draw.test.ts src/server/usecases/__tests__/swiss-playoff-pairing.test.ts src/lib/marketing/__tests__/club-names.test.ts` (if that file exists; else name its test). Run tsc.
- [ ] **Step 4: Mutate:** return the input order from `swissRoundOneOrder` → the draw test goes red. Make `swissChessColoursOn` return `cfg.chess === true` → the boardgame colour test goes red.
- [ ] **Step 5: UI.** Invoke `frontend-design`. `lib/swiss-pairing-menu.ts`'s round-1 hint says "Unseeded players are drawn at random" when any entrant is unseeded (4 locales). Extend `stages-panel-swiss-pairing.test.tsx`.
- [ ] **Step 6: E2E + smoke.**
  - E2E describe `X-SW-DR-1 / X-SW-CC-1`: a chess Swiss, Pair round 1, and the board shows White/Black alternating.
  - Smoke check 10 (round-1 order ≠ registration order for a 16-player unseeded field). `EXPECTED_CHECKS` = 10.
- [ ] **Step 7: Commit** `feat(w3): seeded random round 1; chess colours on by default for boardgame Swiss (SW-L6, SW-H3)`.

**Batch 2 ends here** (Tasks 6–8, one implementer pass: same function). Run the review, push, then dispatch the e2e.

## Task 9: "Add late player" — cases (a)/(b)/(c), automatic arrivals, no round left (§4, ruling 250)

**Rules (§12):**
- "Late entry cases (a)/(b)/(c); (a) is a deviation from FIDE C.04.2 4.4" → **X-SW-LE-1**.
- "Automatic arrivals after Start always take case (c)" → **X-SW-LE-2**.
- "No round left: 'Add a round' while running, 'This Swiss is over' after" → **X-SW-LE-3**.

**Files:**
- Create:
  - `apps/web/src/lib/swiss-late-entry.ts` (pure decision);
  - `apps/web/src/server/usecases/swiss-late-entry.ts` (apply).
- Modify:
  - `apps/web/src/server/usecases/entrants.ts:355-371`: the Start lock admits a division that has a running Swiss stage. After the insert loop, each created entrant goes through `admitSwissLateEntrant(…, "organiser")`, in creation order. `createEntrants`' return gains `late_entry?: LateEntryResult[]`.
  - `apps/web/src/server/usecases/registrations.ts`: `materialise` after the insert at `:1012`.
  - `apps/web/src/server/usecases/imports.ts`: `entrant.create` at `:686-693`.
  - `apps/web/src/server/usecases/stages.ts`: export `swissGen`, `reconcileSwissRoundShells` and `SwissExistingFixture`.
  - `apps/web/src/server/api-v1/schemas.ts`: the entrants POST response schema.
- Test:
  - `apps/web/src/lib/__tests__/swiss-late-entry.test.ts`;
  - `apps/web/src/server/usecases/__tests__/swiss-late-entry.test.ts`;
  - `apps/web/src/server/usecases/__tests__/swiss-late-arrival.test.ts`.

**Interfaces:**
- Produces (lib, pure):
  - Types:
    ```ts
    type LateEntryBoard = { id: string; round: number; seq: number; extKey: string | null; home: string | null; away: string | null; started: boolean; decided: boolean; isBye: boolean };
    type LateEntryDecision =
      | { kind: "repair"; round: number }                                   // case (a)
      | { kind: "take_bye"; round: number; byeFixtureId: string; holder: string } // case (b)
      | { kind: "next_round"; firstRound: number }                           // case (c)
      | { kind: "refused"; code: "SWISS_NO_ROUND_LEFT" | "SWISS_OVER" };
    decideSwissLateEntry(input: { boards: LateEntryBoard[]; rounds: number; swissOver: boolean; automatic: boolean; hasMet: (a: string, b: string) => boolean; newcomer: string }): LateEntryDecision
    ```
  - Order, stated as code-level rules (empty case first, R13):
    1. `swissOver` → `SWISS_OVER`.
    2. No seated round, i.e. shells only, or before the first Pair → `next_round` at `nextUnseatedSwissRound` (round 1).
    3. "Current round" = the latest seated round with an undecided non-bye board (spec §4). If there is none (between rounds): `next_round` at the next unseated round. If no unseated round ≤ `rounds` remains → `SWISS_NO_ROUND_LEFT`.
    4. `automatic` → (c): `next_round` at current+1 if ≤ `rounds`, else `SWISS_NO_ROUND_LEFT`.
    5. No non-bye board in the current round `started` → `repair`.
    6. The round has a bye and `!hasMet(newcomer, holder)` → `take_bye`.
    7. Else (c) as in rule 4.
  - `started` (spec §4): a score event, live (`in_play`), or decided other than the bye. `started` = `fixtureHasResultSql` OR an online-game bridge row (`fixture_external_play`) OR an open device link with events. The server computes it.
- Produces (server):
  - `admitSwissLateEntrant(tx: Tx, auth: AuthCtx | null, divisionId: string, entrantId: string, source: "organiser" | "registration" | "waitlist" | "import"): Promise<LateEntryResult | null>`. It returns null when the division has no running Swiss stage.
  - `type LateEntryResult = { entrant_id: string; stage_id: string; case: "a" | "b" | "c"; round: number; repaired?: { changed_entrant_ids: string[] }; new_board?: { fixture_id: string; scheduled: boolean } }`.
  - It writes:
    - `entrants.swiss_first_round` (= the round they play first);
    - a `swiss_late_entry` ledger row (Task 5's payload) and the division `seq`;
    - for (a)/(b), `afterScheduleWrite` after commit, then `recomputeStandings` for the stage.
  - For an organiser refusal it throws `swissRefusal(code, { canAddRound })` (Tasks 12/13 build Add a round and Finish).
  - An **automatic** arrival never throws. On `SWISS_NO_ROUND_LEFT`/`SWISS_OVER` it records `swiss_first_round = rounds + 1` and the ledger row with `case: "c"`, and the desk lists the entrant as "joined after the last round" (Task 10). The owner decision this needs is listed under "Decisions to confirm".
  - `nextFreeRoundSlot(tx, divisionId, round, boardRows): { scheduled_at: string; court_id: string } | null`. It returns the first `(time, court)` from the round's own distinct `scheduled_at` values × the division's schedule-settings courts that no OCCUPYING fixture holds. It returns null when there is none, and the new board is then left unscheduled.
- Apply per case, all under `pg_advisory_xact_lock('division:'+id)`:
  - **(a)** `clearSwissFixtureSeats` over the round's rows, re-read `existing`, then `swissGen(tx, …)` with the field incl. the newcomer, then `nextFreeRoundSlot` for any board the reshape minted. `changed_entrant_ids` = the entrants whose opponent differs from before. Every surviving row keeps id, time and court; assert this in tests.
  - **(b)** Delete the bye row (no evidence: Task 3's exemption). Insert a board shell `sw-r{N}-b{boards+1}`, seated holder (home) v newcomer (away), `status 'scheduled'`, and place it with `nextFreeRoundSlot`. No other row is written.
  - **(c)** Write `swiss_first_round` only.

- [ ] **Step 1: Write failing pure tests** (`lib/__tests__/swiss-late-entry.test.ts`), a table enumerating every branch with the count asserted:
  - the empty board list;
  - shells only;
  - between rounds;
  - between rounds with no round left;
  - (a);
  - (b);
  - (b) with `hasMet` true → (c);
  - automatic during (a)-eligible → (c);
  - automatic with no round left → refused (the server never throws);
  - `swissOver`;
  - the last round started with a bye → (b), since (a)/(b) are judged before "no round left" (Decisions to confirm, item 1).
  Title the table `X-SW-LE-1 / X-SW-LE-2 / X-SW-LE-3 decision table`.
- [ ] **Step 2: Write failing DB tests** (`server/usecases/__tests__/swiss-late-entry.test.ts`). Every case runs for badminton AND boardgame:
  - `X-SW-LE-1 (a) re-pairs round 2 with the newcomer; every slot keeps its time and court`. Assert per row id that `scheduled_at` and `court_id` are unchanged and only seats changed. An odd→even field mints one board, placed in the next free slot or unscheduled.
  - `X-SW-LE-1 (a) with an odd result field moves the bye`. The bye is never placed (Task 3).
  - `X-SW-LE-1 (b) the newcomer plays the bye holder; nothing else moves`. Snapshot every other row before and after, and they must be equal. The holder's bye award is gone, and the holder is bye-eligible again at the next Pair (P-A4: force a field where the holder is the lowest).
  - `X-SW-LE-1 (c) a started round without a bye: round untouched, newcomer seated in round N+1 at its Pair`.
  - `X-SW-LE-1 case (a) never runs over a board an online game stands behind` (Review Focus 1). Insert a `fixture_external_play` row: the decision is (b) or (c), and there is no 500.
  - **Sequences:**
    - `a second late player in the same round`: (a) then (a); then (b) then (c), since the bye is gone;
    - `a late player after a withdrawal`;
    - `a late player after an Undo of Pair next`;
    - `X-SW-LE-1 sequence: (b) then Undo then Withdraw` (Review Focus 2): Undo refuses `SWISS_LATE_ENTRY_NOT_UNDOABLE`; the Withdraw walks the board over to the holder, who now holds win points via the walkover and is bye-ineligible.
  - `X-SW-LE-3 the last round started: refusal SWISS_NO_ROUND_LEFT with canAddRound true; nothing written` (entrant count unchanged: the whole batch rolls back).
  - `X-SW-LE-3 the Swiss is complete (or its knockout has a started fixture): SWISS_OVER`.
  - `a non-Swiss started division still refuses with the existing sentence`: the positive pair for the lock.
  - `a ladder/americano division still accepts`: the existing exemption.
- [ ] **Step 3: Write failing arrival tests** (`swiss-late-arrival.test.ts`):
  - `X-SW-LE-2 a payment confirmation during a live round never re-pairs: case (c), first round = current + 1`, through `materialise`;
  - the same for a waitlist promotion that seats (`promoteOldestWaitlisted` with auto-approval, free);
  - the same for an import `entrant.create`;
  - `X-SW-LE-2 an automatic arrival with no round left never fails the confirmation` (Review Focus 4): the registration ends `confirmed`, and the entrant has `swiss_first_round = rounds + 1`;
  - `an automatic swiss_late_entry is not an undo barrier`.
- [ ] **Step 4: Run FAIL:** `VERIFY-WEB t9 src/lib/__tests__/swiss-late-entry.test.ts src/server/usecases/__tests__/swiss-late-entry.test.ts src/server/usecases/__tests__/swiss-late-arrival.test.ts`.
- [ ] **Step 5: Implement.** Keep the module import direction `entrants.ts → swiss-late-entry.ts → stages.ts`. If tsc reports a cycle through `stages.ts → entrants.ts`, import `DEPARTED_STATUSES` from a leaf instead of moving more code.
- [ ] **Step 6: Run PASS:**
  - the Step 4 files;
  - `src/server/usecases/__tests__/registrations*.test.ts` (name the materialise and promotion files);
  - `src/server/usecases/__tests__/imports*.test.ts`;
  - `src/server/usecases/__tests__/entrants*.test.ts`;
  - `swiss-withdrawal-walkover.test.ts`;
  - `src/lib/__tests__/status-set-sweep.test.ts`.
  Run tsc and `openapi:gen`.
- [ ] **Step 7: Mutate**, one at a time:
  - (a)'s "nothing started" guard → `true`: the online-game test and the (c) test go red;
  - drop `hasMet` in (b);
  - make `automatic` take (a): the X-SW-LE-2 test goes red;
  - swap the order of rules 1 and 4 → the decision-table row goes red.
- [ ] **Step 8: Smoke** checks 11–14: one per case (a)/(b)/(c) through `POST /api/v1/divisions/{id}/entrants`, plus one automatic arrival (case c). `EXPECTED_CHECKS` = 14.
- [ ] **Step 9: Commit** `feat(w3): Add late player — re-pair, take the bye or join next round (ruling 250)`. The body names the FIDE C.04.2 4.4 deviation for case (a).

## Task 10: Late entry on the desk (UI)

**Rules (§12):** X-SW-LE-1, X-SW-LE-2, X-SW-LE-3 (UI half).

**Files:**
- Modify:
  - `apps/web/src/components/v2/desk/stage-rail.tsx`: a "Add late player" action on a started Swiss stage, which opens the existing add-entrant form;
  - `apps/web/src/components/v2/stages-panel.tsx`: the notice after the add, and the rail's pending-latecomer line;
  - `apps/web/src/components/v2/entrants-panel.tsx`: its add path shows the same notice when `late_entry` returns.
- Create: `apps/web/src/lib/swiss-late-entry-notice.ts` (pure), with the copy for each case.
- Test:
  - `apps/web/src/lib/__tests__/swiss-late-entry-notice.test.ts`;
  - `apps/web/src/components/v2/desk/__tests__/stage-rail.test.tsx`;
  - `apps/web/e2e/w3-swiss-app-a.spec.ts`.

**Interfaces:**
- Consumes: `LateEntryResult[]` (Task 9); `swissRefusalKey` (Task 4).
- Produces:
  - `lateEntryNotice(results: LateEntryResult[], names): { key: MessageKey; params }[]`.
  - Copy (en; 4 locales):
    - (a) "Round {n} re-paired with {name}: {k} players have a new opponent." plus "1 new board is unscheduled" when `!new_board.scheduled`;
    - (b) "{name} plays {holder}, who had the bye in round {n}.";
    - (c) "{name} joins from round {n}.";
    - rail line "{count} late players join next round" (desk notice, ruling 250);
    - "{count} joined after the last round" (the automatic no-round-left case).
  - The refusal surfaces with its recovery button. `SWISS_NO_ROUND_LEFT` offers "Add a round" (Task 12's action; until Task 12 lands, render the copy only).

- [ ] **Step 1: Invoke `frontend-design`.** Show the owner two placements for the action (rail overflow vs a primary beside Pair next) before building (R24). Default recommendation: overflow, since the action is rare.
- [ ] **Step 2: Write failing tests:** the notice table, one row per case plus the two counts, with the count asserted. Rail: `a started Swiss stage renders add-late-player; a setup stage and a league stage do not`.
- [ ] **Step 3: Implement**, with 4 locales, `i18n:gen-keys` and `i18n:check`. Then run PASS: `VERIFY-WEB t10 src/lib/__tests__/swiss-late-entry-notice.test.ts src/components/v2/desk/__tests__/stage-rail.test.tsx src/components/v2/__tests__/stages-panel-swiss-pairing.test.tsx`.
- [ ] **Step 4: E2E** describe `X-SW-LE-1 add a late player in each case`, covering:
  - (a) before any board starts;
  - (b) after starting one board on an odd field;
  - (c) with no bye;
  - the refusal at the last round;
  - for badminton and for a chess (boardgame) division;
  - read the notices and the run sheet.
  Add `X-SW-UP-1` and `X-SW-MR-1` steps to this describe (Tasks 6 and 7's UI paths).
- [ ] **Step 5: Screenshots** at 1280, 320 and 768 (rail, notice, refusal) go to an Artifact page with per-screen verdicts and the control-set diff at 320 vs 1280. There must be no horizontal scroll.
- [ ] **Step 6: Commit** `feat(w3): Add late player on the desk`.

**Batch 3 ends here** (Tasks 9–10). Run the review, push, then dispatch the e2e.

## Task 11: Round guidance and caps (SW-H2, RB3-3)

**Rules (§12):** "Round count guidance, warn above the safe max, refuse above the hard max" → **X-SW-RC-1**.

**Files:**
- Modify:
  - `apps/web/src/lib/swiss-rounds.ts` (its first production caller);
  - `apps/web/src/server/usecases/stages.ts`:
    - `swissGen` at `:1262-1265`: after the `CONFIG_INVALID` check, judge rounds against `swissFieldForRound(...).length` at every Generate (shell mint and every Pair);
    - `assertSwissRoundsDeclared` at `:411-419`: unchanged; the field is unknown at create;
  - `apps/web/src/server/usecases/schedule.ts`: `startDivision` at `:3872` judges every Swiss stage against the active field;
  - `apps/web/src/components/v2/division-builder.tsx:285,891-898`: default 3 (the band for ≤ 8), min 1, and a guidance line;
  - `apps/web/src/components/v2/division-settings.tsx:1186-1199`: min 1 (it was 3), and the same guidance line;
  - `apps/web/src/components/v2/stages-panel.tsx`: a warning notice when Generate returns `swiss_rounds.verdict === "warn"`.
- Test:
  - `apps/web/src/lib/__tests__/swiss-rounds.test.ts` (extend);
  - `apps/web/src/server/usecases/__tests__/swiss-rounds-cap.test.ts`;
  - the builder/settings component tests: name the existing division-builder and `division-settings-*` tests that pin 5/15.

**Interfaces:**
- Produces:
  - `swissRoundsGuidance(field: number): { recommended: number; safeMax: number; hardMax: number }`;
  - `type SwissRoundsJudgement = { verdict: "ok" | "warn" | "refuse"; recommended: number; safeMax: number; hardMax: number }`;
  - `judgeSwissRounds(rounds: number, field: number): SwissRoundsJudgement`;
  - `GenerateOutcome.swiss_rounds?: SwissRoundsJudgement`, present when the verdict is `warn`;
  - refusal `SWISS_ROUNDS_ABOVE_MAX {rounds, field, hardMax}`.
- Formulas (rulebook §3.1/§3.2):
  - `safeMax = ⌊n/2⌋`;
  - `hardMax = n − 1` (n even) or `n` (n odd);
  - `recommended = min(swissRoundsForFieldSize(n), safeMax)`;
  - `warn` iff `safeMax < rounds ≤ hardMax`;
  - `refuse` iff `rounds > hardMax`.
  n counts the field paired now (Task 6's `swissFieldForRound`).

- [ ] **Step 1: Write failing tests.**
  - `X-SW-RC-1 guidance follows rulebook §3.1 for n = 2..130`: compute the expected values from the rulebook's formulas and `SWISS_ROUNDS_BANDS` (the owner's declaration), assert the count = 129, and add the §3.2 anchor rows quoted with citation (n=6 → 3/3/5; n=8 → 3/4/7; n=3 → 1/1/3).
  - The ordering-differential: `n = 6 recommends 3, not the builder's old 5`.
  - `X-SW-RC-1 Generate refuses rounds > hard max; writes nothing`, for a 4-entrant 5-round stage (rulebook SW-H1's example).
  - `X-SW-RC-1 Pair next refuses after withdrawals shrink the field below rounds`, with the recovery details `{ canFinish: true }`.
  - `X-SW-RC-1 6 × 5 warns, does not refuse`.
  - `X-SW-RC-1 Start refuses a Swiss above its hard max`.
- [ ] **Step 2: Run FAIL**, implement, add the copy in 4 locales (the guidance line "For {n} players: {recommended} rounds recommended, at most {hardMax}" and the warn notice), run `i18n:gen-keys`, then run PASS: `VERIFY-WEB t11 src/lib/__tests__/swiss-rounds.test.ts src/server/usecases/__tests__/swiss-rounds-cap.test.ts src/server/usecases/__tests__/swiss-shell-fixtures.test.ts` plus the named builder/settings tests. Run `openapi:gen`.
- [ ] **Step 3: Mutate:** `hardMax = n` for even n → the 4×5 refusal goes red. Drop the Generate check (keep Start) → the shrink test goes red.
- [ ] **Step 4: UI.** Invoke `frontend-design`. Take screenshots of the builder and settings guidance at 3 widths and add them to the Artifact.
- [ ] **Step 5: E2E + smoke.**
  - E2E describe `X-SW-RC-1 rounds above the hard max are refused at Start`.
  - Smoke check 15 (4 × 5 → 422 `SWISS_ROUNDS_ABOVE_MAX`). `EXPECTED_CHECKS` = 15.
- [ ] **Step 6: Commit** `feat(w3): Swiss round guidance; warn above the safe max, refuse above the hard max (SW-H2, RB3-3)`.

## Task 12: Per-stage rounds editable until the first fixture starts; chess toggle; Add a round (SW-M10, #838, RB3-5)

**Rules (§12):** "Rounds per stage, editable until the first fixture starts; then Finish / Add a round" → **X-SW-RC-2**. The chess toggle is RB3-10's "can be switched off" (→ X-SW-CC-1).

**Files:**
- Modify:
  - `apps/web/src/app/api/v1/stages/[id]/route.ts`: add `PATCH`;
  - `apps/web/src/server/api-v1/schemas.ts`: `PatchSwissStage = z.object({ rounds: z.number().int().min(1), chess: z.boolean() }).partial().strict()`, with at least one key.
- Create:
  - `apps/web/src/app/api/v1/stages/[id]/swiss/add-round/route.ts`;
  - in `apps/web/src/server/usecases/swiss-rounds-admin.ts`: `patchSwissStage` and `addSwissRound`.
- Modify: `apps/web/src/components/v2/desk/stage-rail.tsx` (a "Rounds: N" control with edit and Add a round), and `stages-panel.tsx` (the chess toggle on a boardgame Swiss stage).
- Test:
  - `apps/web/src/server/usecases/__tests__/swiss-rounds-admin.test.ts`;
  - `apps/web/src/app/api/v1/stages/[id]/__tests__/route.test.ts`.

**Interfaces:**
- Produces:
  - `patchSwissStage(auth, stageId, body: { rounds?: number; chess?: boolean }): Promise<{ rounds: number; chess: boolean; swiss_rounds: SwissRoundsJudgement; shells: { added: number; removed: number; slots_freed: number } }>`;
  - `addSwissRound(auth, stageId): Promise<{ rounds: number; shells_added: number }>`.
- Rules:
  - **"Started"** = any fixture of the stage under `fixtureHasResultSql`. A bye is not started (Task 3). Shells do not freeze anything (rulebook §7).
  - **PATCH:**
    - not Swiss → `STAGE_NOT_SWISS`;
    - started → `SWISS_ROUNDS_LOCKED {canFinish, canAddRound}`;
    - `rounds` judged by `judgeSwissRounds` against the active field: `refuse` → `SWISS_ROUNDS_ABOVE_MAX`, `warn` → returned;
    - reducing below a seated round → `SWISS_ROUNDS_BELOW_SEATED`.
  - Shells: rounds removed are deleted (each unseated, no evidence, and Task 1's `carrySlots` report of freed slots); rounds added are minted with `planSwissShells` for the current field.
  - Appends `swiss_rounds_changed {via: "edit"}` (an undo barrier).
  - **`addSwissRound`:**
    - allowed while the stage is not complete and no later stage has a started fixture;
    - new total ≤ hardMax, else `SWISS_ROUNDS_ABOVE_MAX`;
    - mints round N+1 shells and appends `swiss_rounds_changed {via: "add_round"}`.
    - **Ruling 250 governs, not rulebook §7.** Add a round stays available after the final round is paired (Decisions to confirm, item 2).
  - The same advisory lock and `divisionLockState` freeze refusal as Unpair.

- [ ] **Step 1: Write failing tests:**
  - `X-SW-RC-2 rounds edit after shells exist and before any start: 5 → 3 deletes rounds 4–5 shells; 3 → 4 mints round 4` (#838's regression: today `FORMAT_LOCKED` blocks it);
  - `X-SW-RC-2 after the first core.start: SWISS_ROUNDS_LOCKED with canFinish and canAddRound`;
  - `X-SW-RC-2 a bye alone does not lock rounds`;
  - `X-SW-RC-2 Add a round mints round N+1 for the current field and is an undo barrier`;
  - `X-SW-RC-2 Add a round above the hard max refuses`;
  - `X-SW-RC-2 Add a round after the Swiss is complete refuses SWISS_OVER`;
  - `X-SW-CC-1 chess can be switched off before start and is then off at Pair`.
  Then the sequence: edit rounds, Pair, Undo (Task 5: Undo across `swiss_rounds_changed` refuses by name).
- [ ] **Step 2: Run FAIL**, implement (route doc per `node_modules/next/dist/docs/`), run `openapi:gen`, then run PASS: `VERIFY-WEB t12 src/server/usecases/__tests__/swiss-rounds-admin.test.ts src/app/api/v1/stages/[id]/__tests__/route.test.ts src/server/usecases/__tests__/swiss-undo-pair-next.test.ts`.
- [ ] **Step 3: Mutate:** "started" → any fixture exists (today's rule) → the first test goes red. Drop the hard-max check in `addSwissRound` → its refusal test goes red.
- [ ] **Step 4: UI.** Invoke `frontend-design` and show 2 options for the rounds control (an inline stepper vs an edit dialog). Wire "Add a round" as the recovery button on Task 10's `SWISS_NO_ROUND_LEFT` refusal. 4 locales. Take screenshots at 3 widths and add them to the Artifact.
- [ ] **Step 5: E2E + smoke.**
  - E2E describe `X-SW-RC-2 edit rounds, then add a round after play`.
  - Smoke checks 16–17. `EXPECTED_CHECKS` = 17.
- [ ] **Step 6: Commit** `feat(w3): Swiss rounds editable until first start; Add a round (SW-M10, #838)`.

## Task 13: "Finish the Swiss now" (RB3-20, RB3-4's recovery)

**Rules (§12):** "'Finish the Swiss now'" → **X-SW-FN-1**.

**Files:**
- Create: `apps/web/src/app/api/v1/stages/[id]/swiss/finish/route.ts`.
- Modify:
  - `apps/web/src/server/usecases/swiss-rounds-admin.ts`: `finishSwissNow`;
  - the stage rail: a "Finish the Swiss now" action with a confirm.
- Test: `apps/web/src/server/usecases/__tests__/swiss-finish-now.test.ts`.

**Interfaces:**
- Produces: `finishSwissNow(auth, stageId): Promise<{ finished_after: number; shells_removed: number; slots_freed: number } & CompleteStageResult>`.
- Behaviour:
  - `k` = the latest round whose seated boards are all decided.
  - `k = 0` → `SWISS_FINISH_NOTHING_PLAYED`.
  - Round k+1 seated with a started board → `SWISS_FINISH_ROUND_UNDECIDED {boards}`, naming them as `generatePreconditionMessage` names abandoned boards.
  - Round k+1 seated but not started → its seats are cleared and its shells deleted.
  - Shells of rounds > k are deleted (no evidence).
  - `config.rounds := k`; append `swiss_rounds_changed {via: "finish"}`.
  - After the transaction commits, call `completeStage(auth, stageId)`, which seeds the KO as usual.
  - This is the recovery App B's SW-H1 refusal will offer ("Finish after N−1").

- [ ] **Step 1: Write failing tests:**
  - `X-SW-FN-1 finishing after round 3 of 5 completes the stage and seeds the knockout from round-3 standings`. Expected: the qualified list equals `rankedStageStandings` read before the call (the table after round 3), not after.
  - `X-SW-FN-1 a paired-but-unstarted round 4 is unpaired and dropped`.
  - `X-SW-FN-1 a started round 4 refuses and names its boards`.
  - `X-SW-FN-1 nothing played refuses`.
  - `X-SW-FN-1 Undo across a finish refuses SWISS_ROUNDS_CHANGE_NOT_UNDOABLE`.
  - For boardgame too (swiss_knockout).
- [ ] **Step 2: Run FAIL**, implement, run `openapi:gen`, then run PASS: `VERIFY-WEB t13 src/server/usecases/__tests__/swiss-finish-now.test.ts src/server/usecases/__tests__/swiss-knockout-shape.test.ts`.
- [ ] **Step 3: Mutate:** skip the started check for round k+1 → the refusal test goes red.
- [ ] **Step 4: UI.** Invoke `frontend-design`. The confirm copy: "Standings after round {k} become final. Rounds {k+1}–{N} are removed." (4 locales). Take screenshots at 3 widths and add them to the Artifact.
- [ ] **Step 5: E2E + smoke.**
  - E2E describe `X-SW-FN-1 finish a 5-round Swiss after round 3 into the knockout`.
  - Smoke check 18. `EXPECTED_CHECKS` = 18.
- [ ] **Step 6: Commit** `feat(w3): Finish the Swiss now (RB3-20)`.

## Task 14: Manual board swap in rounds ≥ 2 — blocked with guidance (SW-L12, RB3-25)

**Rules (§12):** "Manual board swap in rounds ≥ 2 blocked with guidance" → **X-SW-MS-1**.

**Premise found:** the API half is already true. `PatchFixture` is `.strict()` (`schemas.ts:1553-1578`), so a request naming `home_entrant_id` gets 400. Only the guidance is missing.

**Files:**
- Modify: `apps/web/src/lib/swiss-pairing-menu.ts` and `stage-rail.tsx`. For rounds ≥ 2, the read-only mode line adds "To change who plays whom: Unpair, then Pair next." (4 locales).
- Test:
  - `apps/web/src/components/v2/__tests__/stages-panel-swiss-pairing.test.tsx`;
  - `apps/web/src/app/api/v1/fixtures/[id]/__tests__/route.test.ts` (or the existing PatchFixture schema test; name it).

- [ ] **Step 1: Write failing tests:**
  - `X-SW-MS-1 PATCH a round-2 Swiss fixture with home_entrant_id is refused (400) and the seat is unchanged`. This pins today's behaviour; read the row back.
  - `X-SW-MS-1 the round-2 menu shows the Unpair-then-Pair guidance; round 1 does not`.
- [ ] **Step 2: Implement, PASS**, then mutate (hide the hint for every round → red).
- [ ] **Step 3: E2E + smoke.**
  - E2E: a step in the Task 10 describe reading the hint.
  - Smoke check 19 (the 400). `EXPECTED_CHECKS` = 19.
- [ ] **Step 4: Commit** `feat(w3): rounds ≥ 2 explain how to change a pairing (SW-L12)`.

**Batch 4 ends here** (Tasks 11–14, sequential: they share `stage-rail.tsx`). Run the review, push, then dispatch the e2e.

## Task 15: Disqualification cascades like a withdrawal (RB3-17)

**Rules (§12):** "Disqualification = withdrawal from that moment; annulment separate" → **X-SW-DQ-1**.

**Files:**
- Modify:
  - `apps/web/src/server/usecases/withdrawal.ts:286`: `withdrawEntrantCascade(auth, entrantId, opts: { as?: "withdrawn" | "disqualified" } = {})` writes the final status `opts.as ?? "withdrawn"`;
  - `apps/web/src/server/usecases/entrants.ts:878` `patchEntrant`: a `status: "disqualified"` patch on a started division routes to the cascade instead of a bare flip.
- Test: `apps/web/src/server/usecases/__tests__/disqualify-cascade.test.ts`.

**Interfaces:** `WithdrawCascadeOut.status: "withdrawn" | "disqualified"`. The walkover reason the cascade already writes is unchanged; ruling 115 still decides credit.

- [ ] **Step 1: Write failing tests** (Swiss badminton and boardgame, plus a league):
  - `X-SW-DQ-1 PATCH status disqualified mid-Swiss walks the open board over to the opponent and leaves played results standing`;
  - `X-SW-DQ-1 a disqualified entrant is not paired again`;
  - `X-SW-DQ-1 before Start it stays a plain status flip`;
  - `X-SW-DQ-1 a second PATCH to disqualified is idempotent`.
- [ ] **Step 2: Run FAIL**, implement, then run PASS: `VERIFY-WEB t15 src/server/usecases/__tests__/disqualify-cascade.test.ts src/server/usecases/__tests__/swiss-withdrawal-walkover.test.ts src/lib/__tests__/status-set-sweep.test.ts`.
- [ ] **Step 3: Mutate:** remove the route-through in `patchEntrant` → the first test goes red.
- [ ] **Step 4: E2E + smoke.**
  - E2E: an API-driven describe `X-SW-DQ-1` (there is no DQ button in the UI; the board shows the walkover).
  - Smoke check 20. `EXPECTED_CHECKS` = 20.
- [ ] **Step 5: Commit** `fix(w3): a disqualification cascades like a withdrawal (RB3-17)`.

## Task 16: Public "Round X of N" (SW-L11)

**Rules (§12):** none; this is a brief item with no rule row.

**Files:**
- Create: `apps/web/src/lib/swiss-round-state.ts` (pure).
- Modify:
  - `apps/web/src/server/public-site/competition-hub-schema.ts:260-272` (`TableView` gains `swissRound`);
  - `apps/web/src/server/public-site/competition-hub.ts` (fill it);
  - `apps/web/src/components/public-site/standings-table-view.tsx` (a heading chip).
- Test:
  - `apps/web/src/lib/__tests__/swiss-round-state.test.ts`;
  - `apps/web/src/server/public-site/__tests__/competition-hub-schema.test.ts`;
  - `apps/web/src/components/public-site/__tests__/standings-table-view-headers.test.tsx`.

**Interfaces:**
- Produces:
  - `swissRoundState(rounds: number, fixtures: { round_no: number; home: string|null; away: string|null; status: string; isBye: boolean }[], stageComplete: boolean): { round: number; of: number; state: "paired" | "in_play" | "complete" | "final" } | null`;
  - null when nothing is seated (the empty case first).
- Copy (4 locales):
  - "Round {round} of {of} · paired";
  - "… · in play";
  - "… · complete";
  - "Final standings after {of} rounds".

- [ ] **Step 1: Write failing tests:**
  - a table of every state with the count asserted;
  - a schema round-trip;
  - the chip renders, anchored on `="` (AGENTS.md: React serialises an omitted prop as `"$undefined"`);
  - `a league table has no chip`.
- [ ] **Step 2: Run FAIL**, implement, `i18n:gen-keys`, then run PASS: `VERIFY-WEB t16 src/lib/__tests__/swiss-round-state.test.ts src/server/public-site/__tests__/competition-hub-schema.test.ts src/components/public-site/__tests__/standings-table-view-headers.test.tsx`.
- [ ] **Step 3: Mutate:** return null always → the render test goes red.
- [ ] **Step 4: UI.** Invoke `frontend-design`. Take public-table screenshots at 3 widths and add them to the Artifact.
- [ ] **Step 5: E2E + smoke.**
  - E2E describe `public Swiss shows Round X of N`.
  - Smoke check 21 (the hub doc carries `swissRound`). `EXPECTED_CHECKS` = 21.
- [ ] **Step 6: Commit** `feat(w3): public "Round X of N" for a Swiss table (SW-L11)`.

Tasks 15 and 16 have disjoint file sets and may run in parallel.

## Task 17: Pin-only rule tests for signed behaviour that already holds (§12 close-out rows with app code)

**Rules (§12):**
- "Rank-adjacent from round 2 in swiss_playoff / swiss_knockout (deviation)" (RB3-12) → **X-SW-RA-1**.
- "Cut-line ties: flag-and-pick / visible lots, no play-off game" (RB3-18) → **X-SW-CT-1**.
- "A correction after the next round is paired: the published pairing stands, standings recompute" (RB3-21) → **X-SW-CR-1**.

**Added scope:** this task was not in the brief. The controller may move it to the close-out PR instead.

**Files:** Test only: `apps/web/src/server/usecases/__tests__/swiss-signed-rules-pin.test.ts`.

- [ ] **Step 1: Read before asserting** (AGENTS.md "a grep is not a read"):
  - `lib/format-templates.ts:205-233`;
  - `stages.ts:5701` (`SEEDING_TIE_UNRESOLVED`);
  - the correction path, a void and re-score on a round-1 board after round 2 is paired.
- [ ] **Step 2: Write the tests:**
  - `X-SW-RA-1 swiss_playoff pairs round 2 rank-adjacent`;
  - `X-SW-CT-1 a tied cut line refuses SEEDING_TIE_UNRESOLVED and offers the lots draw, never a play-off fixture`;
  - `X-SW-CR-1 correcting a round-1 result after round 2 is paired leaves round 2's seats and recomputes standings`.
  Each must pass on the branch. If one fails, that is a finding: stop and report it, do not fix it here.
- [ ] **Step 3: Mutate one input per test**, for example force fold pairing → RA-1 goes red.
- [ ] **Step 4: Commit** `test(w3): pin RB3-12, RB3-18, RB3-21 as signed`.

## Task 18: PR, CI, owner sign-off

- [ ] **Step 1:**
  - Run `npm run openapi:gen` and get a clean diff.
  - Run `i18n:check`, tsc and lint (the count must not rise).
  - Run the smoke guard tests and `SMOKE_ONLY=w3SwissA npm run test:smoke`: 21/21 = `EXPECTED_CHECKS`.
- [ ] **Step 2: Open the PR** `feat(w3): Swiss app PR A`. The body carries:
  - `Matrix rows: swiss, swiss_playoff, swiss_knockout × all`;
  - "Data changes" (Task 3's and Task 6's migrations, with Task 0's counts);
  - Task 0's findings;
  - the rule-id table below;
  - the FIDE 4.4 deviation note;
  - the Claude Code line.
- [ ] **Step 3: Dispatch** `gh workflow run e2e.yml --ref feat/w3-swiss-app-a -f pr=<N>` and hand back. Judge `w3-swiss-app-a.spec.ts`, `swiss-shell.spec.ts`, `stage-roster-drift.spec.ts`, `formats.spec.ts`, `swiss-legend.spec.ts` and `mobile.spec.ts` as whole files. A serial file's red count is a floor.
- [ ] **Step 4:** Run a final Opus `reviewer` pass over the whole branch; it answers the four questions per change. Then the per-screen visual sign-off on the Artifact. Merge only on the owner's explicit go.
- [ ] **Step 5:** Append the "W3 App A" status and the findings to `_INDEX.md` (status section, not rulings), and hand the rule-id table to the engine close-out plan.

---

## Batches (suggested)

| Batch | Tasks | Why together | Parallel? |
|---|---|---|---|
| 0 | T0 | Live data must be known first | — |
| 1 | T1–T5 | Rebuild, reshape, bye and ad-hoc share `stages.ts`; T5 needs T4's refusal table | Sequential; T1+T2 one implementer pass |
| 2 | T6–T8 | All in `swissGen`'s history and field code | One implementer pass |
| 3 | T9–T10 | Late entry server then UI | Sequential |
| 4 | T11–T14 | Round count, admin routes, rail controls | Sequential (`stage-rail.tsx`) |
| 5 | T15 ‖ T16, then T17 | Disjoint files | T15 and T16 in parallel |
| 6 | T18 | PR, CI, sign-off | — |

Each batch ends with an Opus `reviewer` pass over the batch diff, a push and an e2e dispatch. Batch 0 is the gate for Tasks 4, 6 and 11.

## Decisions to confirm with the owner (my calls; recommendations stated)

1. **(a)/(b) are judged before "no round left".** A late player whose last round has started with a bye still plays the bye holder (case b). The refusal fires only when (c) would be needed. **Recommend yes:** it seats a paying player in a round that has room, with nothing else moving.
2. **"Add a round" stays available after the final round is paired.** Ruling 250 offers it exactly when the last round has started, but rulebook §7 says "while the final round is not yet paired". **Recommend ruling 250**, as the later and owner-given rule; amend §7 at close-out.
3. **An automatic arrival with no round left is recorded, never refused.** It sets `swiss_first_round = rounds + 1`, and the desk shows "joined after the last round". Refusing would fail a payment confirmation after the money is taken. **Recommend yes.**
4. **Undo barriers are organiser actions only.** An automatic arrival does not block Undo, because it changes no pairing.
5. **Case (b)'s "they have met" fallthrough** can only be reached by re-admitted data: a newly created entrant has met nobody. It is kept as a guard (R28) and tested on constructed rows.

## Premises found false or stale (to `_INDEX.md` "False premises found")

- **SW-M2 is labelled BOTH but is app-only.** The engine's inverse carries `__undo_of`, so the app reads `seated_fixture_ids` itself (Task 5).
- **"A bye snapshots at award" is not a local write.** `config_snapshot` is PLAYED in `fixtureEvidenceSql` and `playedSql`, so a frozen bye would lock rules and block Unpair, Rebuild and Undo. Task 3 exempts system byes in both.
- **SW-L12's "blocked" half already holds.** `PatchFixture` is `.strict()`; only the guidance is missing (Task 14).
- **Rulebook §7 and ruling 250 disagree on when "Add a round" is allowed** (Decision 2).
- **Automatic arrivals bypass the Start lock for EVERY format, not only Swiss.** `registrations.ts:1012` and `imports.ts:688` insert with no division-status check, so a league or group division can gain an un-fixtured entrant after Start. Out of W3's scope; reported, not fixed.
- **The `status-set-sweep` path in the W2e plan (`server/__tests__/`) is wrong.** The file is `apps/web/src/lib/__tests__/status-set-sweep.test.ts`.
- **Prod is at Flyway V417**, so Task 0's prod query cannot read W2d's stage table-rules pin.

## Tasks that need an engine change after all

None. Two pieces of the signed rules stay with the engine plan:
- RB3-10's topscorer exception;
- the art. 16 category for late-entry missed rounds in tie-breaks.
This PR covers the round-1 colour lot (app post-process) and the pairing-score zero (`swissGen`).

## Rule-id table (spec §12; for the engine rules close-out PR)

| Id | §12 rule | Source | Proving test(s) — file :: title prefix | Task |
|---|---|---|---|---|
| X-SW-RB-1 | Rebuild keeps times and courts, in one transaction | G3, #840, FX-G13, SW-L8 | `server/usecases/__tests__/rebuild-one-transaction.test.ts`, `lib/__tests__/rebuild-slots.test.ts`, `swiss-withdrawal-reconcile.test.ts` :: `X-SW-RB-1` | 1, 2 |
| X-SW-BY-1 | A bye shell is never on a court and never printed | RB3-23 | `schedule-bye-shell.test.ts`, `lib/__tests__/scorer-sheets.test.ts` :: `X-SW-BY-1` | 3 |
| X-SW-BY-2 | (app half of "Bye = win points … frozen at award", the engine-PR row) | 251, RB3-7(a) | `swiss-bye-snapshot.test.ts` :: `X-SW-BY-2` | 3 |
| X-SW-AH-1 | Ad-hoc "Add match" refused on a Swiss stage | RB3-15 | `add-fixture.test.ts` :: `X-SW-AH-1` | 4 |
| X-SW-UN-1 | Undo of Pair next clears seats if no result, else a named refusal; Add late player has no Undo | RB3-22, §10.8 | `swiss-playoff-pairing.test.ts`, `swiss-undo-pair-next.test.ts` :: `X-SW-UN-1` | 5 |
| X-SW-MR-1 | (app half of "Late entrant: 0 per missed round", the engine-PR row) | 251 | `swiss-late-field.test.ts` :: `X-SW-MR-1` | 6 |
| X-SW-UP-1 | Unplayed pairs may meet again; a walkover winner stays bye-ineligible | RB3-2, RB3-14 | `swiss-unplayed-rematch.test.ts` :: `X-SW-UP-1` | 7 |
| X-SW-DR-1 | Seeded random draw for an unseeded round 1 | RB3-16 | `lib/__tests__/swiss-draw.test.ts`, `swiss-round-one-draw.test.ts` :: `X-SW-DR-1` | 8 |
| X-SW-CC-1 | Chess colours on by default for boardgame Swiss; round-1 colour by lot (+ `rules/boardgame.md`) | RB3-10 | `lib/__tests__/swiss-draw.test.ts`, `swiss-round-one-draw.test.ts`, `swiss-rounds-admin.test.ts` :: `X-SW-CC-1` | 8, 12 |
| X-SW-LE-1 | Late entry cases (a)/(b)/(c); (a) is a deviation from FIDE C.04.2 4.4 | 250 | `lib/__tests__/swiss-late-entry.test.ts`, `server/usecases/__tests__/swiss-late-entry.test.ts`, `swiss-late-field.test.ts` :: `X-SW-LE-1` | 6, 9, 10 |
| X-SW-LE-2 | Automatic arrivals after Start always take case (c) | 250 | `swiss-late-arrival.test.ts` :: `X-SW-LE-2` | 9 |
| X-SW-LE-3 | No round left: "Add a round" while running, "This Swiss is over" after | 250 | `server/usecases/__tests__/swiss-late-entry.test.ts` :: `X-SW-LE-3` | 9 |
| X-SW-RC-1 | Round count guidance; warn above the safe max; refuse above the hard max | RB3-3 | `lib/__tests__/swiss-rounds.test.ts`, `swiss-rounds-cap.test.ts` :: `X-SW-RC-1` | 11 |
| X-SW-RC-2 | Rounds per stage, editable until the first fixture starts; then Finish / Add a round | RB3-5 (#838) | `swiss-rounds-admin.test.ts` :: `X-SW-RC-2` | 12 |
| X-SW-FN-1 | "Finish the Swiss now" | RB3-20 | `swiss-finish-now.test.ts` :: `X-SW-FN-1` | 13 |
| X-SW-MS-1 | Manual board swap in rounds ≥ 2 blocked with guidance | RB3-25 | `stages-panel-swiss-pairing.test.tsx`, the PatchFixture route test :: `X-SW-MS-1` | 14 |
| X-SW-DQ-1 | Disqualification = withdrawal from that moment; annulment separate | RB3-17 | `disqualify-cascade.test.ts` :: `X-SW-DQ-1` | 15 |
| X-SW-RA-1 | Rank-adjacent from round 2 in swiss_playoff / swiss_knockout (deviation) | RB3-12 | `swiss-signed-rules-pin.test.ts` :: `X-SW-RA-1` | 17 |
| X-SW-CT-1 | Cut-line ties: flag-and-pick / visible lots, no play-off game | RB3-18 | `swiss-signed-rules-pin.test.ts` :: `X-SW-CT-1` | 17 |
| X-SW-CR-1 | A correction after the next round is paired: the published pairing stands, standings recompute | RB3-21 | `swiss-signed-rules-pin.test.ts` :: `X-SW-CR-1` | 17 |

§12 close-out rows this plan does NOT prove:
- RB3-7(c), requested byes: there is no product path; the row is written as ⛔ citing the absent API.
- RB3-19 belongs to W4 FX-G16.
- RB3-9 waits for the App-B bump PR.
- RB3-4's app surfacing is App B.

X-SW-BY-2 and X-SW-MR-1 are proposals. If the engine plan picks other ids for those two engine-PR rows, rename the two test titles to match in the same close-out.
