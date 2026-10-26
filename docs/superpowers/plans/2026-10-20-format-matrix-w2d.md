# Format × Sport Matrix — W2d (tables and tie-breaks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Sequencing.** W2d builds ON W2c, which merged as #1007 (`5e8cef4347`) on 2026-10-24.
> - **Every task waits for Task 0**: the rebase, the re-pin of every line in **Anchors**, the migration number and the pre-W2d snapshot B1 needs.
> - Task 0 re-took every **Anchors** pin at `e97823e4d8` (= origin/main `2e0deaa6c1` plus the W2d docs merge); they are marked **main@e97823e4d8**. They are still pins, not promises.
> - The migration is **V472** (`V472__w2d_table_rules.sql`). Main's max is V471: V469 W2c (`fixture_rules_override`), V470 email-outbox, V471 all-stages-free.

## PR split (owner, 2026-10-25/26)

- W2d ships as **two PRs**.
- **PR A** = Tasks 0–12, plus:
  - **A14**: Task 14's DB-level producer→consumer seam tests for Tasks 0–12, without its API v1 parts, including the `gamePoints` and `winsCount` producer killers.
  - **A-smoke**: in `scripts/smoke.ts`, a stage is pinned at generate, and two reloads give the same lots order.
  - **A20**: the MD-1 Stryker sweep over PR A's engine files.
  - **A21**: PR A's ship gates.
- **PR B** = Tasks 13–21, branched from PR A.
- **V472 is frozen** once PR A merges.
- `scripts/w2d/post-deploy-pin.ts` is the one owner-run post-deploy script. Prod is idle, so run `--check` after the deploy, and run fix mode (a run without `--check`) only if a count is above 0.
- The tennis player stat `nestedGamesOf` stays unchanged (owner).

**Goal:** Every table stage ranks by its sport's real rules — outcome-keyed points (regulation, overtime, shoot-out, tie, no result), a per-stage tie-break order validated when it is saved, a stored drawing of lots, the sport's cross-group order — and once a stage is active its table can no longer move under anyone, including under this release.

**Architecture:**
- **Engine first, one authority per fact** (spec §5.1).
  - `decidedIn` is a pure function of the stored outcome (`decidedInFor(module, outcome)`); no column.
  - One `PointsRule` shape and one `payout` function pay every decided fixture; each module supplies its default as `tablePointsRule(cfg, stageKind)`. `reachableOutcomes` + `coverage` answer "does this rule pay everything this format can produce" for the stage save, the division save and the fixture override alike.
  - `rankStandings` gains the new keys, the h2h modifiers, the partial-schedule guard and the stored lots map; a key with no comparator throws.
  - `validateCascade` (new file `competition/cascade-rules.ts`) returns every refusal; `resolveTableRules` (new `competition/table-rules.ts`) is the one resolver: `pinned ?? stage own ?? division ?? sport default(kind)`.
- **Web: one loader, one pin, one lock.** `server/engine-db/table-rules.ts` loads the effective rules for a stage and writes the pin in the transaction that activates the stage (`stages.ts` generation writers). Every consumer in spec §6 reads through it; a source scan forbids a second resolver. W2c's Q3 lock loosens into the pin; the stage's own order and points lock at first score with W2c's `STAGE_FORMAT_LOCKED`.
- **Migration** adds the pin columns and `stage_lots_draws`, and pins every active or complete stage to the rules it ranks by today (B1) through a SQL function the migration calls once and the B1 test calls again.
- **UI (D11 Option A):** a "Tie-breaks" section after W2c's "Points" section in the stage card; the Points section shows exactly the reachable outcomes; the public table gains the new columns, half-points, OTW/OTL and the lots note; the hockey pad asks the goal type.

**Tech Stack:**
- TypeScript 7 (`typescript-native`), Node 26 `--experimental-strip-types` (no enums, namespaces or parameter properties; `.ts` import suffixes under `packages/` and `scripts/`).
- zod 4; vitest 4; fast-check; Playwright + `@axe-core/playwright`.
- Next.js — read `node_modules/next/dist/docs/` before touching a page (AGENTS.md).
- Postgres deltas under `db/migration/deltas/` (Flyway, in order); pnpm.
- Stryker (`packages/engine/stryker.groups.mjs`, `packages/engine/scripts/stryker-changed.mjs`); the hand-mutant runner `scripts/mutate.ts`.

**Spec:** `docs/superpowers/specs/2026-10-20-format-matrix-w2d-design.md`, owner-approved 2026-10-20 at `8168a0b92a` (D1–D11, B1–B5, OC1–OC3, the author's calls in §17). Read with:
- `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_RULES.md` R1–R29 and `_INDEX.md` (W2c's fold lands with W2c);
- `AGENTS.md` (classes 1–23, the phone composition), `docs/superpowers/RULES.md`, `docs/superpowers/TEST-STRATEGY.md` (rules 1–10, the reviewer's four questions);
- style: the W2c plan (`docs/superpowers/plans/2026-10-13-format-matrix-w2c.md` on the W2c branch).

Where the spec and the tree disagree, the tree wins and the disagreement is a numbered **Plan finding** at the end. A finding never re-opens a decision; where the plan needs a call the spec does not make, it is marked **planner's call** and listed in the self-review.

---

## Anchors (to re-pin in Task 0)

`E` = `packages/engine/src`. `W` = `apps/web/src`. `IDX` = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md`. `MUT` = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2d`. `RULES` = `packages/engine/rules`. `SPEC` = the spec above. `§N.M` names item M of spec §N where §N is a numbered list (§11, §12, §13). The engine's pnpm filter is **`@onryde/seazn-engine`** (`@seazn/engine` is only an import alias; a pnpm filter on that name matches no project and exits 0, PF-16).

| Fact | Where |
|---|---|
| `PointsRule` zod `{base, bonuses, forfeit}` `:13-40`; `validatePointsRule :46`; `isBye :63`; `forfeitShaped :72`; `isUnplayedForfeit :86`; `applyPointsRule(outcome, pair, rule, played, scoreKeys) :174`; `Expressible`/`BASE_KEYS`/`pointsRuleExpressible :250-278`; `pointsRuleBounds :378` | main@e97823e4d8 `E/competition/points.ts` |
| `RankContext :202-223` (`cascade, results, h2hRecursive, swiss, seeds, h2hScope, rngSeed`); `RankingResult :225-231` (`rows, lotsGroups`); `DIFF_KEYS/FOR_KEYS/AGAINST_KEYS :237-241`; `COMPARATORS :332`; `H2H_KEYS :368`; `h2hToPlain :376`; `h2hBlock :414`; `directRefine :468`; `refine :495`; silent skip `:529-537`; `lotSeed :547`; `bySeedThenId :558`; `rankStandings :572`; `validateCascade(cascade, {metrics, swiss}) :638`; `buildSwissTable :705` | main@e97823e4d8 `E/competition/tiebreakers.ts` |
| `TableStage.h2hRecursive :72`, `rngSeed :75`; `DivisionEvent` `rank_lock_required`/`rank_lock :104-105`; `completeTableStage :215` (passes `h2hRecursive :243`, `rngSeed :245`, events `:255-257`) | main@e97823e4d8 `E/competition/stage.ts` |
| `crossGroupOrder :573` (hard-coded `points, diff, for, wins`), its caller `resolveProgression :668` | main@e97823e4d8 `E/competition/progression.ts` |
| `tieDecidingKey :54` (null unless `cascade[0]==="points"`) | main@e97823e4d8 `E/competition/tie-what-if.ts` |
| `TiebreakerKey` union `:46`; `defaultTiebreakers: TiebreakerKey[] :944`; `matchPointsBounds :979` | main@e97823e4d8 `E/sport/module.ts` |
| `forEachSport(fn, modules?) : number :57`; `sportCases :33` | main@e97823e4d8 `E/testkit/for-each-sport.ts` |
| `deriveSeed(…,"lots",stageId)` | main@e97823e4d8 `E/testkit/simulation.ts:559,653` |
| period goal: payload `kind?` `:259`; `applyGoal(state, payload, strict) :1094` (strict-only kind check `:1110-1118`); pad enum `goalKindValues :2047`; metrics `goals_<kind>` skip `fg`/`og` `:2478-2481` | main@e97823e4d8 `E/sports/period/kernel.ts` |
| strict-only refusal precedent (`strict = strictFromSeq …`, lineup refusal) | main@e97823e4d8 `E/core/events.ts:990-1005` |
| `FOLD_EPOCH` (hockey 2, football 2, …), `FOLD_MINOR` | main@e97823e4d8 `E/sport/fold-epoch.ts` `FOLD_EPOCH :20-32`, `FOLD_MINOR :35-38` (values: PF-14) |
| football `points {win 3, draw 1, loss 0, shootoutWin?, shootoutLoss?}` | main@e97823e4d8 `E/sports/football/football.ts:124-132`; SO delta `:2779-2789` (split only when BOTH keys are set, `:2781-2784`); `declaredPointsSets :2842`, `matchPointsBounds :2850` read the keys too |
| period `points {win, draw, loss, otWin?, otLoss?, shootoutWin?, shootoutLoss?}` | main@e97823e4d8 `E/sports/period/kernel.ts:214-222` (type `PeriodCfg.points :98-106`); SO payer `winPoints :1537` (per key: `shootoutWin ?? otWin ?? win`, `:1540-1541`), called by `standingsDelta :2753`; `declaredPointsSets :2833`, `matchPointsBounds :2849` |
| corpora carrying `shootoutWin` in a recorded config | aff07f7ad8 `E/sports/{football,hockey,icehockey}/*.golden.json` (`git grep -c -a shootoutWin` matches all three); recording configs `E/testkit/golden.ts:82,1073`; the re-baseline splices each RECORDED config back into its states (`keepRecordedConfig`, `golden.ts:1382`; GOLDEN-POLICY.md:331-344) |
| hockey default `3/1/0 :130`; `fih-shootout` `{3,1,0, shootoutWin 2, shootoutLoss 1} :146`; ice hockey IIHF `{3,1,0, otWin 2, otLoss 1} :179`, recreational `{2,1,0} :208` | main@e97823e4d8 `hockey.ts`, `icehockey.ts` |
| cricket `points {win 2, tie 1, noResult 1, loss 0, draw?}` | main@e97823e4d8 `E/sports/cricket/cricket.ts:62-68` |
| set sports `pointsMap` (`setbased/kernel.ts:124`): badminton `{"*":[2,0]} :28`, table tennis `{"*":[2,0]} :30`, volleyball FIVB `{"3-2":[2,1],"*":[3,0]} :11`, beach `{"*":[2,0]} :61` | main@e97823e4d8 `E/sports/setbased/*` |
| tennis `points {win 2, loss 0}` `:25`; boardgame `scoring {2,1,0}` half-points `:61-67`; carrom `{2,0,1} :55-57`; generic `{w,d,l} :44-48` | main@e97823e4d8 per module |
| default cascades: badminton/TT/volleyball `points, wins, set_ratio, point_ratio, h2h_points`; ice hockey `points, h2h_points, h2h_diff, h2h_for, diff, for, seed`; cricket `points, wins, nrr, h2h_points, seed`; hockey `points, diff, for, h2h_points, seed`; tennis `points, set_ratio, game_ratio, h2h_points, seed`; generic `points, diff, for, h2h_points, lots`; football `FOOTBALL_TIEBREAKERS.fifa2026`; carrom `CARROM_TIEBREAKERS`; boardgame `BOARDGAME_TIEBREAKERS` | main@e97823e4d8 `E/sports/**` `defaultTiebreakers` |
| web cascade resolver `cascadeFor :492-494`; `toTableStage :496` (passes `rngSeed :504`); `applyPointsRule` call sites `:116` (bye) and `:432`; `recomputeStandings :583`; `rankedStageStandings :618`; `completeStageIfReady :668`; `status = 'complete' :849` | main@e97823e4d8 `W/server/engine-db/competition.ts` |
| stage activation: `generateStageFixturesWrite :2436` → `update stages set status = 'active' :2955`; `generateProgressionSetupFixtures :3476` → `:3788`; stage inserts `:575` and `templates.ts:356` (both `pending`) | main@e97823e4d8 `W/server/usecases/stages.ts` |
| `tableRuleKeys :23`; `STAGE_POINTS_REPLACES = {points, pointsMap} :43`; `lockedStageIdsAmong :74` (played OR an opened online round: PF-9); `divisionRefusals :102` (tiebreakers branch `:125-129`); `divisionLockedFields :160` | main@e97823e4d8 `W/server/usecases/rule-locks.ts` |
| `formatLockedStageIds :45`; `putStageRules :73` | main@e97823e4d8 `W/server/usecases/stage-rules.ts` |
| `writeFixtureRulesOverride :251` | main@e97823e4d8 `W/server/usecases/fixture-rules.ts` |
| `RULE_ERROR_STATUS :13`; `POINTS_SPLIT_LABEL_KEYS :115`; `ruleRefusalText :240` | main@e97823e4d8 `W/lib/rule-errors.ts` |
| `TiebreakerKeyS :325`; division `tiebreakers :450` (`CreateDivision`), `:479` (`PatchDivision`); `Division` response schema `tiebreakers :561` (the plan's "stage `:536`" was this line; no Stage schema carries `tiebreakers`); `rngSeed` optional `:1184` (`StageConfig :1152`) | main@e97823e4d8 `W/server/api-v1/schemas.ts` |
| template `tiebreakers: z.array(z.string()).optional() :135` | main@e97823e4d8 `W/server/templates/schema.ts` |
| `StagePointsSection` mounted `:2549`; `StageFormatRow :2264` | main@e97823e4d8 `W/components/v2/stages-panel.tsx` |
| W2c stage-rules UI: `stage-points-section.tsx`, `stage-points-model.ts`, `stage-row-model.ts`, `sequence-field.tsx` | main@e97823e4d8 `W/components/v2/stage-rules/` |
| hockey pad goal dock: kind chips from `cfg.goalKinds` skip `fg`/`og` (`fg` "is the default and needs no chip") | main@e97823e4d8 `W/components/v2/scorepad/v3/skins/period-shared.ts:1555-1572` |
| other resolvers (spec §6 W2–W7) | main@e97823e4d8 `W/server/public-site/competition-hub.ts:920`, `W/server/slideshow-data.ts:71`, `W/app/embed/divisions/[id]/[widget]/page.tsx:72`, `W/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx:95`, `W/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:439,960-979`, `W/server/public-site/standings-view.ts:370,391`, `division-qualification.ts:63`, `qualification-view.ts:169,375` |
| other `defaultTiebreakers` readers (Task 8 ports them, PS-3) | aff07f7ad8 `E/testkit/simulation.ts:238`, `E/testkit/conformance.ts:110`, `tools/bench/packs/build-packs/_tiny.ts:784`; engine tests `E/competition/tie-what-if.test.ts`, `E/sports/{boardgame/boardgame,carrom/carrom,football/football,nested/playerstats,period/period,setbased/playerstats}.test.ts`, `E/testkit/{conformance-pad,conformance}.test.ts` (9 files) |
| bench resolvers | main@e97823e4d8 `tools/bench/lib/validate-pack.ts:2303,2337,2367`, `tools/bench/lib/pack-template.ts:107`; `applyPointsRule` import `:191`, call `:2261` |
| smoke `w2cStageRulesSuite :7231`, called `:1294`; `SELECTABLE_SUITES :23060` (`w2cStageRules :23071`); `SMOKE_ONLY` takes a comma list (`scripts/smoke-select.ts:12`) | main@e97823e4d8 `scripts/smoke.ts` |
| W2c e2e `e2e/stage-rules-w2c.spec.ts`; `e2e/standings-popovers.spec.ts`; `e2e/mobile.spec.ts`; walkthroughs `e2e/walkthrough/` | main@e97823e4d8 `apps/web/` |
| highest delta: main@e97823e4d8 `V471__all_stages_free.sql` (W2c's is `V469__fixture_rules_override.sql`); W2d's is **`V472__w2d_table_rules.sql`** | `db/migration/deltas/` |
| `stages.status` check `('pending','active','complete')` | `db/migration/v2-engine/tables/V210__stages.sql:10` |
| golden hockey streams record untyped goals (`{"by":"H"}`) | main@e97823e4d8 `E/sports/hockey/hockey.golden.json` (finding PF-2) |

Before building on any line, the implementer re-opens it (AGENTS class 5). A moved line is a note in the task report; a changed MEANING is a new plan finding.

---

## Global Constraints

- **Worktree.** `WT` = the build worktree `/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2d-build`, branch `feat/format-matrix-w2d` (created in Task 0 off origin/main `2e0deaa6c1`, after W2c merged as #1007, with the spec and plan merged in at `e97823e4d8`).
  - Every shell command starts `cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2d-build && …` (cwd resets between calls).
  - Never edit the main checkout, the W2c worktree or the docs worktree. **Never `git stash`.** No heredocs: commit messages go through the Write tool to `$TMPDIR/w2d-msg.txt`, then `git commit -F "$TMPDIR/w2d-msg.txt" -- <paths>`, ending with the committing agent's own `Co-Authored-By:` line.
- **Local env.** `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`, label `w2d`: `$S up --label w2d --all` (fresh pg + `db:apply` + `sync:sports` + prod server); `eval "$($S env --label w2d)"`; `psql "$DATABASE_URL" -Atc "show data_directory"` equals the label's datadir; after a code change `$S rebuild --label w2d`. `BASE`/`SMOKE_BASE` use `localhost`, never 127.0.0.1.
- **Scoped runs only** (owner 2026-09-28). Never the full gate, full vitest, full e2e or `seazn-env gate`.
  - Web vitest (`<N>` = task):
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2d-build/apps/web && rm -f "$TMPDIR/w2d-t<N>.json" && pnpm exec vitest run <exact paths> --reporter=json --outputFile="$TMPDIR/w2d-t<N>.json"; echo EXIT=$?
    ```
  - Engine vitest: the same from `packages/engine`, output `$TMPDIR/w2d-t<N>e.json`.
  - **Judge** every run: `jq -c '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,failedSuites:.numFailedTestSuites,files:[.testResults[].name]|length,names:[.testResults[].name]}' "$TMPDIR/w2d-t<N>.json"`. Green = `failed==0`, `failedSuites==0`, `passed==total>0`, `files` == paths passed, every name starts with `WT`. A TDD red = `failed>0`, `failedSuites==0`, and each failure message is the assertion the step names (a `TypeError` or collect failure is not a red). Never trust an `rtk` summary.
  - DB suites: `.env.local` is the symlink and `jq '[.testResults[].assertionResults[]|select(.status=="pending")]|length'` is 0.
  - tsc: `cd WT/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.json; echo EXIT=$?`; engine `cd WT/packages/engine && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit; echo EXIT=$?`; scripts + tools (bench, matrix, smoke) `cd WT && rtk proxy node node_modules/typescript-native/bin/tsc -p tsconfig.scripts.json; echo EXIT=$?` (every task that edits an engine export a bench file reads, PS-3).
  - eslint: `cd WT && rtk proxy ./node_modules/.bin/eslint <changed files>; echo EXIT=$?` — clean only with `EXIT=0` and no `✖`.
  - **E2E: CI dispatch only, never local** (memory, owner): `cd WT && gh workflow run e2e.yml --ref feat/format-matrix-w2d` (always `--ref`; the workflow's only input is `pr`, so the dispatch runs every job). Judge ONLY the named spec file's results from the run's report artifact (`unexpected == 0`, `expected > 0` for that file) and confirm the run's `headSha` is the branch tip (a push to main cancels a dispatched run; re-dispatch). A Playwright `-g` slice is never a gate (class 21). `mobile.spec.ts` is serial: a red count is a floor.
- **`grep -a` always**; an empty grep from the wrong cwd is not absence.
- **Engine/web boundary.** `apps/web` imports only `@seazn/engine/{core,sport,sports,sports/<key>,competition}`; new engine helpers are exported from `E/competition/index.ts` or `E/sport/index.ts`; the engine never imports web; `tools/` is never imported by `apps/` or `packages/`.
- **Golden corpus** (`E/testkit/GOLDEN-POLICY.md`): never `UPDATE_GOLDEN`; never `REBASELINE_GOLDEN` **except Task 3's one isolated re-baseline commit (PS-1)**; new cfg fields `.optional()` with no default; `pnpm --filter @onryde/seazn-engine fold-epoch:check --against HEAD^1` green on every engine commit, except Task 3's code → corpus → bump sequence, which is judged once with `--against "$TASK_BASE"` after the bump commit (GOLDEN-POLICY.md:323-329: the corpus lands alone, the bump in the next commit). **Module `standingsDelta` does not change in W2d** (the table applies the rule; spec §5.1), **with one exception (PS-1): Task 3 edits ONLY the shoot-out branch of football's and the period kernel's `standingsDelta` payers and their bounds, so nothing reads the deleted `shootoutWin/shootoutLoss`.** Epoch bumps, all MAJOR: Task 3 football 2 → 3 and hockey 2 → 3 (and ice hockey 1 → 2 if its corpus moves); Task 18 hockey 3 → 4 (finding PF-2). No other sport's corpus may move.
- **OpenAPI** before every commit that touches `api-v1/`: `cd WT && pnpm openapi:gen && git status --porcelain openapi/` shows only the intended diff, committed with the task. CI's drift check must pass.
- **Strings.** Every new user-facing string goes to `W/dictionaries/{en,es,fr,nl}/ui.json` (editor, pad) or `public.json` (public table) in the same commit, then `pnpm i18n:gen-keys` and `pnpm i18n:check` at the root. `W/lib/i18n-keys.ts` is generated. Families (SPEC §9): `div.detail.tiebreak.rule.<key>` for every new key and modifier; editor chrome; §10 messages; points outcome rows; lots note; empty-table note.
- **Greenfield** (RULES.md:30-34, SPEC §7): shapes change without a deprecation window or alias; tests pinning old shapes are updated, each named in the report. The one exception is data: B1 pins started stages.
- **All scoring is free** (D1). No `requireFeature` on any W2d setting. Owner ruling 2026-10-20: ship BEHAVIOUR tests only (a Community org saves and the table pays); never a test that pins a gate's absence or an entitlement copy string.
- **UI bar** (D1, owner 2026-10-19): correctness first, existing W2c pattern, house theme, no polish pass. Sign-off screenshots at **1280 only**; the e2e spec runs at all seven width projects in CI with no horizontal scroll. Every UI dispatch invokes `frontend-design:frontend-design` and applies it. Phone composition rules (AGENTS.md) apply to the pad change.
- **Do not touch:** `.github/workflows/e2e.yml`; `tools/bench/lib/suites/run-suite.ts`/`PackSchema` (the other bench files W2d's renames reach ARE in scope and ported in Tasks 2, 8, 9 — PS-3); committed `truth-runs/**`; the spec (orchestrator owns it); Swiss pairing and Swiss default CONTENT (W3); `colorOfHome`; any module `standingsDelta` body, **except Task 3's shoot-out branch (PS-1, above)**; any engine file split.
- **Test authority** (TEST-STRATEGY 1–10; R9, R13, R15–R19, R25–R29):
  - **Expected values** come from the rulebook text (RBG/RBS lines cited in the test title or a comment) or the engine's declarations (`module.tablePointsRule`, `module.reachableDecidedIn`, `module.primaryTableKey`, `module.defaultTiebreakers(kind, cfg)`, `module.metrics`, `module.configSchema`, `module.variants`). Never from the function under test. Each guard has one case where the right answer differs from the wrong one's constant.
  - **Anti-vacuity:** every sweep and property returns its count and asserts `> 0` (and equal to the derived population where known); zero checked fails. Sport sweeps go through `forEachSport`.
  - **Sequence cases**, empty first, in every task: a second call, an empty input, after a void or withdrawal, another sport.
  - **Mutate the guard once** (R17): each task's `MUT/t<N>.json` (`{id, file, find, replace, killers:[{cwd, files, name}]}`), run `cd WT && pnpm mutate --list MUT/t<N>.json --json-out "$TMPDIR/w2d-mut-t<N>.json"; echo EXIT=$?` → every row `KILLED`. Engine tasks also run changed-lines Stryker (`TASK_BASE` recorded by the orchestrator):
    ```bash
    cd WT/packages/engine && rm -f reports/mutation/changed.json && M="$(node scripts/stryker-changed.mjs --base "$TASK_BASE")" && STRYKER_MUTATE="$M" pnpm mutation > "$TMPDIR/w2d-stryker-t<N>.log" 2>&1; echo EXIT=$?; node scripts/stryker-changed.mjs --report reports/mutation/changed.json --expect "$M"
    ```
    Expected `survived: 0, noCoverage: 0`, or a killing test, or an equivalence row the reviewer agrees with. Never `// Stryker disable`. A guard whose only witness is a browser gets a pure `*-model.ts` helper with a unit killer. **Never run `pnpm mutate` or Stryker while any other task's tests, tsc or build run in the same tree** (`pnpm mutate` rewrites source in place; Stryker shares `reports/mutation/changed.json` and diffs `--base "$TASK_BASE"`) — PS-4.
  - **Rule-10 sequences:** fast-check with invariants after every step; a shrunk failure is committed as a named regression with its seed BEFORE the fix (R29).
  - **Four test types per task** (RULES.md): unit; e2e traced to a NAMED spec file and title (CI dispatch); smoke as a named check in `w2dTablesSuite` (`scripts/smoke.ts`, created in Task 13 — the first task whose checks the API can see, PS-2), run scoped as `SMOKE_ONLY=w2dTables` (registered in `SELECTABLE_SUITES`; never a full `pnpm smoke`, PS-9a); regression = the red-first test plus the named existing suite kept green. A regression run passes exact FILES, never a directory, and states the file count the judge's `files` must equal (PS-9d). "N/A" is never a test type: a task with no UI or API of its own traces forward to a named spec title or smoke check (RULES.md:104-110).
  - **Rule rows:** every proving test title carries its rule id as a whole token (Appendix A, signed in Task 0). No task edits `packages/engine/test/rules-reference.ts` `AWAITING_PROOF` (`:47`) or a rules file's `proved-by`; the orchestrator does that in one commit per wave.
- **Docs as they happen** (R22): each task reports IDX lines (W2 row, false premises); the orchestrator commits IDX.

---

## Review Focus

Five inputs the spec implies but no requirement names, most likely first. Each line's test is written into the owning task.

1. **The organiser rebuilds or regenerates fixtures on an active stage** (the "Rebuild fixtures" path re-runs generation). The pin taken at first activation stands: it is neither cleared nor re-taken from a division or sport default that changed in between. Test: Task 9, `table-rules-pin.test.ts` "Review Focus 1: regenerating an active stage keeps its first pin".
2. **An entrant withdraws, or a fixture is expunged (ruling 105), after a drawing of lots.** The tied membership changes, so the old draw is superseded and a new one is stored; reloading twice gives the same order; the old row stays as history and is never applied to a different membership. Test: Task 5 `lots-stored.test.ts` "Review Focus 2: a changed tied set draws again and keeps the old row"; DB half in Task 9 `stage-lots.test.ts`.
3. **Two recomputes race for the same stage** (two scorers finishing fixtures in one pool at once). Exactly one draw row exists per `(stage, pool, members)` and both readers return the same order. Test: Task 9, `stage-lots.test.ts` "Review Focus 3: concurrent recomputes store one draw".
4. **An API client sends `tiebreakers: []` versus `tiebreakers: null`.** `null` inherits (badge Inherited); `[]` is refused `TIEBREAK_KEY_INVALID` with reason `empty`, never stored as "no order". Test: Task 10, `stage-tiebreaks-write.test.ts` "Review Focus 4: [] is refused, null inherits".
5. **A stage with carried-over openings** (`carry_deltas`, carry mode `points`/`full`) under the new always-applied rule. Carried rows keep their carried points; only the stage's own fixtures are paid by `payout`; the carried row is never re-paid. Test: Task 9 (web, DB — carried rows meet `payout` only in web code: `carryDeltas` at `stages.ts:4494`, payout sites `competition.ts:116,432`; PS-5e), `table-rules-pin.test.ts` "Review Focus 5: carried openings are not re-paid by the stage rule".

---

## Execution

- **Agents.** Opus-minimum (`RULES.md` agent topology; the W2c Sonnet exception is W2c-only and is NOT extended — planner's reading of SPEC §15.3). Implementer → reviewer per task; no dispatch sets `model:`.
- **Every dispatch carries five things** (AGENTS.md): exact paths; acceptance (the task's red and green with rule ids); what NOT to touch (Global Constraints + the task's list); the verify command; the cap "final message under 15 lines — counts, paths, deviations, blockers; no file contents or diffs".
- **Raw counts.** The orchestrator never accepts "done, tests pass" without the judge's JSON line, and re-runs each wave's SCOPED gate (the union of the wave's Step-4 commands) itself.
- **Waves.** Each wave ends with ONE whole-wave `reviewer` pass over `git diff <wave-start-sha>..HEAD`, the orchestrator's scoped gate, the wave's proof commit (AWAITING_PROOF + `proved-by`), and a **walkthrough** (owner rule): the orchestrator drives the product on the `w2d` env through what the wave changed and writes per-screen verdicts (1280 for UI). The next wave starts only after all four are clean.

### Waves and parallelism

| Wave | Tasks | Order | Starts when |
|---|---|---|---|
| 0 | 0 | orchestrator | W2c merged |
| 1 — engine foundations | 1, 2, 3, 4, 5, 6 | 1 → 2 → 4 → 3 → 5 → 6 (sequential, PS-4) | Task 0 |
| 2 — storage, pin, resolver | 7, 8, 9, 10 | 7 → 8 → 9 → 10 (sequential, PS-4); **T11 merges before T10** starts (PS-2) | wave 1 closed |
| 3 — defaults and cross-group | 11, 12 | 11 (lane; starts right after Task 8 merges; **merges before Task 10**) → 12 (after 10) | Task 8 merged |
| 4 — API and the real seam | 13, 14 | 13 → 14 | waves 2 and 3 closed |
| 5 — UI and pad | 15+16 (one loop), 17, 18 | 15+16 → 17 → 18 | wave 4 closed |
| 6 — close-out | 19, 20, 21 | 19 → 20 → 21 | wave 5 closed |

**Why the former pairs run sequentially (PS-4).** The file sets of 2/4, 3/5 and 7/8 are disjoint, but their verify steps are not: `pnpm mutate` rewrites source in place while the other task's tests run; changed-lines Stryker shares `reports/mutation/changed.json` and diffs `--base "$TASK_BASE"`, which would include the other task's edits; engine tsc, vitest and `$S rebuild --label w2d` (Task 7) build the other task's half-done state; `fold-epoch:check --against HEAD^1` can land on the sibling's commit. One build worktree, one implementer at a time (SDD rule: never parallel implementers).

**Why Task 11 merges before Task 10 (PS-2).** Task 10 validates the effective cascade on `createStages`/`replaceStages`. Until Task 11, the sport default is today's list (Task 8), which fails Task 6's rules for badminton, table tennis, volleyball, cricket, hockey, ice hockey and tennis (no `lots`; `points` first where the primary is `wins`) and for chess (`buchholz*` on a non-Swiss stage). With 11 merged first, every inherited default is valid when 10's validation lands, so §5.5 holds exactly as written.

**Task 11's lane** (`format-matrix-w2d-defaults`, its own tree): 11 edits `E/sports/**` values, `E/sport/module.ts` (`tablePresets`), `RULES/*.md` and its own engine tests; 9 edits `W/**`, `E/competition/points.ts` and `tools/bench/**`. The files are disjoint and the lane shares no verify step with the build tree, so whether 11 overlaps 9 is the orchestrator's scheduling call. 11 merges (`--no-ff`, re-gated on the merged tree) before Task 10 starts and before Task 12.

Everything from 13 on is sequential: `schemas.ts`/`openapi`, `smoke.ts`, the dictionaries and `mobile.spec.ts` are shared.

Lanes branch from `feat/format-matrix-w2d`, get their own `pnpm install --frozen-lockfile` and `.env.local` symlinks, and merge back with `git merge --no-ff` (never squash); the lane's scoped gate re-runs on the merged tree. Lanes never write IDX or rules-reference.

---

## File structure

| Path | Responsibility | Task |
|---|---|---|
| `E/competition/decided-in.ts` (new) | `DecidedIn`, `decidedInFor`, `DECIDED_IN` | 1 |
| `E/sport/module.ts` | `outcomeMethods`, `decidedInOf`, `reachableDecidedIn`, `reachableResultKinds`, `reachableSetScores?`, `shootoutAs`, `winsCount?`, `declaresUnplayedLoss?` (1); `TiebreakerKey` additions (4); `tablePointsRule` (3); `primaryTableKey` (6); `defaultTiebreakers(kind, cfg)` (8; PS-7c); `tablePresets?` (11); `partialScheduleOrder?` (12) | 1, 3, 4, 6, 8, 11, 12 |
| `E/competition/points.ts` | widened `PointsRule`, `payout`, `reachableOutcomes`, `coverage`, `pointsRuleBounds`, `legacyPointsRule` (2); old-shape tolerance deleted (9); inexpressible deleted (10) | 2, 9, 10 |
| `E/sports/**` | per-sport declarations, `tablePointsRule`, `soBonus` and the shoot-out branch of the two `standingsDelta` payers (PS-1), defaults, presets | 1, 3, 6, 8, 11, 12, 18 |
| `E/sports/{football,hockey,icehockey}/*.golden.json`, `E/sport/fold-epoch.ts` | Task 3's isolated re-baseline and MAJOR bumps (PS-1); hockey's second MAJOR | 3, 18 |
| `W/lib/match-rules/football.ts`, `W/components/v2/{division-settings.tsx,division-format-patch.ts}`, `W/lib/rule-errors.ts` (`POINTS_SPLIT_LABEL_KEYS`), `rules.err.pointsSplit.shootout*` copy | web half of the `shootoutWin/shootoutLoss` removal (PS-1) | 3 |
| `E/competition/tiebreakers.ts` | new keys, modifiers, throw on no comparator, stored lots, partial-schedule guard | 4, 5, 12 |
| `E/competition/cascade-rules.ts` (new) | `validateCascade` (moved and rewritten), `CascadeRefusal` | 6 |
| `E/competition/table-rules.ts` (new) | `TableRules`, `TableRulesPin`, `resolveTableRules` | 8 |
| `E/competition/{stage,progression,tie-what-if,display}.ts` | consume `TableRules`; cross-group order; primary key; columns | 5, 8, 12, 17 |
| `db/migration/deltas/V<n>__w2d_table_rules.sql` (new) | pin columns, `stage_lots_draws`, `w2d_pin_started_stages()` | 7 |
| `scripts/w2d/pin-scenario.ts` (new) + `W/server/engine-db/__tests__/fixtures/{w2d-pin-before.json,w2d-pin-seed.ts}` | B1 seed, the pre-W2d snapshot (with every UUID and `rngSeed`) and its seeding twin (PS-8) | 7 |
| `W/server/engine-db/table-rules.ts` (new) | `loadTableRules`, `pinStageTableRules`, `repinStageOwnRules`, `loadLotsDraws`, `persistLotsDraws` | 9 |
| `W/server/engine-db/competition.ts` + the six resolvers (SPEC §6) | one resolver; `winsCount`/`gamePoints` at every rank call | 8 (port), 9 |
| `tools/bench/lib/{validate-pack,pack-template}.ts`, `tools/bench/packs/build-packs/_tiny.ts` | bench ports (in W2d scope, PS-3) | 2, 8, 9 |
| `W/server/usecases/{stage-rules,rule-locks,divisions,stages,templates,fixture-rules,stage-rules-merge}.ts`, `W/server/templates/schema.ts`, `W/components/v2/stage-rules/stage-points-{model.ts,section.tsx}` (inexpressible state), `W/components/v2/division-settings-locks.ts` | write paths, lock, coverage, `stagesKeptPinned`, inexpressible deleted | 10 |
| `W/server/api-v1/{schemas,openapi}.ts`, `openapi/*.json`, `W/lib/rule-errors.ts` | API v1 | 2 (`openapi:gen` only), 10 (`TiebreakerKeyS`), 13 |
| `W/components/v2/stage-rules/{stage-tiebreaks-section.tsx,stage-tiebreaks-model.ts}` (new), `stage-points-{section.tsx,model.ts}`, `stages-panel.tsx` | Option A | 15, 16 |
| `W/server/public-site/standings-view.ts`, `W/components/public-site/standings-table.tsx`, `W/lib/tiebreak-label.ts` | public table | 17 |
| `W/components/v2/scorepad/v3/skins/period-shared.ts`, `E/sports/period/kernel.ts`, `E/sport/fold-epoch.ts` | hockey goal type | 18 |
| `scripts/smoke.ts` (`w2dTablesSuite`, registered as `w2dTables` in `SELECTABLE_SUITES`) | smoke | 13–18 |
| `apps/web/e2e/stage-tiebreaks-w2d.spec.ts` (new), `e2e/walkthrough/tables-w2d.spec.ts` (new), `e2e/mobile.spec.ts`, `e2e/standings-popovers.spec.ts` | e2e | 15–19 |
| `RULES/*.md` | Appendix A rows | 0, 11 |
| `MUT/t<N>.json` | hand mutants | every code task |

---

## Tasks

Every task lists its files, interfaces, its four test types, its sequence cases (empty first), its mutation step and its verify command. The orchestrator records `TASK_BASE=$(git rev-parse HEAD)` before each dispatch.

### Task 0: Orchestrator — rebase, re-pin, migration number, rule rows, the pre-W2d base (W2c merged #1007, 2026-10-24)

SPEC §15.1–2, §11.1, D1, Appendix A.

**Files:**
- Create: `WT` (worktree), `MUT/.gitkeep`.
- Modify: this plan's **Anchors** table (re-pinned values), `RULES/{cross-sport,football,hockey,icehockey,boardgame,cricket,volleyball,badminton,tabletennis,tennis,carrom,generic}.md` (Appendix A rows, status `awaiting proof`), `packages/engine/test/rules-reference.test.ts` (`AWAITING_PROOF` gains every Appendix A id), `IDX` (W2d row: started, `W2D_BASE`).

- [x] **Step 1: Create the build worktree after W2c merges**
  ```bash
  cd /Users/ashokhein/github/seazn.club && git fetch origin && git worktree add ../seazn.club-worktrees/format-matrix-w2d-build -b feat/format-matrix-w2d origin/main; echo EXIT=$?
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2d-build && git merge --no-ff docs/format-matrix-w2d -m "Merge W2d spec and plan"; echo EXIT=$?
  ```
  Expected: `EXIT=0` twice; `git log --oneline -3` shows the merge, and `git merge-base --is-ancestor <W2c merge sha> HEAD` exits 0. Then `pnpm install --frozen-lockfile`; symlink `.env.local` and `apps/web/.env.local` from the main checkout; `readlink -f node_modules/@seazn/engine` resolves inside `WT`. Record `W2D_BASE=$(git rev-parse HEAD)` in IDX: it is the pre-W2d code the B1 snapshot runs (Task 7).
- [x] **Step 2: Re-pin every Anchors row on the rebased tree** with `git grep -n -a`. A moved line is updated in place; a changed meaning becomes a Plan finding. Confirm in particular: W2c's `STAGE_POINTS_REPLACES`, `divisionRefusals`' tiebreakers branch, `writeFixtureRulesOverride`, `applyPointsRule`'s five parameters, the two `status = 'active'` writers, and that no third activation writer exists (`git grep -n -a -E "stages set status|insert into stages" -- apps/web/src scripts tools`).
- [x] **Step 3: Fix the migration number.** `ls db/migration/deltas | sort -V | tail -3` → `V<max>`; W2d's delta is `V<max+1>__w2d_table_rules.sql`. Record the number in IDX and tell f-r2 / free-stages / email-outbox (whoever lands second renumbers, D1).
- [ ] **Step 4: Sign the rule rows.** Put Appendix A's rows to the owner in chat, word for word, at plan start (ruling 75). Write the signed text into each `RULES/*.md` with status `awaiting proof`, add each id to `AWAITING_PROOF`, and run `rules-reference.test.ts` (judged by JSON; green means the map lists every new id).
- [x] **Step 5: Send f-w2c the handover note** (SPEC §11.2) as a RECOMMENDATION from f-w2d, never as an owner ruling (class 17): `shootoutWin/shootoutLoss` are replaced by `soBonus`; `STAGE_POINTS_REPLACES` widens; the tiebreakers branch of `divisionRefusals` goes. — void, see PF-13
- [ ] **Step 6: Commit** `git commit -F "$TMPDIR/w2d-msg.txt" -- RULES packages/engine/test/rules-reference.test.ts docs/superpowers/plans/2026-10-20-format-matrix-w2d.md MUT/.gitkeep` (IDX by the orchestrator in the same commit).

---

### Task 1: Engine — `decidedIn` and the outcome vocabulary per sport (wave 1)

SPEC §5.2, D4, B2 (shoot-out kind), §13.4 (`decidedInOf` total). Rule rows X-PT-2, X-PT-4.

**Files:**
- Create: `E/competition/decided-in.ts`; export from `E/competition/index.ts`.
- Modify: `E/sport/module.ts` (`SportModule` gains the eight members below: the seven of the original plan plus `declaresUnplayedLoss`, PS-7a).
- Modify: `E/sports/football/football.ts`, `E/sports/period/kernel.ts` (+ `hockey.ts`, `icehockey.ts` presets), `E/sports/cricket/cricket.ts`, `E/sports/boardgame/boardgame.ts`, `E/sports/setbased/kernel.ts`, `E/sports/nested/kernel.ts` (tennis), `E/sports/carrom/carrom.ts`, `E/sports/generic/generic.ts`: one declaration block each.
- Test: `E/competition/decided-in.test.ts` (new); `E/sport/outcome-methods-source.test.ts` (new source scan).
- Create: `MUT/t1.json`.
- Do NOT touch: any `standingsDelta`, any fold.

**Interfaces:**
- Consumes: `MatchOutcome` (`E/core/types.ts`), `StageKind`, `AnySportModule`, `EngineError("CONFIG_INVALID")`.
- Produces:
  ```ts
  // E/competition/decided-in.ts
  export type DecidedIn = "regulation" | "ot" | "so";
  export const DECIDED_IN: readonly DecidedIn[]; // ["regulation","ot","so"]
  /** null for every outcome kind except `win`. Throws CONFIG_INVALID for a method the module does not declare. */
  export function decidedInFor(module: Pick<AnySportModule, "decidedInOf">, outcome: MatchOutcome): DecidedIn | null;
  // E/sport/module.ts — on SportModule
  readonly outcomeMethods: readonly string[];          // every `win.method` the fold can write
  decidedInOf(method: string): DecidedIn;              // throws CONFIG_INVALID on an unknown method
  reachableDecidedIn(cfg: Cfg, stageKind: StageKind): ReadonlySet<DecidedIn>;
  reachableResultKinds(cfg: Cfg, stageKind: StageKind): ReadonlySet<"draw" | "tie" | "noResult">;
  reachableSetScores?(cfg: Cfg): readonly `${number}-${number}`[]; // set sports only, from bestOf
  readonly shootoutAs: "draw_plus_bonus" | "result";
  readonly winsCount?: "all" | "regulation";          // absent = "all"
  readonly declaresUnplayedLoss?: true;               // D6: a "loss, not played" value exists; table tennis only (PS-7a)
  ```

**PF-10 first (read and cite, before Step 1):** read `settleAppliesInTable` (`E/core/events.ts:193`) and `rowAwaitsSettle` (`W/server/engine-db/recorded-abandon.ts:84`), and cite the file:line of each in the task report. An organiser no-result abandon is `core.abandon{noResult:true}` with `outcome` null and the separate `no_result` flag (`W/server/engine-db/competition.ts:346`). Task 9's web payout sites hand `payout` the outcome `{kind:"no_result"}` for it (PS-5c), for which `decidedInFor` is null like every non-win kind (the "decidedInFor is null for … no_result" case below covers it).

**Declarations (SPEC §5.2 table; mapping `extra_time`→`ot`; `shootout`, `super_over`, `boundary_count`, `tiebreak_*`→`so`; `abandoned`→`regulation`; legacy `walkover`/`forfeit` win methods → `regulation`, still treated as awards by `forfeitShaped`):**

| Module | `reachableDecidedIn` | `reachableResultKinds` | `shootoutAs` | `winsCount` |
|---|---|---|---|---|
| football | regulation; `ot` iff the merged cfg's `extraTime.enabled`; `so` iff `shootout` | draw iff the stage is a table stage | `draw_plus_bonus` | all |
| hockey (period preset) | regulation; `so` iff `shootout ≠ null`; `ot` iff `overtime ≠ null` | draw (table) | `draw_plus_bonus` | `regulation` (B2) |
| ice hockey | regulation; `ot` iff `overtime ≠ null`; `so` iff `shootout ≠ null` | draw iff `overtime === null` (recreational) | `result` | all |
| cricket | regulation; `so` iff `superOver` | tie, noResult; draw iff `inningsPerSide === 2` | `result` (author's call) | all |
| boardgame | regulation; `so` iff a table stage carries `tiebreakRungs` | draw | `result` (author's call) | all |
| set sports, tennis, carrom, generic | regulation | carrom/generic: draw; others none | `result` | all |

`declaresUnplayedLoss: true` is declared by table tennis only (D6, SPEC §5.10 "W 2, played L 1, unplayed L 0"); every other module omits it, so `loss.unplayed` is reachable nowhere else (PS-7a).

- [ ] **Step 1: Write the failing tests.** `E/competition/decided-in.test.ts`:
  ```ts
  // X-PT-2. Expected values from SPEC §5.2's mapping and each module's own cfg declarations, never from decidedInFor.
  it("X-PT-2 decidedInOf is total over every declared outcome method (forEachSport, counted)", () => {
    const visited = new Set<string>();
    const n = forEachSport(({ module }) => { visited.add(module.key); for (const m of module.outcomeMethods) expect(DECIDED_IN).toContain(module.decidedInOf(m)); });
    expect(n).toBeGreaterThan(0);
    // PS-9g: the bound comes from an independent declaration (the epoch table), never from the list being iterated.
    expect([...visited].sort()).toEqual(Object.keys(FOLD_EPOCH).sort());
  });
  it("X-PT-2 the mapping: extra_time→ot; shootout, super_over, boundary_count, tiebreak_<rung>→so; abandoned→regulation", …);
  //   football.decidedInOf("extra_time")==="ot"; football.decidedInOf("shootout")==="so"; cricket "super_over"/"boundary_count"→"so";
  //   cricket "innings"/"dls"/"regulation"→"regulation"; for every rung of TIEBREAK_RUNGS boardgame.decidedInOf(`tiebreak_${r}`)==="so" (count === TIEBREAK_RUNGS.length)
  it("an unknown method throws CONFIG_INVALID, never maps to regulation", () => expect(() => football.decidedInOf("bogus")).toThrow(/CONFIG_INVALID/));
  it("decidedInFor is null for draw, tie, no_result, award, double_walkover (empty case first: an undecided fixture → null)", …);
  it("X-PT-2 ice hockey IIHF reaches {regulation, ot, so}; recreational reaches {regulation} (icehockey.ts variants)", …);
  //   expected sets derived from cfg: overtime !== null ⇒ ot, shootout !== null ⇒ so — read from icehockey.variants
  it("X-PT-2 football league reaches {regulation}; a group stage with shootout on reaches {regulation, so}; extraTime.enabled adds ot", …);
  it("X-PT-4 shootoutAs: football and hockey draw_plus_bonus; ice hockey, cricket, boardgame result", …);
  it("HK-TB-1 hockey declares winsCount 'regulation'; no other sport does (counted)", …);
  it("cricket reaches tie and noResult; draw only when inningsPerSide === 2 (D10(c))", …);
  it("volleyball bestOf 5 reaches set scores 3-0, 3-1, 3-2; bestOf 3 reaches 2-0, 2-1 (from cfg.bestOf, not typed lists)", …);
  it("X-WO-1 (amended, D6) only table tennis declares an unplayed loss; no other module does (counted)", …);
  ```
  `E/sport/outcome-methods-source.test.ts`: for each module source file, every `method: "<literal>"` written on a `win` outcome (`git grep -a`-style regex over the file text) is in `module.outcomeMethods`; reports the count per module and fails on 0 for any module that writes wins.
- [ ] **Step 2: Run, expect FAIL** (`decided-in.ts` missing → collect fails first; after a stub export, the assertions fail on `outcomeMethods` undefined).
  `cd WT/packages/engine && rm -f "$TMPDIR/w2d-t1e.json" && pnpm exec vitest run src/competition/decided-in.test.ts src/sport/outcome-methods-source.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t1e.json"; echo EXIT=$?`
- [ ] **Step 3: Implement** `decided-in.ts` and the declarations in the table, one block per module (kernels declare for their presets; hockey/ice hockey differ by preset). `reachableSetScores` enumerates `W-L` for `W = ceil(bestOf/2)`, `L ∈ [0, W-1]`.
- [ ] **Step 4: Run, expect PASS**; engine tsc; eslint on changed files; `pnpm --filter @onryde/seazn-engine fold-epoch:check --against HEAD^1` (no golden moves).
- [ ] **Step 5: Mutate** `MUT/t1.json`: (a) `decidedInOf` default branch returns `"regulation"` instead of throwing → killed by "an unknown method throws"; (b) ice hockey `so` condition `shootout !== null` → `true` → killed by the recreational case. Run the mutate command; every row KILLED.
- [ ] **Step 6: Commit** `feat(engine): decidedIn and the per-sport outcome vocabulary (W2d T1)`.

Test types: unit (above); e2e → Task 19 `tables-w2d.spec.ts` "goals family: OT and shoot-out results"; smoke → Task 14 (`w2dTablesSuite` "decidedIn reaches the public row"); regression: `E/sport/supports-draws.test.ts`, `E/testkit/for-each-sport.test.ts` stay green. Sequence: undecided → decided → void (outcome null → `decidedInFor` null) → another sport.

---

### Task 2: Engine — the widened `PointsRule`, `payout`, reachable outcomes and coverage (wave 1, after Task 1)

SPEC §5.3, D4, D6, D9, D10(a)(c), B2, F11 (§2.1 #15). Rule rows X-PT-2, X-PT-3, X-PT-4, X-WO-1 (amended), X-DW-4, FB-PT-1, VB-PT-2, VB-PT-3, CK-PT-1, CK-PT-2, TT-PT-1, IH-PT-1.

**Files:**
- Modify: `E/competition/points.ts` — `PointsRule` (replaces `:13-40`), `payout` (replaces `applyPointsRule :174`), `validatePointsRule :46` (margin aliases), `pointsRuleBounds :378` (over reachable outcomes), new `reachableOutcomes`, `coverage`, `legacyPointsRule`. `forfeitShaped`, `isUnplayedForfeit`, `carryDeltas`, `applyRankLocks` unchanged. `pointsRuleExpressible` stays until Task 10 deletes it with its readers.
- Modify (mechanical port so `tsc` stays green; `tsc` lists them; no behaviour change beyond the shape): `W/server/engine-db/competition.ts:98,116,386,432`; `W/server/engine-db/fixture-cfg.ts:2` (imports `PointsRule`, PF-6); main@e97823e4d8 `W/components/v2/stage-rules/stage-points-model.ts` (`ZERO_BASE`, `storedPointsRule`, the draft builder); `W/lib/points-line.ts`; `E/testkit/scenarios.ts`; the existing tests `E/competition/{points,points-w2c,w2b-tables,tiebreak-rule-award-alias}.test.ts`, `W/server/public-site/__tests__/qualification-view.test.ts`. Bench (in W2d's scope, PS-3: W2d renames the type, so bench tsc must stay green): `tools/bench/lib/validate-pack.ts:191,2261` (`applyPointsRule` → `payout`, same mechanical port).
- Read, no edit: `W/server/api-v1/schemas.ts:18` re-uses the engine `PointsRule` (`PutStageRules.points :1294`), so the OpenAPI output moves in THIS task: run `cd WT && pnpm openapi:gen` and commit `openapi/*.json` with it (PS-3c; Global "OpenAPI").
- Test: `E/competition/points-w2d.test.ts` (new); `E/competition/points-w2d.property.test.ts` (new, fast-check).
- Create: `MUT/t2.json`.

**Interfaces:**
- Consumes: `DecidedIn`, `decidedInFor`, the Task 1 module members; `AwardScoreKeys`; `DIFF_KEYS/FOR_KEYS/AGAINST_KEYS` (`tiebreakers.ts:237-241`).
- Produces:
  ```ts
  export const PointsRule: z.ZodType<PointsRule>; // shape exactly SPEC §5.3
  export type PointsRule = {
    win: { regulation: number; ot?: number; so?: number };
    loss: { regulation: number; ot?: number; so?: number; unplayed?: number };
    draw?: number; soBonus?: number; shootoutAs: "draw_plus_bonus" | "result";
    tie?: number; noResult?: number;
    bySetScore?: Record<string, readonly [number, number]>;
    unit: "whole" | "half";
    bonuses: Bonus[]; forfeit?: { winnerPoints: number; loserPoints: number; awardScore?: readonly [number, number] };
  };
  export type OutcomeKey =
    | `win.${DecidedIn}` | `loss.${DecidedIn}` | "loss.unplayed" | "draw" | "tie" | "noResult" | `set:${number}-${number}`;
  export function payout(outcome: MatchOutcome, decidedIn: DecidedIn | null, pair: FixtureResult, played: boolean,
                         rule: PointsRule, scoreKeys: AwardScoreKeys | undefined): FixtureResult;
  export function reachableOutcomes(module: AnySportModule, cfg: unknown, stageKind: StageKind): ReadonlySet<OutcomeKey>;
  export type Coverage = { readonly ok: true } | { readonly ok: false; readonly uncovered: readonly OutcomeKey[] };
  export function coverage(rule: PointsRule, reachable: ReadonlySet<OutcomeKey>): Coverage;
  export function pointsRuleBounds(rule: PointsRule, reachable: ReadonlySet<OutcomeKey>): MatchPointsBounds;
  /** B1: the old {base, bonuses, forfeit} shape, paid as before W2d (tie 0, noResult 0, SO/OT as a win/loss). */
  export function legacyPointsRule(old: { base: { win: number; draw: number; loss: number }; bonuses?: unknown[]; forfeit?: unknown }): PointsRule;
  /** Reads a stored `config.points`: the new shape, or (until Task 9 deletes this branch) the old shape via legacyPointsRule; else null. */
  export function parseStoredPointsRule(raw: unknown): PointsRule | null;
  ```
  `payout` also writes the display metrics `won_ot`, `won_so`, `lost_ot`, `lost_so` (0/1, written only when 1) on a `win`; under `draw_plus_bonus` + `so` the W/D/L becomes drawn/drawn and the winner still gets `won_so: 1` (SPEC §5.1, §5.7).
  `reachableOutcomes` adds `loss.unplayed` only when `module.declaresUnplayedLoss` (table tennis, PS-7a); elsewhere an unplayed loss falls back to the credited score's loss (SPEC §5.3 coverage defaults).

**PF-10 first:** the same read-and-cite as Task 1 (`settleAppliesInTable` `E/core/events.ts:193`, `rowAwaitsSettle` `W/server/engine-db/recorded-abandon.ts:84`), cited in the report; `payout({kind:"no_result"}, null, …)` pays `rule.noResult ?? 0` (the CK-PT-1 cases below), and the web mapping of the `no_result` flag to that outcome is Task 9's (PS-5c).

- [ ] **Step 1: Write the failing tests.** `E/competition/points-w2d.test.ts`; every rule below is typed from the rulebook values SPEC §5.10 signs, never from a module:
  ```ts
  const IIHF = PointsRule.parse({ win: { regulation: 3, ot: 2 }, loss: { regulation: 0, ot: 1 }, shootoutAs: "result", unit: "whole", bonuses: [] });
  const FB   = PointsRule.parse({ win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "draw_plus_bonus", unit: "whole", bonuses: [] });
  const TT   = PointsRule.parse({ win: { regulation: 2 }, loss: { regulation: 1, unplayed: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] });
  // empty case first
  it("an undecided fixture pays nothing and is not counted", …);
  it("X-DW-4 a double walkover pays 0/0 and no bonus, whatever the rule", …);
  it("IH-PT-1 an OT win pays 2/1; a GWS with no `so` entry falls back to the OT values 2/1 (RBG:343-344)", …);
  it("FB-PT-1 X-PT-4 a shoot-out under draw_plus_bonus books drawn/drawn, pays 1+1=2 to the winner and 1 to the loser; won_so 1 on the winner; wins 0 for both (RB2B-7)", () => {
    const [h, a] = payout(win("H", "shootout"), "so", pair(1, 1), true, FB, undefined);
    expect([h.won, h.drawn, h.lost, h.points]).toEqual([0, 1, 0, 2]);
    expect([a.won, a.drawn, a.lost, a.points]).toEqual([0, 1, 0, 1]);
    expect(h.metrics.won_so).toBe(1);
  });
  it("B2 soBonus absent defaults to 1; soBonus 2 pays 3/1 (the differential against a hard-coded 1)", …);
  it("X-WO-1 (amended, D6) TT: an unplayed walkover loser gets loss.unplayed 0; a played loser gets 1; the winner gets 2 either way", …);
  it("X-PT-1 an unplayed forfeit with a forfeit row pays the forfeit row, not loss.unplayed (precedence, SPEC §5.3 step 5)", …);
  it("a bye pays the forfeit row if set, else the clean-sweep win; never awardScore", …);
  it("CK-PT-1 cricket: tie 1 each; noResult 1 each; a rule with no noResult pays 0 (D14)", …);
  it("CK-PT-2 a two-innings draw pays `draw` 1 (D10(c))", …);
  it("VB-PT-2 bySetScore {2-0:[3,0], 2-1:[2,1]}: 2-1 pays 2:1, not 3:0 (SC-S9); an exact key beats '*'", …);
  it("F11 a win_margin_gte bonus reads football's gd and cricket's run_diff, not literal diff (validatePointsRule accepts it)", …);
  it("unit 'half' changes nothing payout pays (display only)", …);
  it("a draw under a rule with no draw throws CONFIG_INVALID (coverage should have refused it at save)", …);

  describe("reachableOutcomes + coverage (X-PT-3)", () => {
    it("an empty reachable set is covered (empty case)", …);
    it("football group with shootout on: {win.regulation, loss.regulation, draw, win.so, loss.so} — no loss.unplayed (PS-7a)", …); // from Task 1 declarations
    it("X-WO-1 (amended, D6) table tennis reaches loss.unplayed; football, hockey and badminton do not (declaresUnplayedLoss, counted)", …);
    it("X-PT-3 a draw_plus_bonus rule with no draw payout is uncovered ['draw'] on a HAND-BUILT reachable set holding win.so but NOT draw — the so→draw rule refuses it, not a reachable draw (PS-9g)", …);
    it("VB-PT-3 {'*':[3,0],'3-2':[2,1]} on bestOf 5 is uncovered ['set:3-0','set:3-1'] — '*' does not count when >1 distinct pair (RBS:566)", …);
    it("VB-PT-3 a flat {'*':[2,0]} always covers; the explicit FIVB map {3-0,3-1,3-2} covers bestOf 5", …);
    it("VB-PT-3 a bestOf 3 override on the FIVB bestOf-5 map is uncovered ['set:2-0','set:2-1'] (SPEC §5.4)", …);
    it("cricket: a rule with no tie is uncovered ['tie']; noResult falls back to 0 and is covered", …);
    it("an override that only removes outcomes (football extra time off) stays covered", …);
  });
  it("pointsRuleBounds over IIHF reachable outcomes is {min 0, max 3}; football draw_plus_bonus with so is {min 0, max 3}", …);
  it("legacyPointsRule({base:{win:3,draw:1,loss:0}}) pays a shoot-out win as a win (3/0), a tie 0, a no-result 0 (B1)", …);
  ```
  `points-w2d.property.test.ts` (fast-check, rule 10): **points conservation** — for random rules and random decided fixtures, Σ row points == Σ per-fixture payouts, a double walkover adds 0 (reports `checked > 0`); **payout symmetry** — swapping home/away swaps the pair.
- [ ] **Step 2: Run, expect FAIL** on the new assertions (old `PointsRule` rejects the new shape).
  `cd WT/packages/engine && rm -f "$TMPDIR/w2d-t2e.json" && pnpm exec vitest run src/competition/points-w2d.test.ts src/competition/points-w2d.property.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t2e.json"; echo EXIT=$?`
- [ ] **Step 3: Implement** the signatures in `points.ts` in SPEC §5.3's step order; port the readers listed under **Files** mechanically (old `base.win` → `win.regulation`, `base.draw` → `draw`, `base.loss` → `loss.regulation`; a stored old shape is read through `legacyPointsRule`). `decidedIn` at the two web call sites comes from `decidedInFor(sportModule, outcome)`.
- [ ] **Step 4: Run, expect PASS**; then the regression set (exact files; judge `files` = 4 engine, 5 web):
  `cd WT/packages/engine && pnpm exec vitest run src/competition/points.test.ts src/competition/points-w2c.test.ts src/competition/w2b-tables.test.ts src/competition/tiebreak-rule-award-alias.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t2r.json"; echo EXIT=$?`
  `cd WT/apps/web && pnpm exec vitest run src/server/public-site/__tests__/qualification-view.test.ts src/components/v2/stage-rules/__tests__/stage-points-model.test.ts src/components/v2/stage-rules/__tests__/stage-points-section.test.tsx src/components/v2/stage-rules/__tests__/stage-row-model.test.ts src/components/v2/stage-rules/__tests__/stage-rule-fields.test.tsx --reporter=json --outputFile="$TMPDIR/w2d-t2w.json"; echo EXIT=$?`
  All three tscs (web, engine, scripts + tools); eslint on changed files; `cd WT && pnpm openapi:gen && git status --porcelain openapi/` shows only the `PointsRule` diff, committed with the task.
- [ ] **Step 5: Mutate** `MUT/t2.json`: (a) the `draw_plus_bonus` branch books won/lost instead of drawn → killed by FB-PT-1; (b) `soBonus ?? 1` → `?? 0` → killed by "soBonus absent"; (c) `'*'` counted toward explicit coverage → killed by VB-PT-3; (d) `loss.unplayed` ignored → killed by X-WO-1. Plus changed-lines Stryker on `points.ts`.
- [ ] **Step 6: Commit** `feat(engine): outcome-keyed PointsRule, payout and coverage (W2d T2)`.

Test types: unit + property; e2e → Task 16 `stage-tiebreaks-w2d.spec.ts` "points rows are exactly the reachable outcomes"; smoke → Task 14; regression above. Sequence: undecided → decided → second recompute (same points) → void → another sport (cricket tie).

---

### Task 3: Engine — each sport's `tablePointsRule`, `soBonus`, and the parity sweep (wave 1, after Task 4)

SPEC §5.3 "The sport's default, as a rule" (the `shootoutWin/shootoutLoss` removal, greenfield, no alias), §5.10 points column, §11.2, D6, D10(a)(c), B2. Rule rows FB-PT-1, HK-PT-1, HK-PT-2, IH-PT-1, IH-PT-2, BG-PT-1, CK-PT-1, CK-PT-2, VB-PT-1, VB-PT-2, TT-PT-1.

**This task owns W2d's one golden exception (PS-1, Global Constraints).** Removing the zod keys is a tsc error in two `standingsDelta` payers and their bounds, and the football, hockey and ice hockey corpora carry `shootoutWin` in a recorded config, so the fold output moves. The removal stands (SPEC §5.3); the SO rows are already SIGNED in the parity list below, so the parity oracle is unaffected.

**Files:**
- Modify: `E/sport/module.ts` (`tablePointsRule(cfg: Cfg, stageKind: StageKind): PointsRule` on `SportModule`).
- Modify: every module/kernel listed in Task 1 (one `tablePointsRule` each). `E/sports/football/football.ts:131-132` and `E/sports/period/kernel.ts:221-222` (+ the `PeriodCfg.points` type `:98-106`): `shootoutWin`/`shootoutLoss` → `soBonus: z.number().int().nonnegative().optional()`; `hockey.ts:146` `fih-shootout` preset → `{win 3, draw 1, loss 0, soBonus 1}`. Their `*.schema.json` via `pnpm --filter @onryde/seazn-engine schema:snapshot`.
- Modify, **the shoot-out branch ONLY** (the one `standingsDelta` exception, PS-1) — each stops reading the deleted keys and nothing else changes: football `standingsDelta` win case `football.ts:2780-2786` (a shoot-out win pays `points.win`/`points.loss`, as when the split was unset), `declaredPointsSets :2842-2848`, `matchPointsBounds :2850-2857`; period kernel `winPoints :1537-1548` (its `"shootout"` branch reads `otWin ?? win`, `otLoss ?? loss`), `declaredPointsSets :2833-2847`, `matchPointsBounds :2849-2857`.
- Modify: `E/sports/setbased/volleyball.ts:11,38` — FIVB map explicit `{"3-0":[3,0],"3-1":[3,0],"3-2":[2,1]}`; best-of-3 `{"2-0":[3,0],"2-1":[2,1]}` (D10(a)); beach `{"*":[2,0]}` unchanged. `tabletennis.ts:30` → TT rule 2/1/0 with `loss.unplayed: 0` (D6).
- Modify (web half of the removal, PS-1c; no task owned it): `W/lib/match-rules/football.ts:32-39,118-144` (the `shootoutWin`/`shootoutLoss` override builder and the two fields; `soBonus` is NOT added here — the stage Points section owns it, Task 15+16); `W/components/v2/division-settings.tsx:361` and `W/components/v2/division-format-patch.ts:39` (comments naming the pair); `W/lib/rule-errors.ts:118-119` (`POINTS_SPLIT_LABEL_KEYS` loses both rows); `rules.err.pointsSplit.shootoutWin`/`shootoutLoss` leave `W/dictionaries/{en,es,fr,nl}/ui.json`, then `pnpm i18n:gen-keys` (`W/lib/i18n-keys.ts`) and `pnpm i18n:check`.
- Modify (tests pinning the old keys; greenfield — each rewritten or deleted and named in the report): engine `E/competition/points-w2c.test.ts:450`, `E/sport/match-points-bounds.test.ts:92-130`, `E/sport/rule-keys.test.ts:124,139`, `E/sports/football/football.test.ts:138-164,458`, `E/testkit/golden-compare.test.ts:60`; web `W/components/v2/__tests__/{match-rules,division-format-patch}.test.ts`, `W/components/v2/__tests__/division-settings-standings-points.test.tsx`, `W/lib/match-rules/__tests__/{football.contract,joint-builders}.test.ts`, `W/lib/__tests__/{match-rules-best-of-one,rule-scope,rule-errors-copy}.test.ts`, `W/server/usecases/__tests__/{stage-points,stage-rules,stage-rules-every-sport}.test.ts` (the full census is `git grep -n -a -E "shootoutWin|shootoutLoss" -- packages/engine/src apps/web/src`, re-run in Step 4: only `soBonus`-era hits and the corpora's recorded configs may remain). `E/testkit/golden.ts:82,1073` (the recording configs) change only if the re-baseline requires it, and the report says why.
- Modify: `E/sports/{football,hockey,icehockey}/*.golden.json` — **only** through Step 7's isolated `REBASELINE_GOLDEN=1` commit; `E/sport/fold-epoch.ts` — Step 8's MAJOR bumps football 2 → 3, hockey 2 → 3, and ice hockey 1 → 2 if its corpus moved (from PF-14's values; Task 18 then takes hockey 3 → 4).
- Test: `E/competition/table-points-parity.test.ts` (new).
- Create: `MUT/t3.json`.

**Interfaces:**
- Consumes: Task 2's `PointsRule`, `payout`, `reachableOutcomes`, `coverage`, `legacyPointsRule`.
- Produces: `module.tablePointsRule(cfg, stageKind)` for every module; `soBonus` cfg key (football, period kernel).

**Values (SPEC §5.10, exactly):** football W3 D1 L0, SO draw + `soBonus` 1, `draw_plus_bonus`; hockey 3/1/0 with draws, Pro League preset = draw 1 + `soBonus` 1 (2/1), `winsCount` regulation; ice hockey IIHF `win {regulation 3, ot 2}`, `loss {regulation 0, ot 1}` (GWS falls back to OT), recreational 2/1/0 with draws; chess `{win 2, draw 1, loss 0}` `unit:"half"`; cricket W2, tie 1, NR 1, L0, draw 1 only when `inningsPerSide === 2`; volleyball maps above; badminton `{"*":[2,0]}`; table tennis W2, played L1, unplayed L0; tennis 2/0; carrom 2/1/0; generic 3/1/0 from `w/d/l`.

- [ ] **Step 1: Write the failing test** `table-points-parity.test.ts`:
  ```ts
  // The parity oracle is the module's OWN standingsDelta (pre-W2d payer), untouched by W2d except its shoot-out branch (PS-1),
  // whose every row (football/hockey win.so, loss.so) is SIGNED below; the signed deltas are an allowlist.
  const SIGNED: ReadonlyArray<{ sport: string; variant?: string; outcome: OutcomeKey; why: string }> = [
    { sport: "tabletennis", outcome: "loss.regulation", why: "D6 TT 2/1/0" },
    { sport: "volleyball", outcome: "set:2-1", why: "D10(a) best of 3" },
    { sport: "volleyball", outcome: "set:2-0", why: "D10(a) best of 3" },
    { sport: "cricket", outcome: "draw", why: "D10(c) two-innings draw default 1" },
    { sport: "football", outcome: "win.so", why: "B2 draw plus bonus" }, { sport: "football", outcome: "loss.so", why: "B2" },
    { sport: "hockey", outcome: "win.so", why: "B2" }, { sport: "hockey", outcome: "loss.so", why: "B2" },
  ];
  it("X-PT-2 tablePointsRule pays exactly what standingsDelta paid, every sport × variant × reachable outcome, except SIGNED (counted)", () => {
    // for each forEachSport module, each variant preset ∪ {}, each table stage kind, each OutcomeKey in reachableOutcomes:
    //   build the outcome + a real delta pair from module.standingsDelta, compare payout(tablePointsRule) points to delta points.
    // Report checked, skippedAsSigned; expect(checked).toBeGreaterThan(0); every SIGNED row must be MET at least once AND
    // must actually differ (a SIGNED row whose payout equals the old one fails: the allowlist cannot hide a non-change).
    // TT's unplayed loss is NOT signed: it paid 0 before and pays 0 now, so parity asserts it.
  });
  it("X-PT-3 every module's tablePointsRule covers its own reachableOutcomes (counted)", …);
  it("FB-PT-1 football group with shootout: the SO winner gets 2, the loser 1, both drawn (RB2B-7)", …);
  it("HK-PT-2 the fih-shootout preset pays 2/1 for a shoot-out and books D; the default hockey variant reaches no `so` and pays 3/1/0 (D10(f))", …);
  it("IH-PT-1 IIHF 3/2/1/0 for OT and GWS; IH-PT-2 recreational 2/1/0 with draws", …);
  it("TT-PT-1 2/1/0 with an unplayed loss paying 0", …);
  it("VB-PT-1 VB-PT-2 FIVB best of 5 and the best-of-3 map exactly as SPEC §5.3", …);
  it("BG-PT-1 chess default is 2/1/0 in half-points (unit 'half')", …);
  it("CK-PT-2 the two-innings draw appears only when inningsPerSide === 2", …);
  it("soBonus is the only shoot-out key: football and period configSchema STRIP shootoutWin/shootoutLoss (z.object, `kernel.ts:214`, `football.ts:124-133`) — a cfg parsed with them holds neither key (greenfield, no alias; PS-1b)", …);
  it("PS-1 a shoot-out win's standingsDelta reads no deleted key: football pays win/loss, the period kernel otWin ?? win (expected from the cfg's own win/otWin, never the split)", …);
  ```
- [ ] **Step 2: Run, expect FAIL.** `cd WT/packages/engine && rm -f "$TMPDIR/w2d-t3e.json" && pnpm exec vitest run src/competition/table-points-parity.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t3e.json"; echo EXIT=$?`
- [ ] **Step 3: Implement** `tablePointsRule` per module from its existing cfg keys (SPEC §5.3 examples), the cfg changes, the shoot-out-branch edits and the volleyball/TT maps; the web half of the removal and the tests that pinned the old keys; run `schema:snapshot`, `pnpm i18n:gen-keys`.
- [ ] **Step 4: Run, expect PASS** (the golden replay is expected RED here, on the football/hockey/ice hockey corpora only — Steps 7–8 settle it); regression, exact files (judge `files` = 10 engine, 13 web):
  `cd WT/packages/engine && pnpm exec vitest run src/sport/match-points-bounds.test.ts src/sport/supports-draws.test.ts src/sport/rule-keys.test.ts src/sports/football/football.test.ts src/sports/period/period.test.ts src/sports/period/shootout.test.ts src/competition/points-w2c.test.ts src/testkit/golden-compare.test.ts src/testkit/conformance.test.ts src/testkit/for-each-sport.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t3r.json"; echo EXIT=$?`
  `cd WT/apps/web && pnpm exec vitest run src/components/v2/__tests__/match-rules.test.ts src/components/v2/__tests__/division-format-patch.test.ts src/components/v2/__tests__/division-settings-standings-points.test.tsx src/lib/match-rules/__tests__/football.contract.test.ts src/lib/match-rules/__tests__/joint-builders.test.ts src/lib/__tests__/match-rules-best-of-one.test.ts src/lib/__tests__/rule-scope.test.ts src/lib/__tests__/rule-errors-copy.test.ts src/server/usecases/__tests__/stage-points.test.ts src/server/usecases/__tests__/stage-rules.test.ts src/server/usecases/__tests__/stage-rules-every-sport.test.ts src/components/v2/stage-rules/__tests__/stage-points-model.test.ts src/components/v2/stage-rules/__tests__/stage-points-section.test.tsx --reporter=json --outputFile="$TMPDIR/w2d-t3w.json"; echo EXIT=$?` (DB suites: pending 0)
  All three tscs; eslint; `pnpm i18n:check`; the `shootoutWin|shootoutLoss` census above.
- [ ] **Step 5: Mutate** `MUT/t3.json`: hockey `shootoutAs` → `"result"` (killed by HK-PT-2's D booking); TT `unplayed: 0` → `1` (killed by TT-PT-1); volleyball best-of-3 `2-1` → `[3,0]` (killed by VB-PT-2). Changed-lines Stryker on the module lines W2d added.
- [ ] **Step 6: Commit the code** `feat(engine): every sport's table points as a rule; soBonus replaces shootoutWin/Loss (W2d T3)` — everything except the corpora and `fold-epoch.ts`, so the tree is clean for Step 7.
- [ ] **Step 7: The isolated re-baseline (GOLDEN-POLICY "The write modes", "What the harness enforces" 1–3).** With a clean tree: `cd WT/packages/engine && REBASELINE_GOLDEN=1 pnpm exec vitest run src/testkit/golden.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t3-rebase.json"; echo EXIT=$?`. Review it as a state diff FROM THE BYTES (the `rtk` wrapper swallows the printout): for each written corpus, diff against `git show HEAD:<path>` and confirm, per stream, that `events`, `lineups` and `configs` are byte-identical and which of `states`/`summary`/`outcome`/`deltas` moved; the moved keys must be the shoot-out points' (no `cards`, no clock). Only `E/sports/{football,hockey,icehockey}/*.golden.json` may change. Commit the corpora ALONE: `test(engine): re-baseline football/hockey/icehockey goldens for the soBonus removal (W2d T3, PS-1)`. **Guard:** if the plain golden replay is still red on the recorded `cfg.points.shootoutWin` after the re-baseline (the re-baseline splices each RECORDED config back into its states, `keepRecordedConfig` `golden.ts:1382`; GOLDEN-POLICY.md:331-344), STOP and report to the orchestrator — never hand-edit a corpus, never `UPDATE_GOLDEN`.
- [ ] **Step 8: The MAJOR bumps, next commit.** `E/sport/fold-epoch.ts`: football 2 → 3, hockey 2 → 3, ice hockey 1 → 2 only if its corpus moved in Step 7; the header comment says why (an older phone keeps paying the deleted split). Then `cd WT/packages/engine && pnpm exec vitest run src/testkit/golden.test.ts src/testkit/golden-policy.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t3g.json"; echo EXIT=$?` green, and `cd WT && pnpm --filter @onryde/seazn-engine fold-epoch:check --against "$TASK_BASE"; echo EXIT=$?` → `EXIT=0`, the raised sports listed, `changed 0` for every other sport. Commit `chore(engine): FOLD_EPOCH majors for the soBonus removal (W2d T3, PS-1)`.

Test types: unit (parity sweep = SPEC §13.4 parity leg); e2e → Task 19 walkthroughs read the points; smoke → Task 14; regression above (+ the golden replay after Step 8). Sequence: default variant → each preset → stage-kind change (league vs group) → another sport.

---

### Task 4: Engine — the new tie-break keys, the h2h modifiers, and no silent skip (wave 1, after Task 2)

SPEC §5.6 (table), §2.3 anti-goal 2, P9, P20, B4, B5, OC3. Rule rows BD-TB-1, TT-TB-1, TN-TB-1, IH-TB-1, FB-TB-2, HK-TB-1, HK-TB-2, VB-TB-2, BG-TB-1, BG-TB-3.

**Files:**
- Modify: `E/sport/module.ts:46` — `TiebreakerKey` gains `set_diff`, `point_diff`, `h2h_two`, `h2h_wins`, `h2h_set_ratio`, `h2h_point_ratio`, `h2h_reapply`, `h2h_exclusion`, `matches_played`, `field_goals`. (The web's hand-typed `TiebreakerKeyS`, `schemas.ts:325`, follows in Task 10, PS-2c.)
- Modify: `E/competition/tiebreakers.ts` — `COMPARATORS :332` (new comparators), `H2H_KEYS :368` / `h2hToPlain :376` (h2h_wins, h2h_set_ratio, h2h_point_ratio), `h2hBlock :414` (re-application and exclusion as block modifiers; `h2hRecursive` deleted from `RankContext`), `h2h_two` handler, `wins` honours `RankContext.winsCount`, `sberger`/`direct` on a non-Swiss stage from pool results with GAME points (B5), and `:529-537` throws `CONFIG_INVALID` instead of skipping.
- Modify: `E/competition/stage.ts:72,243` (drop `h2hRecursive`).
- Modify: `E/competition/cascade.test.ts` — the only test that uses `h2hRecursive` (`git grep -l -a h2hRecursive`: it, `stage.ts`, `tiebreakers.ts`); its cases move to `h2h_reapply` in the cascade, each named (PS-9d).
- Test: `E/competition/tiebreak-keys-w2d.test.ts`, `E/competition/tiebreak-properties.test.ts` (fast-check).
- Create: `MUT/t4.json`.
- Do NOT touch: `buildSwissTable`'s Swiss arithmetic (W3; P12).

**Interfaces:**
- Consumes: `StandingsRow`, `RankContext`, `FixtureResult`.
- Produces (on `RankContext`, replacing `h2hRecursive`):
  ```ts
  winsCount?: "all" | "regulation";              // from the module (Task 1)
  gamePoints?: (r: FixtureResult) => readonly [number, number]; // B5: chess SB/direct read 1/½/0 (as half-points 2/1/0) whatever the table paid
  ```
  and the comparators for every ✚ key in SPEC §5.6.

**Algorithms the signature does not determine:**
```text
h2hBlock(class, blockKeys, modifier, ctx):
  mini = fixtures among class members only (both legs in a double round robin aggregate: B4)
  sub = refine(class, blockKeys mapped through h2hToPlain, over mini)
  modifier "h2h_reapply" (UEFA 20.01(d), IIHF): after the WHOLE block, for each sub-group S with 1 < |S| < |class|:
      re-run h2hBlock(S, blockKeys, "h2h_reapply") on fixtures among S only; repeat until no group shrinks (terminates:
      |S| strictly decreases); a group the block cannot split falls through to the next cascade key.
  modifier "h2h_exclusion" (ITTF 3.7.5.3): walk blockKeys in order; the FIRST key that splits the class stops the walk;
      each resulting sub-group S with |S| > 1 restarts the block from blockKeys[0] on fixtures among S only.
  no modifier (FIFA fall-through): one pass, residual groups fall to the next cascade key.
h2h_two(class): if |class| !== 2 or the two never met (or are level on the points of their mini-table) → no split, mark
  tieBreak note "h2h_two_not_applicable"; else order by mini-table points over all their meetings.
field_goals(row) = gf − goals_pc − goals_stroke (own goals count, B3); missing metrics read as 0.
```

- [ ] **Step 1: Write the failing tests.** `tiebreak-keys-w2d.test.ts` — expected orders typed from the federation text in each title:
  ```ts
  it("BD-TB-1 BWF 16.2.3: three level on wins are split by games DIFFERENCE where games RATIO would disagree (RBS:151-156)", …);
  it("BD-TB-1 OC3 h2h_two after set_diff splits the remaining two by their meeting; on a class of 3 it does not split", …);
  it("TT-TB-1 ITTF 3.7.5.3 exclusion: restarting on the remaining two reverses the 3-way ratio order (RBS:228)", …);
  it("FB-TB-2 UEFA re-application: a 4-way h2h tie reduced to 2 is re-applied among the 2 only (RBG:108-110)", …);
  it("IH-TB-1 IIHF re-application down to 2 (RBG:345-346); re-application with no progress terminates", …);
  it("TN-TB-1 ATP C.3-2 matches_played: a 2-1 record ranks above 2-0", …);
  it("HK-TB-1 FIH: more wins above better GD (RBG:236); wins counts regulation wins only under winsCount 'regulation' (B2)", …);
  it("HK-TB-2 field_goals = gf − goals_pc − goals_stroke; an own goal counts; a corner and a stroke do not (B3)", …);
  it("VB-TB-2 a double round robin h2h aggregates both legs where the last match alone would order them the other way (B4)", …);
  it("BG-TB-1 BG-TB-3 round robin: SB from GAME points decides where SB from 3/1/0 table points would not (B5, FIDE C.07)", …);
  it("h2h_wins, h2h_set_ratio, h2h_point_ratio read the mini-table only, never overall rows", …);
  it("anti-goal 2: a cascade key with no comparator throws CONFIG_INVALID (was a silent skip, tiebreakers.ts:529-537)", …);
  it("edge: one entrant; all level down to the last key; 2-, 3- and 4-way ties; h2h_two on two who never met; exclusion after the first split; a stage with pools", …);
  it("edge: a double walkover is out of every ratio (X-DW-4); a void then the table again; a second rank call is identical", …);
  ```
  `tiebreak-properties.test.ts` (rule 10; each reports `checked`): **permutation invariance** (shuffling row and fixture order gives the same ranking, given the same lots map — Task 5 adds the map; here residuals compare by id); **appending a key never reorders entrants the prefix already separated**; **re-application terminates** (random classes, bounded steps).
- [ ] **Step 2: Run, expect FAIL.** `cd WT/packages/engine && rm -f "$TMPDIR/w2d-t4e.json" && pnpm exec vitest run src/competition/tiebreak-keys-w2d.test.ts src/competition/tiebreak-properties.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t4e.json"; echo EXIT=$?`
- [ ] **Step 3: Implement** the comparators and the block per the algorithm above.
- [ ] **Step 4: Run, expect PASS**; regression `pnpm exec vitest run src/competition/tiebreakers.test.ts src/competition/stage.test.ts src/competition/cascade.test.ts` (judged, `files` = 3; the `h2hRecursive` cases in `cascade.test.ts` become `h2h_reapply` in the cascade, each named). tsc, eslint.
- [ ] **Step 5: Mutate** `MUT/t4.json`: exclusion restarts from the current key instead of `blockKeys[0]` (killed by TT-TB-1); `h2h_two` splits a class of 3 (killed by BD-TB-1 OC3 case); the no-comparator `throw` → `continue` (killed by anti-goal 2); `field_goals` subtracts `goals_og` (killed by HK-TB-2). Stryker changed lines.
- [ ] **Step 6: Commit** `feat(engine): BWF/ITTF/ATP/FIH/IIHF tie-break keys and h2h modifiers (W2d T4)`.

Test types: unit + property (SPEC §13.2, §13.3); e2e → Task 19 per family; smoke → Task 14; regression above. Sequence: empty class → split → second call identical → after a void → another sport.

---

### Task 5: Engine — the stored lots draw and the empty table (wave 1, after Task 3)

SPEC §5.8, §2.3 anti-goal 3, P21, ruling 70, D5, D7 (ST-G13). Rule rows X-TB-4, X-TB-6.

**Files:**
- Modify: `E/competition/tiebreakers.ts` — `RankContext` gains `lotsDraws`; `RankingResult` gains `newLotsDraws`, row flag `level`; `lotSeed :547` unchanged; the `lots` step per the algorithm; the no-`lots` seed → id fallback (`:599-607`) stays.
- Modify: `E/competition/stage.ts` — `DivisionEvent` `rank_lock` gains `order: EntrantId[]` and `drawnAt: string`, both read from the stored draw in `lotsDraws` (the pure engine has no clock; a new draw's date is the DB's, Task 9 — PS-5b); `completeTableStage` passes `lotsDraws`, returns `newLotsDraws`.
- Test: `E/competition/lots-stored.test.ts` (new), and properties added to `tiebreak-properties.test.ts`.
- Create: `MUT/t5.json`.

**Interfaces:**
- Produces:
  ```ts
  export type MembersKey = string; // sorted entrant ids joined with ","
  export function membersKeyOf(ids: readonly EntrantId[]): MembersKey;
  // RankContext — the value carries the stored draw's date (PS-5b): `drawnAt` is the DB's `stage_lots_draws.drawn_at`
  export interface StoredLotsDraw { readonly order: readonly EntrantId[]; readonly drawnAt: string }
  lotsDraws?: ReadonlyMap<MembersKey, StoredLotsDraw>;
  countedFixtures?: number; // 0 ⇒ empty table
  // RankingResult
  newLotsDraws: ReadonlyArray<{ membersKey: MembersKey; members: readonly EntrantId[]; drawnOrder: readonly EntrantId[]; seed: number }>;
  // StandingsRow
  level?: boolean; // true for every row of an empty table
  ```

**The `lots` step (SPEC §5.8 order, empty case first):**
```text
if countedFixtures === 0: order every class by seed then id, mark level=true on every row, store nothing, return.
for each residual class C at `lots`:
  k = membersKeyOf(C)
  if lotsDraws.has(k): order C by lotsDraws.get(k).order.
  else: seed = lotSeed(rngSeed, sorted ids of C); order = shuffle(C, seed); push {k, members, order, seed} to newLotsDraws.
```

- [ ] **Step 1: Write the failing tests** `lots-stored.test.ts`:
  ```ts
  it("X-TB-6 an empty table (0 counted fixtures): every row level, no leader, newLotsDraws empty (RBG:31-33)", …);
  it("X-TB-4 a residual class with no stored draw is drawn with the seeded shuffle and returned in newLotsDraws", …);
  it("X-TB-4 the same class with its stored draw uses it even when rngSeed changes (stored beats re-hash)", …);
  it("Review Focus 2: a changed tied set (one member withdrew) draws again; the old key is not applied to the new membership", …);
  it("X-TB-4 completeTableStage's rank_lock carries `order` and `drawnAt` read from the stored draw in lotsDraws — the engine invents no date (PS-5b)", …);
  it("a second recompute with the returned draws stored yields an identical order and no new draws", …);
  ```
  Properties (rule 10): **lots reload stability** — rank, persist `newLotsDraws`, rank again → identical, `newLotsDraws` empty; an unrelated result that leaves the tied set the same keeps the draw; **permutation invariance** now with the lots map.
- [ ] **Step 2: Run, expect FAIL.** `cd WT/packages/engine && rm -f "$TMPDIR/w2d-t5e.json" && pnpm exec vitest run src/competition/lots-stored.test.ts src/competition/tiebreak-properties.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t5e.json"; echo EXIT=$?`
- [ ] **Step 3: Implement** per the algorithm.
- [ ] **Step 4: Run, expect PASS**; regression `src/competition/stage.test.ts src/testkit/simulation.test.ts` (judged, `files` = 2). tsc, eslint.
- [ ] **Step 5: Mutate** `MUT/t5.json`: drop the empty-table branch (killed by X-TB-6); look up by unsorted ids (killed by the stability property); ignore a stored draw (killed by "stored beats re-hash"). Stryker changed lines.
- [ ] **Step 6: Commit** `feat(engine): stored, seeded lots draw and the level empty table (W2d T5)`.

Test types: unit + property; e2e → Task 17 `standings-popovers.spec.ts` "Drawn by lots on {date}"; smoke → Task 14 (reload twice, same order); regression above. Sequence: empty → first draw → reload → changed membership → another sport.

---

### Task 6: Engine — `validateCascade` and `primaryTableKey` (wave 1, after Task 5)

SPEC §5.5, D3, D8, D10(d), D11, OC1, OC3. Rule rows X-TB-3, X-TB-5, X-TB-7 (refusal half), FB-TB-4.

**Files:**
- Create: `E/competition/cascade-rules.ts` (planner's call: the validator leaves the ranker file; W2d owns every mutant in it, §20); export from `E/competition/index.ts`.
- Modify: `E/competition/tiebreakers.ts:638-695` — the old `validateCascade` is deleted (no production caller, P4); its callers in tests move.
- Modify: `E/sport/module.ts` — `primaryTableKey: "points" | "wins"`; each module declares it (`wins` for volleyball, badminton, tennis).
- Test: `E/competition/cascade-rules.test.ts` (new).
- Create: `MUT/t6.json`.

**Interfaces:**
- Produces:
  ```ts
  export type CascadeRefusalReason =
    | "empty" | "duplicate" | "first" | "last" | "sport" | "stage_format" | "cross_group" | "fair_play_off" | "position";
  export interface CascadeRefusal { readonly index: number; readonly key: TiebreakerKey | null; readonly reason: CascadeRefusalReason; readonly need?: string }
  export interface CascadeContext { readonly module: AnySportModule; readonly cfg: unknown; readonly stageKind: StageKind; readonly crossGroup: boolean }
  export function validateCascade(cascade: readonly TiebreakerKey[], ctx: CascadeContext): readonly CascadeRefusal[]; // [] = valid
  export function offerableKeys(cascade: readonly TiebreakerKey[], position: number, ctx: CascadeContext): readonly TiebreakerKey[]; // "+ Add step" (§9)
  ```
  `offerableKeys(c, i, ctx)` is exactly the keys k for which `validateCascade(insert(c, i, k), ctx)` adds no refusal — the UI's complement test (Task 15) relies on that identity.

- [ ] **Step 1: Write the failing tests** `cascade-rules.test.ts` (SPEC §5.5 rules, empty case first; the expected reason derived from the module's declared metrics and `primaryTableKey`):
  ```ts
  it("X-TB-3 [] is refused {index:-1, key:null, reason:'empty'} on every stage kind including swiss", …);
  it("X-TB-3 OC3 h2h_two may appear twice; any other key twice is refused 'duplicate' at its second index", …);
  it("X-TB-3 a non-Swiss order must start with primaryTableKey: badminton ['points',…,'lots'] → 'first' (primary is wins)", …);
  it("X-TB-3 a non-Swiss order must end with exactly one lots: missing → 'last'", …);
  it("X-TB-3 OC1 a Swiss order not starting with the primary or not ending in lots is accepted; nrr in a badminton Swiss order is still refused 'sport'", …);
  it("X-TB-5 nrr outside cricket and board_ratio outside carrom → 'sport' (D10(d), counted over forEachSport)", …);
  it("X-TB-5 buchholz/buchholz_cut1 outside swiss → 'stage_format'; on any sport's swiss stage → accepted (RB2A-15)", …);
  it("X-TB-5 sberger and direct are accepted on a round-robin stage (SPEC §5.5 rule 3)", …);
  it("X-TB-7 crossGroup:true refuses every h2h key, h2h_two, direct and the modifiers → 'cross_group'", …);
  it("FB-TB-4 fair_play: football with fairPlay true accepted; fairPlay false → 'fair_play_off'; hockey → 'sport' (D8)", …);
  it("h2h_reapply/h2h_exclusion not directly after an h2h block, or two in one block → 'position'", …);
  it("field_goals needs hockey's gf/goals_pc/goals_stroke; refused 'sport' in football", …);
  it("every refusal is returned, not just the first (an order with three faults returns three)", …);
  it("offerableKeys complement: every key it hides is refused at that position and every key it offers is accepted (forEachSport × stage kind, counted)", …);
  ```
- [ ] **Step 2: Run, expect FAIL.** `cd WT/packages/engine && rm -f "$TMPDIR/w2d-t6e.json" && pnpm exec vitest run src/competition/cascade-rules.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t6e.json"; echo EXIT=$?`
- [ ] **Step 3: Implement** the six rules in SPEC §5.5's order.
- [ ] **Step 4: Run, expect PASS**; regression: the old `validateCascade` callers, moved to the new signature (PS-9d): `pnpm exec vitest run src/competition/cascade.test.ts src/competition/tiebreakers.gaps.test.ts src/sports/period/period.test.ts src/sports/period/period-audit.test.ts` (judged, `files` = 4). tsc, eslint.
- [ ] **Step 5: Mutate** `MUT/t6.json` (SPEC §13 "mutate the guard once"): delete the first/last check (killed by "must start with"); make the Swiss exemption apply to every kind (killed by the non-Swiss 'first' case); allow every duplicate (killed by OC3's second half); skip the fair-play cfg check (FB-TB-4); skip the cross-group refusal (X-TB-7). Stryker on `cascade-rules.ts`.
- [ ] **Step 6: Commit** `feat(engine): validateCascade returns every refusal; primaryTableKey (W2d T6)`.

Test types: unit; e2e → Task 15 "an invalid step shows its reason inline"; smoke → Task 13 ("an invalid order is refused by name"); regression above. Sequence: empty → valid → one fault → three faults → another sport.

**Wave 1 close:** whole-wave review; orchestrator gate = Steps 4 of Tasks 1–6 (Task 3's golden replay after its Step 8); proof commit for X-PT-2/3/4, X-WO-1, X-DW-4, X-TB-3/4/5/6, the sport PT/TB rows above; walkthrough: none (engine only) — the orchestrator instead runs `pnpm --filter @onryde/seazn-engine fold-epoch:check --against <wave-start>` and records the MAJORs Task 3 raised (football 2 → 3, hockey 2 → 3, ice hockey 1 → 2 if its corpus moved) and that no other sport's corpus moved.

---

### Task 7: Migration — pin columns, `stage_lots_draws`, the B1 pin function, the view (wave 2, first)

SPEC §8, §5.4 "Migration pin (B1)", B1, P18/P18a, plan finding PF-3 (`public_stages_v`). Rule row X-TB-2 (migration half).

**Files:**
- Create: `db/migration/deltas/V<n>__w2d_table_rules.sql` (`<n>` from Task 0). Load `supabase:supabase-postgres-best-practices` before writing it.
- Create: `scripts/w2d/pin-scenario.ts` — `seed` and `read` modes over API v1 only (endpoints that exist at `W2D_BASE`: create division/stages, generate, `POST /fixtures/{id}/events`, `GET /stages/{id}/standings`), deterministic names.
- Create: `apps/web/src/server/engine-db/__tests__/fixtures/w2d-pin-before.json` — the `read` output at `W2D_BASE` (Step 1), recording every stage, pool, entrant and fixture UUID and each stage's `rngSeed` beside the tables (PS-8b: row order depends on ids through the seed → id fallback and `lotSeed(rngSeed, ids)`).
- Create: `apps/web/src/server/engine-db/__tests__/fixtures/w2d-pin-seed.ts` — **the seeding twin** (PS-8a): a vitest seeder that inserts the scenario's divisions, stages, pools, entrants, fixtures and events with exactly the UUIDs and `rngSeed` recorded in `w2d-pin-before.json`, so Task 9's §13.8 identity re-seeds the same ids.
- Test: `apps/web/src/server/engine-db/__tests__/w2d-migration-pin.test.ts` (DB).
- Create: `MUT/t7.json`.

**Interfaces:**
- Consumes: Task 2 `PointsRule`, `legacyPointsRule`.
- Produces (SQL, all in the delta):
  - `stages.table_rules_pinned jsonb null`, `stages.table_rules_pinned_at timestamptz null`, check `(table_rules_pinned is null) = (table_rules_pinned_at is null)`.
  - `stage_lots_draws (id uuid pk default gen_random_uuid(), stage_id uuid not null references stages on delete cascade, pool_id uuid null, members_key text not null, members uuid[] not null, drawn_order uuid[] not null, seed bigint not null, drawn_at timestamptz not null default now(), superseded_at timestamptz null)`; unique index on `(stage_id, coalesce(pool_id, '00000000-0000-0000-0000-000000000000'::uuid), members_key) where superseded_at is null`; RLS and grants copied from the sibling stage tables' policy shape.
  - `w2d_legacy_points(old jsonb) returns jsonb` — the SQL twin of `legacyPointsRule`.
  - `w2d_pre_points(sport text, cfg jsonb) returns jsonb` — the points each sport paid before W2d, as a new-shape rule (mapping below).
  - `w2d_pre_cascade(sport text) returns jsonb` — each sport's pre-W2d `defaultTiebreakers` as literals (Anchors row; re-read at `W2D_BASE`).
  - `w2d_pin_started_stages() returns integer` — pins every stage with `status in ('active','complete') and table_rules_pinned is null` to `{points, tiebreakers, crossGroup: ["points","diff","for","wins"], sources: {points:"migrated", tiebreakers:"migrated"}}`, returns the count. Idempotent.
  - The data steps, in order: convert every stage's old-shape `config.points` (`config.points ? 'base'`) through `w2d_legacy_points`; for football and hockey divisions, `soBonus = shootoutWin − draw` and drop `shootoutWin/shootoutLoss`; for ice hockey divisions, drop `shootoutWin/shootoutLoss` (the period kernel's schema no longer has them, Task 3; GWS falls back to OT, SPEC §5.3 — PS-1d); `select w2d_pin_started_stages()` (which reads the pre-W2d payer from `w2d_pre_points`, so a started stage keeps its split).
  - `public_stages_v.points_rule` redefined to `coalesce(s.table_rules_pinned -> 'points', <the new-shape rebuild of config.points>)` (PF-3: the view rebuilt the OLD keys `base/bonuses/forfeit`, `V414__public_stages_qualification.sql:57-66,154-157`).

**`w2d_pre_points` mapping (pre-W2d payer; every default coalesced from the module schema at `W2D_BASE`, re-read by the builder):**

| sport | rule |
|---|---|
| football | `win.regulation = points.win (3)`, `draw = points.draw (1)`, `loss.regulation = points.loss (0)`; `win.so/loss.so = shootoutWin/shootoutLoss` only when BOTH are set, else `win.so/loss.so = win/loss` (pre-W2d football paid the split only with both keys, `football.ts:2781-2784` — PS-8d); `shootoutAs:"result"` |
| hockey, icehockey | `points.{win,draw,loss}`; `win.ot/loss.ot = otWin/otLoss`; `win.so = shootoutWin ?? otWin ?? win`, `loss.so = shootoutLoss ?? otLoss ?? loss`, per key (`kernel.ts:1540-1541`); `result` |
| cricket | `win 2, tie 1, noResult 1, loss 0`, `draw` when set |
| badminton, tabletennis, volleyball | `bySetScore = pointsMap` (TT `{"*":[2,0]}` — 2/0, not D6's 2/1/0) |
| tennis | `points.{win 2, loss 0}` |
| boardgame | `scoring.{win 2, draw 1, loss 0}`, `unit:"half"` |
| carrom | `{win 2, draw 1, loss 0}` |
| generic | `points.{w, d, l}` |
| every sport | the stage's own converted `config.points` wins over this when present; `tie`/`noResult` 0 unless the sport paid them; bonuses and forfeit kept |

The cascade is `divisions.tiebreakers` when set, else `w2d_pre_cascade(sport)`. **Plan finding PF-1:** the web resolver today reads `division.tiebreakers ?? module.defaultTiebreakers` for EVERY stage kind including Swiss (main@e97823e4d8 `competition.ts:492-494`), so the production Swiss badminton stage ranks by `points, wins, set_ratio, point_ratio, h2h_points` — the SPEC §8 "INFERRED" is confirmed by the code; the builder still reads the live row on staging (Step 6).

- [ ] **Step 1: Capture the pre-W2d snapshot** (expected values come from the pre-W2d CODE, never from W2d's): in a detached worktree at `W2D_BASE` with its own env label `w2d-base`, `pnpm db:apply && pnpm sync:sports`, start its prod server, copy in `scripts/w2d/pin-scenario.ts` (uncommitted there), run `seed` then `read`, and copy the JSON (tables, every UUID, each `rngSeed`) to `fixtures/w2d-pin-before.json`. The scenario seeds one active and one complete stage per family — football (with a played group shoot-out), hockey (Pro League preset with a shoot-out), ice hockey (an OT and a GWS), cricket (a tie and a no-result), volleyball (a 3-2), badminton **Swiss** (mirrors production), table tennis (a walkover), tennis, chess, carrom, generic — plus one stage with an old-shape `config.points`, and one pending stage. Each stage gets enough results to need two keys and one residual tie.
- [ ] **Step 2: Write the failing DB test** `w2d-migration-pin.test.ts`:
  ```ts
  it("B1 w2d_legacy_points equals legacyPointsRule for every old-shape sample (one authority, two languages; counted)", …);
  it("B1 w2d_pre_points(sport, cfg) equals the pre-W2d payer for every SEEDED variant in w2d-pin-before.json (counted; PS-8c)", …);
  //   expected: the points recorded in w2d-pin-before.json for that sport's stages, never W2d's tablePointsRule.
  //   The scenario seeds one variant per family; the title says so rather than claiming every preset.
  it("B1 PS-8d the equality above includes a one-key football sample: w2d_pre_points maps a cfg with only shootoutWin set to a plain win/loss shoot-out (as football.ts:2781-2784 paid), and both keys set to the split", …);
  it("B1 w2d_pin_started_stages pins active and complete stages only, returns the count, sources 'migrated'", …);
  it("B1 a second call pins nothing and changes nothing (idempotent)", …);
  it("B1 a pending stage is NOT pinned, and its old-shape config.points is converted in place", …);
  it("B1 football/hockey division cfg: shootoutWin 2 with draw 1 becomes soBonus 1 and the old keys are gone", …);
  it("PS-1d an ice hockey division cfg loses shootoutWin/shootoutLoss and keeps otWin/otLoss", …);
  it("PF-3 public_stages_v.points_rule returns the pin's points for a pinned stage and the new shape otherwise", …);
  it("a pin and its timestamp are both null or both set (check constraint)", …);
  ```
  (§13.8's table-order identity runs in Task 9, once the loader reads the pin.)
- [ ] **Step 3: Run, expect FAIL** (functions absent). `cd WT/apps/web && rm -f "$TMPDIR/w2d-t7.json" && pnpm exec vitest run src/server/engine-db/__tests__/w2d-migration-pin.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t7.json"; echo EXIT=$?` (DB pending count 0).
- [ ] **Step 4: Write the delta**; `$S rebuild --label w2d` (re-applies migrations on the label DB); run, expect PASS.
- [ ] **Step 5: Mutate** `MUT/t7.json`: the pin predicate `status in ('active','complete')` → `status = 'active'` (killed by the complete-stage case); `w2d_legacy_points` drops `tie: 0` → `null` (killed by the equality case).
- [ ] **Step 6: Staging check (orchestrator).** On staging, before merge: `select count(*) from stages where status in ('active','complete')` before, then after the migration `select count(*) from stages where table_rules_pinned is not null` — equal. Record both numbers in the PR body (owner fact: one Swiss badminton competition).
- [ ] **Step 7: Commit** `feat(db): W2d pin columns, stored lots table and the B1 pin of started stages (W2d T7)`.

Test types: unit (DB); e2e → Task 19 `tables-w2d.spec.ts` "pin: a started stage's public table does not move after the division default changes" (no UI of its own; the public table reads the same pin, PS-9e); smoke → Task 14 ("a pinned stage's table reads the pin"); regression `W/server/public-site/__tests__/qualification-view.test.ts` (the view change). Sequence: empty DB (count 0) → seeded → second call → pending stays live → another sport.

---

### Task 8: Engine — `resolveTableRules`, `defaultTiebreakers(kind, cfg)`, engine consumers (wave 2, after Task 7)

SPEC §5.4 "Resolution", §5.9 default cross-group, §6 E1/E3/E5/E6, P25. Rule row X-TB-1. (Review Focus 5 moved to Task 9, PS-5e.)

**Files:**
- Create: `E/competition/table-rules.ts`; export from `E/competition/index.ts`.
- Modify: `E/sport/module.ts:944` — `defaultTiebreakers(kind: TableStageKind, cfg: Cfg): TiebreakerKey[]` (`TableStageKind = "league" | "group" | "swiss" | "americano"`); every module returns TODAY's list for every kind and ignores `cfg` (values change in Task 11, where football's default reads `cfg.fairPlay`).
  **PS-7c, owner 2026-10-24 (Option 1):** the signature is `(kind, cfg)`, and the one caller that matters is `resolveTableRules`, which passes the stage's merged cfg (division cfg ⊕ `stage.rules`). Every other reader below passes the cfg it already holds. No UI file calls it (PS-7b; the editor reads `tableRules.tiebreakers.sportDefault`, Task 13).
- Modify: `E/competition/stage.ts` — `TableStage.cascade` → `TableStage.rules: TableRules`; `completeTableStage(stage, fixtures)` ranks with `rules.tiebreakers`, `lotsDraws`, `winsCount`, `gamePoints`.
- Modify: `E/competition/tie-what-if.ts:54` — the "primary" test reads `module.primaryTableKey` (P25).
- Modify: `E/testkit/simulation.ts:238,559,653`, `E/testkit/scenarios.ts`, `E/testkit/conformance.ts:110` — pass `resolveTableRules(...)` and a lots map; read `defaultTiebreakers(kind, cfg)`.
- Modify (every other `defaultTiebreakers` reader, ported to `defaultTiebreakers(<the stage's kind>, <the cfg it already holds>)` so all three tscs stay green; Task 9 then replaces the web ones with the loader — PS-3a): web `W/server/engine-db/competition.ts:492-494` (`cascadeFor` → `resolveTableRules` with `pinned: null`), `W/server/public-site/competition-hub.ts:920`, `W/server/slideshow-data.ts:71`, `W/app/embed/divisions/[id]/[widget]/page.tsx:72`, `W/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx:95`, `W/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:439`; bench (in scope, PS-3) `tools/bench/lib/validate-pack.ts:2367`, `tools/bench/packs/build-packs/_tiny.ts:784`; the 9 engine tests in the Anchors row (`git grep -l -a defaultTiebreakers -- 'packages/engine/**/*.test.ts'`).
- Test: `E/competition/table-rules.test.ts` (new); `E/competition/tie-what-if.test.ts` (one case).
- Create: `MUT/t8.json`.

**Interfaces:**
- Produces:
  ```ts
  export type TableRulesSource = "stage" | "division" | "sport" | "migrated";
  export interface TableRules { readonly points: PointsRule; readonly tiebreakers: readonly TiebreakerKey[]; readonly crossGroup: readonly TiebreakerKey[] }
  export interface TableRulesPin extends TableRules { readonly sources: { readonly points: TableRulesSource; readonly tiebreakers: TableRulesSource } }
  export interface TableRulesInput {
    readonly module: AnySportModule; readonly stageKind: TableStageKind; readonly mergedCfg: unknown; // division cfg ⊕ stage.rules (W2c)
    readonly stageOwn: { readonly points: PointsRule | null; readonly tiebreakers: readonly TiebreakerKey[] | null; readonly crossGroup: readonly TiebreakerKey[] | null };
    readonly divisionTiebreakers: readonly TiebreakerKey[] | null;
    readonly pinned: TableRulesPin | null;
  }
  export function resolveTableRules(input: TableRulesInput): TableRulesPin;
  /** §5.9: the stage's order with every head-to-head key and modifier removed. */
  export function defaultCrossGroup(tiebreakers: readonly TiebreakerKey[]): readonly TiebreakerKey[];
  ```
  `resolveTableRules` = `pinned ?? { points: stageOwn.points ?? module.tablePointsRule(mergedCfg, stageKind), tiebreakers: stageOwn.tiebreakers ?? divisionTiebreakers ?? module.defaultTiebreakers(stageKind, mergedCfg), crossGroup: stageOwn.crossGroup ?? defaultCrossGroup(<the tiebreakers>) }` with `sources` naming the winning layer.

- [ ] **Step 1: Write the failing tests** `table-rules.test.ts`:
  ```ts
  it("X-TB-1 own order beats the division's, which beats the sport default for the stage kind; sources say which (empty case: nothing set → sport)", …);
  it("X-TB-1 a pin beats every layer, including a stage own value saved after it (the web re-pins; the engine never merges)", …);
  it("the points layer: own rule → else tablePointsRule(division ⊕ stage.rules, kind) — a stage's best-of-3 rules change the sport rule it inherits (volleyball)", …);
  it("defaultCrossGroup removes h2h_*, h2h_two, direct and the modifiers, keeping order", …);
  it("completeTableStage ranks with rules.tiebreakers and returns newLotsDraws; h2hRecursive no longer exists on TableStage", …);
  it("defaultTiebreakers(kind, cfg) for every module × TableStageKind × the module's default cfg is non-empty and every key it returns has a comparator (anti-goal 2) — content, not totality, which tsc already enforces (forEachSport, counted; PS-9g)", …);
  it("PS-7c the sport layer is asked with the input's mergedCfg: a spy module's defaultTiebreakers receives exactly that object and the stage kind; it is not called when an own or division order wins", …);
  ```
  `tie-what-if.test.ts`: `it("P25 a wins-first volleyball order gets a what-if (primaryTableKey, not cascade[0]==='points')", …)`.
- [ ] **Step 2: Run, expect FAIL.** `cd WT/packages/engine && rm -f "$TMPDIR/w2d-t8e.json" && pnpm exec vitest run src/competition/table-rules.test.ts src/competition/tie-what-if.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t8e.json"; echo EXIT=$?`
- [ ] **Step 3: Implement**; port every reader listed under **Files** (the web build and the bench keep compiling; Task 9 replaces the web ports with the loader).
- [ ] **Step 4: Run, expect PASS**; regression `src/competition/stage.test.ts src/testkit/simulation.test.ts` plus the 9 ported engine tests (judged, `files` = 11); `fold-epoch:check --against HEAD^1`; all three tscs; eslint.
- [ ] **Step 5: Mutate** `MUT/t8.json`: swap the stage and division precedence (killed by X-TB-1); `defaultCrossGroup` keeps `h2h_two` (killed); `resolveTableRules` calls `defaultTiebreakers(stageKind, {})` instead of `mergedCfg` (killed by the PS-7c case).
- [ ] **Step 6: Commit** `feat(engine): one resolver for a stage's table rules (W2d T8)`.

Test types: unit; e2e → Task 15 (badges read `sources`); smoke → Task 14; regression above. Sequence: nothing set → division set → own set → pinned → another sport.

---

### Task 9: Web — one loader, the pin at activation, the six resolvers collapse, lots persisted (wave 2, after Task 8)

SPEC §5.4 "Pin at start", §5.8 persistence, §6 W1–W11, §2.3 anti-goal 1, OC2, B1 (§13.8), Review Focus 1, 2, 3 and 5. Rule rows X-TB-1, X-TB-2, X-TB-4.

**Files:**
- Create: `W/server/engine-db/table-rules.ts`.
- Modify: `W/server/usecases/stages.ts` — inside `generateStageFixturesWrite` (`:2436`; its status write `:2955`) and `generateProgressionSetupFixtures` (`:3476`; its status write `:3788`), `pinStageTableRules(tx, stageId)` in the same `if (stage.status === "pending")` block, after the status update. These two are the only `update stages set status = 'active'` in non-test `W/server` (`git grep -n -a "set status = 'active'" -- apps/web/src/server`, 2026-10-24).
- Modify: `W/server/engine-db/competition.ts`:
  - `cascadeFor`/`toTableStage` (`:492-504`) read `loadTableRules`.
  - The two payout sites (`:116` bye, `:432` decided fixture) pay `rules.points` through `payout`. When the row's `no_result` flag is set (`:346`) and its outcome is null, they hand `payout` the outcome `{kind:"no_result"}` (PS-5c; PF-10).
  - Every web rank call passes `winsCount: module.winsCount` and `gamePoints` (PS-5a; the HK-TB-1 and B5 cases are Task 14's).
  - `recomputeStandings`/`rankedStageStandings`/`completeStageIfReady` pass `lotsDraws` and `countedFixtures`. They persist `newLotsDraws` under the advisory lock they already hold, then RE-READ the stored rows, so `drawnAt` is the DB's `now()`, before ranking and before appending `rank_lock` (PS-5b). `rank_lock` carries the stored `order` and `drawnAt`.
- Modify: the other resolvers (SPEC §6 W2–W7; ported to `defaultTiebreakers(kind, cfg)` in Task 8, now replaced): `server/public-site/competition-hub.ts`, `server/slideshow-data.ts`, `app/embed/divisions/[id]/[widget]/page.tsx`, `app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx`, `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` (per-stage caption data only; the caption UI is Task 17), `server/public-site/{standings-view,division-qualification,qualification-view}.ts`. Each calls `loadTableRules`, with bounds from `pointsRuleBounds(rules.points, reachable)`.
- Modify: `E/competition/points.ts` — delete the old-shape tolerance in `parseStoredPointsRule` (every row is converted by Task 7); `E/competition/points-w2d.test.ts` gains the case (PS-9f).
- Modify (bench, in scope, PS-3): `tools/bench/lib/validate-pack.ts` — `:2303` (`cascade: division.tiebreakers ?? tiebreakersOf(…)`), `:2337` (the `completeTableStage` call) and `:2367` (`tiebreakersOf` → `fold.module.defaultTiebreakers`); and `tools/bench/lib/pack-template.ts:107`. All are ported to `resolveTableRules({ …, pinned: null })`: the bench has no DB, so it has no pin and no stored draw.
- Test: `W/server/engine-db/__tests__/{table-rules-pin,stage-lots,table-rules-single-resolver}.test.ts` (new); `w2d-migration-pin.test.ts` (extended, §13.8).
- Create: `MUT/t9.json`.
- No `scripts/smoke.ts` edit: `w2dTablesSuite` is created and registered in Task 13, when the API fields its checks read exist (PS-2, PS-9a).

**Interfaces:**
- Consumes: `resolveTableRules`, `TableRulesPin`, `membersKeyOf`, `StoredLotsDraw`, `RankingResult.newLotsDraws`, `payout`, the Task 7 columns.
- Produces:
  ```ts
  export interface LoadedTableRules extends TableRulesPin {
    readonly pinnedAt: string | null;
    readonly reachable: ReadonlySet<OutcomeKey>;
    /** PS-7b: the sport layer for this stage (`module.defaultTiebreakers(stageKind, mergedCfg)`, PS-7c), for the editor's Reset; the UI never calls the module. */
    readonly sportDefault: readonly TiebreakerKey[];
  }
  export async function loadTableRules(tx: Tx, stageId: string): Promise<LoadedTableRules>; // throws CONFIG_INVALID: active/complete and unpinned
  export async function pinStageTableRules(tx: Tx, stageId: string): Promise<void>;        // idempotent: … where table_rules_pinned is null
  /** PS-5d, Task 10's caller: an own save between activation and the first score. Replaces ONLY the saved field(s) of the
   *  existing pin, with source "stage"; every other field and source of the pin is kept. No pin → no-op (a pending stage reads live). */
  export async function repinStageOwnRules(tx: Tx, stageId: string, saved: { readonly points?: PointsRule; readonly tiebreakers?: readonly TiebreakerKey[]; readonly crossGroup?: readonly TiebreakerKey[] }): Promise<void>;
  export async function loadLotsDraws(tx: Tx, stageId: string): Promise<ReadonlyMap<string /* pool id or "" */, ReadonlyMap<MembersKey, StoredLotsDraw>>>;
  export async function persistLotsDraws(tx: Tx, stageId: string, poolId: string | null, draws: RankingResult["newLotsDraws"]): Promise<void>;
  ```
  `persistLotsDraws` inserts with `on conflict do nothing` on the partial unique index, then re-reads, so a racing writer's draw wins for both (Review Focus 3). A stored draw whose members intersect a newly stored draw in the same pool gets `superseded_at = now()` (history kept).

- [ ] **Step 1: Write the failing DB tests.** `table-rules-pin.test.ts`:
  ```ts
  it("X-TB-2 generating a stage's fixtures (generateStageFixturesWrite) pins it in the same transaction", …);
  it("X-TB-2 the progression setup path (generateProgressionSetupFixtures) pins it too", …);
  it("X-TB-2 OC2 a pending stage reads live layers; after activation a division tiebreakers edit does not reach it", …);
  it("anti-goal 1: after activation, editing the division cfg points, the division default order, or the sport default (simulated by a module stub) changes none of the stage's rows", …);
  it("Review Focus 1: regenerating an active stage keeps its first pin (not re-taken from a changed division default)", …);
  it("an active stage with no pin makes loadTableRules throw CONFIG_INVALID (the guard, reached by nulling the column)", …);
  it("activation-writer census: every `update stages set status = 'active'` in non-test W/server (git grep -a) is followed by pinStageTableRules in the same function (source scan; counts writers found, expects 2; 0 fails)", …);
  it("Review Focus 5: carried openings are not re-paid by the stage rule — a points-carry stage's carried row keeps its carried points after the stage's own fixtures are paid by payout (carryDeltas stages.ts:4494; payout sites competition.ts:116,432)", …);
  it("PF-10 / PS-5c: an organiser no-result abandon (outcome null, no_result flag set) pays rule.noResult to both sides; a rule without noResult pays 0; the same fixture before the abandon pays nothing (cricket, the one sport whose reachableResultKinds holds noResult — Task 1)", …);
  it("PS-7b loadTableRules returns sportDefault = the module's default for the stage kind and merged cfg, also when an own order wins (football with fairPlay on and off — the two differ from Task 11 on)", …);
  ```
  `stage-lots.test.ts`:
  ```ts
  it("X-TB-4 a residual tie is drawn once, stored, and the same order comes back on two reloads", …);
  it("X-TB-6 an empty table stores no draw", …);
  it("Review Focus 2: a withdrawal that changes the tied set stores a new draw and marks the old one superseded; an expunged fixture (ruling 105) likewise", …);
  it("Review Focus 3: two concurrent recomputes store one draw per (stage, pool, members) and both return its order", …);
  it("X-TB-4 rank_lock at completion carries the stored order and the stored drawn_at (the DB's now(), read back — PS-5b), not a JS clock", …);
  ```
  `table-rules-single-resolver.test.ts` (source scan, SPEC §1 done-means 4): no file under `W/` except `server/engine-db/table-rules.ts` reads `defaultTiebreakers` or `.tiebreakers ??`; reports files scanned (> 0) and the one allowed hit (= 1).
  `w2d-migration-pin.test.ts` gains **§13.8**:
  ```ts
  it("B1 a started stage's table is IDENTICAL before and after the migration, row by row (order, points, W/D/L), for every stage in w2d-pin-before.json (counted)", …);
  //   seed with Task 7's `fixtures/w2d-pin-seed.ts` (the recorded UUIDs and rngSeed, PS-8a), call w2d_pin_started_stages(), rankedStageStandings per stage, compare to the fixture.
  it("B1 positive pair: the scenario's pending football stage DOES take W2d's new rule — its shoot-out-decided fixture is booked as a draw plus the SO bonus (Task 3), so its rows differ from the fixture's (PS-2b)", …);
  ```
- [ ] **Step 2: Run, expect FAIL.** `cd WT/apps/web && rm -f "$TMPDIR/w2d-t9.json" && pnpm exec vitest run src/server/engine-db/__tests__/table-rules-pin.test.ts src/server/engine-db/__tests__/stage-lots.test.ts src/server/engine-db/__tests__/table-rules-single-resolver.test.ts src/server/engine-db/__tests__/w2d-migration-pin.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t9.json"; echo EXIT=$?`
- [ ] **Step 3: Implement** the loader, the pin calls, the resolver collapse, the no-result mapping, lots persistence and the bench port.
- [ ] **Step 4: Run, expect PASS.**
  - Regression (PS-9e; judged, `files` = 5): `cd WT/apps/web && pnpm exec vitest run src/server/engine-db/__tests__/integration.test.ts src/server/engine-db/__tests__/config-snapshot.test.ts src/server/engine-db/__tests__/pooled-standings-null-snapshot.test.ts src/server/public-site/__tests__/qualification-view.test.ts src/server/public-site/__tests__/standings-view.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t9r.json"; echo EXIT=$?`.
  - Engine (PS-9f; `files` = 2): `cd WT/packages/engine && pnpm exec vitest run src/competition/points-w2d.test.ts src/competition/points.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t9e.json"; echo EXIT=$?`, then the Global changed-lines Stryker recipe on `points.ts` (the deleted old-shape branch).
  - All three tscs; eslint.
  - Smoke: none in this task. The "pinned at generate" check is Task 13's `w2dTables` (PS-9a).
- [ ] **Step 5: Mutate** `MUT/t9.json`:
  - Delete the `pinStageTableRules` call in one writer. It is killed by the census AND by the writer's own case; mutate the two guards one at a time.
  - Skip the pin step entirely. It is killed by the §13.8 B1 case, on the scenario's football shoot-out stage.
  - Drop `where table_rules_pinned is null` (killed by Review Focus 1).
  - Delete the active⇒pinned throw in `loadTableRules` (killed by the CONFIG_INVALID case).
  - `on conflict do nothing` → plain insert (killed by Review Focus 3).
  - Pay the carried row through `payout` too (killed by Review Focus 5).
  - Drop the `no_result` → `{kind:"no_result"}` mapping (killed by the PF-10 case).
- [ ] **Step 6: Commit** `feat(web): one table-rules loader, the pin at activation, stored lots (W2d T9)`.

Test types: unit (DB) + source scans; e2e → Task 15 "pinned at start" and Task 19 walkthroughs; smoke → Task 13 `w2dTables` ("a stage is pinned when its fixtures are generated"); regression above. Sequence: pending → active (pinned) → regenerate → first score → void that score → another sport.

---

### Task 10: Web — the write paths: validation, coverage, the lock, `stagesKeptPinned` (wave 2, after Task 9 AND after Task 11 has merged — PS-2)

SPEC §5.4 "What changes after the pin", "Fixture override coverage", §5.5 "Write paths", §5.8 (the seed → id fallback), §10, §11 item 4, D3, D8, D9, D10(a), Review Focus 4. Rule rows X-TB-2 (lock half), X-TB-3, X-TB-5, X-PT-3, FB-TB-4.

**Why Task 11 first (PS-2):** this task validates the effective cascade on `createStages`/`replaceStages`. Before Task 11, the sport default is TODAY's list, which fails `validateCascade` for most sports (no `lots` last; `points` first where the primary key is `wins`; chess `buchholz*` on a non-Swiss stage). With Task 11 merged, every inherited default passes, and §5.5 stays exactly as written.

**Files:**
- Modify: `W/server/usecases/stage-rules.ts` `putStageRules :73`:
  - It accepts `tiebreakers: TiebreakerKey[] | null` and `crossGroupTiebreakers`, and validates them with `validateCascade`.
  - Points go through `coverage(rule, reachableOutcomes(...))`.
  - Before the first score, a valid save calls `repinStageOwnRules(tx, stageId, <the saved fields>)`. That call replaces only those fields of the existing pin (PS-5d, Task 9).
  - After the first score the save is `STAGE_FORMAT_LOCKED`. "Started" is W2c's predicate `lockedStageIdsAmong` (`rule-locks.ts:74`), which also counts an online stage whose round is opened and has no score (PF-9, PS-6).
  - The volleyball `"*"` early return in `unansweredSetScores` (`W/server/usecases/stage-rules-merge.ts:113`, the return at `:125`) is deleted, because coverage owns it.
- Modify: `W/server/usecases/rule-locks.ts`:
  - `divisionRefusals` loses its tiebreakers branch (`:125-129`).
  - `STAGE_POINTS_REPLACES` becomes `{points, pointsMap, otWin, otLoss, soBonus, tie, noResult, draw}`.
  - Boardgame `scoring` and `awardScore` keep W2c's lock.
- Modify: `W/components/v2/division-settings-locks.ts` (`RULE_LOCK_KEYS :16-19`; SPEC §11 item 4, PS-9e): the form's tiebreakers field carries no lock line once a stage starts, because the server stops refusing it. `DIVISION_TABLE_RULES_LOCKED` stays for boardgame `scoring`/`awardScore`. Its tests `W/components/v2/__tests__/division-settings-locks.test.ts` and `division-settings-lock-lines.test.tsx` gain that case.
- Modify: `W/server/usecases/divisions.ts` `createDivision :239` and `patchDivision :732`:
  - Validate against the sport and against every UNPINNED table stage that inherits.
  - The patch response gains `stagesKeptPinned: {stageId, name}[]`.
  - A cfg save that flips football `fairPlay` re-validates every unpinned inheriting cascade.
  - `refuseInexpressibleStagePoints`'s call (`:1245`) is deleted.
- Modify: `W/server/usecases/stages.ts` `createStages :507` / `replaceStages :621` — validate the effective cascade, and assign `config.rngSeed` (random 31-bit) when it is absent.
- Modify: `W/server/usecases/templates.ts` and `W/server/templates/schema.ts:135` (`z.array(z.string())` → `z.array(TiebreakerKeyS)`, plus validation on apply).
- Modify: `W/server/api-v1/schemas.ts` — `TiebreakerKeyS :325` gains Task 4's ten keys (moved here from Task 13, PS-2c, because the template schema and the division write types above need them). Then `cd WT && pnpm openapi:gen` and commit `openapi/*.json` (Global "OpenAPI").
- Modify: `W/server/usecases/fixture-rules.ts` `writeFixtureRulesOverride :251` — check coverage of the fixture's merged format against the stage's effective (pinned) rule.
- Delete: `pointsRuleExpressible`, `Expressible` and `BASE_KEYS` (W2c `E/competition/points.ts:250-278`) with every reader (SPEC §5.3 "with every reader"; PS-3b). The census is `git grep -l -a -E "pointsRuleExpressible|POINTS_RULE_INEXPRESSIBLE|divisionExpressible|POINTS_SPLIT_LABEL_KEYS|refuseInexpressibleStagePoints" -- apps packages`, which must read 0 after this task. At 2026-10-24 it lists:
  - **Engine:** `E/competition/points.ts`; `points-w2c.test.ts` (the Q1 `describe`, `:460-496`).
  - **Web server:** `W/server/usecases/stage-rules-merge.ts`:
    - the import `:15`;
    - `inexpressibleRefusal :256-263`;
    - Q1 step 2 of `refuseStagePoints :287-289`, whose steps 1 and 3 stay (its callers are `stage-rules.ts:170` and `stage-defaults.ts:110`);
    - `refuseInexpressibleStagePoints :312-321`.
  - **Web server, continued:** `divisions.ts:29,1245`; `stage-defaults.ts:81` (comment); `openapi.ts:102,147,148,160,766` (the route summaries and the `keys` description; Task 13 then names the new codes there).
  - **Rule errors:** `W/lib/rule-errors.ts` — `POINTS_RULE_INEXPRESSIBLE` (`:20`, `:53`, `:178`, `:202`, `:272`), `pointsSplit :79` and `POINTS_SPLIT_LABEL_KEYS :115-123`. Task 3 has already removed the shoot-out rows from it.
  - **UI (PS-3b):** `W/components/v2/stage-rules/stage-points-model.ts` (`divisionExpressible :52-54`, imports `:14,16`) and `stage-points-section.tsx` (the inexpressible state, `:8,29,128,173`).
  - **Tests:** `stage-points-model.test.ts`, `stage-points-section.test.tsx`, `W/components/v2/__tests__/stages-panel-stage-points.test.tsx`, `W/lib/__tests__/rule-errors-copy.test.ts`, `W/server/api-v1/__tests__/openapi-400-label.test.ts`, `division-locks.test.ts`, `rules-lifecycle-sequence.test.ts`, `stage-points.test.ts` — each case is deleted or rewritten, with why.
  - **E2e:** `apps/web/e2e/stage-rules-w2c.spec.ts:15,558,882-897` and `apps/web/e2e/mobile.spec.ts:33,5919`. They are rewritten here and proven by the CI e2e dispatch at the wave-2 close; e2e never runs locally.
- Modify: `W/lib/rule-errors.ts` — `TIEBREAK_KEY_INVALID` (422, `extra.refusals`) and `POINTS_OUTCOME_UNCOVERED` (422, `extra.uncovered`), with SPEC §10's English and their keys. The four dictionaries (`ui.json`) get the §10 messages and the nine reasons, then run `pnpm i18n:gen-keys`.
- No `scripts/smoke.ts` edit: its checks read `PutStageRules.tiebreakers` and `stagesKeptPinned` over the API, so they are Task 13's (PS-2, PS-9a).
- Test: `W/server/usecases/__tests__/{stage-tiebreaks-write,division-tiebreaks-write,table-rules-sequence,table-writers-source}.test.ts` (new). Rewrite the cases in W2c's `rules-lifecycle-sequence.test.ts` and `division-locks.test.ts` that the lock change turns red, each named with why (SPEC §11 item 4).
- Create: `MUT/t10.json`.

**Interfaces:**
- Consumes: `validateCascade`, `coverage`, `reachableOutcomes`, `loadTableRules`, `repinStageOwnRules` (Task 9's signature), `lockedStageIdsAmong` (W2c).
- Produces: `putStageRules(auth, stageId, body: { rules?; points?: PointsRule | null; tiebreakers?: TiebreakerKey[] | null; crossGroupTiebreakers?: TiebreakerKey[] | null })`; `DivisionPatchResult.stagesKeptPinned`; the error codes above; `TiebreakerKeyS` with the ten keys.

- [ ] **Step 1: Write the failing tests.** `stage-tiebreaks-write.test.ts`:
  ```ts
  it("X-TB-5 an own order with nrr on a football stage is refused 422 TIEBREAK_KEY_INVALID with refusals [{index, key:'nrr', reason:'sport'}]", …);
  it("Review Focus 4: tiebreakers [] is refused (reason 'empty'); null inherits (sources.tiebreakers 'division' or 'sport')", …);
  it("X-TB-2 between activation and the first score an own save is accepted and re-pins (sources 'stage')", …);
  it("PS-5d an own points save after activation re-pins ONLY points: a division default order edited after activation does not ride in — the pinned tiebreakers and their source are unchanged", …);
  it("X-TB-2 after the first score an own tiebreakers or points save is 409 STAGE_FORMAT_LOCKED; a void of that score does not unlock (monotonic)", …);
  it("PF-9 / PS-6 an online (Lichess) division stage with an opened round and NO score refuses own tiebreakers and points 409 STAGE_FORMAT_LOCKED (W2c's lockedStageIdsAmong); the same stage before the round opens accepts them", …);
  it("X-PT-3 a football group stage with shootout on and an own rule with no draw is refused POINTS_OUTCOME_UNCOVERED ['draw']", …);
  it("X-PT-3 VB-PT-3 a best-of-3 fixture override on a FIVB best-of-5 stage is refused naming set:2-0 and set:2-1", …);
  it("an override that only removes outcomes (football extra time off) is accepted", …);
  it("a Community org saves an own order, a split points rule, bonuses and a forfeit row, and its table pays them (D1; behaviour only)", …);
  ```
  `division-tiebreaks-write.test.ts`:
  ```ts
  it("X-TB-2 a division tiebreakers save is no longer refused for a started stage; the response lists it in stagesKeptPinned", …);
  it("STAGE_POINTS_REPLACES: a division otWin / soBonus / tie / draw save is accepted once stages are pinned; boardgame `scoring` still DIVISION_TABLE_RULES_LOCKED", …);
  it("X-TB-5 a division default invalid for one unpinned inheriting stage is refused naming that stage and its kind; a pinned stage is not consulted", …);
  it("FB-TB-4 flipping football fairPlay off while an unpinned stage has an OWN or division order holding fair_play is refused naming it; a stage inheriting the sport default is not refused (the default drops fair_play with it — PS-7c, Task 11)", …);
  it("createStages: an inherited key invalid for the new stage's kind is refused with the 'set this stage's own order' reason; rngSeed is assigned when absent", …);
  it("a template whose tiebreakers hold an unknown key is refused at apply (schema.ts no longer z.string())", …);
  it("§5.8 no non-Swiss product path reaches the seed → id fallback: every sport default (forEachSport × non-Swiss TableStageKind × the module's default cfg) and every order a write path accepts ends in lots (counted, > 0); a migrated pin is the one exception (B1), counted separately", …);
  ```
  `table-rules-sequence.test.ts` (rule 10, fast-check over {stage own edit, division edit, sport-default stub change, activate, first score, void, regenerate}): **pin monotonicity**. After activation, no sequence changes the stage's ranked rows except its own valid saves before the first score, and such a save changes only the field it saved (PS-5d). Reports `checked`.
  `table-writers-source.test.ts`: every SQL write to `divisions.tiebreakers` and `stages.config` under `W/server` (`git grep -a`) is in a function that calls `validateCascade` (counted; 0 fails).
  Division settings locks (`W/components/v2/__tests__/division-settings-locks.test.ts`): `it("§11 item 4 a started stage leaves the tiebreakers field open (no lock line); boardgame scoring still carries DIVISION_TABLE_RULES_LOCKED", …)`.
- [ ] **Step 2: Run, expect FAIL.** `cd WT/apps/web && rm -f "$TMPDIR/w2d-t10.json" && pnpm exec vitest run src/server/usecases/__tests__/stage-tiebreaks-write.test.ts src/server/usecases/__tests__/division-tiebreaks-write.test.ts src/server/usecases/__tests__/table-rules-sequence.test.ts src/server/usecases/__tests__/table-writers-source.test.ts src/components/v2/__tests__/division-settings-locks.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t10.json"; echo EXIT=$?`
- [ ] **Step 3: Implement** the write paths and the deletions. Rewrite the W2c lock tests that assert the removed refusals.
- [ ] **Step 4: Run, expect PASS.**
  - Regression (PS-9e; judged, `files` = 13):
    ```
    cd WT/apps/web && pnpm exec vitest run \
      src/server/usecases/__tests__/{stage-rules,stage-rules-every-sport,rules-lifecycle-sequence,division-locks,fixture-rules,stage-defaults,stage-points}.test.ts \
      src/components/v2/__tests__/division-settings-lock-lines.test.tsx \
      src/components/v2/stage-rules/__tests__/{stage-points-model.test.ts,stage-points-section.test.tsx} \
      src/components/v2/__tests__/stages-panel-stage-points.test.tsx \
      src/lib/__tests__/rule-errors-copy.test.ts \
      src/server/api-v1/__tests__/openapi-400-label.test.ts \
      --reporter=json --outputFile="$TMPDIR/w2d-t10r.json"; echo EXIT=$?
    ```
    zsh expands the braces. Confirm 13 paths in `.testResults[].name`.
  - Engine (`files` = 1): `cd WT/packages/engine && pnpm exec vitest run src/competition/points-w2c.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t10e.json"; echo EXIT=$?`.
  - Run the census grep above, which must read 0. Run all three tscs (the e2e specs compile under apps/web's tsc), eslint, `pnpm i18n:check` and `cd WT && pnpm openapi:gen && git status --porcelain openapi/` (only the `TiebreakerKeyS` and removed-code diff).
  - **Live catalog (SPEC §11 item 5):** read `standings.custom_points` and `tiebreakers.custom` for every plan from the live entitlements catalog (memory: it has differed from `V393__entitlements_v18.sql:63-69`). If any plan reads false, delete the `requireFeature` calls for these settings (`stages.ts:419` `standings.custom_points`, `:477` `tiebreakers.custom`) in this task; the Community behaviour test above is the proof, and there is no gate-absence pin. The `tiebreakers.custom` call at `:5143` (`overrideStandings`) is not a scoring setting and stays.
  - Smoke: none in this task. "An invalid order is refused by name" and "a division edit after activation lists the stage as kept" are Task 13's `w2dTables` checks.
- [ ] **Step 5: Mutate** `MUT/t10.json`:
  - Remove `validateCascade` from `putStageRules` (killed by the X-TB-5 case AND the writers source scan; mutate the two one at a time).
  - The lock predicate reads `fixtures.status` instead of W2c's monotonic pair (killed by the void case).
  - The lock predicate drops the opened-round arm (killed by the PF-9 case, PS-6).
  - `repinStageOwnRules` re-resolves the whole pin with `pinned: null` (killed by the PS-5d case).
  - `STAGE_POINTS_REPLACES` loses `soBonus` (killed).
  - Coverage is skipped on the override path (killed by VB-PT-3).
- [ ] **Step 6: Commit** `feat(web): validated tie-break and points writes; the pin replaces the division lock (W2d T10)`.

Test types: unit (DB) + sequence + source scan; e2e → Task 15/16, plus the rewritten `stage-rules-w2c.spec.ts`/`mobile.spec.ts` cases in the wave-2 close CI dispatch; smoke → Task 13 `w2dTables`; regression above. Sequence: empty body → valid → invalid → after activation → after first score → after a void → another sport.

**Wave 2 close:**
- Whole-wave review.
- Gate = the Step 4s of Tasks 7–10, and of Task 11, which merged before Task 10.
- Proof commit (X-TB-1/2/3/4/5/6, X-PT-3, FB-TB-4).
- CI e2e dispatch (`--ref` the build branch) for `stage-rules-w2c.spec.ts` and `mobile.spec.ts`.
- **Walkthrough** on the `w2d` env at 1280:
  1. Create a football and a volleyball division.
  2. Generate. The badge data says pinned, via the API.
  3. Edit the division default.
  4. Confirm the started table did not move and the API lists it in `stagesKeptPinned`.
  5. Write the verdicts to IDX.

---

### Task 11: Engine — per-sport defaults, presets, rule rows, rulebook scenarios (lane `format-matrix-w2d-defaults`; starts right after Task 8 merges and merges BEFORE Task 10 starts — PS-2)

SPEC §5.10, D5, D10, B4, B5, OC1, §13.1, §13.4 ("the default order passes"). Rule rows FB-TB-1/2/3, HK-TB-1, IH-TB-1, BG-TB-1/2, CK-TB-1, VB-TB-1, BD-TB-1, TT-TB-1, TN-TB-1/2, CA-TB-1, GN-TB-1, HK-PT-2, BG-PT-1 (preset half).

**Files:**
- Modify: every module's `defaultTiebreakers(kind, cfg)` round-robin value (Swiss value unchanged, OC1), exactly SPEC §5.10:

  | sport | default order (league/group/americano) |
  |---|---|
  | football | `fifa2026`: points, h2h_points, h2h_diff, h2h_for, diff, for, fair_play, lots |
  | hockey | points, wins, diff, for, h2h_points, h2h_wins, h2h_diff, h2h_for, field_goals, lots |
  | ice hockey | points, h2h_points, h2h_diff, h2h_for, h2h_reapply, diff, for, seed, lots |
  | chess / boardgame | points, direct, wins, sberger, lots |
  | cricket | points, wins, nrr, h2h_points, seed, lots |
  | volleyball | wins, points, set_ratio, point_ratio, h2h_points, lots |
  | badminton | wins, h2h_two, set_diff, h2h_two, point_diff, h2h_two, lots |
  | table tennis | points, h2h_points, h2h_set_ratio, h2h_point_ratio, h2h_exclusion, lots |
  | tennis | wins, matches_played, h2h_two, set_ratio, h2h_two, game_ratio, h2h_two, seed, lots |
  | carrom | points, wins, set_ratio, board_ratio, point_ratio, h2h_points, lots |
  | generic | points, diff, for, h2h_points, lots |

  **PS-7c, owner 2026-10-24 (Option 1):** football's `fair_play` step is in the default only while the division's cfg tracks it (`cfg.fairPlay` on). With it off, `defaultTiebreakers(kind, cfg)` omits the step, so the default always passes `validateCascade` (D8, §13.4). `resolveTableRules` hands it the merged cfg (Task 8). Every other module ignores `cfg`.
- Modify: `E/sport/module.ts` — `tablePresets?(stageKind: TableStageKind): { points: readonly { id: string; rule: PointsRule }[]; tiebreakers: readonly { id: string; keys: readonly TiebreakerKey[] }[] }`. Football tiebreakers `fifa2026`, `uefa` (fifa2026 with `h2h_reapply` after the block), `classic` (points, diff, for, h2h_points, h2h_diff, h2h_for, fair_play, lots); hockey points `pro_league`; chess points `fide_1_half_0` and `three_one_zero` (`{win 3, draw 1, loss 0, unit "whole"}`) — `three_one_zero` absent on `swiss`.
- Modify: `RULES/*.md` — the deviation rows' text (football lots instead of FIFA ranking RB2B-4, UEFA 20.02 not offered RB2B-5, `uefa` tail INFERRED; FIH ranking shoot-out RB2B-11; IIHF steps 4–5 RB2B-12; cricket lots after seed; tennis lots after seed; volleyball best of 3 VB-12 and double-RR aggregate RBS:295; carrom/generic product rule RB2B-27).
- Test: `E/competition/tables-rulebook.test.ts` (new, §13.1), `E/competition/defaults-sweep.test.ts` (new, §13.4).
- Create: `MUT/t11.json`.

**Interfaces:** Consumes Tasks 2–8. Produces the default values and `tablePresets`.

- [ ] **Step 1: Write the failing tests.** `tables-rulebook.test.ts` — one describe per sport, each case a table typed from the rule text, each title carrying its rule id; each sport has ≥1 case per key it DECIDES and ≥1 DIFFERENTIAL case against the pre-W2d order (the old list from the Anchors row, typed into the test as the "wrong one's constant"):
  ```ts
  it("VB-TB-1 five 3-2 wins (10 pts) rank above four 3-0 wins (12 pts) (RBS:318 VB-9)", …);
  it("BD-TB-1 a three-way tie split by games DIFFERENCE where the ratio disagrees (RBS:151-156)", …);
  it("TT-TB-1 TT-PT-1 a walkover loser on 0 vs a played loser on 1; exclusion reverses the 3-way ratio order (RBS:227-230)", …);
  it("TN-TB-1 2-1 above 2-0 (matches played); TN-TB-2 a won match tie-break counts one set and one game (RB2A-11)", …);
  it("HK-TB-1 more wins above better GD; HK-TB-2 field goals decide (RBG:236-237)", …);
  it("IH-TB-1 a 4-way tie re-applied down to 2 (RBG:345-346)", …);
  it("FB-TB-1 FB-TB-2 uefa vs fifa2026 on a 3-way tie that re-application splits differently (RBG:108-112)", …);
  it("BG-TB-1 chess RR: SB decides where Buchholz would have; BG-TB-2 buchholz is not in the RR default", …);
  it("CK-PT-1 under a stage rule a cricket tie pays 1, not 0 (ST-G9)", …);
  it("VB-PT-2 best of 3: 2-1 pays 2:1, not 3:0 (SC-S9)", …);
  it("HK-PT-2 SC-P4 oracle: FIH default 3/1/0 with a draw; the Pro League preset's shoot-out pays D + 1 (2/1) (D10(f), B2)", …);
  ```
  `defaults-sweep.test.ts` (forEachSport × variant × table stage kind, counted, 0 fails): the default order passes `validateCascade` (Swiss skips the shape rule only, OC1 — and the count of Swiss cells is reported separately); every `tablePresets` order passes; every `tablePresets` points rule covers `reachableOutcomes`; the non-Swiss default starts with `primaryTableKey` and ends with `lots`.
  ```ts
  it("PS-7c football default omits fair_play when fairPlay is off, includes it when on; both pass validateCascade", …); // the two orders typed from SPEC §5.10's fifa2026 row, with and without fair_play
  ```
- [ ] **Step 2: Run, expect FAIL.** `cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2d-defaults/packages/engine && rm -f "$TMPDIR/w2d-t11e.json" && pnpm exec vitest run src/competition/tables-rulebook.test.ts src/competition/defaults-sweep.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t11e.json"; echo EXIT=$?`
- [ ] **Step 3: Implement** the values, presets and rule-row text.
- [ ] **Step 4: Run, expect PASS**; regression: every engine test touching `defaultTiebreakers` — list them with `git grep -l -a defaultTiebreakers -- 'packages/engine/**/*.test.ts'`, pass them as exact paths, and judge `files` = that count (written down before the run; PS-9d); `pnpm --filter @onryde/seazn-engine fold-epoch:check --against HEAD^1`; all three tscs; eslint. Merge the lane (`--no-ff`) BEFORE Task 10 starts, and re-run the same files on the merged tree.
- [ ] **Step 5: Mutate** `MUT/t11.json`: badminton default swaps `set_diff` and `point_diff` (killed by BD-TB-1); volleyball `points` first (killed by VB-TB-1); chess 3/1/0 preset offered on swiss (killed by the sweep); football keeps `fair_play` when `fairPlay` is off (killed by the PS-7c case AND by the sweep — mutate them one at a time).
- [ ] **Step 6: Commit** `feat(engine): the signed per-sport table defaults and presets (W2d T11)`.

Test types: unit (§13.1, §13.4); e2e → Task 19; smoke → Task 14 (one sport's default order through the API); regression above. Sequence: default → preset → variant → Swiss (exempt) → another sport.

---

### Task 12: Engine + web — cross-group ranking (ST-G4) and the partial-schedule order (ST-G12) (wave 3, after Tasks 10 and 11)

SPEC §5.9, §5.6 "ST-G12", D3, D7, author's call (generic skip). Rule rows X-TB-7, X-TB-8, IH-TB-2.

**Files:**
- Modify: `E/competition/progression.ts:573` — `crossGroupOrder(rows, crossGroup: readonly TiebreakerKey[], lotsDraws, ctx)` replaces the hard-coded list (`:574`). Its ONLY caller is `resolveProgression`'s best-Nth branch (`:668`). The comment at `:570-572` records that the former `orderCandidates` (qualification.ts) and `crossGroupOrder` (stage-seeding.ts) copies were already unified into this one; neither exists today (`git grep -n -a crossGroupOrder`, 2026-10-24).
- Modify: `E/competition/tiebreakers.ts` — `RankContext.scheduledPairs?: ReadonlySet<string>` (sorted `a|b`); the h2h block's completeness guard; `partialScheduleOrder` substitution.
- Modify: `E/sport/module.ts` — `partialScheduleOrder?: readonly (TiebreakerKey | "fewest_played")[]`; ice hockey declares `["fewest_played","diff","for","seed","lots"]` (RBG:349-350). `fewest_played` is internal, never in `TiebreakerKey` or `offerableKeys`.
- Modify: `W/server/engine-db/competition.ts` — pass `scheduledPairs` (from the stage's fixtures, decided or not) and the SOURCE stage's `crossGroup` + lots to progression.
- Test: `E/competition/cross-group-w2d.test.ts`, `E/competition/partial-schedule.test.ts` (new); one DB case in `W/server/engine-db/__tests__/table-rules-pin.test.ts` (the pinned crossGroup is what progression reads).
- Create: `MUT/t12.json`.

**Interfaces:** Produces `crossGroupOrder` (new signature), `RankContext.scheduledPairs`, `partialScheduleOrder`. The tie popover note `"h2h_incomplete"` on rows whose class skipped the block.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  it("X-TB-7 two badminton runners-up from different groups are split by set_diff, not by seed (ST-G4)", …); // expected from BWF 16.2.3, not from crossGroupOrder
  it("X-TB-7 the cross-group order never applies a head-to-head step (teams never met)", …);
  it("X-TB-7 a pinned stage's crossGroup (migrated: points, diff, for, wins) is what progression uses — B1 keeps best-third unmoved", …);
  it("X-TB-8 IH-TB-2 IIHF partial schedule: a 3-way tie whose mini-schedule is incomplete is ordered fewest played → diff → for → seed → lots (RBG:349-350)", …);
  it("X-TB-8 a complete mini-schedule uses the h2h block as usual (the positive pair)", …);
  it("X-TB-8 another sport (football) with an incomplete mini-schedule skips the block for that class and notes 'h2h_incomplete' (author's call, AUD-ST:71)", …);
  it("empty: a class of one, and a stage whose scheduledPairs is empty, behave as before", …);
  ```
- [ ] **Step 2: Run, expect FAIL.** `cd WT/packages/engine && rm -f "$TMPDIR/w2d-t12e.json" && pnpm exec vitest run src/competition/cross-group-w2d.test.ts src/competition/partial-schedule.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t12e.json"; echo EXIT=$?`, then the web DB case: `cd WT/apps/web && rm -f "$TMPDIR/w2d-t12w.json" && pnpm exec vitest run src/server/engine-db/__tests__/table-rules-pin.test.ts -t "crossGroup" --reporter=json --outputFile="$TMPDIR/w2d-t12w.json"; echo EXIT=$?` (judge the case's title in `.testResults[].assertionResults`, not just the count).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; regression (judged): engine `src/competition/progression.test.ts src/competition/qualification.test.ts` (`files` = 2); web `src/server/usecases/__tests__/stage-progression.test.ts` and `src/server/engine-db/__tests__/table-rules-pin.test.ts` (`files` = 2; `stage-progression.test.ts:272,371` pins the best-Nth tie order that runs through `crossGroupOrder`); all three tscs; eslint.
- [ ] **Step 5: Mutate** `MUT/t12.json`: restore the hard-coded list (killed by X-TB-7); treat an undecided scheduled pair as complete (killed by X-TB-8). Stryker changed lines.
- [ ] **Step 6: Commit** `feat(engine): cross-group order from the source stage; IIHF partial-schedule order (W2d T12)`.

Test types: unit; e2e → Task 19 "goals family: best third"; smoke → Task 14; regression above. Sequence: no candidates → one per group → tie → after a withdrawal → another sport.

**Wave 3 close:** whole-wave review; gate = Task 12's Step 4, plus Task 11's Step 4 re-run on the current tree (it merged before Task 10 and was gated at the wave-2 close, PS-2); proof commit; **walkthrough**: a hockey group stage and an ice-hockey group stage played to a tie on the `w2d` env, public tables read through the API; verdicts to IDX.

---

### Task 13: API v1 and OpenAPI (wave 4)

SPEC §7, §10, §6 W9. Rule rows proved through the API: X-TB-1, X-TB-5, X-PT-3. This is the first task whose fields the smoke suite can read, so it creates `w2dTablesSuite` and takes the checks Tasks 9 and 10 traced forward (PS-2, PS-9a).

**Files:**
- Modify: `W/server/api-v1/schemas.ts` — `TiebreakerKeyS :325` (already widened with Task 4's ten keys in Task 10, PS-2c); `PutStageRules` (`points :1294`) gains `tiebreakers: z.array(TiebreakerKeyS).nullable().optional()` and `crossGroupTiebreakers` (same); `points` is the widened `PointsRule` (re-exported, unchanged import at `:18`); `StageRules` response adds both; `Stage` GET gains `tableRules` (shape below, exported as `StageTableRules` for Task 15+16); standings row gains `won_ot, won_so, lost_ot, lost_so`, `tieBreak.drawnAt`, `level`; division patch response gains `stagesKeptPinned`; `rngSeed` stays optional on input (server assigns it).
- Modify: `W/server/api-v1/openapi.ts` — the `/divisions/{id}/stages` POST/PUT and `/stages/{id}/rules` PUT summaries (`:147,148,160`; Task 10 already removed `POINTS_RULE_INEXPRESSIBLE` from them) name `TIEBREAK_KEY_INVALID`, `POINTS_OUTCOME_UNCOVERED`, the pin and the lock; the standings and division routes describe the new fields.
- No `W/server/api-v1/http.ts` edit: its `ENGINE_HTTP` (`:28`) maps ENGINE error codes only. The two rule codes take their status from `RULE_ERROR_STATUS` (`W/lib/rule-errors.ts:13`), where Task 10 adds them (PS-10).
- Modify: `scripts/smoke.ts` — create `w2dTablesSuite`, call it beside `w2cStageRulesSuite` (`:1294`), and register it as `w2dTables` in `SELECTABLE_SUITES` (`:23060`, beside `w2cStageRules :23071`). Its checks: "a stage is pinned when its fixtures are generated" (Task 9), "an invalid order is refused by name" and "a division edit after activation lists the stage as kept" (Task 10), "GET tableRules says where the order came from" (this task).
- Modify: `openapi/*.json` (regenerated).
- Modify: the route handlers only if a schema change needs it: `W/app/api/v1/stages/[id]/{rules,standings}/route.ts`, the public standings route, the division PATCH route.
- Test: `W/server/api-v1/__tests__/w2d-api.test.ts` (new; route handlers over the label DB).
- Create: `MUT/t13.json`.

**Interfaces:**
- Produces:
  ```ts
  // GET /stages/{id} and the stages list
  tableRules: {
    tiebreakers: { keys: TiebreakerKey[]; source: TableRulesSource; pinnedAt: string | null; sportDefault: TiebreakerKey[] }; // sportDefault: LoadedTableRules.sportDefault (PS-7b), the editor's Reset
    crossGroup: { keys: TiebreakerKey[] };
    points: { rule: PointsRule; source: TableRulesSource; pinnedAt: string | null };
    reachableOutcomes: OutcomeKey[];
  }
  ```

- [ ] **Step 1: Write the failing tests** `w2d-api.test.ts`:
  ```ts
  it("X-TB-1 GET /stages/{id} returns tableRules with source 'sport' before any edit, 'division' after a division default, 'stage' after PUT rules", …);
  it("PS-7b tableRules.tiebreakers.sportDefault is the sport's default for the stage kind and the division cfg even when an own order wins (football with fairPlay off: no fair_play; on: fair_play before lots)", …);
  it("X-TB-5 PUT /stages/{id}/rules {tiebreakers:['points','nrr','lots']} on football → 422 TIEBREAK_KEY_INVALID, extra.refusals[0] = {index:1,key:'nrr',reason:'sport'}", …);
  it("X-PT-3 PUT /fixtures/{id}/rules best of 3 on a FIVB best-of-5 stage → 422 POINTS_OUTCOME_UNCOVERED, extra.uncovered ['set:2-0','set:2-1']", …);
  it("an old-shape points body {base:{…}} is 400 (greenfield, no alias)", …);
  it("GET standings rows carry won_ot/won_so/lost_ot/lost_so, tieBreak.drawnAt for a lots tie, level on an empty table", …);
  it("PATCH division tiebreakers after activation → 200 with stagesKeptPinned naming the stage", …);
  it("POINTS_RULE_INEXPRESSIBLE appears nowhere in schemas, openapi or the error map (greenfield deletion, git grep -a, counted files > 0)", …);
  ```
- [ ] **Step 2: Run, expect FAIL.** `cd WT/apps/web && rm -f "$TMPDIR/w2d-t13.json" && pnpm exec vitest run src/server/api-v1/__tests__/w2d-api.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t13.json"; echo EXIT=$?`
- [ ] **Step 3: Implement**; `cd WT && pnpm openapi:gen && git status --porcelain openapi/` shows only the intended diff.
- [ ] **Step 4: Run, expect PASS**; regression: the W2c API tests — list them with `git grep -l -a "stages/{id}/rules\|PutStageRules" -- apps/web/src/server/api-v1/__tests__`, pass exact paths, and judge `files` = that count (PS-9d); all three tscs; eslint. Smoke (scoped, PS-9a): `$S rebuild --label w2d`, then `cd WT && SMOKE_ONLY=w2dTables SMOKE_BASE=http://localhost:<port> pnpm smoke; echo EXIT=$?`, judged on its own exit and the printed check count (= 4).
- [ ] **Step 5: Mutate** `MUT/t13.json`: `tableRules.tiebreakers.source` hard-coded `"sport"` (killed); `TiebreakerKeyS` loses `h2h_two` (killed by a BWF PUT case added to the first test); `sportDefault` serialised from the winning order instead of the loader's field (killed by the PS-7b case).
- [ ] **Step 6: Commit** (with `openapi/*.json`) `feat(api): stage tableRules, tie-break orders and outcome-keyed points over API v1 (W2d T13)`.

Test types: unit (route); e2e → Task 15; smoke above; regression above. Sequence: GET before edit → PUT → GET → PUT invalid → after activation → another sport.

---

### Task 14: The real producer → consumer seam, and smoke (wave 4, after Task 13)

SPEC §13.5 (class 1: drive the seam through its real producer and consumer), §13 Smoke, §5.2 pad finding (API half), B5. Rule rows FB-PT-1, IH-PT-1, CK-PT-1, TT-PT-1, HK-TB-1, HK-TB-2, X-TB-2.

**Files:**
- Test: `W/server/engine-db/__tests__/tables-producer-consumer.test.ts` (new, DB): events go through the real `POST /api/v1/fixtures/{id}/events` route handler, the real recompute, then the real public standings `GET`.
- Modify: `scripts/smoke.ts` — `w2dTablesSuite` reaches its SPEC §13 shape: create a division, set a stage order and points through the API, generate, score one fixture, read the public standings (order, `source`, `pinnedAt`), plus the checks earlier tasks added.
- Create: `MUT/t14.json`.

- [ ] **Step 1: Write the failing tests** (red until every earlier seam is wired; each expected value from the rulebook, never from `payout`):
  ```ts
  it("FB-PT-1 football group, shootout on: football.penalty kicks in the SHOOTOUT phase → public row D for both, winner 2 points, loser 1, wins 0 (RB2B-7)", …);
  it("IH-PT-1 icehockey.period.advance into OT + icehockey.goal → OTW/OTL and 3-2-1-0 points 2/1 (RBG:343-344)", …);
  it("IH-PT-1 icehockey.shootout.attempt → a GWS pays 2/1", …);
  it("CK-PT-1 a cricket tie → 1 point each on the public table", …);
  it("TT-PT-1 a table-tennis walkover → the loser's row gets 0, a played loser 1", …);
  it("HK-TB-2 hockey goals typed fg / pc / stroke / og through the API: two teams level on points, wins, diff and for are ranked by field goals (gf − goals_pc − goals_stroke; the own goal counts as a field goal), and the public row's metrics carry goals_pc and goals_stroke (the column itself is Task 17's — PS-2)", …);
  it("HK-TB-1 FIH: a team with more REGULATION wins ranks above one level on points whose wins include a shoot-out win — winsCount 'regulation' reaches the web rank call (PS-5a; RBG:236)", …);
  it("B5 chess round robin under the 3/1/0 preset: Sonneborn-Berger and direct read the game points 1/½/0, not the 3/1/0 table points — two players level on table points split as RBG's SB arithmetic says (gamePoints reaches the web rank call, PS-5a)", …);
  it("X-TB-2 the pin comes from the real POST /stages/{id}/generate; the lock from the real first event append; the override refusal from the real PUT /fixtures/{id}/rules", …);
  ```
- [ ] **Step 2: Run, expect FAIL** on any unwired step; a red here is a defect in the owning task, fixed there (class 1), never by editing this test's expected values.
  `cd WT/apps/web && rm -f "$TMPDIR/w2d-t14.json" && pnpm exec vitest run src/server/engine-db/__tests__/tables-producer-consumer.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t14.json"; echo EXIT=$?`
- [ ] **Step 3: Fix the seams the test finds** (each fix in its owning file, named in the report).
- [ ] **Step 4: Run, expect PASS**; smoke (scoped, PS-9a): `$S rebuild --label w2d` then `cd WT && SMOKE_ONLY=w2dTables,w2cStageRules SMOKE_BASE=http://localhost:<port> pnpm smoke; echo EXIT=$?` (`w2cStageRules` is the regression), judged on its own exit and the printed check count of each suite.
- [ ] **Step 5: Mutate** `MUT/t14.json`:
  - The web payout site passes `decidedIn: null` (killed by FB-PT-1 and IH-PT-1).
  - The web rank call drops `winsCount` (killed by HK-TB-1) or `gamePoints` (killed by B5); mutate them one at a time.
  - The recompute skips `persistLotsDraws`. It is killed by Task 9's `stage-lots.test.ts` "X-TB-4 a residual tie is drawn once, stored, and the same order comes back on two reloads", which reads the stored row; that is a vitest killer `scripts/mutate.ts` can run (PS-9b).
- [ ] **Step 6: Commit** `test(web): W2d producer → consumer through the real API; w2dTablesSuite (W2d T14)`.

**Wave 4 close:** whole-wave review; gate; proof commit; **walkthrough** through the API on the `w2d` env (football group shoot-out, ice-hockey OT) with verdicts in IDX.

---

### Task 15 + 16 (one loop): The stage editor — "Tie-breaks" section and the widened "Points" section (wave 5; UI, Option A)

SPEC §9, D11, D3, OC1, OC2, B2 (SO row), D10(b), §10 copy. **Invoke `frontend-design:frontend-design` and apply it** in the house theme (owner: mocks are layout only). **No second options round (owner, 2026-10-20):** Option A (D11) is the chosen layout; build it directly, correctness-first. Rule rows X-TB-1, X-TB-2, X-TB-3, X-PT-3.

**Files:**
- Create: `W/components/v2/stage-rules/stage-tiebreaks-model.ts` (pure; every guard lives here so it has a unit killer), `W/components/v2/stage-rules/stage-tiebreaks-section.tsx`.
- Modify: `W/components/v2/stages-panel.tsx` — mount `StageTiebreaksSection` after `StagePointsSection` (W2c `:2549`) for table stages; it receives the panel's `formatLockedStageIds` prop (`:331`, the server's `formatLockedStageIds`, `W/server/usecases/stage-rules.ts:45`) (league, group, swiss, americano).
- Modify: main@e97823e4d8 `W/components/v2/stage-rules/stage-points-model.ts` + `stage-points-section.tsx` — rows = `reachableOutcomes`; SO row by `shootoutAs`; volleyball row per reachable set score; preset chips from `tablePresets`; `POINTS_OUTCOME_UNCOVERED` inline. (W2c's inexpressible card and `divisionExpressible` were already deleted in Task 10, PS-3b.)
- Modify: `W/dictionaries/{en,es,fr,nl}/ui.json` (+ `pnpm i18n:gen-keys`): `div.detail.tiebreak.rule.<key>` for every new key and modifier; badges; "+ Add step"; reset and preset names (FIFA 2026 / UEFA / Classic, Pro League, 1/½/0, 3/1/0); "always first" / "always last"; the lock line "{stage} has started — its tie-breaks are pinned."; the cross-group line "Between groups: …"; the points rows including "after a shoot-out: counts as a draw; the winner gets +[1]".
- Create: `apps/web/e2e/stage-tiebreaks-w2d.spec.ts`; Modify: `apps/web/e2e/mobile.spec.ts` (the section at all seven widths; open the phone fold first, `toBeAttached` before visibility; every instance).
- Test: `W/components/v2/stage-rules/__tests__/{stage-tiebreaks-model,stage-points-w2d-model}.test.ts`.
- Create: `MUT/t15.json`, `MUT/t16.json`.

**Interfaces:**
- Consumes: `offerableKeys`, `validateCascade`, `tablePresets`, `reachableOutcomes`, `coverage`, `GET tableRules` typed `StageTableRules` (Task 13's export; its `tiebreakers.sportDefault` is the Reset target, PS-7b — the UI never calls `defaultTiebreakers`), `PUT /stages/{id}/rules`, the server's `formatLockedStageIds`.
- Produces:
  ```ts
  // PS-9h: the types this file reads. StageTableRules is Task 13's API type; the other two are defined here.
  export interface StageLike { readonly id: string; readonly kind: TableStageKind; readonly pooled: boolean; readonly bestNth: boolean; readonly tableRules: StageTableRules } // the panel's stage row, reduced to what the models read
  export interface PointsRow { readonly key: OutcomeKey; readonly value: number | null /* null = uncovered */; readonly fallback: boolean /* paid by coverage's fallback, e.g. loss.unplayed → loss */; readonly drawPlusBonus: number | null /* the SO row under shootoutAs 'draw_plus_bonus': the winner's +soBonus */ }
  export type TiebreakBadge = { kind: "inherited"; from: "division" | "sport" } | { kind: "overridden" } | { kind: "pinned"; from: TableRulesSource };
  export interface TiebreakRow { key: TiebreakerKey; pinned: "first" | "last" | null; canUp: boolean; canDown: boolean; canRemove: boolean; refusal?: CascadeRefusal }
  export function tiebreakRows(keys: readonly TiebreakerKey[], ctx: CascadeContext, locked: boolean): TiebreakRow[];
  export function addableAt(keys: readonly TiebreakerKey[], position: number, ctx: CascadeContext): readonly TiebreakerKey[]; // === offerableKeys
  export function tiebreakBadge(tableRules: StageTableRules): TiebreakBadge;
  export function sectionLocked(stageId: string, formatLockedStageIds: readonly string[]): boolean; // the SERVER's lock answer (W2c's predicate: first score, or an opened online round — PF-9, PS-6), never activation (OC2) and never a client-side hasScore
  export function resetOrder(tableRules: StageTableRules): readonly TiebreakerKey[]; // = tableRules.tiebreakers.sportDefault (PS-7b)
  export function crossGroupLine(stage: StageLike): readonly TiebreakerKey[] | null; // pooled + best-Nth only
  export function pointsRows(reachable: readonly OutcomeKey[], rule: PointsRule): PointsRow[]; // the SO row reads rule.shootoutAs (PS-9h: no duplicate argument)
  ```

- [ ] **Step 1: Write the failing unit tests.** `stage-tiebreaks-model.test.ts`:
  ```ts
  it("X-TB-3 non-Swiss: row 1 is the primary measure pinned 'first' (no arrows, no remove); the last row is lots pinned 'last'", …);
  it("X-TB-3 OC1 a Swiss stage shows no pinned rows (its shape is W3's)", …);
  it("+ Add step offers exactly offerableKeys at that position; h2h modifiers only directly after an h2h step (forEachSport × kind, counted)", …);
  it("X-TB-1 badge: Inherited from division / sport default; Overridden when own; Pinned at start from activation with its source", …);
  it("X-TB-2 OC2 editable between activation and the first score; locked (no arrows/remove/add/reset) once the server lists the stage in formatLockedStageIds", …);
  it("PF-9 / PS-6 an online stage with an opened round and no score is locked because the server says so (formatLockedStageIds holds it), not because of a score; the empty list locks nothing", …);
  it("an inherited division default invalid for this stage marks the inherited step and returns the 'set this stage's own order' hint", …);
  it("football reset offers FIFA 2026 / UEFA / Classic from tablePresets; other sports one 'sport default' = tableRules.tiebreakers.sportDefault (PS-7b; a fixture whose sportDefault differs from the stage's current order)", …);
  it("the cross-group line shows only for a pooled stage with best-Nth progression, and holds no h2h key", …);
  ```
  `stage-points-w2d-model.test.ts`:
  ```ts
  it("X-PT-3 rows are exactly reachableOutcomes: IIHF shows OT and shoot-out rows; recreational shows a draw row and none of them", …);
  it("B2 football/hockey SO row reads 'counts as a draw; the winner gets +soBonus'; ice hockey shows won/lost after a shoot-out", …);
  it("VB-PT-3 volleyball best of 5 shows one row per reachable set score; a two-pair map missing 3-1 marks it uncovered", …);
  it("cricket shows tie and no result; TT shows 'a loss not played'", …);
  it("chess presets 1/½/0 and 3/1/0 on a round robin; 3/1/0 absent on Swiss", …);
  it("W2c's inexpressible notice stays gone: no key POINTS_RULE_INEXPRESSIBLE is referenced (source scan of stage-rules/, files scanned > 0) — green from Step 2 on, because Task 10 deleted it; kept as the guard", …);
  ```
- [ ] **Step 2: Run, expect FAIL.** `cd WT/apps/web && rm -f "$TMPDIR/w2d-t15.json" && pnpm exec vitest run src/components/v2/stage-rules/__tests__/stage-tiebreaks-model.test.ts src/components/v2/stage-rules/__tests__/stage-points-w2d-model.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t15.json"; echo EXIT=$?`
- [ ] **Step 3: Implement** the models, then the sections rendering the models' answers (the components decide nothing a model does not).
- [ ] **Step 4: Run, expect PASS**; regression (PS-9d; judged, `files` = 4): `cd WT/apps/web && pnpm exec vitest run src/components/v2/stage-rules/__tests__/stage-points-model.test.ts src/components/v2/stage-rules/__tests__/stage-points-section.test.tsx src/components/v2/stage-rules/__tests__/stage-row-model.test.ts src/components/v2/stage-rules/__tests__/stage-rule-fields.test.tsx --reporter=json --outputFile="$TMPDIR/w2d-t15r.json"; echo EXIT=$?`; all three tscs; eslint; `pnpm i18n:check`.
- [ ] **Step 5: Write the e2e** `stage-tiebreaks-w2d.spec.ts` (run whole, no `-g`): inherit → override (move a step, add `set_diff`) → an invalid step shows its reason inline → reset to sport default → generate fixtures (badge "Pinned at start", still editable) → first score → pinned and locked (arrows hidden, lock line) → the points rows are exactly the reachable outcomes for a football group stage with shootout on; axe on both sections; no horizontal scroll. Add the section to `mobile.spec.ts`. **CI dispatch** (Global Constraints) and judge this file and `mobile.spec.ts` at all seven projects; re-run `mobile.spec.ts` until a full pass (serial floor).
- [ ] **Step 6: Mutate** `MUT/t15.json` / `t16.json` (unit killers only): `sectionLocked` returns true for every activated stage (killed by the OC2 case); `sectionLocked` ignores `formatLockedStageIds` and reads a score flag (killed by the PF-9 case); `resetOrder` returns the current order (killed by the reset case); Swiss rows pinned (killed by OC1 case); `pointsRows` shows unreachable rows (killed by X-PT-3).
- [ ] **Step 7: Sign-off.** Screenshots at **1280 only** (Swiss, football group pre-start, pinned, locked; points for football and ice hockey), with per-screen verdicts in the report.
- [ ] **Step 8: Commit** `feat(ui): stage Tie-breaks section and reachable-outcome points (W2d T15+T16)`.

Test types: unit (models); e2e `stage-tiebreaks-w2d.spec.ts` + `mobile.spec.ts`; smoke → Task 13 `w2dTables` "an invalid order is refused by name" and "GET tableRules says where the order came from" (the write and the read this UI makes; RULES.md:104-110, PS-9e); regression above. Sequence: inherited → own → invalid → reset → activated → scored → after a void of that score (still locked) → another sport.

---

### Task 17: The public table — columns, half-points, OTW/OTL, lots note, empty table (wave 5, after 15+16)

SPEC §5.7, §6 W6/W8/B2, §9 public table, D10(b), anti-goals 2 (the popover half) and 3. Rule rows X-TB-4 (display), X-TB-6, BG-PT-1, IH-PT-1 (columns), HK-TB-2 (the field-goals column; the ranking half is Task 14's).

**Files:**
- Modify: `E/competition/display.ts` — a column per new key (set difference, point difference, field goals, SB in round robin, tennis game ratio ST-G29); IIHF `OTW`/`OTL` (= `won_ot + won_so`, `lost_ot + lost_so`, RBG:343-344); recreational GP W D L; chess `unit:"half"` renders `pointsToText` ("1½").
- Modify: `W/server/public-site/standings-view.ts` (`standingsColumns`), `W/components/public-site/standings-table.tsx` (popover), `W/lib/tiebreak-label.ts:21` — new key labels, "Drawn by lots on {date}", "head-to-head not complete" (`h2h_incomplete`, Task 12), "head-to-head applies to two teams only" (`h2h_two_not_applicable`, Task 4), "level"; the empty table renders every rank "–" and no leader styling or qualification chips.
- Modify: the division page (`W/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:960-979`) — the read-only caption becomes per stage, with source and pinned.
- Modify: `tools/matrix/lib/browser/pages/standings.ts` — re-checked against the new columns (SPEC §6 B2).
- Modify: `W/dictionaries/{en,es,fr,nl}/public.json` (+ `ui.json` for the caption), `pnpm i18n:gen-keys`.
- Modify: `apps/web/e2e/standings-popovers.spec.ts` (lots note, level, head-to-head not complete, head-to-head for two only), `apps/web/e2e/mobile.spec.ts` (new columns at seven widths, no horizontal scroll).
- Modify: `scripts/smoke.ts` — `w2dTablesSuite` gains the check "public standings carry drawnAt and level" (PS-9e).
- Test: `E/competition/display-w2d.test.ts`, `W/server/public-site/__tests__/standings-view-w2d.test.ts` (new).
- Create: `MUT/t17.json`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  it("BG-PT-1 chess 3 half-points print '1½' (D10(b), RB2B-17)", …);
  it("IH-PT-1 IIHF prints OTW/OTL as OT+SO sums; recreational prints GP W D L (RBG:343-344)", …);
  it("a column per new key in the order: set_diff, point_diff, field_goals, SB (round robin), game ratio — only when the key is in the effective order (ST-G29)", …);
  it("X-TB-6 an empty table renders every rank '–', no leader row, no qualification chip", …);
  it("X-TB-4 a lots-decided row's popover says 'Drawn by lots on {date}' from tieBreak.drawnAt", …);
  it("anti-goal 2 a class of three on a badminton h2h_two step: the popover says head-to-head applies to two teams only (note h2h_two_not_applicable), and a class of two shows no such note (the positive pair)", …);
  it("the division caption is per stage and says where its order came from and that it is pinned", …);
  ```
- [ ] **Step 2: Run, expect FAIL.** `cd WT/packages/engine && rm -f "$TMPDIR/w2d-t17e.json" && pnpm exec vitest run src/competition/display-w2d.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t17e.json"; echo EXIT=$?` and `cd WT/apps/web && rm -f "$TMPDIR/w2d-t17w.json" && pnpm exec vitest run src/server/public-site/__tests__/standings-view-w2d.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t17w.json"; echo EXIT=$?`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS** (the Step 2 commands); regression (judged, `files` = 1 each): `cd WT/packages/engine && pnpm exec vitest run src/competition/display.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t17er.json"; echo EXIT=$?` and `cd WT/apps/web && pnpm exec vitest run src/server/public-site/__tests__/standings-view.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t17wr.json"; echo EXIT=$?`; all three tscs; eslint; `pnpm i18n:check`. Smoke: `$S rebuild --label w2d`, then `cd WT && SMOKE_ONLY=w2dTables SMOKE_BASE=http://localhost:<port> pnpm smoke; echo EXIT=$?`. E2E by CI dispatch: `standings-popovers.spec.ts` and `mobile.spec.ts`, judged per file. Assertions on HTML bodies anchor on `="` (`$undefined` trap).
- [ ] **Step 5: Mutate** `MUT/t17.json`: `pointsToText` bypassed (killed by BG-PT-1); empty-table branch removed (killed by X-TB-6); the `h2h_two_not_applicable` label dropped (killed by the anti-goal 2 case).
- [ ] **Step 6: Sign-off** at 1280 (chess RR, IIHF, an empty table, a lots tie popover) with per-screen verdicts.
- [ ] **Step 7: Commit** `feat(public): standings columns, half-points, OTW/OTL, lots note and the level empty table (W2d T17)`.

Test types: unit (engine display + web view); e2e `standings-popovers.spec.ts` + `mobile.spec.ts` (CI dispatch); smoke `w2dTables` "public standings carry drawnAt and level" (PS-9e); regression above. Sequence: empty table → one fixture → a lots tie → a void that re-levels it → another sport.

---

### Task 18: Hockey — the goal type becomes a required pad choice (wave 5, after Task 17)

SPEC §5.6 `field_goals` row, B3; plan finding PF-2. **Invoke `frontend-design:frontend-design`**; phone composition rules apply (one DOM, `max-md:` branches; control-set diff at 320 vs 1280). **Owner chose option A (2026-10-20, after a clickable mockup):** the goal tap opens the kind chips (Field goal / Penalty corner / Penalty stroke), and the soft-commit timer waits until one is chosen; Cancel drops the goal. Option B (three goal tiles per side) was rejected. Rule row HK-TB-2.

**PS-7d, owner 2026-10-24:**
- A strict untyped hockey goal is refused with the named engine code `GOAL_KIND_REQUIRED`. The refusal is pad-visible, so this amends SPEC §10, which called it `CONFIG_INVALID` "never shown to an organiser" (recorded in PF-15; the spec text itself is not edited by this plan).
- The dock offers exactly three kind chips (owner option A): Field goal (`fg`), Penalty corner (`pc`) and Penalty stroke (`stroke`), from hockey's `goalKinds` (`E/sports/hockey/hockey.ts:133`).
- An own goal stays on its existing control, the dock's `ownGoal` flag (`period-shared.ts:1567-1572`, sending `kind: "og"`). It counts as a field goal for the side it is credited to (HK-TB-2, B3). The chips gain no own-goal chip; SPEC §9's four-type list is superseded by option A.

**Files:**
- Modify: `E/sports/period/kernel.ts` — preset flag `goalKindRequired: boolean` (hockey true; ice hockey false); in `applyGoal :1094`, `if (strict && state.cfg.goalKindRequired && payload.kind === undefined) throw GOAL_KIND_REQUIRED`. **Strict only** (PF-2): replay stays lenient, so the frozen golden hockey streams with `{"by":"H"}` still fold (an untyped legacy goal counts as a field goal, B3's definition).
- Modify: `E/core/errors.ts` (+ `errors.test.ts`) — `GOAL_KIND_REQUIRED`.
- Modify: `W/server/api-v1/http.ts` — `ENGINE_HTTP` (`:28`, typed `Record<EngineErrorCode, number>`, so tsc demands the row) gains `GOAL_KIND_REQUIRED: 422`, beside `INVALID_EVENT`.
- Modify: `E/sport/fold-epoch.ts` — hockey MAJOR 3 → 4 (Task 3 took it 2 → 3, PS-1; the write path now refuses what an older phone sends; the lineup precedent in the file's header); `FOLD_MINOR` unchanged.
- Modify: `E/testkit/conformance-pad.ts` — the hockey goal generator always sends a kind (else conformance turns red under strict).
- Modify: `W/components/v2/scorepad/v3/skins/period-shared.ts:1555-1572` — the loop stops skipping `fg` (it becomes the first chip, "Field goal"), keeps skipping `og` (the `ownGoal` flag stays as it is); `types.ts` `DockSpec` gains `requires` if option A needs it. Also the pad error copy for `GOAL_KIND_REQUIRED` and `W/dictionaries/{en,es,fr,nl}/ui.json` (`pad.hockey.kind.fg` "Field goal", the refusal copy).
- Create: `apps/web/e2e/scorepad-v3-hockey-goal-type.spec.ts`; Modify: `apps/web/e2e/mobile.spec.ts` (the hockey pad at seven widths).
- Test: `E/sports/period/goal-kind-required.test.ts`, `W/components/v2/scorepad/v3/__tests__/hockey-goal-type.test.ts` (new; the pure dock/commit helper).
- Create: `MUT/t18.json`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  it("HK-TB-2 B3 a strict hockey.goal with no kind is refused GOAL_KIND_REQUIRED (PS-7d: the named code, not CONFIG_INVALID)", …);
  it("PS-7d an own goal (kind 'og', the existing ownGoal control) is accepted under strict and counts as a field goal for the credited side", …);
  it("HK-TB-2 replay of a ledger holding an untyped goal still folds and counts it as a field goal (golden stays byte-identical)", …);
  it("ice hockey goals without a kind are still accepted (another sport)", …);
  it("fold-epoch: FOLD_EPOCH.hockey is 4 (Task 3's 3, plus this task's major; PS-9c — no git in vitest)", () => { expect(FOLD_EPOCH.hockey).toBe(4); });
  it("the pad cannot commit a hockey goal until a kind is chosen; Field goal is an explicit choice (pure helper)", …);
  it("PS-7d the hockey dock's kind chips are exactly Field goal, Penalty corner, Penalty stroke (from hockey's goalKinds minus og), and ownGoal stays a flag, not a kind chip", …);
  it("an own goal commits through the ownGoal flag without a kind chip (its kind is og)", …);
  ```
- [ ] **Step 2: Run, expect FAIL.** `cd WT/packages/engine && rm -f "$TMPDIR/w2d-t18e.json" && pnpm exec vitest run src/sports/period/goal-kind-required.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t18e.json"; echo EXIT=$?` and `cd WT/apps/web && rm -f "$TMPDIR/w2d-t18w.json" && pnpm exec vitest run src/components/v2/scorepad/v3/__tests__/hockey-goal-type.test.ts --reporter=json --outputFile="$TMPDIR/w2d-t18w.json"; echo EXIT=$?`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; regression (judged; `src/sports/hockey` holds no test file, so it is not a target — PS-9d): engine `src/sports/period/period.test.ts src/sports/period/period-audit.test.ts src/sports/period/padspec.test.ts src/testkit/conformance-pad.test.ts src/testkit/golden.test.ts src/testkit/golden-policy.test.ts` (`files` = 6), web `src/components/v2/scorepad/v3/__tests__/period-pair.test.ts` (`files` = 1); `cd WT && pnpm --filter @onryde/seazn-engine fold-epoch:check --against HEAD^1; echo EXIT=$?` (PS-9c); all three tscs; eslint; `pnpm i18n:check`. E2E by CI dispatch: the new spec and `mobile.spec.ts`. Smoke: `w2dTablesSuite` "an untyped hockey goal is refused by name".
- [ ] **Step 5: Mutate** `MUT/t18.json`: drop `strict &&` (killed by the replay case); drop the `goalKindRequired` test (killed by the ice-hockey case); refuse `og` too (killed by the own-goal case); the dock keeps skipping `fg` (killed by the three-chips case).
- [ ] **Step 6: Sign-off** at 1280 plus the 320 vs 1280 control-set diff (phone composition rule) with verdicts.
- [ ] **Step 7: Commit** `feat(hockey): the pad records every goal's type; strict refusal of an untyped goal (W2d T18)`.

**Wave 5 close:** whole-wave review; gate; proof commit; **walkthrough** at 1280 through the stage editor, a scored hockey and chess stage, and the public table; per-screen verdicts in IDX.

---

### Task 19: Walkthrough e2e per sport family, and the regression map (wave 6)

SPEC §13.7, §5.2 pad finding (football kicks in a GROUP stage), "Regression". Owner rule: a walkthrough after each task group.

**Files:**
- Create: `apps/web/e2e/walkthrough/tables-w2d.spec.ts` — one `describe` per family; each sets an order in the editor, scores through the pad, and reads the public table order and columns:
  - goals: football group stage with shootout on — the pad offers kicks in the group stage (a red here is a W2d defect, SPEC §5.2), D + 1 on the table; hockey Pro League with typed goals and the field-goals column; ice hockey OT and GWS → OTW/OTL; best-third across groups (Task 12).
  - sets: volleyball best of 3 (2:1), badminton BWF order, table tennis walkover (loser 0).
  - tennis: matches played above set ratio.
  - cricket: a tie (1 each) and a no-result.
  - boards: chess round robin "1½" and SB; carrom.
  - generic.
  - the pin (SPEC §13.8, traced from Task 7): `test("pin: a started stage's public table does not move after the division default changes", …)` — generate and score a stage, edit the division default order in Settings, and the public table's order and points are unchanged, while a new pending stage takes the edit.
- Create: the regression map in the PR-body draft (`$TMPDIR/w2d-pr-body.md`): each closed gap (ST-G2, G4, G9, G10, G12, G13, G16, G29, SC-P10, SC-S9, F11, P20–P25) → the test title that was red first in its task (taken from the task reports), and the commit that turned it green.

- [ ] **Step 1: Write the spec**; CI dispatch; judge this file (`unexpected == 0`, `expected > 0`). A red is fixed in the owning task's files, never by loosening the walkthrough.
- [ ] **Step 2: Write the regression map**; every row has a test title and a red-first record; a row without one is a gap the orchestrator sends back to its task.
- [ ] **Step 3: Commit** `test(e2e): W2d table walkthroughs per sport family (W2d T19)`.

---

### Task 20: MD-1 — Stryker on the engine files W2d owns, every survivor classified (wave 6)

SPEC §14. Before/after in the PR body.

- [ ] **Step 1: The "before" scores.** `competition/tiebreakers.ts`: the W1d baseline, 197 survived / 503 killed / 13 timeout of 713 ≈ 72.4% (`truth-runs/w1d-baseline/MUTATION.md:174-177`). `competition/points.ts`: re-measured on a detached worktree at `W2D_BASE` (the W1d baseline is stale after W2c's +140/−21): `cd <detached>/packages/engine && pnpm exec stryker run --mutate "src/competition/points.ts"` → record.
- [ ] **Step 2: The "after" runs, per file, never group=all locally:**
  ```bash
  cd WT/packages/engine && pnpm exec stryker run --mutate "src/competition/tiebreakers.ts" > "$TMPDIR/w2d-md1-tiebreakers.log" 2>&1; echo EXIT=$?
  cd WT/packages/engine && pnpm exec stryker run --mutate "src/competition/points.ts:<W2d lines>" > "$TMPDIR/w2d-md1-points.log" 2>&1; echo EXIT=$?
  cd WT/packages/engine && pnpm exec stryker run --mutate "src/competition/{cascade-rules,table-rules,decided-in}.ts" > "$TMPDIR/w2d-md1-new.log" 2>&1; echo EXIT=$?
  ```
  plus W2d's moved lines in `stage.ts`, `progression.ts` and the sport modules (`node scripts/stryker-changed.mjs --base "$W2D_BASE"`). The CI legs competition-6/-7 (split at `directRefine`, `stryker.groups.mjs`) are dispatched for the cross-check.
- [ ] **Step 3: Classify** every Survived and NoCoverage: A-real (a killing test, expected value from the rulebook), A-msg, B-equivalent (`packages/engine/stryker-equivalent.json` + proof), C-dead (caller search named). Escalate above 150 survivors in one run. Treat static survivors as suspect until P0 lands.
- [ ] **Step 4: Floors.** `stryker-floor.json` competition 77.9 is never lowered; the PR body carries per-file counts and before/after scores.
- [ ] **Step 5: Commit** the killing tests and `stryker-equivalent.json` rows: `test(engine): MD-1 classification for W2d's engine lines (W2d T20)`.

---

### Task 21: Orchestrator — fold, ship gates, PR, e2e dispatch (wave 6)

SPEC §15.4–5, §12.3, §16.

- [ ] **Step 1: Fold.** D1–D11, B1–B5 and OC1–OC3 get ruling numbers after W2c's; the ruling 108 amendment text (SPEC §3); §4's false premises and this plan's findings; the MD-1 table row for `points.ts` (P13) → IDX. Rule rows → `signed <ruling> <date>` or `deviation <ruling> <date>`; `AWAITING_PROOF` is empty for W2d ids.
- [ ] **Step 2: W5 amendments** (D7, SPEC §12.3), same PR: `W5-round-robin.md:79-80` trap → "fixed in W2d (stored lots)"; `2026-09-27-format-matrix-design.md:455` W5 row drops ST-G4 and ST-G13; `IDX:4406,4408,4409` (the ST-G4, ST-G12 and ST-G13 rows; ST-G6 sits between them at `:4407` and is not W2d's) → W2d. ST-G3 has no IDX row; it stays W5 in `W5-round-robin.md:36`.
- [ ] **Step 3: Ruling-70 regression (SPEC §16).** Dispatch one judge regression over the `swiss_knockout` L3 cells; record any new P6 cell against ruling 70 rather than parking it.
- [ ] **Step 4: Gates.** The union of every task's scoped Step 4 on the final tree (never the full suite); `pnpm --filter @onryde/seazn-engine fold-epoch:check --against <merge-base>`; OpenAPI drift; `pnpm i18n:check`; a whole-branch `reviewer` pass (the three standing lenses).
- [ ] **Step 5: PR** (one PR, merge commit; body: per-wave verdicts, the regression map, MD-1 before/after, the staging pin counts from Task 7 Step 6, the planner's calls). Smoke runs on the PR. E2E by `gh workflow run e2e.yml --ref feat/format-matrix-w2d`, judged per spec file. Merge only on the owner's explicit go after any owner-run staging steps. Delete the lane worktrees.

---

## Appendix A — rule rows

The rows, their ids and their wording are SPEC Appendix A, signed in Task 0. Each id is proved by the task named in its first proving test title above; the orchestrator's per-wave proof commit fills `proved-by`.

## Plan findings

| # | Spec said / assumed | Tree says | Effect on the plan |
|---|---|---|---|
| PF-1 | §8: INFERRED that the production Swiss stage resolves to badminton's `defaultTiebreakers` | Confirmed by code: main@e97823e4d8 `competition.ts:492-494` `cascadeFor` reads `division.tiebreakers ?? module.defaultTiebreakers` for every stage kind | Task 7 pins Swiss stages with the same literal; Task 7 Step 6 still reads the live row |
| PF-2 | §5.6: "the engine refuses an untyped `hockey.goal`" | The frozen golden hockey streams hold untyped goals (`hockey.golden.json`, `{"by":"H"}`) and GOLDEN-POLICY forbids re-baselining; the pad treats `fg` as "the default and needs no chip" (`period-shared.ts:1555-1572`); the kernel already has a strict-only seam for declaration refusals (`kernel.ts:1110-1118`, `core/events.ts:990-1005`) | Task 18 refuses on the WRITE path only (`strict`), replay lenient, hockey `FOLD_EPOCH` MAJOR bump (3 → 4, after Task 3's PS-1 bump), `conformance-pad` sends a kind. The decision (refuse) stands; only where it is enforced is the planner's call. Task 3's PS-1 rebaseline re-records corpus STATES, not the event streams, so the untyped goals stay. The refusal code is `GOAL_KIND_REQUIRED`, owner 2026-10-24 (PS-7d, PF-15) |
| PF-3 | §8 lists the columns and table only | `public_stages_v.points_rule` rebuilds the OLD keys `base/bonuses/forfeit` (`V414__public_stages_qualification.sql:57-66,154-157`) and qualification reads it | Task 7 redefines the view to the pin's points or the new shape |
| PF-4 | §5.3: `payout(outcome, decidedIn, pair, played, rule)` | W2c `applyPointsRule` has a fifth parameter `scoreKeys: AwardScoreKeys` (`points.ts:174`) | `payout` keeps it as its sixth |
| PF-5 | §5.4: "including any insert that creates a stage already active" | Both stage inserts write `pending` (main@e97823e4d8 `stages.ts:575`, `templates.ts:356`); activation is only at fixture generation (status writes `stages.ts:2955`, `:3788`) | Task 9's census scan still enforces it for any future writer |
| PF-6 | §11 lists W2c readers of the points rule | More readers of the old shape exist: `stage-points-model.ts`, `points-line.ts`, `schemas.ts:18`, `fixture-cfg.ts`, `competition.ts:98,386` | Task 2 ports them mechanically so `tsc` stays green, and regenerates `openapi/*.json` (PS-3c) |
| PF-7 | §15.5 "e2e by workflow_dispatch" | `e2e.yml`'s only dispatch input is `pr`; a dispatch runs every job | Each UI task judges its named spec file from the run |
| PF-8 | §8 pins points and order | The pre-W2d cross-group order is hard-coded `points, diff, for, wins` (`progression.ts:573`); not pinning it would move best-third rankings of started stages, which B1 forbids | Task 7 pins `crossGroup` to that literal for migrated stages |
| PF-9 | W2c's Q3 lock (plan read at `2bcc66313b`): `lockedStageIdsAmong` counts PLAYED stages | `lockedStageIdsAmong` (`rule-locks.ts:74`) also counts a stage whose online round is opened (`stage_ids_with_opened_round`, an SQL function in V469; W2c rebase ruling D2), not only played stages | The W2d pin and the first-score lock (Tasks 9, 10) keep D2: a stage with an opened round counts as started for the lock. Tests reuse W2c's predicate rather than re-deriving "played" |
| PF-10 | `core.abandon` carries no no-result marker (plan read at `2bcc66313b`) | W2c rebase ruling D3: `core.abandon` takes an optional `noResult: true` (`E/core/events.ts:74`). Only `organiser_no_result` writes it; W2c's `settleAppliesInTable`/`rowAwaitsSettle` read it | Task 1's `decidedInFor` and Task 2's `reachableOutcomes`/`payout` map an abandoned fixture with `noResult: true` to the `noResult` outcome and keep W2c's table treatment unchanged. Tasks 1 and 2 first read `settleAppliesInTable` and `rowAwaitsSettle`, and cite the file:line of each |
| PF-11 | Stage-level rules are settable on every division (plan read at `2bcc66313b`) | W2c rebase ruling D1: a Lichess (online) division refuses stage-level clock and variant (reason `online_division`, `W/lib/rule-errors.ts:99`) | None on tie-breaks or points: stage-level order and points stay editable on online divisions. Task 10 must not route its new refusals through `online_division` |
| PF-12 | W2d's locks reuse W2c's lock codes (`STAGE_FORMAT_LOCKED`, `DIVISION_TABLE_RULES_LOCKED`) | Plain `FORMAT_LOCKED` (`replaceStages`) is not in `RULE_ERROR_STATUS` (`W/lib/rule-errors.ts:13`), while `DIVISION_FORMAT_LOCKED`, `DIVISION_TABLE_RULES_LOCKED` and `STAGE_FORMAT_LOCKED` are | Task 10's new lock refusals use `STAGE_FORMAT_LOCKED` / `DIVISION_TABLE_RULES_LOCKED` as planned, and add no new code to the unlisted family |
| PF-13 | Task 0 Step 5 (SPEC §11.2): a handover note to f-w2c, so W2c ships `soBonus`, a wider `STAGE_POINTS_REPLACES` and no tiebreakers branch in `divisionRefusals` | W2c merged (#1007) without those changes, and f-w2c is closed. `STAGE_POINTS_REPLACES` is still `{points, pointsMap}` (`rule-locks.ts:43`); the tiebreakers branch of `divisionRefusals` is at `:125-129` | Task 0 Step 5 is void. W2d makes those edits itself in Tasks 3 and 10 |
| PF-14 | Anchors at plan time: `FOLD_EPOCH` "hockey 2, football 2, …" | `FOLD_EPOCH` (`E/sport/fold-epoch.ts:20-32`) is hockey 2, football 2, boardgame/carrom/generic 3, and every other sport 1 | Every task that changes a sport's fold bumps from these values, not from the old ones |
| PF-15 | The plan as approved 2026-10-20 | Pre-flight scan 2026-10-24 (`.superpowers/sdd/2026-10-20-format-matrix-w2d/preflight-scan.md`, PS-1..PS-10) found false premises, stale pins, an unrunnable B1 seed and wave-order hazards | PS-1..PS-10 applied per the ledger's rulings (`progress.md` "Pre-flight scan rulings"). The main moves: T3 golden exception with an isolated REBASELINE commit and epoch majors; T9/T10/T13 smoke moves to T13; pairs sequential; T11 merges before T10; bench in scope; T7 seeding twin. **Owner 2026-10-24:** PS-7c = Option 1 (`defaultTiebreakers(kind, cfg)` through `resolveTableRules`; the football default omits `fair_play` when `fairPlay` is off, so it always passes `validateCascade`; T8, T11). PS-7d = the untyped hockey goal is refused with the named code `GOAL_KIND_REQUIRED`, which is pad-visible and **amends SPEC §10's `CONFIG_INVALID`**; three chips (Field goal, Penalty corner, Penalty stroke); own goal stays on its existing control and counts as a field goal; no own-goal chip (T18) |
| PF-16 | Verify commands written `pnpm --filter @seazn/engine …` | The engine package is `@onryde/seazn-engine` (`packages/engine/package.json`). A filter on `@seazn/engine` matches no project, and pnpm exits 0 having run nothing (seen 2026-10-24): a vacuous green | Every engine filter in this plan names `@onryde/seazn-engine`; a step that prints no script output is not a pass |

## Self-review

1. **Spec coverage.** §2.1 #1 → T8, T10, T15; #2 → T6, T10; #3 → T1; #4 → T2, T3, T10; #5 → T9, T10; #5a → T7, T9; #5b → T2, T3, T4; #6 → T4; #7 → T5, T9; #8, #9 → T12; #10 → T3, T11; #11 → T2, T3; #12 → T6, T10, T11; #13 → T17; #14 → T2, T3, T10; #15 → T2; #16 → T17. §2.3 anti-goals → T9 (1), T4/T6 (2), T5/T17 (3). §5.1–5.10 → T1–T12 as headed. §6: E1–E6 → T5, T8, T12; W1–W7 → T9; W8, W6 caption, B2 → T17; W9 → T13; W10 unchanged; W11 → T3's parity + T4 (B5); W12 → T10; bench B1 → T9 (in scope, PS-3). §7 → T13. §8 → T7. §9 → T15+16, T17, T18. §10 → T10, T13. §11 items 1–4 → T0, T10; §11 item 5 → T10 (behaviour test; the live catalog is re-checked in T10 Step 4 — if any plan reads `standings.custom_points` or `tiebreakers.custom` false, the `requireFeature` calls at `stages.ts:419,477` go, and only behaviour is tested). §12.3 → T21. §13 parts 1 → T11 (+T4, T12 differentials); 2 → T4, T5; 3 → T2, T4, T5, T10; 4 → T1, T3, T6, T11; 5 → T14; 6 → T20; 7 → T15+16, T17, T18, T19; 8 → T7, T9; smoke → T9–T18 (`w2dTablesSuite`), T14; regression → each task + T19's map. §14 → T20. §15 → T0, T21. §16 judge regression → T21. **Gaps found and fixed while writing:** the `tools/matrix` standings page (§6 B2) had no task → added to T17; §11 item 5's live-catalog check had no step → T10; the ruling-70 judge dispatch (§16) → T21; the view `public_stages_v` (PF-3) → T7; the pinned cross-group (PF-8) → T7.
2. **Step scan.** Function bodies appear only for the h2h block modifiers, `h2h_two`, the `lots` step and the B1 mapping table (undetermined by their signatures). Removed a parity allowlist row that did not differ (TT unplayed loss) and required every allowlisted row to actually differ.
3. **Type consistency.** `payout`/`reachableOutcomes`/`coverage`/`OutcomeKey`/`legacyPointsRule`/`parseStoredPointsRule` (T2) used by T3, T7, T9, T10, T15+16; `TableRules`/`TableRulesPin`/`TableRulesSource`/`resolveTableRules`/`defaultCrossGroup` (T8) by T9, T12, T13, T15; `membersKeyOf`/`newLotsDraws`/`countedFixtures` (T5) by T9; `offerableKeys`/`CascadeRefusal`/`CascadeContext` (T6) by T10, T15; `winsCount`/`gamePoints` (T1/T4) by T8; `tablePresets` (T11) by T15+16; `loadTableRules`/`repinStageOwnRules` (T9) by T10, T12, T13. `defaultTiebreakers(kind: TableStageKind, cfg: Cfg)` (T8, PS-7c) by T11 and through `resolveTableRules` only; `LoadedTableRules.sportDefault` (T9) by T13 (`StageTableRules`) and T15+16 (`resetOrder`).
4. **Review Focus.** Five lines, each with its test in the owning task (T9, T5+T9, T9, T10, T9 — Review Focus 5 moved from T8, PS-5e).
5. **Proportion.** The spec is 998 lines; this plan is well under 3× it, and its code blocks are signatures, test titles and assertions.

**Planner's calls** (none re-opens a decision): `validateCascade` moves to a new `cascade-rules.ts`; the Swiss editor shows no pinned rows (consequence of OC1); `pointsRuleExpressible` is deleted in T10 with its readers, not T2; `payout` runs at the existing web fold sites rather than inside `completeTableStage`; the B1 "before" comes from the pre-W2d code through an API scenario, and the pin is a SQL function the test can call again; the migrated `crossGroup` literal (PF-8); the hockey refusal is strict-only with a fold-epoch MAJOR and a `GOAL_KIND_REQUIRED` code (PF-2); football's default omits `fair_play` when `fairPlay` is off; a stored draw is superseded when a newer draw in the same pool shares a member; the `tablePresets` declaration; `outcomeMethods`/`reachableResultKinds`/`reachableSetScores` declarations (so totality and coverage are computable); `rngSeed` is a random 31-bit value at creation; Opus for every task.

## Execution handoff

**Owner-approved 2026-10-20.** Execution method: **subagent-driven** (owner chose it, 2026-10-20). A fresh implementer per task, a fresh reviewer before the next task, a walkthrough per task group, and a whole-branch review at the end. Starts at Task 0 once W2c merges.
