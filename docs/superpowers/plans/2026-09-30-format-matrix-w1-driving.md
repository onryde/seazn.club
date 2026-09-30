# Format × Sport Matrix — W1-driving (L3 driving breadth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every one of the 231 cells runs its four scripted scenarios over HTTP instead of reading ⏳ W1-driving. Today 177 of them are deferred: 33 on the ladder family, 99 on multi-stage rows and 45 on team sports. W1-driving adds:
- team rosters and lineups;
- multi-stage seed-proposal → confirm;
- ladder challenges;
- americano and mexicano rounds on linked persons;
- a per-format field size;
- the cricket two-innings and tie streams;
- structural champion rules for the non-knockout brackets;
- in-process parallel workers.

What an organiser gets: when W1d's truth run lands, a red on a league → knockout division, a football league or a padel americano is a product finding, not "the harness never tried".

**Architecture** (rulings 44–49, 2026-09-30):
- **One seam, more methods.** The new product calls are `OrganiserDriver` methods:
  - `putLineup`, `entrantMembers`, `confirmSeedProposal`, `recomputeSeedProposal`, `challenge`, `americanoView`, `createFromTemplate`;
  - `addEntrants` carries members.
  - `HttpDriver` implements every method over v1.
  - `BrowserDriver` delegates the setup-filler ones to its wrapped `HttpDriver` (ruling 47) and records them as filler in the mixed ledger.
  - The fakes implement them in memory, so every loop is proven DB-free first.
- **One play loop per stage kind, one division loop over stages.** `playDivision` does the following:
  1. generates every later stage's TBD placeholders right after Start;
  2. plays stage N with the kind's loop (generate loop, swiss rounds, ladder challenges, americano/mexicano rounds);
  3. completes stage N once;
  4. confirms the seed proposal on stage N+1;
  5. repeats.

  `snapshot` emits one `ObservedStage` per stage. A later stage's field is `"seeded"`: the entrants the confirm placed.
- **Routes are one typed construct.** Every place the harness names an owning wave goes through `routeTo(wave, why)`, or a deferral class the Q-A guard already reads. The guard reads all of them, counts them, and refuses a bare wave literal anywhere else (D7).
- **Workers are in-process** (ruling 46). `--workers N` gives N sessions, each with its own sign-in and cookie jar. They pull items off one queue and store results by plan index.
- **No product changes** (ruling 19). A product red is recorded in `_INDEX.md` and routed.

**Tech Stack:**
- Node 26 `--experimental-strip-types`: no enums, namespaces or parameter properties; `.ts` import suffixes.
- TypeScript 7 (`typescript-native`) via `tsconfig.scripts.json`.
- vitest 4 via `packages/engine`'s binary.
- zod 4, fast-check (a root dependency already, `scripts/matrix/__tests__/fast-check-resolution.test.ts`).
- Playwright 1.61.1 (library, chromium), for Task 13 only.
- pnpm 10.

**Spec:** `docs/superpowers/specs/2026-09-27-format-matrix-design.md` §6.1, §6.4, §7.3, §7.3a, §7.5, §8. The binding scope is the owner's rulings 28 and 44–49 in `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md` ("Owner rulings"), including the four items folded in beneath 49.
- Prompt: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/W1-driving.md`.
- `_RULES.md`: R1, R3, R8, R9, R11, R13, R14a, R17, R21–R25.
- `docs/superpowers/TEST-STRATEGY.md`: the house test authority, rules 1–5 and 10.
- `AGENTS.md`: failure classes 1, 3, 5, 7, 9, 13, 14, 19, 20.
- House style follows `docs/superpowers/plans/2026-09-29-format-matrix-w1c.md`.

Where the spec and the tree disagree, see **False premises found in planning** below. The tree wins.

---

## Step 0 — anchors (pinned 2026-09-30 against `98fc6d530` = `origin/main` `ebf7ec040` + rulings 44–49; the rows added at fix round 1 re-pinned against `c9e18e39a`)

| Fact | Where |
|---|---|
| `DRIVING_WAVE = "W1-driving"`; `FORMAT_LATER`; `MAX_ITERATIONS = 64` | `scripts/matrix/lib/scenarios/common.ts:91,93,95` |
| The three deferrals (ladder family, multi-stage, team) fire before any driver call | `scripts/matrix/lib/scenarios/common.ts:108,110,112` |
| `SetUpOptions { rosterlessTeams? }`: PADPROOF only | `scripts/matrix/lib/scenarios/common.ts:104`; `lib/scenarios/pad-proof.ts:53` |
| `setUpDivision` builds entrants `Matrix Player N` with no members, then `stage = stages[0]` | `scripts/matrix/lib/scenarios/common.ts:119-124` |
| `playStage` has a swiss round loop and a generate loop, and exits `drained`, `cap`, `refused_generate` or `empty_pair_round` | `scripts/matrix/lib/scenarios/common.ts:229-267`, `LoopExit` `:63` |
| `finishStage` reads `finalRanks` from the `stage_completed` event | `scripts/matrix/lib/scenarios/common.ts:299-309` |
| `snapshot` emits ONE stage, `fieldSource: "division"` | `scripts/matrix/lib/scenarios/common.ts:331-357` |
| `Recorder` has run-wide `generates`, `pairRounds` and `exit` | `scripts/matrix/lib/scenarios/common.ts:65-86` |
| Field size per scenario: `ENTRANTS` const: LIFECYCLE 8, M1 8, R4 8, F1 7 | `lib/scenarios/{lifecycle,m1-walkover,r4-withdrawal,f1-odd-field}.ts` |
| `OrganiserDriver` methods | `scripts/matrix/lib/driver/types.ts:65-101` |
| `FixtureRow` has no `ext_key` / `is_final`; `CompleteOut` has no `seed_proposal` | `scripts/matrix/lib/driver/types.ts:21-24` |
| `HttpDriver.addEntrants` posts `{kind, display_name, seed}` | `scripts/matrix/lib/driver/http-driver.ts:128-132` |
| `/complete` is never repeated (`DriverMisuse`) | `scripts/matrix/lib/driver/http-driver.ts:217-239` |
| `OVERRIDE_WAVE = "W1-driving"`; thrown as `NoOrganiserPath` | `scripts/matrix/lib/driver/browser-driver.ts:121,401` |
| `TEMPLATE_ONLY_CELLS`, `TEMPLATE_DRIVING_WAVE = "W1-driving"`, `API_ONLY_UI_WAVE` | `scripts/matrix/lib/api-only-ui.ts:15,17-19` |
| Mixed exemptions must match `/→ W\d\|→ W1-driving/` | `scripts/matrix/lib/driver/mixed.ts:21-22,82` |
| `KNOWN_NO_PATH`, `KNOWN_UI_NO_PATH`: bare wave literals | `scripts/matrix/lib/scenario-catalogue.ts:144,149` |
| `counts.ts` `routedTo: "W2"` / `"W1-driving"`: bare literals | `scripts/matrix/lib/counts.ts:121-122` |
| Q-A guard: `DEFERRALS = {ScenarioUnsupported:0, RowBuildDeferred:1}`, `scanDeferrals`, `isOpen`, `shipped`; anti-vacuity on `sites > 0` and `deferred.size > 0` | `scripts/matrix/__tests__/scenario-catalogue.test.ts:548-669` |
| `RowBuildDeferred` is declared but never constructed | `scripts/matrix/lib/catalogue.ts:86-97` |
| `HarnessGap {when, reason}`; the M5 cricket tie gap | `scripts/matrix/lib/applicability.ts:249,300-303` |
| `LEVEL_PROBES.cricket` answers null when `ballsPerInnings` is not a number | `scripts/matrix/lib/applicability.ts:101-122` |
| `RequestedOutcome`: win/draw/forfeit/abandon, no tie; `ALL_OUTCOMES` has 6 | `scripts/matrix/lib/streams/types.ts:5-9`; `fold.test.ts:135` |
| `cricketGenerator` refuses `inningsPerSide !== 1` and draws | `scripts/matrix/lib/streams/cricket.ts:38-54` |
| `KNOWN_UNSUPPORTED` holds cricket two-innings only | `scripts/matrix/lib/streams/known-unsupported.ts` |
| Engine cricket `test` preset: `inningsPerSide 2`, `ballsPerInnings null`, `followOn {enabled, lead 200}`, draw 1 pt | `packages/engine/src/sports/cricket/cricket.ts:3559-3567` |
| `generatePagePlayoff`: exactly 4 (`pp-q1`, `pp-elim`, `pp-q2`, `pp-final` isFinal) | `packages/engine/src/scheduling/bracket.ts:382-395` |
| `generateStepladder`: `sl-g0..sl-g(k-2)`, last isFinal | `packages/engine/src/scheduling/bracket.ts:406-437` |
| `generateDoubleElim`: `gf` isFinal, `gf-reset` isFinal when `bracketReset` | `packages/engine/src/scheduling/bracket.ts:340-360` |
| Division fixture list serves `ext_key`, `lane`, `is_final`, `third_place` | `apps/web/src/server/usecases/stages.ts:162,222`; `app/api/v1/divisions/[id]/fixtures/route.ts` |
| Every progression body the builder writes has `timing: "setup"` | `apps/web/src/components/v2/format-templates.ts:13,80,155,168,179,209,234,281` |
| Take kinds in builder bodies: `rankRange`, `topNPerGroup`, `bestNth`, `roundLosers` | `apps/web/src/components/v2/format-templates.ts:78,121,140,279` |
| A later "setup" stage needs its own generate (TBD rows). It must exist BEFORE the source completes, else `409 STAGE_COMPLETED_SEEDING_FAILED` | `apps/web/src/server/usecases/stages.ts:2240-2280,3203+,4176+` |
| `/complete` answers `seed_proposal {id, status}` for the next stage | `apps/web/src/server/usecases/stages.ts:4176+` |
| `POST /stages/{id}/seed-proposal` (201, recompute) and `POST …/seed-proposal/confirm`; there is **no GET** | `apps/web/src/app/api/v1/stages/[id]/seed-proposal/route.ts`, `…/confirm/route.ts` |
| `ConfirmSeedProposal {proposalId, edits?, tiePicks?[{slots: string[], order: uuid[]}]}` → `{proposalId, filled, fixtures}` | `apps/web/src/server/api-v1/schemas.ts:4839-4851` |
| `SeedProposal.computed {qualifiers[{rank, source, entrantId, destinationSlot}], ties[{slots, entrantIds, reason}]}` | `apps/web/src/server/api-v1/schemas.ts:4801-4838` |
| Ladder: generate creates nothing; `POST /stages/{id}/challenges {challenger_id, opponent_id}` → `{fixture_id, ladder_order}` (201) | `apps/web/src/server/usecases/stages.ts:~2397,5503-5590`; `app/api/v1/stages/[id]/challenges/route.ts` |
| Ladder refusals: `LADDER_ENTRANT_FOREIGN`, `LADDER_ENTRANT_WITHDRAWN`, `LADDER_CHALLENGE_NOT_UPWARD`, `LADDER_CHALLENGE_OUT_OF_RANGE`; the first challenge writes `ladder_order` by seed | `apps/web/src/server/usecases/stages.ts:5539-5640` |
| Americano needs ≥4 entrants with a linked person, else `STAGE_NOT_READY`; `personOf` reads every member row with no kind filter and no `order by`, so a team entrant yields one arbitrary member (false premise 10) | `apps/web/src/server/usecases/stages.ts:744-754` |
| Mexicano waits while any fixture of the stage is not `decided` | `apps/web/src/server/usecases/stages.ts:769` |
| A walkover fixture is stored `forfeited` | `apps/web/src/server/engine-db/append-event.ts:147` |
| Withdrawal: `mine.length === 0 → continue`; open formats void pending and report `walkover` only when something was pending; `page_playoff` is not in `BRACKET_WALKOVER_KINDS` | `apps/web/src/server/usecases/withdrawal.ts:166,213-217`; `usecases/stages.ts:880-884` |
| M1 finds seed 1 by entrant id; R4 fires on `round === 1` and asserts `policy !== "none"` | `scripts/matrix/lib/scenarios/m1-walkover.ts:25,47`; `r4-withdrawal.ts:75,109` |
| L2 numbering is global with a lap shift per 7-pick scenario; F1 `page_playoff_only` is run 801 of 1,732 | `scripts/matrix/lib/pairs.ts:132-165`; `catalogue/l2-pairs.json` |
| The probe's API rows are single-stage only (comment names W1-driving) | `scripts/matrix/lib/probe-set.ts:36-39,58` |
| Start gates: `PlanLacksGate` covers feature gates only; `planLimit` exists on the DB seam | `scripts/matrix/run.ts:333-369,713-717`; `:132` |
| Americano grid: `GET /stages/{id}/americano` → `{rounds[{round_no, matches[{fixture_id, team1{entrant_id}, team2}]}], leaderboard[{person_id, …}]}` | `apps/web/src/server/usecases/americano.ts` |
| Inline member: `{new_person: {full_name}, squad_number, is_captain}`; ≤40 members | `apps/web/src/server/api-v1/schemas.ts:563-589` |
| `PatchEntrant.members`: full replacement with `person_id` | `apps/web/src/server/api-v1/schemas.ts:634-648` |
| `CreatePerson {full_name, consent default {}}` | `apps/web/src/server/api-v1/schemas.ts:665-680` |
| `PutLineup {slots[{person_id, slot, position_key?, order_no?, roles}]}`, `PUT /fixtures/{id}/lineups/{entrantId}` | `apps/web/src/server/api-v1/schemas.ts:1523-1555` |
| `resolvePositions(module, cfg)` → `{groups[{key, min?, max?}], roles?[{key, unique?, required?}], lineup{size, benchMax?}}`; `validateLineup` → `LineupIssue[]` | `packages/engine/src/sport/catalog.ts:29-110` |
| `CreateFromTemplate {template_key, template_version?, name, starts_on?, ends_on}` → `{competitionId, slug, divisions[{id, stages[{id, fixtureCount}]}]}` | `apps/web/src/server/api-v1/schemas.ts:1185-1215` |
| Template cards `template-card-<key>`; box-league = badminton `short` group ×4, 16; t20-super8 = cricket `t20` group ×4 → group ×2 → KO 4, 16 | `apps/web/src/components/v2/template-gallery.tsx:242`; `server/templates/catalog/{box-league,t20-super8}.json` |
| `execute`: ONE sign-in, sequential `for` over items | `scripts/matrix/run.ts:668-735` (`:692` comment) |
| `--only` goes through `checkSliceFilter` and admits the 6 slice cells only | `scripts/matrix/run.ts:786`; `lib/slice.ts:44-48` |
| `newModelState` refuses multi-stage (`:256`) and team (`:259`) with plain `Error` | `scripts/matrix/lib/model/state.ts:250-285` |
| `modelCommands({fences})`: uniform over `COMMAND_KINDS` | `scripts/matrix/lib/model/commands.ts:386-388` |
| Model `--cell` admits the slice cells only | `scripts/matrix/model.ts:175-180` |
| Drop list: 0 drops today for LIFECYCLE, M1, R4a, F1 | `scripts/matrix/catalogue/drop-list.json` `groups` |
| `I2` champion branch is `s.kind === "knockout"` only | `scripts/matrix/lib/invariants.ts:98-134` |
| `INVARIANTS = [I1…I8]`; `evaluateInvariant` fails `checked 0` | `scripts/matrix/lib/invariants.ts:358-375` |
| Frozen plan per committed run; a new run adds its entry | `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/plans.lock.json`; `__tests__/committed-plans.ts` |

Before building on any line above, the executor pins it again (AGENTS class 5). A line that has moved is a note in the task report, not a blocker. A line whose MEANING is false is a false premise: record it, then continue.

---

## Global Constraints

- **Worktree and branch.**
  - Execution gets its own worktree: `/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1-driving-exec`, branch `feat/format-matrix-w1-driving`. It is created from the tip of the planning branch `docs/format-matrix-w1-driving-plan`, which is `origin/main` `ebf7ec040` plus the rulings commit `98fc6d530` plus this plan's commit, so no cherry-pick is owed (Task 1 Step 0).
  - Every shell command starts `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1-driving-exec && …`, because cwd resets between calls.
  - Never edit the main checkout. Never `git stash`: the stash stack is shared.
  - No heredocs. Write commit messages with the editor tool into `$TMPDIR/w1drv-msg.txt`, then `git commit -F "$TMPDIR/w1drv-msg.txt" -- <paths>`.
  - Every message ends with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **pnpm, never npm install.** A fresh worktree has no `node_modules`, so run `pnpm install --frozen-lockfile` first. No task changes the lockfile.
- **Local verification = ONLY the tests that cover the files you changed** (owner, 2026-09-28). Never the full gate, the full vitest suite or the full e2e suite. W1-driving touches no `apps/web/e2e` spec.
  - The vitest template, with `<N>` = the task number and `<files>` = the exact test paths:
    ```bash
    cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1-driving-exec && rm -f "$TMPDIR/w1drv-t<N>.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w1drv-t<N>.json" --testTimeout=30000 <files>; echo EXIT=$?
    cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1-driving-exec && node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const files=r.testResults.map(t=>t.name);const bad=files.filter(f=>!f.startsWith(process.argv[2]));console.log(JSON.stringify({total:r.numTotalTests,passed:r.numPassedTests,failed:r.numFailedTests,failedSuites:r.numFailedTestSuites,files:files.length,stray:bad}))' "$TMPDIR/w1drv-t<N>.json" "$PWD/"
    ```
  - Green means all of: `failed == 0`; `failedSuites == 0`; `passed == total > 0`; `files` equals the number of paths passed; `stray` is empty. Paste the JSON line into the task report and pin `total`.
  - Never trust `rtk` summaries: `PASS(0) FAIL(0)` is a suite that failed to collect. vitest positionals are literal filename filters, so a typo silently runs fewer files. The `files` count catches that.
- **tsc and eslint on changed files only.**
  - Scoped tsc: with the Write tool create `$TMPDIR/w1drv-tsc-<N>.json`:
    ```json
    {"extends":"/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1-driving-exec/tsconfig.scripts.json","include":[],"files":[<absolute changed .ts paths>],"compilerOptions":{"incremental":false,"typeRoots":["/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1-driving-exec/node_modules/@types"]}}
    ```
    then `cd <worktree> && rtk proxy node node_modules/typescript-native/bin/tsc -p "$TMPDIR/w1drv-tsc-<N>.json"; echo EXIT=$?`.
  - eslint: `cd <worktree> && rtk proxy ./node_modules/.bin/eslint <changed scripts/ files>; echo EXIT=$?`. Empty output is clean only with `EXIT=0`.
- **`grep -a` always.**
- **Strip-types rules.** No `enum`, `namespace` or constructor parameter properties. Error subclasses assign their fields in the constructor body. Every relative import carries `.ts`. Extend `scripts/matrix/__tests__/strip-types-loadable.test.ts` with each new module (the test's own list: a `W1DRV_T<N>` array beside `W1C_T4`).
- **Boundary** (R3; `scripts/matrix/__tests__/boundary.test.ts`).
  - No new import from `scripts/bench/**` (D1 declines `advance.ts`).
  - No new relative import into `apps/web`. Product facts are read as text by DB-free pin tests. The template JSON files are read with `readFileSync` + `JSON.parse`, never imported.
  - Engine imports are bare packages (`@seazn/engine/sport`, `@seazn/engine/scheduling`), which are allowed.
- **Do not touch:**
  - `scripts/bench/**`, `run-suite.ts`, `PackSchema`;
  - `.github/workflows/e2e.yml`, `apps/web/playwright.config.ts`, any `apps/web/e2e/**` file;
  - anything under `apps/web/**` or `packages/engine/**` (no product changes, ruling 19).
- **Test authority** (`TEST-STRATEGY.md` rules 1–5 and 10; R9, R13, R25):
  - Before writing a task's tests, list its **state transitions and its empty case first**, then test both. The four that bite here: a second call, an empty input, after a withdrawal or void, and another sport.
  - Every check, invariant, sweep and planner reports how many items it checked; **zero checked is a failure**.
  - Expected values come from engine declarations (`resolvePositions`, `validateLineup`, `generatePagePlayoff`/`generateStepladder`/`generateDoubleElim`, `sportModule().init/apply` folds, `supportsDraws`), the committed catalogue files, the product's own text read from source, or a cited rulebook. **Never from the code under test.** Where one can, a case is chosen so the right answer differs from the wrong one's constant.
  - "Cannot happen" becomes a named refusal plus a test that reaches it.
  - **Rule 10.** Any ordered-action surface this wave adds gets a fast-check sequence test with invariants after every step: multi-stage advance (Task 6), ladder challenges (Task 7), mexicano rounds (Task 8). A shrunk failure is committed as a named regression case with its seed BEFORE the fix.
- **Mutation** (R17). Each task's last test step lists `mutant → killing test`. Back up with `cp <file> "$TMPDIR/w1drv-bak-<name>"`, mutate, run the named test file, see it red (pin `total` and `failed`), then restore with `cp "$TMPDIR/w1drv-bak-<name>" <file>`. **Never** `git checkout <file>`. Mutate each new guard once; mutate two guards that cover for each other one at a time.
- **Budgets are derived, never flat** (class 20).
  - Every loop cap is expressed in a declared quantity: the stage's `config.rounds`, the field size, or `MAX_ITERATIONS`.
  - A live run's wall clock is `cases × per-case budget ÷ workers`, written in the task, never a guess.
- **Public repo** (R14a). Synthetic identities only:
  - owner `delivered+matrix-<runId>@resend.dev`;
  - entrants "Matrix Player N" / "Matrix Team N";
  - roster members "Matrix Player N.M".

  Every text writer goes through `redact()`. Results still refuse on `findSecrets()`.
- **Live runs** (Tasks 6, 11, 13, 15) follow `~/.claude/skills/seazn-local-env/SKILL.md`:
  - a fresh DB via `db:apply` + `sync:sports`, with `BENCH_EXPECTED_DATA_DIR` = `show data_directory` (confirm it is yours);
  - **no `REDIS_URL`**; PostHog and Sentry blanked; `AUTH_DEV_LINKS=1`;
  - a prod build; `SMOKE_BASE=http://localhost:<port>` (never 127.0.0.1);
  - a fresh run id and a clean tree before evidence runs;
  - every command writes `EXIT=$?` itself.
- **Owner rulings are binding:**
  - 19 (wave done, product reds recorded never fixed);
  - 24 (builder-default variant);
  - 28 (W1-driving);
  - 29 (variants LIFECYCLE only);
  - 31 (the 24 `test` cases);
  - 39 (L1 at 1280);
  - 43 (API-only rows planned 🚫 in the browser);
  - **44–49** and the four folded-in items (see Decisions).

### The four test types, as they apply here

| Type | Meaning in W1-driving |
|---|---|
| Unit | Pure pieces are tested DB-free under `scripts/matrix/__tests__/`: routes and the guard, field sizes, the roster and lineup builders against the engine's `validateLineup`, the new driver methods against a stub transport, every play loop against an in-memory fake, the invariants, the cricket streams folded through the real engine, the worker queue, the planner, and the model's roster and bias. |
| E2E / live | The HTTP run of ruling 48 on workers (Task 15), and the L1 proof at 1280 of one cell per new capability plus the two template cells (Task 13). |
| Smoke | The HTTP slice re-run at the head (24 cases), which must match W1c's committed states (Task 15 Step 1). Every capability also gets one live cell before the full run (Task 6 Step 12, Task 11 Step 7). |
| Regression | The committed runs stay judged against `plans.lock.json`. The model's `--regressions` replays its 5 committed cases unchanged (Task 14). Every rule-10 shrink is committed as a named case with its seed. |

---

## Review Focus

These are the five failure modes most likely to bite a person using this harness (the W1d triager, the owner reading `MATRIX.md`) that no functional test would exercise. Each one's pinning test sits in its owning task.

1. **A lineup the engine refuses.** Football needs exactly one starting goalkeeper and cricket a wicketkeeper role. A roster builder that fills "N players" without the catalog's group minimums and required roles produces lineups the engine's `validateLineup` flags. Whether the product then refuses the PUT, stores it with a warning, or refuses the first event through `assertLineup` is NOT pinned yet (Task 4 Step 0 pins it, plan review 1 m-3). Any of the three reads as a product red on 45+ cells. Expected: for every sport and every builder-default and committed variant cfg, the built lineup passes the engine's own `validateLineup` with `[]`, and the builder reports how many cfgs it checked. Pinned by `rosters.test.ts` "every sport's lineup passes validateLineup, counted" (Task 3).
2. **A later stage judged or seeded wrong.** Several things go wrong here: confirming a stale proposal, confirming twice, repeating `/complete`, or snapshotting stage 2 on the division's whole entrant list. Each turns a multi-stage cell green or red for a harness reason. Expected:
   - confirm uses exactly the proposal id `/complete` returned, once;
   - `/complete` is never repeated;
   - a later stage's field is the entrants the confirm placed (`fieldSource: "seeded"`), and it equals the take its progression declares.

   Pinned by `multi-stage.test.ts` "confirm uses the id /complete returned, once, and the seeded field is the confirm's" and the fast-check sequence test (Task 6).
3. **A loop that drains with nothing played.** A ladder's generate answers `[]`, so the old loop reads `drained` at once. An americano re-generate can plan a duplicate round. Either gives a ✅ over nothing. Expected: a ladder stage with zero challenges, or an americano stage with zero decided rounds, is red, and I9/I10 fail on `checked 0`. Pinned by `ladder-loop.test.ts` "no challenge played is red, never drained" (Task 7), `americano-loop.test.ts` "a stalled mexicano exits stalled_rounds" (Task 8) and `invariants.test.ts` I9/I10 empty cases (Task 9).
4. **Workers cross-talk.** Two workers on one cookie jar would switch each other's active org. A failed case would shift later results out of plan order. Expected:
   - each worker has its own session;
   - a worker's case still refuses `OrgMismatch`;
   - `results.cases[i]` is plan item `i` whatever finished first;
   - a crash in one case leaves every other index in place.

   Pinned by `run-cli.test.ts` "workers: one session each, results in plan order, a crash keeps indices" (Task 11).
5. **The Q-A guard passes vacuously.** Once the last `ScenarioUnsupported(DRIVING_WAVE, …)` is deleted, today's guard sees 0 deferral sites and reds. The obvious repair is to delete the check. A new routing shape (a `Record<string, string>` of waves) would also escape it. Expected: the guard counts every route across every construct, fails on 0, and refuses a bare wave literal outside `routeTo`/a deferral class. Pinned by `scenario-catalogue.test.ts` "a stray wave literal is refused by name" and "zero routes read is a failure" (Task 1).

---

## False premises found in planning

Each has file:line evidence. They go to `_INDEX.md` "False premises found" (Task 16).

1. **"GET the seed proposal to read the latest."** The route has no GET. `POST /stages/{id}/seed-proposal` computes or recomputes (201), and `POST …/confirm` fills (`app/api/v1/stages/[id]/seed-proposal/route.ts`). The harness confirms the id `/complete` returned, and recomputes only on a tie refusal (D1).
2. **"`Scenario.entrantCount` sets the field."** Nothing reads it. Each scenario passes its own `ENTRANTS` const to `setUpDivision` (`lifecycle.ts`, `m1-walkover.ts`, `r4-withdrawal.ts`, `f1-odd-field.ts`). A per-format size must change the call, not the declaration (Task 2).
3. **"Only mexicano risks a duplicate round on re-generate."** `americanoGen` plans on EVERY generate, whatever the mode (`usecases/stages.ts:734-800`), so a second generate on an americano stage risks duplicate players too. The americano loop never generates after Start (D9).
4. **"The M5 tie gap covers cricket."** It covers limited-overs cricket only. `LEVEL_PROBES.cricket` returns null when `ballsPerInnings` is not a number (`applicability.ts:101-122`), and the `test` preset has `ballsPerInnings: null`. So a 4-innings level tie is outside applicability today. Task 10 builds the tie stream for both. Whether M5 should probe 4-innings ties is routed to **W2** as a finding.
5. **"924 cases" (ruling 48).** The fold-in drops F1 on `page_playoff_only` as unfit, which is 11 cells, so 913 cases remain. Adding the 24 cricket `test` variant cases gives **937** planned. Task 12 derives the number from the committed drop list and never types it.
6. **`RowBuildDeferred` is a deferral class the guard reads.** It is never constructed (`catalogue.ts:86-97` says so). The guard keeps reading it; it is not a route.
7. **"A structural champion rule needs a new product field."** The division fixture list already serves `ext_key`, `is_final` and `lane` (`usecases/stages.ts:162,222`). The harness only has to stop dropping them (`FixtureRow`, `toFixture`).
8. **"The Q-A guard's anti-vacuity is sound."** It asserts `sites > 0` and `deferred.size > 0` over `ScenarioUnsupported`/`RowBuildDeferred` only (`scenario-catalogue.test.ts:652-657`). The only shipped sites are the three W1-driving deferrals (`common.ts:108,110,112`), which this wave deletes, and `RowBuildDeferred` has none. At close the guard would red for a harness reason. Task 1 moves the basis to every route read.
9. **"Multi-stage in the model goes to W4/W5/W7" (ruling 49).** Design §8 puts `swiss_playoff` and `swiss_knockout` in **W3**, not W4 or W5. D6 routes them to W3 and flags the difference to the owner, rather than reading the ruling's list literally.
10. **"Americano × team sport refuses."** (Corrected at plan review 1, I-2. The first draft of this plan predicted `STAGE_NOT_READY`; that prediction was itself false.) `americanoGen` builds `personOf = new Map(memberRows.map((r) => [r.entrant_id, r.person_id]))` over every `entrant_members` row, with **no kind filter and no `order by`** (`usecases/stages.ts:744-747`). A team entrant with a full roster therefore yields exactly ONE person, whichever member row the query returns last. 8 teams give 8 players ≥ 4, so generation **succeeds silently**, and the stage pairs cross-team persons. The 5 team-sport americano and mexicano cells (10 in all) are predicted **product findings → W7** ("americano generates on team entrants with one arbitrary roster member each"), not refusals and not harness reds. Task 8 pins the prediction with a text test on `stages.ts` (no kind filter), so a product fix moves it.
11. **The W1c status row says "PR and merge: pending"** (`_INDEX.md:15`). It merged as #905 (`ebf7ec040`). Task 16 corrects it.
12. **"M1 and R4 mean the same on every family."** (Plan review 1, C-1.)
    - M1 finds seed 1's fixture by ENTRANT id (`lib/scenarios/m1-walkover.ts:25`). Americano and mexicano fixtures seat ephemeral pair entrants (`usecases/stages.ts:681` `pairEntrantsFor`), so `target` stays null and `m1-walkover-recorded` reds "no round fixture seated seed 1" (`m1-walkover.ts:47`) on 22 cases.
    - R4 withdraws seed 3 after round 1 (`r4-withdrawal.ts:75`). On a ladder, round 1 is the first challenge (seeds 8 v 7, D8), so seed 3 has no fixture yet and `withdrawal.ts:166` (`mine.length === 0 → continue`) leaves the policy `"none"`, which `r4-policy-reported` (`r4-withdrawal.ts:109`) reds on 11 cases.
    - R4 on americano and mexicano withdraws an individual entrant that no fixture seats, so the policy is `"none"`, nothing is voided, and the person keeps playing their pair games (`withdrawal.ts:213-217`, open-format branch).
    - Ruling 51 defines each meaning (D14).
13. **"Ruling 51's ladder timing gives R4 a policy to report."** Withdrawing seed 3 AFTER its first challenge is decided leaves it no pending fixture, because D8 decides each challenge before the next is issued. The open-format branch posts a walkover only when a pending fixture exists (`withdrawal.ts:213-217`, `if (out.policy === "none" && plan.length > 0)`). So the product's correct answer on a ladder is `policy "none"`, voided 0, walkovers 0. Asserting `policy !== "none"` there would be a harness-premise red. D14 makes `r4-policy-reported` per-family on the ladder: the expected policy is DERIVED from the fixtures seed 3 has pending at withdrawal time, not assumed. Plan review 2 confirmed this premise against the tree (the ladder is in neither `TABLE_KINDS`, `withdrawal.ts:37`, nor `BRACKET_WALKOVER_KINDS`, `stages.ts:880-884`; `PENDING` is `{scheduled, in_play}`, `apps/web/src/lib/table-withdrawal.ts:18`). D14's full ladder expectation is **ruled (53)**.
14. **"Mexicano waits only on a finalized round."** The wait test is `existing.some((f) => f.status !== "decided")` (`usecases/stages.ts:769`). An M1 walkover is stored `forfeited` (`engine-db/append-event.ts:147`), and any open-format void is `abandoned`. Either one makes every later mexicano generate return `[]`, which reads as exit `stalled_rounds` (I-3). D9 predicts this for **M1** on mexicano. It does **not** arise for R4 (plan review 2, I-3): R4 withdraws an individual that no fixture seats, after round 1 is fully decided, so nothing is voided and nothing blocks.
16. **"The open-format withdrawal cascade forfeits to the opponent."** (Plan review 2, I-1.) `cascadeItems` (`lib/scenarios/r4-withdrawal.ts:23-51`) models the table and bracket walkover: each pending fixture with a seated opponent becomes `forfeited` to that opponent. For kinds in neither `TABLE_KINDS` nor `BRACKET_WALKOVER_KINDS` (ladder, `page_playoff`, americano), the product instead **abandons** every pending fixture, counts each in `voided`, and still reports policy `walkover` (`withdrawal.ts:213-217`, `applyUpdate` → `voidAndAbandon`). The unchanged check would red "abandoned after walkover, expected forfeited" and "reported 1 voided, observed 0" for a harness reason. D14 makes `cascadeItems` kind-aware (Task 7).
17. **"Mexicano's players are the division's individuals."** (Plan review 2, I-3.) The active-entrant query has no kind filter (`usecases/stages.ts:2290-2293`, `status in ('registered', 'confirmed')`). Pair entrants are inserted with `kind: "pair"` and the default status `'registered'` (`stages.ts:715-721`; `V212__entrants.sql:12`). So from round 2 on, every earlier pair entrant counts as a "player" as well, and `americanoGen` maps each one to an arbitrary member (false premise 10), whose person is already one of the individuals. `pairMexicanoRound` sorts by points, then id (`packages/engine/src/scheduling/americano.ts:93-95`). The duplicates sit next to each other and fall into the same quartet: the same person on both sides, possibly a self-pair that hits the `entrant_members` primary key (`V213:9`), which may surface as an unnamed 500 on generate. A **round-2 duplicate person is near-certain** on every mexicano case that reaches round 2. It is predicted with the signature `mexicano-pair-entrants-counted-as-players` → W7. Americano is untouched, because it plans every round at the Start generate, before any pair entrant exists.
15. **"Dropping one L2 run removes only that run."** (Plan review 1, I-4.) `planL2` numbers runs globally, and the width comes from the run number plus a lap shift applied only when a scenario's pick count is a multiple of 7 (`scripts/matrix/lib/pairs.ts:132-165`). F1 has 21 picks today, and `page_playoff_only` F1 is run 801. Dropping it renumbers **931** of 1,731 runs and re-widths **949** (the reviewer simulated the committed generator; the control reproduced all 1,732 runs with 0 mismatches). Ruling 50 accepts the reshuffle once (Task 2 Step 4).

---

## Decisions

**Ruled: 44 (2026-09-30).** The cricket two-innings (`test`) generator and the cricket tie outcome are W1-driving's, struck from W2's checklist. → Task 10.

**Ruled: 45.** I2 on double elim, stepladder and page playoff is structural only:
- the champion is the winner of the terminal final (`pp-final`, the last stepladder game, `gf`/`gf-reset`);
- that winner is `finalRanks[0]`;
- `finalRanks` is a permutation of the field.

"Exactly one unbeaten" stays knockout-only, and rulebook semantics stay with W4/W6. → Task 9.

**Ruled: 46.** Workers are in-process: one server and DB, and each worker has its own sign-in, session and jar. Results are written in plan order. W1d owns the shards. → Task 11.

**Ruled: 47.**
- Rosters and lineups, seed-proposal → confirm and ladder challenges are HTTP setup filler, and `BrowserDriver` uses the same filler.
- L1 proof at 1280 covers one cell per capability; the full L1 grid is W1d's.
- `OVERRIDE_WAVE` → W2.
- The two template-only cells are driven here.

→ Tasks 1, 13.

**Ruled: 48.** Done when the HTTP run of LIFECYCLE, M1, R4a and F1 over all 231 cells (on workers) plus the 24 cricket `test` cases has no ⏳ naming W1-driving and no ❌ with a harness cause. Product reds are recorded and routed. → Task 15.

**Ruled: 49.** The model gets team rosters and a Swiss-biased command generator. Multi-stage and the ladder family in the model go to the family waves. → Task 14.

**Folded in (owner told, no objection):**
- page playoff seeds 4, and F1 on `page_playoff_only` is unfit (Task 2);
- rosters are full size, with lineups PUT before each fixture's first event (Tasks 3–4);
- americano/mexicano individuals get linked persons (Task 5);
- the Q-A guard reads the blind-spot routes and the row reads "in progress" (Task 1);
- `W1-driving.md` is written, and R1 gains W1-driving (Task 16).

**Ruled: 50 (plan review 1, 2026-09-30).** The `l2-pairs.json` reshuffle from dropping F1 on `page_playoff_only` (931 of 1,731 runs renumbered, 949 re-widthed; false premise 15) is **accepted once** and named in the Task 2 commit. Committed evidence stays judged against `plans.lock.json`. Task 10's regen must change only `l3Gap` fields. → Task 2 Step 4, Task 10 Step 4.

**Ruled: 51.** M1 and R4 get a defined meaning on the ladder family (not dropped as unfit, ruling 42):
- M1 on americano and mexicano targets the first fixture whose pair entrant has seed 1's person as a member;
- R4 on the ladder withdraws seed 3 after its first challenge;
- R4 on americano and mexicano, where the withdrawn player keeps playing their pair games, is a predicted product red → W7.

→ D14, Tasks 7, 8, 15.

**Ruled: 52.** D1–D13 below are **accepted as written** (each is marked "ruled (52)"). D6 amends ruling 49: model refusals route by design §8, which adds **W3** for `swiss_playoff` and `swiss_knockout` beside W4, W5 and W7. D14 is new at fix round 1. It records ruling 51 and, since fix round 2, ruling 53.

**Ruled: 53 (plan review 2, 2026-09-30).** R4 on the ladder is judged by what a withdrawal actually leaves (false premise 13). The case asserts that:
- the policy is derived from the product's pending set;
- seed 3's decided challenge is unchanged;
- seed 3 is gone from the live ladder order but stays in the raw `ladder_order`;
- no later challenge seats seed 3;
- zero challenges are refused.

Noted for W7, not asserted: `finalRanks` is the raw `ladder_order` (`engine-db/competition.ts:606`), so a withdrawn player keeps their rung. → D14, Task 7, Task 9 (I9).

**D1 — ruled (52). Seed advance through two driver methods, not bench `advance.ts`.**
- `confirmSeedProposal(stageId, {proposalId, tiePicks?})` confirms exactly the proposal id `/complete` returned for the next stage.
- On `422 SEEDING_TIE_UNRESOLVED` (or whatever named code Step 0 pins), the harness calls `recomputeSeedProposal(stageId)` once. It then confirms with `tiePicks` in the order the product itself listed (`ties[i].entrantIds`), and records the note and fact `seeding_tie_picked`.
- Owner value:
  - the harness proves the organiser's own two-click path (Complete, then Confirm) without importing a bench helper that asserts an expected qualifier list;
  - tie semantics stay W4/W5's, because the harness takes the product's own listed order and says it did.
- Rejected: importing `advanceStageSeeding` (`scripts/bench/lib/advance.ts:203`). It always POST-recomputes, which makes the draft `/complete` minted stale. It demands an expected qualifier list the harness has no rulebook for, and it throws on every refusal, so a named product refusal would become a harness crash.

**D2 — ruled (52). Rosters: full declared size, members inline over HTTP, members as filler in the browser.**
- Roster size = `resolvePositions(module, cfg).lineup.size + (lineup.benchMax ?? 0)`, capped at the schema's 40 (a named refusal above it).
- `HttpDriver.addEntrants` sends `members: [{new_person: {full_name: "Matrix Player <entrant>.<m>"}, squad_number: m, is_captain: m === 1}]` in the create body.
- `BrowserDriver` adds the entrant by name through the UI, so `addEntrants` keeps its browser coverage. It then seeds members as HTTP filler: `POST /persons` per member, then `PATCH /entrants/{id} {members}`.
- The lineup builder fills every group's `min` first and gives each required role to a distinct starter. It is unit-tested against `validateLineup(...) → []`.
- Owner value:
  - one roster shape everywhere, sized by the engine's own catalog;
  - cricket's all-out (`min(playersPerSide, order.length) − 1`) matches the generated stream, so a streamed innings means the same as on the pad.
- Rejected: two-player "minimal" rosters. They change cricket's all-out and any sport's lineup-size validation.

**D3 — ruled (52). PADPROOF keeps `rosterlessTeams`.** Its D-T9-2 proof (a team pad scores a rosterless fixture) stays a PADPROOF-only option. Every other scenario seeds rosters.
- Owner value: the committed W1c pad-proof evidence stays reproducible, and the new roster path is proven where it is needed.
- Rejected: seeding rosters into PADPROOF too. That changes a committed, frozen run's plan (`plans.lock.json`) for no new coverage.

**D4 — ruled (52). Cricket `test` streams and the tie** (engine preset `cricket.ts:3559-3567`).
- The shapes, each `s(runs, wickets)` an innings summary:
  - `win-home` is a follow-on innings victory: `[START, s(500,10), s(200,10), cricket.followon, s(150,10)]`, lead 300 ≥ 200;
  - `win-away` is 4 innings, a chase by wickets: `[START, s(250,10), s(300,10), s(200,10), s(151,3)]`;
  - `draw` (league/group/swiss only, by `supportsDraws`) is `[START, s(300,10), s(250,10), s(200,5,declared), s(100,3,partial), cricket.match.close]`;
  - `tie` is a level 4-innings aggregate: `[START, s(250,10), s(200,10), s(200,10), s(250,10)]`;
  - a limited-overs `tie` is two equal summaries, unreachable when `superOver` is true (the fold would open a super over).
- `wickets` are clamped by `declaredAllOut`. `legalBalls` is a fixed per-innings count, because `ballsPerInnings` is null.
- `RequestedOutcome` gains `{kind: "tie"}`, and `ALL_OUTCOMES` grows to 7. `SportStreamGenerator.tied?(req)` is optional, so `generateStream` throws `OutcomeUnreachable` for a sport without it.
- The M5 `HarnessGap` is removed, so its 14 drops leave on regen, and `KNOWN_UNSUPPORTED` becomes `[]`.
- Owner value: the 24 `test` cases and the 14 M5 cells become driveable, with outcomes the engine's own fold decides (each shape is asserted by folding, never by reading the generator).
- Rejected: a ball-by-ball two-innings generator. It needs a batting order per innings and adds nothing a summary fold does not prove at L3.

**D5 — ruled (52). A future generator gap routes to W2.** `counts.json`'s `generatorUnsupported.routedTo` becomes `routeTo("W2", "generator breadth")`. After Task 10 no case sits in that bucket, and a new one belongs to W2's generator-breadth task.
- Owner value: no route names a closed wave after W1-driving.
- Rejected: leaving it at W1-driving. The Q-A guard reds the moment the row closes.

**D6 — ruled (52). Model refusals get their own class, routed by family.**
- `ModelUnsupported(wave, reason)` replaces the plain `Error`s at `model/state.ts:256,259`. The team refusal goes away (ruling 49).
- The multi-stage rows route by design §8:
  - `league_ko`, `groups_ko`, `group_stepladder`, `group_playoffs`, `group_group_ko` → W5;
  - `ko_plate`, `qualifying_main` → W4;
  - `swiss_playoff`, `swiss_knockout` → **W3** (false premise 9).
- The ladder family → W7.
- Owner value: every model refusal names the wave that owns its rulebook, and the Q-A guard reads it.
- Rejected: W4/W5/W7 literally. That sends two swiss rows to a wave that does not own swiss.
- **Ruling 52 amends ruling 49 by this decision:** the family waves for model refusals are W3, W4, W5 and W7.

**D7 — ruled (52). One routing construct.**
- New `scripts/matrix/lib/routing.ts` defines `interface Route {wave, why}` and `routeTo(wave, why): Route`. Every wave the harness names is one of:
  - a deferral class the guard reads: `ScenarioUnsupported`, `NoOrganiserPath`, `ModelUnsupported` (arg 0), or `RowBuildDeferred` (arg 1);
  - a `routeTo("<literal>", …)` call.
- `API_ONLY_UI_WAVE`, `KNOWN_NO_PATH`, `KNOWN_UI_NO_PATH`, `HarnessGap` (gains `route`), `counts.ts` `routedTo` and mixed `exempt(action, route: Route)` all take a `Route`. The mixed regex is deleted.
- The guard reads all of them from the AST. It refuses any other string literal exactly equal to a wave id or containing `W1-driving`, and judges anti-vacuity on `modules scanned > 0` and `routes read > 0`.
- Owner value: "no route names a closed wave" becomes checkable in one place, and a new routing shape cannot hide.
- Rejected: extending the regex scan wave by wave. That was the blind spot.

**D8 — ruled (52). Ladder schedule: one bottom-up sweep of adjacent upward challenges.**
- For a field of `n` there are `n − 1` challenges. At step `k` (1-based) the harness reads the live `ladder_order`, drops withdrawn entrants, and the entrant at position `n − k` challenges the one at `n − k − 1` (0-based).
- The challenger wins on odd `k` and loses on even `k`, through the normal stream generator.
- M1/R4 hooks see `batch = [the challenge fixture]` and `round = k`.
- **M1 on the ladder fires on the LAST challenge** (plan review 1, m-4). Seed 1 sits at rung 0, which the bottom-up sweep first touches at step `n − 1` (step 7 of 7 for 8 entrants). So "seed 1's first opponent does not turn up" is the final challenge, and `m1-winner-progresses` abstains ("not a bracket stage"). That is expected; the evidence reader should not read it as a missed hook.
- **R4 on the ladder fires after seed 3's first challenge** (ruling 51, D14), not after step 1. With the plan's win/lose alternation seed 3 is first touched at step 5 of 7 (the challenger at live index 3 wins over seed 3 at index 2); the test derives the step from `ladderSchedule` + the swap rule, never types it.
- The bound is the field size (no literal). The expected final order is computed in the test by applying the adjacent-swap rule to the seed order.
- Owner value: every challenge is legal under any `challengeRange ≥ 1`, and adjacent challenges make swap and leapfrog identical, so the expected order needs no ladder rulebook (W7's).
- Rejected: random challenges. They are not reproducible, and they need range and rulebook knowledge the harness does not own.

**D9 — ruled (52). Americano and mexicano loops.**
- Americano: no generate after Start. The harness lists fixtures and plays round by round, lowest `round_no` first. The cap is `config.rounds`.
- Mexicano: generate after each fully decided round. The cap is `config.rounds + 1` generates. `created 0` before `config.rounds` rounds is exit `"stalled_rounds"` (new `LoopExit`) plus a note.
- Per-round person uniqueness is read from the pair entrants' members.
- Product reds are recorded as findings → W7 and never fixed. Two are **predicted**, each with its own signature:
  - **`mexicano-pair-entrants-counted-as-players`** (false premise 17, plan review 2 I-3). From round 2 on, the product counts every earlier pair entrant as a player, so a person appears twice in a round. This is near-certain on every mexicano case that reaches round 2 (LIFECYCLE, F1, R4, about 33 cases). It surfaces as an I10 "seated N×" red, or as a refused or 500 generate if a self-pair hits the `entrant_members` primary key.
  - **`mexicano-stalled-on-non-decided`** (false premise 14, plan review 1 I-3). The product waits on `existing.some((f) => f.status !== "decided")` (`usecases/stages.ts:769`), so an M1 `forfeited` walkover (`engine-db/append-event.ts:147`) makes every later generate create 0. R4 does NOT cause it (plan review 2 I-3). The harness never "unblocks" it (no re-decide, no retry): the loop exits `stalled_rounds` with the note.
  - Suspected, but with no signature: an early complete.
- The `FakeAmericanoDriver` mirrors the product by DEFAULT. It waits on exactly `status !== "decided"`, and from round 2 on it counts its own earlier pair entrants as players, reading each through its last member row. The clean shape (individuals only) is the option `individualsOnly: true`, used only by the tests that isolate a harness mechanic. Text pins in `americano-loop.test.ts` read `stages.ts` for the wait predicate and for the kind-less active-entrant query (`:2290-2293`), so a product change reds the pin and moves the fake with it.
- Owner value: the loops are bounded by the stage's own declared rounds, and a product that stops early reads as a named stall, not ✅.
- Rejected: re-generating americano to "top up". False premise 3.

**D10 — ruled (52). `--workers N > 1` is HTTP-only in this wave.** `--driver browser --workers 2` is a usage error naming W1d.
- Owner value: no parallel path ships unproven. The browser's per-case contexts share one launched browser, and pad holds were never measured under contention. W1d proves it inside its shards.
- Rejected: allowing both. That is an inert seam (class 1) until someone runs it.

**D11 — ruled (52). Template-only cells use the template's own field.**
- `group_only|badminton` via `box-league` and `group_group_ko|cricket` via `t20-super8` add the template's declared `entrantCount` (16 each, read from the catalog JSON as text).
- The division, variant and stage bodies are the template's, so `life-built-as-posted` compares against the catalog JSON, not `stagesForRow`.
- Owner value: the cell is proven on the organiser's real path, with the shape the organiser gets.
- Rejected: forcing 8 entrants into a 16-seat template. That is a shape no organiser would build.

**D12 — ruled (52). M1 and R4 hooks fire on stage 1 only.** In a multi-stage division, the walkover (M1) and the seed-3 withdrawal (R4) happen in the first stage's first round (on a ladder stage, at the moments D8 and D14 define). Later stages play with the default policy.
- Owner value: the scenario keeps its meaning (an early walkover or withdrawal), and the withdrawn entrant's absence from the seeded field is itself checked by `advance-seeded-as-declared`.
- Rejected: firing hooks per stage. That doubles the withdrawal, and R4's second call would refuse.

**D13 — ruled (52). The L1 proof excludes the cricket `test` streams** (full text in Task 13 Step 7). W1c's cricket pad adapter has no route for `cricket.followon`, `cricket.match.close` or a declared innings, so the two-innings shapes are proven over HTTP only. The adapter routes go on W1d's first-tasks list, before the full L1 grid reaches `*|cricket|test`.
- Owner value: one L1 cell per capability that has a pad route today, and the gap is on a wave's list, not silent.
- Rejected: writing those pad routes here, which is pad work outside the ruling-47 scope.

**D14 — M1 and R4 on the ladder family (rulings 51 and 53; false premise 13).** Pinned at Task 7 Step 0 (ladder) and Task 8 Step 0 (americano/mexicano). Each meaning has a fake-driver test that reds on TODAY's hooks (`m1-walkover.ts:23-31`, `r4-withdrawal.ts:74-84`, `:109`) and passes after.
- **M1 on americano and mexicano (ruling 51).**
  - "Seed 1's person" = `setup.persons.get(seed1)` (Task 5): one person for an individual, the roster for a team entrant (the product picked one member per team, false premise 10).
  - The target is the FIRST fixture in the batch whose home or away pair entrant has one of those persons as a member, read through `ctx.driver.entrantMembers(pairId)` (never inferred from display names).
  - The absent side is the other pair entrant; the forfeit goes to seed 1's pair.
  - `m1-walkover-recorded` expects status `forfeited` and winner = seed 1's PAIR entrant id (canary: the absent pair). `m1-winner-progresses` abstains ("not a bracket stage").
  - On mexicano the walkover is `forfeited`, which stalls every later round (false premise 14): predicted signature `mexicano-stalled-on-non-decided` → W7.
  - The M1 hook takes a `targetOf(batch)` strategy chosen by stage kind: entrant-id match (today's, every other kind) or pair-member match (americano). A lookup table keyed by kind, not an if-chain in the hook.
- **`r4-cascade-consistent` becomes kind-aware (false premise 16, plan review 2 I-1).** `cascadeItems(policy, w, before, after, walkovers, voided, kind)` chooses its walkover model by kind, through a lookup keyed on the product's two sets. The runtime lookup is one harness constant, `FORFEIT_MODEL_KINDS` in `lib/observed.ts` beside `PENDING_STATUSES`. A text-pin test holds it equal to the union of the product's `TABLE_KINDS` (`withdrawal.ts:37`) and `BRACKET_WALKOVER_KINDS` (`stages.ts:880-884`), just as `PENDING_STATUSES` is held to `table-withdrawal.ts:18` (plan review 3 m-6: one runtime authority per fact).
  - For a kind in either set, the model is today's: a pending fixture with a seated opponent is `forfeited` to that opponent, and one with a TBD opponent is `abandoned`.
  - For any other kind (the open-format branch: ladder, `page_playoff`, americano), `walkover` means every pending fixture is `abandoned` and counted in `voided`, and no fixture is forfeited (reported walkovers 0).
  - "Pending" is the product's `WITHDRAWAL_PENDING_STATUSES`, text-pinned from `apps/web/src/lib/table-withdrawal.ts:18` (`{scheduled, in_play}`), never a typed list (plan review 2 m-3).
  - The `league|generic` R4 canary's verdict and its `r4-policy-reported` / `r4-cascade-consistent` entries stay byte-identical, because `league` is in `TABLE_KINDS` and canary runs are league-only (`run.ts:630-643` `canaryVerdict`; `slice.ts:74-77` `planCanaryCase`). A test pins those before and after. The whole checks JSON does change: the new `r4-not-challenged-later` appears as an abstain, which the test asserts separately (plan review 3 m-2).
- **R4 on the ladder (ruling 51; the expectation is ruled (53) — false premise 13, plan review 2 Q3).**
  - The hook withdraws seed 3 in `afterRound` of the FIRST ladder step whose batch seats seed 3 (today's hook fires on `round === 1`). The R4 trigger is a per-kind strategy beside M1's: `round === 1` for every other kind, "first batch seating seed 3" for `ladder`.
  - The case asserts five product facts, and nothing else:
    1. **The policy is derived from the product's pending set.** `expectedPolicy = before.some((f) => PENDING.has(f.status)) ? "walkover" : "none"`, where `PENDING` is the text-pinned `WITHDRAWAL_PENDING_STATUSES` and the rule is the open-format branch (`withdrawal.ts:213-217`). Under D8 it is `"none"`, because seed 3's one challenge is decided before the hook fires. `r4-policy-reported` on a ladder asserts `policy === expectedPolicy`, and the canary judges the opposite. Every other kind keeps `policy !== "none"`.
    2. **Seed 3's decided challenge is unchanged.** With `none`, `r4-cascade-consistent` (kind-aware, above) requires every `before` fixture unchanged, and walkovers, voided and skipped are all 0. Both the outcome and the swap it caused stand ("earned standings stand", `withdrawal.ts:213`).
    3. **Seed 3 is gone from the live order but stays in the raw `ladder_order`.** New item in `r4-not-challenged-later`: seed 3 is absent from the live projection (raw order minus departed), and present in the stage's raw `config.ladder_order` at the index it held when it withdrew. The product never prunes it (`stages.ts:5562-5572`), and reach counts live rungs (`:5601-5640`).
    4. **No later challenge seats seed 3.** `r4-not-challenged-later` checks each challenge fixture `playLadder` issued after the withdrawal step (the ladder's twin of `r4-not-paired-later`). A challenge naming seed 3 would get `LADDER_ENTRANT_WITHDRAWN` (`stages.ts:5575-5583`). The check abstains on other kinds.
    5. **Zero refused challenges.** Stage completion stays with the existing `life-stage-completed`; it is not a new R4 item.
  - **W7 note, recorded but NOT asserted:** `finalRanks` is the RAW `ladder_order` (`engine-db/competition.ts:606`), so seed 3 keeps a finishing rank at the rung it held. The case writes the note "ladder finalRanks keep withdrawn <seed 3> at rung <i> (raw ladder_order) — W7 rulebook question", and no check passes or fails on it either way.
- **R4 on americano (ruling 51): a PREDICTED product red → W7.**
  - Seed 3 (an individual entrant) is withdrawn after round 1, as today. No fixture seats it (pair entrants do), so `before` is `[]` and the product reports `policy "none"`. The person keeps playing the pair games already planned, because americano plans every round at Start (false premise 3).
  - `r4-policy-reported` stays `policy !== "none"` there, and so reds. The case gets the predicted signature `r4-withdrawn-player-kept-playing` only when BOTH legs hold:
    - `before.length === 0`;
    - seed 3's person is a member of a pair entrant seated on a fixture with `round_no > afterRound`.
- **R4 on mexicano (plan review 2 I-3): the same signature, with a real second leg.**
  - Nothing is voided, so the rounds do not stall.
  - The signature needs `before.length === 0` AND seed 3's person seated in any fixture of round ≥ 2 **through any entrant**. Seed 3 can come back through its round-1 pair entrant, which the product still counts as a player (false premise 17).
  - Without that leg, the case goes to normal triage.
  - The round-2 duplicate (`mexicano-pair-entrants-counted-as-players`) is expected on these cases too.
- **Triage rule.** A ❌ is a predicted product red → W7, counted as NOT harness-caused for ruling 48, only when EVERY failing check on the case is covered by a signature the case carries. The coverage table is kept in ONE place, Task 15 Step 3 item 4, and this decision points to it rather than copying it (plan review 3 I-2: two copies had already drifted). The table covers each signature's companions: a non-`drained` exit also reds I4 and `life-stage-completed` with "never asked", because Task 6 skips `finishStage` on such an exit.
- Owner value: every one of the 55 cells × scenario pairs these rules touch (22 M1 + 11 ladder R4 + 22 americano R4) ends as ✅ or a named, routed product finding, never an unexplained harness red, which is what ruling 48's "no ❌ with a harness cause" needs.
- Rejected: dropping the pairs as unfit (ruling 42 forbids it, ruling 51 says so); keeping `policy !== "none"` on the ladder (it asserts a policy the product is right not to report).

---

## File Structure

```
scripts/matrix/
  lib/routing.ts                    (T1)  Route, routeTo — the one routing construct (D7)
  lib/api-only-ui.ts                (T1,T13) API_ONLY_UI_WAVE: Record<ApiOnlyRowKey, Route>; TEMPLATE_* removed at T13
  lib/scenario-catalogue.ts         (T1)  KNOWN_NO_PATH / KNOWN_UI_NO_PATH as Route maps
  lib/counts.ts                     (T1,T10) routedTo via routeTo; generator bucket → W2 (D5)
  lib/driver/mixed.ts               (T1,T13) exempt(action, Route); FILLER actions (ruling 47)
  lib/driver/browser-driver.ts      (T1,T3,T13) OVERRIDE route → W2; filler delegation; template card path
  lib/applicability.ts              (T1,T2,T10) HarnessGap.route; F1 unfit on page_playoff_only; M5 gap removed
  lib/field-size.ts                 (T2)  fieldSizeFor(row, scenario, template?)
  lib/scenarios/{lifecycle,m1-walkover,r4-withdrawal,f1-odd-field}.ts (T2,T6,T7,T8) field size; playDivision;
                                          M1/R4 per-kind target, trigger and signatures (D14)
  catalogue/{drop-list,floors,counts,l2-pairs,variants}.json (T2,T10) regenerated, reviewed diffs
  lib/scenarios/rosters.ts          (T3)  rosterSize, rosterMembers, lineupFor (D2)
  lib/driver/types.ts               (T3,T5,T6,T7,T8,T13) MemberInput, EntrantMember, LineupSlotWire,
                                          FixtureRow.ext_key/is_final, CompleteOut.seed_proposal, new methods
  lib/driver/http-driver.ts         (T3,T5,T6,T7,T8,T13) the new methods over v1
  lib/scenarios/common.ts           (T4,T5,T6) deferrals removed; lineups before first event; linked persons;
                                          StageTrack; playDivision; per-stage snapshot
  lib/scenarios/advance.ts          (T6)  confirmAdvance, declaredTake, advanceSeededAsDeclared
  lib/observed.ts                   (T5,T6,T9) ObservedFixture.extKey/isFinal/persons; CaseFact seeding_tie_picked
  lib/scenarios/ladder-loop.ts      (T7)  playLadder (D8)
  lib/scenarios/americano-loop.ts   (T8)  playAmericano, playMexicano (D9)
  lib/invariants.ts                 (T9)  I2 structural (ruling 45); I9 ladder; I10 americano
  lib/streams/types.ts              (T10) RequestedOutcome tie; SportStreamGenerator.tied?
  lib/streams/cricket.ts            (T10) two-innings shapes + tie (D4)
  lib/streams/index.ts              (T10) generateStream tie arm; matchesRequest tie
  lib/streams/known-unsupported.ts  (T10) []
  run.ts                            (T6,T11,T12) PlanStageCapTooLow; --workers; w1-driving set; --only any catalogue cell
  lib/probe-set.ts                  (T12) the single-stage comment reworded (m-8)
  lib/workers.ts                    (T11) runQueue(items, workers, run) → results by index
  lib/w1-driving-set.ts             (T12) planW1Driving(variantFor, filter)
  lib/model/state.ts, commands.ts   (T14) ModelUnsupported; rosters; SWISS_BIAS
  model.ts                          (T14) --cell admits single-stage catalogue cells
  lib/layers.ts                     (T13) w1-driving-l1 set
  __tests__/…                       one test file per module above (named in each task)
  __tests__/fake-formats-driver.ts  (T6,T7,T8) FakeMultiStageDriver, FakeLadderDriver, FakeAmericanoDriver
docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md  (T1,T15,T16)
docs/superpowers/specs/2026-09-27-format-matrix-prompts/_RULES.md  (T16) R1 gains W1-driving
docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1drv-*/ (T13,T15) evidence
```

Every new `scripts/matrix/**` test file is picked up by the existing strict CI matrix step (`ci.yml`), which fails on zero tests, failed suites, passed ≠ total and stray files. None of them needs a DB or a browser.

---

## Task 1: Routing hygiene — one routing construct, a guard that reads it, the row "in progress", `OVERRIDE_WAVE` → W2

**Why:** Ruling 28's guard reads only `new ScenarioUnsupported`/`new RowBuildDeferred`. Six other constructs name waves with bare literals, and the guard is blind to them: `API_ONLY_UI_WAVE`, `TEMPLATE_DRIVING_WAVE`, `OVERRIDE_WAVE`, `KNOWN_NO_PATH`/`KNOWN_UI_NO_PATH`, the mixed-driver regex, and `counts.ts` `routedTo`. Its anti-vacuity basis also dies with this wave (false premise 8). The widened guard must land first, so every later task's route changes are read.

**Files:**
- Create: `scripts/matrix/lib/routing.ts`
- Modify:
  - `scripts/matrix/lib/api-only-ui.ts:14-19,45-47`;
  - `scripts/matrix/lib/scenario-catalogue.ts:144,149` and their consumers (`knownNoPath`/`l2NoPath` stay `string | null`, read from `route.wave`);
  - `scripts/matrix/lib/counts.ts:121-122`;
  - `scripts/matrix/lib/driver/mixed.ts:19-22,78-88`, plus every `exempt(` caller (`rtk proxy grep -anr "exempt(" scripts/matrix/lib`);
  - `scripts/matrix/lib/driver/browser-driver.ts:118-121,401`;
  - `scripts/matrix/lib/applicability.ts:249` (`HarnessGap` gains `route`) and the M5 gap (`:300-303`);
  - `scripts/matrix/lib/scenarios/common.ts:88-91`;
  - `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md:17` (the W1-driving status row only).
- Test:
  - `scripts/matrix/__tests__/scenario-catalogue.test.ts:548-669` (the guard);
  - `routing.test.ts` (new);
  - `mixed-driver.test.ts:162-165`;
  - `browser-driver.test.ts:331,503`;
  - `run-cli.test.ts:1062,1415,1424,1632-1633` (wherever `OVERRIDE_WAVE`'s W1-driving is pinned: re-pin with `rtk proxy grep -anr "W1-driving" scripts/matrix/__tests__`).

**Interfaces:**
- Produces:
  - `interface Route { readonly wave: string; readonly why: string }`;
  - `routeTo(wave: string, why: string): Route`;
  - `DRIVING_ROUTE: Route` (common.ts), with `DRIVING_WAVE = DRIVING_ROUTE.wave` kept for the deferral sites until Task 13;
  - `API_ONLY_UI_WAVE: Readonly<Record<ApiOnlyRowKey, Route>>`;
  - `MixedLedger.exempt(a: ActionType, route: Route)`;
  - `HarnessGap { when; route: Route }` (the old `reason` is `route.why`).

- [ ] **Step 0: Worktree** (first task of the wave).
  ```bash
  cd /Users/ashokhein/github/seazn.club && git fetch origin && git worktree add -b feat/format-matrix-w1-driving .claude/worktrees/format-matrix-w1-driving-exec docs/format-matrix-w1-driving-plan && cd .claude/worktrees/format-matrix-w1-driving-exec && git log --oneline -3 && pnpm install --frozen-lockfile; echo EXIT=$?
  ```
  Expected log: this plan's commit, then `98fc6d530` (rulings 44–49), then `ebf7ec040`. Re-pin every Step 0 anchor above and record moves in the report.

- [ ] **Step 1: The W1-driving row reads "in progress".** Edit `_INDEX.md`'s status row for W1-driving, state column only, to:
  `**in progress** — plan \`docs/superpowers/plans/2026-09-30-format-matrix-w1-driving.md\` (rulings 44–49); deferrals naming W1-driving remain until Task 13`.
  Scope column: unchanged. The guard's `isOpen` must still read it as open. That is asserted in Step 2 against the real file.

- [ ] **Step 2: Write the failing tests.** List the transitions first: empty source; a route literal; a route by identifier; a stray literal; a route in a JSON file; after the last deferral is deleted.

  `routing.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { routeTo, WAVE_ID } from "../lib/routing.ts";

  describe("routeTo", () => {
    it("empty case first: an empty wave or reason is refused by name", () => {
      expect(() => routeTo("", "x")).toThrow(/wave/);
      expect(() => routeTo("W2", "")).toThrow(/why/);
    });
    it("a wave outside the programme's ids is refused (W11, w2, W1-drive)", () => {
      for (const bad of ["W11", "w2", "W1-drive", "W1e"]) expect(() => routeTo(bad, "x"), bad).toThrow(/not a programme wave/);
    });
    it("every programme wave id is accepted and frozen", () => {
      const ids = ["W1a", "W1b", "W1c", "W1d", "W1-driving", ...Array.from({ length: 9 }, (_, i) => `W${i + 2}`)];
      expect(ids.length).toBe(14);
      for (const w of ids) {
        expect(WAVE_ID.test(w), w).toBe(true);
        const r = routeTo(w, "why");
        expect(Object.isFrozen(r)).toBe(true);
        expect(r).toEqual({ wave: w, why: "why" });
      }
    });
  });
  ```
  Derive the 14 ids from `_INDEX.md`'s Status table in a second assertion: the rows matching `^\| (W[\w-]+) \|`, which must be the same set. The expected set comes from the programme index, never from `WAVE_ID`.

  In `scenario-catalogue.test.ts`, rename `scanDeferrals` → `scanRoutes`. Keep every existing reader test, and add these:
  ```ts
  it("reads routeTo(<literal>, …) and the four deferral classes, NoOrganiserPath and ModelUnsupported included", () => {
    expect(scanRoutes(`export const r = routeTo("W4", "why");`)).toEqual({ sites: 1, waves: ["W4"], unread: [] });
    expect(scanRoutes(`throw new NoOrganiserPath("W2", "x");`)).toEqual({ sites: 1, waves: ["W2"], unread: [] });
    expect(scanRoutes(`throw new ModelUnsupported("W7", "x");`)).toEqual({ sites: 1, waves: ["W7"], unread: [] });
  });
  it("a stray wave literal is refused by name: a map value, a const, a template, a W1-driving substring", () => {
    const stray = {
      mapValue: `const M = { D1: "W9" };`,
      constant: `export const OVERRIDE = "W1-driving";`,
      template: "const t = `W4`;",
      substring: `const s = "owed to W1-driving later";`,
      routedTo: `const c = { routedTo: "W2" };`,
    };
    for (const [shape, src] of Object.entries(stray)) {
      const scan = scanRoutes(src);
      expect(scan.unread.some((u) => u.includes("stray wave literal")), `${shape}: ${JSON.stringify(scan)}`).toBe(true);
    }
  });
  it("a routeTo whose wave is not a literal is unread (a variable hides the wave)", () => {
    expect(scanRoutes(`const w = pick(); routeTo(w, "x");`).unread.length).toBeGreaterThan(0);
  });
  it("text that only looks like a wave is not a site: W11, a lowercase set name, a comment", () => {
    expect(scanRoutes(`const a = "W11"; const b = "w1-driving"; // routeTo("W4", "x")`)).toEqual({ sites: 0, waves: [], unread: [] });
  });
  ```
  Replace the ruling-28 guard body. The anti-vacuity basis becomes routes read across all constructs, and the committed `counts.json` routes join them:
  ```ts
  const scans = modules.map((f) => scanRoutes(readFileSync(f, "utf8"), f));
  expect(scans.flatMap((s) => s.unread), "a route names its wave in a shape this guard cannot read, or a bare wave literal sits outside routeTo").toEqual([]);
  const counts = JSON.parse(readFileSync(resolve(REPO, "scripts/matrix/catalogue/counts.json"), "utf8")) as { variants: Record<string, { routedTo?: string }> };
  const jsonRoutes = Object.values(counts.variants).flatMap((v) => (v && typeof v === "object" && typeof v.routedTo === "string" ? [v.routedTo] : []));
  const waves = new Set([...scans.flatMap((s) => s.waves), ...jsonRoutes, ...ATOMIC.flatMap((a) => [a.knownNoPath, a.l2NoPath]).filter((w): w is string => w !== null)]);
  const read = scans.reduce((n, s) => n + s.sites, 0) + jsonRoutes.length;
  // R25: counted, and zero is a failure — never "no deferral sites" (false premise 8).
  expect(modules.length).toBeGreaterThan(0);
  expect(read, "routes read across every construct").toBeGreaterThan(0);
  for (const w of waves) {
    expect(rows.has(w), `${w} has no status row in _INDEX.md`).toBe(true);
    expect(isOpen(rows.get(w)!), `${w}: "${rows.get(w)}" is not open`).toBe(true);
  }
  ```
  Add the zero case as its own test: `scanRoutes("")` gives `{sites: 0, …}`. A guard helper `judgeRoutes(scans, jsonRoutes, rows)` (extract the loop above into a function the test calls; `rows` is the status map) called as `judgeRoutes([], [], rows)` must throw "routes read across every construct". Add a synthetic case too: `judgeRoutes` fed one `W1-driving` route and a status map where that row reads `done` must fail naming the row. That is the mechanism that makes Task 16's row flip safe only once no route names the wave. Do not pin the real row's text, because Task 16 closes it.

- [ ] **Step 3: Run them: expect FAIL.**
  - `routing.ts` does not exist.
  - The stray test fails, because `scanDeferrals` does not look at literals.
  - The real-tree guard now lists every bare literal as unread: `common.ts:91`, `api-only-ui.ts:15,19`, `browser-driver.ts:121`, `scenario-catalogue.ts:144,149`, `counts.ts:121,122`.

  Paste that list. It is the set Step 4 converts, and anything extra is a pin move to record.

- [ ] **Step 4: Implement.**

  `scripts/matrix/lib/routing.ts`:
  ```ts
  // D7 (W1-driving plan): the ONE construct that names an owning wave. The
  // Q-A guard (scenario-catalogue.test.ts, ruling 28) reads every
  // routeTo("<literal>", …) and every deferral class from the AST, and refuses
  // a bare wave literal anywhere else — so "no route names a closed wave" is
  // checked in one place and a new routing shape cannot hide.
  /** The programme's wave ids (_INDEX.md Status). */
  export const WAVE_ID = /^W(?:1[a-d]|1-driving|[2-9]|10)$/;
  export interface Route { readonly wave: string; readonly why: string }
  export class NotAWave extends Error {
    constructor(wave: string) {
      super(`routing: '${wave}' is not a programme wave (${WAVE_ID.source}) — a route must name a wave with a status row`);
      this.name = "NotAWave";
    }
  }
  export function routeTo(wave: string, why: string): Route {
    if (wave === "") throw new Error("routing: a route needs a wave");
    if (why.trim() === "") throw new Error(`routing: a route to ${wave} needs a why`);
    if (!WAVE_ID.test(wave)) throw new NotAWave(wave);
    return Object.freeze({ wave, why });
  }
  ```

  Convert the constructs:
  - **`common.ts`:**
    ```ts
    export const DRIVING_ROUTE = routeTo("W1-driving", "L3 driving breadth W1a deferred (ruling 28)");
    export const DRIVING_WAVE = DRIVING_ROUTE.wave;
    ```
    The guard's `waveOf` already resolves the identifier `DRIVING_WAVE` by value.
  - **`api-only-ui.ts`:**
    ```ts
    export const API_ONLY_UI_WAVE: Readonly<Record<ApiOnlyRowKey, Route>> = Object.freeze({
      knockout_third_place: routeTo("W4", "no builder control for a third-place match (design §8)"),
      page_playoff_only: routeTo("W4", "no builder control for a first-stage page playoff (design §8)"),
      stepladder_only: routeTo("W4", "no builder control for a first-stage stepladder (design §8)"),
      group_only: routeTo("W5", "no builder control for a group stage with no knockout (design §8)"),
      group_group_ko: routeTo("W5", "no builder control for two group stages (design §8)"),
    });
    export const TEMPLATE_DRIVING = routeTo("W1-driving", "catalog template driving (ruling 47)");
    ```
    `apiOnlyUiPath` returns `wave: API_ONLY_UI_WAVE[row].wave` / `TEMPLATE_DRIVING.wave`; its shape is unchanged.
  - **`scenario-catalogue.ts`:** `KNOWN_NO_PATH: Readonly<Record<string, Route>>`, each entry `routeTo("W9", "division merge: build-or-refuse ruling (design §4)")` and so on, with the why copied from design §4's lines. `KNOWN_UI_NO_PATH.M12b = routeTo("W2", "core.lineup.retirement has no pad or console control (ruling 30)")`. The consumers read `.wave`.
  - **`counts.ts`:** `routedTo: routeTo("W2", "the engine refuses the cfg or its stream").wave` and `routedTo: routeTo("W1-driving", "cricket two-innings generator (ruling 44)").wave`. The committed `counts.json` bytes do not change (same strings). Task 10 moves the second to W2 (D5).
  - **`mixed.ts`:** delete `NAMES_A_WAVE`. `exempt(a: ActionType, route: Route)` stores `→ ${route.wave}: ${route.why}` as the evidence string (so the check's evidence text is unchanged in shape). The "second, different reason" guard compares that string. Callers pass `routeTo(...)` or `API_ONLY_UI_WAVE[row]`.
  - **`browser-driver.ts`:**
    ```ts
    const OVERRIDE_ROUTE = routeTo("W2", "the rules editor is not driven in the browser; W2 owns the editor fixes (rulings 33, 47)");
    ```
    `throw new NoOrganiserPath(OVERRIDE_ROUTE.wave, …)` becomes `throw new NoOrganiserPath("W2", …)` with a literal, because the guard reads arg 0 as a literal or `DRIVING_WAVE` only. Keep `OVERRIDE_ROUTE` for the message text.
  - **`applicability.ts`:** `HarnessGap { when; route: Route }`. The M5 gap becomes `route: routeTo("W1-driving", "<the existing reason text, minus '— routed W1-driving'>")`. `dropKind`/the drop reason read `gap.route.why`, so the committed `drop-list.json` text must come out byte-identical. Step 5 checks it.

  In the guard, `DEFERRALS` gains `NoOrganiserPath: 0, ModelUnsupported: 0` (`ModelUnsupported` arrives in Task 14; reading a class that is not constructed yet costs nothing). A `CallExpression` whose callee is the identifier `routeTo` is a site. Its arg 0 must be a string literal (read) or it is unread. Every `StringLiteral`/`NoSubstitutionTemplateLiteral`/template span whose text matches `WAVE_ID` exactly, or contains `W1-driving`, is a stray unless it IS arg 0 of a `routeTo` call or the wave arg of a deferral `new`.

- [ ] **Step 5: Run: expect PASS.** Files: `routing.test.ts`, `scenario-catalogue.test.ts`, `mixed-driver.test.ts`, `browser-driver.test.ts`, `run-cli.test.ts`, `applicability.test.ts`, `committed-catalogue.test.ts`, `strip-types-loadable.test.ts`. Also `pnpm matrix:catalogue --check; echo EXIT=$?` → `EXIT=0`: the committed catalogue files are byte-identical, so the route conversion moved no text. The tests that pinned `OVERRIDE_WAVE`'s W1-driving are re-pinned to W2. Each re-pin reads the route's wave from the module, never a typed "W2".

- [ ] **Step 6: Mutation** (report each kill):
  - drop the stray-literal arm of `scanRoutes` → killed by "a stray wave literal is refused by name";
  - revert one `API_ONLY_UI_WAVE` entry to a bare `"W4"` → killed by the real-tree guard ("stray wave literal … api-only-ui.ts");
  - replace `read > 0` with `true` → killed by the `judgeRoutes([], [], rows)` zero case;
  - `judgeRoutes` skips the open-row check for W1-driving → killed by the synthetic closed-row case;
  - `routeTo` accepts any string → killed by "a wave outside the programme's ids is refused".
- [ ] **Step 7: Scoped tsc + eslint** on every changed `.ts`. Commit:
  `refactor(matrix): one routing construct the Q-A guard reads; OVERRIDE route → W2 (W1-driving T1, D7, ruling 47)`
  with paths: `routing.ts`, the converted modules, the tests, `_INDEX.md`.

---

## Task 2: Per-format field size — a page playoff seeds 4; F1 on `page_playoff_only` is unfit

**Why:** Every scenario seeds a fixed 8 (7 for F1), and a page playoff takes exactly 4 (`bracket.ts:382-386`). So the 11 `page_playoff_only` cells red at Start for a harness reason (`_INDEX.md` W1b probe, `page_playoff_only` LIFECYCLE). This is the fold-in beneath ruling 49.

**Files:**
- Create: `scripts/matrix/lib/field-size.ts`, `scripts/matrix/__tests__/field-size.test.ts`
- Modify:
  - `scripts/matrix/lib/scenarios/{lifecycle,m1-walkover,r4-withdrawal,f1-odd-field}.ts` (the `setUpDivision(..., ENTRANTS)` calls; `entrantCount` becomes the scenario's default, with a comment that the call site asks `fieldSizeFor`);
  - `scripts/matrix/lib/applicability.ts` (`F1`);
  - `scripts/matrix/catalogue/{drop-list,floors,counts,l2-pairs}.json` (regenerated);
  - `scripts/matrix/__tests__/fake-driver.ts` (`FakeKnockoutDriver` option `pagePlayoff`, for the m-5 R4 prediction test).
- Test: `field-size.test.ts`, `applicability.test.ts`, `committed-catalogue.test.ts`, `scenarios.test.ts`.

**Interfaces:**
- Produces:
  - `fieldSizeFor(row: RowKey, scenario: ScenarioKey): number`;
  - `class NoFieldSize extends Error { row; scenario }`;
  - `PAGE_PLAYOFF_FIELD = 4`, `DEFAULT_FIELD = 8`, `ODD_FIELD = 7`.

  Task 13 adds the template override.

- [ ] **Step 1: Write the failing tests** (`field-size.test.ts`). Empty case first: a scenario with no scripted field.
  ```ts
  import { generatePagePlayoff, generateStepladder } from "@seazn/engine/scheduling";
  import { describe, expect, it } from "vitest";
  import { ROW_KEYS } from "../lib/catalogue.ts";
  import { NoFieldSize, fieldSizeFor } from "../lib/field-size.ts";

  const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
  /** The page playoff field, from the ENGINE: every n in 2..16 it accepts. */
  const pagePlayoffAccepts = (): number[] => ids(16).map((_, i) => i + 1).filter((n) => n >= 2).filter((n) => {
    try { generatePagePlayoff({ entrants: ids(n) }); return true; } catch { return false; }
  });

  describe("fieldSizeFor", () => {
    it("empty case first: DENIED and PADPROOF have their own fields and are refused by name", () => {
      expect(() => fieldSizeFor("league", "DENIED")).toThrow(NoFieldSize);
      expect(() => fieldSizeFor("league", "PADPROOF")).toThrow(NoFieldSize);
    });
    it("page_playoff_only seeds exactly the one size the engine's page playoff accepts", () => {
      const accepted = pagePlayoffAccepts();
      expect(accepted.length, "the engine accepts exactly one page-playoff size").toBe(1);
      for (const s of ["LIFECYCLE", "M1", "R4"] as const) expect(fieldSizeFor("page_playoff_only", s)).toBe(accepted[0]);
    });
    it("F1 on page_playoff_only is unfit: an odd field cannot enter a fixed-size bracket", () => {
      expect(() => fieldSizeFor("page_playoff_only", "F1")).toThrow(/odd field/);
    });
    it("every other row keeps 8 / 7, and the engine's stepladder takes the 8 (a differing case: 8 ≠ 4)", () => {
      let checked = 0;
      for (const row of ROW_KEYS.filter((r) => r !== "page_playoff_only")) {
        expect(fieldSizeFor(row, "LIFECYCLE")).toBe(8);
        expect(fieldSizeFor(row, "F1")).toBe(7);
        expect(fieldSizeFor(row, "F1") % 2).toBe(1);
        checked++;
      }
      expect(checked).toBe(ROW_KEYS.length - 1);
      expect(generateStepladder({ entrants: ids(fieldSizeFor("stepladder_only", "LIFECYCLE")) }).fixtures.length).toBe(7);
    });
  });
  ```
  In `scenarios.test.ts`, add "page_playoff_only LIFECYCLE adds exactly 4 entrants": run on a fake driver whose `postStages` accepts `page_playoff`, then read `driver.calls` for the `addEntrants` count. Add "F1 on page_playoff_only is never planned": the F1 applicability decision for `page_playoff_only|generic` is a drop with the new reason. In `applicability.test.ts`, the F1 witness keeps `league|generic` and drops `page_playoff_only|generic`.

  **R4 on `page_playoff_only` once it seeds 4 — the prediction** (plan review 1, m-5). Seed 3 plays `pp-elim` (round 0 → `round_no` 1) against seed 4 (`packages/engine/src/scheduling/bracket.ts:390-393`). The harness's default winner is the better seed (`scripts/matrix/lib/scenarios/common.ts:161`), so seed 3 WINS `pp-elim` and is seated in `pp-q2`. R4 then withdraws it after round 1. `page_playoff` is not in `BRACKET_WALKOVER_KINDS` (`usecases/stages.ts:880-884`), so the open-format branch applies (`withdrawal.ts:213-217`). `pp-q2` is **abandoned**, even though its other seat (the loser of `pp-q1`) is filled. Nothing is forfeited. The product reports policy `"walkover"` with walkovers 0 and voided 1, and `pp-final`'s away seat (`winnerOf("pp-q2")`) is never filled (corrected at plan review 2, I-1: the first version of this prediction assumed a forfeit to the opponent).

  Predicted outcome, once Task 7 makes `r4-cascade-consistent` kind-aware (D14, false premise 16): `r4-policy-reported` and `r4-cascade-consistent` pass, and the stage never completes. The full failing set is `["I4-nothing-ends-stuck", "life-loop-bounded"]` (corrected at plan review 3, I-2):
  - the loop runs out of seated open fixtures, because `pp-final` is unseated, so `finishStage` runs;
  - the product answers `200 completed: false` with no code (`stages.ts:4153-4154`), which I4 reds as "did not complete … and named no reason" (`invariants.ts:238`);
  - `life-stage-completed` ABSTAINS, because `pp-final` is still open (`assertions.ts:225`, "life-loop-bounded judges an unfinished one");
  - `life-loop-bounded` reds on the unfinished stage.

  That is a **product red → W4** ("a page-playoff withdrawal voids the path to the final"). Between Task 2 and Task 7, `r4-cascade-consistent` still uses the table/bracket model and would red on this shape for a harness reason. No live R4 `page_playoff_only` evidence is taken before Task 7.

  A fake test pins the harness side, on `FakeKnockoutDriver` (`__tests__/fake-driver.ts:400`) with a new option `pagePlayoff: true`: 4 seats, the `pp-*` shape from `generatePagePlayoff`, and the open-format abandon on withdrawal mirrored from `withdrawal.ts:213-217`. In Task 2 it asserts:
  - policy `walkover`, walkovers 0, voided 1;
  - `pp-q2` `abandoned`, `pp-final` never seated;
  - no `/complete` retry.

  Task 7 adds `expect(verdict("r4-cascade-consistent")).toBe("pass")` to the same test, which is its killer for the kind-aware mutant, together with the full failing set `["I4-nothing-ends-stuck", "life-loop-bounded"]` and `expect(verdict("life-stage-completed")).toBe("abstain")`. Task 15 Step 3 lists the case among the predicted reds.

- [ ] **Step 2: Run: expect FAIL** (no module; F1 is `ALWAYS`).

- [ ] **Step 3: Implement** `field-size.ts`:
  ```ts
  // Folded in beneath ruling 49: the field a scripted scenario seeds is the
  // FORMAT's, not a fixed 8. A page playoff takes exactly 4
  // (packages/engine/src/scheduling/bracket.ts generatePagePlayoff:
  // "page playoffs need exactly 4 entrants"), so an odd field (F1) is unfit
  // there — dropped in applicability, and refused here if ever asked.
  import type { RowKey } from "./catalogue.ts";
  import type { ScenarioKey } from "./scenarios/types.ts";

  export const PAGE_PLAYOFF_FIELD = 4;
  export const DEFAULT_FIELD = 8;
  export const ODD_FIELD = 7;
  const FIXED: Readonly<Partial<Record<RowKey, number>>> = Object.freeze({ page_playoff_only: PAGE_PLAYOFF_FIELD });

  export class NoFieldSize extends Error {
    readonly row: string;
    readonly scenario: string;
    constructor(row: string, scenario: string, why: string) {
      super(`field-size: no field for ${row} × ${scenario} — ${why}`);
      this.name = "NoFieldSize";
      this.row = row;
      this.scenario = scenario;
    }
  }

  export function fieldSizeFor(row: RowKey, scenario: ScenarioKey): number {
    const fixed = Object.prototype.hasOwnProperty.call(FIXED, row) ? FIXED[row]! : null;
    switch (scenario) {
      case "LIFECYCLE": case "M1": case "R4": return fixed ?? DEFAULT_FIELD;
      case "F1":
        if (fixed !== null) throw new NoFieldSize(row, scenario, `an odd field is impossible on a fixed ${fixed}-seat format (unfit; drop-list F1)`);
        return ODD_FIELD;
      default: throw new NoFieldSize(row, scenario, "this scenario seeds its own field");
    }
  }
  ```
  Each of the four scenarios calls `setUpDivision(ctx, rec, fieldSizeFor(ctx.spec.row, <KEY>))`. `applicability.ts`, beside the other predicates:
  ```ts
  const onlyPagePlayoff: Predicate = (f) => f.stages.length === 1 && f.stages[0]!.kind === "page_playoff";
  ```
  Then `F1: rule(not(onlyPagePlayoff), "an odd field cannot enter a fixed 4-seat page playoff (engine generatePagePlayoff: exactly 4) — unfit (ruling 6, case by case)", T, "page_playoff_only|generic")`. Match `StageFact`'s real field names at `applicability.ts:20-27`.

- [ ] **Step 4: Regenerate the catalogue as a reviewed diff.**
  `cd <worktree> && pnpm matrix:catalogue --write; echo EXIT=$?` must REFUSE (floors lowered), `EXIT=2`. Paste the refusal. Then run `pnpm matrix:catalogue --write --accept-lower-floors; echo EXIT=$?` → 0.

  Review `git diff --stat scripts/matrix/catalogue/` and the diff itself. Expected:
  - `drop-list.json`: one new `F1` group, `kind: "inapplicable"`, 11 cells on `page_playoff_only`, and `total` +11;
  - `floors.json`: `page_playoff_only`'s floor −11, and the sums −11;
  - `counts.json`: the matching totals;
  - `l2-pairs.json`: **renumbered and re-widthed, accepted once by ruling 50.** Removing run 801 (`F1 × page_playoff_only × football/11-a-side`) takes F1 from 21 picks to 20, which removes F1's lap shift and every later lap shift and moves every later run number by −1 (`scripts/matrix/lib/pairs.ts:132-165`; false premise 15). Plan review 1 simulated it: **931 of 1,731 runs renumbered, 949 re-widthed**. Committed evidence stays judged against `plans.lock.json`, never today's planner.

  **What MUST still hold (ruling 50), checked mechanically, not by eye.** Run, from the worktree:
  ```bash
  cd <worktree> && git show HEAD:scripts/matrix/catalogue/l2-pairs.json > "$TMPDIR/w1drv-l2-before.json" && node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));const key=r=>JSON.stringify([r.scenario,r.row,r.sport,r.preset,r.bound,r.covers,r.l3Gap]);const gone=a.runs.filter(r=>r.scenario==="F1"&&r.row==="page_playoff_only");const keep=a.runs.filter(r=>!(r.scenario==="F1"&&r.row==="page_playoff_only")).map(key);const now=b.runs.map(key);const missing=keep.filter(k=>!now.includes(k));const extra=now.filter(k=>!keep.includes(k));const renum=b.runs.filter(r=>{const o=a.runs.find(x=>key(x)===key(r));return o&&o.n!==r.n}).length;const rewidth=b.runs.filter(r=>{const o=a.runs.find(x=>key(x)===key(r));return o&&o.width!==r.width}).length;console.log(JSON.stringify({before:a.runs.length,after:b.runs.length,removed:gone.length,missing:missing.length,extra:extra.length,renumbered:renum,rewidthed:rewidth,nContiguous:b.runs.every((r,i)=>r.n===i+1),rowScenarioDelta:b.targets.rowScenario-a.targets.rowScenario}))' "$TMPDIR/w1drv-l2-before.json" scripts/matrix/catalogue/l2-pairs.json; echo EXIT=$?
  ```
  Green means ALL of:
  - `removed == 1` and `after == before − 1` (the run count; 1,732 → 1,731 at the tree the plan was pinned on);
  - `missing == 0` and `extra == 0`: every non-(F1, `page_playoff_only`) run is still present with the same scenario, row, sport, preset, bound, `covers` and `l3Gap`, and no new run appeared;
  - `nContiguous == true`;
  - `rowScenarioDelta == −1`;
  - `renumbered` and `rewidthed` are **pasted, not judged** (expected 931 and 949 by review 1's simulation; a different number is a note to the controller, not a stop, since both are accepted by ruling 50);
  - `committed-plans-frozen.test.ts` and `committed-matrix.test.ts` green in Step 5 (committed runs are judged against `plans.lock.json`, so the reshuffle must not touch any of them).

  **Stop condition:** `missing > 0`, `extra > 0`, `removed ≠ 1`, or a red `committed-plans-frozen.test.ts`. Any of those is not the reshuffle ruling 50 accepted; do not commit, report the JSON line to the controller.

  The commit body names the acceptance: "l2-pairs.json reshuffled once (N renumbered, M re-widthed of 1,731), accepted by owner ruling 50; committed evidence stays judged against plans.lock.json".

- [ ] **Step 5: Run: expect PASS.** Files: `field-size.test.ts`, `applicability.test.ts`, `scenarios.test.ts`, `committed-catalogue.test.ts`, `probe-set.test.ts`, `pairs.test.ts`, `committed-plans-frozen.test.ts`, `committed-matrix.test.ts`, `strip-types-loadable.test.ts`. Then `pnpm matrix:catalogue --check` → 0.
- [ ] **Step 6: Mutation:**
  - `FIXED` empty → killed by "seeds exactly the one size the engine's page playoff accepts";
  - the F1 `throw` returns 7 → killed by "F1 on page_playoff_only is unfit";
  - `onlyPagePlayoff` → `() => false` → killed by the applicability witness test.
- [ ] **Step 7: tsc + eslint; commit** `feat(matrix): per-format field size — page playoff seeds 4, F1 unfit there (W1-driving T2)`.

---

## Task 3: The driver roster seam — members on `addEntrants`, `putLineup`, `entrantMembers`; the browser delegates both

**Why:** 45 single-stage team cells, and every team cell on the multi-stage and ladder rows, need rosters (`common.ts:112`; `_INDEX.md` cricket#001: ball-by-ball needs a batting order of ≥2). The roster must be full size (D2) and pass the engine's lineup rules (Review Focus 1).

**Files:**
- Create: `scripts/matrix/lib/scenarios/rosters.ts`, `scripts/matrix/__tests__/rosters.test.ts`
- Modify:
  - `scripts/matrix/lib/driver/types.ts` (`MemberInput`, `EntrantInput`, `EntrantMember`, `LineupSlotWire`, `OrganiserDriver.putLineup/entrantMembers`);
  - `http-driver.ts`, `browser-driver.ts`, `mixed.ts` (`FILLER`);
  - `__tests__/fake-driver.ts` (the fakes store members and lineups).
- Test: `rosters.test.ts`, `http-driver.test.ts`, `browser-driver.test.ts`, `mixed-driver.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export interface MemberInput { readonly fullName: string; readonly squadNumber: number; readonly isCaptain: boolean }
  export interface EntrantInput { readonly displayName: string; readonly seed: number; readonly kind: EntrantKind; readonly members?: readonly MemberInput[] }
  export interface EntrantMember { readonly person_id: string; readonly squad_number: number | null; readonly is_captain: boolean }
  export interface LineupSlotWire { readonly person_id: string; readonly slot: "starting" | "bench"; readonly position_key?: string; readonly order_no?: number; readonly roles?: readonly string[] }
  // OrganiserDriver:
  addEntrants(divisionId: string, entrants: readonly EntrantInput[]): Promise<EntrantRow[]>;
  entrantMembers(entrantId: string): Promise<EntrantMember[]>;          // GET /api/v1/entrants/{id} → members
  putLineup(fixtureId: string, entrantId: string, slots: readonly LineupSlotWire[]): Promise<void>; // PUT /api/v1/fixtures/{id}/lineups/{entrantId}
  // rosters.ts:
  export const ROSTER_MAX = 40; // schemas.ts CreateEntrant members .max(40)
  export function rosterSize(sport: string, cfg: unknown): number;
  export function rosterMembers(sport: string, cfg: unknown, entrantNo: number): MemberInput[];
  export function lineupFor(sport: string, cfg: unknown, members: readonly EntrantMember[]): LineupSlotWire[];
  export class RosterTooLarge extends Error {}
  ```

- [ ] **Step 1: Write the failing tests.** List the transitions first: an empty roster; a second PUT for the same fixture; a withdrawn entrant; another sport.

  `rosters.test.ts`:
  ```ts
  import { forEachSport } from "@seazn/engine/testkit";
  import { resolvePositions, sportModule, validateLineup } from "@seazn/engine/sport";
  import { describe, expect, it } from "vitest";
  import { entrantKindFor, resolveSportCfg } from "../lib/sport-cfg.ts";
  import { offlineVariantOrder } from "../lib/variants.ts";
  import { ROSTER_MAX, RosterTooLarge, lineupFor, rosterMembers, rosterSize } from "../lib/scenarios/rosters.ts";

  const asMembers = (n: number) => Array.from({ length: n }, (_, i) => ({ person_id: `p${i + 1}`, squad_number: i + 1, is_captain: i === 0 }));
  const toEngine = (entrantId: string, slots: ReturnType<typeof lineupFor>) => ({
    entrantId,
    slots: slots.map((s) => ({ personId: s.person_id, slot: s.slot, ...(s.position_key !== undefined ? { positionKey: s.position_key } : {}), roles: [...(s.roles ?? [])], ...(s.order_no !== undefined ? { orderNo: s.order_no } : {}) })),
  });

  describe("rosters", () => {
    it("empty case first: a lineup from no members is refused by name, never an empty PUT", () => {
      expect(() => lineupFor("football", resolveSportCfg("football", offlineVariantOrder("football")[0]!), [])).toThrow(/no members/);
    });
    it("every sport's lineup, at every preset, passes the engine's validateLineup — counted", () => {
      let checked = 0;
      forEachSport(({ key }) => {
        for (const preset of offlineVariantOrder(key)) {
          const cfg = resolveSportCfg(key, preset);
          if (entrantKindFor(key, cfg) !== "team") continue;
          const catalog = resolvePositions(sportModule(key) as never, cfg as never);
          const n = rosterSize(key, cfg);
          expect(n, `${key}/${preset}`).toBe(catalog.lineup.size + (catalog.lineup.benchMax ?? 0));
          const slots = lineupFor(key, cfg, asMembers(n));
          expect(validateLineup(catalog, toEngine("e1", slots)), `${key}/${preset}`).toEqual([]);
          checked++;
        }
      });
      expect(checked, "team presets checked").toBeGreaterThan(0);
    });
    it("members are synthetic and numbered: Matrix Player <entrant>.<m>, squad 1..n, one captain", () => {
      const cfg = resolveSportCfg("cricket", "t20");
      const m = rosterMembers("cricket", cfg, 3);
      expect(m.length).toBe(rosterSize("cricket", cfg));
      expect(m[0]).toEqual({ fullName: "Matrix Player 3.1", squadNumber: 1, isCaptain: true });
      expect(m.filter((x) => x.isCaptain).length).toBe(1);
      expect(new Set(m.map((x) => x.fullName)).size).toBe(m.length);
    });
    it("a catalog above the schema's 40 is refused by name; exactly 40 is accepted", () => {
      const of = (size: number, benchMax: number) => () => ({ groups: [], lineup: { size, benchMax } });
      expect(() => rosterSize("x", {}, of(35, 6))).toThrow(RosterTooLarge);
      expect(rosterSize("x", {}, of(35, 5))).toBe(ROSTER_MAX);
    });
  });
  ```
  The last test injects a catalog through `rosterSize`'s optional third argument (`catalogOf`, which defaults to the engine's `resolvePositions`).

  **Fallback catalogs (plan review 1, m-2).** Football (`packages/engine/src/sports/football/football.ts:1740,2445`), cricket (`sports/cricket/cricket.ts:2600,3532`) and the period kernel (`sports/period/kernel.ts:2451`, used by hockey and ice hockey) declare `positionsFor(cfg)`. The setbased kernel (volleyball, badminton, table tennis) does not: it answers one static `positions` per preset (`sports/setbased/kernel.ts:2281`) through `resolvePositions` (`packages/engine/src/sport/catalog.ts:53-55`). (Corrected at plan review 2, m-2: the first version said "only football".) So, by review 1's reading, volleyball's builder-default **beach** variant (2-a-side) gets a 6-starter catalog (14 members with the bench). The roster follows the engine's catalog, as D2 says, so this is not a harness bug. It is a **W2 finding**: "a variant whose side size differs from its catalog's `lineup.size`".

  The counted sweep must also report the mismatches. It keys the flag on SIZE, not on the absence of `positionsFor`, which would also flag indoor volleyball, whose catalog is correct. It collects `{sport, preset, sideSize, lineupSize, mismatch: sideSize !== lineupSize}`.
  - **`sideSize` comes from a cited rulebook table, not from the cfg** (plan review 3 m-5). No setbased cfg declares players-per-side: beach differs from indoor only in `bestOf`/`setTo`/`finalSetTo`/`pointsMap`/`records` (`sports/setbased/DOMAIN.volleyball.md:38-59`), and volleyball has one static 6-starter `positions` (`setbased/volleyball.ts:16,65`). A cfg-read size would be `null` everywhere, and the finding would vanish.
  - The table is `RULEBOOK_SIDE_SIZE` in the test file, one row per team preset, each row citing its source: for example `volleyball/beach: 2` (FIVB Official Beach Volleyball Rules, team composition: a team is two players) and `volleyball/indoor: 6` (FIVB Official Volleyball Rules, six players on court). Each row carries the rule number from the current edition, which the executor records when writing the table. TEST-STRATEGY allows the rulebook as the oracle. A preset with no row reds, "no rulebook side size for <sport>/<preset>", so the table cannot silently skip a preset.
  - The finding is recorded BY NAME: `expect(mismatches.map((m) => \`${m.sport}/${m.preset}\`)).toContain("volleyball/beach")`. The full list is pinned as found, and it must contain `volleyball/beach`. **An empty mismatch list is a FAILURE**, and so is a list without beach: the W2 finding cannot vanish until W2 closes it, and closing it means changing this assertion in W2's own commit.

  This way the finding cannot silently vanish or silently grow. Task 16 records it in `_INDEX.md` → W2.

  `http-driver.test.ts`, on the existing stub transport:
  - `addEntrants` with members posts `members: [{new_person: {full_name}, squad_number, is_captain}]`, one per member, in order;
  - without members it posts no `members` key (a byte-for-byte check that individual cells are unchanged);
  - `entrantMembers` GETs `/api/v1/entrants/{id}` and returns `members`, ordered by `squad_number`;
  - `putLineup` PUTs `{slots}` to `/api/v1/fixtures/{f}/lineups/{e}`, and a 409/422 answer throws `RefusedCall` with the product's code.

  `browser-driver.test.ts`, on its fake page harness: `addEntrants` with members runs the UI add, then `POST /persons` ×n and `PATCH /entrants/{id} {members}` over the wrapped HttpDriver. `putLineup` goes straight to HTTP. The mixed ledger records both as FILLER, never as a browser or HTTP organiser action, and `mixed-driver-coverage` is unaffected.

- [ ] **Step 2: Run: expect FAIL.**
- [ ] **Step 3: Implement** `rosters.ts`:
  ```ts
  // D2 (W1-driving plan): rosters are the FULL declared size — the engine's
  // own catalog (resolvePositions: starting lineup + bench) — so cricket's
  // all-out (min(playersPerSide, order.length) − 1) means what the generated
  // stream means, and every lineup passes validateLineup (Review Focus 1).
  import { resolvePositions, sportModule, type PositionCatalog } from "@seazn/engine/sport";
  import type { EntrantMember, LineupSlotWire, MemberInput } from "../driver/types.ts";

  export const ROSTER_MAX = 40; // apps/web/src/server/api-v1/schemas.ts CreateEntrant members .max(40)
  type CatalogOf = (sport: string, cfg: unknown) => PositionCatalog;
  const engineCatalog: CatalogOf = (sport, cfg) => resolvePositions(sportModule(sport) as never, cfg as never);

  export class RosterTooLarge extends Error {
    constructor(sport: string, n: number) {
      super(`rosters: ${sport} declares ${n} players (lineup + bench), above the entrant schema's ${ROSTER_MAX}`);
      this.name = "RosterTooLarge";
    }
  }

  export function rosterSize(sport: string, cfg: unknown, catalogOf: CatalogOf = engineCatalog): number {
    const c = catalogOf(sport, cfg);
    const n = c.lineup.size + (c.lineup.benchMax ?? 0);
    if (n > ROSTER_MAX) throw new RosterTooLarge(sport, n);
    return n;
  }

  export function rosterMembers(sport: string, cfg: unknown, entrantNo: number, catalogOf: CatalogOf = engineCatalog): MemberInput[] {
    return Array.from({ length: rosterSize(sport, cfg, catalogOf) }, (_, i) => ({ fullName: `Matrix Player ${entrantNo}.${i + 1}`, squadNumber: i + 1, isCaptain: i === 0 }));
  }

  /** Starters = lineup.size, in squad order. Each group's `min` is filled
   *  first (a football goalkeeper), then the rest take the first group with
   *  room under its `max`; each required role goes to a distinct starter. */
  export function lineupFor(sport: string, cfg: unknown, members: readonly EntrantMember[], catalogOf: CatalogOf = engineCatalog): LineupSlotWire[] {
    if (members.length === 0) throw new Error(`rosters: ${sport} lineup from no members — seed the roster before the first event`);
    const c = catalogOf(sport, cfg);
    const ordered = [...members].sort((a, b) => (a.squad_number ?? 0) - (b.squad_number ?? 0));
    if (ordered.length < c.lineup.size) throw new Error(`rosters: ${sport} needs ${c.lineup.size} starters, roster has ${ordered.length}`);
    const starters = ordered.slice(0, c.lineup.size);
    const count = new Map<string, number>();
    const positions: (string | undefined)[] = starters.map(() => undefined);
    let i = 0;
    for (const g of c.groups) for (let k = 0; k < (g.min ?? 0); k++, i++) { positions[i] = g.key; count.set(g.key, (count.get(g.key) ?? 0) + 1); }
    for (; i < starters.length; i++) {
      const g = c.groups.find((x) => x.max === undefined || (count.get(x.key) ?? 0) < x.max);
      if (g !== undefined) { positions[i] = g.key; count.set(g.key, (count.get(g.key) ?? 0) + 1); }
    }
    const required = (c.roles ?? []).filter((r) => r.required === true).map((r) => r.key);
    const out: LineupSlotWire[] = starters.map((m, j) => ({
      person_id: m.person_id, slot: "starting", order_no: j + 1,
      ...(positions[j] !== undefined ? { position_key: positions[j] } : {}),
      roles: required[j] !== undefined ? [required[j]!] : [],
    }));
    for (const m of ordered.slice(c.lineup.size, c.lineup.size + (c.lineup.benchMax ?? 0))) out.push({ person_id: m.person_id, slot: "bench", roles: [] });
    return out;
  }
  ```
  Put required roles on the LAST starters instead if Step 5's sweep shows a role colliding with a group (for example, a keeper role on a goalkeeper slot). The engine's `validateLineup` decides, not this comment.

  `HttpDriver`:
  ```ts
  async addEntrants(divisionId: string, entrants: readonly EntrantInput[]): Promise<EntrantRow[]> {
    const out = await this.#call<EntrantRow | EntrantRow[]>(`/api/v1/divisions/${divisionId}/entrants`, "POST", entrants.map((e) => ({
      kind: e.kind, display_name: e.displayName, seed: e.seed,
      ...(e.members !== undefined ? { members: e.members.map((m) => ({ new_person: { full_name: m.fullName }, squad_number: m.squadNumber, is_captain: m.isCaptain })) } : {}),
    })));
    return Array.isArray(out) ? out : [out];
  }
  async entrantMembers(entrantId: string): Promise<EntrantMember[]> {
    const e = await this.#call<{ members?: EntrantMember[] }>(`/api/v1/entrants/${entrantId}`);
    return [...(e.members ?? [])].sort((a, b) => (a.squad_number ?? 0) - (b.squad_number ?? 0));
  }
  async putLineup(fixtureId: string, entrantId: string, slots: readonly LineupSlotWire[]): Promise<void> {
    await this.#call(`/api/v1/fixtures/${fixtureId}/lineups/${entrantId}`, "PUT", { slots });
  }
  ```
  `BrowserDriver.addEntrants`: the existing UI add (display names only). Then, when any input has members, for each created entrant the wrapped HttpDriver runs `POST /api/v1/persons {full_name}` per member and `PATCH /api/v1/entrants/{id} {members: [{person_id, squad_number, is_captain}]}`. That call is `HttpDriver.setMembers(entrantId, members)`, a public helper the browser uses. `entrantMembers` and `putLineup` delegate to HttpDriver. `mixed.ts` gets:
  ```ts
  /** Ruling 47: setup filler — HTTP by design in every layer, never an organiser
   *  action type (no browser turn is owed), recorded so a report shows it ran. */
  export const FILLER = ["setMembers", "putLineup", "entrantMembers", "confirmSeedProposal", "recomputeSeedProposal", "challenge", "americanoView"] as const;
  ```
  Add `MixedLedger.filler(name)`, which counts filler calls and refuses a name outside `FILLER`.

  The fakes (`fake-driver.ts`) store members per entrant, with ids `p-<entrant>-<m>`. `putLineup` validates that every `person_id` is a member of that entrant (the product's rule: only entrant members may appear) and that the fixture is `scheduled`, else it throws `RefusedCall(…, 422, "LINEUP_INVALID")`. The fake's refusal code is a fake's; pin the real code at Task 4 Step 0 and use the product's.
- [ ] **Step 4: Run: expect PASS.** Files: `rosters.test.ts`, `http-driver.test.ts`, `browser-driver.test.ts`, `mixed-driver.test.ts`, `strip-types-loadable.test.ts`.
- [ ] **Step 5: Mutation:**
  - drop the group-`min` loop → killed by the `validateLineup` sweep (football `group_min`);
  - drop the required-roles assignment → killed by the sweep (cricket `role_missing`, if the catalog declares one; if none does, record that this mutant is equivalent);
  - `rosterSize` without the bench → killed by the size assertion (a sport with `benchMax > 0`);
  - `addEntrants` always sends `members: []` → killed by the byte-for-byte no-members test;
  - `mixed.filler` accepts any name → killed by the refusal test.
  - the side-size sweep reads `sideSize` from the cfg (null everywhere, so no mismatch) → killed by "the mismatch list contains `volleyball/beach`" and by the empty-list failure (review 3 m-5);
  - delete the `volleyball/beach` row from `RULEBOOK_SIDE_SIZE` → killed by "no rulebook side size for volleyball/beach".
- [ ] **Step 6: tsc + eslint; commit** `feat(matrix): roster seam — members on addEntrants, putLineup, entrantMembers; browser seeds them as filler (W1-driving T3, D2, ruling 47)`.

---

## Task 4: Lineups before every team fixture's first event; the team deferral goes

**Why:** Members alone do not reach the engine, which reads per-fixture lineups only (`engine-db` `loadLineupPair`). So a lineup must be PUT while the fixture is `scheduled`, before its first event (fold-in beneath ruling 49).

**Files:**
- Modify: `scripts/matrix/lib/scenarios/common.ts` (`:112` deferral removed; `setUpDivision` passes members for team kind; `decideFixture` PUTs lineups first).
- Test: `scenarios.test.ts` (`:1013-1018` re-pinned), `pad-proof.test.ts:139-153` (the `rosterlessTeams` path still skips rosters: D3).

**Interfaces:**
- Consumes: `rosterMembers`, `lineupFor`, `OrganiserDriver.entrantMembers/putLineup` (Task 3).
- Produces: `DivisionSetup.rosters: ReadonlyMap<string, readonly EntrantMember[]>` (TEAM entrants only; empty for non-team or rosterless); `DivisionSetup.kind`, `DivisionSetup.entrantIds`, `DivisionSetup.rosterless`; `Recorder.lineupsPut: number`.

- [ ] **Step 0: Pin the product.** Read `apps/web/src/server/usecases/fixtures.ts`'s `putLineup` and record in the report:
  - the refusal code for a non-member `person_id`;
  - the code for a non-`scheduled` fixture;
  - whether a second PUT replaces or appends;
  - (plan review 1, m-3) what a lineup that fails `validateLineup` does, with file:line for each stage: does the PUT refuse (and with which code), does it store and warn, or does the first event refuse through `assertLineup`? Review Focus 1's "422 on its first event" is a hypothesis until this line is pinned; the Task 3 sweep guards against it whichever way the product answers.

  The fake adopts the real codes (Task 3 Step 3 note).

- [ ] **Step 1: Write the failing tests** (`scenarios.test.ts`). Transitions: the first fixture; a second fixture with the same entrants (lineup PUT again, per fixture); a bye (no PUT for the phantom seat); a withdrawn entrant's walkover (no event, so no PUT); another sport.
  ```ts
  it("a team sport plays with full rosters: members at add, a lineup per side before each fixture's first event", async () => {
    const football = Object.keys(sportModule("football").variants as object)[0]!;
    const driver = new FakeLeagueDriver();
    const { state } = await runOn(driver, "LIFECYCLE", { sport: "football", variant: football });
    const cfg = resolveSportCfg("football", football);
    const size = rosterSize("football", cfg);
    const adds = driver.calls.filter((c) => c.startsWith("addEntrants"));
    expect(adds.length).toBe(1);
    expect(driver.memberCount()).toBe(fieldSizeFor("league", "LIFECYCLE") * size);
    // Order: for every decided fixture, both lineups precede its first postEvent.
    const decided = driver.decidedFixtureIds();
    expect(decided.length).toBeGreaterThan(0);
    for (const f of decided) {
      const firstEvent = driver.calls.findIndex((c) => c === `postEvent ${f}`);
      const lineups = driver.calls.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith(`putLineup ${f} `));
      expect(lineups.length, f).toBe(2);
      for (const [, i] of lineups) expect(i, f).toBeLessThan(firstEvent);
    }
    expect(state).toBe("works");
  });
  it("an individual sport sends no members and no lineups (the W1a path is byte-identical)", async () => {
    const driver = new FakeLeagueDriver();
    await runOn(driver, "LIFECYCLE");
    expect(driver.calls.some((c) => c.startsWith("putLineup"))).toBe(false);
    expect(driver.memberCount()).toBe(0);
  });
  ```
  Add the helpers `memberCount()` and `decidedFixtureIds()` to `FakeLeagueDriver`. The old test "a team sport is ScenarioUnsupported(DRIVING_WAVE, team rosters)" is DELETED here, and its deletion is named in the commit body.

- [ ] **Step 2: Run: expect FAIL.**
- [ ] **Step 3: Implement.** In `setUpDivision`:
  - delete the `:112` deferral;
  - build `inputs` with `members: kind === "team" && o.rosterlessTeams !== true ? rosterMembers(sport, cfg, i + 1) : undefined`;
  - after `addEntrants`, for team kind read `rosters` via `entrantMembers(e.id)` for each entrant. The product's person ids are the truth, never the inputs. Refuse by name if any roster's length differs from `rosterSize` (a guard: a product that dropped a member would otherwise play short).

  A new exported helper in `common.ts`:
  ```ts
  /** Fold-in beneath ruling 49: a team fixture's lineups are PUT while it is
   *  still scheduled, before the harness posts anything to it. Once per fixture
   *  (rec.lineupFixtures), because a second PUT is a replacement the scenario
   *  never meant.
   *  Plan review 1 I-1: gated on TEAM kind AND the side being one of the
   *  division's own entrants. An americano/mexicano fixture seats ephemeral
   *  PAIR entrants the product minted (stages.ts:681 pairEntrantsFor), which
   *  are in no roster; that side is skipped with a named note (once per stage),
   *  never thrown and never PUT. A DIVISION entrant with no recorded roster is
   *  still a harness bug, named. */
  export async function ensureLineups(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, f: FixtureRow): Promise<void> {
    // D3: a PADPROOF rosterless setup scores team fixtures with no lineup (W1c D-T9-2), so it returns first.
    if (setup.rosterless || setup.kind !== "team" || rec.lineupFixtures.has(f.id)) return;
    for (const side of [f.home_entrant_id, f.away_entrant_id]) {
      if (side === null) continue;
      if (!setup.entrantIds.has(side)) {
        const note = `lineups: stage ${f.stage_id} seats ${side}, not a division entrant (a product-minted pair entrant) — no lineup PUT`;
        if (!rec.notes.includes(note)) rec.notes.push(note);
        continue;
      }
      const members = setup.rosters.get(side);
      if (members === undefined) throw new Error(`scenario: fixture ${f.id} seats division entrant ${side}, which has no recorded roster`);
      await ctx.driver.putLineup(f.id, side, lineupFor(ctx.spec.sport, ctx.cfg, members));
      rec.lineupsPut++;
    }
    rec.lineupFixtures.add(f.id);
  }
  ```
  `DivisionSetup` gains `kind: EntrantKind`, `entrantIds: ReadonlySet<string>` (the ids `addEntrants` answered) and `rosterless: boolean` (`= o.rosterlessTeams === true`, set by `setUpDivision`; plan review 2 m-1). `rosters` holds TEAM entrants only; americano individuals' persons go in a separate `setup.persons` (Task 5), never in `rosters`, so `ensureLineups` can never PUT a lineup for an individual sport. A rosterless PADPROOF setup has `kind "team"` and an empty `rosters`, so it takes the `setup.rosterless` early return on the first line of `ensureLineups` (D3). `pad-proof.test.ts` pins it (it calls `decideFixture` on rosterless team fixtures, `pad-proof.ts:56,73`); mutant "drop `setup.rosterless ||`" → killed by `pad-proof.test.ts` ("has no recorded roster").

  Two more Step 1 tests, stated empty-case first:
  ```ts
  it("ensureLineups: an individual sport (rosters empty, kind individual) PUTs nothing and throws nothing", async () => { /* FakeLeagueDriver, league|badminton: putLineup calls 0 */ });
  it("ensureLineups: a side that is not a division entrant (a pair entrant) is skipped with one note, never thrown", async () => {
    // A FakeLeagueDriver option `seatForeignSide: "pair-x"` seats one non-division entrant on fixture 1 of a football league.
    // Expected: putLineup for the division side only (1 call on that fixture), rec.notes has exactly one "not a division entrant" line, the case does not crash.
  });
  ```
  The mutant "drop the `entrantIds.has` gate" is killed by the second test (the named throw fires). The americano end-to-end form of it (`americano|badminton` LIFECYCLE puts zero lineups and completes; `americano|football` puts zero lineups, notes the pair-entrant skip and completes) is in Task 8 Step 1, once the americano loop exists.

  `Recorder` gains `readonly lineupFixtures = new Set<string>()` and `lineupsPut = 0`. `decideFixture` calls `await ensureLineups(ctx, rec, setup, f)` after its terminal-status early return and before the `posted = …` line, so it covers both the score branch and the forfeit branch. Step 0 pins whether the product needs a lineup for a forfeit or walkover on a team fixture:
  - if it does, M1's hook (which calls `ctx.driver.forfeit` directly) calls `ensureLineups` first too;
  - if it does not, the hook is left alone.

  The test asserts whichever Step 0 found, citing the product line.
- [ ] **Step 4: Run: expect PASS.** Files: `scenarios.test.ts`, `pad-proof.test.ts`, `rosters.test.ts`.
- [ ] **Step 5: Mutation:**
  - PUT lineups AFTER the first event → killed by the ordering test;
  - skip the away side → killed by `lineups.length === 2`;
  - drop the roster-length guard → killed by a new test where the fake drops one member at add and expects a named error.
- [ ] **Step 6: tsc + eslint; commit** `feat(matrix): team rosters and per-fixture lineups; the team-roster deferral goes (W1-driving T4, D3)`.

---

## Task 5: Linked persons for americano and mexicano individuals

**Why:** Americano needs ≥4 individual entrants, each with a linked person, else it answers `STAGE_NOT_READY` (`stages.ts:744-754`). Individuals today are names only (fold-in beneath ruling 49).

**Files:**
- Modify: `scripts/matrix/lib/scenarios/common.ts` (member inputs for individuals on an `americano` stage); `__tests__/fake-driver.ts`.
- Test: `scenarios.test.ts`.

**Interfaces:**
- Consumes: `EntrantInput.members` (Task 3).
- Produces: `personsNeeded(stageBodies): boolean`, true when any body is `kind: "americano"`. On such a row, an individual entrant carries exactly one member `{fullName: "Matrix Player N", squadNumber: 1, isCaptain: true}`. `DivisionSetup.persons: ReadonlyMap<string, readonly string[]>`: division entrant → its person ids as `entrantMembers` answered (one for an americano individual; the whole roster for a team entrant; empty map on a non-americano row). It is separate from `rosters` (plan review 1 I-1), so nothing that reads `rosters` ever sees an individual.

- [ ] **Step 1: Failing tests.** Transitions: americano; mexicano (the same stage kind, and the row decides the mode); a non-americano individual row, where nothing changes; a team sport on americano, which carries its full roster (Task 4) and **generates** on the product (false premise 10, corrected at plan review 1: one arbitrary member per team becomes the "player"; a W7 finding, never a harness red). Note: running americano needs Task 8's loop. Until then, the test drives `setUpDivision` only and asserts:
  - the `addEntrants` payload: one member per individual entrant on `americano|badminton`, and none on `league|badminton`;
  - `setup.persons` on `americano|badminton` maps each of the 8 entrants to exactly one person id, and `setup.rosters.size === 0`;
  - on `americano|football`, `setup.rosters.size === 8` (full rosters) and `setup.persons` maps each team to its whole roster.
- [ ] **Step 2: Run: expect FAIL.**
- [ ] **Step 3: Implement.** In `setUpDivision`, `members` for an individual on an americano row = `[{ fullName: \`Matrix Player ${i + 1}\`, squadNumber: 1, isCaptain: true }]`. That is one synthetic person with the entrant's own name. After `addEntrants`, on an americano row, `persons` is read through `entrantMembers(e.id)` for each entrant (the product's person ids, never the inputs). The americano loop (Task 8), M1's pair-entrant target (D14) and I10 (Task 9) read `setup.persons`.
- [ ] **Step 4: PASS** (`scenarios.test.ts`).
- [ ] **Step 5: Mutation:**
  - `personsNeeded` → `false` → killed by the payload test;
  - write the americano persons into `rosters` as well → killed by `setup.rosters.size === 0` on `americano|badminton` (and, once Task 8 lands, by its zero-lineups test).
- [ ] **Step 6: tsc + eslint; commit** `feat(matrix): americano/mexicano individuals carry a linked person (W1-driving T5)`.

---

## Task 6: Multi-stage driving — later stages generated after Start, complete once, confirm the seed proposal, play on

**Why:** 99 LIFECYCLE cells sit on the 9 multi-stage rows (`common.ts:110`), and their scenario twins do too. It is the largest single block of ⏳.

**Files:**
- Create: `scripts/matrix/lib/scenarios/advance.ts`, `scripts/matrix/__tests__/multi-stage.test.ts`, `scripts/matrix/__tests__/fake-formats-driver.ts`
- Modify:
  - `scripts/matrix/lib/driver/types.ts` (`FixtureRow.ext_key?`, `is_final?`; `CompleteOut.seed_proposal?`; `SeedProposalOut`, `SeedConfirmOut`; `confirmSeedProposal`, `recomputeSeedProposal`);
  - `http-driver.ts`, `browser-driver.ts` (filler delegation);
  - `scripts/matrix/lib/scenarios/common.ts`:
    - `:110` deferral removed;
    - `StageTrack`;
    - `recordGenerate(ctx, rec, stageId)` records per stage;
    - `decideFixture(…, stage)`;
    - `playStage(…, stage)`;
    - `playDivision`;
    - `finishStage(ctx, rec, stageId)`;
    - `snapshot` per stage;
  - `lib/observed.ts` (`ObservedFixture.extKey?`, `isFinal?`; `CaseFact` gains `"seeding_tie_picked"`);
  - `lib/scenarios/{lifecycle,m1-walkover,r4-withdrawal,f1-odd-field,pad-proof}.ts` (they call `playDivision` and the per-stage `snapshot`; PADPROOF keeps its own single-stage loop and only moves to the new `snapshot` signature).
- Test: `multi-stage.test.ts`, `scenarios.test.ts` (`:1004-1011` deleted: the multi-stage deferral test), `http-driver.test.ts`, `invariants.test.ts` (unchanged `divisionWideLaterStage` behaviour).

**Interfaces:**
- Consumes: `ensureLineups` (Task 4), `fieldSizeFor` (Task 2).
- Produces:
  ```ts
  // driver/types.ts
  export interface SeedProposalRef { readonly id: string; readonly status: string }
  export interface CompleteOut { completed: boolean; events: { type: string; finalRanks?: string[] }[]; division_completed?: boolean; seed_proposal?: SeedProposalRef | null }
  export interface SeedTie { readonly slots: readonly string[]; readonly entrantIds: readonly string[]; readonly reason: string }
  export interface SeedProposalOut { readonly id: string; readonly status: string; readonly qualifiers: readonly { rank: number; entrantId: string; destinationSlot: string }[]; readonly ties: readonly SeedTie[] }
  export interface SeedConfirmOut { readonly proposalId: string; readonly filled: number; readonly fixtures: readonly FixtureRow[] }
  // OrganiserDriver:
  confirmSeedProposal(stageId: string, body: { proposalId: string; tiePicks?: readonly { slots: readonly string[]; order: readonly string[] }[] }): Promise<SeedConfirmOut>;
  recomputeSeedProposal(stageId: string): Promise<SeedProposalOut>;
  // common.ts
  export class StageTrack { exit: LoopExit | null; readonly generates: GenerateObs[]; readonly pairRounds: PairRoundObs[] }
  export interface StagePlay { readonly stage: StageRef; readonly field: readonly string[] | null; readonly advance: AdvanceObs | null; readonly complete: CompleteObs | null }
  export async function playDivision(ctx, rec, setup, hooks?: { beforeRound?; afterRound?; beforeComplete?: (stage: StageRef) => Promise<void> }): Promise<StagePlay[]>;
  export async function snapshot(ctx, rec, setup, plays: readonly StagePlay[], extra: { configEdit; withdrawal }): Promise<ObservedRun>;
  // advance.ts
  export interface AdvanceObs { readonly status: number; readonly code: string | null; readonly proposalId: string | null; readonly filled: number; readonly seeded: readonly string[]; readonly declared: number; readonly tiePicked: boolean }
  export function declaredTake(body: StagePostBody, sourcePools: number): number;
  export class UnknownTakeKind extends Error {}
  export async function confirmAdvance(ctx, rec, target: StageRef, proposal: SeedProposalRef, declared: number): Promise<AdvanceObs>;
  export function advanceSeededAsDeclared(plays: readonly StagePlay[], withdrawn: ReadonlySet<string>): CheckResult;   // id "advance-seeded-as-declared"
  ```
  `CompleteObs` gains `seedProposal: SeedProposalRef | null`. `DivisionSetup` gains `stages: StageRef[]` (every stage, seq order) and `rosters` (Task 4). `LoopExit` gains `"not_reached"`, for a later stage the run never got to.

- [ ] **Step 0: Pin the product.** Read and record in the report:
  - the 409 code and message when a later stage's generate follows the source's completion (`stages.ts:4176+`);
  - the tie refusal's code on confirm (`confirmSeedProposal` in `stages.ts`; expected `SEEDING_TIE_UNRESOLVED`, pinned before use);
  - whether confirm's `fixtures` lists the whole target stage or only the filled rows (the seeded field reads entrants off it);
  - that every `stagesForRow` multi-stage body has `progression.timing === "setup"`. That is a sweep in `multi-stage.test.ts`, counted over the 9 rows;
  - whether the seed proposal leaves out an entrant withdrawn in the source stage (file:line in the qualification builder). The fake mirrors what is found. If the product DOES seed a withdrawn entrant, the fast-check's withdrawn clause and `advance-seeded-as-declared`'s "no withdrawn entrant seeded" item become a predicted product red → W5, recorded in the report, and the fake gains a `seedWithdrawn` mode matching the product so the harness is tested against the real shape;
  - (plan review 1, m-1) the case org's stage cap: `stages.per_division.max` on the plan `chooseTopPublicPlan` picks (`scripts/matrix/lib/seed-org.ts:103-108`; the reviewer read `pro`, 6, from migration V393:77). No red today, but `gatesNeeded` covers feature gates only (`scripts/matrix/run.ts:352-369`), so a plan-catalogue change would read as a product ❌ on every 3-stage row (the W1b T10 RR-1 class). Step 3a adds the start gate.

- [ ] **Step 1: Write the failing tests.** Transitions: the first stage; a second stage; a third (`group_group_ko`); an empty seed (nobody qualifies); a second `/complete` (never); a stale proposal; a tie; a withdrawal before advancing (R4); a withdrawal at any point in the sequence (the rule-10 `withdrawOne` step, plan review 1 I-5); another sport (a team sport on `groups_ko`).

  `fake-formats-driver.ts`: `FakeMultiStageDriver extends FakeLeagueDriver`.
  - Stage 1 is a league or group (the base behaviour). Later stages are `knockout`, `group`, `stepladder` or `page_playoff` bodies.
  - Generate on a later stage before the source completes creates TBD rows (both seats null). After the source completes it throws `RefusedCall(…, 409, "STAGE_COMPLETED_SEEDING_FAILED")`, the code pinned in Step 0.
  - Complete on stage N answers `seed_proposal: {id: "sp-<N+1>-<k>", status: "draft"}`.
  - Confirm with that id fills the TBD rows with the top `declaredTake` entrants of stage N's fake standings, in rank order, and answers `{proposalId, filled, fixtures}`.
  - Confirm with any other id throws `409 SEEDING_PROPOSAL_STALE`. A second confirm throws `409 SEEDING_ALREADY_CONFIRMED` (`stages.ts:4774`).
  - A constructor option `tieAt?: number` makes the first confirm throw the Step 0 tie code, and `recompute` answer a proposal with one tie.

  The fake documents that it proves wiring only (the file header, like `fake-driver.ts:1-10`).

  `multi-stage.test.ts`:
  ```ts
  it("every multi-stage row's later bodies are timing 'setup', and declaredTake answers for each — counted", () => {
    let checked = 0;
    for (const row of ROW_KEYS) {
      const bodies = stagesForRow(row);
      for (const b of bodies.slice(1)) {
        expect(b.progression?.timing, `${row} seq ${b.seq}`).toBe("setup");
        expect(declaredTake(b, 2), `${row} seq ${b.seq}`).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBe(10); // 8 two-stage rows + group_group_ko's two later stages — derived below, not trusted
  });
  ```
  Derive the `10` in the same test as `ROW_KEYS.reduce((n, r) => n + stagesForRow(r).length - 1, 0)`, and assert that the typed 10 equals it. A new row then changes the derived value, and the typed pin says so.

  ```ts
  it("empty case first: a take kind the harness does not know is refused by name", () => {
    expect(() => declaredTake({ kind: "knockout", name: "x", config: {}, seq: 2, progression: { sources: [{ stage: "previous", take: [{ kind: "luckyLosers", n: 2 }] }], placement: "rank_order", timing: "setup" } } as never, 1)).toThrow(UnknownTakeKind);
  });
  it("declaredTake reads the product's own take vocabulary: rankRange, topNPerGroup × pools, bestNth.count, roundLosers.count", () => {
    const body = (take: unknown[]) => ({ kind: "knockout", name: "x", config: {}, seq: 2, progression: { sources: [{ stage: "previous", take }], placement: "rank_order", timing: "setup" } }) as never;
    expect(declaredTake(body([{ kind: "rankRange", from: 1, to: 4 }]), 1)).toBe(4);
    expect(declaredTake(body([{ kind: "topNPerGroup", n: 2 }]), 4)).toBe(8);
    expect(declaredTake(body([{ kind: "topNPerGroup", n: 2 }, { kind: "bestNth", nth: 3, count: 2 }]), 2)).toBe(6);
    expect(declaredTake(body([{ kind: "roundLosers", round: 1, count: 4 }]), 1)).toBe(4);
  });
  it("declaredTake: bestNth adds its count ONCE, never per pool — the right answer differs from a naive per-pool count (plan review 1, m-7)", () => {
    // 3 uneven pools (sizes 4, 4, 3): top 2 per group = 6, plus the best 2 of the 3 thirds = 2 → 8.
    // A naive "count per pool" reading gives 6 + 2×3 = 12; a "pools × every take" reading gives 3×(2+2) = 12.
    // Plan review 2 m-6: the expected count is derived from the ENGINE's own slot expansion, never from declaredTake and
    // never from the text test (which pins the kind SET only, not count semantics).
    const take = [{ kind: "topNPerGroup", n: 2 }, { kind: "bestNth", nth: 3, count: 2 }] as const;
    const engineSlots = expandTake(take as never, { poolKeys: ["A", "B", "C"] }).flat().length;   // @seazn/engine/competition, progression.ts:161
    expect(engineSlots).toBe(8);                                      // the rule's answer, and it differs from the naive 12
    const body = { kind: "knockout", name: "x", config: {}, seq: 2, progression: { sources: [{ stage: "previous", take }], placement: "rank_order", timing: "setup" } } as never;
    expect(declaredTake(body, 3)).toBe(engineSlots);
  });
  it("declaredTake's vocabulary matches the product's take KINDS, read as text (the kind-set oracle; count semantics come from expandTake above)", () => {
    // Reads apps/web/src/components/v2/format-templates.ts as text; asserts the set of `kind: "<x>"` inside take arrays
    // is exactly {rankRange, topNPerGroup, bestNth, roundLosers}, counted > 0 — a new template take kind reds here first.
    // The engine's TakeRule also has `picks` (packages/engine/src/competition/progression.ts:37), which no template uses,
    // so this text test cannot see it; declaredTake refuses it by name (UnknownTakeKind "picks"), asserted here:
    expect(() => declaredTake({ kind: "knockout", name: "x", config: {}, seq: 2, progression: { sources: [{ stage: "previous", take: [{ kind: "picks", picks: [] }] }], placement: "rank_order", timing: "setup" } } as never, 1)).toThrow(/take kind 'picks'/);
  });
  it("league_ko on the fake: later stage generated after Start, stage 1 completed ONCE, the proposal /complete returned confirmed ONCE, stage 2 played", async () => {
    const driver = new FakeMultiStageDriver();
    const { out } = await runOn(driver, "LIFECYCLE", { row: "league_ko" });
    const stage2 = driver.stageIdAt(2);
    const iStart = driver.calls.indexOf("start");
    const iGen2 = driver.calls.indexOf(`generate ${stage2}`);
    const iComplete1 = driver.calls.indexOf(`completeStage ${driver.stageIdAt(1)}`);
    expect(iStart).toBeGreaterThanOrEqual(0);
    expect(iGen2).toBeGreaterThan(iStart);
    expect(iGen2).toBeLessThan(iComplete1);
    expect(driver.calls.filter((c) => c === `completeStage ${driver.stageIdAt(1)}`).length).toBe(1);
    const confirms = driver.calls.filter((c) => c.startsWith(`confirmSeedProposal ${stage2}`));
    expect(confirms).toEqual([`confirmSeedProposal ${stage2} ${driver.proposalIssuedFor(2)}`]);
    const [s1, s2] = out.observed.stages;
    expect([s1!.fieldSource, s2!.fieldSource]).toEqual(["division", "seeded"]);
    expect(s2!.field).toEqual(driver.seededInto(2));
    expect(s2!.field.length).toBe(declaredTake(stagesForRow("league_ko")[1]!, 1));
  });
  it("group_group_ko drives all three stages; each later stage is its own ObservedStage", async () => {
    const { out } = await runOn(new FakeMultiStageDriver(), "LIFECYCLE", { row: "group_group_ko" });
    expect(out.observed.stages.map((s) => [s.seq, s.fieldSource])).toEqual([[1, "division"], [2, "seeded"], [3, "seeded"]]);
  });
  it("a tie on confirm: one recompute, tiePicks in the product's listed order, fact seeding_tie_picked", async () => {
    const driver = new FakeMultiStageDriver({ tieAt: 2 });
    const { out } = await runOn(driver, "LIFECYCLE", { row: "league_ko" });
    expect(driver.calls.filter((c) => c.startsWith("recomputeSeedProposal")).length).toBe(1);
    expect(driver.lastTiePicks()).toEqual(driver.tiesListed().map((t) => ({ slots: t.slots, order: t.entrantIds })));
    expect(out.observed.facts).toContain("seeding_tie_picked");
  });
  it("R4 withdraws seed 3 in stage 1; the withdrawn entrant is never seeded into stage 2", async () => {
    const driver = new FakeMultiStageDriver();
    const { out, checks } = await runOn(driver, "R4", { row: "league_ko" });
    const withdrawn = out.observed.withdrawal!.entrantId;
    expect(out.observed.stages[1]!.field).not.toContain(withdrawn);
    expect(checks.find((c) => c.id === "advance-seeded-as-declared")?.verdict).toBe("pass");
  });
  it("stage 1 not drained: stage 2 is not_reached, never confirmed, and life-loop-bounded reds", async () => {
    const driver = new FakeMultiStageDriver({ refuseGenerateOnStage1: true });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "league_ko" });
    expect(driver.calls.some((c) => c.startsWith("confirmSeedProposal"))).toBe(false);
    expect(out.observed.stages[1]!.complete).toBeNull();
    expect(checks.find((c) => c.id === "life-loop-bounded")?.verdict).toBe("fail");
  });
  it("a team sport on groups_ko plays both stages with lineups on the later stage's fixtures too", async () => {
    const football = Object.keys(sportModule("football").variants as object)[0]!;
    const driver = new FakeMultiStageDriver();
    await runOn(driver, "LIFECYCLE", { row: "groups_ko", sport: "football", variant: football });
    const later = driver.fixturesOfStage(2).filter((f) => driver.decidedFixtureIds().includes(f.id));
    expect(later.length).toBeGreaterThan(0);
    for (const f of later) expect(driver.calls.filter((c) => c.startsWith(`putLineup ${f.id} `)).length).toBe(2);
  });
  ```

  **The rule-10 sequence test** (TEST-STRATEGY rule 10), in the same file:
  ```ts
  it("fast-check: any order of organiser actions around an advance keeps the harness's advance invariants after every step", async () => {
    // Plan review 2 I-2: weighted so the generate → play → complete → confirm path is reached; `playStage1` plays
    // stage 1 to its loop exit in one step (a league of 8 needs 7 rounds, which 16 single-round steps would rarely reach).
    const cmd = fc.oneof(
      { arbitrary: fc.constantFrom("generateLater", "playStage1", "complete", "confirmLatest", "confirmStale", "recompute"), weight: 5 },
      { arbitrary: fc.nat({ max: 7 }).map((seedIdx) => ({ withdrawOne: seedIdx })), weight: 1 },   // review 1 I-5: withdrawal at any point
    );
    const tally = { confirmed: 0, withdrewBeforeConfirm: 0, withdrewAfterConfirm: 0 };
    await fc.assert(fc.asyncProperty(fc.array(cmd, { minLength: 1, maxLength: 16 }), async (steps) => {
      const d = new FakeMultiStageDriver();
      const h = await AdvanceHarness.open(d, "league_ko");
      for (const s of steps) {
        await h.step(s);                          // each step: a named RefusedCall is recorded, never thrown out
        expect(h.completesOf(1)).toBeLessThanOrEqual(1);                 // /complete never repeated
        expect(h.confirmedIds().every((id) => h.issuedIds().includes(id))).toBe(true);
        // Review 2 I-2: judged against entrants withdrawn BEFORE the confirm that seeded them. An entrant seeded and
        // withdrawn LATER stays seated in stage 2 (the product walks it over, withdrawal.ts:191-209), so the old
        // "seeded ⇒ never withdrawn" clause was false by construction.
        expect(h.seeded().every((e) => h.sourceField().includes(e) && !h.withdrawnBeforeConfirm().has(e))).toBe(true);
        expect(h.stage2HasEntrants()).toBe(h.confirmedIds().length > 0); // no seat filled without a confirm
      }
      if (h.confirmedIds().length > 0) tally.confirmed++;
      if (h.withdrawnBeforeConfirm().size > 0 && h.confirmedIds().length > 0) tally.withdrewBeforeConfirm++;
      if (h.withdrawnAfterConfirm().size > 0) tally.withdrewAfterConfirm++;
      return true;
    }), { numRuns: 200, seed: Number(process.env.MATRIX_FC_SEED ?? 20260930) });
    // Anti-vacuity (TEST-STRATEGY rule 2), each counted over the 200 runs and pasted in the task report:
    expect(tally.confirmed, "runs that reached a successful confirm").toBeGreaterThan(0);
    expect(tally.withdrewBeforeConfirm, "runs where a withdrawal preceded a successful confirm").toBeGreaterThan(0);
    expect(tally.withdrewAfterConfirm, "runs where a withdrawal followed a successful confirm").toBeGreaterThan(0);
  });
  it("a withdrawal AFTER a confirm leaves the entrant seeded in stage 2, and stage 2 walks it over (review 2 I-2)", async () => {
    const d = new FakeMultiStageDriver();
    const h = await AdvanceHarness.open(d, "league_ko");
    for (const s of ["generateLater", "playStage1", "complete", "confirmLatest"] as const) await h.step(s);
    const seededFirst = h.seeded()[0]!;
    await h.step({ withdrawOne: d.seedOf(seededFirst) - 1 });
    expect(h.seeded()).toContain(seededFirst);                              // still seated: the product does not unseat
    const itsFixture = d.fixturesOfStage(2).find((f) => f.home_entrant_id === seededFirst || f.away_entrant_id === seededFirst)!;
    expect(itsFixture.status).toBe("forfeited");                            // knockout is in BRACKET_WALKOVER_KINDS: walked over
    // Review 3 m-3: FixtureRow.outcome is `unknown` (driver/types.ts:22), and `.not.toBe` would pass on undefined.
    const opponent = itsFixture.home_entrant_id === seededFirst ? itsFixture.away_entrant_id : itsFixture.home_entrant_id;
    expect(opponent).not.toBeNull();
    expect(winnerOf(toObservedOutcome(itsFixture.outcome))).toBe(opponent);
  });
  ```
  `AdvanceHarness` is a test helper in the same file. It keeps `withdrawnBeforeConfirm()` / `withdrawnAfterConfirm()`, split at the step where the first confirm answered 200. `playStage1` calls the harness's `playStage` on stage 1 until it exits. It maps each step onto the harness's own functions (`recordGenerate`, `playStage`, `finishStage`, `confirmAdvance`) against the fake, keeping one `Recorder`. `withdrawOne(i)` calls `ctx.driver.withdraw(<entrant at seed i+1>)` and adds it to `rec.withdrawn`, exactly as R4's hook does; withdrawing an already-withdrawn entrant is a named `RefusedCall` recorded, never thrown out. The fake mirrors the product's rule that a withdrawn entrant is never seeded (it drops withdrawn entrants from its standings before taking the top `declaredTake`). A shrunk counterexample is committed as a named `it(...)` with its seed and path BEFORE any fix (rule 10).

- [ ] **Step 2: Run: expect FAIL.**
- [ ] **Step 3: Implement the driver methods** (`HttpDriver`):
  ```ts
  async confirmSeedProposal(stageId: string, body: { proposalId: string; tiePicks?: readonly { slots: readonly string[]; order: readonly string[] }[] }): Promise<SeedConfirmOut> {
    return this.#call(`/api/v1/stages/${stageId}/seed-proposal/confirm`, "POST", body);
  }
  async recomputeSeedProposal(stageId: string): Promise<SeedProposalOut> {
    const p = await this.#call<{ id: string; status: string; computed: { qualifiers: SeedProposalOut["qualifiers"]; ties: SeedProposalOut["ties"] } }>(`/api/v1/stages/${stageId}/seed-proposal`, "POST", {});
    return { id: p.id, status: p.status, qualifiers: p.computed.qualifiers, ties: p.computed.ties };
  }
  ```
  `completeStage` passes `seed_proposal` through unchanged. `FixtureRow` keeps `ext_key`/`is_final` as served. `BrowserDriver` delegates both new methods to HttpDriver and records them via `mixed.filler(...)` (ruling 47).

- [ ] **Step 3a: The stage-cap start gate** (plan review 1, m-1). In `run.ts`, beside `gatesNeeded`:
  ```ts
  /** m-1: the case orgs' plan caps stages per division. A 3-stage row on a plan
   *  capped at 2 would read the product's refusal as a ❌ — the RR-1 class, for a
   *  numeric limit instead of a feature gate. */
  export class PlanStageCapTooLow extends Error {
    readonly plan: string; readonly cap: number; readonly needed: number; readonly caseIds: readonly string[];
    constructor(plan: string, cap: number, needed: number, caseIds: readonly string[]) {
      super(`matrix: the case orgs' plan '${plan}' caps stages.per_division.max at ${cap}; ${caseIds.length} planned case(s) need ${needed} — ${caseIds.slice(0, 5).join(", ")}`);
      this.name = "PlanStageCapTooLow"; this.plan = plan; this.cap = cap; this.needed = needed; this.caseIds = caseIds;
    }
  }
  export function stagesNeeded(specs: readonly CaseSpec[], stagesOf: (row: string) => readonly unknown[] = stagesForRow): { needed: number; caseIds: string[] } { /* max stagesOf(row).length over specs; the case ids at that max */ }
  ```
  `execute` calls it right after the `PlanLacksGate` block: `const cap = await db.planLimit(plan, "stages.per_division.max")`; `null` is unlimited; `cap < needed` throws `PlanStageCapTooLow`, which joins the refused-start list at `run.ts:838`. Tests in `run-cli.test.ts`, empty case first: no specs → `needed 0`, no throw; a stub `planLimit` answering 2 with a `group_group_ko` spec → `PlanStageCapTooLow` naming the case; answering 3 or `null` → no throw. Mutant: drop the `cap < needed` comparison (always pass) → killed by the "answering 2" test.

- [ ] **Step 4: Implement `advance.ts`:**
  ```ts
  // W1-driving T6 (D1): the seed advance as the organiser does it — Complete
  // (once, which mints a draft proposal for the next stage), then Confirm
  // THAT proposal. On a tie refusal: one recompute, then the product's own
  // listed order, recorded (tie semantics are W4/W5's rulebook, not ours).
  import { RefusedCall, type SeedProposalRef, type StageRef } from "../driver/types.ts";
  import type { StagePostBody } from "../catalogue.ts";
  import type { CheckResult } from "../results.ts";
  import { assertion } from "./assertions.ts";
  import type { Recorder, StagePlay } from "./common.ts";
  import type { ScenarioContext } from "./types.ts";

  /** Pinned at Task 6 Step 0 from usecases/stages.ts confirmSeedProposal. */
  export const SEEDING_TIE_CODE = "SEEDING_TIE_UNRESOLVED";

  export class UnknownTakeKind extends Error {
    constructor(kind: string) { super(`advance: take kind '${kind}' is not in the harness's vocabulary (rankRange, topNPerGroup, bestNth, roundLosers — format-templates.ts)`); this.name = "UnknownTakeKind"; }
  }

  /** How many entrants the body's progression declares it takes. */
  export function declaredTake(body: StagePostBody, sourcePools: number): number {
    const sources = body.progression?.sources ?? [];
    let n = 0;
    for (const s of sources) for (const t of s.take as readonly Record<string, unknown>[]) {
      switch (t.kind) {
        case "rankRange": n += Number(t.to) - Number(t.from) + 1; break;
        case "topNPerGroup": n += Number(t.n) * sourcePools; break;
        case "bestNth": n += Number(t.count); break;
        case "roundLosers": n += Number(t.count); break;
        default: throw new UnknownTakeKind(String(t.kind));
      }
    }
    return n;
  }

  export interface AdvanceObs { readonly status: number; readonly code: string | null; readonly proposalId: string | null; readonly filled: number; readonly seeded: readonly string[]; readonly declared: number; readonly tiePicked: boolean }

  export async function confirmAdvance(ctx: ScenarioContext, rec: Recorder, target: StageRef, proposal: SeedProposalRef, declared: number): Promise<AdvanceObs> {
    const seatedOf = (fx: readonly { stage_id: string; home_entrant_id: string | null; away_entrant_id: string | null }[]) =>
      [...new Set(fx.filter((f) => f.stage_id === target.id).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((e): e is string => e !== null))];
    try {
      const c = await ctx.driver.confirmSeedProposal(target.id, { proposalId: proposal.id });
      return { status: 200, code: null, proposalId: c.proposalId, filled: c.filled, seeded: seatedOf(c.fixtures), declared, tiePicked: false };
    } catch (e) {
      if (!(e instanceof RefusedCall)) throw e;
      if (e.code !== SEEDING_TIE_CODE) {
        rec.notes.push(`confirm on stage ${target.seq} refused ${e.status} ${e.code ?? "(no code)"}`);
        return { status: e.status, code: e.code, proposalId: proposal.id, filled: 0, seeded: [], declared, tiePicked: false };
      }
    }
    const fresh = await ctx.driver.recomputeSeedProposal(target.id);
    const tiePicks = fresh.ties.map((t) => ({ slots: t.slots, order: t.entrantIds }));
    rec.facts.add("seeding_tie_picked");
    rec.notes.push(`stage ${target.seq}: ${tiePicks.length} seeding tie(s) picked in the product's listed order`);
    try {
      const c = await ctx.driver.confirmSeedProposal(target.id, { proposalId: fresh.id, tiePicks });
      return { status: 200, code: null, proposalId: c.proposalId, filled: c.filled, seeded: seatedOf(c.fixtures), declared, tiePicked: true };
    } catch (e) {
      if (!(e instanceof RefusedCall)) throw e;
      return { status: e.status, code: e.code, proposalId: fresh.id, filled: 0, seeded: [], declared, tiePicked: true };
    }
  }

  /** Each later stage: seeded count = the declared take; seeded entrants are
   *  distinct, from the source stage's field, and never withdrawn. A stage the
   *  run never reached is not counted (life-loop-bounded owns it); none
   *  counted is an abstain with its reason, never a pass. */
  export function advanceSeededAsDeclared(plays: readonly StagePlay[], withdrawn: ReadonlySet<string>): CheckResult {
    const items = plays.flatMap((p, i) => {
      if (i === 0 || p.advance === null || p.advance.status !== 200) return [];
      const source = new Set(plays[i - 1]!.field ?? []);
      const a = p.advance;
      return [
        { ok: a.seeded.length === a.declared, note: `stage ${p.stage.seq}: seeded ${a.seeded.length}, declared ${a.declared}` },
        { ok: a.seeded.every((e) => source.has(e)), note: `stage ${p.stage.seq}: every seeded entrant comes from stage ${plays[i - 1]!.stage.seq}'s field` },
        { ok: a.seeded.every((e) => !withdrawn.has(e)), note: `stage ${p.stage.seq}: no withdrawn entrant seeded` },
      ];
    });
    return assertion("advance-seeded-as-declared", items, items.length === 0 ? "no later stage was confirmed" : null);
  }
  ```
  `declared` is computed by the caller from `declaredTake`. `sourcePools` is the source stage's observed pool count: the distinct non-null `pool_id`s of its fixtures, or 1.

- [ ] **Step 5: Implement `playDivision` and the per-stage snapshot** (`common.ts`):
  ```ts
  export class StageTrack {
    exit: LoopExit | null = null;
    readonly generates: GenerateObs[] = [];
    readonly pairRounds: PairRoundObs[] = [];
  }
  // Recorder gains:  readonly tracks = new Map<string, StageTrack>();  track(id) creates on first use.
  // recordGenerate(ctx, rec, stageId) pushes to rec.generates (run-wide, unchanged) AND rec.track(stageId).generates.
  // playStage(ctx, rec, setup, hooks, stage = setup.stage) sets rec.track(stage.id).exit and rec.exit alike.

  export interface StagePlay { readonly stage: StageRef; readonly field: readonly string[] | null; readonly advance: AdvanceObs | null; readonly complete: CompleteObs | null }

  export async function playDivision(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, hooks: { beforeRound?: RoundHook; afterRound?: RoundHook; beforeComplete?: (stage: StageRef) => Promise<void> } = {}): Promise<StagePlay[]> {
    // Every later "setup" stage gets its TBD rows NOW: after its source
    // completes, the generate is refused 409 (stages.ts:4176+, Task 6 Step 0).
    for (const s of setup.stages.slice(1)) await recordGenerate(ctx, rec, s.id);
    const plays: StagePlay[] = [];
    for (const [i, stage] of setup.stages.entries()) {
      let advance: AdvanceObs | null = null;
      let field: readonly string[] | null = i === 0 ? setup.entrants.map((e) => e.id) : null;
      if (i > 0) {
        const prev = plays[i - 1]!;
        const proposal = prev.complete?.seedProposal ?? null;
        if (prev.complete?.completed !== true || proposal === null) {
          rec.track(stage.id).exit = "not_reached";
          rec.notes.push(`stage ${stage.seq}: not reached (stage ${prev.stage.seq} ${prev.complete === null ? "never completed" : `completed=${prev.complete.completed}, proposal ${proposal === null ? "none" : proposal.id}`})`);
          plays.push({ stage, field: [], advance: null, complete: null });
          continue;
        }
        const body = setup.built.posted.stages[i]!;
        const pools = new Set((await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === prev.stage.id && f.pool_id !== null).map((f) => f.pool_id)).size || 1;
        advance = await confirmAdvance(ctx, rec, stage, proposal, declaredTake(body, pools));
        field = advance.seeded;
        if (advance.status !== 200) { rec.track(stage.id).exit = "not_reached"; plays.push({ stage, field, advance, complete: null }); continue; }
      }
      await playStage(ctx, rec, setup, i === 0 ? hooks : {}, stage);     // D12: hooks on stage 1 only
      if (rec.track(stage.id).exit !== "drained") { plays.push({ stage, field, advance, complete: null }); continue; }
      if (i === 0) await hooks.beforeComplete?.(stage);
      const complete = await finishStage(ctx, rec, stage.id);
      plays.push({ stage, field, advance, complete });
    }
    rec.exit = worstExit(setup.stages.map((s) => rec.track(s.id).exit));
    return plays;
  }
  /** The run's exit is "drained" only if every stage drained; otherwise the first stage that did not. */
  const worstExit = (exits: readonly (LoopExit | null)[]): LoopExit | null => exits.find((e) => e !== "drained") ?? "drained";
  ```
  Notes on the loop:
  - After an unreached stage, the loop keeps going only to record the later stages as `not_reached`. The `continue` in the unreached branch does that, because every later `prev.complete` is null.
  - `finishStage(ctx, rec, stageId)` returns `CompleteObs` with `seedProposal: c.seed_proposal ?? null`.
  - `snapshot(ctx, rec, setup, plays, extra)` emits one `ObservedStage` per play, in the following shape:
    - `fixtures` are that stage's rows (`toFixture` now carries `extKey: f.ext_key ?? null`, `isFinal: f.is_final === true`);
    - `standings` per pool for that stage;
    - `generates` and `pairRounds` come from `rec.track(stage.id)`;
    - `complete: play.complete`;
    - `field: play.field ?? []`;
    - `fieldSource: i === 0 ? "division" : "seeded"`.
  - `decideFixture(ctx, rec, setup, f, outcome, stage = setup.stage)` uses `stage.kind` for `generateStream`, `matchesRequest` and `stageCtx`.
  - The scenarios call `playDivision`:
    - LIFECYCLE passes `beforeComplete: async () => { configEdit = await configProbe(ctx, rec, setup); }`, so the lock probe keeps its place before stage 1 completes;
    - M1 passes `beforeRound`, and R4 passes `afterRound`.
  - Every scenario adds `advanceSeededAsDeclared(plays, rec.withdrawn)` to its assertions.
  - The `:110` deferral and the old multi-stage deferral test are deleted.

- [ ] **Step 6: Run: expect PASS.** Files: `multi-stage.test.ts`, `scenarios.test.ts`, `http-driver.test.ts`, `browser-driver.test.ts`, `invariants.test.ts`, `pad-proof.test.ts`, `layers.test.ts`, `strip-types-loadable.test.ts`. Paste the fast-check seed line.
- [ ] **Step 7: Mutation** (each alone):
  - move the later-stage generates AFTER stage 1's play → killed by "later stage generated after Start" (`iGen2 < iComplete1`);
  - confirm with a fresh `recomputeSeedProposal` id instead of the one `/complete` returned → killed by the `confirms` equality;
  - call `finishStage` twice on stage 1 → killed by the fake's `DriverMisuse` and the fast-check "completes ≤ 1";
  - `fieldSource: "division"` on later stages → killed by the `fieldSource` pair assertion;
  - `declaredTake` `topNPerGroup` ignores pools → killed by the take-vocabulary test (`8`);
  - `advanceSeededAsDeclared` drops the withdrawn item → killed by the R4 test (the fake seeds the withdrawn entrant when the mutant is on; add the fake option `seedWithdrawn: true` for that test);
  - remove `withdrawOne` from the fast-check `cmd` → killed by the `withdrewBeforeConfirm` / `withdrewAfterConfirm` counts (plan review 1 I-5);
  - drop the command weights (equal odds) → run once with the seed; if `tally.confirmed` stays > 0 the mutant is equivalent at this seed, note it; the count assertion is the guard (plan review 2 I-2);
  - the fake unseats an entrant withdrawn after a confirm (cleaner than the product) → killed by the "withdrawal AFTER a confirm" example;
  - `declaredTake` `bestNth` multiplied by pools → killed by the uneven-pools test (`8` from the engine's `expandTake`, not `12`; review 1 m-7, review 2 m-6).
- [ ] **Step 8: tsc + eslint; commit** `feat(matrix): multi-stage driving — seed-proposal confirm, per-stage observation (W1-driving T6, D1, D12)`.

- [ ] **Step 9: Live smoke, one cell per shape** (a fresh env per the skill). Run each with `EXIT=$?` written:
  - `league_ko|badminton` LIFECYCLE;
  - `group_group_ko|generic` LIFECYCLE;
  - `ko_plate|generic` F1.

  The last is predicted a product red: 7 entrants give 3 round-1 losers, fewer than the plate's `count 4`. The expected shape (plan review 1, m-6): `loserAt` throws `QUALIFICATION_INVALID` (`packages/engine/src/competition/progression.ts:577-596`), which surfaces as `409 STAGE_COMPLETED_SEEDING_FAILED` AFTER stage 1 has committed complete (`usecases/stages.ts:4140-4250`). So the harness sees `CompleteObs.completed = false` (a refused `/complete`) while the product shows stage 1 completed. Triage routes it to **W4**; the harness must never retry `/complete` (the driver's `DriverMisuse` guard refuses a repeat). If so, record it; do not fix it.

  These run in **Task 12 Step 7**, the first point where `--only` admits a non-slice cell. This step only records that the three cells are owed there, so the capability's first live contact is not forgotten.

---

## Task 7: Ladder driving through challenges

**Why:** A ladder's generate creates nothing (`stages.ts:~2397`); its fixtures come from `POST /stages/{id}/challenges`. The old loop would read `drained` over nothing (Review Focus 3). That affects 33 cells across the family, 11 of them ladder.

**Files:**
- Create: `scripts/matrix/lib/scenarios/ladder-loop.ts`, `scripts/matrix/__tests__/ladder-loop.test.ts`
- Modify: `driver/types.ts` (`challenge`), `http-driver.ts`, `browser-driver.ts` (filler), `common.ts` (`FORMAT_LATER` loses `ladder`; `playStage` dispatches `kind === "ladder"` to `playLadder`), `fake-formats-driver.ts` (`FakeLadderDriver`), `lib/scenarios/r4-withdrawal.ts` (D14, ruling 53: the per-kind trigger, the derived ladder policy, the kind-aware `cascadeItems` (false premise 16), `r4-not-challenged-later` with its raw/live items, the W7 finalRanks note).
- Test: `ladder-loop.test.ts`, `scenarios.test.ts` (the ladder part of `:1012` re-pinned), the R4 block of `scenarios.test.ts` (there is no `r4-withdrawal.test.ts`; plan review 2 m-8).

**Interfaces:**
- Produces:
  ```ts
  export interface ChallengeOut { readonly fixture_id: string; readonly ladder_order: readonly string[] }
  challenge(stageId: string, challengerId: string, opponentId: string): Promise<ChallengeOut>;  // POST /api/v1/stages/{id}/challenges
  export async function playLadder(ctx, rec, setup, stage: StageRef, hooks): Promise<void>;
  export function ladderSchedule(n: number): readonly { step: number; challengerIdx: number; opponentIdx: number; challengerWins: boolean }[];
  ```

- [ ] **Step 0: Pin the product.** In `stages.ts`, find:
  - when a ladder stage completes (expected: ≥1 fixture and none open);
  - where `ladder_order` is updated on a decided challenge (the swap);
  - whether an entrant may hold two open challenges;
  - whether `formats.advanced` is on the case org's plan (`seed-org.ts` `chooseTopPublicPlan`);
  - (D14, ruling 51) the M1 and R4 meanings on a ladder, each with file:line: the open-format withdrawal branch (`withdrawal.ts:213-217` at plan time: void pending, walkover policy only when something was pending), the raw-vs-live `ladder_order` rule (`usecases/stages.ts:5562-5572` never prunes; `:5601-5625` reach counted on live rungs), and `LADDER_ENTRANT_WITHDRAWN` for a challenge naming a departed entrant (`:5539-5590`).

  Record each with file:line. Capture the `league|generic` R4 canary's `{verdict, checks}` on `FakeLeagueDriver` with TODAY's code into `__tests__/fixtures/r4-canary-before.json`. The canary test compares the verdict and the `r4-policy-reported` / `r4-cascade-consistent` entries against it, and the fixture is never regenerated in this task (review 3 m-2). **Before any implementation**, run the D14 ladder tests below against TODAY's `r4-withdrawal.ts` and paste the red (`r4-policy-reported`: "policy none on a started division", or the hook firing at step 1 before seed 3 has played). A D14 test that is green today is not testing the new meaning.

- [ ] **Step 1: Failing tests.** Transitions: empty ladder; the first challenge; the last; a withdrawn entrant in the middle (R4, D14 timing); a walkover challenge (M1, which lands on the last challenge, D8); a withdrawal at any step (the rule-10 `withdrawOne`, plan review 1 I-5); a second sport.
  ```ts
  it("empty case first: a field of 0 or 1 plans no challenge, and playing it reds (never drained)", async () => {
    expect(ladderSchedule(0)).toEqual([]);
    expect(ladderSchedule(1)).toEqual([]);
  });
  it("n entrants → n−1 adjacent upward challenges, bottom-up, the challenger winning on odd steps", () => {
    const s = ladderSchedule(8);
    expect(s.length).toBe(7);
    for (const c of s) { expect(c.opponentIdx).toBe(c.challengerIdx - 1); expect(c.challengerWins).toBe(c.step % 2 === 1); }
    expect(s.map((c) => c.challengerIdx)).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });
  it("ladder|generic LIFECYCLE on the fake: every challenge legal, the final order is the adjacent-swap rule applied to seed order", async () => {
    const driver = new FakeLadderDriver({ challengeRange: 3 });
    const { out, state } = await runOn(driver, "LIFECYCLE", { row: "ladder" });
    const seeds = driver.entrantsBySeed();
    // Expected order from the RULE (a challenger who wins takes the place above; loses: no change), not from playLadder.
    const expected = [...seeds];
    for (let k = 1; k < seeds.length; k++) {
      const i = seeds.length - k;
      if (k % 2 === 1) [expected[i - 1], expected[i]] = [expected[i]!, expected[i - 1]!];
    }
    expect(driver.ladderOrder()).toEqual(expected);
    expect(out.observed.stages[0]!.complete?.finalRanks).toEqual(expected);
    expect(driver.refusedChallenges()).toEqual([]);
    expect(state).toBe("works");
  });
  it("no challenge played is red, never drained: a fake that refuses every challenge leaves exit refused_challenge and I9 fails on checked 0", async () => {
    const { checks } = await runOn(new FakeLadderDriver({ refuseAll: "LADDER_CHALLENGE_OUT_OF_RANGE" }), "LIFECYCLE", { row: "ladder" });
    expect(checks.find((c) => c.id === "life-loop-bounded")?.verdict).toBe("fail");
  });
  it("R4 (D14, ruling 51): seed 3 is withdrawn after ITS first challenge, not after step 1 — reds on today's hook", async () => {
    const driver = new FakeLadderDriver({ challengeRange: 3 });
    const { out, checks } = await runOn(driver, "R4", { row: "ladder" });
    const seed3 = driver.entrantsBySeed()[2]!;
    // The step is derived from the ledger, never typed: the first decided challenge that seats seed 3.
    const ledger = driver.decidedChallenges();                       // [{step, challenger, opponent, winner}] in issue order
    const first = ledger.findIndex((c) => c.challenger === seed3 || c.opponent === seed3);
    expect(first, "seed 3 played at least one challenge").toBeGreaterThanOrEqual(0);
    expect(driver.withdrawnAfterStep()).toBe(ledger[first]!.step);
    expect(ledger.slice(first + 1).some((c) => c.challenger === seed3 || c.opponent === seed3), "seed 3 challenged after withdrawal").toBe(false);
    expect(driver.refusedChallenges()).toEqual([]);
    expect(checks.find((c) => c.id === "r4-not-challenged-later")?.verdict).toBe("pass");
    expect(out.observed.withdrawal!.afterRound).toBe(ledger[first]!.step);
  });
  it("the product's pending set, read as text: WITHDRAWAL_PENDING_STATUSES is {scheduled, in_play} (plan review 2 m-3)", () => {
    // Reads apps/web/src/lib/table-withdrawal.ts as text, extracts the Set literal of WITHDRAWAL_PENDING_STATUSES,
    // and exports it to the tests as PENDING. Also reads TABLE_KINDS (withdrawal.ts:37, the withdrawal module's own copy,
    // which excludes americano, unlike engine-db/competition.ts:39) and BRACKET_WALKOVER_KINDS (stages.ts:880-884) the same
    // way, as TABLE_KINDS_PINNED and BRACKET_KINDS_PINNED. Each set is asserted non-empty; a product change moves them.
    expect([...PENDING].sort()).toEqual(["in_play", "scheduled"]);
    // Review 3 m-6: ONE runtime authority. The harness already hand-copies PENDING_STATUSES (lib/observed.ts:145); it must
    // equal the product's set, and cascadeItems / expectedPolicy read PENDING_STATUSES, never a second list.
    expect([...PENDING_STATUSES].sort()).toEqual([...PENDING].sort());
    // The runtime kind lookup (FORFEIT_MODEL_KINDS, WALKOVER_MODEL's forfeit set) must equal the pinned union, so the harness cannot drift either.
    expect([...FORFEIT_MODEL_KINDS].sort()).toEqual([...TABLE_KINDS_PINNED, ...BRACKET_KINDS_PINNED].sort());
  });
  it("R4 on a ladder (ruling 53): policy derived from the product's pending set — none here — and the canary's opposite reds", async () => {
    const driver = new FakeLadderDriver({ challengeRange: 3 });
    const { out, checks } = await runOn(driver, "R4", { row: "ladder" });
    const w = out.observed.withdrawal!;
    // The oracle is the product's open-format rule (withdrawal.ts:213-217) over the text-pinned PENDING set, not r4-withdrawal.ts.
    const expected = w.before.some((f) => PENDING.has(f.status)) ? "walkover" : "none";
    expect(expected).toBe("none");                                   // D8 decides each challenge before the next is issued
    expect([w.policy, w.walkovers, w.voided, w.skippedFinalized]).toEqual([expected, 0, 0, 0]);
    expect(checks.find((c) => c.id === "r4-policy-reported")?.verdict).toBe("pass");
    expect(checks.find((c) => c.id === "r4-cascade-consistent")?.verdict).toBe("pass");   // seed 3's decided challenge unchanged
    const canary = await runOn(new FakeLadderDriver({ challengeRange: 3 }), "R4", { row: "ladder", canary: true });
    expect(canary.checks.find((c) => c.id === "r4-policy-reported")?.verdict).toBe("fail");
  });
  it("R4 on a ladder (ruling 53): seed 3 is gone from the LIVE order, still in the RAW ladder_order at its held index; the finalRanks rung is a W7 note, not a check", async () => {
    const driver = new FakeLadderDriver({ challengeRange: 3 });
    const { out, checks } = await runOn(driver, "R4", { row: "ladder" });
    const seed3 = driver.entrantsBySeed()[2]!;
    const heldAt = driver.rawOrderAtWithdrawal().indexOf(seed3);      // the fake's raw order the moment withdraw() answered
    expect(heldAt).toBeGreaterThanOrEqual(0);
    expect(driver.ladderOrder().indexOf(seed3)).toBe(heldAt);         // raw: never pruned (stages.ts:5562-5572)
    expect(driver.ladderOrder().filter((e) => !driver.withdrawnIds().has(e))).not.toContain(seed3);
    expect(checks.find((c) => c.id === "r4-not-challenged-later")?.verdict).toBe("pass");
    // W7: the product snapshots the RAW order into finalRanks (engine-db/competition.ts:606), so seed 3 keeps its rung.
    expect(out.notes.some((n) => n.includes(`ladder finalRanks keep withdrawn ${seed3} at rung ${heldAt}`) && /W7/.test(n))).toBe(true);
    expect(checks.some((c) => /finalRanks/.test(c.id))).toBe(false);  // recorded, never asserted either way
  });
  it("R4 on a ladder with a PENDING challenge at withdrawal (fake option withdrawWhilePending): walkover by abandon, never by forfeit", async () => {
    // withdrawWhilePending: the fake issues seed 3's first challenge and the hook withdraws BEFORE it is decided.
    // The differing case: the right answer ("walkover") differs from the D8 default ("none"), so a hard-coded "none" is killed.
    const driver = new FakeLadderDriver({ challengeRange: 3, withdrawWhilePending: true });
    const { out, checks } = await runOn(driver, "R4", { row: "ladder" });
    const w = out.observed.withdrawal!;
    expect(w.before.filter((f) => PENDING.has(f.status)).length).toBe(1);
    expect([w.policy, w.walkovers, w.voided]).toEqual(["walkover", 0, 1]);          // open-format branch: abandon + voided, no forfeit
    const pending = out.observed.stages[0]!.fixtures.find((f) => f.id === w.before.find((b) => PENDING.has(b.status))!.id)!;
    expect(pending.status).toBe("abandoned");
    expect(checks.find((c) => c.id === "r4-policy-reported")?.verdict).toBe("pass");
    expect(checks.find((c) => c.id === "r4-cascade-consistent")?.verdict).toBe("pass");  // kind-aware (false premise 16)
  });
  it("cascadeItems is kind-aware (false premise 16): open-format walkover = every pending abandoned and counted voided; table/bracket unchanged", () => {
    // Plan review 3 I-3: product-shaped, typed fixtures, no `as never`. winnerOf reads only outcome.kind ∈ {win, award}
    // (observed.ts:124-126), and sameResult reads `before[].outcome` (observed.ts:130-137), so both must be real.
    const fx = (id: string, status: string, outcome: ObservedOutcome | null, home: string, away: string): ObservedFixture =>
      ({ id, stageId: "s1", poolId: null, roundNo: 1, home, away, status, outcome, declared: null });
    const decidedW = { kind: "win", winner: "w" } as const satisfies ObservedOutcome;         // f2, identical before and after
    const before: FixtureSnap[] = [fx("f1", "scheduled", null, "w", "x"), fx("f2", "decided", decidedW, "w", "y")].map(snap);
    const abandonedAfter: ObservedFixture[] = [fx("f1", "abandoned", null, "w", "x"), fx("f2", "decided", decidedW, "w", "y")];
    const forfeitedAfter: ObservedFixture[] = [fx("f1", "forfeited", { kind: "award", winner: "x" }, "w", "x"), fx("f2", "decided", decidedW, "w", "y")];
    const failing = (items: { ok: boolean; note: string }[]) => items.filter((i) => !i.ok).map((i) => i.note);
    // Kinds are read from the product's text-pinned sets (withdrawal.ts:37 TABLE_KINDS, stages.ts:880-884
    // BRACKET_WALKOVER_KINDS), plus the open-format kinds the catalogue uses; each list asserted non-empty.
    const openKinds = ["ladder", "page_playoff", "americano"].filter((k) => !TABLE_KINDS_PINNED.has(k) && !BRACKET_KINDS_PINNED.has(k));
    const forfeitKinds = [...TABLE_KINDS_PINNED, ...BRACKET_KINDS_PINNED];
    expect([openKinds.length, forfeitKinds.length]).toEqual([3, 6]);
    for (const kind of openKinds) {
      // POSITIVE: the abandon shape passes. Reds when kind-awareness is removed (forfeit model: f1 abandoned with x seated → item fails).
      expect(failing(cascadeItems("walkover", "w", before, abandonedAfter, 0, 1, kind)), kind).toEqual([]);
      // NEGATIVE: a forfeit to x is not the open-format shape. Reds when kind is ignored (the forfeit model accepts it).
      expect(failing(cascadeItems("walkover", "w", before, forfeitedAfter, 1, 0, kind)).length, `${kind}: forfeit rejected`).toBeGreaterThan(0);
    }
    for (const kind of forfeitKinds) {
      // POSITIVE: the forfeit-to-opponent shape passes (award to x, walkovers 1). Reds when the abandon model is applied to every kind.
      expect(failing(cascadeItems("walkover", "w", before, forfeitedAfter, 1, 0, kind)), kind).toEqual([]);
      // NEGATIVE: an abandon with a seated opponent is not the table/bracket shape. Reds when the abandon model is applied to every kind.
      expect(failing(cascadeItems("walkover", "w", before, abandonedAfter, 0, 1, kind)).length, `${kind}: abandon rejected`).toBeGreaterThan(0);
    }
  });
  it("the league|generic R4 canary: its verdict and its r4-policy-reported / r4-cascade-consistent entries are byte-identical before and after the kind-aware cascade; the NEW ladder-only check abstains on league", async () => {
    // Review 3 m-2: the WHOLE checks JSON cannot be byte-identical, because Task 7 adds r4-not-challenged-later, which is
    // emitted on every kind (abstain off the ladder), as r4-not-paired-later already is (r4-withdrawal.ts:115-117). So the
    // test compares exactly what should not move, and asserts the new entry separately. Re-snapshotting after the change is
    // forbidden: the fixture is captured at Step 0 from TODAY's code and never regenerated in this task.
    const before = JSON.parse(readFileSync(R4_CANARY_BEFORE, "utf8")) as { verdict: string; checks: CheckResult[] };   // __tests__/fixtures/r4-canary-before.json
    const now = await runCanary(planCanaryCase(variantFor, "R4"), new FakeLeagueDriver());
    expect(now.verdict).toBe(before.verdict);
    for (const id of ["r4-policy-reported", "r4-cascade-consistent"]) {
      expect(JSON.stringify(now.checks.find((c) => c.id === id)), id).toBe(JSON.stringify(before.checks.find((c) => c.id === id)));
    }
    expect(before.checks.some((c) => c.id === "r4-not-challenged-later")).toBe(false);          // proves the snapshot predates the change
    const added = now.checks.find((c) => c.id === "r4-not-challenged-later")!;
    expect([added.verdict, added.checked]).toEqual(["abstain", 0]);
    expect(added.reason).toMatch(/ladder only/);
  });
  it("M1 on a ladder lands on the last challenge (D8, m-4): forfeited to seed 1, m1-winner-progresses abstains", async () => {
    const driver = new FakeLadderDriver({ challengeRange: 3 });
    const { checks } = await runOn(driver, "M1", { row: "ladder" });
    const ledger = driver.decidedChallenges();
    expect(ledger.at(-1)!.opponent).toBe(driver.entrantsBySeed()[0]);
    expect(checks.find((c) => c.id === "m1-walkover-recorded")?.verdict).toBe("pass");
    expect(checks.find((c) => c.id === "m1-winner-progresses")?.verdict).toBe("abstain");
  });
  it("fast-check (rule 10): playLadder under ANY withdrawal set and timing issues zero refused challenges, and the final LIVE order is the adjacent-swap rule replayed over the product's own ledger", async () => {
    // Drives the HARNESS (playLadder + ladderSchedule), never the fake's own challenge logic (plan review 1 I-5).
    // Withdrawals are injected through playLadder's afterRound hook at generated steps, exactly as R4's hook would.
    // Normalisation (plan review 2 m-5), done by LadderHarness BEFORE play and counted, never an unplanned red:
    //   - seedIdx is taken modulo n, so it always names an existing entrant;
    //   - a repeat of an entrant already in the list is dropped (first occurrence wins) — the product would refuse a
    //     second withdrawal, and that refusal is Task 6's sequence, not this property's;
    //   - a withdrawal whose afterStep never runs (the sweep ended first) is not applied, and h.skippedWithdrawals() counts it.
    const arb = fc.record({
      n: fc.integer({ min: 2, max: 10 }),
      withdrawals: fc.array(fc.record({ afterStep: fc.nat({ max: 9 }), seedIdx: fc.nat({ max: 9 }) }), { maxLength: 4 }),
    });
    let withdrewMidSweep = 0;
    await fc.assert(fc.asyncProperty(arb, async ({ n, withdrawals }) => {
      const d = new FakeLadderDriver({ challengeRange: 1 });         // the tightest legal range: any non-adjacent challenge refuses
      const h = await LadderHarness.open(d, n, withdrawals);         // setUpDivision on the fake, then playLadder with the hook
      await h.play();
      expect(d.refusedChallenges(), "playLadder issued a refused challenge").toEqual([]);
      // Oracle: replay the product's decided-challenge ledger over the seed order with the swap rule, then drop the departed.
      // ladder_order is RAW in the product (stages.ts:5562-5572 never prunes); the property compares the LIVE projection.
      const raw = [...d.entrantsBySeed()];
      for (const c of d.decidedChallenges()) if (c.winner === c.challenger) {
        const i = raw.indexOf(c.challenger), j = raw.indexOf(c.opponent);
        [raw[i], raw[j]] = [raw[j]!, raw[i]!];
      }
      const live = (xs: readonly string[]) => xs.filter((e) => !d.withdrawnIds().has(e));
      expect(live(d.ladderOrder())).toEqual(live(raw));
      // Every decided challenge was live-adjacent, upward, and seated no departed entrant at the time it was issued.
      for (const c of d.decidedChallenges()) expect(c.liveAdjacentAtIssue && c.upward && !c.seatedDeparted, `step ${c.step}`).toBe(true);
      if (d.withdrawnIds().size > 0 && d.decidedChallenges().some((c) => c.step > d.firstWithdrawalStep())) withdrewMidSweep++;
      return true;
    }), { numRuns: 200, seed: Number(process.env.MATRIX_FC_SEED ?? 20260930) });
    expect(withdrewMidSweep, "runs where a challenge followed a withdrawal (anti-vacuity)").toBeGreaterThan(0);
  });
  ```
  `FakeLadderDriver` enforces the four ladder refusals with the product's codes from Step 0, swaps on a challenger win, writes `ladder_order` by seed on the first challenge and **never prunes it** (the product's raw order), counts reach on LIVE rungs (the product's F7 rule), refuses a departed entrant with `LADDER_ENTRANT_WITHDRAWN`, answers `withdraw` with the open-format rule (every pending fixture ABANDONED and counted in `voided`, walkovers 0; policy `walkover` only if something was pending, else `none`; false premise 16), keeps `rawOrderAtWithdrawal()`, and completes when ≥1 fixture exists and none is open. `finalRanks` = `ladder_order`. Its ledger (`decidedChallenges()`) records, for each challenge, whether it was live-adjacent and upward at issue time; those flags are computed from the fake's live order at issue, which is the product's rule, not `playLadder`'s. `LadderHarness` is a thin test helper that calls `setUpDivision` + `playLadder` with an `afterRound` hook that withdraws per the generated list; it has no challenge logic of its own.

  `r4-withdrawal.ts` changes (D14, ruling 53):
  - the trigger becomes a per-kind strategy (`R4_TRIGGER: Record<"default" | "ladder", (round, batch, seed3) => boolean>`);
  - `r4-policy-reported` on `ladder` asserts `policy === expectedPolicy(before)` over the text-pinned `PENDING` (with the canary judging the opposite);
  - `cascadeItems` gains a `kind` argument and picks its walkover model from `WALKOVER_MODEL: Record<"forfeit" | "abandon", …>` by membership in `FORFEIT_MODEL_KINDS` (false premise 16). That constant is held equal to the product's `TABLE_KINDS ∪ BRACKET_WALKOVER_KINDS` by the pending-set text-pin test, and pending is read from `PENDING_STATUSES` only (plan review 3 m-6). Every existing caller passes the stage kind, so `league` keeps today's model byte-for-byte;
  - on `ladder` the case pushes the W7 note "ladder finalRanks keep withdrawn <id> at rung <i> (raw ladder_order) — W7 rulebook question" and asserts nothing about it;
  - the new `r4-not-challenged-later` check (items: seed 3 absent from the live order; seed 3 present in the raw `ladder_order` at its held index; one item per later challenge, none seating seed 3) (ladder only; abstains elsewhere) reads the challenge fixtures `playLadder` issued AFTER the withdrawal step (`playLadder` records `rec.ladderSteps: {step, fixtureId}[]`; a challenge fixture's product `round_no` is not relied on). Zero challenges after the withdrawal is an abstain with its reason ("no challenge followed the withdrawal"), never a pass (TEST-STRATEGY rule 2); under D8 with 8 entrants one challenge follows (step 6).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** `ladder-loop.ts`:
  ```ts
  // D8: one bottom-up sweep of adjacent upward challenges. Adjacent means every
  // challenge is legal under any challengeRange ≥ 1, and swap vs leapfrog give
  // the same order — so the expected order needs no ladder rulebook (W7's).
  export function ladderSchedule(n: number) {
    return Array.from({ length: Math.max(0, n - 1) }, (_, j) => {
      const step = j + 1;
      return { step, challengerIdx: n - step, opponentIdx: n - step - 1, challengerWins: step % 2 === 1 };
    });
  }

  export async function playLadder(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, hooks: { beforeRound?: RoundHook; afterRound?: RoundHook }): Promise<void> {
    const track = rec.track(stage.id);
    const plan = ladderSchedule(setup.entrants.length);            // bound = field size − 1, derived
    if (plan.length === 0) { track.exit = rec.exit = "refused_challenge"; rec.notes.push("ladder: a field of < 2 has no challenge"); return; }
    let order: readonly string[] = setup.entrants.map((e) => e.id); // until the first challenge answers the live order
    for (const c of plan) {
      const live = order.filter((e) => !rec.withdrawn.has(e));
      const idx = live.length - c.step;                             // the same walk, over the live active order
      if (idx < 1) break;                                           // a withdrawal shortened the ladder
      const challenger = live[idx]!, opponent = live[idx - 1]!;
      let out: ChallengeOut;
      try { out = await ctx.driver.challenge(stage.id, challenger, opponent); }
      catch (e) {
        if (!(e instanceof RefusedCall)) throw e;
        rec.notes.push(`ladder step ${c.step}: challenge refused ${e.status} ${e.code ?? "(no code)"}`);
        track.exit = rec.exit = "refused_challenge";
        return;
      }
      const f = (await ctx.driver.listFixtures(setup.division.id)).find((x) => x.id === out.fixture_id);
      if (f === undefined) throw new Error(`ladder: challenge answered fixture ${out.fixture_id}, which the division list does not hold`);
      await hooks.beforeRound?.(c.step, [f]);
      const home = f.home_entrant_id === challenger;
      await decideFixture(ctx, rec, setup, f, { kind: "win", winner: c.challengerWins === home ? "home" : "away" }, stage);
      await hooks.afterRound?.(c.step, [f]);
      order = (await ctx.driver.listStages(setup.division.id)).find((s) => s.id === stage.id)?.config.ladder_order as string[] ?? out.ladder_order;
    }
    track.exit = rec.exit = "drained";
  }
  ```
  `LoopExit` gains `"refused_challenge"`. `life-loop-bounded` already reds every exit but `drained`.
- [ ] **Step 4: PASS** (`ladder-loop.test.ts`, `scenarios.test.ts`, `http-driver.test.ts`, `browser-driver.test.ts`). In the same step, Task 2's page-playoff R4 test in `scenarios.test.ts` gains `expect(verdict("r4-cascade-consistent")).toBe("pass")` (false premise 16). `playLadder` also pushes `{step, fixtureId}` to `rec.ladderSteps` for every issued challenge (read by `r4-not-challenged-later`).
- [ ] **Step 5: Mutation:**
  - `challengerWins` always true → killed by the expected-order test (the right answer differs from the "always climbs" constant);
  - drop the withdrawn filter → killed by R4 (`LADDER_ENTRANT_WITHDRAWN` from the fake) AND, separately, by the fast-check property's "zero refused challenges" (run it with the R4 test file excluded once, so each killer is shown alone);
  - the R4 ladder trigger fires on `round === 1` (today's) → killed by the D14 timing test;
  - `expectedPolicy` hard-coded `"none"` → killed by the `withdrawWhilePending` test;
  - the fake's `withdraw` answers `walkover` always → the "derived policy" test reds (proves the test reads the fake's product-shaped answer, not a constant);
  - `cascadeItems` ignores `kind` (always the forfeit model) → the kind-aware unit test reds on BOTH open-format halves: the POSITIVE (`abandonedAfter` → f1 abandoned with x seated fails the forfeit item) and the NEGATIVE (`forfeitedAfter` → the award to x now passes, so `failing(...).length` is 0). Also killed by `withdrawWhilePending`'s `r4-cascade-consistent` pass and by Task 2's page-playoff test once Task 7 adds that assertion. Run each half alone once (comment out the other) and paste both reds (review 3 I-3);
  - `cascadeItems` always uses the abandon model → the kind-aware unit test reds on BOTH table/bracket halves: the POSITIVE (`forfeitedAfter` → the forfeit is not an abandon) and the NEGATIVE (`abandonedAfter` now passes). Run each half alone once and paste both reds. The canary test's `r4-cascade-consistent` comparison also kills it;
  - `cascadeItems` reads a second pending list instead of `PENDING_STATUSES`, or `FORFEIT_MODEL_KINDS` drifts from the pinned union → killed by the pending-set text-pin test (review 3 m-6);
  - drop the raw-`ladder_order` item → killed by "gone from the LIVE order, still in the RAW";
  - turn the W7 finalRanks note into a check → killed by `checks.some(/finalRanks/) === false`.
  - `plan.length === 0` returns `drained` → killed by the empty case;
  - read `ladder_order` from the challenge answer only, never re-listing → killed by the fake's `staleLadderOrderInAnswer` option test (the fake answers the pre-decision order, as the product does before the result lands).
- [ ] **Step 6: tsc + eslint; commit** `feat(matrix): ladder driving through challenges; R4 on the ladder per rulings 51 and 53; kind-aware cascade (W1-driving T7, D8, D14)`.

---

## Task 8: Americano and mexicano rounds

**Why:** 22 cells across the two modes. Americano plans every round at generate. Mexicano plans one round per generate, once the previous round is fully decided. A second americano generate can duplicate rounds (false premise 3). Suspected product reds must be recorded, never fixed (D9).

**Files:**
- Create: `scripts/matrix/lib/scenarios/americano-loop.ts`, `scripts/matrix/__tests__/americano-loop.test.ts`
- Modify: `driver/types.ts` (`americanoView`), `http-driver.ts`, `browser-driver.ts` (filler), `common.ts` (`FORMAT_LATER` deleted; `playStage` dispatches `kind === "americano"` by `config.mode`), `lib/observed.ts` (`ObservedStage.persons?: Record<string, readonly string[]>`, entrant → person ids, for every pair entrant seen), `fake-formats-driver.ts` (`FakeAmericanoDriver`), `lib/scenarios/m1-walkover.ts` (D14: the per-kind `targetOf` strategy; pair-member target and pair winner on `americano`), `lib/scenarios/r4-withdrawal.ts` (D14: the predicted signature `r4-withdrawn-player-kept-playing` on `americano`).
- Test: `americano-loop.test.ts`, `scenarios.test.ts` (the remaining `:1012` test deleted).

**Interfaces:**
- Produces:
  ```ts
  export interface AmericanoViewOut { readonly mode: "americano" | "mexicano"; readonly rounds: readonly { round_no: number; matches: readonly { fixture_id: string; status: string; team1: { entrant_id: string }; team2: { entrant_id: string } }[] }[]; readonly leaderboard: readonly { person_id: string; points: number; games: number }[] }
  americanoView(stageId: string): Promise<AmericanoViewOut>;                        // GET /api/v1/stages/{id}/americano
  export async function playAmericano(ctx, rec, setup, stage, hooks): Promise<void>;
  export async function playMexicano(ctx, rec, setup, stage, hooks): Promise<void>;
  ```
  `LoopExit` gains `"stalled_rounds"`. `CaseFact` is unchanged.

- [ ] **Step 0: Pin the product:**
  - `americanoGen` (`stages.ts:734-800`): does americano plan all `config.rounds` at the first generate, and does a second generate add another set?
  - mexicano: what does a generate answer while a round is open, and what does it answer after the last declared round?
  - the pair entrants' members: `GET /entrants/{pair}` returns the two persons;
  - what `completeStage` puts in `finalRanks` for an americano stage (individual entrants, or pair entrants);
  - (plan review 1 I-3) the mexicano wait predicate, re-pinned: `existing.some((f) => f.status !== "decided")` at `stages.ts:769` at plan time, and the status a walkover gets (`forfeited`, `engine-db/append-event.ts:147`) and a withdrawal void gets;
  - (plan review 1 I-2) the member-row read in `americanoGen`: `personOf` over all `entrant_members` rows, no kind filter, no `order by` (`stages.ts:744-747` at plan time);
  - (D14) whether mexicano's next generate still seats an individual withdrawn after round 1 (`americanoGen` receives `entrants: ActiveEntrant[]`, `stages.ts:734-740`; pin where the caller at `:2396` builds that list and whether it excludes withdrawn entrants);
  - (plan review 2 I-3, false premise 17) the active-entrant query the generate passes to `americanoGen`: no kind filter, `status in ('registered', 'confirmed')` (`stages.ts:2290-2293` at plan time); the pair-entrant insert, `kind: "pair"` with the default status `'registered'` (`stages.ts:715-721`, `db/migration/v2-engine/tables/V212__entrants.sql:12`); the `entrant_members` primary key (`V213__entrant_members.sql:9`); and `pairMexicanoRound`'s sort, points then id (`packages/engine/src/scheduling/americano.ts:93-95`). Record whether a self-pair would reach the PK (a 500) or is prevented earlier.

  Each is written down with file:line. I10 (Task 9) is built on the answer. **Before any implementation**, run the D14 M1 and R4 americano tests below against TODAY's `m1-walkover.ts` / `r4-withdrawal.ts` and paste the reds (M1: `m1-walkover-recorded` "no round fixture seated seed 1"; R4: `r4-policy-reported` "policy none" with no predicted signature on the case).

- [ ] **Step 1: Failing tests.** Transitions: the first round; the last round; a round with a sit-out (F1: 7 players, courtCount 2); a withdrawn player (R4, a predicted product red, D14; on mexicano it does NOT stall, plan review 2 I-3); a walkover (M1 on a pair entrant, D14; on mexicano it stalls the rounds, false premise 14); a void on mexicano; round 2 of mexicano, where the product counts round 1's pair entrants as players (false premise 17); americano vs mexicano; a team sport (false premise 10 corrected: it GENERATES, with one arbitrary roster member per team; recorded as a W7 finding, never a crash).
  ```ts
  it("americano: no generate after Start; rounds played lowest first; capped by config.rounds", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano", rounds: 7 });
    await runOn(driver, "LIFECYCLE", { row: "americano" });
    const stageId = driver.stageIdAt(1);
    expect(driver.calls.filter((c) => c === `generate ${stageId}`).length).toBe(0);
    expect(driver.roundsDecided()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("mexicano loop mechanics (individualsOnly, to isolate the loop): one generate per fully decided round; created 0 before config.rounds is stalled_rounds with a note", async () => {
    const ok = new FakeAmericanoDriver({ mode: "mexicano", rounds: 7, individualsOnly: true });
    const good = await runOn(ok, "LIFECYCLE", { row: "mexicano" });
    expect(ok.calls.filter((c) => c.startsWith("generate ")).length).toBe(7);   // rounds 2..7 + the drained probe after round 7
    expect(good.checks.find((c) => c.id === "life-loop-bounded")?.verdict).toBe("pass");
    const stall = new FakeAmericanoDriver({ mode: "mexicano", rounds: 7, stallAfter: 3, individualsOnly: true });
    const bad = await runOn(stall, "LIFECYCLE", { row: "mexicano" });
    expect(bad.out.notes.some((n) => /stalled after round 3 of 7/.test(n))).toBe(true);
    expect(bad.checks.find((c) => c.id === "life-loop-bounded")?.verdict).toBe("fail");
  });
  it("persons: every pair entrant seen is resolved to its two persons, recorded on the stage", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano", rounds: 3 });
    const { out } = await runOn(driver, "LIFECYCLE", { row: "americano" });
    const persons = out.observed.stages[0]!.persons!;
    expect(Object.keys(persons).length).toBeGreaterThan(0);
    for (const ids of Object.values(persons)) expect(ids.length).toBe(2);
  });
  it("fast-check (rule 10, product-shaped fake): under any interleaving of decide / forfeit / generate / withdraw, a non-decided fixture blocks every later round, round 1 never repeats a person, and every later duplicate is explained by an earlier pair entrant", async () => {
    let dupRuns = 0;
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("decideOne", "forfeitOne", "generate", "withdrawOne"), { maxLength: 24 }), async (steps) => {
      const h = await MexicanoHarness.open(new FakeAmericanoDriver({ mode: "mexicano", rounds: 5 }), 8);   // DEFAULT = the product's shape
      for (const s of steps) {
        await h.step(s);
        const r1 = h.rounds().find((r) => r.round_no === 1);
        if (r1) expect(new Set(r1.persons).size, "round 1").toBe(r1.persons.length);   // only individuals exist before round 2
        // Review 2 I-3: from round 2 a duplicate is the PRODUCT's (pair entrants counted as players, false premise 17).
        // The harness invariant is that the signature's evidence holds: each duplicated person is a member of a pair entrant
        // seated in an EARLIER round. A duplicate that evidence cannot explain is a harness or fake defect.
        for (const r of h.rounds().filter((x) => x.round_no >= 2)) for (const p of h.duplicatesIn(r)) {
          expect(h.pairEntrantsBefore(r.round_no).some((e) => h.membersOf(e).includes(p)), `round ${r.round_no}: ${p}`).toBe(true);
        }
        // I-3: once any fixture is not "decided", no later generate creates a round (the product's rule, text-pinned below).
        if (h.anyNonDecided()) expect(h.lastGenerateCreated() ?? 0, "generate created a round past a non-decided fixture").toBe(0);
      }
      if (h.rounds().some((r) => r.round_no >= 2 && h.duplicatesIn(r).length > 0)) dupRuns++;
      return true;
    }), { numRuns: 200, seed: Number(process.env.MATRIX_FC_SEED ?? 20260930) });
    expect(dupRuns, "runs that reached a round-2 duplicate (anti-vacuity for the evidence invariant)").toBeGreaterThan(0);
  });
  it("the fake's mexicano wait and player set ARE the product's (text pins, review 1 I-3, review 2 I-3)", () => {
    const src = readFileSync(STAGES_TS, "utf8");                     // apps/web/src/server/usecases/stages.ts
    const gen = sliceFunction(src, "americanoGen");                  // the function body, by brace matching
    expect(gen.match(/existing\.some\(\(f\) => f\.status !== "decided"\)/g)?.length).toBe(1);
    expect(WAIT_UNLESS).toBe("decided");                             // the fake's constant
    const active = src.match(/const active = await tx<ActiveEntrant\[\]>`([\s\S]*?)`/)?.[1] ?? "";
    expect(active).toMatch(/status in \('registered', 'confirmed'\)/);
    expect(active).not.toMatch(/\bkind\b/);                          // no kind filter: pair entrants are "players" (false premise 17)
    expect(FAKE_COUNTS_PAIR_ENTRANTS_AS_PLAYERS_BY_DEFAULT).toBe(true);
  });
  it("the fake serves a mexicano stage in the product's shape: kind americano, config.mode mexicano (review 3 I-1)", async () => {
    const driver = new FakeAmericanoDriver({ mode: "mexicano", rounds: 7 });
    await runOn(driver, "LIFECYCLE", { row: "mexicano" });
    const s = driver.stageAt(1);
    expect([s.kind, s.config.mode]).toEqual(["americano", "mexicano"]);
    // And the template the product ships is the same shape (format-templates.ts:261, read as text):
    expect(readFileSync(FORMAT_TEMPLATES_TS, "utf8")).toMatch(/kind: "americano",[^}]*mode: "mexicano"/);
  });
  it("mexicano round 2 (false premise 17): the product-shaped fake repeats a person; the case records the signature with its evidence, routed W7", async () => {
    // A field whose round-2 pairing produces no self-pair, so this test isolates the duplicate (the self-pair path is its own test).
    const driver = new FakeAmericanoDriver({ mode: "mexicano", rounds: 7 });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "mexicano" });
    expect(driver.selfPairsIn(2)).toBe(0);                           // not vacuous about which path ran
    const dup = driver.firstDuplicate();                             // {round_no, person, viaPairEntrant} from the fake's own rows
    expect(dup.round_no).toBeGreaterThanOrEqual(2);
    expect(out.notes.some((n) => n.includes("mexicano-pair-entrants-counted-as-players") && n.includes(dup.person) && n.includes(dup.viaPairEntrant) && /→ W7/.test(n))).toBe(true);
    // The FULL failing-check set, which Task 15's "only covered checks" rule reads (review 2 m-8). At Task 8 no check can
    // see the duplicate yet: I10 is created in Task 9, and Task 9 Step 1 changes this expectation to
    // ["I10-americano-seats-each-person-once"] (review 3 m-1, the Task 2 → Task 7 pattern).
    expect(checks.filter((c) => c.verdict === "fail").map((c) => c.id).sort()).toEqual([]);
  });
  it("mexicano self-pair (review 3 I-2; fake option selfPairAnswers500, set per the Step 0 pin): round 2 refused, signature written, full failing set pinned", async () => {
    const driver = new FakeAmericanoDriver({ mode: "mexicano", rounds: 7, selfPairAnswers500: true });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "mexicano" });
    expect(driver.selfPairsIn(2)).toBeGreaterThan(0);
    expect(checks.find((c) => c.id === "life-loop-bounded")?.evidence.some((e) => /exited refused_generate/.test(e))).toBe(true);
    expect(out.notes.some((n) => n.startsWith("mexicano-pair-entrants-counted-as-players: round 2 generate refused") && /→ W7/.test(n))).toBe(true);
    expect(checks.filter((c) => c.verdict === "fail").map((c) => c.id).sort()).toEqual(["I4-nothing-ends-stuck", "I8-generate-named", "life-loop-bounded", "life-stage-completed"]);
  });
  it("mexicano M1 walkover (D14, false premise 14): the forfeit stalls every later round → stalled_rounds, a note, predicted W7", async () => {
    const driver = new FakeAmericanoDriver({ mode: "mexicano", rounds: 7 });
    const { out, checks } = await runOn(driver, "M1", { row: "mexicano" });
    expect(checks.find((c) => c.id === "m1-walkover-recorded")?.verdict).toBe("pass");
    expect(checks.find((c) => c.id === "life-loop-bounded")?.evidence.some((e) => /exited stalled_rounds/.test(e))).toBe(true);
    expect(out.notes.some((n) => /mexicano-stalled-on-non-decided/.test(n) && /→ W7/.test(n))).toBe(true);
    // The FULL failing-check set (review 2 m-8; corrected at review 3 Q3/I-2), derived from the rule, not from a run:
    //  - M1 forfeits in round 1, so the stall comes before any round 2 (no duplicate; I10, from Task 9, passes);
    //  - the loop exits stalled_rounds → life-loop-bounded;
    //  - Task 6's playDivision skips finishStage on a non-drained exit, so complete is null → I4 "stage 1: never asked to
    //    complete" (invariants.ts:235; no cut_short, so no abstain) and life-stage-completed "never asked" (round 1 is all terminal);
    //  - I8 passes: the created-0 generate is a 2xx whose total is the stage's full list (> 0).
    // Decision: the stall does NOT add cut_short. cut_short means "stopped at the harness's cap"; a stall is the product
    // refusing to go on, and masking I4 with it would also hide a genuine "never asked to complete" on any other path.
    expect(checks.filter((c) => c.verdict === "fail").map((c) => c.id).sort()).toEqual(["I4-nothing-ends-stuck", "life-loop-bounded", "life-stage-completed"]);
    for (const id of ["I4-nothing-ends-stuck", "life-stage-completed"]) {
      expect(checks.find((c) => c.id === id)!.evidence.every((e) => /never asked/.test(e)), `${id}: only "never asked" items`).toBe(true);
    }
  });
  it("mexicano R4 does NOT stall (review 2 I-3): round 2 is generated; the signature needs seed 3's person seated in round ≥ 2 through ANY entrant", async () => {
    const driver = new FakeAmericanoDriver({ mode: "mexicano", rounds: 7 });
    const { out, checks } = await runOn(driver, "R4", { row: "mexicano" });
    expect(out.notes.some((n) => /mexicano-stalled-on-non-decided/.test(n))).toBe(false);
    expect(driver.roundsGenerated()).toContain(2);
    const p3 = driver.personOfSeed(3);
    const seatedLater = driver.fixturesAfterRound(1).some((f) => [f.home_entrant_id, f.away_entrant_id].some((e) => driver.membersOf(e!).includes(p3)));
    // Signature present iff its second leg holds, read from the fake's rows (the oracle), never from r4-withdrawal.ts.
    expect(out.notes.some((n) => /r4-withdrawn-player-kept-playing/.test(n))).toBe(seatedLater);
    expect(seatedLater, "the product-shaped default seats seed 3's person later (false premise 17)").toBe(true);
    // Full failing set at Task 8 (review 3 I-2; Task 9 Step 1 adds "I10-americano-seats-each-person-once" for the round-2 duplicate):
    expect(checks.filter((c) => c.verdict === "fail").map((c) => c.id).sort()).toEqual(["r4-policy-reported"]);
  });
  it("mexicano R4 WITHOUT the second leg (dropWithdrawnFromPlan, committed; review 3 m-4): no signature", async () => {
    // On mexicano the option drops the withdrawn individual AND every pair entrant containing their person, or
    // false premise 17 would keep seating them through a round-1 pair and seatedLater would stay true.
    const driver = new FakeAmericanoDriver({ mode: "mexicano", rounds: 7, dropWithdrawnFromPlan: true });
    const { out } = await runOn(driver, "R4", { row: "mexicano" });
    const p3 = driver.personOfSeed(3);
    expect(driver.fixturesAfterRound(1).some((f) => [f.home_entrant_id, f.away_entrant_id].some((e) => driver.membersOf(e!).includes(p3)))).toBe(false);
    expect(driver.roundsGenerated()).toContain(2);                   // round 2 exists, so "no signature" is not vacuous
    expect(out.notes.some((n) => /r4-withdrawn-player-kept-playing/.test(n))).toBe(false);
  });
  it("M1 on americano (D14, ruling 51): targets the first fixture whose pair entrant has seed 1's person as a member — reds on today's hook", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano", rounds: 7 });
    const { out, checks } = await runOn(driver, "M1", { row: "americano" });
    const p1 = driver.personOfSeed(1);
    const round1 = driver.fixturesOfRound(1);
    // Oracle: the fake's own member rows (the product-shaped pair entrants), not m1-walkover.ts.
    const expected = round1.find((f) => driver.membersOf(f.home_entrant_id!).includes(p1) || driver.membersOf(f.away_entrant_id!).includes(p1))!;
    const seed1Pair = driver.membersOf(expected.home_entrant_id!).includes(p1) ? expected.home_entrant_id : expected.away_entrant_id;
    const fx = out.observed.stages[0]!.fixtures.find((f) => f.id === expected.id)!;
    expect(fx.status).toBe("forfeited");
    expect(fx.outcome && "winner" in fx.outcome ? fx.outcome.winner : null).toBe(seed1Pair);
    expect(checks.find((c) => c.id === "m1-walkover-recorded")?.verdict).toBe("pass");
    expect(checks.find((c) => c.id === "m1-winner-progresses")?.verdict).toBe("abstain");
    expect(driver.calls.filter((c) => c.startsWith("entrantMembers ")).length, "the target was found through entrant members").toBeGreaterThan(0);
  });
  it("R4 on americano (D14, ruling 51): the withdrawn player keeps playing → the predicted signature, routed W7, never a crash", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano", rounds: 7 });
    const { out, checks } = await runOn(driver, "R4", { row: "americano" });
    expect(out.observed.withdrawal!.policy).toBe("none");
    expect(out.observed.withdrawal!.before).toEqual([]);
    expect(checks.find((c) => c.id === "r4-policy-reported")?.verdict).toBe("fail");
    expect(out.notes.some((n) => /r4-withdrawn-player-kept-playing/.test(n) && /→ W7/.test(n))).toBe(true);
    // the signature's second leg, from the fake's members: seed 3's person sits in a pair on a round > 1
    const p3 = driver.personOfSeed(3);
    expect(driver.fixturesAfterRound(1).some((f) => [f.home_entrant_id, f.away_entrant_id].some((e) => driver.membersOf(e!).includes(p3)))).toBe(true);
    expect(checks.filter((c) => c.verdict === "fail").map((c) => c.id).sort(), "full failing set (review 3 I-2)").toEqual(["r4-policy-reported"]);
  });
  it("R4 on americano WITHOUT the second leg (fake option `dropWithdrawnFromPlan`): no predicted signature — the red goes to normal triage", async () => {
    // The differing case: a product that DID drop the withdrawn player from later pairs must not be labelled with the W7 signature.
    const driver = new FakeAmericanoDriver({ mode: "americano", rounds: 7, dropWithdrawnFromPlan: true });
    const { out, checks } = await runOn(driver, "R4", { row: "americano" });
    const p3 = driver.personOfSeed(3);
    expect(driver.fixturesAfterRound(1).some((f) => [f.home_entrant_id, f.away_entrant_id].some((e) => driver.membersOf(e!).includes(p3)))).toBe(false);
    expect(out.notes.some((n) => /r4-withdrawn-player-kept-playing/.test(n))).toBe(false);
    expect(checks.find((c) => c.id === "r4-policy-reported")?.verdict).toBe("fail");  // still red (policy none), now uncovered
  });
  it("americano|badminton LIFECYCLE puts zero lineups and completes; americano|football puts zero lineups, notes the pair-entrant skip, and completes (I-1)", async () => {
    // FakeAmericanoDriver mirrors americanoGen's member read: one person per entrant, the LAST member row for a team (false premise 10).
    const bad = new FakeAmericanoDriver({ mode: "americano", rounds: 3 });
    const b = await runOn(bad, "LIFECYCLE", { row: "americano", sport: "badminton" });
    expect(bad.calls.filter((c) => c.startsWith("putLineup ")).length).toBe(0);
    expect(b.out.observed.stages[0]!.exit).toBe("drained");
    expect(b.checks.find((c) => c.id === "life-stage-completed")?.verdict).toBe("pass");
    const foot = new FakeAmericanoDriver({ mode: "americano", rounds: 3 });
    const f = await runOn(foot, "LIFECYCLE", { row: "americano", sport: "football", variant: Object.keys(sportModule("football").variants as object)[0]! });
    expect(foot.calls.filter((c) => c.startsWith("putLineup ")).length).toBe(0);
    expect(f.out.notes.filter((n) => /not a division entrant/.test(n)).length).toBe(1);   // one stage
    expect(f.out.notes.filter((n) => n.startsWith("americano generated on team entrants with one arbitrary roster member each") && /W7/.test(n)).length).toBe(1);
    expect(f.out.observed.stages[0]!.exit).toBe("drained");
    expect(f.checks.find((c) => c.id === "life-stage-completed")?.verdict).toBe("pass");
  });
  it("team americano: the product's member read has no kind filter (text pin, I-2)", () => {
    // Reads stages.ts as text: inside americanoGen the entrant_members select carries no `kind` predicate and no `order by`.
    // If a product fix adds either, this pin reds and false premise 10's prediction must move (to a refusal or a roster-aware plan).
  });
  ```
  **The fake's default is the product's shape (plan review 2 I-3, false premise 17).** From mexicano round 2 on, `FakeAmericanoDriver` counts every active entrant as a player, pair entrants included (no kind filter, status `registered`/`confirmed`, as `stages.ts:2290-2293` does). It pairs them by points then id (`americano.ts:93-95`), so a person can sit in round 2 both alone and inside a round-1 pair entrant. The option `individualsOnly: true` models the corrected product; only the loop-mechanics test and a harness-isolating unit use it. The old `duplicateInRound2` option is gone: the duplicate is the default, never an opt-in. The default is DERIVED from the exported constant, `individualsOnly = opts.individualsOnly ?? !FAKE_COUNTS_PAIR_ENTRANTS_AS_PLAYERS_BY_DEFAULT`, so the text-pin test's assertion on the constant moves the fake with it (plan review 3 m-4).

  **The fake serves the product's stage shape (plan review 3 I-1).** A mexicano stage is `{ kind: "americano", config: { mode: "mexicano", … } }` (`format-templates.ts:261`, `api-v1/schemas.ts:1019`, the product branches on `cfg.mode` at `stages.ts:756`). `FakeAmericanoDriver({ mode: "mexicano" })` answers `listStages` with exactly that: `kind: "americano"` and `config.mode: "mexicano"`, never `kind: "mexicano"`. Every mexicano branch in the harness keys on `stage.kind === "americano" && stage.config.mode === "mexicano"`: `playStage`'s dispatch, `notePairEntrantDuplicates`, the stall note and the R4 second leg. A test pins the fake's shape: `driver.stageAt(1)` has `kind === "americano"` and `config.mode === "mexicano"`, so a fake that drifts to `kind: "mexicano"` reds there before it can keep a dead gate green.

  **The self-pair path (plan review 3 I-2).** Whether a self-pair (a pair entrant paired with its own member) reaches the `entrant_members` PK as a 500 is pinned at Step 0. The fake mirrors that answer. If it is a 500, the round-2 generate exits `refused_generate`, round 2 is never created, and the case's full failing set is `["I4-nothing-ends-stuck", "I8-generate-named", "life-loop-bounded", "life-stage-completed"]`: an unnamed 500 generate (I4, I8), the loop exit (life-loop-bounded), and a finished round 1 never asked to complete (I4, life-stage-completed). I10 passes, because no round 2 exists. `playMexicano` then writes the signature with the self-pair evidence (`mexicano-pair-entrants-counted-as-players: round 2 generate refused <status> after round 1 created pair entrants <ids> → W7`). A fake test with option `selfPairAnswers500: true` pins that set. The harness must NOT fix the duplicate. The case records it as the I10 red (Task 9) with the signature note below, and the loop still ends at its bound.

  `FakeAmericanoDriver` waits on exactly `status !== "decided"` (a forfeit and a void both block, false premise 14) and reads persons the way `americanoGen` does (every member row, last one wins). The notes the loop writes carry the predicted signatures `mexicano-stalled-on-non-decided`, `mexicano-pair-entrants-counted-as-players` and `r4-withdrawn-player-kept-playing` verbatim. `playMexicano` writes `mexicano-pair-entrants-counted-as-players: round <r> seats <person> twice, directly and via pair entrant <id> (a round-<q> pair, q < r) → W7` for the first such duplicate per stage. The evidence (the person is a member of an earlier pair entrant) is required: a duplicate it cannot explain gets no signature and goes to normal triage. The signatures are written verbatim because Task 15 Step 3's triage rule matches on them. On a team sport (`setup.kind === "team"`), `playAmericano`/`playMexicano` also push, once, "americano generated on team entrants with one arbitrary roster member each — W7 finding (false premise 10)", naming for each team the one person the product seated (read from the pair entrants' members against `setup.persons`); that note is the finding, since every check may still pass.

  **The M1 hook on americano** (`m1-walkover.ts`, D14): `targetOf` for kind `americano` resolves `setup.persons.get(seed1)`, then for each fixture in the batch reads `ctx.driver.entrantMembers(side)` for both sides (cached per pair entrant) and takes the first fixture where either side's members intersect seed 1's persons. `absent` is the other side; `m1-walkover-recorded`'s expected winner is seed 1's pair entrant (canary: the absent pair). For every other kind `targetOf` is today's entrant-id match, byte-for-byte.

  **The R4 signature on americano** (`r4-withdrawal.ts`, D14): after `snapshot`, on kind `americano`, when `w.policy === "none"` and `w.before.length === 0`, the scenario reads seed 3's persons from `setup.persons` and the observed stage's `persons` map; if any of them belongs to a pair entrant seated on a fixture with `roundNo > w.afterRound`, it pushes `r4-withdrawn-player-kept-playing: <person> still seated in <k> later fixture(s) — predicted product red → W7`. On mexicano (`stage.config.mode === "mexicano"` on the same `americano` kind, plan review 3 I-1) the same rule applies with a real second leg (plan review 2 I-3: R4 does not stall mexicano, so round 2 is generated). The signature is pushed only when seed 3's person is seated in a round ≥ 2 through ANY entrant (alone, or as a member of a pair entrant, which false premise 17 makes likely). Policy `none` and an empty `before` are not enough on their own. `r4-policy-reported` is NOT relaxed: it still reds, and the note is what Task 15 Step 3's triage rule reads.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** `americano-loop.ts`:
  ```ts
  // D9. Americano plans every round at Start's generate; a re-generate can
  // plan again (false premise 3), so the loop never generates. Mexicano plans
  // one round per generate once the previous round is decided. Both are bounded
  // by the stage's own config.rounds; a mexicano that stops early is a named
  // stall, never ✅. Suspected product reds are RECORDED (→ W7), never fixed.
  export async function playAmericano(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, hooks: Hooks): Promise<void> {
    const track = rec.track(stage.id);
    const rounds = Number(stage.config.rounds);
    for (let r = 1; r <= rounds; r++) {
      const open = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id && seatedOpen(f));
      if (open.length === 0) break;
      const round = Math.min(...open.map((f) => f.round_no ?? 0));
      await decideRound(ctx, rec, setup, stage, round, open.filter((f) => (f.round_no ?? 0) === round), hooks);
    }
    const left = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id && seatedOpen(f));
    track.exit = rec.exit = left.length === 0 ? "drained" : "cap";
    if (left.length > 0) { rec.facts.add("cut_short"); rec.notes.push(`americano: ${left.length} fixture(s) open after config.rounds=${rounds}`); }
    await recordPersons(ctx, rec, setup, stage);
  }

  export async function playMexicano(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef, hooks: Hooks): Promise<void> {
    const track = rec.track(stage.id);
    const rounds = Number(stage.config.rounds);
    let played = 0;
    for (let g = 0; g <= rounds; g++) {                         // cap: config.rounds + 1 generates (the drained probe)
      const open = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id && seatedOpen(f));
      if (open.length > 0) {
        const round = Math.min(...open.map((f) => f.round_no ?? 0));
        await decideRound(ctx, rec, setup, stage, round, open.filter((f) => (f.round_no ?? 0) === round), hooks);
        played++;
      }
      if (g === rounds) break;
      const fixtures = await recordGenerate(ctx, rec, stage.id);
      if (fixtures === null) { track.exit = rec.exit = "refused_generate"; await recordPersons(ctx, rec, setup, stage); return; }
      const created = track.generates.at(-1)!.created;
      if (created === 0) {
        track.exit = rec.exit = played >= rounds ? "drained" : "stalled_rounds";
        if (played < rounds) {
          // I-3 / false premise 14: the product waits on ANY non-"decided" fixture (stages.ts:769) — a forfeited
          // walkover, a void, a finalized row. Name it so triage can route it without a harness hunt.
          const blocking = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id && f.status !== "decided");
          rec.notes.push(blocking.length > 0
            ? `mexicano-stalled-on-non-decided: stalled after round ${played} of ${rounds}; ${blocking.length} fixture(s) not decided (${[...new Set(blocking.map((f) => f.status))].join(", ")}) — predicted product red → W7`
            : `mexicano: stalled after round ${played} of ${rounds} (generate created 0, every fixture decided) — suspected product red → W7`);
        }
        await recordPersons(ctx, rec, setup, stage);
        return;
      }
    }
    track.exit = rec.exit = "cap";
    rec.facts.add("cut_short");
    await recordPersons(ctx, rec, setup, stage);
  }

  /** Every pair entrant seated in this stage → its persons (GET /entrants/{id}),
   *  so I10 can check per-round uniqueness against the product's own members. */
  async function recordPersons(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, stage: StageRef): Promise<void> {
    const sides = new Set((await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === stage.id).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((e): e is string => e !== null));
    const out: Record<string, readonly string[]> = {};
    for (const e of sides) out[e] = (await ctx.driver.entrantMembers(e)).map((m) => m.person_id);
    rec.stagePersons.set(stage.id, out);
    // Review 3 I-1: mexicano is { kind: "americano", config.mode: "mexicano" } (format-templates.ts:261, schemas.ts:1019,
    // stages.ts:756). StageRef.kind is the raw kind (driver/types.ts:16), so a `kind === "mexicano"` gate is never true live.
    if (stage.kind === "americano" && stage.config.mode === "mexicano") notePairEntrantDuplicates(rec, setup, stage, out);
  }

  /** From round 2 on: the first person seated twice in one round, directly and via a pair entrant that an EARLIER
   *  round created, gets the predicted signature. Evidence required; an unexplained duplicate gets no signature. */
  function notePairEntrantDuplicates(rec: Recorder, setup: DivisionSetup, stage: StageRef, persons: Record<string, readonly string[]>): void {
    // for each round r ≥ 2 (from rec's fixtures of this stage): expand each side to persons via `persons`
    // (a division entrant maps through setup.persons); find a person p appearing twice; find a pair entrant e seated in a
    // round q < r with p ∈ persons[e]; if found, push the signature note once per stage and return.
  }
  ```
  `decideRound` is the existing `decideBatch` body, lifted to take `stage`. `Recorder.stagePersons: Map<string, Record<string, readonly string[]>>`, and `snapshot` writes it to `ObservedStage.persons`. The division entrants' own persons come from `setup.persons` (Task 5; never `rosters`, plan review 1 I-1), and `snapshot` writes them to the same map, so I10 can map field entrant → person.

  In the mexicano loop, `played` counts the rounds the harness decided. The "drained probe" is the one generate after the last declared round, which must create 0. If it creates more, the next loop pass has `g === rounds`, plays nothing and exits `cap` with `cut_short`: a mexicano that keeps planning past its declared rounds is recorded, not trusted.
- [ ] **Step 4: PASS** (`americano-loop.test.ts`, `scenarios.test.ts`, `http-driver.test.ts`).
- [ ] **Step 5: Mutation:**
  - americano calls `recordGenerate` each round → killed by "no generate after Start";
  - mexicano treats `created 0` as `drained` always → killed by the stall test;
  - drop `recordPersons` → killed by the persons test;
  - the fake's mexicano wait → `status === "finalized"` only (the first draft's D9 reading) → killed by the fast-check's "non-decided blocks" invariant and the M1 mexicano stall test (proves the fake is held to the product's rule, I-3);
  - the stall note loses the `mexicano-stalled-on-non-decided` signature → killed by the M1 mexicano test;
  - M1 `targetOf` for americano falls back to the entrant-id match → killed by the D14 M1 americano test (today's red returns);
  - the R4 signature ignores its second leg (labels every `policy none` americano case) → killed by the `dropWithdrawnFromPlan` test;
  - the mexicano R4 signature fires on `policy none` alone (the first draft's shape) → killed by the COMMITTED "mexicano R4 WITHOUT the second leg" test (review 3 m-4);
  - gate `notePairEntrantDuplicates` (or the R4 second leg, or the stall note) on `stage.kind === "mexicano"` → killed by the mexicano round-2 test (no signature), because the fake serves `kind: "americano"` (review 3 I-1); and a fake drifting to `kind: "mexicano"` is killed by the stage-shape test;
  - `dropWithdrawnFromPlan` on mexicano drops only the individual, not the pair entrants holding their person → killed by the committed "WITHOUT the second leg" test (`seatedLater` stays true);
  - `notePairEntrantDuplicates` drops its evidence requirement (labels any duplicate) → killed by a unit case with a duplicate that no earlier pair explains;
  - drop the `notePairEntrantDuplicates` call → killed by the mexicano round-2 test;
  - the fake's default flips to `individualsOnly` → killed by the fast-check `dupRuns > 0` count and by the text-pin test, because the default is DERIVED from `FAKE_COUNTS_PAIR_ENTRANTS_AS_PLAYERS_BY_DEFAULT` (review 3 m-4);
  - the stall adds `cut_short` → killed by the M1 mexicano full-set test (I4 would abstain);
  - `ensureLineups` loses the `entrantIds.has` gate → killed by the americano|football zero-lineups test (the named throw fires).
- [ ] **Step 6: tsc + eslint; commit** `feat(matrix): americano and mexicano round loops on linked persons; M1/R4 on the pair entrants per ruling 51; pair-entrant duplicate signature (W1-driving T8, D9, D14)`.

---

## Task 9: Invariants — I2 structural on the three non-knockout brackets (ruling 45); I9 ladder; I10 americano

**Why:**
- I2 checks a champion on knockout only (`invariants.ts:120-132`). On double elim, stepladder and page playoff it checks the permutation alone, so a wrong champion passes.
- No invariant targets `ladder` or `americano` at all. Only I4, I5 and I8 apply there (facts B §5).

**Files:**
- Modify: `scripts/matrix/lib/invariants.ts` (I2's non-knockout branch; `I9`, `I10`; `INVARIANTS`), `lib/observed.ts` (`ObservedFixture.extKey?: string | null`, `isFinal?: boolean`; set by Task 6's `toFixture`).
- Test: `scripts/matrix/__tests__/invariants.test.ts`.

**Interfaces:**
- Produces:
  - `terminalFinalKeys(kind: string, field: readonly string[], config: Record<string, unknown>): readonly string[]`, derived from the engine's generators;
  - `I9-ladder-order-is-the-field`;
  - `I10-americano-seats-each-person-once`.

  Both new specs are `stepSafe: false`.

- [ ] **Step 1: Failing tests.** List the empty case first for each: no stage, a stage with no fixtures, a stage with no final.

  **Task 8's mexicano round-2 test changes here (plan review 3 m-1).** In `americano-loop.test.ts`, "mexicano round 2 (false premise 17)" changes its full failing set from `[]` to `["I10-americano-seats-each-person-once"]`, with the I10 evidence `round 2: <dup.person> seated 2×`. "mexicano R4 does NOT stall" changes likewise, from `["r4-policy-reported"]` to `["I10-americano-seats-each-person-once", "r4-policy-reported"]`. Task 8's other pinned sets are unchanged: the M1 stall has no round 2, and the self-pair path creates none, so I10 passes on both. Run that test red before the I10 implementation (it still reads `[]`), then green after.

  Then:
  ```ts
  describe("I2 structural (ruling 45)", () => {
    const kinds = ["page_playoff", "stepladder", "double_elim"] as const;
    it("terminal keys come from the engine's generators, not a table", () => {
      const f4 = ["a", "b", "c", "d"];
      expect(terminalFinalKeys("page_playoff", f4, {})).toEqual(generatePagePlayoff({ entrants: f4 }).fixtures.filter((x) => x.isFinal === true).map((x) => x.id));
      expect(terminalFinalKeys("stepladder", f4, {})).toEqual(generateStepladder({ entrants: f4 }).fixtures.filter((x) => x.isFinal === true).map((x) => x.id));
      expect(terminalFinalKeys("double_elim", f4, { bracketReset: true })).toEqual(generateDoubleElim({ entrants: f4, bracketReset: true }).fixtures.filter((x) => x.isFinal === true).map((x) => x.id));
    });
    const F = ["a", "b", "c", "d"];
    /** A completed bracket of `kind` over F whose terminal final (by the
     *  ENGINE's key) is won by `champ`; every other row is a filler decided
     *  fixture. The expected champion is the one the test sets on that row. */
    const bracketOf = (kind: (typeof kinds)[number], champ: string, finalRanks: string[], cfg: Record<string, unknown> = {}) => {
      const keys = terminalFinalKeys(kind, F, cfg);
      const last = keys.at(-1)!;
      return stage({
        kind, field: F, config: cfg,
        fixtures: [
          fx({ roundNo: 1, home: "a", away: "b", outcome: win("b"), extKey: "r1" }),
          fx({ roundNo: 9, home: champ, away: F.find((x) => x !== champ)!, outcome: win(champ), extKey: last, isFinal: true }),
        ],
        complete: { status: 200, code: null, completed: true, finalRanks, seedProposal: null },
      });
    };
    it.each(kinds)("%s: rank 1 is the winner of the terminal final — passes", (kind) => {
      expect(evaluateInvariant(I2, run([bracketOf(kind, "c", ["c", "a", "b", "d"])]))).toMatchObject({ verdict: "pass" });
    });
    it.each(kinds)("%s: rank 1 is not the terminal final's winner — fails by name", (kind) => {
      const r = evaluateInvariant(I2, run([bracketOf(kind, "c", ["a", "c", "b", "d"])]));
      expect(r.verdict).toBe("fail");
      expect(r.evidence.join(" ")).toMatch(/rank 1 is a, the .* winner is c/);
    });
    it("double_elim with a played gf-reset: the reset's winner, not gf's, is the champion", () => {
      const cfg = { bracketReset: true };
      const s = stage({
        kind: "double_elim", field: F, config: cfg,
        fixtures: [
          fx({ roundNo: 8, home: "a", away: "b", outcome: win("b"), extKey: "gf", isFinal: true }),
          fx({ roundNo: 9, home: "b", away: "a", outcome: win("a"), extKey: "gf-reset", isFinal: true }),
        ],
        complete: { status: 200, code: null, completed: true, finalRanks: ["a", "b", "c", "d"], seedProposal: null },
      });
      expect(evaluateInvariant(I2, run([s])).verdict).toBe("pass");
      expect(evaluateInvariant(I2, run([{ ...s, complete: { ...s.complete!, finalRanks: ["b", "a", "c", "d"] } }])).verdict).toBe("fail");
    });
    it("page_playoff: the champion lost pp-q1 and still passes — no unbeaten rule outside knockout", () => {
      const s = stage({
        kind: "page_playoff", field: F,
        fixtures: [
          fx({ roundNo: 0, home: "a", away: "b", outcome: win("b"), extKey: "pp-q1" }),
          fx({ roundNo: 0, home: "c", away: "d", outcome: win("c"), extKey: "pp-elim" }),
          fx({ roundNo: 1, home: "a", away: "c", outcome: win("a"), extKey: "pp-q2" }),
          fx({ roundNo: 2, home: "b", away: "a", outcome: win("a"), extKey: "pp-final", isFinal: true }),
        ],
        complete: { status: 200, code: null, completed: true, finalRanks: ["a", "b", "c", "d"], seedProposal: null },
      });
      expect(evaluateInvariant(I2, run([s])).verdict).toBe("pass");
    });
    it("no fixture carries the terminal key: fails naming the key", () => {
      const s = bracketOf("stepladder", "c", ["c", "a", "b", "d"]);
      const stripped = { ...s, fixtures: s.fixtures.map((f) => ({ ...f, extKey: null })) };
      expect(evaluateInvariant(I2, run([stripped])).evidence.join(" ")).toMatch(/no decided fixture carries a terminal final key \(sl-g2\)/);
    });
  });
  ```
  The existing knockout I2 tests stay unchanged and green.

  ```ts
  describe("I9 ladder", () => {
    const I9 = spec("I9-ladder-order-is-the-field");
    const ladder = (finalRanks: string[] | null, order: string[], fixtures = [fx({ home: "d", away: "c", outcome: win("d") })]) => stage({
      kind: "ladder", field: ["a", "b", "c", "d"], config: { ladder_order: order }, fixtures,
      complete: { status: 200, code: null, completed: true, finalRanks, seedProposal: null },
    });
    it("empty case first: a ladder stage with no decided challenge fails, checked counted", () => {
      const r = evaluateInvariant(I9, run([ladder(["a", "b", "d", "c"], ["a", "b", "d", "c"], [])]));
      expect(r.verdict).toBe("fail");
      expect(r.evidence.join(" ")).toMatch(/no decided challenge/);
    });
    it("finalRanks = ladder_order over the active field passes; missing, duplicate, outsider and ranks ≠ order each fail by name", () => {
      expect(evaluateInvariant(I9, run([ladder(["a", "b", "d", "c"], ["a", "b", "d", "c"])])).verdict).toBe("pass");
      expect(evaluateInvariant(I9, run([ladder(["a", "b", "d"], ["a", "b", "d"])])).evidence.join(" ")).toMatch(/c not ranked/);
      expect(evaluateInvariant(I9, run([ladder(["a", "a", "b", "d", "c"], ["a", "a", "b", "d", "c"])])).evidence.join(" ")).toMatch(/a ranked 2×/);
      expect(evaluateInvariant(I9, run([ladder(["a", "b", "d", "c", "x"], ["a", "b", "d", "c", "x"])])).evidence.join(" ")).toMatch(/x ranked but not in the field/);
      expect(evaluateInvariant(I9, run([ladder(["a", "b", "c", "d"], ["a", "b", "d", "c"])])).evidence.join(" ")).toMatch(/finalRanks differ from ladder_order/);
    });
    it("the PRODUCT shape (review 2 m-4, ruling 53): a withdrawn entrant stays ranked at its held rung, since finalRanks = raw ladder_order — pass, and the rung is a W7 note", () => {
      // competition.ts:606 snapshots the raw ladder_order, which stages.ts:5562-5572 never prunes; D8 leaves policy "none".
      const w = { entrantId: "c", afterRound: 3, policy: "none" as const, walkovers: 0, voided: 0, skippedFinalized: 0, before: [] };
      const r = evaluateInvariant(I9, run([ladder(["a", "c", "b", "d"], ["a", "c", "b", "d"])], { withdrawal: w }));
      expect(r.verdict).toBe("pass");                                 // "ranked but withdrawn" is NOT an I9 failure (W7's question)
      expect(r.checked).toBe(4);
    });
    it("a withdrawn entrant may ALSO be absent from finalRanks (a pruning product); an active one may not", () => {
      const w = { entrantId: "c", afterRound: 3, policy: "none" as const, walkovers: 0, voided: 0, skippedFinalized: 0, before: [] };
      expect(evaluateInvariant(I9, run([ladder(["a", "b", "d"], ["a", "b", "d"])], { withdrawal: w })).verdict).toBe("pass");
      expect(evaluateInvariant(I9, run([ladder(["a", "c", "d"], ["a", "c", "d"])], { withdrawal: w })).evidence.join(" ")).toMatch(/b not ranked/);
    });
  });
  describe("I10 americano", () => {
    const I10 = spec("I10-americano-seats-each-person-once");
    const persons = { A: ["p1"], B: ["p2"], C: ["p3"], D: ["p4"], P12: ["p1", "p2"], P34: ["p3", "p4"], P13: ["p1", "p3"], P24: ["p2", "p4"], P11: ["p1", "p1"] };
    const am = (fixtures: ObservedFixture[], finalRanks: string[] | null = ["A", "B", "C", "D"]) => stage({
      kind: "americano", field: ["A", "B", "C", "D"], persons, fixtures,
      complete: { status: 200, code: null, completed: true, finalRanks, seedProposal: null },
    });
    it("empty case first: no round played fails on checked 0", () => {
      expect(evaluateInvariant(I10, run([am([])]))).toMatchObject({ verdict: "fail", checked: 0 });
    });
    it("two rounds, each person once per round, everyone plays — passes", () => {
      const r = evaluateInvariant(I10, run([am([fx({ roundNo: 1, home: "P12", away: "P34", outcome: win("P12") }), fx({ roundNo: 2, home: "P13", away: "P24", outcome: win("P24") })])]));
      expect(r.verdict).toBe("pass");
    });
    it("a person seated twice in one round fails naming the round and the person", () => {
      const r = evaluateInvariant(I10, run([am([fx({ roundNo: 1, home: "P12", away: "P13", outcome: win("P12") })])]));
      expect(r.evidence.join(" ")).toMatch(/round 1: p1 seated 2×/);
    });
    it("a field person who never plays fails", () => {
      const r = evaluateInvariant(I10, run([am([fx({ roundNo: 1, home: "P12", away: "P13", outcome: win("P12") })])]));
      expect(r.evidence.join(" ")).toMatch(/p4 never played/);
    });
    it("finalRanks: each active individual entrant once, nothing outside the field", () => {
      const ok = [fx({ roundNo: 1, home: "P12", away: "P34", outcome: win("P12") })];
      expect(evaluateInvariant(I10, run([am(ok, ["A", "B", "C"])])).evidence.join(" ")).toMatch(/D not ranked/);
      expect(evaluateInvariant(I10, run([am(ok, ["A", "B", "C", "D", "P12"])])).evidence.join(" ")).toMatch(/P12 ranked but not in the field/);
    });
  });
  ```
  The I10 finalRanks tests follow Task 8 Step 0's finding about what `finalRanks` holds. If Step 0 found pair entrants, the last test is rewritten to "each ranked id is a pair entrant seated in this stage, with no duplicates", and I10's `description` says so. The `CompleteObs` literals carry `seedProposal` (Task 6).

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
  ```ts
  import { generateDoubleElim, generatePagePlayoff, generateStepladder } from "@seazn/engine/scheduling";

  /** Ruling 45: the terminal final is the engine's own isFinal fixture for
   *  this bracket shape — never a key table typed here. */
  export function terminalFinalKeys(kind: string, field: readonly string[], config: Record<string, unknown>): readonly string[] {
    const finals = (fx: readonly { id: string; isFinal?: boolean }[]) => fx.filter((f) => f.isFinal === true).map((f) => f.id);
    switch (kind) {
      case "page_playoff": return finals(generatePagePlayoff({ entrants: [...field] }).fixtures);
      case "stepladder": return finals(generateStepladder({ entrants: [...field] }).fixtures);
      case "double_elim": return finals(generateDoubleElim({ entrants: [...field], bracketReset: config.bracketReset === true }).fixtures);
      default: throw new Error(`invariants: '${kind}' has no structural final (knockout keeps the unbeaten rule)`);
    }
  }
  ```
  In I2's loop, after the permutation block:
  ```ts
  if (s.kind !== "knockout" && s.field.length > 0) {
    checked++;
    const keys = terminalFinalKeys(s.kind, s.field, s.config);          // engine order: gf before gf-reset
    const played = keys.map((k) => s.fixtures.find((f) => f.extKey === k)).filter((f): f is ObservedFixture => f !== undefined && winnerOf(f.outcome) !== null);
    const terminal = played.at(-1);
    if (terminal === undefined) fails.push(`no decided fixture carries a terminal final key (${keys.join(" / ")})`);
    else if (ranks[0] !== winnerOf(terminal.outcome)) fails.push(`rank 1 is ${ranks[0] ?? "nobody"}, the ${terminal.extKey} winner is ${winnerOf(terminal.outcome)}`);
  }
  ```
  `I9` and `I10` follow the `InvariantSpec` shape exactly (`abstainOn: ["cut_short"]`, `requiresCompletedStage: true` for I9 and `false` for I10, whose per-round check needs no completion). They report `checked` per entrant, per round and per person, and return through `result(fails, checked)`, so `evaluateInvariant`'s R25 guard applies.

  Their failure texts are the ones the tests match:
  - I9:
    - `no decided challenge on the ladder`;
    - `<e> not ranked` / `<e> ranked N×` (active entrants only; `run.withdrawal?.entrantId` is exempt from "not ranked", and a withdrawn entrant still RANKED is not a failure either: the product keeps its rung, a W7 note from Task 7, ruling 53);
    - `<id> ranked but not in the field`;
    - `finalRanks differ from ladder_order: …`.
  - I10:
    - `round <n>: <person> seated N×`;
    - `<person> never played`, over the persons of the field entrants, from `s.persons`. On a TEAM sport a field entrant's persons are its whole roster (`setup.persons`, Task 5), and the product seats one member per team (false premise 10), so this item is judged per ENTRANT there: `<entrant> never played` when none of its persons sat in any decided fixture. The one-member-per-team shape is the W7 note Task 8 writes, not an I10 red (plan review 1 I-2). A test pins both forms: individual `A` with person `p1` unseated reds "p1 never played"; team `T` with roster `[p1, p2, p3]` where only `p2` played passes, and where none played reds "T never played";
    - the same three rank texts as I9, over the individual field.

  Append both to `INVARIANTS`. `STEP_INVARIANTS` is unchanged (both are `stepSafe: false`).

  Step 0 of Task 9: read how the product ends a double elim whose upper-bracket champion won `gf`, when `bracketReset` is on. Is `gf-reset` never created, voided, or left `scheduled`? If it is left open, `loopBounded` reds it, which is a product finding (→ W6), not an I2 change.
- [ ] **Step 4: PASS** (`invariants.test.ts`, `scenarios.test.ts`, `ladder-loop.test.ts`, `americano-loop.test.ts`).
- [ ] **Step 5: Mutation:**
  - `played.at(-1)` → `played[0]` → killed by "the reset's winner, not gf's";
  - I2's structural branch restricted to `page_playoff` → killed by the `it.each` stepladder/double_elim "fails by name";
  - I9 drops the `ranks = ladder_order` item → killed by "ranks ≠ order fail";
  - I10's per-round uniqueness skipped → killed by "a person seated twice".
- [ ] **Step 6: tsc + eslint; commit** `feat(matrix): I2 structural champion on DE/stepladder/page playoff; I9 ladder; I10 americano (W1-driving T9, ruling 45)`.

---

## Task 10: Cricket — the tie outcome and the two-innings `test` streams (ruling 44)

**Why:**
- 24 variant cases are unscorable because the generator refuses `inningsPerSide 2` (`cricket.ts:42-44`).
- 14 M5 cells are dropped as a harness gap because no generator emits a tie (`applicability.ts:300-303`).

Ruling 44 gives both to W1-driving and strikes them from W2.

**Files:**
- Modify:
  - `scripts/matrix/lib/streams/types.ts` (`RequestedOutcome` tie; `ALL_OUTCOMES` 7; `outcomeLabel`; `SportStreamGenerator.tied?`);
  - `streams/cricket.ts`, `streams/index.ts`, `streams/known-unsupported.ts`;
  - `lib/applicability.ts` (M5 `gap` deleted);
  - `lib/counts.ts` (D5: `generatorUnsupported.routedTo` → `routeTo("W2", "generator breadth")`);
  - `catalogue/{variants,drop-list,floors,counts,l2-pairs}.json` (regenerated);
  - `_INDEX.md` "W2 checklist" (strike the two cricket lines, citing ruling 44; that section only).
- Test:
  - `streams.test.ts` (`:240-253` sweep);
  - `fold.test.ts:135` (re-pinned: seven outcomes, named);
  - `applicability.test.ts:49,302`;
  - `committed-catalogue.test.ts:319-333,405`;
  - `variants.test.ts`, `probe-set.test.ts:34`, `pairs.test.ts:123`, `results.test.ts:128,131` (each wherever the 24 / 14 / W1-driving are pinned; re-pin by `rtk proxy grep -anr "W1-driving\|twoInnings\|harness-gap" scripts/matrix/__tests__`).

**Interfaces:**
- Produces:
  - `RequestedOutcome |= { kind: "tie" }`;
  - `SportStreamGenerator.tied?(req: StreamRequest): StreamEvent[]`;
  - `TEST_BALLS = 540` (a fixed per-innings legal-ball count, because `ballsPerInnings` is null for `test`);
  - `generateStream` throws `OutcomeUnreachable` for a tie on a sport without `tied`, or where the fold would not end level (a limited-overs `superOver: true`).

- [ ] **Step 0: Pin the engine** (`packages/engine/src/sports/cricket/cricket.ts`):
  - the summary schema (`:226-238`: `runs`, `wickets`, `legalBalls`, `declared?`, `partial?`);
  - `cricket.followon`'s payload and when it is legal (a lead ≥ `followOn.lead`, after the second innings);
  - `cricket.match.close`'s payload for a draw;
  - how a 4-innings level aggregate folds (expected `{kind: "tie"}`);
  - how a limited-overs level score folds with `superOver: false` (tie) and `true` (a super over opens).

  Record each with its line. The shapes below are written to those facts, and the test asserts every shape by folding it through the engine.

- [ ] **Step 1: Failing tests** (`streams.test.ts`). List the empty case first: a `test` cfg with every outcome.
  ```ts
  describe("cricket two-innings and tie (ruling 44, D4)", () => {
    const testCases = () => readVariantsFile().sports.find((s) => s.sport === "cricket")!.cases.filter((c) => c.preset === "test");
    it("the 24 committed test-preset cases each fold every reachable outcome to the requested result — counted", () => {
      let folded = 0;
      const cases = testCases();
      expect(cases.length).toBe(24);
      for (const vc of cases) {
        const cfg = resolveSportCfg("cricket", "test", vc.overrides);
        for (const stageKind of ["league", "knockout"] as const) {
          for (const outcome of ALL_OUTCOMES.filter((o) => o.kind === "win" || o.kind === "draw" || o.kind === "tie")) {
            const req = { sportKey: "cricket", cfg, stageKind, home: "h", away: "a", outcome };
            let events: StreamEvent[];
            try { events = generateStream(req); } catch (e) {
              expect(e, `${vc.id} ${stageKind} ${outcomeLabel(outcome)}`).toBeInstanceOf(OutcomeUnreachable);
              expect(outcome.kind === "draw" && !drawsAllowed("cricket", cfg, stageKind), `${vc.id}: only a refused draw may be unreachable here`).toBe(true);
              continue;
            }
            expect(matchesRequest(req, foldStream(sportModule("cricket"), cfg, "h", "a", events).outcome), `${vc.id} ${stageKind} ${outcomeLabel(outcome)}`).toBe("match");
            folded++;
          }
        }
      }
      expect(folded).toBeGreaterThan(cases.length * 2);
    });
    it("win-home uses the follow-on only where the cfg enables it; the by-runs shape otherwise folds to the same winner", () => {
      const on = resolveSportCfg("cricket", "test");
      const off = resolveSportCfg("cricket", "test", { followOn: { enabled: false } });
      const ev = (cfg: unknown) => generateStream({ sportKey: "cricket", cfg, stageKind: "league", home: "h", away: "a", outcome: { kind: "win", winner: "home" } });
      expect(ev(on).some((e) => e.type === "cricket.followon")).toBe(true);
      expect(ev(off).some((e) => e.type === "cricket.followon")).toBe(false);
    });
    it("tie: limited overs folds level with superOver off, is unreachable with it on; a sport with no tied() is unreachable", () => {
      const t20 = resolveSportCfg("cricket", "t20");
      const req = (cfg: unknown, sportKey = "cricket") => ({ sportKey, cfg, stageKind: "league" as const, home: "h", away: "a", outcome: { kind: "tie" } as const });
      expect(foldStream(sportModule("cricket"), t20, "h", "a", generateStream(req(t20))).outcome?.kind).toBe("tie");
      expect(() => generateStream(req({ ...(t20 as object), superOver: true }))).toThrow(OutcomeUnreachable);
      expect(() => generateStream(req(resolveSportCfg("badminton", offlineBuilderDefault("badminton")), "badminton"))).toThrow(OutcomeUnreachable);
    });
    it("KNOWN_UNSUPPORTED is empty (ruling 44)", () => { expect(KNOWN_UNSUPPORTED).toEqual([]); });
  });
  ```
  The old sweep's `twoInnings` branch (`:240-253`) is deleted with it. Every cricket variant now folds, and `folded/2 === cases.length` over the win outcomes. `applicability.test.ts:302` flips to `toContain("tie")`. The M5 witness expectations follow from the regen: re-pin them from the committed drop list after Step 4, never by hand.

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** in `cricket.ts`:
  ```ts
  /** A fixed legal-ball count per innings for the `test` preset, whose
   *  ballsPerInnings is null (no over limit): 90 overs × 6. Any value the
   *  summary schema accepts serves; the fold never reads it as a limit. */
  export const TEST_BALLS = 540;

  function twoInnings(req: DecidedRequest, allOut: number): StreamEvent[] {
    const cfg = req.cfg as { followOn?: { enabled?: boolean; lead?: number } };
    const s = (runs: number, wickets: number, extra: Record<string, unknown> = {}) => ({ type: SUMMARY, payload: { runs, wickets: Math.min(wickets, allOut), legalBalls: TEST_BALLS, ...extra } });
    if (req.outcome.kind === "draw") {
      return [START, s(300, 10), s(250, 10), s(200, 5, { declared: true }), s(100, 3, { partial: true, legalBalls: 120 }), { type: "cricket.match.close", payload: MATCH_CLOSE_DRAW }];
    }
    if (req.outcome.winner === "home") {
      const lead = cfg.followOn?.lead ?? Number.POSITIVE_INFINITY;
      return cfg.followOn?.enabled === true && 300 >= lead
        ? [START, s(500, 10), s(200, 10), { type: "cricket.followon", payload: FOLLOW_ON_PAYLOAD }, s(150, 10)]
        : [START, s(300, 10), s(250, 10), s(200, 10), s(200, 10)];      // home 500 v away 450: by 50 runs
    }
    return [START, s(250, 10), s(300, 10), s(200, 10), s(151, Math.min(3, allOut - 1))];   // target 151: away by wickets
  }

  export const cricketGenerator: SportStreamGenerator = {
    sportKeys: ["cricket"],
    decided(req) {
      const cfg = req.cfg as CricketCfg;
      const allOut = declaredAllOut(sportModule(req.sportKey).padSpec?.(req.cfg));
      if (cfg.inningsPerSide === 2) return twoInnings(req, allOut);
      if (cfg.inningsPerSide !== 1) throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), `inningsPerSide ${cfg.inningsPerSide}`);
      if (req.outcome.kind === "draw") throw new GeneratorUnsupported(req.sportKey, "draw", "limited-overs cricket has no draw");
      /* the existing limited-overs body, unchanged */
    },
    tied(req) {
      const cfg = req.cfg as CricketCfg & { superOver?: boolean };
      const allOut = declaredAllOut(sportModule(req.sportKey).padSpec?.(req.cfg));
      const w = (n: number) => Math.min(n, allOut);
      if (cfg.inningsPerSide === 2) {
        const s = (runs: number) => ({ type: SUMMARY, payload: { runs, wickets: w(10), legalBalls: TEST_BALLS } });
        return [START, s(250), s(200), s(200), s(250)];                  // 450 v 450
      }
      if (cfg.superOver === true) throw new OutcomeUnreachable(req.sportKey, "tie", "superOver is on: a level score opens a super over");
      const B = cfg.ballsPerInnings;
      return [START, { type: SUMMARY, payload: { runs: 150, wickets: w(5), legalBalls: B } }, { type: SUMMARY, payload: { runs: 150, wickets: w(5), legalBalls: B } }];
    },
  };
  ```
  `MATCH_CLOSE_DRAW` and `FOLLOW_ON_PAYLOAD` are the payload literals pinned at Step 0, each with its engine line in a comment. `index.ts`, in `generateStream`, before the decided call:
  ```ts
  if (o.kind === "tie") {
    if (gen.tied === undefined) throw new OutcomeUnreachable(req.sportKey, label, "the sport's generator declares no level result");
    return gen.tied(req);
  }
  ```
  `matchesRequest` gains `if (o.kind === "tie") return outcome.kind === "tie" ? "match" : "mismatch";`. `DecidedOutcome` stays win/draw. `known-unsupported.ts` becomes `export const KNOWN_UNSUPPORTED: readonly … = Object.freeze([]);` with its header updated (ruling 44). In `applicability.ts`, delete M5's `gap`. The rule itself is unchanged, and `GENERATES_TIE` now reads true. `counts.ts`: D5.

- [ ] **Step 4: Regenerate the catalogue as a reviewed diff.**
  - `pnpm matrix:catalogue --write; echo EXIT=$?`. If it refuses on floors, paste the refusal, then rerun with `--accept-lower-floors` only if the lowered floors are explained below.
  - Expected:
    - `variants.json`: the 24 `test` cases' `scorable` goes to null (scorable);
    - `drop-list.json`: the 14 M5 `harness-gap` drops are gone, and the 3 M5 `unscorable-only` ladder-family drops re-decide (paste what they became);
    - `floors.json`: floors RISE;
    - `counts.json`: `generatorUnsupported.count` 0, `routedTo: "W2"`;
    - `l2-pairs.json`: run 514's `l3Gap` mark is gone (W1d first-tasks item 4's premise; Task 16 records it). **Only `l3Gap` fields may change** (ruling 50).
  - **The `l3Gap`-only check** (ruling 50), mechanical, run from the worktree after the regen:
    ```bash
    cd <worktree> && git show HEAD:scripts/matrix/catalogue/l2-pairs.json > "$TMPDIR/w1drv-l2-t10-before.json" && node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),b=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));const strip=r=>{const{l3Gap,...rest}=r;return JSON.stringify(rest)};const sameLen=a.runs.length===b.runs.length;const otherDiffs=sameLen?a.runs.filter((r,i)=>strip(r)!==strip(b.runs[i])).map(r=>r.n):["length "+a.runs.length+"→"+b.runs.length];const gapChanged=sameLen?a.runs.filter((r,i)=>JSON.stringify(r.l3Gap)!==JSON.stringify(b.runs[i].l3Gap)).map(r=>({n:r.n,from:r.l3Gap,to:b.runs[r.n-1].l3Gap})):[];const topSame=JSON.stringify({w:a.widths,t:a.targets})===JSON.stringify({w:b.widths,t:b.targets});console.log(JSON.stringify({before:a.runs.length,after:b.runs.length,otherDiffs,gapChanged,topSame}))' "$TMPDIR/w1drv-l2-t10-before.json" scripts/matrix/catalogue/l2-pairs.json; echo EXIT=$?
    ```
    Green means ALL of: `after == before`; `otherDiffs` is `[]` (no run's scenario, row, sport, preset, bound, width, `covers` or `n` moved); `topSame` is true; `gapChanged` is **non-empty** (zero changed is vacuous: the M5 lift did not reach the pairs) and every entry has `to: null` and a `from` naming the M5 tie gap (run 514 among them). Paste the JSON line.
  - **Stop condition:** any `otherDiffs`, a length change, `topSame` false, or a `gapChanged` entry whose `to` is not null. For example, if the 3 re-decided M5 `unscorable-only` drops become owed L2 picks, the pair plan grows and renumbers; that is NOT the change ruling 50 allowed for Task 10. Do not commit; report the JSON line to the controller for an owner call.
  - No permanent test pins this one-off diff (it would freeze it forever). The pasted JSON line is the evidence, and `committed-plans-frozen.test.ts` in Step 5 guards the committed runs.
- [ ] **Step 5: PASS.** Files: `streams.test.ts`, `fold.test.ts`, `applicability.test.ts`, `committed-catalogue.test.ts`, `variants.test.ts`, `probe-set.test.ts`, `pairs.test.ts`, `results.test.ts`, `committed-plans-frozen.test.ts`, `scenario-catalogue.test.ts` (the guard: `counts.json` no longer names W1-driving). Then `pnpm matrix:catalogue --check` → 0.
- [ ] **Step 6: Mutation:**
  - the 4th tie innings 251 → killed by the tie fold (win, not tie);
  - win-home always uses the follow-on → killed by the `followOn.enabled: false` case (the engine refuses a follow-on it does not allow; paste the error);
  - `tied` ignores `superOver` → killed by the unreachable assertion;
  - `matchesRequest` tie arm → `"match"` → killed by the sweep with a mutated shape (4th innings 249 folds to a home win, and the sweep reds).
- [ ] **Step 7: tsc + eslint; commit** `feat(matrix): cricket tie and two-innings test streams; M5 gap and KNOWN_UNSUPPORTED emptied (W1-driving T10, ruling 44, D4, D5)`.

---

## Task 11: In-process workers — `--workers N` (ruling 46)

**Why:** 937 cases in sequence is hours (the W1c slice ran ~1 case/min at full length). Ruling 46: N workers against one server and DB, each with its own sign-in, session and jar, with results in plan order.

**Files:**
- Create: `scripts/matrix/lib/workers.ts`, `scripts/matrix/__tests__/workers.test.ts`
- Modify: `scripts/matrix/run.ts` (`parseCli` `--workers`; `USAGE`; `execute`, where one sign-in becomes one per worker; `RunResults` gains `workers: number` in the run header if `results.ts`'s strict schema allows an optional field, else a note line; see Step 0).
- Test: `workers.test.ts`, `run-cli.test.ts`, `results.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export async function runQueue<W, T, R>(items: readonly T[], workers: number, open: (n: number) => Promise<W>, run: (w: W, item: T, index: number) => Promise<R>, crashed: (item: T, index: number, error: unknown) => R): Promise<R[]>;
  export class WorkersOutOfRange extends Error {}
  export const MAX_WORKERS = 8;
  ```

- [ ] **Step 0: Pin.**
  - `run.ts` `execute`: every place the single `session` is read. `prepareCaseOrg(session, …)` switches the active org on that session's jar (`seed-org.ts:136-147`), and `deps.driverFor(base, session, orgId)`.
  - `results.ts` `RunResultsSchema`: whether a run-level `workers` field is allowed. If the schema is strict and v3 is committed, add it as optional under v3 with a `parseResults` test that v3 files without it still read.
  - Live, on the Task 11 Step 7 env: sign in twice as the same owner email, switch org on session A, and read the active org on session B. It must be unchanged. This is ruling 46's premise; if false, stop and report.

- [ ] **Step 1: Failing tests** (`workers.test.ts`). List the empty case first: no items.
  ```ts
  it("empty case first: no items opens no worker and returns []", async () => {
    let opened = 0;
    expect(await runQueue([], 4, async () => { opened++; return {}; }, async () => 1, () => 0)).toEqual([]);
    expect(opened).toBe(0);
  });
  it("results land in plan order whatever finishes first", async () => {
    const delays = [30, 5, 20, 1, 10];
    const out = await runQueue(delays, 3, async (n) => n, async (_w, d, i) => { await new Promise((r) => setTimeout(r, d)); return i; }, () => -1);
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });
  it("each worker opens once and is reused; never more workers than items", async () => {
    const opened: number[] = [];
    await runQueue([1, 2], 5, async (n) => { opened.push(n); return n; }, async () => 0, () => -1);
    expect(opened.sort()).toEqual([0, 1]);
  });
  it("a crash keeps every other index in place and is recorded at its own", async () => {
    const out = await runQueue(["a", "boom", "c"], 2, async () => null, async (_w, x) => { if (x === "boom") throw new Error("x"); return x; }, (x, i) => `crashed ${x}@${i}`);
    expect(out).toEqual(["a", "crashed boom@1", "c"]);
  });
  it("workers outside 1..MAX_WORKERS are refused by name", async () => {
    await expect(runQueue([1], 0, async () => 0, async () => 0, () => 0)).rejects.toBeInstanceOf(WorkersOutOfRange);
    await expect(runQueue([1], MAX_WORKERS + 1, async () => 0, async () => 0, () => 0)).rejects.toBeInstanceOf(WorkersOutOfRange);
  });
  ```
  In `run-cli.test.ts`, with the injected `RunDeps`:
  - `--workers 3` over 7 planned cases calls `signIn` exactly 3 times;
  - each case's `driverFor` receives the session of the worker that ran it;
  - `results.cases[i].caseId` equals the plan's `i`-th id;
  - a case whose fake driver throws `OrgMismatch` is that case's error, and the other cases are unaffected;
  - `--driver browser --workers 2` is a usage error naming W1d (D10);
  - `--workers 1` is byte-identical to today's single-sign-in run (the existing run-cli snapshot tests stay green unchanged).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** `workers.ts`:
  ```ts
  // Ruling 46: N in-process workers against ONE server and DB. Each worker is
  // opened once (its own sign-in, session and jar) and pulls the next plan
  // item off a shared cursor; results are stored by plan index, so the order
  // of results.json never depends on which worker was fastest.
  export const MAX_WORKERS = 8;
  export class WorkersOutOfRange extends Error {
    constructor(n: number) { super(`workers: ${n} is outside 1..${MAX_WORKERS}`); this.name = "WorkersOutOfRange"; }
  }
  export async function runQueue<W, T, R>(items: readonly T[], workers: number, open: (n: number) => Promise<W>, run: (w: W, item: T, index: number) => Promise<R>, crashed: (item: T, index: number, error: unknown) => R): Promise<R[]> {
    if (!Number.isInteger(workers) || workers < 1 || workers > MAX_WORKERS) throw new WorkersOutOfRange(workers);
    const out = new Array<R>(items.length);
    let next = 0;
    const lane = async (n: number): Promise<void> => {
      const w = await open(n);
      for (let i = next++; i < items.length; i = next++) {
        try { out[i] = await run(w, items[i]!, i); } catch (e) { out[i] = crashed(items[i]!, i, e); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, items.length) }, (_, n) => lane(n)));
    return out;
  }
  ```
  `MAX_WORKERS = 8` is the local-env bound: the prod DB budget note is 60 connections, and each worker's cases open requests serially. W1d may raise it inside a shard. `execute`'s sequential `for` becomes `runQueue(items, cli.workers, (n) => deps.signIn(base, owner), (session, item, i) => runOne(session, item, i), (item, i, e) => crashResult(item, i, e))`. `runOne` is today's loop body with `session` as a parameter. Browser runs keep `workers === 1` (D10).
- [ ] **Step 4: PASS** (`workers.test.ts`, `run-cli.test.ts`, `results.test.ts`, `strip-types-loadable.test.ts`).
- [ ] **Step 5: Mutation:**
  - `out.push(...)` instead of `out[i] =` → killed by "plan order";
  - one shared `open()` for all lanes → killed by "signIn exactly 3 times";
  - drop the `try` → killed by "a crash keeps every other index".
- [ ] **Step 6: tsc + eslint; commit** `feat(matrix): in-process workers, one session each, results in plan order (W1-driving T11, ruling 46, D10)`.
- [ ] **Step 7: Live proof** (a fresh env per the skill; Step 0's two-session premise first):
  - `pnpm matrix:l3 --workers 1 --run-id w1drv-t11-w1; echo EXIT=$?`, then `pnpm matrix:l3 --workers 3 --run-id w1drv-t11-w3; echo EXIT=$?`. Both use the default slice (24 cases).
  - Diff the two `results.json` case lists (ids and states): identical, and in plan order.
  - Paste both wall-clock times.

---

## Task 12: The planner — the `w1-driving` set, and `--only` on any catalogue cell

**Why:** No CLI path plans a multi-stage, ladder-family or team cell today. `--only` admits the 6 slice cells only (`slice.ts:44-48`). Ruling 48's evidence needs all 231 cells × 4 scenarios plus the 24 `test` cases.

**Files:**
- Create: `scripts/matrix/lib/w1-driving-set.ts`, `scripts/matrix/__tests__/w1-driving-set.test.ts`
- Modify: `scripts/matrix/run.ts` (`SETS["w1-driving"]`; the slice planner's `--only` falls through to a catalogue cell; `USAGE`), `lib/slice.ts` (`checkSliceFilter` keeps slice semantics; the new `checkCellFilter` admits `ROW_KEYS × SPORT_KEYS`), `lib/probe-set.ts` (the `:36-39` comment only, m-8).
- Test: `w1-driving-set.test.ts`, `run-cli.test.ts`, `slice.test.ts`, `committed-plans-frozen.test.ts` (unchanged: the slice planner's slice-cell output must not move).

**Interfaces:**
- Produces:
  ```ts
  export const W1_DRIVING_SET = "w1-driving";
  export const W1_DRIVING_SCENARIOS: readonly ["LIFECYCLE", "M1", "R4", "F1"];
  export function planW1Driving(variantFor: (sport: string) => string, filter: { only?: string; scenario?: string }, deps?: { drops?: () => DropIndex; variants?: () => VariantsFile }): CaseSpec[];
  export function checkCellFilter(only: string): { row: RowKey; sport: string };   // UnknownFilter otherwise
  ```

- [ ] **Step 1: Failing tests.** List the empty case first: a filter matching nothing.
  ```ts
  it("empty case first: --only naming no catalogue cell is UnknownFilter, never an empty plan", () => {
    expect(() => planW1Driving(variantFor, { only: "nope|generic" })).toThrow(UnknownFilter);
  });
  it("plans every applicable (cell, scenario) of the four scripts plus the cricket test cases — the count DERIVED from the committed drop list", () => {
    const drops = readDropIndex();
    const atomOf = { LIFECYCLE: LIFECYCLE_ID, M1: "M1", R4: "R4a", F1: "F1" } as const;
    let expected = 0;
    for (const row of ROW_KEYS) for (const sport of SPORT_KEYS) for (const s of W1_DRIVING_SCENARIOS) if (!drops.has(atomOf[s], row, sport)) expected++;
    const testCases = readVariantsFile().sports.find((x) => x.sport === "cricket")!.cases.filter((c) => c.preset === "test" && c.scorable === null).length;
    const plan = planW1Driving(variantFor, {});
    expect(testCases).toBe(24);
    expect(plan.length).toBe(expected + testCases);
    expect(plan.length).toBe(937);  // 231×4 − 11 (F1 page_playoff_only, Task 2) + 24 — the typed pin must equal the derivation
    expect(new Set(plan.map((c) => c.caseId)).size).toBe(plan.length);
  });
  it("plan order is row × sport × scenario, then the variant cases — stable across calls", () => {
    expect(planW1Driving(variantFor, {}).map((c) => c.caseId)).toEqual(planW1Driving(variantFor, {}).map((c) => c.caseId));
  });
  it("--only a non-slice cell plans that cell's four scenarios (and its test cases if cricket); --scenario narrows", () => {
    expect(planW1Driving(variantFor, { only: "league_ko|football" }).map((c) => c.scenario)).toEqual(["LIFECYCLE", "M1", "R4", "F1"]);
    expect(planW1Driving(variantFor, { only: "page_playoff_only|generic" }).map((c) => c.scenario)).toEqual(["LIFECYCLE", "M1", "R4"]);
    expect(planW1Driving(variantFor, { only: "league|cricket", scenario: "LIFECYCLE" }).filter((c) => c.variant === "test").length).toBe(3);
  });
  it("the slice planner's slice-cell output is unchanged (committed plans stay frozen)", () => {
    const cases = slicePlanner({ only: "league|generic" }).plan(variantFor);
    expect(cases.map((c) => c.caseId)).toEqual(["LIFECYCLE", "M1", "R4", "F1"].map((s) => `league|generic|${variantFor("generic")}|${s}`));
  });
  ```
  The `league|cricket` count of 3 comes from facts: league holds 3 `test` cases. Derive it in the test from `variants.json` rather than typing it; the literal above is the value that derivation must equal.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** `w1-driving-set.ts`:
  - For each `row` of `ROW_KEYS`, `sport` of `SPORT_KEYS` and scenario of `W1_DRIVING_SCENARIOS`: skip if the committed drop list drops `(atom, row, sport)`. Otherwise push `{caseId: \`${row}|${sport}|${v}|${s}\`, row, sport, variant: v, scenario: s, canary: false}`, with `v = variantFor(sport)`.
  - Then for each scorable cricket `test` variant case, push `{caseId: \`${vc.row}|cricket|test|LIFECYCLE|${vc.id}\`, row: vc.row, sport: "cricket", variant: "test", scenario: "LIFECYCLE", canary: false, overrides: vc.overrides}`, exactly `probe-set.ts`'s variant shape.
  - `requireScorable` guards each one (a case the committed file marks unscorable is refused by name).
  - `DropIndex` reads `drop-list.json`'s `groups[].cells` (`{row: sport[]}`) keyed by `scenario`.

  `run.ts`:
  - `SETS["w1-driving"]` maps to a `PlanCases` that, unlike the other sets, ACCEPTS `--only` and `--scenario` (it does not throw `SetTakesNoFilter`).
  - `sports` = `SPORT_KEYS` (every builder variant order is read once from the DB).
  - The default slice planner, given an `--only` that `checkSliceFilter` rejects but `checkCellFilter` accepts, plans through `planW1Driving` restricted to that cell. A slice cell plans exactly as today.

  **The `probe-set.ts` orphan (plan review 1, m-8; facts-A item 18).** `scripts/matrix/lib/probe-set.ts:36-39` says the probe's API-only rows are "single-stage (a multi-stage row needs seed-proposal handling, deferred to W1-driving)", and `:58` enforces it (re-pinned at plan review 2, m-8) (`isApi.has(row) && stages.length === 1`), which leaves out `group_group_ko`, the one multi-stage row in `API_ONLY_ROWS` (`catalogue.ts:27-29`). Decision: **the exclusion stays, the comment changes.** `w1b-probe` is W1b's committed probe set; re-planning it would change what a re-run of that set means, while the `w1-driving` set (this task) already plans `group_group_ko` × every sport × the four scenarios. So:
  - reword the `probe-set.ts:36-39` comment to: "single-stage only: `w1b-probe` is W1b's frozen probe; the multi-stage API-only row (`group_group_ko`) is driven by the `w1-driving` set (`lib/w1-driving-set.ts`), which W1-driving added" — the comment no longer names W1-driving as a deferral, so the Task 1 guard has nothing to route;
  - add to `w1-driving-set.test.ts`: "every API-only row the probe set leaves out is planned by the w1-driving set, counted": for each row of `API_ONLY_ROWS` not in `probeRows().api`, assert `planW1Driving(variantFor, {})` holds at least one LIFECYCLE case on it; the count of such rows is asserted `> 0` (today 1, `group_group_ko`) so the test cannot pass on an empty difference;
  - `probe-set.test.ts` is unchanged (its pins on the api list still hold).
  Mutant: `planW1Driving` skips API-only rows → killed by the new test.
- [ ] **Step 4: PASS** (`w1-driving-set.test.ts`, `run-cli.test.ts`, `slice.test.ts`, `probe-set.test.ts`, `committed-plans-frozen.test.ts`, `committed-matrix.test.ts`).
- [ ] **Step 5: Mutation:**
  - ignore the drop list → killed by the derived count;
  - drop the variant cases → killed by `+ testCases`;
  - `--only` outside the slice still throws → killed by the `league_ko|football` test.
- [ ] **Step 6: tsc + eslint; commit** `feat(matrix): the w1-driving set and --only on any catalogue cell (W1-driving T12)`.
- [ ] **Step 7: First live contact per capability** (the cells owed by Task 6 Step 9, plus one per later capability). On a fresh env, run each `pnpm matrix:l3 --only <cell> --scenario <S> --run-id w1drv-t12-<n>; echo EXIT=$?`. The cells are:
  - `league_ko|badminton` LIFECYCLE;
  - `group_group_ko|generic` LIFECYCLE;
  - `ko_plate|generic` F1 (predicted product red → W4: `409 STAGE_COMPLETED_SEEDING_FAILED` after stage 1 has committed complete, `CompleteObs.completed = false`, never retried; the full shape is in Task 6 Step 9, m-6);
  - `league|football` LIFECYCLE (rosters);
  - `ladder|generic` R4;
  - `americano|badminton` LIFECYCLE;
  - `mexicano|generic` M1 (predicted `mexicano-stalled-on-non-decided` → W7, false premise 14);
  - `americano|football` LIFECYCLE (predicted: generates on one arbitrary roster member per team → W7 finding, false premise 10; zero lineups PUT);
  - `page_playoff_only|tennis` LIFECYCLE;
  - `double_elim|generic` LIFECYCLE (I2 structural);
  - `league|cricket|test` one variant case.

  Paste the state and failing check ids of each. A harness-caused ❌ goes back to its owning task, fixed with a failing test first, before Task 13.

---

## Task 13: Browser — the setup filler live, L1 proof at 1280 per capability, the two template cells through their cards

**Why:** Ruling 47. Rosters, seed confirm and challenges are HTTP filler, which `BrowserDriver` already delegates (Tasks 3, 6, 7, 8). This task proves it live on one L1 cell per new capability, drives the two template-only cells through the gallery, and retires the last W1-driving routes.

**Files:**
- Modify:
  - `scripts/matrix/lib/driver/types.ts` (`createFromTemplate`);
  - `http-driver.ts`, `browser-driver.ts` (the template card path via the page objects; `#judgeApiOnlyPath` no longer abstains on a template cell);
  - `lib/browser/pages/competition.ts` (a `createFromTemplateUi(key)` page action: `/o/<org>/c/new` → `template-card-<key>` → the detail sheet CTA → wait on the product's `POST /api/v1/competitions/from-template` answer);
  - `lib/api-only-ui.ts` (`TEMPLATE_DRIVING` and `TEMPLATE_ONLY_CELLS` removed; `apiOnlyUiPath` answers the template path as reachable);
  - `lib/scenarios/types.ts` (`CaseSpec.template?: string`);
  - `lib/scenarios/common.ts` (template branch in `setUpDivision`; `DRIVING_ROUTE`/`DRIVING_WAVE` deleted);
  - `lib/field-size.ts` (`fieldSizeFor(row, scenario, template?)`: the template's `entrantCount`, D11);
  - `lib/layers.ts` (`--set w1-driving-l1`);
  - `lib/browser/selectors.ts` (the template testids, text-pinned).
- Test:
  - `browser-driver.test.ts`, `page-objects.test.ts`, `selectors.test.ts`, `layers.test.ts`, `field-size.test.ts`;
  - `scenarios.test.ts` (`:991-998`: the ruling-28 `DRIVING_WAVE` pin is deleted, because the constant is gone);
  - `scenario-catalogue.test.ts` (the guard now reads no W1-driving route anywhere).

**Interfaces:**
- Produces:
  ```ts
  export interface FromTemplateOut { readonly competition: CompetitionRef; readonly division: DivisionRef; readonly stages: readonly StageRef[] }
  createFromTemplate(key: string, input: { name: string; endsOn: string }): Promise<FromTemplateOut>;
  export function templateField(key: string): { sport: string; variant: string; entrantKind: string; entrantCount: number; stageKinds: readonly string[] };  // read from server/templates/catalog/<key>.json as text
  export const W1_DRIVING_L1_SET = "w1-driving-l1";
  ```

- [ ] **Step 0: Pin.**
  - `template-gallery.tsx:242` (the card), the detail sheet's CTA control (testid or en accessible name, text-pinned as W1c D4 does);
  - `FromTemplateResult` (`schemas.ts:1206+`);
  - that the from-template usecase creates NO entrants (`usecases/templates.ts:356` comment);
  - that both template JSON files still read as in the Step 0 anchors table.

  Also decide the cricket-`test`-in-browser question (D13, below).
- [ ] **Step 1: Failing tests.** Transitions: a template cell; a non-template API-only cell (still planned 🚫, ruling 43); a template whose JSON changed (a pin reds).
  ```ts
  it("templateField reads the product's catalog JSON as text: box-league and t20-super8", () => {
    expect(templateField("box-league")).toMatchObject({ sport: "badminton", variant: "short", entrantKind: "individual", entrantCount: 16, stageKinds: ["group"] });
    expect(templateField("t20-super8")).toMatchObject({ sport: "cricket", variant: "t20", entrantKind: "team", entrantCount: 16, stageKinds: ["group", "group", "knockout"] });
  });
  it("fieldSizeFor on a template cell is the template's own entrantCount (D11), which differs from the default 8", () => {
    expect(fieldSizeFor("group_only", "LIFECYCLE", "box-league")).toBe(templateField("box-league").entrantCount);
    expect(fieldSizeFor("group_only", "LIFECYCLE", "box-league")).not.toBe(fieldSizeFor("group_only", "LIFECYCLE"));
  });
  it("the w1-driving-l1 set: one cell per capability plus the two template cells, all at 1280, driven", () => {
    const cases = planW1DrivingL1(variantFor);
    expect(cases.map((c) => [identityOf(c).caseId.split("|").slice(0, 2).join("|"), c.width])).toEqual([
      ["league|football", 1280], ["groups_ko|badminton", 1280], ["ladder|generic", 1280], ["americano|badminton", 1280],
      ["mexicano|generic", 1280], ["group_only|badminton", 1280], ["group_group_ko|cricket", 1280],
    ]);
    expect(cases.every((c) => c.spec !== null)).toBe(true);
    expect(cases.filter((c) => c.spec?.template !== undefined).map((c) => c.spec!.template)).toEqual(["box-league", "t20-super8"]);
  });
  // In scenario-catalogue.test.ts, beside the guard (it reuses scanRoutes). Comments may still cite the
  // wave (commit history, plan references): the AST reader ignores them, a raw text grep would not.
  it("no route names W1-driving anywhere in the shipped harness", () => {
    const scans = shipped(resolve(REPO, "scripts/matrix")).map((f) => scanRoutes(readFileSync(f, "utf8"), f));
    expect(scans.reduce((n, s) => n + s.sites, 0)).toBeGreaterThan(0);
    expect(scans.flatMap((s) => s.waves)).not.toContain("W1-driving");
    expect(scans.flatMap((s) => s.unread)).toEqual([]);
  });
  ```
  In `browser-driver.test.ts`:
  - a template case calls `createFromTemplateUi("box-league")`, records `createCompetition` AND `createDivision` as browser actions in the mixed ledger (one organiser act creates both), never calls `postStages`, and the `organiser-ui-path` check is absent (not abstain) on the two template cells;
  - the three non-template API-only rows still plan 🚫 (ruling 43; unchanged `layers.test.ts` cases);
  - `setMembers`, `putLineup`, `confirmSeedProposal`, `challenge` and `americanoView` go to HTTP and are counted as filler.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
  - `setUpDivision`, when `ctx.spec.template` is set:
    1. `const t = await ctx.driver.createFromTemplate(ctx.spec.template, {name: \`Matrix ${ctx.spec.caseId}\`, endsOn: TEMPLATE_ENDS_ON})` (a fixed synthetic date constant, commented);
    2. `bodies` = the stages as read back, in seq order;
    3. `posted` = `{sport: t.division.sportKey, variant: t.division.variantKey, stages: <the template's stage kinds as bodies>, …}`, so `life-built-as-posted` compares against the catalog JSON (D11);
    4. entrants = `fieldSizeFor(row, scenario, template)`, with rosters for the team template;
    5. then Start, and the normal play (`playDivision`).
  - `HttpDriver.createFromTemplate` POSTs `/api/v1/competitions/from-template {template_key, name, ends_on}`, then reads the competition, division and stages back. It is used by the fakes' tests and by `BrowserDriver`'s wrapped driver for the read-back only.
  - `BrowserDriver.createFromTemplate` drives the card and resolves on the product's own response (`respond.ts` `actAndAwait`).
  - `planW1DrivingL1` (in `layers.ts`) returns the seven `DrivenLayerCase`s above at `L1_WIDTH`. The two template cells carry `template`.
  - Delete `DRIVING_ROUTE`/`DRIVING_WAVE`, `TEMPLATE_DRIVING`, `TEMPLATE_ONLY_CELLS` and the ruling-28 `DRIVING_WAVE` test. The Q-A guard now sees no W1-driving route. It stays green while the row is "in progress", and it will stay green when Task 16 flips the row to done, which is the point.
- [ ] **Step 4: PASS.** Files: `browser-driver.test.ts`, `page-objects.test.ts`, `selectors.test.ts`, `layers.test.ts`, `field-size.test.ts`, `scenarios.test.ts`, `scenario-catalogue.test.ts`, `mixed-driver.test.ts`, `boundary.test.ts`, `strip-types-loadable.test.ts`.
- [ ] **Step 5: Mutation:**
  - the template branch calls `postStages` too → killed by "never calls postStages";
  - `fieldSizeFor` ignores the template → killed by the D11 test;
  - put `TEMPLATE_DRIVING` back → killed by "no route names W1-driving";
  - the filler recorded as a browser action → killed by the filler count test.
- [ ] **Step 6: tsc + eslint; commit** `feat(matrix): browser uses the setup filler; template-only cells driven through their cards; last W1-driving routes retired (W1-driving T13, ruling 47, D11)`.
- [ ] **Step 7: Live L1 proof** (a fresh env, prod build; chromium via `pnpm exec playwright install chromium` if missing, which is an environment fault, not a red):
  - `pnpm matrix:browser --set w1-driving-l1 --run-id w1drv-l1-r1; echo EXIT=$?`, twice more as `-r2` and `-r3` (class 8: a flaky-shaped gate three times);
  - per-screen verdicts at 1280 for every captured screen, in `truth-runs/w1drv-l1/README.md` (class 11). Confirm the images exist, differ where the states differ, and were taken after the state they prove (class 10);
  - no horizontal scroll at 1280 (the existing `no-horizontal-scroll` check).

  **D13 (recommendation):** the L1 proof excludes the cricket `test` streams. W1c's cricket pad adapter declares no route for `cricket.followon`, `cricket.match.close` or a declared innings (W1c `_INDEX.md` per-adapter table). The two-innings shapes are proven over HTTP (Task 15). Routed as a W1d first-tasks line: "cricket pad adapter routes for the two-innings events, before the full L1 grid reaches `*|cricket|test`".
  - Owner value: the L1 proof stays one cell per capability that has a pad route today, and the gap is on a wave's list, not silent.
  - Rejected: writing the adapter routes here. That is pad work W1c owns the pattern for, and the full L1 grid that needs it is W1d's.

---

## Task 14: The reference model — team rosters, a Swiss-biased generator, family-routed refusals (ruling 49)

**Why:**
- The model refuses team sports (`model/state.ts:259`) and runs the slice cells only (`model.ts:175-180`).
- At the default 20 runs a Swiss cell can draw no Correct and read vacuous (W1b Task 15; `_INDEX.md` "For W1-driving").
- Its multi-stage and ladder-family refusals are plain `Error`s that name no wave.

**Files:**
- Modify:
  - `scripts/matrix/lib/model/state.ts` (`ModelUnsupported`; the team refusal removed; rosters at `newModelState`; lineups before `Score`/`Walkover` via `ensureLineups`' model twin);
  - `lib/model/commands.ts` (`modelCommands({fences, bias})`; `SWISS_BIAS`; the late-entry `AddEntrant` command carries a full roster on a team sport);
  - `model.ts` (`--cell` admits single-stage catalogue cells; a multi-stage or ladder-family cell is refused by `ModelUnsupported` naming its wave, D6);
  - `lib/model/run-cell.ts` (passes the bias for `swiss`).
- Test: `model-core.test.ts`, `model-cli.test.ts`, `model-run-cell.test.ts`, `scenario-catalogue.test.ts` (the guard reads `ModelUnsupported`, already in `DEFERRALS` since Task 1).

**Interfaces:**
- Produces:
  ```ts
  export class ModelUnsupported extends Error { readonly wave: string; readonly reason: string; constructor(wave: string, reason: string) }
  export const MODEL_FAMILY_ROUTE: Readonly<Record<string, Route>>;   // multi-stage + ladder-family rows → W3/W4/W5/W7 (D6)
  export const SWISS_BIAS: Readonly<Partial<Record<CommandKind, number>>> = { Start: 3, Generate: 3, Score: 3 };
  export function modelCommands(opts: { fences: boolean; bias?: Readonly<Partial<Record<CommandKind, number>>> }): fc.Arbitrary<…>[];
  ```

- [ ] **Step 1: Failing tests.** List the empty case first: an empty bias is today's uniform set.
  ```ts
  it("empty case first: no bias gives exactly one arbitrary per command kind (today's set)", () => {
    expect(modelCommands({ fences: true }).length).toBe(COMMAND_KINDS.length);
    expect(modelCommands({ fences: true, bias: {} }).length).toBe(COMMAND_KINDS.length);
  });
  it("SWISS_BIAS replicates Start, Generate and Score by weight; every kind still appears at least once", () => {
    const n = COMMAND_KINDS.length + (SWISS_BIAS.Start! - 1) + (SWISS_BIAS.Generate! - 1) + (SWISS_BIAS.Score! - 1);
    expect(modelCommands({ fences: true, bias: SWISS_BIAS }).length).toBe(n);
  });
  it("a swiss cell at 20 runs exercises Correct at least once (the W1b vacuous case), seed pinned", async () => {
    const out = await runModelCell({ cell: "swiss|badminton", runs: 20, seed: -1180181307, driver: new ModelFakeDriver() });
    expect(out.counts.Correct.ran).toBeGreaterThan(0);
  });
  it("team cells run: league|football plays with full rosters and a lineup per side before the first Score", async () => {
    const football = Object.keys(sportModule("football").variants as object)[0]!;
    const driver = new ModelFakeDriver();
    await runModelCell({ cell: "league|football", runs: 5, seed: 1, driver, variant: football });
    expect(driver.memberCount()).toBeGreaterThan(0);
    const posted = [...new Set(driver.calls.filter((c) => c.startsWith("postEvent ")).map((c) => c.split(" ")[1]!))];
    expect(posted.length, "fixtures the model scored").toBeGreaterThan(0);
    for (const f of posted) {
      const first = driver.calls.indexOf(`postEvent ${f}`);
      const lineups = driver.calls.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith(`putLineup ${f} `));
      expect(lineups.length, f).toBe(2);
      for (const [, i] of lineups) expect(i, f).toBeLessThan(first);
    }
  });
  it.each([["league_ko", "W5"], ["swiss_playoff", "W3"], ["ko_plate", "W4"], ["group_group_ko", "W5"], ["ladder", "W7"], ["americano", "W7"], ["mexicano", "W7"]])("%s in the model is ModelUnsupported naming %s (D6)", async (row, wave) => {
    await expect(newModelState({ driver: new ModelFakeDriver(), row: row as RowKey, sport: "generic", variant: "standard", entrants: 8, tag: "t" })).rejects.toMatchObject({ name: "ModelUnsupported", wave });
  });
  ```
  The seed `-1180181307` is W1b's recorded vacuous seed for `swiss|badminton` at 20 runs (`_INDEX.md` W1b row), so this test fails today and passes with the bias. `runModelCell` is a helper at the top of `model-run-cell.test.ts` over the real `runCell` (`lib/model/run-cell.ts:204`):
  ```ts
  const runModelCell = async (o: { cell: string; runs: number; seed: number; driver: ModelFakeDriver; variant?: string }) => {
    const [row, sport] = o.cell.split("|") as [RowKey, string];
    const variant = o.variant ?? offlineBuilderDefault(sport);
    return runCell({
      cell: o.cell, row, sport, variant, runs: o.runs, maxCommands: MODEL_DEFAULTS.maxCommands, seed: o.seed, fences: true,
      timeLimitMs: MODEL_DEFAULTS.timeLimitMs, regressions: [],
      newDriverState: async (n) => ({ model: await newModelState({ driver: o.driver, row, sport, variant, entrants: 6, tag: `t${n}` }), real: o.driver }),
    });
  };
  ```
  If the file already has an equivalent input builder, use it instead and note the name in the report.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
  - `modelCommands`:
    ```ts
    return COMMAND_KINDS.flatMap((kind) => Array.from({ length: Math.max(1, opts.bias?.[kind] ?? 1) }, () => fc.tuple(fc.nat({ max: 63 }), fc.nat({ max: 1 })).map(([k, w]) => commandOf(kind, k, w, opts.fences))));
    ```
  - `run-cell.ts` passes `bias: m.stageKind === "swiss" ? SWISS_BIAS : undefined`.
  - `newModelState`:
    - replaces the two throws with `throw new ModelUnsupported(MODEL_FAMILY_ROUTE[input.row]!.wave, …)` for multi-stage and ladder-family rows. Any other multi-stage row missing from the table is a named `Error` (a guard: a new row must be routed);
    - adds entrants with `members: kind === "team" ? rosterMembers(sport, cfg, i + 1) : undefined`, then reads the rosters back via `entrantMembers`;
    - adds `ModelState.rosters`.
  - The model's Score/Walkover/Correct commands call the model twin of `ensureLineups` (the same `lineupFor`, once per fixture).
  - `model.ts --cell` admits any `cellId(row, sport)` whose row is single-stage and not in the ladder family. A multi-stage one reaches `newModelState` and is refused there, so the refusal is the typed one.
- [ ] **Step 4: PASS** (`model-core.test.ts`, `model-cli.test.ts`, `model-run-cell.test.ts`, `scenario-catalogue.test.ts`). The `--regressions` replay test stays byte-identical: the bias applies only when no committed case pins a command list. Assert that the 5 committed cases replay unchanged.
- [ ] **Step 5: Mutation:**
  - ignore `bias` → killed by the SWISS_BIAS length test and the seed test;
  - route `swiss_playoff` to W5 → killed by the `it.each`;
  - skip rosters → killed by the team-cell test.
- [ ] **Step 6: tsc + eslint; commit** `feat(matrix): model team rosters, Swiss-biased commands, family-routed refusals (W1-driving T14, ruling 49, D6)`.
- [ ] **Step 7: Live** (on the Task 15 env, before Task 15's full run): `pnpm matrix:model --cell swiss|badminton --runs 20 --run-id w1drv-model-sb; echo EXIT=$?` and `pnpm matrix:model --cell league|football --runs 20 --run-id w1drv-model-fb; echo EXIT=$?`. Paste each cell's verdict and every command's `ran` count; none may be 0. Then `pnpm matrix:model --regressions --run-id w1drv-model-reg` shows 5 known, each exact.

---

## Task 15: The live evidence — ruling 48, on workers, reviewed

No new code. A defect found here is fixed in the owning task's module with a failing test first, as a new commit, and the affected cases are re-run.

Before starting: a fresh DB and prod server via the `seazn-local-env` skill. Confirm that `show data_directory` is this session's, that `SMOKE_BASE` is `http://localhost:<port>`, and that the tree is clean. Every run writes `EXIT=$?` itself. Evidence goes under `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1drv-<name>/`.

- [ ] **Step 1: Smoke, the HTTP slice (24).** `pnpm matrix:l3 --workers 4 --run-id w1drv-http-slice --report-dir <truth-runs>`. Every case state must equal W1c's committed `w1c-http-slice/results.json`. Any drift stops the wave (class 14): reproduce it on a clean detached worktree before calling it anything.
- [ ] **Step 2: The ruling-48 run.** `pnpm matrix:l3 --set w1-driving --workers 4 --run-id w1drv-l3 --report-dir <truth-runs>; echo EXIT=$?`.
  - The budget is written down before starting: at ~1 min per case, 937 cases take ~4 h on 4 workers. Use `run_in_background` with a 7,200,000 ms timeout per half. If needed, split by `--only` row groups into several run ids, each committed.
  - After: paste the state histogram. Planned total = ✅ + ❌ + ⏳ + 🚫 + ░ + ⛔ must equal 937, derived from the planner, never typed.
- [ ] **Step 3: Done-when (ruling 48), judged mechanically.**
  1. `node -e` over `results.json`: zero cases whose `state === "later"` and whose `deferred.wave === "W1-driving"`. Paste the count.
  2. Every ❌ is triaged into exactly one of:
     - **harness** (fixed in its owning task, test first, and that case re-run until it is not harness);
     - **product** (a finding, routed by design §8 to its wave, with case id and failing check);
     - **unfit** (put to the owner as a recommendation, never assumed).

     The list is written to `truth-runs/w1drv-l3/TRIAGE.md`, one line per ❌.
  3. The predicted product reds are checked by name, and each is recorded as confirmed or not:
     - `ko_plate|*|F1` → W4: `409 STAGE_COMPLETED_SEEDING_FAILED` after stage 1 committed complete, `CompleteObs.completed = false`, never retried (m-6, Task 6 Step 9);
     - `group_group_ko|*|F1`;
     - the 10 americano/mexicano × team-sport cells (false premise 10, corrected at plan review 1): the stage GENERATES on one arbitrary roster member per team; the cases carry the note "americano generated on team entrants with one arbitrary roster member each" → W7 finding. They may still be ✅ on every check, which is exactly why the note is the finding;
     A "mexicano case" below means the catalogue row `mexicano`, whose stage is `{ kind: "americano", config.mode: "mexicano" }` (plan review 3 I-1). Every harness branch and signature keys on `config.mode`, never on the kind.
     - every mexicano M1 case and any mexicano case with a forfeit or void: `mexicano-stalled-on-non-decided` → W7 (false premise 14, plan review 1 I-3), with the full failing set `["I4-nothing-ends-stuck", "life-loop-bounded", "life-stage-completed"]` (plan review 3 Q3). **R4 does not stall mexicano** (plan review 2 I-3): its withdrawal voids nothing that is pending, so round 2 is generated;
     - any mexicano case whose round-2 generate is refused because the pairing seats a pair entrant with its own member (the self-pair PK path, if Step 0 of Task 8 pinned it as a 500): `mexicano-pair-entrants-counted-as-players` with the self-pair evidence → W7. The full failing set is `["I4-nothing-ends-stuck", "I8-generate-named", "life-loop-bounded", "life-stage-completed"]` (plan review 3 I-2). If Step 0 found a NAMED refusal instead, I8 and I4's generate item pass, and the set is I4 ("never asked" only), `life-loop-bounded` and `life-stage-completed`;
     - every mexicano case that reaches round 2 (about 33 cases: LIFECYCLE, M1-free, R4 and F1 across the mexicano cells): `mexicano-pair-entrants-counted-as-players` → W7, with I10 failing on `round <n>: <person> seated 2×` (false premise 17, plan review 2 I-3). The note names the person and the earlier pair entrant that contains them;
     - every americano R4 case, and every mexicano R4 case where seed 3's person is seated in a round ≥ 2 through any entrant: `r4-withdrawn-player-kept-playing` → W7 (ruling 51, D14; the mexicano second leg, plan review 2 I-3);
     - `page_playoff_only|*|R4`: `pp-q2` abandoned by the open-format branch (policy `walkover`, walkovers 0, voided 1; false premise 16), so `r4-policy-reported` and the kind-aware `r4-cascade-consistent` pass; the final is never seated, `/complete` answers `200 completed: false` with no code, and the full failing set is `["I4-nothing-ends-stuck", "life-loop-bounded"]` with `life-stage-completed` abstaining (plan review 3 I-2) → W4 (plan review 1 m-5, plan review 2 I-1, Task 2);
     - the ladder R4 cases carry **no predicted red** (ruling 53): the policy is derived (`none`), seed 3 is live-absent and raw-present, and no later challenge seats it. Each carries the W7 note "ladder finalRanks keep withdrawn <id> at rung <i>", counted in TRIAGE.md as a W7 note, not a red;
     - `double_elim` with an unplayed `gf-reset` (Task 9 Step 0).
  4. **Triage rules for the predicted signatures: the ONE coverage table** (ruling 51, D14; plan review 1 C-1, I-3; plan review 3 I-2 made this the single copy, and D14 points here). A ❌ is classified **product (predicted) → W7** without a harness hunt ONLY when every one of its failing checks is covered by a signature on the same case:
     - **`r4-withdrawn-player-kept-playing`** (americano or mexicano R4) covers:
       - `r4-policy-reported`.
     - **`mexicano-stalled-on-non-decided`** (mexicano; M1, or any case with a forfeit or void) covers:
       - `life-loop-bounded`, when its evidence is `exited stalled_rounds`;
       - `life-stage-completed`, when its ONLY items are "complete → never asked";
       - `I4-nothing-ends-stuck`, when its ONLY items are "stage <n>: never asked to complete".
     - **`mexicano-pair-entrants-counted-as-players`** (mexicano; any case reaching round 2) covers:
       - `I10-americano-seats-each-person-once`, when its ONLY items are `round <n ≥ 2>: <person> seated 2×` and every such person is named in the signature's evidence (a member of an earlier pair entrant; false premise 17). An I10 item for round 1, a `never played` item, or a person the evidence does not name is uncovered.
       - On the self-pair path (a refused round-2 generate with the self-pair evidence), it also covers:
         - `life-loop-bounded`, when its evidence is `exited refused_generate`;
         - `I8-generate-named`, when its only item is that round-2 generate;
         - `I4-nothing-ends-stuck`, when its only items are that generate and "never asked to complete";
         - `life-stage-completed`, when its only items are "never asked".
     - Any combination of the above on one case is covered, provided each failing check is covered by its own signature (for example `r4-policy-reported` + I10 on a mexicano R4 case). A mexicano R4 case never gets `life-loop-bounded`, I4 or `life-stage-completed` covered by the stall signature, since R4 does not stall (plan review 2 I-3).

     The coverage table is checked by one fake test per signature set in Task 8 (the M1 stall, round 2 plus Task 9's I10, the self-pair path, the R4 cases), each asserting its case's full failing set, so the table and the pinned sets cannot drift apart. The general rule behind the companions (review 3's gap hunt): after Task 6, every non-`drained` exit leaves `complete: null`, which reds I4 and, on an all-terminal stage, `life-stage-completed` with "never asked". Every pinned full set in this plan was checked for that companion.

     A failing check NOT in that table (a crash, `life-built-as-posted`, `fold-parity`, `results-as-posted`, I10 outside the pair-entrant rule, I4 or `life-stage-completed` with any item other than "never asked", `m1-walkover-recorded`, a refused call without its signature) sends the whole case to normal triage, **harness first**. A signature on a case whose failing checks do not match it is itself a harness finding (the signature fired on the wrong shape). The count of cases classified by each signature is pasted into TRIAGE.md, and a signature count of 0 where the prediction said "every case" is recorded as "prediction not confirmed", never silently dropped. On the ladder, R4 carries no predicted red (ruling 53): `r4-policy-reported` is derived (D14), and any red there is triaged normally, harness first.
- [ ] **Step 4: The generated `MATRIX.md`.** `pnpm matrix:render truth-runs/w1drv-l3/results.json`. Confirm that `MATRIX.md` exists, is non-empty, and carries one row per planned case (the renderer's own count).
- [ ] **Step 5: `plans.lock.json`.** Add one entry per new committed run: `w1drv-http-slice`, `w1drv-l3` (or each split id), `w1drv-l1-r1..r3`, and the Task 11 and Task 14 runs if committed. Copy the missing-entry failure's printed entry (`committed-plans.ts`). Editing an existing entry is a stop.
- [ ] **Step 6: Parity.** `pnpm matrix:parity truth-runs/w1drv-http-slice/results.json truth-runs/w1drv-l1/w1drv-l1-r1/results.json --out truth-runs/w1drv-l1/parity.md; echo EXIT=$?`, over the cells the two runs share. Each difference is triaged as W1c Task 14 did.
- [ ] **Step 7: Flaky-shaped gates ×3** (class 8): Task 13's L1 set, three runs, three state columns pasted. Also re-run three times every ❌ from Step 3 whose failing check is timing-shaped (`pad-ledger-as-generated`, a request timeout). A case that differs across runs is a flake finding with its check named.
- [ ] **Step 8: READMEs with per-screen verdicts** (class 11): `truth-runs/w1drv-l1/README.md` (every screen × 1280) and `truth-runs/w1drv-l3/README.md` (the histogram, TRIAGE.md, and the predicted-red check).
- [ ] **Step 9: Commit the evidence**: `docs(matrix): W1-driving truth runs — slice, ruling-48 L3 on workers, L1 proof, triage`. Run `committed-matrix.test.ts` and `committed-plans-frozen.test.ts` green first. Paste their JSON lines.
- [ ] **Step 10: Whole-branch review.** Dispatch the reviewer over `origin/main...HEAD` with Review Focus 1–5, TRIAGE.md and the four reviewer questions (TEST-STRATEGY). Fix every Critical and Important finding, test first, and re-run the scoped gate plus the affected live cases. Paste the reviewer's final verdict.

---

## Task 16: `_INDEX.md`, `_RULES.md` R1 and the prompts — status, findings, W1d/W2 prerequisites

**Files:**
- Modify:
  - `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md`;
  - `_RULES.md` (R1 only);
  - `W1d-ci-truth-run.md` (Prerequisites only);
  - `W2-scoring-fidelity.md` (Prerequisites and the generator-breadth lines struck by ruling 44);
  - the memory entry `project_format_matrix_programme.md` and its `MEMORY.md` line.

- [ ] **Step 1: The W1-driving status row**, which flips from "in progress" to done. Record:
  - the Task 15 counts and the paths to each `results.json`;
  - the ⏳-W1-driving count (0) and the harness-❌ count (0);
  - TRIAGE.md's product-red count per wave;
  - the L1 proof ×3;
  - the review verdict;
  - the PR and merge commit, once they exist.

  The Q-A guard must stay green with the row closed. Run `scenario-catalogue.test.ts` and paste its line: it is the proof that no route names W1-driving.
- [ ] **Step 2: The W1c row's stale "PR and merge: pending"** becomes "MERGED 2026-09-30 — PR #905, merge `ebf7ec040`" (false premise 11).
- [ ] **Step 3: R1** in `_RULES.md` gains W1-driving: "W1a → W1b → W1c → **W1-driving** → W1d → W2 …", citing ruling 28. The same one-word change goes in design §8's "Order." line, if the design doc is in this programme's edit scope. If it is not, record the line in "Decision log" for the design's owner.
- [ ] **Step 4: Prerequisites.**
  - `W1d-ci-truth-run.md`'s "W1a, W1b, W1c merged" gains "W1-driving merged (ruling 28)".
  - `W2-scoring-fidelity.md`'s "W1a–W1d merged" gains "W1-driving".
  - The W2 checklist lines for the cricket two-innings generator and the cricket tie are struck, citing ruling 44. Task 10 already struck them in `_INDEX.md`; this edits the prompt's copy.
- [ ] **Step 5: "W1d first tasks" adjustments:**
  - item 4 (`LayerCase.run` inert / record run 514 `l3Gap`): run 514's `l3Gap` is gone after Task 10's regen, so the item's premise changed. Rewrite it with what the regenerated `l2-pairs.json` now says;
  - add "cricket pad adapter routes for the two-innings events" (D13);
  - add "browser workers inside a shard" (D10);
  - add "`MAX_WORKERS` may rise inside a shard" (Task 11).
- [ ] **Step 6: Findings routed (W1-driving)**, a new section. Every product red from TRIAGE.md goes in with its case id, failing check and wave. Then:
  - the 4-innings level-tie applicability question → W2 (false premise 4);
  - americano × team sport generates on one arbitrary roster member per team → W7 (false premise 10, corrected at plan review 1);
  - any seeding tie the harness had to pick (`seeding_tie_picked` cases) → W4/W5 by row;
  - every suspected americano/mexicano product red (D9) → W7, including the mexicano stall on any non-`decided` fixture (false premise 14);
  - R4 on americano/mexicano: the withdrawn player keeps playing (ruling 51; on mexicano only where the second leg holds) → W7;
  - mexicano from round 2 counts round-1 pair entrants as players, so a person sits twice in one round, or the round-2 generate 500s on a self-pair (`stages.ts:2290-2293` has no kind filter; false premise 17, plan review 2 I-3, review 3 I-2) → W7;
  - the ladder keeps a withdrawn player's rung in `finalRanks` (the raw `ladder_order`, `competition.ts:606`; ruling 53's note, never asserted) → W7;
  - R4 on `page_playoff_only`: the open-format branch abandons `pp-q2` and strands the final → W4 (review 1 m-5, review 2 I-1);
  - a variant whose side size differs from its catalog's `lineup.size` (volleyball beach, by review 1's reading; the setbased kernel has no `positionsFor`) → W2 (m-2, Task 3);
  - an unplayed `gf-reset` → W6.
- [ ] **Step 7: False premises.** Add the planning list (1–17, including the four found at plan review 1: 12–15, the two found at plan review 2: 16–17, and false premise 10's correction) plus every Step 0 premise that proved false, each with what was seen.
- [ ] **Step 8: Recommendations.** D1–D13 are recorded as ruled (52), with D6's amendment of ruling 49 (W3 added). D14's ruling-51 meanings and its ladder R4 expectation are ruled (51, 53). The predicted-signature legs and triage rule (Task 15 Step 3) are the planner's method, not a ruling. Anything not ruled stays a recommendation and is never labelled a ruling (class 17).
- [ ] **Step 9: Memory.** Update the programme memory entry (W1-driving done, counts, the PR, what W1d needs first) and its `MEMORY.md` index line.
- [ ] **Step 10: Commit** `docs(matrix): W1-driving index — status, findings, R1, W1d/W2 prerequisites`. Then open the PR (body ending with the attribution line) and ask the owner whether to dispatch e2e for the branch (`workflow_dispatch`; feature-branch pushes trigger nothing). This wave touches no e2e spec, so the answer is likely "not needed". Put it to the owner anyway.

---

## Self-Review

1. **Scope coverage** (rulings 44–49 plus the folded-in items; the controller's T1–T16):
   - Q-A guard, anti-vacuity basis, row "in progress", `OVERRIDE_WAVE` → W2 → Task 1;
   - page playoff 4, F1 unfit, catalogue regen as a reviewed diff with the floors rule → Task 2;
   - the roster seam (inline members, full size, `putLineup`, browser filler) → Task 3;
   - lineups before the first event, team deferral removed, PADPROOF `rosterlessTeams` decided (D3) → Task 4;
   - americano persons → Task 5;
   - multi-stage (generate after Start, complete once, confirm, per-stage `ObservedStage` "seeded", `group_group_ko` three stages on the Pro plan, `advance.ts` declined as D1) → Task 6;
   - ladder via challenges, bound derived, `finalRanks = ladder_order` → Tasks 7 and 9;
   - americano/mexicano loops, drained detection, product reds recorded → Task 8;
   - I2 structural, I9, I10, anti-vacuity → Task 9;
   - cricket tie and two-innings, regen, `KNOWN_UNSUPPORTED` empty, W2 checklist struck → Tasks 10 and 16;
   - workers → Task 11;
   - planner set and `--only` → Task 12;
   - browser filler, L1 proof per capability, the two template cells → Task 13;
   - model rosters, Swiss bias, family routes → Task 14;
   - live evidence (ruling 48: `plans.lock`, MATRIX.md, READMEs, parity, ×3) → Task 15;
   - `_INDEX`, R1, W1d/W2 prerequisites, W1d first-task item 4 → Task 16.

   The stage cap: `group_group_ko` needs 3 stages, and a case org gets the top public plan (`seed-org.ts:103-108` `chooseTopPublicPlan`; review 1 read 6). Task 6 Step 0 pins it, and Task 6 Step 3a adds the `PlanStageCapTooLow` start gate, so a plan-catalogue change refuses the run before any case instead of reading as a product ❌ (plan review 1 m-1; the first draft's claim that Step 0 already re-pinned it was untrue).

   Plan review 1 (fix round 1) is folded in: C-1 → D14, Tasks 7, 8, 15 Step 3; I-1 → Task 4 `ensureLineups` gate, Task 5 `setup.persons`; I-2 → false premise 10 corrected, Tasks 5, 8, 12, 15, 16; I-3 → false premise 14, D9, Task 8; I-4 → ruling 50, Task 2 Step 4, Task 10 Step 4; I-5 → Task 6 and Task 7 rule-10 tests; m-1 → Task 6 Step 3a; m-2 → Task 3; m-3 → Task 4 Step 0, Review Focus 1; m-4 → D8; m-5 → Task 2, Task 15; m-6 → Task 6 Step 9, Task 12 Step 7, Task 15; m-7 → Task 6 Step 1; m-8 → Task 12.

   Plan review 2 (fix round 2) is folded in:
   - I-1 → false premise 16, D14 (kind-aware `cascadeItems`), the Task 2 page-playoff prediction, Task 7 (unit test, `withdrawWhilePending`, the byte-identical canary, mutants), Task 15 Step 3;
   - I-2 → Task 6's fast-check: weighted commands; the seeding clause judged against `withdrawnBeforeConfirm`; confirm/before/after counts asserted > 0; a withdrawal-after-confirm example; mutants;
   - I-3 → false premise 17, D9, D14, Task 8 (Step 0 pins, the product-shaped default fake with `individualsOnly`, the evidence-checked fast-check, the round-2 signature test, mexicano R4 not stalling, mutants), Task 15 Step 3 (predictions and the I10 triage rule), Task 16;
   - m-1 → Task 4 `ensureLineups` (the `setup.rosterless` return);
   - m-2 → Task 3's side-size flag;
   - m-3 → Task 7's text-pinned `PENDING`;
   - m-4 → Task 9 I9's product-shape case;
   - m-5 → Task 7's `LadderHarness` normalisation;
   - m-6 → Task 6: 8 from the engine's `expandTake`, and `picks` refused by name;
   - m-7 → expected values written out in Tasks 6, 7 and 8;
   - m-8 → Task 7 files, Task 8's full failing-check sets, probe-set `:58`;
   - FP13 and W7 → ruling 53, D14, Task 7, Task 9, Task 15, Task 16.

   Plan review 3 (fix round 3) is folded in:
   - I-1 → Task 8: every mexicano gate keys on `config.mode` (`notePairEntrantDuplicates`, the R4 second leg); the fake serves `kind: "americano"` + `config.mode`, pinned by a stage-shape test; a `kind === "mexicano"` mutant is listed;
   - I-2 and Q3 → the mexicano M1 set is `[I4-nothing-ends-stuck, life-loop-bounded, life-stage-completed]` (no `cut_short`, reason given); the self-pair 500 path has its own test and set; ONE coverage table in Task 15 Step 3 item 4, with D14 pointing to it and the "never asked" companions covered; the page-playoff set is `[I4-nothing-ends-stuck, life-loop-bounded]` with `life-stage-completed` abstaining (Task 2, Task 7, Task 15); every pinned set was checked for the I4 companion (gap hunt);
   - I-3 → Task 7's `cascadeItems` unit test uses typed, product-shaped fixtures (`snap()`, `kind: "win"/"award"` outcomes, `outcome` on `before`), with each half's killing mutation written out;
   - m-1 → full spec ids; the I10 expectations move in at Task 9 Step 1;
   - m-2 → the canary compares the verdict and two entries, and asserts the new check's abstain;
   - m-3 → `winnerOf(toObservedOutcome(...))` against the named opponent;
   - m-4 → the fake's default is derived from the constant; a committed mexicano `dropWithdrawnFromPlan` case (which also drops the pair entrants holding the person);
   - m-5 → `RULEBOOK_SIDE_SIZE` (cited), `volleyball/beach` asserted by name, and an empty mismatch list fails;
   - m-6 → `PENDING_STATUSES` and `FORFEIT_MODEL_KINDS` are the single runtime authorities, each held to the product's text;
   - m-7 → `expandTake` at `:161`; the stray fragment is repaired.
2. **Placeholder scan.** Some values are deliberate Step 0 pins, each confirmed in its task before use:
   - the product's refusal codes (`SEEDING_TIE_CODE`, the lineup refusal, the ladder codes);
   - the cricket payload literals (`MATCH_CLOSE_DRAW`, `FOLLOW_ON_PAYLOAD`);
   - the americano `finalRanks` holder.

   Every test body is written out. The one test with conditional expectations (I10's `finalRanks`) names both forms and the fact that picks between them.
3. **Type consistency.**
   - `Route`/`routeTo` (T1) is used by T10's `counts.ts` and T14's `MODEL_FAMILY_ROUTE`.
   - `EntrantInput.members`/`MemberInput` (T3) is used by T4, T5, T13 and T14.
   - `EntrantMember` (T3) is read by `lineupFor`, `recordPersons` (T8) and the model (T14).
   - `StageTrack`/`rec.track(id)` (T6) is used by T7 and T8.
   - `decideFixture(…, stage)` (T6) is called by T7.
   - `CompleteObs.seedProposal` (T6) appears in T9's literals.
   - `confirmAdvance(ctx, rec, target, proposal, declared)` has one signature in T6's Interfaces and code.
   - `fieldSizeFor(row, scenario, template?)`: T2 defines two parameters, and T13 adds the optional third.
   - `LoopExit` gains `not_reached` (T6), `refused_challenge` (T7) and `stalled_rounds` (T8). `loopBounded` reds all of them.
4. **Review Focus.** Each of the five has a named test in its owning task:
   - RF1 → `rosters.test.ts` "every sport's lineup … passes validateLineup" (T3);
   - RF2 → `multi-stage.test.ts` "confirm uses the id /complete returned" and the fast-check test (T6);
   - RF3 → `ladder-loop.test.ts` "no challenge played is red", `americano-loop.test.ts` "stalled_rounds", and I9/I10's empty cases (T7, T8, T9);
   - RF4 → `workers.test.ts` and `run-cli.test.ts` workers (T11);
   - RF5 → `scenario-catalogue.test.ts` "a stray wave literal is refused" and the zero-routes case (T1).
5. **Sequence tests (rule 10).** Multi-stage advance (T6), ladder challenges (T7) and mexicano rounds (T8) each have a fast-check test with invariants after every step and a pinned seed. Each includes the withdrawal transition (`withdrawOne` in T6 and T8; generated withdrawals through `playLadder`'s hook in T7) with counted non-vacuity checks (T6 counts runs reaching a confirm, and withdrawals before and after it; T8 counts runs reaching a round-2 duplicate), and T7's property drives `playLadder` itself, not the fake's challenge logic (plan review 1 I-5). Shrunk failures are committed as named cases before any fix.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-30-format-matrix-w1-driving.md`, with the wave prompt at `docs/superpowers/specs/2026-09-27-format-matrix-prompts/W1-driving.md`. D1–D13 are ruled (52); rulings 50 and 51 are folded in (fix round 1), and ruling 53 (the ladder R4 expectation) and plan review 2 in fix round 2. Nothing in the plan awaits an owner ruling. Which execution approach would you prefer?

- **Subagent-driven.** A fresh implementer per task and a fresh reviewer after each, then a whole-branch review at the end (Task 15 Step 10). This is the most thorough, and the programme's standing topology (`docs/superpowers/RULES.md`).
- **Native.** One session implements every task, then one fresh reviewer checks the branch. Cheaper, but there is no independent review until the end.

**For this plan I recommend Subagent-driven.** Tasks 3 → 4 → 6 → 7/8 → 9 chain through shared interfaces (`EntrantInput`, `StageTrack`, `decideFixture(…, stage)`, `CompleteObs.seedProposal`). A mistake in one silently changes what every later loop observes, and the programme's failure classes 1, 3 and 12 were each caught by per-task review, not by the final one.

Parallelism is limited, because most tasks share `common.ts`, `driver/types.ts` and `scenarios.test.ts`. Only these pairs are file-disjoint and may run in parallel worktrees:
- Task 10 (streams, catalogue) alongside Tasks 3–5;
- Task 11 (workers) alongside Task 9.

Anything else runs in sequence.


## Executor carries from plan review 4 (Approved, 0 Critical / 0 Important / 5 Minor)

Each carry goes into the named task's dispatch brief. The executor re-pins it at Step 0 and does not treat it as settled.

- **m-a (Task 2 / Task 7, scoped canary).** `runCanary` does not exist and `verdict` is undefined. Use the existing `runOn({canary: true})` and read `state.state`.
- **m-b (Task 4 / Task 7, `PENDING_STATUSES`).** A second pending list that holds equal values passes the value pin. Either add a source scan that refuses a second literal list, or relabel that mutant as structural and say so.
- **m-c (Task 3, `RULEBOOK_SIDE_SIZE`).**
  - Write down the table's R9 reconciliation. It is rulebook-derived, not read from product output.
  - Every row carries a non-empty source.
  - The table spans 15 team presets. Expect `hockey/youth` to join `volleyball/beach` in the found list: the committed rulebook says 7 a side, the lineup says 11.
- **m-d (Task 8 / Task 9, I10).** "I10 passes on the M1 stall and the self-pair path" holds only if I10 skips its rank items when `complete` is null. Pin that with a test. Americano `finalRanks` are pair-entrant ids; judge them per person through the members, never by entrant id.
- **m-e (Task 7, `seatedLater`).** `seatedLater === true` holds only because of the fake's id order. Make the fake's id order adversarial, or assert on seat membership rather than position.
- **FIVB rule numbers (Task 3 dispatch brief, both conditions binding).**
  - The executor reads each rule number from the document in the same session and never recalls one. Otherwise the row says "unverified" and gives the URL (V2 is marked "summary" in the committed rulebook).
  - A house variant cites its committed W2 rulebook row or is excluded by name.
