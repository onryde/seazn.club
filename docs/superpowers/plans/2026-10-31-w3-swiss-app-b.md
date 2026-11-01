# W3 Swiss — App PR B (the engine bump) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move seazn.club onto `@onryde/seazn-engine` 2.0.0 (the W3 engine release). Adapt every breaking type and epoch consequence. Then wire everything the release offers into the product: SW-H1's refusal on the desk with its recovery, the look-ahead warning, the topscorer flag, score groups from table points (SW-M11), and art. 16's two inputs filled from real data. Also show the Swiss tie-break columns on the slideshow and the public table (ST-G21), drive a full Swiss into its KO cut in the browser (SW-L10), and retire owner ruling 70 with an L3 re-baseline, all in the same PR.

**Architecture:** One PR on `feat/w3-swiss-app-b`, cut from `origin/main` after app PR A has merged. It first installs the exact engine-PR snapshot (`0.0.0-pr<N>.<sha>`) through ONE `pnpm-workspace.yaml` `overrides:` entry keyed on the alias, with the manifests and their pin tests untouched. Task 13 removes the override and moves the 6 manifests (plus the lockfile) to `^2.0.0` once the release is published. Since #1097 the 4 range tests accept any caret release, so they are not edited (Task 0 has the paired flow; the owner decides it).
- **Server:** `swissGen` (`usecases/stages.ts`) narrows `pairRound`'s new union and throws the named refusal. It reads pairing scores from the stage's own table (`stageTablePoints`, a points-only read over `loadStageInputs`) and sets `lookAhead` / `finalRoundMaxScore`.
- **Standings:** `loadStageInputs` (`engine-db/competition.ts`) fills `TableFixture.unplayed` through the engine's `unplayedSidesOf`, and `TableStage.swissAbsentRounds` from the stage's seats.
- **Harness:** `tools/matrix` learns that a named refusal is not "paired nobody" and takes the organiser's recovery. Ruling 70's override goes, and L3 is re-baselined on this branch's truth run.

**Tech Stack:** TypeScript 7 / Node 26, Next.js (the repo's non-standard version: read `node_modules/next/dist/docs/` before touching a route or page), postgres.js, zod, vitest (JSON reporter), Playwright (CI dispatch only), Flyway deltas, pnpm 10 workspace with 6 `@seazn/engine` aliases.

**Spec:** `docs/superpowers/specs/2026-10-31-format-matrix-w3-swiss-design.md`.
- Scope: §6.3, and the §12 rows marked "after app bump PR".
- Rulings 250–253 are in `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md` (`:1995-2040`). The signed rulebook `rulebook-W3-swiss.md` is beside it, and every expected value comes from it.
- The brief `W3-swiss.md` "Output and handoff" (`:90-95`) is the ruling-70 retirement contract.
- Contracts consumed: the engine plan `docs/superpowers/plans/2026-10-31-w3-swiss-engine.md` at **90aafd00e1** (contract unchanged at e560114dd1) ("Interfaces the app plan consumes", Tasks 4b/4c/7/8/9, and the Task 12 id table), and the app-A plan `2026-10-31-w3-swiss-app-a.md` at **e560114dd1** (its Interfaces and refusal table).
- Evidence: `/Users/ashokhein/github/seazn.club/.superpowers/handoff/2026-10-31-w3/gaps.md`.

**Out of scope:**
- Everything in app PR A, including its refusal table, `finishSwissNow`, `patchSwissStage`/`addSwissRound`, the late-entry cases and their field model, frozen byes, and public "Round X of N".
- Engine code.
- The engine rules close-out PR (engine plan Task 12). This plan hands that PR its proving paths.
- Rows cut at 10 on the slideshow (`slideshow.tsx:343`) is not ST-G21's column gap; it is listed under "Findings", not built.

---

## Global Constraints

- **Worktree:** `/Users/ashokhein/github/seazn.club-worktrees/w3-app-b`, branch `feat/w3-swiss-app-b`, cut from a fresh `origin/main` that contains the merged app PR A AND seazn.club #1097 (`bde9e13180`, caret-agnostic engine-range tests). Confirm with `git merge-base --is-ancestor bde9e13180 HEAD`.
  - Never write in `~/github/seazn.club`. Never `git stash` (the stack is shared).
  - `$WT` = that worktree. `$S` = the executor's own scratchpad subdirectory `<scratchpad>/w3b-<task>/`. Never `rm` outside it.
  - Prefix every command with `cd $WT && ` (or `cd $WT/apps/web && `) in the same call.
- **Re-pin first.** Line numbers below were read at app `920d7a9a22` (pins checked unchanged to e560114dd1) and engine plan 90aafd00e1. App PR A rewrites `stages.ts`, so every task opens its cited lines before editing (AGENTS.md class 5). A moved pin is not a finding. A pin whose BEHAVIOUR changed is a finding; record it in the commit body.
- **Re-read the engine contract** before Task 1 and again before Task 12. Read the engine PR's actual `src/scheduling/swiss.ts`, `src/competition/{stage,points,tiebreakers}.ts` and `src/sport/module.ts` exports at the pinned snapshot. If any name in "Interfaces consumed" differs, the engine wins: stop and report the diff before adapting.
- **Environment:** follow the `seazn-local-env` skill: a fresh DB, `db:apply`, then `sync:sports`. Confirm `show data_directory` is yours. DB suites are red without it, and that red is environmental.
- **Scoped vitest only.** Never the full suite, the full gate or the full e2e locally.
  - `VERIFY-WEB <name> <files…>` = `cd $WT/apps/web && npx vitest run <files…> --reporter=json --outputFile=$S/<name>.json; echo EXIT=$?`.
  - Then `node -e 'const r=require(process.argv[1]);console.log(r.numPassedTests+"/"+r.numTotalTests, "failedSuites="+r.numFailedTestSuites);for(const t of r.testResults)console.log(t.status,t.name)' $S/<name>.json`.
  - **Green** = `EXIT=0`, passed = total > 0, `failedSuites=0`, and every named file appears in `.testResults[].name` under `$WT`. The JSON reporter cannot see an Unhandled Rejection, so EXIT=0 is required.
  - Name whole files; positionals are literal filters. Never an empty list (zsh then runs the FULL suite). Never through `rtk`. Never `--root`. Never `--testTimeout`.
  - Root-level suites (`scripts/__tests__`, `tools/matrix/__tests__`): `VERIFY-ROOT <name> <files…>` = `cd $WT && ./node_modules/.bin/vitest run <files…> --reporter=json --outputFile=$S/<name>.json; echo EXIT=$?`, judged the same way.
- **Types:** `cd $WT && pnpm turbo run typecheck; echo EXIT=$?` (all six consumers; this is what the engine's `downstream` job runs). Also `cd $WT && node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json; echo EXIT=$?`. Never through `rtk` (it eats `pnpm exec tsc`).
- **Lint:** `cd $WT/apps/web && rtk proxy npm run lint`. Read `✖ N problems`; the count must not rise.
- **OpenAPI:** a schema change runs `npm run openapi:gen` in `$WT`, then `git status --porcelain openapi/`. Only the intended change may appear, and it is committed.
- **Locale (R23):** every new user-facing string goes into all four of `apps/web/src/dictionaries/{en,es,fr,nl}/{ui,public}.json` as the key's family requires. Then run `npm run i18n:gen-keys` and `npm run i18n:check`. Never hand-edit `lib/i18n-keys.ts`. Refusal copy lives in app-A's `apps/web/src/lib/swiss-refusals.ts` table.
- **Migrations:** `db/migration/deltas/V<next>__<name>.sql`. Re-check the next free number on `origin/main` at task time. A delta that moves stored data:
  - opens with a `-- DATA CHANGE (LOUD)` header in V481's shape (count first, then write, in one block);
  - is listed in the PR body's "Data changes" section;
  - runs pre-deploy (owner rule 2026-10-28). Never a compat shim.
- **Tests (TEST-STRATEGY.md, `_RULES.md`): all four types per task.**
  - **Unit:** vitest, with DB-backed cases wherever SQL is involved.
  - **E2E:** a `test.describe` per task in `apps/web/e2e/w3-swiss-app-b.spec.ts` (Task 1 creates it), run only by CI dispatch, judged as a whole file.
  - **Smoke:** counted checks in `scripts/smoke/suites/w3SwissB.ts` (Task 1 creates it).
  - **Regression:** a test that fails on today's `main`, or on the snapshot before the task's code, for the gap being closed.
  - **Expected values** come from the rulebook (cite the section in a one-line comment), or the engine's own declarations (`module.tablePointsRule`, `swissDrawPoints`, `defaultTiebreakers`). Never from `swissGen`, `loadStageInputs` or the product's output. At least one case per guard must have a right answer that differs from today's wrong one, marked `// differential: today X`.
  - **Anti-vacuity:** every sweep, property and table test asserts its count is > 0 and prints it. Zero is a failure. Each rule set states its empty case first (R13).
  - **Mutation:** mutate each new guard once, one at a time (delete it, or revert it to today's line). See a named test go red, then restore. Record `mutant → killer test` in the commit body. Two guards that cover for each other are mutated separately.
  - **Sequence:** every behaviour task covers a **second call**, an **empty input**, **after a withdrawal or void**, and **another sport**. Badminton plus boardgame (chess) at minimum; plus football wherever goals or `opp_diff` are involved.
- **Rule ids: the engine plan is the only id authority** (90aafd00e1: X-SW-1..11 engine rows, X-SW-12..30 and BG-SW-1 in its Task 12 close-out table). A proving test's `describe`/`it` title carries the id as a whole token. The ids this PR proves are in the table at the end. Never a `-KO-` id; never an id of your own making.
- **UI tasks:**
  - Invoke the `frontend-design` skill first. Build in the house theme (mocks are layout only). Show the owner 2 options before building (R24).
  - Mobile-first: one DOM, `max-md:*` branches (AGENTS.md "phone composition").
  - Verify at 1280, 320 and 768 with no horizontal page scroll, and compare the control set at 320 against 1280.
  - Screenshots go to an Artifact page with a per-screen verdict, never into the repo.
  - A new testid on the stage rail or a public table: grep `apps/web/e2e/mobile.spec.ts` and keep its control-set and clipping scans true.
- **E2E by CI dispatch only:** `gh workflow run e2e.yml --ref feat/w3-swiss-app-b -f pr=<N>`, always with `--ref`.
  - The dispatch runs every job. Judge `w3-swiss-app-b.spec.ts` and every spec named in Task 13 as whole files, never `-g`.
  - A push cancels a running dispatch.
  - Dispatch at batch ends, then hand back. The main thread watches the run.
- **Smoke wiring:**
  - One `suite("w3SwissB", …)` call in `scripts/smoke/main.ts`, after app-A's `w3SwissA`.
  - The owner `delivered+w3b_${tag}@resend.dev` in `scripts/smoke/harness.ts`'s cleanup list.
  - A `SELECTABLE_SUITES` entry in `scripts/smoke/index.ts`.
  - Run: `SMOKE_ONLY=w3SwissB npm run test:smoke` against a live local server. Its count must equal `EXPECTED_CHECKS`; zero fails.
- **R27:** the PR body carries `Matrix rows: swiss, swiss_playoff, swiss_knockout × all; boardgame × all (FOLD_EPOCH 4→5)`. Confirm the exact grammar with `pnpm matrix:pr-rows` on the body before opening. Not the skill's `none — engine bump` line: this PR carries web and `stages.ts` changes.
- **Never touch:** the engine repo, the spec, the other two plans, `_INDEX.md` rulings (Task 13 appends status and findings only), `stryker-*.json`, `truth-runs/w1d-baseline/**` (a committed record; see Task 12).
- **Commits:** conventional. End every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Interfaces consumed (engine 2.0.0, per engine plan 90aafd00e1; re-verify against the snapshot)

```ts
// @seazn/engine/scheduling/swiss
export const SWISS_NO_LEGAL_PAIRING = "SWISS_NO_LEGAL_PAIRING";
export type SwissRefusalReason = "field_too_small" | "no_bye_candidate" | "rematch" | "colour" | "search_limit";
export interface SwissRefusal { ok: false; code: typeof SWISS_NO_LEGAL_PAIRING; reason: SwissRefusalReason; field: number }
export interface SwissRound { ok: true; pairings: SwissPairing[]; bye?: EntrantId; floated: EntrantId[];
  nextRound?: "pairable" | "unpairable" | "unknown" }            // present iff constraints.lookAhead
export type SwissPairResult = SwissRound | SwissRefusal;
export interface SwissConstraints { chess?: boolean; pairing?: "fold" | "rank_adjacent";
  lookAhead?: boolean; finalRoundMaxScore?: number }             // byeScore removed
export function pairRound(standings, history, constraints?, budget?): SwissPairResult;
// history.colours is read for non-chess too (home = "W").

// @seazn/engine/competition (stage.ts, points.ts)
interface TableFixture { /* … */ unplayed?: "home" | "away" | "both" }
interface TableStage { /* … */ swissAbsentRounds?: ReadonlyMap<EntrantId, readonly number[]> } // `rounds` required on a Swiss stage with any unplayed round
export function unplayedSidesOf(outcome: MatchOutcome, played: boolean, pair: FixtureResult): "home" | "away" | "both" | undefined;
export function swissDrawPoints(rule: PointsRule): number;      // rule.draw ?? rule.win.regulation / 2

// @seazn/engine/sport
type TiebreakerKey = /* … */ | "opp_diff";
// BoardgameCfg loses byeScore (stripped on parse); boardgame.ruleKeys.byeScore gone; boardgame FOLD_EPOCH 4 → 5.
// payout pays a bye win points (X-SW-5); defaultTiebreakers("swiss", cfg) changes for every sport (X-SW-9);
// buchholz / buchholz_cut1 / sberger / opp_diff row metrics are in table points (÷2 only for unit "half").
```

## Interfaces consumed (app PR A, merged)

- `apps/web/src/lib/swiss-refusals.ts`: `SWISS_REFUSALS: Record<SwissRefusalCode, { status; message; key }>`, `swissRefusalKey(code)`. Server side: `swissRefusal(code, details?)` in `apps/web/src/server/usecases/swiss-refusal.ts`.
- `finishSwissNow(auth, stageId)` and route `POST /api/v1/stages/{id}/swiss/finish`. `patchSwissStage(auth, stageId, { rounds?, chess? })` and route `PATCH /api/v1/stages/{id}`. Both are in `apps/web/src/server/usecases/swiss-rounds-admin.ts`.
- `judgeSwissRounds(rounds, field)` / `swissRoundsGuidance(field)` in `apps/web/src/lib/swiss-rounds.ts`.
- `swissFieldForRound(entrants, target)`, `entrants.swiss_first_round`, `admitSwissLateEntrant(…)`, and `isSwissByeShellExtKey(extKey)` (`lib/swiss-shell.ts`).
- `apps/web/src/server/__tests__/w3-migration.test.ts` (extended here).
- The e2e helpers app-A added to `w3-swiss-app-a.spec.ts`: reuse by import, or move them to `apps/web/e2e/support/` in Task 1 if they are module-private.

## Review Focus

1. **A refusal on round N after an odd-field reshape.** `swissGen` reshapes shells before it pairs. A refusal must leave every row as it was before the press (the pre-pair reshape included), seat nobody, write no `fixtures_generated`, and answer `SWISS_NO_LEGAL_PAIRING`, never `created: 0`. Pinned in Task 4: `X-SW-3 a refusal after a reshape rolls the reshape back`.
2. **A latecomer under case (c) who has no seat yet.** They are not a table entrant (`competition.ts:510-526` builds entrants from seats). `swissAbsentRounds` must not name them, or the engine throws `CONFIG_INVALID` and every standings read of the stage fails. Once seated, their missed rounds must appear. Pinned in Task 8: `X-SW-8 a case-(c) latecomer with no seat yet: table ranks, no key`.
3. **A stored ad-hoc round** (pre-ruling-252 rows, `ext_key` `adhoc-%`, round `maxRound+1`). It must declare no absences for everyone else, which would be the #846 phantom bye reborn as a phantom VUR. Pinned in Task 8: `X-SW-8 an ad-hoc round declares no absences`.
4. **Mid-round ranking with a pending board.** The public table renders during play. An entrant seated on an undecided board is not absent that round. Pinned in Task 8: `X-SW-8 a seated pending board is not an absence`.
5. **The nine live badminton divisions on their pinned chain** (X-TB-2). After the bump their table keeps its pinned order, and the slideshow shows only the columns that pinned chain holds, so no Buchholz column appears for a chain without Buchholz. Pinned in Task 9: `ST-G21 a stage pinned to the pre-W3 chain shows no Buchholz column`.

---

## Task 0: Pre-flight, paired-PR flow, live data (controller-run; no code)

**Files:** none in the repo. Output goes to `$S/preflight.md`, and later into the PR body.

- [ ] **Step 1: Gates to start.**
  - App PR A is merged to `origin/main`.
  - The engine PR is open, and its snapshot is published: `npm view @onryde/seazn-engine versions --registry https://npm.pkg.github.com | tr ',' '\n' | grep "0.0.0-pr<N>"`. Record `<N>` and the exact `<sha>` version.
  - The engine PR's epoch report (or `pnpm fold-epoch:check` output in its body) names **boardgame 4 → 5 only**. Anything else: STOP and report.
  - **Release order (M7).** Engine 1.1.0 (#6) is cut BEFORE 2.0.0. Gate: 1.1.0 is published, and the app bump onto it has merged to `origin/main`. Read the 6 manifests' current spec from `origin/main` and record it in `$S/preflight.md` (expected `^1.1.0`, not `^1.0.0`). If 1.1.0 is not out, or the app is not yet on it, **STOP and put it to the owner**: wait, or proceed with app-B over the older pin. Do not decide this yourself.
- [ ] **Step 2: The merge-order decision — PENDING THE OWNER. Put it to them in chat; do not decide it.**
  - **The problem.** The engine PR's `downstream` job (engine `ci.yml:312-459`) checks out **seazn.club main** (`:332-333`) and injects the PR snapshot through `pnpm-workspace.yaml` overrides (`:388-402`). It then runs `turbo run typecheck`. App main does not know the new union, `byeScore` or `opp_diff`, so `downstream` reds on every engine push, and no app branch can green it. It is NOT a required check (branch protection). The engine plan Task 11 Step 3 already expects the red.
  - **Recommended: flow A, paired PRs (engine `AGENTS.md:27-29`, which wins over the skill per `SKILL.md:8`).**
    1. This PR installs the exact snapshot through ONE `pnpm-workspace.yaml` `overrides:` entry (the existing block, `:52`): `"@seazn/engine": "npm:@onryde/seazn-engine@0.0.0-pr<N>.<sha>"`. The 6 manifests and their 4 pin tests stay on main's spec. Every task is built and gated against the snapshot, with CI and the e2e dispatch green on this branch. Each engine-PR push that re-cuts the snapshot means editing that one line plus a re-run of the scoped gates.
    2. `downstream` is NOT a required check. The owner merges the engine PR over its red once this PR is green on the snapshot, with this PR linked in the engine PR body.
    3. The owner merges `release/2.0.0` (engine-release skill §1). Prove the publish: registry version, `v2.0.0` tag, and a GitHub Release whose epoch report names boardgame.
    4. Task 13 removes the override, moves the manifests and pins to `^2.0.0`, re-runs the gates, and the owner merges this PR.
    - Owner value: the app is proven against exactly the engine code that ships before anything is released. App main stays on its 1.x caret (a caret never resolves 2.x) and is never broken in between.
  - **Alternative: flow B (the skill's literal rule `SKILL.md:64`, "never pin a snapshot").** Merge the engine PR and release 2.0.0 first, then build this PR on `^2.0.0`. Cost: a MAJOR goes out unvalidated by its only consumer. A defect found here then needs a 2.0.1 round-trip.
  - Record the owner's answer in `$S/preflight.md`, and in the PR body as the owner's words. Do not label a recommendation as a ruling (AGENTS.md class 17).
- [ ] **Step 3: Live data (stg standing read; prod only if the owner gives the route in chat; read-only).**
  - Pass the URL via env only (`REMOTE_DATABASE_URL`, `.env.local:9`). Set `default_transaction_read_only=on` and `search_path=seazn_club`. Never put it in argv, a log or chat.
  - Bye points: app-A Task 0 Step 3 owns this check (count 1: Swiss bye rows whose effective points rule pays a `forfeit` row with `winnerPoints ≠ win`, or a `forfeit_win` bonus). Do NOT re-run it. Cite app-A's recorded result. If that result is above 0 and the owner has not ruled on it, **STOP and raise to the owner** with the division list: the bump moves those standings (anti-goal §2), and the owner's rule is a LOUD note plus a decision, never a shim.
  - Count 2 (feeds Task 2): stored boardgame configs carrying `byeScore` in each of V481's five places (`divisions.config`, `stages.config->'rules'`, `fixtures.rules_override`, `fixtures.config_snapshot`, `match_states.state->'cfg'`), each scoped by the division's sport.
  - Count 3 (feeds Task 8): live Swiss stages with a seated round in which a table entrant holds no seat. These are the rows whose Buchholz moves when absences become VURs; quote the count in the PR body.
  - Count 4: live Swiss stages holding an `adhoc-%` fixture (Review Focus 3). Quote the count; Task 8's ad-hoc guard has to hold for every one of them.

## Task 1: Bump to the snapshot; adapt every breaking type; re-derive the tests the release overrules

**Rules:** none new. This is the substrate. Behaviour changes that arrive with the engine (X-SW-5 bye points, X-SW-9 chains, X-SW-7/8 Buchholz values) are re-derived where app tests froze the old values.
- **Added (app-A T7 review m6):** `swiss-unplayed-rematch.test.ts`'s REMATCH board shape is engine 1.1.0's first preference, not a legality fact. 2.0.0's look-ahead may legitimately move it. If it moves, re-derive the shape by hand. The durable witness is the `history.played` assertions; never delete those.

**Files:**
- Modify: `pnpm-workspace.yaml`, the existing `overrides:` block (`:52`). Add ONE entry keyed on the alias: `"@seazn/engine": "npm:@onryde/seazn-engine@0.0.0-pr<N>.<sha>"`. Then update `pnpm-lock.yaml`. This is the only way a snapshot is installed here.
- **Do NOT touch** in this task: the 6 manifests (`package.json:73`, `apps/web/package.json:25`, `packages/scheduler/package.json:20`, `packages/reference/package.json:14`, `tools/bench/package.json:8`, `tools/matrix/package.json:7`) and the 4 engine-range tests (`scripts/__tests__/registry-install.test.ts:22`, `scripts/__tests__/engine-package-identity.test.ts:13`, `tools/matrix/__tests__/workspace-wiring.test.ts:138`, `apps/web/src/__tests__/toolchain.test.ts:357`). Since #1097 (`bde9e13180`) they accept any `npm:@onryde/seazn-engine@^X.Y.Z` caret, still require the 6 manifests to be identical and the lock to satisfy the caret, and refuse `0.0.0-pr…`, `workspace:` and `link:`. That is why the snapshot goes in the override and never in a manifest. Task 13 moves the 6 manifests; the tests are never edited.
- Modify: `apps/web/src/lib/swiss-refusals.ts` (app-A's table). Add the `SWISS_NO_LEGAL_PAIRING` row here (status 422, key `swiss.refusal.SWISS_NO_LEGAL_PAIRING`), with en copy plus the 3 locales and `i18n:gen-keys`. The reason-specific sentences and actions are Task 4's. The row lands in the same task as the throw that uses it.
- Modify: `apps/web/src/server/usecases/stages.ts` at the `pairRound` call (`:1442`) and its consumers (`:1514-1548`). The narrowing only; Task 4 owns the refusal's copy and recovery.
- Modify: `apps/web/src/lib/swiss-pairing.ts:54` (`roundOnePairs`: a refusal yields `[]`, and the hint says nothing), `apps/web/e2e/walkthrough/swiss-round-one-pairing.spec.ts:577` (its oracle narrows), `tools/matrix/__tests__/model-fake-driver.ts:654-668` (the twin narrows; Task 5 changes its scores).
- Modify: `apps/web/src/server/usecases/rule-locks.ts:39` (comment: `byeScore` is gone, X-SW-6) and `apps/web/src/server/usecases/__tests__/division-locks.test.ts:631,1028-1048`. Re-derive both from the engine's declarations: the declared points keys become `["awardScore", "scoring"]`. The I-2 case is retitled `X-SW-6 a stored byeScore is not a declared key: a config carrying it saves, and the key is not written back`.
- Re-derive: every app test the release overrules. Find them by behaviour, not filename (AGENTS.md class 16):
  - `grep -arln "byeScore\|forfeit.*bye\|bye.*forfeit\|virtual\|buchholz\|h2h_points" apps/web/src scripts tools/matrix --include='*.test.ts*'`;
  - plus whatever `pnpm turbo run typecheck` and the scoped runs name.
  Each re-derived expectation carries its rulebook citation (§4 for Buchholz and byes, §5 for chains). The commit body lists every file and assertion changed, with the ruling that overrules it (class 4: a test that froze an overruled value).
- Create: `apps/web/e2e/w3-swiss-app-b.spec.ts` (empty describe scaffold), `scripts/smoke/suites/w3SwissB.ts` (`EXPECTED_CHECKS = 1`), and the smoke wiring in `scripts/smoke/{main,harness,index}.ts`.
- Leave alone: `apps/web/src/server/engine-db/__tests__/fixtures/w2d-pin-before.json`. It is a recorded pre-W2d store; parse strips the key. If a test reading it reds, that is a finding: record it, do not edit the recording.

**Interfaces:**
- Produces: the `SWISS_REFUSALS.SWISS_NO_LEGAL_PAIRING` row. In `swissGen`, `const round = pairRound(…); if (!round.ok) throw swissRefusal("SWISS_NO_LEGAL_PAIRING", { round: target, reason: round.reason, field: round.field });` **before any write**. Task 4 extends the details and adds the desk copy.

- [ ] **Step 1: Write the failing tests.**
  - `apps/web/src/lib/__tests__/swiss-refusals.test.ts` (app-A's): `SWISS_NO_LEGAL_PAIRING has a row with status 422 and a key present in all 4 locales`.
  - `apps/web/src/server/usecases/__tests__/swiss-no-legal-pairing.test.ts` (new; badminton and boardgame through one body):
    - `X-SW-3 Pair next on a history with no legal round answers SWISS_NO_LEGAL_PAIRING and seats nobody`. Construction (rulebook §3.1; engine plan Task 4b's S6 shape): 6 entrants, `config.rounds = 5`. Write rounds 1–3 onto the shells by SQL as R1 {p0-p1, p2-p3, p4-p5}, R2 {p0-p5, p1-p2, p3-p4}, R3 {p0-p3, p1-p4, p2-p5}, each decided home win. The unplayed remainder is two triangles, so round 4 has no perfect matching. Assert the refusal, then that every round-4 row's `home_entrant_id`/`away_entrant_id` is null, and that no new `fixtures_generated` row exists. `// differential: today created 0, "up to date"`.
    - `X-SW-3 empty case first: a 1-entrant stage refuses field_too_small, not a crash`.
- [ ] **Step 2: Run, verify FAIL** on main's engine (before the override): `VERIFY-WEB t1-red src/server/usecases/__tests__/swiss-no-legal-pairing.test.ts src/lib/__tests__/swiss-refusals.test.ts`. Expect the round-4 test red on `created: 0`.
- [ ] **Step 3: Override and install.** Add the override line, then `cd $WT && pnpm install; echo EXIT=$?`. Confirm the snapshot resolved: `node -p 'require("./apps/web/node_modules/@seazn/engine/package.json").version'` prints `0.0.0-pr<N>.<sha>`, and so does the same read under `packages/reference/`. `git diff --stat` must show only `pnpm-workspace.yaml` and `pnpm-lock.yaml`. The 4 pin tests must stay green unchanged: they read the manifests, which did not move.
- [ ] **Step 4: Adapt.** Run `pnpm turbo run typecheck` and fix each error at its site, narrowing on `ok` (never cast). Every caller of `pairRound` must handle `ok: false` by writing nothing.
- [ ] **Step 5: Re-derive** the overruled tests listed above.
- [ ] **Step 6: Run, verify PASS:**
  - `VERIFY-WEB t1 src/server/usecases/__tests__/swiss-no-legal-pairing.test.ts src/lib/__tests__/swiss-refusals.test.ts src/server/usecases/__tests__/division-locks.test.ts src/lib/__tests__/swiss-pairing.test.ts src/server/usecases/__tests__/swiss-playoff-pairing.test.ts src/server/usecases/__tests__/swiss-shell-fixtures.test.ts` plus every file Step 5 touched (named);
  - `VERIFY-ROOT t1-root scripts/__tests__/registry-install.test.ts scripts/__tests__/engine-package-identity.test.ts scripts/__tests__/engine-bare-imports.test.ts tools/matrix/__tests__/workspace-wiring.test.ts tools/matrix/__tests__/model-fake-driver.test.ts`, and `VERIFY-WEB t1-tc src/__tests__/toolchain.test.ts`. App CI's registry guard (`ci.yml:131-148`: no `link:`/`file:`, count 6) must accept the override; if it rejects an `npm:` override, STOP and report rather than editing the guard. (name the real test file of the fake driver; `ls tools/matrix/__tests__ | grep -i fake`);
  - both tsc commands and lint.
- [ ] **Step 7: Mutate:** remove the `if (!round.ok)` throw (use a non-null assertion to compile) → the X-SW-3 test reds. Restore.
- [ ] **Step 8: Smoke** check 1: `POST /api/v1/stages/{id}/generate` on the SQL-seeded S6 stage → 409/422 with code `SWISS_NO_LEGAL_PAIRING` (status from app-A's `SWISS_REFUSALS` table, never a typed literal). The seed is a smoke helper writing through `withTenant` exactly as the unit test does.
- [ ] **Step 9: Commit** `chore(engine): install the W3 engine snapshot via override; adapt pairRound's refusal union, byeScore removal (X-SW-3, X-SW-6)`. The body lists the re-derived tests.

## Task 2: The epoch bump's migration steps (boardgame FOLD_EPOCH 4 → 5; byeScore stored-config cleanup)

**Rules:** X-SW-6 (the app half: the stored key is cleaned before deploy, not left for read-time stripping).

**Why:** the skill says a FOLD_EPOCH raise means "STOP: the app owes the epoch-migration steps first" (`SKILL.md:40`), but no document names the steps (premise 4). Read from the tree, they are:
1. **A stored-config cleanup.** No storage is keyed by epoch (`scoring.ts:222,735-780` is the only consumer, a write gate), and there is no re-fold job. What changed is the config shape the epoch moved for: `byeScore` is gone. The owner's data rule (10-28) and the W2e precedent (V481 step 3, `progressScore`) say remove it in all five stored places, pre-deploy and loudly.
2. **The 426 gate.** After deploy, a native capture client running engine 1.x and sending `engine_epoch: 4` for a boardgame fixture gets `426 ENGINE_OUTDATED`. The web pad sends no `engine_epoch` and is unaffected (smoke `epochFloorOverride.ts:86`). The emergency lever is `ENGINE_EPOCH_FLOOR_OVERRIDE` (`engine-epoch-override.ts:38`). This is owed a release-note line and a pinned test, not code.
3. **No cache invalidation** beyond step 1. `match_states.state->'cfg'` is one of the five places.
4. **The division save refuses the stripped key unless step 1 runs (engine T6 review, read at 5d7bac77b6).**
   - `divisions.ts:1138` `changedConfigKeys` diffs the parsed patch against the RAW stored row. A 2.0.0 parse strips `byeScore`, so the stored key reads as a change.
   - `divisionRefusals` then refuses it on any started stage with `DIVISION_FORMAT_LOCKED` (`rule-locks.ts:155-157`).
   - `restoreKey` writes it back (`divisions.ts:1164`), so every later save repeats the refusal. A no-change save gets a 409 that names `byeScore` (`divisions.ts:1216-1233`).
   - So the `divisions.config` strip is load-bearing, not cosmetic. Pin it: a started boardgame division that still carries `byeScore` saves an unrelated field without a 409 after this task (the I-2 retitle in Task 1 covers the key not being written back).
5. **The 1.x window.** Between the pre-deploy strip and 2.0.0 serving, the 1.x app re-adds the default `byeScore: 2` on any boardgame config it writes.
   - The migration is idempotent, so re-run it once after 2.0.0 is serving. The runbook line goes in the PR body.
   - Smoke check 2 and the stg read in Task 12 run after that re-run.
6. **The rollback lever is safe here.** `ENGINE_EPOCH_FLOOR_OVERRIDE=boardgame=4` lets an epoch-4 phone through. Engine T6 proved outcomes, summaries and deltas are byte-identical across the bump (only the `byeScore` text left the states), so an epoch-4 phone folds the same results. Say so in the release note.

**Files:**
- Create: `db/migration/deltas/V<next>__w3_bye_score_cleanup.sql` (DATA CHANGE, LOUD). Its header names the five places in V481's words. It counts first, writes in one block, and scopes every statement by the division's `sport_key = 'boardgame'`. Each statement is `… #- '{byeScore}'` (or the nested path for `state->'cfg'`) `where … ? 'byeScore'`. It is idempotent.
- Modify: `apps/web/src/server/__tests__/w3-migration.test.ts` (app-A's file).
- Modify: `apps/web/src/server/usecases/__tests__/scoring-engine-epoch.test.ts` (one case).

**Interfaces:** none produced.

- [ ] **Step 1: Write the failing tests.**
  - `X-SW-6 the cleanup removes byeScore from a boardgame division, a stage rules overlay, a rules_override, a config_snapshot and a match_states cfg (5 places, counted)`. Seed one row per place, each carrying `byeScore: 2` plus a sibling key. After the migration, `byeScore` is absent from all five and every sibling key is byte-identical.
  - `X-SW-6 the cleanup never touches a non-boardgame row that happens to carry the key`: the positive pair. A generic division with a stray `byeScore` keeps it, so the sport scope is pinned.
  - `X-SW-6 a second run changes 0 rows`.
  - In `scoring-engine-epoch.test.ts`: `boardgame's floor is the engine's declared epoch: engine_epoch = foldEpochOf("boardgame") − 1 is refused 426; the web pad (no engine_epoch) writes`. The expected floor is read from the engine (`foldEpochOf`), never the literal 5.
- [ ] **Step 2: Run, verify FAIL:** `VERIFY-WEB t2 src/server/__tests__/w3-migration.test.ts src/server/usecases/__tests__/scoring-engine-epoch.test.ts`. The migration tests are red because the file is missing. The epoch case may already pass; if so it is a pin, so say so in the commit body.
- [ ] **Step 3: Implement** the delta.
- [ ] **Step 4: Run, verify PASS:** the Step 2 files plus `src/server/__tests__/w2e-migration.test.ts`. That test reads deltas by glob, so a numbering clash shows here.
- [ ] **Step 5: Mutate:** drop the sport scope → the positive-pair test reds. Drop the `match_states` statement → the 5-places test reds.
- [ ] **Step 6: Smoke** check 2: a boardgame division's stored config read back through `GET /api/v1/divisions/{id}` carries no `byeScore`. Update `EXPECTED_CHECKS`. There is no UI change. The e2e is owed through Task 10's chess describe, which plays a boardgame Swiss end to end on the migrated schema.
- [ ] **Step 7: Commit** `fix(w3): remove the stored byeScore before deploy (X-SW-6; boardgame FOLD_EPOCH 4→5)`. The body says DATA CHANGE, quotes Task 0's count 2, and carries the release-note line for the 426 gate.

## Task 3: `opp_diff` labels, header and wire enum

**Rules:** none of its own (the key belongs to FB-TB-5 / HK-TB-3 / IH-TB-3's chains).

**Files:**
- Modify:
  - `apps/web/src/server/public-site/standings-view.ts:230-263` (`TIE_BREAK_MSG_KEYS` gains `opp_diff: "table.tieBreak.opp_diff"`; tsc demands it);
  - `standings-view.ts` `METRIC_HEADER_KEYS` (`:150-162`): `opp_diff: { "Opp GD": { abbr: "table.abbr.oppDiff", title: "table.col.oppDiff" } }`. It is a translated word, not a notation, so not `NOTATION_HEADERS`.
  - `apps/web/src/server/api-v1/schemas.ts:328-335` (`TiebreakerKeyS` enum; the `AssertTrue` at `:1063` holds it both ways). Then `npm run openapi:gen`.
- Dictionaries, 4 locales:
  - `ui.json` `div.detail.tiebreak.rule.opp_diff` (en: "Opponents' goal difference");
  - `public.json` `table.tieBreak.opp_diff` (en: "Opponents' goal difference"), `table.abbr.oppDiff` (en: "Opp GD"), `table.col.oppDiff` (en: "Opponents' goal difference").
  - Then `i18n:gen-keys` and `i18n:check`.
- Test:
  - `apps/web/src/server/public-site/__tests__/standings-view-keys.test.ts`, or the existing file that enumerates `TIE_BREAK_MSG_KEYS`; find it with `grep -arl TIE_BREAK_MSG_KEYS apps/web/src --include='*.test.ts'`;
  - `apps/web/src/lib/__tests__/tiebreak-label.test.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `every TiebreakerKey the engine declares has a dictionary key in all 4 locales (counted; the list read from the engine's own key set, never typed)`.
  - `opp_diff renders "Opp GD" over its column and names itself in the tie popover (en), and the other 3 locales are not the English string`.
  - `the stage tie-break editor offers opp_diff on a football Swiss stage and not on a badminton one`. The expected value comes from the engine's `offerableKeys` declaration (`stage-tiebreaks-model.ts:85`), never a typed list.
- [ ] **Step 2: Run FAIL, implement, run PASS:** `VERIFY-WEB t3 <the files above> src/components/v2/stage-rules/__tests__/stage-tiebreaks-model.test.ts` (name the real file). Run tsc and lint.
- [ ] **Step 3: Mutate:** delete the `es` key → the 4-locale test reds.
- [ ] **Step 4: E2E + smoke.** Task 10's football describe reads the "Opp GD" column on the public table. Smoke check 3: `GET` the hub doc of a football Swiss stage; its table `columns` include `opp_diff` with a non-empty header.
- [ ] **Step 5: Commit** `feat(w3): opp_diff labels in 4 locales, header and wire enum`.

**Batch 1 = Tasks 1–3.** Task 1 goes first; Tasks 2 and 3 have disjoint files and may run in parallel after it. Run an Opus `reviewer` pass over the batch diff, push, open the PR as a draft (body: the Task 0 decision, "paired with engine #<N>"), dispatch the e2e, and hand back.

## Task 4: SW-H1 on the desk — the named refusal and its recovery

**Rules:** X-SW-3 (app surfacing, cited at close-out); X-SW-26 (the recovery it offers).

**Files:**
- Modify:
  - The `SWISS_REFUSALS` row for `SWISS_NO_LEGAL_PAIRING` already exists (Task 1). This task adds only the reason-specific sentences and the actions below.
  - `apps/web/src/server/usecases/stages.ts`, `swissGen`: the throw from Task 1 gains the recovery details `{ round, reason, field, finishAfter: round − 1, canFinish: finishAfter ≥ 1 }`. Order matters: the refusal check sits before any write in the pairing transaction, so a pre-pair reshape is rolled back (Review Focus 1). If the reshape is committed in an earlier transaction after app-A, move the pairing call ahead of the reshape's writes or into the same transaction; say which in the commit body.
  - `apps/web/src/server/api-v1/http.ts:229-282`: read it; expect no edit. Its case-by-case allowlist applies to `EngineError` only. `swissRefusal` raises an `HttpError`, whose `extra` is merged into the response body as given. So the guard against leaking belongs at the source: `swissGen` builds `extra` from exactly the five fields below, copied by name, and never spreads the engine's `SwissRefusal` object or anything else into it. (If app-A's `swissRefusal` turns out not to be an `HttpError`, record it as a finding and route `extra` through the allowlist instead.)
  - `apps/web/src/components/v2/stages-panel.tsx`: in `classifyActError` (`:1873`), `SWISS_NO_LEGAL_PAIRING` maps to an amber warning with two actions. **"Finish the Swiss after round {n}"** calls app-A's `POST /api/v1/stages/{id}/swiss/finish` behind the same confirm copy app-A Task 13 uses. **"Change the number of rounds"** opens app-A's rounds control. The desk never shows `schedule.notice.nothingNew` for a refusal.
- Create: `apps/web/src/lib/swiss-no-pairing.ts` (pure): `noPairingNotice(details): { key: MessageKey; params; actions: ("finish" | "rounds")[] }`.
- Copy, 4 locales (rulebook §3.3, verbatim intent):
  - `swiss.refusal.SWISS_NO_LEGAL_PAIRING.rematch` = "Round {round} can't be paired: every remaining pairing would repeat a match already played. You can finish the Swiss after round {finishAfter} (standings are final as they stand), or change the number of rounds.";
  - `….colour` = the same sentence with "would break the colour limits";
  - `….no_bye_candidate` = "… every player has already had the bye …";
  - `….search_limit` = "Round {round} could not be paired in time. Try again, or finish the Swiss after round {finishAfter}.";
  - `….field_too_small` = "Round {round} needs at least two players.";
  - action labels `swiss.recovery.finishAfter` = "Finish after round {n}" and `swiss.recovery.changeRounds` = "Change rounds".
- Test:
  - `apps/web/src/lib/__tests__/swiss-no-pairing.test.ts`;
  - `apps/web/src/server/usecases/__tests__/swiss-no-legal-pairing.test.ts` (extend);
  - `apps/web/src/components/v2/__tests__/stages-panel-swiss-pairing.test.tsx` (extend).

**Interfaces:**
- Consumes: `SwissRefusal` (engine); `swissRefusal`, `finishSwissNow` and the rounds PATCH (app-A).
- Produces: `noPairingNotice` (above); the refusal's wire shape `{ code: "SWISS_NO_LEGAL_PAIRING", extra: { round: number; reason: SwissRefusalReason; field: number; finishAfter: number; canFinish: boolean } }`.

- [ ] **Step 1: Write the failing tests.**
  - Pure, a table over every `SwissRefusalReason` (5, read from the engine's union through an exhaustive `Record`), with the count asserted, the empty case first (`finishAfter = 0` → no finish action, rounds only):
    - `X-SW-3 every refusal reason has its sentence and its recovery; round 1 offers no finish`.
  - DB:
    - `X-SW-3 the refusal carries round, reason, field and finishAfter on the wire`.
    - `X-SW-3 the refusal body carries nothing internal`: through the real route, the response body's keys are exactly `code`, `message` (plus whatever envelope keys app-A's other refusals carry, read from one of them in the same test), and `extra`. `extra`'s keys are exactly `{round, reason, field, finishAfter, canFinish}`, with no entrant ids, no history, no stack and no `ok`. The empty case: a `field_too_small` refusal has the same key set.
    - `X-SW-3 a refusal after a reshape rolls the reshape back` (Review Focus 1). Withdraw p5 from the S6 construction pre-pair so the round-4 shells reshape, press Pair, and assert every round-4 row is byte-identical to before the press.
    - `X-SW-3 a second press refuses again and writes nothing` (second call).
    - `X-SW-3 after a void on round 3 the round re-opens and Pair next refuses STAGE_NOT_READY (undecided), not SWISS_NO_LEGAL_PAIRING` (after a void).
    - `X-SW-26 the recovery: finish after round 3 completes the stage and seeds the knockout from round-3 standings` (swiss_knockout). This drives app-A's `finishSwissNow` from the refused state.
    - Another sport: the same body runs in boardgame with chess on.
  - Component: `X-SW-3 the desk shows the refusal sentence and both actions, never "nothing new"`, anchored on `="` for attribute probes.
- [ ] **Step 2: Run FAIL:** `VERIFY-WEB t4 src/lib/__tests__/swiss-no-pairing.test.ts src/server/usecases/__tests__/swiss-no-legal-pairing.test.ts src/components/v2/__tests__/stages-panel-swiss-pairing.test.tsx`.
- [ ] **Step 3: Invoke `frontend-design`.** Show the owner 2 placements for the recovery (inline buttons in the amber notice, vs a notice plus the rail's existing Finish action highlighted). Recommend inline: the organiser reads the reason and acts in one place.
- [ ] **Step 4: Implement**, 4 locales, `i18n:gen-keys`, `i18n:check`, `openapi:gen` (the 422 is documented).
- [ ] **Step 5: Run PASS:** the Step 2 files plus `src/server/usecases/__tests__/swiss-finish-now.test.ts` and `src/lib/__tests__/swiss-refusals.test.ts`. Run tsc and lint.
- [ ] **Step 6: Mutate** one at a time:
  - map the code back to `nothingNew` → the component test reds;
  - drop `finishAfter` from `extra` → the wire test reds;
  - spread the engine's `SwissRefusal` into `extra` → the nothing-internal test reds;
  - move the refusal check after the reshape write → the rollback test reds.
- [ ] **Step 7: Screenshots** at 1280, 320 and 768 (the notice with both actions; the finish confirm) go to the Artifact with verdicts and the 320-vs-1280 control-set diff.
- [ ] **Step 8: E2E + smoke.**
  - E2E describe `X-SW-3 / X-SW-26 an unpairable round refuses by name and finishes after the last full round`. Seed the S6 history through `withDb` (`e2e/helpers.ts:539`): the SQL writes results onto the product's own shells. The refusal itself comes from the real server and engine (premise 11: no UI path reaches a dead end deterministically after W3's guards). Then press Pair next, read the sentence, press "Finish after round 3", confirm, and read the KO bracket.
  - Smoke check 4: the wire `extra` carries `finishAfter = 3`. Update `EXPECTED_CHECKS`.
- [ ] **Step 9: Commit** `feat(w3): an unpairable Swiss round refuses by name with Finish / Change rounds (SW-H1, X-SW-3)`.

## Task 5: Score groups from table points (SW-M11; RB3-9)

**Rules:** X-SW-19 "Pairing score groups use the stage's table points".

**Decision (premise 10):** the pairing score IS the table's points, read from the same inputs and the same engine fold the table uses, so the published table, the groups and the tie-breaks read one number (rulebook §5 last paragraph). A per-fixture formula (`win.regulation`, `swissDrawPoints`) would be a second authority. It would drift from the table on IIHF OT wins (3/2/1/0), `bySetScore` maps and bonus rules. `swissDrawPoints` is used here only to derive expected values, and in the matrix twin that has no table.

**Files:**
- Modify: `apps/web/src/server/engine-db/competition.ts`: add `stageTablePoints(tx: Tx, stageId: string): Promise<{ points: ReadonlyMap<string, number>; rule: PointsRule }>`. It runs `loadStageInputs`, then `completeTableStage(toTableStage(inputs, await loadLotsDraws(tx, stageId)), inputs.tableFixtures)`, and maps rows to `points`. `rule` is the SAME `rules.points` object `loadStageInputs` hands to `payout` (`competition.ts:470-480`): the stage's one table rule, its pin once started (`loadTableRules`, `table-rules.ts:270`). Return that object; do not re-read it. This is where `swissGen` gets `rules.points` (premise 7), so the scores and Task 7's maximum share one rule. It **never persists a lots draw** (unlike `rankedStageStandings:757`, which stores one): points do not depend on order.
- Modify: `apps/web/src/server/usecases/stages.ts`, `swissGen` `:1355-1427`:
  - `const { points, rule } = await stageTablePoints(tx, stageId)`; `score` = `points` (an entrant with no table row = 0, the empty case). Keep `rule` in scope for Task 7;
  - the four hard-coded `+1` / `+0.5` / `+1` / `+1` (`:1373, :1395, :1396-1398, :1424`) are deleted;
  - the loops keep their non-score jobs: `played`, `colours`, `byes`, `inRound`.
  - **Legacy implicit byes** (app-A kept their +1 for `swiss_first_round` null): they now score what the table scores, 0. They keep bye-ineligibility. This supersedes app-A's legacy +1 for the pairing score only; it is listed under Decisions for the owner.
- Modify: `tools/matrix/__tests__/model-fake-driver.ts:646-649`: the twin scores win = the declared rule's win (clean sweep under `bySetScore`), draw = `swissDrawPoints(rule)`, bye = win, the rule read from `tablePointsRule(cfg, "swiss")`.
- Test: `apps/web/src/server/usecases/__tests__/swiss-score-groups.test.ts`.

**Interfaces:**
- Produces: `stageTablePoints` (above); inside `swissGen`, the local `rule: PointsRule` that Task 7 reads.

- [ ] **Step 1: Write the failing tests** (through `swissGen` with a `vi.spyOn` on `pairRound`'s standings argument, plus the seated result):
  - `X-SW-19 empty case first: round 1 sends every entrant score 0`.
  - `X-SW-19 boardgame: a win is 2 and a draw 1 in the score groups (the table's half-points), not 1 / 0.5`. Expected from the declared rule. `// differential: today 1 and 0.5` (the ratio is equal, so also assert the absolute values).
  - `X-SW-19 ice hockey: an OT win (2) and a regulation win (3) land in different score groups`. Expected from IIHF's declared 3/2/1/0. `// differential: today both +1, one group`. This is the case where the right answer differs in ORDER.
  - `X-SW-19 a custom rule win 3 / draw 1 on badminton: groups are 3/1/0`.
  - `X-SW-19 a bye scores the stage's win points, the same number the table shows (X-SW-5)`. Assert the spy score equals the public table's `points` for the bye holder, read through `rankedStageStandings` (the consumer).
  - `X-SW-19 after a withdrawal: the withdrawn entrant's opponents keep the points the table gives them`.
  - `X-SW-19 a second Pair (after Unpair) sends the same scores`.
  - `X-SW-19 stageTablePoints writes no lots draw` (count the lots rows before and after = equal), and its positive pair: `rankedStageStandings still stores one`.
  - Live-division sequence: `a stage pinned before W3 (pre-W3 rule pin) groups by its PINNED rule's points`.
- [ ] **Step 2: Run FAIL:** `VERIFY-WEB t5 src/server/usecases/__tests__/swiss-score-groups.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run PASS:** the Step 2 file plus `swiss-late-field.test.ts`, `swiss-playoff-pairing.test.ts`, `swiss-shell-fixtures.test.ts`, `swiss-walkover-saturday.test.ts`, `swiss-unplayed-rematch.test.ts` (app-A's), `swiss-no-legal-pairing.test.ts`, and the fake driver's test via VERIFY-ROOT. Run tsc.
- [ ] **Step 5: Mutate:** restore `+1` for a win → the ice hockey test reds. Score from `rankedStageStandings` instead → the lots-row test reds.
- [ ] **Step 6: Smoke** check 5: an ice hockey Swiss, after round 1 with one OT win, pairs round 2 with the OT winner outside the regulation winners' group (read the seats). E2E is in Task 10 (the KO cut reads the table the groups now share).
- [ ] **Step 7: Commit** `fix(w3): Swiss score groups are the table's own points (SW-M11, X-SW-19)`.

## Task 6: The harness reads a named refusal as a refusal, and takes the recovery (pre-requisite of the ruling-70 retirement)

**Rules:** none (harness). **Premise 5:** `tools/matrix/lib/scenarios/common.ts:797-805` pushes `{ roundNo, seated: 0 }` for a REFUSED generate as well, and `invariants.ts:300` turns that into "round N paired nobody (SW-H1)". As written, the SW-H1 fix would leave ruling 70's three cells red under their old reason.

**Added (app-A T7 review m3):** invariant I6 ("no two entrants meet twice in a swiss stage", `tools/matrix/lib/invariants.ts:~341-362`) counts every two-seated board as a meeting. After app-A T7 (X-SW-15, P-A2), a pair whose earlier board was a `double_walkover`, or an award the engine reads as unplayed (`isUnplayedForfeit`), may legally meet again. I6 must exempt exactly those, reading the same engine predicate and never a re-typed list. Add a differential: an unplayed rematch is not a violation, and a played rematch still is. Land it before Task 12's L3 re-baseline, or a legal rematch re-baselines as a violation.

**Files:**
- Modify:
  - `tools/matrix/lib/observed.ts` (`PairRoundObs` gains `refused?: string`, the code);
  - `tools/matrix/lib/scenarios/common.ts:795-810` (the Swiss loop):
    - on a named refusal with code `SWISS_NO_LEGAL_PAIRING`, record `{ roundNo, seated: 0, refused: code }`, then take the organiser's recovery: `POST /api/v1/stages/{id}/swiss/finish`, recorded as a `generates`-style observation `finish`;
    - exit `"finished_early"`, which leaves the stage asked to complete;
    - any other refusal keeps `refused_generate`.
  - `tools/matrix/lib/invariants.ts:298-301`: "paired nobody" fires only when `seated === 0 && refused === undefined`. A refused pair round counts as checked and passes only if `isNamedRefusal`.
  - `tools/matrix/lib/driver/http-driver.ts:228` (add `finishSwiss(stageId)`) and the fake driver's twin in `tools/matrix/__tests__/model-fake-driver.ts`: it returns the refusal when `pairRound` refuses, and implements `finishSwiss` as app-A's `finishSwissNow` behaves.
- Test:
  - `tools/matrix/__tests__/scenarios.test.ts` (extend near `:1941`);
  - `tools/matrix/__tests__/invariants.test.ts` (or the file that pins I4; name it).

- [ ] **Step 1: Write the failing tests.**
  - `I4 a SWISS_NO_LEGAL_PAIRING refusal is a named refusal, not "paired nobody"`;
  - `I4 an empty success still fails "paired nobody (SW-H1)"`: the positive pair, and the property I4 exists for;
  - `the Swiss loop on SWISS_NO_LEGAL_PAIRING finishes the Swiss and the knockout is reached` (fake driver, a forced dead end);
  - `a refusal with any other code still exits refused_generate`.
- [ ] **Step 2: Run FAIL, implement, run PASS:** `VERIFY-ROOT t6 tools/matrix/__tests__/scenarios.test.ts tools/matrix/__tests__/<I4 file> tools/matrix/__tests__/<fake-driver test>`, plus `tsc -p tsconfig.tools-tests.json` and `pnpm matrix:single-sport --check --against HEAD^1`.
- [ ] **Step 3: Mutate:** drop the `refused === undefined` condition → the refusal test reds; drop the finish call → the knockout-reached test reds.
- [ ] **Step 4:** No UI, no product smoke. The proof is Task 12's CI truth run on the three cells.
- [ ] **Step 5: Commit** `fix(matrix): a named Swiss refusal is a refusal, and the harness finishes the Swiss as an organiser would`.

**Batch 2 = Tasks 4–6** (sequential: 4 and 5 share `swissGen`; 6 consumes 4's wire shape and 5's fake-driver scores). Run the review, push, dispatch the e2e, and hand back.

## Task 7: Wire the look-ahead (X-SW-10) and the topscorer flag (X-SW-11)

**Rules:** X-SW-10 (app warning, cited at close-out); X-SW-11 (app input).

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts`, `swissGen`'s `pairRound` constraints.
  - `lookAhead: rounds > swissRoundsGuidance(n).safeMax && target < rounds`, with n = `swissFieldForRound(entrants, target).length` (app-A). This is rulebook §3.3 "above the safe maximum", and never on the last round.
  - `finalRoundMaxScore: target === rounds && rounds > 1 && chessOn ? (rounds − 1) × maxRoundPoints(rule, module, cfg) : undefined`. `rule` is the `PointsRule` Task 5 put in scope from `stageTablePoints`, which is the same rule the scores were computed under, in the same units (table points).
  - **One-round Swiss (engine T4c review I2):** `rounds > 1` is load-bearing. With one round the maximum would be (1 − 1) × win = 0, and the engine throws `CONFIG_INVALID` on a value ≤ 0. The schema allows one round (`schemas.ts:1190` min(1)). Add a test: a one-round chess Swiss pairs, with no `finalRoundMaxScore` sent.
  - **At most once per stage (engine T4c re-review):** "Add a round" after the final round was paired would make a NEW `target === rounds` and send the maximum a second time. Under the exemption a non-topscorer can then be barred from both colours, and the engine throws `CONFIG_INVALID` (swiss.ts M3 guard). So send `finalRoundMaxScore` only when no earlier round of this stage was paired with it. The mechanism (a stage flag, or a check on the round number) is the implementer's call. Add a sequence test: pair the final round, Add a round, pair it. It must pair or refuse `colour`, never throw.
  - **One bonus policy for the score and the maximum.** The score is table points, and table points include every bonus the rule pays. So `maxRoundPoints` = the most table points ONE fixture can pay one side under `rule`, bonuses included. Compute it by calling the same `payout` that `loadStageInputs` calls (`competition.ts:470-480`) on a regulation win with the clean-sweep result for the sport's format (`setsToWinOf(module, cfg)`), and take the winner's points. Never a hand formula: a formula is a second authority that drifts on bonuses (premise 10). Re-pin `payout`'s signature at the snapshot.
  - `GenerateOutcome.swiss_next_round?: "unpairable" | "unknown"`, present only when `round.nextRound` is not `"pairable"`.
- Create: `apps/web/src/server/engine-db/swiss-max-round-points.ts` (server, it calls `payout`): `maxRoundPoints(rule: PointsRule, module: AnySportModule, cfg: unknown): number`.
- Modify: `apps/web/src/components/v2/stages-panel.tsx`: after a successful Pair, an amber line when `swiss_next_round` is present. 4 locales:
  - `swiss.warning.nextRoundUnpairable` = "Round {next} may not be possible: every pairing left after this round repeats a match. You can finish after round {round}."
  - `…unknown` = "Round {next} could not be checked in time."
- Test:
  - `apps/web/src/server/engine-db/__tests__/swiss-max-round-points.test.ts`;
  - `apps/web/src/server/usecases/__tests__/swiss-look-ahead.test.ts`;
  - `apps/web/src/components/v2/__tests__/stages-panel-swiss-pairing.test.tsx` (extend: the warning render).

**Interfaces:**
- Consumes: `SwissConstraints.lookAhead` / `finalRoundMaxScore`, `SwissRound.nextRound` (engine Tasks 4b/4c); `swissRoundsGuidance` (app-A); Task 5's table-point scores and its `rule` in `swissGen`. **Runs after Task 5:** before Task 5, scores are 1/0.5 while the maximum would be in table points, so nobody is ever a topscorer and X-SW-11 would be inert.
- Produces: `maxRoundPoints`; `GenerateOutcome.swiss_next_round`.

- [ ] **Step 1: Write the failing tests.**
  - `maxRoundPoints` over every sport's DECLARED Swiss rule (`module.tablePointsRule(cfg, "swiss")` for each `declaredCfgs` cfg, via `forEachSport`), counted. Expected = rulebook §4 "win points" for that sport (the clean-sweep pair under a set-score map), typed per sport from the rulebook. Empty case first: a rule with no `bySetScore` and no bonus is `win.regulation`.
  - `maxRoundPoints counts a win bonus the rule pays, as the table does`: a custom rule with a winner bonus gives win + bonus. `// differential: a bonus-free formula gives win only`.
  - `the score and the maximum agree: a player who won every round has score = (rounds − 1) × maxRoundPoints after round rounds − 1` (badminton bySetScore and boardgame, counted). This pins the shared policy: it fails if either side drops or adds the bonus.
  - DB, through a `vi.spyOn` on the engine module's `pairRound` export plus the seated result (both, so a spy alone cannot pass):
    - `X-SW-10 6 entrants, 5 rounds: round 3 is paired with lookAhead and round 4 stays pairable`. Seed R1–R2 as the S6 6-cycle and press Pair. Assert the spy saw `lookAhead: true`, and that the seated round 3 leaves a perfect matching for round 4, checked by the test's own brute-force oracle (rulebook §3.1). `// differential: without lookAhead the fold seats the three diameters`.
    - `X-SW-10 empty case: 6 entrants, 3 rounds (= safe max) → no lookAhead, no warning`.
    - `X-SW-10 the last round never asks for a look-ahead`.
    - `X-SW-10 a round whose every legal pairing kills the next returns swiss_next_round "unpairable" and still seats the round`. The construction is found by brute force over n = 6..8 seeded histories with a non-last target round. Commit it as a named fixture with its seed, the way the engine plan found S6.
    - `X-SW-11 the final round of a chess Swiss sends finalRoundMaxScore = (rounds − 1) × the declared clean-sweep win; earlier rounds and badminton send none` (counted over boardgame and badminton).
    - `X-SW-11 a player on a perfect score before the final round IS a topscorer: the spy's standings score equals finalRoundMaxScore` (boardgame). This is the inert-seam guard for the flag.
    - `X-SW-11 two topscorers with the same absolute colour preference are paired in the final round instead of refused`. A boardgame history seeded so the topscorers' last two games were both White. `// differential: without the flag → SWISS_NO_LEGAL_PAIRING colour`.
  - Component (M8; the e2e only proves the warning's absence): `X-SW-10 a Pair response with swiss_next_round "unpairable" renders the amber line naming round {next} and the finish-after round`; `… "unknown" renders the could-not-check line`; empty case first, `… no swiss_next_round renders no warning`. Feed the panel the response shape, and anchor on `="` for the testid.
- [ ] **Step 2: Run FAIL**, implement, add 4 locales, `i18n:gen-keys`, then run PASS: `VERIFY-WEB t7 src/server/engine-db/__tests__/swiss-max-round-points.test.ts src/server/usecases/__tests__/swiss-look-ahead.test.ts src/server/usecases/__tests__/swiss-no-legal-pairing.test.ts src/server/usecases/__tests__/swiss-score-groups.test.ts src/components/v2/__tests__/stages-panel-swiss-pairing.test.tsx`. Run tsc.
- [ ] **Step 3: Mutate** one at a time:
  - `lookAhead` always false → the S6 test reds;
  - `lookAhead` on the last round too → the last-round test reds;
  - `finalRoundMaxScore` on every round → the "earlier rounds send none" test reds;
  - drop the warning field → the unpairable test reds;
  - delete the panel's render branch for `swiss_next_round` (the server still sends it) → the component render test reds;
  - drop the bonus from `maxRoundPoints` → the win-bonus test and the score-equals-max test red.
- [ ] **Step 4: Screenshots** of the amber line at 3 widths go to the Artifact.
- [ ] **Step 5: Smoke** check 6: the `swiss_next_round` field on the brute-force fixture's Pair response. The e2e is in Task 10 (the 6 × 5 describe reads no warning on a pairable path).
- [ ] **Step 6: Commit** `feat(w3): look-ahead above the safe maximum; final-round topscorer flag (RB3-4, RB3-10)`.

## Task 8: Fill art. 16's two inputs from real data — `unplayed` and `swissAbsentRounds` (inert-seam guard)

**Rules:** X-SW-7 (forfeits and double walkovers unplayed; withdrawal-adjusted opponents); X-SW-8 (late entrant's missed rounds). Both are engine rows; this is their producer. Until it lands they are inert in production (engine plan self-review "Seams"; AGENTS.md class 1).

**The rule the producer implements** (rulebook §4; engine plan Task 7):
- For each counted two-sided fixture: `unplayed = unplayedSidesOf(outcome, played, pair)`. `played` comes from `forfeitPlayedFacts(tx, fixtures, module)` (`engine-db/forfeit-played.ts:26`), the one authority on "was anything played" (rulings 116/118). `pair` is the `FixtureResult` the loader already builds (`competition.ts:470-480`).
- For a Swiss stage, the **Swiss rounds** are the round numbers of fixtures whose `ext_key` is a Swiss shell (`^sw-r\d+-`), not ad-hoc rows (Review Focus 3). A round is **open for absence** when it has at least one seated fixture.
- `swissAbsentRounds(e)` = the open Swiss rounds in which table entrant `e` holds **no seat** in any fixture of that round (home, away or bye winner, whatever the status). One rule covers a late entrant's rounds before entry, a withdrawn or disqualified entrant's rounds after leaving, and a legacy implicit bye. A seat on a pending board is a seat (Review Focus 4).
- Keys are table entrants only (Review Focus 2). An entrant is omitted when its list is empty.
- `rounds` stays `stage.config.rounds` (`:604`). app-A's Finish writes the cut-short value there.

**Files:**
- Create: `apps/web/src/server/engine-db/swiss-absent-rounds.ts` (pure, server): `swissAbsentRounds(fixtures: readonly { round_no: number | null; ext_key: string | null; home_entrant_id: string | null; away_entrant_id: string | null; outcome: unknown }[], tableEntrants: readonly string[]): ReadonlyMap<string, readonly number[]>`.
- Modify: `apps/web/src/server/engine-db/competition.ts`:
  - `loadStageInputs` `:351-526`: select `ext_key` with the fixtures (`:369-379`); compute `played` once per stage; set `base.unplayed` on two-sided decided fixtures; carry the absent map in `StageInputs`;
  - `toTableStage` `:588-610`: `...(inputs.stage.kind === "swiss" && absent.size > 0 ? { swissAbsentRounds: absent } : {})`.
- Modify: `apps/web/src/server/engine-db/table-rules.ts` `tableRulesOf` (~:167). This is the only place where the sport module and the merged cfg meet.
  - Fill `swissDraw: swissDrawFactsOf(module, mergedCfg)` on every Swiss stage. That covers both the bye/absence draw value (engine T7 fix round, ruling R4) and the clean-sweep win.
  - Engine T8 makes the field type-required whenever `swiss: true` (engine T8 review m3).
    - The usual `cond ? { swiss: true, swissDraw } : {}` spread no longer type-checks.
    - Write an explicit `{ swiss: false }` branch instead. Never use an `as never` / `as TableStage` cast.
    - Engine T8 also lists the other two fields owed at `competition.ts:~605`: `TableFixture.unplayed` from `unplayedSidesOf`, and post-withdrawal rounds in `swissAbsentRounds`.
  - The engine refuses a Swiss stage with no `swissDraw` eagerly (engine T8 carry). If the field is missing, every Swiss standings read fails.
  - Pin it with `X-SW-7 a Swiss stage with a bye ranks through the real producer (odd field)`, and add the even-field case beside it. A test with an even field only never reaches the old lazy throw.
- Test:
  - `apps/web/src/server/engine-db/__tests__/swiss-absent-rounds.test.ts` (pure);
  - `apps/web/src/server/engine-db/__tests__/swiss-art16-producer.test.ts` (DB, real producer and consumer).

**Interfaces:**
- Consumes: `unplayedSidesOf`, `TableFixture.unplayed`, `TableStage.swissAbsentRounds` (engine Tasks 7/8); `admitSwissLateEntrant` and `withdrawEntrantCascade` (app-A, the real producers of the states).
- Produces: `swissAbsentRounds` (above).

- [ ] **Step 1: Write the failing pure tests**, with the empty case first and every branch counted:
  - no fixtures → empty map;
  - a late entrant first seated in round 3 of 3 open rounds → `[1, 2]`;
  - a withdrawn entrant with seats in rounds 1–2 of 4 open rounds → `[3, 4]`;
  - a seated pending board → not absent;
  - a bye winner → not absent;
  - an ad-hoc round (`adhoc-1`, round 4) → never an open round;
  - shells with no seats (an unpaired future round) → never open;
  - an entrant not in `tableEntrants` → no key.
- [ ] **Step 2: Write the failing DB tests** (`swiss-art16-producer.test.ts`). Each builds the state through the REAL producer (the API usecases), and reads the result through the REAL consumers: `rankedStageStandings` (the desk table) and `buildTableView` via the competition hub (the public table). Expected Buchholz values are derived by hand in a comment from rulebook §4 for the scenario's declared rule: D = `swissDrawPoints(declared rule)`, cap = D × R, opponents' adjusted scores. They are never read from the engine's output.
  - `X-SW-8 a late entrant's missed round is a VUR: Buchholz on the desk and the public table equals the rulebook's`. The S4 shape on boardgame (R = 3; L admitted by `admitSwissLateEntrant` case (c) after round 1; results as engine plan S4). Expected L 8 half-points → displayed 4, and B 11 → 5.5. `// differential: without the producer, L's own card has no round-1 dummy`.
  - `X-SW-8 the same on badminton`, with D = ½ × the declared win (no draw), hand-derived in the test comment.
  - `X-SW-7 a pre-play walkover is unplayed: the loser's Buchholz uses a dummy capped at the opponent's adjusted score`. The S2 shape, driven through the real forfeit route with nothing played. `// differential: today read as a played game`.
  - `X-SW-7 a retirement after play stays played` (the positive pair, `forfeitPlayedFacts` true).
  - `X-SW-7 a withdrawn entrant's opponents read its adjusted score`. The S3 shape via `withdrawEntrantCascade`.
  - `X-SW-7 a double walkover gives both sides a forfeit_loss`.
  - Review Focus 2: `X-SW-8 a case-(c) latecomer with no seat yet: table ranks, no key`. Then Pair the next round and assert the key appears with the missed rounds.
  - Review Focus 3: `X-SW-8 an ad-hoc round declares no absences`. Seed an `adhoc-1` row by SQL (ruling 252 refuses new ones).
  - Review Focus 4: `X-SW-8 a seated pending board is not an absence`. Rank mid-round.
  - Sequences: `after a void of round 2's only result, the round is still open and its seats still count`; and `a second read gives identical rows`.
  - Another sport: `football: S2 under the declared draw points`.
- [ ] **Step 3: Run FAIL:** `VERIFY-WEB t8 src/server/engine-db/__tests__/swiss-absent-rounds.test.ts src/server/engine-db/__tests__/swiss-art16-producer.test.ts`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run PASS:** the Step 3 files plus `src/server/engine-db/__tests__/competition*.test.ts` (name each), `src/server/public-site/__tests__/competition-hub*.test.ts` (name each), `swiss-late-entry.test.ts` and `swiss-withdrawal-walkover.test.ts`. Run tsc.
- [ ] **Step 6: Mutate** one at a time (the inert-seam proof; each must red a named test):
  - drop `swissAbsentRounds` from `toTableStage` → the X-SW-8 late-entrant test;
  - drop `unplayed` → the X-SW-7 walkover test;
  - count pending boards as no seat → Review Focus 4;
  - include ad-hoc rounds → Review Focus 3;
  - drop the table-entrant filter → Review Focus 2 (CONFIG_INVALID).
- [ ] **Step 7: Smoke** check 7: a boardgame Swiss with a case-(c) latecomer after round 1. After round 3, the hub doc's Buchholz cell for L equals the rulebook value (the smoke derives it with the same hand formula in a comment). Update `EXPECTED_CHECKS`. The e2e is Task 10's (a), (b), (c) flow.
- [ ] **Step 8: Commit** `feat(w3): fill art. 16's unplayed and absent rounds from real data (X-SW-7, X-SW-8)`.

**Batch 3 = Tasks 7–8** (sequential: 7 reads Task 5's scores and rule; 8 touches `competition.ts` after Task 5). Run the review, push, dispatch the e2e, and hand back.

## Task 9: ST-G21 — the slideshow and the public table show the Swiss tie-break columns

**Rules:** none (a display gap). It shows X-SW-9's chain where the table is shown (rulebook §8 T9).

**Premise 9:** the public table and the desk table already pick their columns through `tableColumns` over the stage's cascade (`competition-hub.ts:940-960`, `standing-table.tsx:118`). So the default chains bring Buchholz there. What is owed is a proof, the `opp_diff` header (Task 3) and the phone fold. The slideshow drops every metric column (`slideshow-data.ts:147-174`).

**Files:**
- Modify:
  - `apps/web/src/server/slideshow-data.ts:42-174`. `StandingsSlideRow` gains `tiebreaks: string[]` (cells) and the slide gains `tiebreakColumns: { key: string; header: string }[]`. Both are chosen by `slideTiebreakColumns(shown, cascade)` = the first **two** keys in cascade order whose column `shown` holds and whose key the engine declares Swiss-only. Read that declaration from `@seazn/engine/competition`'s cascade-rule metadata (`swissOnly`; if it is not exported, STOP and report, and never type the list). The cells are `cellText`; the headers are `columnHeader`'s abbr.
  - The existing `pointRatio` column stays as it is.
  - `apps/web/src/components/v2/slideshow.tsx:63-99,240,334-369`: grid templates for 1 and 2 tie-break columns beside each existing shape. `standingsTemplate` keeps throwing on an unknown shape. Count the variants in a test.
  - `apps/web/src/components/public-site/standings-table-view.tsx`, only if the 320 check shows overflow: Buchholz columns fold into the phone disclosure exactly as other non-compact metric columns do (`compactKeysOf`).
- Create: `apps/web/src/lib/slide-tiebreak-columns.ts` (pure): `slideTiebreakColumns(shown: StandingsColumn[], cascade: readonly string[], swissOnly: ReadonlySet<string>): StandingsColumn[]`.
- Test:
  - `apps/web/src/lib/__tests__/slide-tiebreak-columns.test.ts`;
  - `apps/web/src/server/__tests__/slideshow-data.test.ts` (extend; name the real file);
  - `apps/web/src/components/public-site/__tests__/standings-table-view-headers.test.tsx` (extend);
  - `apps/web/src/components/v2/__tests__/slideshow*.test.tsx` (name it).

- [ ] **Step 1: Invoke `frontend-design`.** Show the owner 2 options for the TV board:
  - (A) up to two tie-break columns after Pts, abbreviated headers;
  - (B) one column (the chain's first Swiss key) plus the full name in a footnote.
  Recommend A: the cut and seeding disputes the owner wants gone (RB3-6 owner value) need both Buchholz numbers visible.
- [ ] **Step 2: Write the failing tests.**
  - Pure, empty case first: a league cascade → `[]`; badminton's Swiss default → `[buchholz_cut1, buchholz]`; football's → `[buchholz, opp_diff]`; boardgame's → `[buchholz_cut1, buchholz]` (the first two of three). Every expected list is derived from the engine's `defaultTiebreakers("swiss", cfg)` per sport through `forEachSport`, counted 11, never typed.
  - `ST-G21 a badminton Swiss slide carries Buchholz Cut-1 and Buchholz cells equal to the public table's cells for the same rows` (one source, `cellText`).
  - `ST-G21 a stage pinned to the pre-W3 chain shows no Buchholz column` (Review Focus 5).
  - `ST-G21 the public table of a Swiss stage under the default chain renders Buchholz Cut-1 and Buchholz headers` (anchor on `="`); `a league table renders neither`.
  - `slideshow templates: every (result shape × 0/1/2 tie-break) combination has a template (counted)`.
- [ ] **Step 3: Run FAIL, implement, run PASS:** `VERIFY-WEB t9 <the files above> src/server/public-site/__tests__/standings-ratio-note.test.ts`. Run tsc and lint.
- [ ] **Step 4: Mutate:** `slideTiebreakColumns` returns `[]` → the slide test reds. Ignore the pin (read defaults) → the Review Focus 5 test reds.
- [ ] **Step 5: Screenshots.**
  - Organiser board (`/slideshow/divisions/[id]`) and public `/present` at 1280 and 768: the TV budget.
  - Public table at 1280, 320 and 768, with no horizontal scroll and the 320-vs-1280 control-set diff.
  - All go to the Artifact with per-screen verdicts.
- [ ] **Step 6: E2E + smoke.**
  - E2E describe `ST-G21 the board and the public table show Buchholz for a Swiss`, plus a step in `slideshow-pts-ratio.spec.ts`'s neighbourhood only if its shapes moved. Run that spec whole in the dispatch.
  - Smoke check 8: the public slides doc of a Swiss stage carries `tiebreakColumns` with 2 keys.
- [ ] **Step 7: Commit** `feat(w3): Swiss tie-break columns on the slideshow and the public table (ST-G21)`.

## Task 9b: A Swiss round starts only after the previous round ends (X-SW-31; controller addition 11-01, engine T10b)

**Rules (§12):** X-SW-31 (engine row; the app half is the producer and the copy).

**Engine facts (T10b + fix round):**
- `roundBarrier?: "start" | "end"` lives on the scheduling `Assignment`, the build input fixture and the solver-port fixture. Absent means today's start floor.
- A sequence carrying mixed values → CONFIG_INVALID. The engine never reads `existing` for this guard.
- The placer seeds the floor from `existing` boards of the same sequence.
- New conflict kind `round_order_end`, with the gap in `shortfallMinutes` (not part of identity).
- New refusal detail `no_slot_round_barrier`.

**Files:** every app producer of a scheduling `Assignment` or build fixture. Sweep them all by behaviour: `grep -a` for `roundNo:` in the producers under `apps/web/src/server/**` and `packages/scheduler/src/**`. That includes BOTH widening callers (`roundRobinSequenceSiblings` and the delta-gate seam), the apply gate, auto-schedule, move/drag, and the pins path. Also: `packages/scheduler/src/placement-client.ts` (`toRequest`), the conflict copy, and the 4 locale dictionaries.

**Interfaces:**
- ONE helper, `roundBarrierFor(stageKind): "end" | undefined` (swiss → "end"), read by every producer. A missed producer makes every Swiss edit fail with CONFIG_INVALID (422), so the sweep is the task.
- `toRequest` forwards `round_barrier` on `Fixture` and `PinnedRow`. **Gate:** the placement service (onryde/seazn.club.placement) must ship the `round_barrier` field and the end constraint in `model.py` §10 first. Until it does, the build gate discards a solver board that breaches, and greedy ships (`verifier_rejected` is logged). That is correct but noisy. Opening that repo's PR needs the owner's go (third repo).

**Steps:**
- [ ] **Step 1: Failing tests.**
  - `X-SW-31 every Assignment producer sets roundBarrier "end" for a Swiss stage and nothing for league/group`: counted over the producers found by the sweep, failing at 0.
  - `X-SW-31 auto-schedule after Pair: round 2 is proposed after round 1's last board ends, and the apply accepts it`: the proposal-vs-apply parity, driven through the real auto-schedule and apply usecases with round 1 played (as obstacles).
  - `X-SW-31 a manual move of a round-2 board before round 1 ends is refused with the round_order_end copy` (4 locales).
  - `X-SW-31 a league keeps the start floor`: the control.
- [ ] **Step 2: Implement.** Copy for `round_order_end` and `no_slot_round_barrier` in all 4 locales; regenerate i18n-keys.
- [ ] **Step 3: Contract test** for `toRequest`. A Swiss build's request carries `round_barrier: "end"` on every Swiss fixture and pinned row. Only after the placement service ships the field.
- [ ] **Step 4: Mutate.** Drop the helper from one producer → the counted sweep test goes red. Drop the `toRequest` forward → the contract test goes red.
- [ ] **Step 5: E2E + smoke.** E2E describe in the Task 10 spec: Pair round 1, auto-schedule, and round 2 lands after round 1's last board. Smoke check: the auto-schedule proposal for a Swiss round 2 has min start ≥ max end of round 1.
- [ ] **Step 6: Commit** `feat(w3): a Swiss round is scheduled only after the previous round ends (X-SW-31)`.

**Addendum (owner ruling 255, 2026-11-01): unpaired Swiss round slots reach the solver.** Today a Swiss TBD shell goes
to placement with empty `entrant_indices` AND `person_indices` (`schedule.ts` `peopleOf`), the service refuses
(`INVALID_REQUEST "fixtures[k] has neither entrant_indices nor person_indices set"`) and every Swiss auto-schedule falls
back to greedy, so the round end barrier above never reaches the solver. Found by the Match Day session (5 local
divisions). Fix, in this task's re-vendor:
- The placement service ships an additive `Fixture` flag for an **unpaired round slot** (a placement PR, merged before
  this task): no person constraints (nobody is in it yet), but courts, windows, day caps and the round end barrier all
  apply. Never give a shell the whole field's people — every shell of a round would then clash with every other and the
  round would serialise onto one court.
- `toRequest` sets the flag on exactly the Swiss shells that carry no entrant (bye shells never reach placement, X-SW-29).
- Tests: `X-SW-31 auto-schedule of a Swiss stage with unpaired rounds is solved, not refused` (the request carries the
  flag, the solver path returns a placement, no `solver_unavailable` fallback); a counted contract test that `toRequest`
  never emits a fixture with both index lists empty AND no flag (fails at 0 checked); `round_no` is stamped on every
  Swiss fixture.

## Task 10: The full e2e — an odd field, a bye, a Buchholz tie, late players (a)/(b)/(c), into the KO cut (SW-L10)

**Rules:** proves X-SW-12 (late entry), X-SW-5 (bye), X-SW-8, X-SW-9 / BD-TB-2 (a tie broken on Buchholz), X-SW-19 (groups), X-SW-24 (cut-line flag), and X-SW-3/X-SW-26 (Task 4's describe).

**Files:**
- Modify: `apps/web/e2e/w3-swiss-app-b.spec.ts`.
- Create: `apps/web/e2e/support/swiss-oracle.ts`. This is the test's OWN rulebook oracle, written from rulebook §4/§5, and it never imports the product. It provides:
  - `tablePoints(fixtures, rule)`;
  - `buchholz(fixtures, entrant, { rounds, drawPoints, absent })` and `buchholzCut1(…)`, with the art. 16 dummy capped at D × R and opponents' adjusted scores;
  - `rankByChain(rows, chain)` for `points → buchholz_cut1 → buchholz → set_ratio → point_ratio → direct`.
  The `rule` and `chain` it is fed are the engine's DECLARED values (`tablePointsRule`, `defaultTiebreakers("swiss")`), read through the e2e's API, not computed.

**The flow** (badminton, `swiss_knockout`, Top 4; `test.describe.configure({ mode: "serial" })` inside the file):
1. Create the division through the builder UI as `formats.spec.ts:242-279` does. 7 seeded entrants. Rounds = the builder's recommended default for 7 (rulebook §3.2: 3), asserted as the value the knob OPENS AT (class 19). Start.
2. **Round 1 (odd field):** tap Pair next. Assert 3 boards and 1 bye. On the run sheet the bye has no court (X-SW-29). The bye holder's table points equal the declared win (X-SW-5).
3. **Case (a):** before any board starts, add late player L1 through "Add late player". The notice says re-paired. The field is 8 and the bye is gone. Every pre-existing board's time and court is unchanged (read the run sheet). Then play round 1 through the API (`scoreFixture`, `e2e/helpers.ts:2413`).
4. **Round 2 (even):** Pair. Start one board (`core.start` via the API). **Case (c):** add L2. The notice says "joins from round 3". Round 2 is untouched. Play round 2.
5. **Round 3:** Pair (field 9 → a bye). Start one board. **Case (b):** add L3. The notice names the bye holder. The new board shows L3 v the holder, and nothing else moved. Play round 3, with results chosen by a fixed policy (seed order, except two designated upsets) so that **two entrants who never met are level on points across the cut line (4th/5th)**. Assert that tie exists with count > 0 (anti-vacuity: no tie, no test).
6. **Tables:** the public table's Buchholz Cut-1 and Buchholz cells for every row equal `swiss-oracle`'s values. Absences: L1 none, L2 round 2, L3 rounds 1–2. The order equals `rankByChain`. The 4th/5th pair is split by Buchholz, not head-to-head (they never met): X-SW-9, BD-TB-2.
7. **Slideshow:** open `/present` and read the same two cells for the cut-line rows (ST-G21).
8. **KO cut:** complete the stage. The seed proposal's top 4 equals `rankByChain`'s top 4. Confirm, and the bracket renders the four in seed order (`formats.spec.ts:350-371` shape). If the chain leaves a cut-line tie unsplit, the desk flags it and no silent order is confirmed (X-SW-24).

**Further describes in the same file:**
- `X-SW-12 chess: the same three late-entry cases on a boardgame Swiss`. A shorter field (5 + 3 latecomers, 3 rounds). It asserts colours alternate and the absences' Buchholz as above. This is also Task 2's e2e on the migrated schema.
- `football Swiss: Opp GD column and Buchholz on the public table` (Task 3 and ST-G21).
- `X-SW-3 / X-SW-26 …` (Task 4).
- `X-SW-10 a 6 × 5 Swiss pairs round 3 with no next-round warning` (Task 7).

- [ ] **Step 1: Write the oracle and its own unit test.** `apps/web/e2e/support/__tests__/swiss-oracle.test.ts` runs under vitest via VERIFY-WEB; confirm the e2e support dir is collected, else place it under `src/lib/__tests__/` importing the file. It checks the engine plan's hand-derived S1–S5 numbers (E 12/2, C 7/2, L 8, B 11, X 13.5). These come from the rulebook, so the oracle is checked against the rulebook, not the product.
- [ ] **Step 2: Write the spec.** Budget: `test.setTimeout(Math.max(FLOOR, base + taps × perTap))` with the constants named (AGENTS.md class 20), never a flat literal.
- [ ] **Step 3: Static gates:** `cd $WT/apps/web && npx tsc --noEmit -p .` and lint. Never run the spec locally.
- [ ] **Step 4: Push and dispatch** `gh workflow run e2e.yml --ref feat/w3-swiss-app-b -f pr=<N>`. Hand back. The main thread judges `w3-swiss-app-b.spec.ts` as a whole file. It is serial, so a red count is a floor (class 21).
- [ ] **Step 5: Mutate (by reasoning, on the oracle only):** make the oracle's dummy uncapped → its S1 "C 7/2" unit case reds. This shows the oracle is not decoration.
- [ ] **Step 6: Smoke** check 9: the API-only skeleton of the flow (7 + case (a) + case (c) + case (b), 3 rounds, complete). The stage completes and the KO has 4 seeds. Final `EXPECTED_CHECKS` = 9.
- [ ] **Step 7: Commit** `test(w3): drive an odd Swiss with three late players and a Buchholz cut into the knockout (SW-L10)`.

**Batch 4 = Tasks 9–10.** Run the review, push, dispatch, and hand back.

## Task 11: Re-derive the e2e, walkthrough and smoke specs the release overrules (by behaviour)

**Why separate:** the skill says "never edit a smoke, e2e or walkthrough spec to make a bump pass" (`SKILL.md:46`). That rule is written for a behaviour-free bump. This bump changes behaviour by ruling (bye points 251, chains 252/RB3-8, art. 16 252/RB3-6, epoch). Every spec edit therefore needs its ruling cited and the owner shown the list (premise 13). It must never be a silent green-making edit.

**Files:** found, not guessed:
- `grep -arln "buchholz\|Buchholz\|h2h_points\|byeScore\|nothingNew\|up to date" apps/web/e2e scripts/smoke --include='*.ts'`;
- plus every spec the Batch 1–4 dispatches reddened.

- [ ] **Step 1:** For each red spec, read what it ASSERTS (class 4). Classify each one:
  - **overruled**: the old value contradicts a ruling. Re-derive from the rulebook and cite the ruling in a comment and in the commit body.
  - **regression**: our defect. Fix the product, not the spec.
  - **environmental**: per the `seazn-local-env` skill §5. Record it.
- [ ] **Step 2:** Re-run the affected specs by dispatch, as whole files.
- [ ] **Step 3: Commit** `test(w3): re-derive specs the W3 rulings overrule`. The body lists each spec, assertion and ruling. The list goes to the PR body for the owner.

## Task 12: Retire owner ruling 70 and re-baseline L3 (same PR as SW-H1)

**Rules:** brief "Output and handoff" (`W3-swiss.md:90-95`). The retirement lands in the same PR as Task 4, and after Tasks 6–9. The baseline must be a run of the tree that ships, so this task runs last before the PR is marked ready.

**Files:**
- Create: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w3-final/` in `w2e-final`'s shape (README, `ci/L{1,2,3}/`, judges), and append to `truth-runs/plans.lock.json`.
- Modify:
  - `tools/matrix/catalogue/baseline.json`: delete the `ruling70` block (`:3-17`) and repoint `L3` to `truth-runs/w3-final/ci/L3/results.json`.
  - `tools/matrix/lib/pr-sample.ts`:
    - delete `RULING_70_IDS` (`:156-160`);
    - `BaselineFile` (`:194`) refuses any `ruling70` key in the live catalogue with a named `BaselineUnreadable`: "owner ruling 70 retired by the SW-H1 fix (W3); a re-baseline never carries it";
    - `baselineOverrides` returns no override.
    - **The W1d record keeps its own block** (`truth-runs/w1d-baseline/baseline.json`, premise 6). Its loader (`backlog.ts:649-671`) validates that block's ids as cases of THAT record's L3 (as `baseline-ruling70.test.ts:100` does today), never against a deleted constant. The record file stays byte-identical.
  - `tools/matrix/catalogue/backlog-carries.json`: remove the `ruling-70` carry (`:21`). Re-read `p6-recommendation` (`:27`) and `swiss-playoff-reason-flip` (`:33`): each anchored on SW-H1 is either closed by this fix (remove it, and say so in the commit body) or still true (keep it). Decide by reading the W3 truth run, not by guessing.
  - `tools/matrix/ci/summary.ts:37,163-165,272,360` (`lotsFlips`): the three cells stop being expected flips.
  - `tools/matrix/catalogue/triage-rules.json:406,423` via `catalogue/scripts/gen-rules.py:110-113` and `gen-shapes.py:72`. Regenerate with `pnpm matrix:catalogue`; never hand-edit generated JSON. The SW-H1 rules stay: they still classify an empty success, should one come back.
  - Tests:
    - `tools/matrix/__tests__/baseline-ruling70.test.ts` becomes the retirement test. Its STALE guard (`:474-482`) is the test the brief says fires.
    - `backlog.test.ts:340,415-424,534-536,680-686`: `:534-536` already expects a retired block to load as `[]`; `:680-686` pins the W3 section's text, so re-derive it from `W3-swiss.md`.
    - `summary.test.ts:796-881`.
    - `w1d-backlog-index.test.ts:381-385`: it pins `W3-swiss.md` text, and that text does not change.
    - `w2a-expect.test.ts:200,230`, `triage-rules-shapes.test.ts:102`.
  - `truth-runs/w1d-baseline/README.md`: per the brief, append a dated "Retired" line under "## Owner ruling 70: three cells held red" (`:70-84`) naming the W3 PR and the new baseline run. History is appended, never rewritten.
  - `_INDEX.md`: regenerate the backlog section with `pnpm matrix:backlog` (the command printed under that section, `:5194`). Never hand-edit it.

- [ ] **Step 1: CI truth run.** `git push origin feat/w3-swiss-app-b && gh workflow run matrix-truth.yml --ref feat/w3-swiss-app-b -f scope=full; echo EXIT=$?`. Then `gh run list --workflow matrix-truth.yml --branch feat/w3-swiss-app-b --limit 1 --json databaseId,status,headSha,event`: headSha = HEAD, event `workflow_dispatch`. Hand back. When it ends: `gh run download <id> --name merged --dir truth-runs/w3-final/ci`, then `pnpm matrix:render`.
- [ ] **Step 2: Judge against the CURRENT baseline (block still applied):** `pnpm matrix:judge regression --baseline <current L3> --now truth-runs/w3-final/ci/L3/results.json --json-out truth-runs/w3-final/judge-L3.json; echo EXIT=$?`, and the same for L1 and L2.
  - Expected: 0 regressions.
  - Ruling 70's three cells: `works` (improvement), or red with a reason that is NOT "paired nobody".
  - `swiss_knockout|hockey|fih-outdoor|R4` (red in the baseline on SW-H1): `works`.
  - **Any cell red on "paired nobody (SW-H1)": STOP.** The fix did not land; do not retire the block.
  - Every other moved Swiss or boardgame cell is triaged:
    - expected by a ruling (bye points, chains, art. 16): record it, citing the ruling;
    - a defect: fix it in this PR and re-run that cell.
- [ ] **Step 3: Write the failing tests first:**
  - `ruling 70 is retired: the live baseline carries no ruling70 block, and a block is refused by name`;
  - `the committed baseline holds none of the three cells red on "paired nobody"`;
  - `the W1d record still loads its own block and its backlog section is unchanged` (byte compare of the regenerated W1d section).
- [ ] **Step 4: Retire** the block, the constant and the carry; repoint L3; regenerate the triage rules and the backlog. Then `pnpm matrix:lock-check --against HEAD`.
- [ ] **Step 5: Run PASS:** `VERIFY-ROOT t12 tools/matrix/__tests__/baseline-ruling70.test.ts tools/matrix/__tests__/backlog.test.ts tools/matrix/__tests__/w1d-backlog-index.test.ts tools/matrix/__tests__/summary.test.ts tools/matrix/__tests__/pr-sample.test.ts tools/matrix/__tests__/w2a-expect.test.ts tools/matrix/__tests__/triage-rules-shapes.test.ts tools/matrix/__tests__/triage.test.ts`, plus `tsc -p tsconfig.tools-tests.json`.
- [ ] **Step 6: Mutate:** put the block back in `baseline.json` → the "refused by name" test reds. Hand-edit one W1d record id → the W1d test reds. Restore both.
- [ ] **Step 7: Commit** in two commits:
  - `docs(matrix): W3 truth run (w3-final)`;
  - `chore(matrix): retire owner ruling 70; L3 re-baselined on the W3 run (SW-H1)`.

## Task 13: Re-pin to the release, PR, CI, owner sign-off

- [ ] **Step 1: Paired-flow gate (flow A, if the owner chose it).** The engine PR has merged, `release/2.0.0` has merged, and the publish is proven: registry `2.0.0`, tag `v2.0.0`, and the Release's epoch report names boardgame 4 → 5 only.
- [ ] **Step 2: Re-pin (M1, M7).**
  - First re-read the CURRENT spec on `origin/main` (rebase onto it): `grep -an '"@seazn/engine"' package.json apps/web/package.json packages/scheduler/package.json packages/reference/package.json tools/bench/package.json tools/matrix/package.json` and the 4 pin lines below. Do not assume `^1.0.0`: by now it is `^1.1.0` (Task 0's gate) or later. Record what you found in the commit body.
  - Remove the `"@seazn/engine"` entry from `pnpm-workspace.yaml`'s `overrides:`. No snapshot spec may remain anywhere: `grep -arn "0.0.0-pr" --include='*.json' --include='*.yaml' --include='*.ts' . | grep -v node_modules` returns nothing.
  - Set the 6 manifests to `"npm:@onryde/seazn-engine@^2.0.0"`: `package.json:73`, `apps/web/package.json:25`, `packages/scheduler/package.json:20`, `packages/reference/package.json:14`, `tools/bench/package.json:8`, `tools/matrix/package.json:7`.
  - Do NOT edit the 4 range tests (`scripts/__tests__/registry-install.test.ts`, `scripts/__tests__/engine-package-identity.test.ts`, `tools/matrix/__tests__/workspace-wiring.test.ts`, `apps/web/src/__tests__/toolchain.test.ts`). Since #1097 they accept any caret release. The bump diff is exactly the 6 manifest lines, the removed override line, and `pnpm-lock.yaml`: check with `git diff --stat`.
  - `pnpm install; echo EXIT=$?`, then confirm `node -p 'require("./apps/web/node_modules/@seazn/engine/package.json").version'` prints `2.0.0`.
  - Prove the 4 range tests green on `^2.0.0`, unchanged: `VERIFY-ROOT t13-pins scripts/__tests__/registry-install.test.ts scripts/__tests__/engine-package-identity.test.ts tools/matrix/__tests__/workspace-wiring.test.ts` and `VERIFY-WEB t13-tc src/__tests__/toolchain.test.ts`. Mutate once: set one manifest back to its old caret → the identical-manifests check reds. Restore.
  - If the release's engine tree differs from the snapshot's (another engine PR merged between them, `git -C ~/github/seazn.club.engine diff <snapshot sha> v2.0.0 -- src`), re-run every task's VERIFY-WEB list and Task 12 Steps 1–2. A difference that moves a cell re-baselines.
- [ ] **Step 3: Gates:**
  - `pnpm turbo run typecheck`, `tsc -p tsconfig.tools-tests.json`, lint (count not risen);
  - `i18n:check`;
  - `openapi:gen` with a clean diff;
  - `pnpm matrix:single-sport --check --against origin/main`;
  - **The rules checker on the released rows (M9).** The close-out rows (X-SW-12..30, and the app-appended proof paths of X-SW-3/7/8/10/11) land in the ENGINE PR before the 2.0.0 cut, so 2.0.0's published rules cite this PR's test files. Run `VERIFY-ROOT t13-rules scripts/__tests__/rules-reference.test.ts`: it reads `node_modules/@seazn/engine` rows through the testkit and checks every non-engine proof path and its id token. It must be green on 2.0.0 here, not on someone's later bump. Any red row naming an app-B path is a defect in this PR (a missing file or a title without its id). A red row naming an app-A path goes to the orchestrator. Also run it at each batch end against the snapshot, if the snapshot already carries the rows: a red there is expected only for a task not yet done, and must be named.
  - the smoke guard tests (`scripts/__tests__/smoke-{paths,select,manifest}.test.ts`), then `SMOKE_ONLY=w3SwissB npm run test:smoke`: 9/9 = `EXPECTED_CHECKS`.
- [ ] **Step 4: PR body:**
  - the Matrix rows line (Global Constraints, R27);
  - "Paired with onryde/seazn.club.engine#<N>; engine 2.0.0 release <link>";
  - the owner's merge-order answer, in their words;
  - "Data changes" (Task 2's delta, Task 0's counts);
  - "Epoch: boardgame 4→5; web pad unaffected; native clients on engine 1.x get 426 for boardgame (ENGINE_EPOCH_FLOOR_OVERRIDE is the lever)";
  - Task 11's re-derived spec list;
  - Task 12's judge lines and per-cell triage;
  - the rule-id table below;
  - the Claude Code line.
- [ ] **Step 5: Dispatch** `gh workflow run e2e.yml --ref feat/w3-swiss-app-b -f pr=<N>` and hand back. Judge these as whole files: `w3-swiss-app-b.spec.ts`, `w3-swiss-app-a.spec.ts`, `formats.spec.ts`, `swiss-shell.spec.ts`, `swiss-legend.spec.ts`, `slideshow-pts-ratio.spec.ts`, `standings-*.spec.ts`, `walkthrough/swiss-round-one-pairing.spec.ts` and `mobile.spec.ts`. A serial file's red count is a floor.
- [ ] **Step 6:** A final Opus `reviewer` pass over the whole branch answers the four questions per change. Then the per-screen visual sign-off on the Artifact. Merge only on the owner's explicit go.
- [ ] **Step 6b: Post-deploy stg check (M6), after the owner deploys this PR to stg (Task 2's delta runs pre-deploy).** Drive it through the product on stg, by hand or browser, and record what you SAW on the Artifact (class 5: a read is not a run):
  - Create a boardgame (chess) Swiss with an odd field (5 players, 3 rounds). Pair round 1, so a bye is awarded.
  - The standings show the bye holder on the declared win points (X-SW-5, rulebook §4), with no forfeit row and no bonus. Score round 1 and check that the table equals the rulebook's hand values.
  - The stored config has no `byeScore`. Standing stg read, URL via env only: count `byeScore` in the five places (Task 0 count 2's SQL) = 0, and the new division's `divisions.config` and `stages.config` carry none.
  - No 426: the web pad scores a boardgame board on stg without `ENGINE_OUTDATED`, and `POST …/score` with no `engine_epoch` returns 2xx. Separately, a request carrying `engine_epoch: foldEpochOf("boardgame") − 1` returns 426, proving the gate is live and not bypassed.
  - Any miss: STOP before merge and report it.
- [ ] **Step 7:** Append "W3 App B" status, findings and premises to `_INDEX.md` (status sections, not rulings). Hand the rule-id table to the engine close-out (engine plan Task 12 Step 2).

---

## Batches

| Batch | Tasks | Why together | Parallel? |
|---|---|---|---|
| 0 | T0 | Owner decision, snapshot and live data first | — |
| 1 | T1, then T2 ‖ T3 | Compiles against the snapshot (override only); epoch steps; labels | T2 and T3 disjoint after T1 |
| 2 | T4–T6 | SW-H1 desk; score groups from table points; harness | Sequential (`swissGen`, wire shape, fake driver) |
| 3 | T7–T8 | Look-ahead and topscorer (needs T5's scores and rule); art. 16 inputs | Sequential (`swissGen`, `competition.ts`) |
| 4 | T9–T10 | Display, then the browser flow that reads it | Sequential |
| 5 | T11, T12, T13 | Spec re-derivation, retirement on the final tree, re-pin | Sequential |

Each batch ends with an Opus `reviewer` pass, a push, an e2e dispatch and a hand-back.

## Decisions to confirm with the owner (recommendations, not rulings)

1. **Merge order (Task 0 Step 2), PENDING OWNER.** Recommend flow A, paired PRs: this PR installs the snapshot through a `pnpm-workspace.yaml` override. `downstream` is not a required check, so the engine PR merges over its red once this PR is green on the snapshot, with this PR linked in the engine PR body. The red cannot be fixed from any app branch, because the job builds app main.
1b. **Release order (Task 0 Step 1).** Engine 1.1.0 (#6) ships, and the app moves onto it, before 2.0.0. If not, the owner decides whether app-B waits.
2. **Pairing score = the table's points, exactly (Task 5).** Legacy implicit byes (no bye row, `swiss_first_round` null) then score 0 in the groups, as the table already scores them, instead of app-A's kept +1. Recommend yes, per RB3-9 "one number". Only the next Pair changes; past pairings stand (§7).
3. **Every seated round with no seat is an absence (Task 8)**, a legacy implicit bye included, which becomes a zero-point VUR in Buchholz. Recommend yes: it is what the table already pays, and FIDE 16.2.5 is its category.
4. **Re-derived specs (Task 11)** under the skill's "never edit a spec to pass a bump". Recommend accepting the listed, ruling-cited edits: this is a behaviour release, not a plain bump.
5. **Slideshow layout option A** (two tie-break columns), Task 9.

## Premises found false or stale (to `_INDEX.md` "False premises found")

1. The skill's bump diff "only those lines plus `pnpm-lock.yaml`" (`SKILL.md:39`) did not hold at planning time. Four tests pinned the manifest spec verbatim (`registry-install.test.ts:22`, `engine-package-identity.test.ts:13`, `workspace-wiring.test.ts:138`, `toolchain.test.ts:357`). This was fixed by #1097 (`bde9e13180`): they now accept any caret release, so a bump is again just the manifests plus the lock.
2. The skill (`SKILL.md:64`, never pin a snapshot) and engine `AGENTS.md:27-29` ("the app PR pins that exact version") read as if they disagree. The mechanism that reconciles them: a snapshot is installed ONLY through a `pnpm-workspace.yaml` `overrides:` entry keyed on the alias, so no manifest ever pins one. The AGENTS.md wording is what led the first draft of this plan to edit manifests.
3. A green paired app PR cannot green the engine's `downstream` job: it builds seazn.club **main** with the snapshot injected (`ci.yml:332-333,388-402`).
4. No document names "the epoch-migration steps" (`SKILL.md:40`, engine AGENTS.md). Derived here: V481's stored-config cleanup shape plus the 426 gate. Nothing in storage is keyed by epoch.
5. The harness records a REFUSED Swiss generate as `seated: 0` (`scenarios/common.ts:797-805`), and I4 calls it "paired nobody (SW-H1)" (`invariants.ts:300`). The SW-H1 fix alone would not clear ruling 70's cells.
6. `RULING_70_IDS` also validates a second, historical `ruling70` block in `truth-runs/w1d-baseline/baseline.json`, which the byte-for-byte W1d backlog section depends on. "Delete the constant" needs that record handled first.
7. `swissGen` has no points rule in hand (`stages.ts:1253-1263`; only `rankedStageStandings` at `:1431`). The authority is `loadTableRules` (`table-rules.ts:270`) / `loadStageInputs`. And `rankedStageStandings` persists lots draws (`competition.ts:757-766`), so it is the wrong reader for scores.
8. Entrants carry no `withdrawn_at` and no round (`V212__entrants.sql:12-13`). Absent rounds must be derived from seats.
9. The public table already shows Buchholz whenever the cascade holds it (`tableColumns`). ST-G21's public half is delivered by the engine's chain change; only the slideshow drops metric columns.
10. The brief's "score groups via `swissDrawPoints`": a per-fixture formula would be a second authority beside the table. `swissDrawPoints` is used only in the matrix twin and in test derivations.
11. After W3's guards (app-A's round caps, the engine's bye retry, complete search and look-ahead), no UI path reaches `SWISS_NO_LEGAL_PAIRING` deterministically. Its e2e seeds the history by SQL and keeps the real server and engine as the producer.
12. The matrix fake driver hard-codes swissGen's 1 / 0.5 scores (`model-fake-driver.ts:646-649`); it moves with Task 5.
13. The skill's "never edit a spec to make a bump pass" (`SKILL.md:46`) assumes a behaviour-free bump. This one changes behaviour by ruling (Task 11).

## Findings (not built here)

- The slideshow still cuts rows at 10 (`slideshow.tsx:343`), so a 16-player Swiss cut is not visible on the board. This is ST-G21's sibling, not its column gap. Route it to the owner.

## Rule-id table (for the engine close-out, Task 12 Step 2 of the engine plan)

| Id | Row (engine plan) | This PR's proving test(s) :: title token | Task |
|---|---|---|---|
| X-SW-3 | No legal pairing → named refusal (app surfacing) | `server/usecases/__tests__/swiss-no-legal-pairing.test.ts`, `lib/__tests__/swiss-no-pairing.test.ts`, `components/v2/__tests__/stages-panel-swiss-pairing.test.tsx` :: `X-SW-3` | 1, 4 |
| X-SW-26 | "Finish the Swiss now" (offered by the refusal) | `swiss-no-legal-pairing.test.ts` :: `X-SW-26` (plus app-A's `swiss-finish-now.test.ts`) | 4 |
| X-SW-10 | Look-ahead above the safe maximum (app warning) | `server/usecases/__tests__/swiss-look-ahead.test.ts`, `components/v2/__tests__/stages-panel-swiss-pairing.test.tsx` :: `X-SW-10` | 7 |
| X-SW-11 | Topscorer exception (app input) | `swiss-look-ahead.test.ts` :: `X-SW-11` | 7 |
| X-SW-19 | Pairing score groups use the stage's table points | `server/usecases/__tests__/swiss-score-groups.test.ts` :: `X-SW-19` | 5 |
| X-SW-7 | art. 16 unplayed rounds (app producer: `unplayed`, withdrawal adjust) | `server/engine-db/__tests__/swiss-art16-producer.test.ts` :: `X-SW-7` | 8 |
| X-SW-8 | Late entrant's missed rounds (app producer: `swissAbsentRounds`) | `swiss-art16-producer.test.ts`, `server/engine-db/__tests__/swiss-absent-rounds.test.ts` :: `X-SW-8` | 8 |
| X-SW-6 | `byeScore` removed (stored-config cleanup) | `server/__tests__/w3-migration.test.ts`, `server/usecases/__tests__/division-locks.test.ts` :: `X-SW-6` | 1, 2 |
| (X-SW-12) | Late entry cases (a)/(b)/(c) | NOT cited from this PR. Its proof paths are app-A's unit tests. `e2e/w3-swiss-app-b.spec.ts` carries the token only as extra browser evidence | 10 |

X-SW-5 (bye = win points) and X-SW-9 / BD-TB-2 (chains) are engine rows whose app evidence is re-derived in Task 1 and driven in Task 10. They need no app proof path. Never put `-KO-` in an id.

**M9: the ids whose released rows cite THIS PR's tests.** Every one of these must have its cited file in this PR, with a test title carrying the id as a whole token, before Task 13's `rules-reference.test.ts` run: **X-SW-3, X-SW-6, X-SW-7, X-SW-8, X-SW-10, X-SW-11, X-SW-19, X-SW-26**.
- The cited paths are the ones in the table above. They are a contract with the engine close-out, which lands them in 2.0.0's rows before this PR merges.
- An executor never renames or moves a cited file and never drops an id from a title. If one has to move, the orchestrator amends the engine row first.
- Hand this list and the table to the engine close-out (engine plan Task 12) as soon as Batch 1 opens the draft PR, not at Task 13.
