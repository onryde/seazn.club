# Format × Sport Matrix — W1c (browser layers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The scenario scripts that run over HTTP also run in a real browser. W1c adds a `BrowserDriver` (organiser page objects plus one pad adapter per sport, 11 in all) behind the existing `OrganiserDriver` seam. It adds the L1 and L2 planners, a pad-proof set that drives every sport's real pad to a finalized result, a parity check against the HTTP run, and the five W1b carries. What an organiser gets: a green cell was clicked, not just posted.

**Architecture** (ruling 37, 2026-09-29):
- **One runner.** `BrowserDriver` lives in `scripts/matrix/lib/driver/` and uses the Playwright *library* (`import { chromium } from "playwright"`, as `scripts/bench/lib/tap-play.ts:18` already does). `run.ts` selects it with `--driver browser`. L1 and L2 reuse L3's planner seam, scenarios, invariants, `decideState`, `results.json` and `MATRIX.md`.
- **Mixed driver** (ruling 15). `BrowserDriver` wraps an `HttpDriver`. The first call of each organiser action type goes through the browser; later calls, reads and filler fixtures go over HTTP. Every browser action waits on the product's own response to the request the UI made, and returns that JSON. The scenario therefore sees the same shapes, and the same `RefusedCall`s, as over HTTP.
- **Pads replay the generated events** (ruling 38). Each matrix pad adapter implements the bench's `TapAdapter` shape (`scripts/bench/lib/drivers/scorer.ts:282`): one generated event becomes a list of taps, and the product must then hold one ledger row with that event's payload (a per-adapter allowlist of tolerated extra keys, as the bench's generic adapter keeps). The set-based pads write the coarse `*.summary` event through their `setScore` tile (`badminton.tsx:909,1036-1050`), so the one-for-one replay the bench proved for generic extends to them. An event type the pad cannot write one-for-one (cricket's non-partial innings summary; football's goal minute) is declared a **fallback** per adapter: the adapter taps the pad's own route to the same result (cricket: over summaries then the close), states how many rows that writes, and those rows are judged by the engine fold instead of by payload. The scenario folds what the product stored.
- **Borrowed, not rebuilt** (ruling 38). From the bench: the ledger reader (`ledger.ts`), the sport-blind tap vocabulary and chassis testids (`scorer.ts`), the generic adapter, and the consent/device-link/start-row helpers (`tap-play.ts`). The bench's private `executeStep` is copied. Its match loop (`playMatchByTaps`, `createTapPlayer`) is not used: it fixes the widths and always finalizes.
- **Browser checks join the case.** UI-vs-API agreement, builder output against the harness's bodies, visual evidence and mixed-driver coverage are `CheckResult`s. They merge into the case's checks, so `decideState` judges them with everything else.

**Tech Stack:**
- Node 26 `--experimental-strip-types`: no enums, namespaces or parameter properties; `.ts` import suffixes.
- TypeScript 7 (`typescript-native`) via `tsconfig.scripts.json`.
- vitest 4 via `packages/engine`'s binary.
- zod 4.
- Playwright 1.61.1: the root `playwright` package (`package.json:73`), chromium only.
- pnpm 10.

**Spec:** `docs/superpowers/specs/2026-09-27-format-matrix-design.md`, sections §3 (API-only rows), §6.1, §6.2, §6.4, §10 steps 4, 5 and 7, and §11 O3.
- Prompt: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/W1c-browser-layers.md`.
- `_RULES.md`: R10–R20 and R22–R25.
- `_INDEX.md`: rulings 4, 7, 15, 19, 28, 36 and 37; the W1b session status; "Findings routed (W1b)"; the Recommendations "For W1c" line.
- `docs/superpowers/TEST-STRATEGY.md`: the house test authority.
- `AGENTS.md`: "The phone composition", and failure classes 1, 2, 10, 19–22.
- House style follows `docs/superpowers/plans/2026-09-28-format-matrix-w1b.md`.

Where the spec and the tree disagree, see **False premises found in planning** below. The tree wins.

---

## Step 0 — anchors (pinned 2026-09-29 against `fce1ccdbf`, main after #903)

| Fact | Where |
|---|---|
| `OrganiserDriver`: 20 methods + `callCount` | `scripts/matrix/lib/driver/types.ts:61-90` |
| `RefusedCall(method, path, status, code, message, featureKey)`, no `extra` | `scripts/matrix/lib/driver/types.ts:115-130` |
| `PostedEvent {seq, status, outcome, event_id, retried?}` | `scripts/matrix/lib/driver/types.ts:31-36` |
| `HttpDriver` class, private `#send` / `#call` | `scripts/matrix/lib/driver/http-driver.ts:60,85,109` |
| `RunDeps.driverFor(base, session, orgId)`; real = `new HttpDriver(...)` | `scripts/matrix/run.ts:103,580` |
| `runCase` merges invariants + scenario assertions, then `decideState` | `scripts/matrix/run.ts:312-356` |
| `parseCli` options: base, run-id, report-dir, only, scenario, canary, set | `scripts/matrix/run.ts:250-270` |
| `SETS = { "w1b-probe": probePlanner }` | `scripts/matrix/run.ts:147` |
| `RunResults.schemaVersion: 2`; `RunResultsSchema` strict | `scripts/matrix/lib/results.ts:59-68,97-105` |
| `decideState` never yields `no_path` / `not_run` | `scripts/matrix/lib/results.ts:113-126` |
| `ScenarioKey = "LIFECYCLE" \| "M1" \| "R4" \| "F1" \| "DENIED"` | `scripts/matrix/lib/scenarios/types.ts:9` |
| `setUpDivision` defers ladder/americano/mexicano, multi-stage, team kind to W1-driving | `scripts/matrix/lib/scenarios/common.ts:95-101` |
| `decideFixture` folds the GENERATED stream locally and posts via `postStream` | `scripts/matrix/lib/scenarios/common.ts:156-195` |
| `finishStage` reads `finalRanks` from `completeStage`'s `events` | `scripts/matrix/lib/scenarios/common.ts:274-285` |
| Set-based generators emit coarse `${sport}.game.summary` / `volleyball.set.summary` `{home, away}` | `scripts/matrix/lib/streams/setbased.ts:9,25-43` |
| `L2Run {n, scenario, row, sport, preset, bound, width, covers, l3Gap}`; `L2_WIDTHS` | `scripts/matrix/lib/pairs.ts:22-37` |
| `HARNESS_SCENARIO = {LIFECYCLE, M1, R4a:"R4", F1}` | `scripts/matrix/lib/scenario-catalogue.ts:188` |
| `KNOWN_NO_PATH` (by parent) / `KNOWN_UI_NO_PATH` (by atom) | `scripts/matrix/lib/scenario-catalogue.ts:144,149` |
| `RegressionSchema` has one `fence`, no `maxCommands`, no fences on/off | `scripts/matrix/lib/scenario-catalogue.ts:224-248`; `scripts/matrix/model.ts:303-311,341` |
| `fedCandidates` takes the structural superset | `scripts/matrix/lib/model/state.ts:162-175`; used `lib/model/commands.ts:73-74` |
| Flat `timeout: 60_000` spawns | `scripts/matrix/__tests__/ci-wiring.test.ts:314`, `workspace-wiring.test.ts:113` |
| `SPAWN_MS = 25_000`, `spawnBudget(n)` | `scripts/matrix/__tests__/spawn-budget.ts:13,25` |
| `crash-exit.ts` preload; a bare `node` load crash still exits 1 | `scripts/matrix/lib/crash-exit.ts:1-20`; `package.json:17-21,40` |
| Reference gate: `TOKENS` owners flagged only as member-read owners | `scripts/reference-boundary.ts:78,241-253` |
| Harness import gate: relative imports into `apps/web` limited to 2 files; bare packages unrestricted | `scripts/matrix/__tests__/boundary.test.ts:15-17,58` |
| `BUILDER_DEFAULT_KNOBS {qualified 4, swissRounds 5, poolCount 2, legs 1}` | `scripts/matrix/lib/catalogue.ts:43-48` |
| `API_ONLY_ROWS`: group_only, group_group_ko, knockout_third_place, page_playoff_only, stepladder_only | `scripts/matrix/lib/catalogue.ts:27-29` |
| Template labels `format.template.<key>.label` (flat keys) | `apps/web/src/dictionaries/en/ui.json` |
| Playwright widths 320×568, 360×800, 375×667, 390×844, 430×932, 768×1024, 834×1194 | `apps/web/playwright.config.ts:190-262` |
| Magic-link e2e sign-in, onboarding completion, consent localStorage | `apps/web/e2e/auth.setup.ts:26-73` |
| `HOLD_MS_DEFAULT = 10_000`; env `NEXT_PUBLIC_SCOREPAD_HOLD_MS` (build-baked); `MIN_HOLD_MS 500` | `apps/web/src/components/v2/scorepad/queue.ts:150,154,171,195` |
| Double-submit window 250 ms; human repeat 350 ms | `apps/web/src/components/v2/scorepad/use-pad-pipeline.ts:364,384` |
| Every sport renders on the v3 pad (`V3_SKINS`) | `apps/web/src/components/v2/scorepad/v3/registry.ts:101-140` |
| Bench tap vocabulary: `TapStep` `:104-130`, `selectorForTapStep` `:140`, chassis testids `:165-176`, `TAP_PACING_MS` `:185`, `PadPage` `:220`, `TapAdapter` `:282`, `organiserStepsFor` `:322`; private `executeStep` `:232-264` | `scripts/bench/lib/drivers/scorer.ts` |
| `playMatchByTaps` forces the organiser to 1280 (`:674`) and always finalizes (`:765-775`) — not used | `scripts/bench/lib/drivers/scorer.ts:643-799` |
| `genericAdapter` (the bench's only adapter); win-loss draw throws | `scripts/bench/lib/drivers/adapters/generic.ts:166-170,214` |
| `fetchFixtureLedger` (exclusive `since_seq`), `fetchFixtureStatus`, `LedgerRow`, `LedgerTransport`; closure = ledger + http | `scripts/bench/lib/ledger.ts:27,72,125,145` |
| `seedConsent`/`CONSENT_SEED` `:59-68`, `devicePadUrl` `:112`, `DEVICE_HANDOVER_SELECTOR` `:87`, `DEVICE_LINK_MINT_TESTID` `:89`, `waitForStartRow` `:475`, `reloadConsoleBeforeAction` `:456`; `createTapPlayer` fixes the scorer at 390 (`:659`) and refuses an organiser < 768 (`:618`) — not used | `scripts/bench/lib/tap-play.ts` |
| Set-based pads write `*.summary` through tile `setScore` (offered when `!gameInProgress`, phase live) | `apps/web/src/components/v2/scorepad/v3/skins/badminton.tsx:909,950,1036-1050`; `tabletennis.tsx:757`; `volleyball.tsx:921` |
| Roster seeding precedent: `POST /persons`, entrants with `members`, `PUT /fixtures/:id/lineups/:entrantId` | `apps/web/e2e/helpers.ts:2098-2233` |

Organiser UI facts (component:line, testid) are in the task that uses them. The full scout tables are reproduced in **Appendix A** (organiser UI) and **Appendix B** (pads), so an implementer who sees one task still has them.

Before building on any line above, the executor pins it again (AGENTS class 5). A line that has moved is a note in the task report, not a blocker.

---

## Global Constraints

- **Worktree and branch.**
  - Execution gets its own worktree off `origin/main`: `/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1c-exec`, branch `feat/format-matrix-w1c` (Task 1 Step 0). The planning worktree `format-matrix-w1c` (branch `docs/format-matrix-w1c-plan`) is not used for execution; its commits (ruling 37, this plan) are cherry-picked onto the exec branch in Task 1 Step 0.
  - Every shell command starts `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1c-exec && …`, because cwd resets between calls.
  - Cherry-pick, never rebase. Never edit the main checkout. Never `git stash`: the stash stack is shared.
  - No heredocs. Write commit messages with the editor tool into `$TMPDIR/w1c-msg.txt`, then `git commit -F "$TMPDIR/w1c-msg.txt" -- <paths>`.
  - Every message ends with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **pnpm, never npm install.** A fresh worktree has no `node_modules`, so run `pnpm install --frozen-lockfile` first. No task changes the lockfile: `playwright` is already a root dependency.
  - Chromium: `cd <worktree> && pnpm exec playwright install chromium` (Task 4 Step 0). A missing browser is an environment fault, never a product red.
- **Local verification = ONLY the tests that cover the files you changed** (owner, 2026-09-28). Never the full gate, the full vitest suite or the full e2e suite. W1c touches no `apps/web/e2e` spec, so no Playwright Test spec runs in this wave.
  - The vitest template, with `<N>` = the task number and `<files>` = the exact test paths:
    ```bash
    cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1c-exec && rm -f "$TMPDIR/w1c-t<N>.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w1c-t<N>.json" --testTimeout=30000 <files>; echo EXIT=$?
    cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1c-exec && node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const files=r.testResults.map(t=>t.name);const bad=files.filter(f=>!f.startsWith(process.argv[2]));console.log(JSON.stringify({total:r.numTotalTests,passed:r.numPassedTests,failed:r.numFailedTests,failedSuites:r.numFailedTestSuites,files:files.length,stray:bad}))' "$TMPDIR/w1c-t<N>.json" "$PWD/"
    ```
  - Green means all of: `failed == 0`; `failedSuites == 0`; `passed == total > 0`; `files` equals the number of paths passed; `stray` is empty. Paste the JSON line into the task report and pin `total`.
  - `packages/reference` tests run from that package: `cd <worktree>/packages/reference && ../engine/node_modules/.bin/vitest run --reporter=json --outputFile=… <files>`, judged the same way.
  - Never trust `rtk` summaries: `PASS(0) FAIL(0)` is a suite that failed to collect.
- **tsc and eslint on changed files only.**
  - Scoped tsc: with the Write tool create `$TMPDIR/w1c-tsc-<N>.json`:
    ```json
    {"extends":"/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1c-exec/tsconfig.scripts.json","include":[],"files":[<absolute changed .ts paths>],"compilerOptions":{"incremental":false,"typeRoots":["/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1c-exec/node_modules/@types"]}}
    ```
    then `cd <worktree> && rtk proxy node node_modules/typescript-native/bin/tsc -p "$TMPDIR/w1c-tsc-<N>.json"; echo EXIT=$?`.
  - eslint: `cd <worktree> && rtk proxy ./node_modules/.bin/eslint <changed scripts/ files>; echo EXIT=$?`. Empty output is clean only with `EXIT=0`.
- **`grep -a` always.**
- **Strip-types rules.** No `enum`, `namespace` or constructor parameter properties. Error subclasses assign fields in the constructor body. Every relative import carries `.ts`. `scripts/matrix/__tests__/strip-types-loadable.test.ts` spawns node against every shipped module; extend its list with each new module.
- **Boundary** (R3; `scripts/matrix/__tests__/boundary.test.ts`):
  - From `scripts/bench/lib/` the allowed imports become `http.ts`, `plan.ts`, `env.ts` **plus** (ruling 38) `ledger.ts`, `drivers/scorer.ts`, `drivers/adapters/generic.ts` and `tap-play.ts`. From `scorer.ts` and `tap-play.ts` only the named sport-blind exports may be imported; `playMatchByTaps`, `createTapPlayer` and `browserTapPlayer` are refused by name (Task 4 Step 17). The bench's private `executeStep` is copied into `lib/pads/execute.ts` with a comment naming its source line. This programme never edits a bench file (R3).
  - From `apps/web` the only allowed relative imports stay `format-templates.ts` and `match-rules.ts`. Selectors and copy are **read as text** by DB-free pin tests (Task 4), never imported.
  - `playwright` is a bare package import (allowed). No module under `lib/` except `lib/browser/**`, `lib/pads/**` and `lib/driver/browser-driver.ts` may import it; Task 4 adds that rule to `boundary.test.ts`, so the L3 path never loads a browser.
- **No product changes** (recommendation D4 below). W1c changes nothing under `apps/web/**` or `packages/engine/**`. A product red found by a browser run is a FINDING recorded in `_INDEX.md` and routed, never fixed here.
- **Do not touch** `scripts/bench/**`, `.github/workflows/e2e.yml`, `apps/web/playwright.config.ts` or any `apps/web/e2e/**` file. W1d owns CI wiring for L1/L2.
- **Test authority** (`TEST-STRATEGY.md`, R9, R13, R25, R28):
  - Before writing tests, list the change's state transitions and its empty case, and test both.
  - Every check, sweep and planner reports how many items it checked; **zero checked is a failure**.
  - Expected values come from the engine (`sportModule(...).init/apply` folds, `supportsDraws`), the committed catalogue files, or the product's text (testids, dictionary strings) read from source — never from the code under test.
  - "Cannot happen" becomes a named refusal plus a test that reaches it.
- **Mutation** (R17). Each task's last test step lists `mutant → killing test`. Copy with `cp <file> "$TMPDIR/w1c-bak-<name>"`, mutate, run the named test file, see it red (pin `total`), restore with `cp "$TMPDIR/w1c-bak-<name>" <file>`. **Never** `git checkout <file>`.
- **Budgets are derived, never flat** (class 20). Every browser wait is `budgetMs(...)` from `lib/browser/budget.ts` (Task 4), expressed in `HOLD_MS`, the tap pace and a named slack. A flat `timeout:` literal in `lib/browser/**`, `lib/pads/**` or `browser-driver.ts` is refused by a scan test (Task 4).
- **Phone folds** (class 22). Open a fold only when its toggle is visible; wait on `toBeAttached`-style `state: "attached"`, never on visibility; open every instance.
- **Public repo** (R14a). Synthetic identities only (`delivered+matrix-<runId>@resend.dev`, "Matrix Player N", "Matrix Person N"). Screenshots show only synthetic data; the report directory stays under `matrix-report/` (gitignored) until Task 14 copies chosen evidence into `truth-runs/`. Every text writer goes through `redact()`; results still refuse on `findSecrets()`.
- **Live runs** (Tasks 7, 11, 14) follow `~/.claude/skills/seazn-local-env/SKILL.md`: fresh DB via `db:apply` + `sync:sports`; `BENCH_EXPECTED_DATA_DIR` = `show data_directory`; **no `REDIS_URL`**; PostHog and Sentry blanked; `AUTH_DEV_LINKS=1`; the prod build baked with `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` and the harness shell exporting the same value; `SMOKE_BASE=http://localhost:<port>` (never 127.0.0.1); a fresh run id; a clean tree before evidence runs.
- **Owner rulings are binding:** 15 (mixed driver), 19 (wave done), 23 as extended by 38, 28 (W1-driving), 29 (variants LIFECYCLE only), 36 (no browser check of the five W1b findings), 37 (runner-hosted `BrowserDriver`), 38 (bench tap helpers imported). The Decisions section's D1–D9 are the controller's RECOMMENDATIONS until the owner rules on them at plan review; never label them rulings (AGENTS class 17).

### The four test types, as they apply here

| Type | Meaning in W1c |
|---|---|
| Unit | Every pure piece is tested DB-free and browser-free under `scripts/matrix/__tests__/`: selector pins, budgets, the mixed-driver ledger, L1/L2 planners, results v3, parity, each pad adapter's event→taps routes (derived from `generateStream`'s own output), the replay's row comparison, and the stored-stream fold. |
| E2E / live | The browser runs against a real prod server: pad-proof (11 sports), L1 on the slice, L2 on the slice, the width sweep, the API-only rows (Tasks 7, 11, 14). |
| Smoke | The HTTP slice re-run at the W1c head: the 24 W1a cases stay ✅ (Task 14 Step 2), proving the carries and the v3 results did not move L3. |
| Regression | The five committed MB cases replay exactly under the new `maxCommands`/fences fields (Task 2); W1a/W1b suites stay green; the browser-vs-HTTP parity report is committed evidence (Task 14). |

---

## Review Focus

These are the five failure modes most likely to bite a person using this harness (the next wave's implementer, the owner reading `MATRIX.md`) that no functional test would exercise. Each one's pinning test sits in its owning task.

1. **A browser green that never clicked.** A page object that quietly falls back to HTTP (a selector miss caught and retried over the API) would report ✅ for a cell no organiser action reached. Expected: every organiser action type the case invoked has at least one browser execution recorded, or the case is red on `mixed-driver-coverage`. Pinned by `mixed-driver.test.ts` "a missing browser action reds by name" (Task 6).
2. **The pad writes something other than the generated event.** A tap that lands a different set score, or an extra key the product adds, changes point difference, so standings drift and parity reds for a harness reason. Expected: every pad-written ledger row equals its generated event (type and payload, less the adapter's declared tolerated keys), and the stored stream folds to the same outcome. Pinned by `pad-adapters.test.ts` "every adapter maps every event its generator emits, and refuses the rest by name" (Task 7) and the live `pad-ledger-as-generated` check (Task 7).
3. **A phone fold that hides a control on one width only.** The stage rail folds below 768 (`stage-rail-trigger`); a page object written at 1280 fails at 320 with a timeout that reads as a product defect. Expected: the rail opens when, and only when, its trigger is visible. Pinned by `page-objects.test.ts` "fold gate keys on trigger visibility, never width" (Task 5) and the live 320 L1 runs (Task 14).
4. **The UI answered from a different endpoint than the harness judges.** If a page object read its result from the DOM while the product had refused the call, the scenario would see success. Expected: every browser action resolves on the product's own response to the request the UI made; a non-2xx becomes the same `RefusedCall` HttpDriver throws. Pinned by `browser-driver.test.ts` "a refused UI action throws RefusedCall with the product's code" (Task 6).
5. **A vacuous visual gate** (class 10). Screenshots that were never written, or that are identical across states because nothing changed on screen, would sign off pictures of nothing. Expected: every declared shot exists, is non-empty, and each "must differ" pair differs by hash. Pinned by `evidence.test.ts` "a missing or identical shot reds visual-evidence" (Task 4).

---

## False premises found in planning

Each has file:line evidence. They go to `_INDEX.md` "False premises found" (Task 15).

1. **"The bench ships only a generic tap adapter"** (prompt, design §6.1; `audit-2026-09-27/bench-reuse.md:61-62,188`). True, but it undersells the bench: it also ships a hardened ledger reader, a sport-blind tap vocabulary pinned to the product, and consent/device-link/start-row helpers, all reusable (ruling 38). Its match loop is NOT reusable: `playMatchByTaps` forces the organiser to 1280 (`scorer.ts:674`) and always finalizes (`:765-775`), and `createTapPlayer` fixes the scorer at 390 (`tap-play.ts:659`). The bench also never drives the builder, Generate, Start or Withdraw in a browser, so the page objects are new work.
2. **"Every organiser action has a UI" (ruling 15's "standings/progression/final-ranks pages").** No organiser or public page lists final ranks past the champion (`app/(public)/shared/…/page.tsx:239`, champion banner only), and rank override has no UI (only `api/v1/stages/[id]/standings/override`). The organiser standings tab draws tables only for league, group and swiss (`d/[divSlug]/page.tsx:83`, `TABLE_KINDS`). See D6.
3. **"The builder saves stages with PUT"** (W1b's `replaceStagesProbe`). The builder's Create POSTs the division, then POSTs stages, then PUTs schedule settings (`division-builder.tsx:431,444,458`). Only Settings `apply-structure` PUTs (`division-settings.tsx:545`). In the browser `createDivision` and `postStages` are ONE organiser action (Task 6).
4. **"A pad adapter can score any sport's fixture the harness generates."** Cricket balls carry striker/non-striker/bowler and football goals a scorer on the pitch; the server refuses unknown persons (`apps/web/e2e/helpers.ts:2086-2092`). The harness has no team rosters (W1-driving, ruling 28; `common.ts:101`). The four team sports' adapters are proven by the pad-proof set with rosters seeded over HTTP (D3), not by L1.
5. **"L2 runs on the slice" proves the L2 framework.** Filtering the committed `l2-pairs.json` to the slice cells gives 68 runs (65 swiss|badminton, 2 swiss|generic, 1 knockout|badminton), and only **3** use an atom the harness has a script for (R4a n=70 @375, M1 n=414 @390, F1 n=788 @375, all swiss|badminton). The other 65 have no scenario script yet. See D5.
6. **No e2e spec presses `score-finalize`** (`fixture-console.tsx:1274`), and every pad walkthrough shortens the config with `setDivisionConfigSql` before Start (e.g. `walkthrough/scorepad-v3-badminton-match.spec.ts:179-186`). No browser test has ever played a builder-default match to finalized. The three name-sorted defaults — volleyball `beach`, carrom `club-29`, boardgame `blitz` — have no browser coverage at all (`e2e/v3-skin-catalog.ts:70,78,128` use indoor, icf, classical).
7. **`HOLD_MS` default vs the CI comment.** `queue.ts:150` sets 10 000 ms; `e2e.yml:418,1026,1354` still says 5 s. CI bakes 3 000, so CI is unaffected. The harness never waits a hold out: it taps `pad-send-now` when it appears (the copied `executeStep`'s `releaseHold`), and its budgets are expressed in the served value.
9. **Stale bench comment cites** (`tap-play.ts:86` → now `fixture-console.tsx:1018`; `:89` → now `device-link-panel.tsx:310`; `scorer.ts:764` → now `fixture-console.tsx:1274`). The bench's pins are presence scans, so nothing is red; recorded for the bench's index, not edited here (R3).
8. **`journey-pro.spec.ts:246` says `generic.result` is held 6 s.** A null dock sends immediately (`pad-host.tsx:1229-1241`). The generic adapter waits on the ledger, not on a hold.

---

## Decisions

**Ruled — 37 (2026-09-29):** `BrowserDriver` inside the matrix runner (Playwright library), not Playwright Test specs. Owner value: one verdict pipeline, so browser green and HTTP green mean the same check set; parity is a JSON diff; W1d shards L1/L2 like L3 without editing `e2e.yml`.

**Ruled — 38 (2026-09-29):** borrow the bench's tap helpers by import (`ledger.ts`; the sport-blind exports of `drivers/scorer.ts`; `genericAdapter`; the pure helpers of `tap-play.ts`), copy the private `executeStep`, and do not use `playMatchByTaps` / `createTapPlayer`. Extends ruling 23 (a second transitive pack-schema load, via `simulate.ts`). Owner value: one source for the tap vocabulary and its product pins.

**Recommendations for the owner's ruling at plan review** (not rulings; each is applied as written unless the owner rules otherwise):

**D1 — O3, widths.** L1 runs every cell at **1280 and 320**; L2 uses the committed rotation in `l2-pairs.json` (never re-planned, `_INDEX.md` Recommendations "For W1c"). W1c adds a one-off **width sweep**: `league|badminton` LIFECYCLE at the other six widths (360, 375, 390, 430, 768, 834).
- Owner value: 320 is the narrowest phone and every fold opens there; 1280 is the organiser's desk. The sweep proves each page object at the `md` breakpoint (768/834, where `md:hidden` toggles flip) before W1d's first full run, which would otherwise discover a broken page object on ~1,700 L2 runs at once.
- Cost: 462 L1 runs full-grid (as `counts.json` already states); the sweep is 6 runs, W1c only.
- Rejected: L1 at all seven widths (231 × 8 = 1,848 runs, four times the cost, and L2 already rotates the seven).

**D2 — pad adapters replay the generated events (bench `TapAdapter` shape, ruling 38).** For each generated event the adapter returns the taps that make the pad write it; the product must then hold one ledger row equal to it (less declared tolerated keys). An adapter whose pad cannot write an event type one-for-one declares a **fallback** for it: the pad's own route to the same result, its row count, and a file:line reason. Those rows are judged by the fold (`pad-outcome-as-requested`), not per payload; each such declaration is listed in `_INDEX.md`'s per-adapter table. `decideFixture` folds what the product stored.
- Owner value: the ledger a browser run leaves is the ledger the HTTP run leaves, so standings, parity and every invariant compare like with like; a pad that writes the wrong thing reds on its own row, named.
- Rejected: "tap to any win". Simpler, but a different scoreline changes the table, and every parity red would need a human to decide whether it was the harness.
- The console pad is the organiser's own pad, and it is what L1/L2 drive at every width. The phone rule that hides the scoring card (`fixture-console.tsx:745,1009`, `consoleScoringEmptyOnPhone = started && !(scorePadV2 && mountPad) && …`) applies only while NO pad is mounted, so a live fixture's pad stays on screen at 320. Task 7 Step 0 confirms this in a browser at 320 before the adapters are built. If that premise is false, the stop is recorded and the owner is asked; the plan does not quietly switch to the device-link hand-over, because that is a different product path (it needs `scoring.device_links`, and the scorer is anonymous).

**D3 — the pad-proof set.** `--set pad-proof` plans one case per sport that has a pad adapter, in registry order: a **3-entrant league** at the builder-default variant and length (no config shortening), with outcomes home win, then a draw where the sport's default allows one on a league (away win otherwise), then away win. Every fixture is scored on the pad and then **finalized with `score-finalize`**. Each is read back as `finalized` with its requested outcome, and the stage completes. Rosters are seeded over HTTP only for a sport whose pad refuses without them (Tasks 10–11 Step 0 decide). They are always full size, because a short lineup changes cricket's all-out and so changes what the same stream means.
- Owner value: the first browser coverage of the beach, club-29 and blitz defaults, of a full-length builder-default match, and of the organiser's Finalize button (false premise 6). W1d learns exactly which sports' L1 cells can run.
- Rejected: proving adapters only through L1. The slice has two sports, and four team sports cannot run L1 until W1-driving seeds rosters.

**D4 — no product changes; selectors are pinned text.** W1c adds no testids to `apps/web`. It uses existing testids, and for controls with none (template radios, "Add entrant", "Import CSV", the withdraw confirm) the en accessible name. Every selector is text-pinned by a DB-free test that reads the product source or `dictionaries/en/*.json`, so a copy or testid change reds CI, not a live run hours later. Browser contexts run with locale `en`.
- Owner value: the harness proves the product as shipped, and the wave does not touch files W2–W9 are about to edit.
- Rejected: adding ~6 testids now. Invisible to users, but it puts `apps/web` edits in a harness wave. A later wave that touches those controls can add them.

**D5 — L2 on the slice is 68 runs, 3 executed.** The 3 runs with a harness script execute in the browser. The atoms with a known path gap (`knownNoPath` / `l2NoPath`) record 🚫 naming their wave. Every other run records ░ `not_run` with the reason "no scenario script yet". W1c does not write new scenario scripts.
- Owner value: the L2 framework is proven on the committed file, with honest states for the rest, and no L2 run is silently dropped (R13).
- Rejected: writing scenario scripts for the 65 in W1c. Those are the family waves' truth-run work (§10 step 3).

**D6 — final ranks with no page.** The browser checks rank 1 against the public page's champion banner (`ui-champion-shown`) and the organiser standings table where one exists (`ui-standings-match`). Ranks 2..n have no page; that is recorded as a FINDING in `_INDEX.md` routed to **W4** (brackets) and **W7** (ladder, americano, mexicano), not as a failing check.
- Owner value: the slice's knockout cells can go green on what the product does show, and the missing placement page is still on a wave's backlog instead of ❌ on every bracket cell forever.
- Rejected: a failing `ui-final-ranks` check on every bracket cell.

**D7 — API-only rows.** Created over HTTP, then driven in the browser from Generate onward. Each case carries a failing `organiser-ui-path` check naming the owning wave from design §8: `knockout_third_place`, `page_playoff_only`, `stepladder_only` → **W4**; `group_only`, `group_group_ko` → **W5**. This follows the prompt ("recorded as a ❌ routed to its named wave") and ruling 19. The two cells a catalog template does reach (`group_only × badminton` via `template-card-box-league`, `group_group_ko × cricket` via `template-card-t20-super8`) record `organiser-ui-path` **abstain** "reachable only through catalog template <key>; driving it → W1-driving", not ❌. The organiser does have a path, and W1c does not drive the template gallery (the template path and team seeding are W1-driving's).

**D8 — no horizontal page scroll is a check.** `no-horizontal-scroll` runs at every captured state (the house UI bar). A red is a product finding routed at triage by surface.

**D9 — results schema v3.** Every case records `layer` (`L1`/`L2`/`L3`), `driver` (`http`/`browser`) and `width` (null for HTTP). `parseResults` still reads committed v2 evidence.

---
## File Structure

```
scripts/reference-boundary.ts                 (T1)  alias rule for the nondeterministic globals
packages/reference/test/boundary-gate.test.ts (T1)  alias cases
scripts/matrix/
  lib/scenario-catalogue.ts        (T2)  RegressionSchema + maxCommands, fencesOn
  catalogue/regressions.json       (T2)  the 5 MB cases gain both fields
  model.ts                         (T2)  --regressions replays with each case's own maxCommands/fencesOn
  lib/driver/types.ts              (T2,T6,T7) RefusedCall.extra; PostedEvent.event; OrganiserDriver.finalize?/rosters?
  lib/driver/http-driver.ts        (T2,T6,T7) extra from the envelope; finalize; ledger(fixtureId) via bench ledger.ts; rosters
  lib/model/state.ts               (T2)  fedCandidates reads extra.next_match.fixture_id first
  __tests__/ci-wiring.test.ts      (T2)  spawn caps from spawn-budget.ts
  __tests__/workspace-wiring.test.ts (T2) spawn caps from spawn-budget.ts
  __tests__/cli-invocation.test.ts (T2)  every documented CLI call goes through the package script (carry e)
  lib/results.ts                   (T3)  schema v3 (layer, driver, width); decideState noPath / notRun
  lib/render-matrix.ts             (T3)  reads v2 and v3
  lib/browser/budget.ts            (T4)  budgetMs, TAP_PACE_MS, holdMsFromEnv
  lib/browser/viewports.ts         (T4)  width → viewport (pinned to playwright.config.ts)
  lib/browser/selectors.ts         (T4)  TESTID / NAME tables, each with its source pin
  lib/browser/session.ts           (T4)  launch, per-case context (cookies, bench seedConsent/CONSENT_SEED, locale en, viewport)
  lib/browser/evidence.ts          (T4)  shots, hashes, must-differ pairs, no-horizontal-scroll → CheckResult
  lib/browser/respond.ts           (T4)  actAndAwait: click + the product's own response → data | RefusedCall
  lib/browser/pages/*.ts           (T5)  competition, division-builder, entrants, launch, stage-rail,
                                         run-sheet, fixture-console, standings, public-division
  lib/driver/browser-driver.ts     (T6)  BrowserDriver implements OrganiserDriver
  lib/driver/mixed.ts              (T6)  ActionType, MixedLedger, mixedDriverCoverage()
  lib/pads/types.ts                (T7)  MatrixPadAdapter = bench TapAdapter + routes table + fallback declarations
  lib/pads/execute.ts              (T4)  COPY of bench scorer.ts:232-268 executeStep/executeSteps (source line cited)
  lib/pads/replay.ts               (T7)  replayEvents: one event → steps → one ledger row, exact payload compare
  lib/pads/{generic,badminton}.ts  (T7)  generic wraps bench genericAdapter (+ win_loss draw route)
  lib/pads/{tabletennis,volleyball,tennis}.ts (T9)
  lib/pads/{football,hockey,icehockey}.ts     (T10)
  lib/pads/{cricket,boardgame,carrom}.ts      (T11)
  lib/pads/index.ts                (T7…T11) PAD_ADAPTERS in registry order
  lib/scenarios/pad-proof.ts       (T7)  PADPROOF scenario (3 entrants, every fixture on the pad, finalized)
  lib/scenarios/rosters.ts         (T7)  minimal persons + lineups for team-kind sports
  lib/scenarios/common.ts          (T7)  decideFixture folds the STORED stream when the driver returns it
  lib/pad-proof-set.ts             (T7)  --set pad-proof planner
  lib/layers.ts                    (T12) L1 planner, L2 planner (filters l2-pairs.json), width-sweep, api-only sets
  run.ts                           (T3,T6,T12) --driver, --width, --layer; v3 results; browser lifecycle
  parity.ts + lib/parity.ts        (T13) HTTP vs browser verdict diff CLI
  lib/driver/padpage-assignability.ts (T7) compile-time proof: a Playwright Page is a bench PadPage (tsc -p tsconfig.scripts.json)
  __tests__/boundary.test.ts       (T4)  ALLOWED_BENCH + 4 files; named-export refusals (ruling 38)
  __tests__/…                      one test file per module above (named in each task)
package.json                       (T6,T13) matrix:browser, matrix:parity scripts
docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md      (T8,T11,T14,T15)
docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1c-*/ (T8,T11,T14) evidence
```

Every new `scripts/matrix/**` test file is picked up by the existing strict CI matrix step (`ci.yml:197-241`), which fails on zero tests, failed suites, passed ≠ total and stray files. None of them launches a browser: the CI job has no chromium, and the tests are DB-free and browser-free by design.

---

## Task 1: Carry (a) — the reference gate refuses aliases of the nondeterministic globals

**Why:** W1b's gate flags `performance.now()` but passes `const p = performance; p.now()`, `const { now } = performance` and `Reflect.get(Date, "now")` (probe run 2026-09-29, scout A §11a). W3 writes the first reference family; the gate must hold before then.

**Files:**
- Modify: `scripts/reference-boundary.ts` (the `R` table `:48-68`; the identifier branch of `visit` `:249-253`)
- Test: `packages/reference/test/boundary-gate.test.ts`

**Interfaces:**
- Consumes: `TOKENS` (`:78`), `ownsMemberRead` (`:146`), `namesNoBinding` (`:140`), `judged(files)` test helper.
- Produces: a new reason `R.tokenAlias`; no signature change.

- [ ] **Step 0: Worktree** (first task of the wave).
  ```bash
  cd /Users/ashokhein/github/seazn.club && git fetch origin && git worktree add -b feat/format-matrix-w1c .claude/worktrees/format-matrix-w1c-exec origin/main && cd .claude/worktrees/format-matrix-w1c-exec && git cherry-pick <ruling-37 sha> <plan sha> && pnpm install --frozen-lockfile; echo EXIT=$?
  ```
  The two SHAs are the `docs/format-matrix-w1c-plan` commits (`git log --oneline origin/main..docs/format-matrix-w1c-plan`). Re-pin every Step 0 anchor above; record moves in the report.

- [ ] **Step 1: Write the failing test** — add to `boundary-gate.test.ts` beside the existing global-object case (`:365`):

```ts
  it("refused: a nondeterministic global named outside a member read — an alias would hide the read (W1b carry a)", () => {
    expect(judged({ "a.ts": [
      `const p = performance;`,
      `export const a = p.now();`,
      `const { now } = performance;`,
      `export const b = Reflect.get(Date, "now");`,
      `export const c = [Math][0].random();`,
      `const cr = crypto;`,
    ].join("\n") })).toEqual([
      `1 performance: ${TOKEN_ALIAS}`,
      `3 performance: ${TOKEN_ALIAS}`,
      `4 Date: ${TOKEN_ALIAS}`,
      `5 Math: ${TOKEN_ALIAS}`,
      `6 crypto: ${TOKEN_ALIAS}`,
    ]);
  });
  it("…while member reads the gate already judges stay as they were, and the harmless members stay allowed", () => {
    expect(judged({ "a.ts": [
      `export const a = Math.max(1, 2);`,
      `export const b = Date.UTC(2026, 0, 1);`,
      `export const c = (r: { performance: number }) => r.performance;`,
      `export const d = { Date: 1, Math: 2 };`,
      `export type T = typeof Math.PI;`,
    ].join("\n") })).toEqual([]);
    expect(judged({ "a.ts": `export const x = performance.now();` })).toEqual([`1 performance.now: ${TOKEN}`]);
  });
```

`TOKEN_ALIAS` is read from the gate's own exported reason table the same way the file already reads `TOKEN` and `GLOBAL_REF` (pin the existing pattern at the file's top). Empty case first: the "harmless" test's first expectation is `[]`, and it runs before any refusal in the file order.

- [ ] **Step 2: Run it — expect FAIL** (the first test's `toEqual` gets `[]`).
  `cd <worktree>/packages/reference && ../engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w1c-t1.json" test/boundary-gate.test.ts; echo EXIT=$?` then the JSON summary line. Expected `failed == 1`.

- [ ] **Step 3: Implement.** Add to `R`:

```ts
  tokenAlias: "a nondeterministic global (Date, Math, process, performance, crypto, Temporal) named outside a member read is refused — an alias or Reflect.get would hide a clock or entropy read",
```

In the identifier branch, after the `GLOBAL_OBJECTS` arm:

```ts
      // W1b carry (a): the owner of a TOKENS read may only appear AS that owner —
      // `performance.now()`. Bound to a name, destructured, or passed on
      // (`Reflect.get(Date, "now")`, `[Math][0]`), the gate can no longer see the read.
      else if (ts.isIdentifier(node) && TOKENS.has(node.text) && !ownsMemberRead(node) && !namesNoBinding(node) && !isTypePosition(node)) add(node.getStart(sf), node.text, R.tokenAlias);
```

`Date()` / `new Date` are handled before this branch via `handled`; add their callee node to `handled` in the call/new arm (`handled.add(nn)` when the Date arm fires) so the identifier branch does not report it twice. `isTypePosition(node)` is a new three-line helper: true when an ancestor before the nearest statement is a `TypeQueryNode`/`TypeReferenceNode` (`typeof Math.PI` in a type). Keep it next to `ownsMemberRead`.

- [ ] **Step 4: Run it — expect PASS**, and run the whole file (every earlier case still holds). Paste the JSON line; pin `total`.

- [ ] **Step 5: The real package stays clean.** `cd <worktree> && pnpm run reference:boundary; echo EXIT=$?` → `EXIT=0` and the scanned count > 0 (the existing "real package is clean" test also covers this).

- [ ] **Step 6: Mutation** (report each kill):
  - delete the new `else if` → killed by "refused: a nondeterministic global named outside…";
  - drop `!ownsMemberRead(node)` → killed by "…harmless members stay allowed" (`Math.max` flagged);
  - drop `!namesNoBinding(node)` → killed by the same test (`{ Date: 1 }`);
  - drop the `handled.add` for Date → killed by the existing `new Date` case (reported twice).

- [ ] **Step 7: Scoped tsc + eslint** on `scripts/reference-boundary.ts`; then commit:
  `fix(reference): gate refuses aliases of nondeterministic globals (W1b carry a)`.

---

## Task 2: Carries (b)–(e) — regression replay settings, the refusal's next match, spawn caps, CLI invocation

**Files:**
- Modify: `scripts/matrix/lib/scenario-catalogue.ts:224-248` (RegressionSchema), `scripts/matrix/catalogue/regressions.json`, `scripts/matrix/model.ts:300-345`
- Modify: `scripts/matrix/lib/driver/types.ts:115-130`, `scripts/matrix/lib/driver/http-driver.ts:47-53,99-107`, `scripts/matrix/lib/model/state.ts:162-175`
- Modify: `scripts/matrix/__tests__/ci-wiring.test.ts:314`, `scripts/matrix/__tests__/workspace-wiring.test.ts:113`
- Create: `scripts/matrix/__tests__/cli-invocation.test.ts`
- Test: `scripts/matrix/__tests__/scenario-catalogue.test.ts`, `model-cli.test.ts`, `http-driver.test.ts`, `model-core.test.ts`

**Interfaces:**
- Produces: `Regression.maxCommands: number`, `Regression.fencesOn: boolean`; `RefusedCall.extra: Readonly<Record<string, unknown>> | null` (7th constructor arg, default `null`); `nextMatchFixtureId(e: RefusedCall): string | null` exported from `types.ts`.

### (b) The regression case records how it was found

- [ ] **Step 1: Read the evidence for each MB case.** For each of MB-001…MB-005, open its run's report under `truth-runs/w1b-model*/` (`runId` in `regressions.json`) and read the settings the run used: `--max-commands` (default 30 in `model.ts`) and whether fences were on. Record the five pairs in the task report with the file:line each came from. A report that does not state them is a finding: record `null` is NOT allowed — derive it from the run's own CLI line in the report, or from `model.ts`'s defaults at the harness commit the report names, and say which.

- [ ] **Step 2: Failing tests.** In `scenario-catalogue.test.ts`:

```ts
  it("a regression case records how it was found: maxCommands (≥1) and fencesOn — without them replay guesses", () => {
    const base = { ...MB_FIXTURE }; // the file's existing valid fixture
    expect(() => parseRegressions([{ ...base }])).toThrow(/maxCommands/);
    expect(() => parseRegressions([{ ...base, maxCommands: 0, fencesOn: true }])).toThrow(/maxCommands/);
    expect(() => parseRegressions([{ ...base, maxCommands: 30 }])).toThrow(/fencesOn/);
    expect(parseRegressions([{ ...base, maxCommands: 30, fencesOn: false }])[0]).toMatchObject({ maxCommands: 30, fencesOn: false });
  });
```

In `model-cli.test.ts`, beside the existing `--regressions` replay test: a case committed with `maxCommands: 7, fencesOn: true` is replayed with exactly those (assert on the replay call's recorded options), and a second case with `maxCommands: 30, fencesOn: false` with those — two cases whose settings differ, so a replay that ignores them cannot pass both.

- [ ] **Step 3: Run — expect FAIL.**
- [ ] **Step 4: Implement.** Add to `RegressionSchema`:

```ts
  /** The command bound the finding run used (`--max-commands`). Replay uses it:
   *  a shorter bound may never reach the failing command (W1b carry b). */
  maxCommands: z.number().int().min(1),
  /** Whether the finding run had its fences on. Replay matches it. */
  fencesOn: z.boolean(),
```

Write both fields into the five cases from Step 1. In `model.ts`'s `--regressions` path replace the fixed `fences: false` (`:341`) and the default command bound with the case's `fencesOn` / `maxCommands`; delete the caveat printed at `:310-311` and the comment at `:303-304` (they are now false).

- [ ] **Step 5: Run — expect PASS.** Then re-run the committed replay offline test (`model-cli.test.ts`, whole file) and paste counts.

### (c) The refusal carries the product's next match

- [ ] **Step 6: Pin what the product sends.** `grep -arn "next_match" apps/web/src/server apps/web/src/app/api` — record the route(s) and the envelope shape (`error.next_match.fixture_id`?). `scripts/matrix/__tests__/product-text.ts:106` already text-pins `{ next_match: ref }`; extend that pin to the field path the driver will read.

- [ ] **Step 7: Failing tests.** In `http-driver.test.ts`: a fake transport answering `409 {ok:false,error:{code:"FIXTURE_LOCKED",message:"…",next_match:{fixture_id:"f-9"}}}` makes the driver throw a `RefusedCall` whose `extra` is `{ next_match: { fixture_id: "f-9" } }` and `nextMatchFixtureId(e) === "f-9"`; an envelope with no extra fields gives `extra === null` and `null`. In `model-core.test.ts`: `fedCandidates` with a refusal naming `f-9` returns exactly `["f-9"]`; without it, the structural superset (the existing expectation, unchanged).

- [ ] **Step 8: Implement.** `RefusedCall` gains `readonly extra: Readonly<Record<string, unknown>> | null` (constructor param 7, default `null`, assigned in the body). `http-driver.ts`'s `Envelope` error type widens to `Record<string, unknown>`; `#unwrap` passes every error key except `code`, `message`, `current_seq`, `feature_key` as `extra` (null when none), each string value through `redact`. Add:

```ts
/** The fixture a refusal says the result fed, or null (W1b carry c). */
export function nextMatchFixtureId(e: RefusedCall): string | null {
  const nm = e.extra?.next_match;
  return typeof nm === "object" && nm !== null && typeof (nm as { fixture_id?: unknown }).fixture_id === "string" ? (nm as { fixture_id: string }).fixture_id : null;
}
```

`fedCandidates` takes the refusal as an optional argument: when `nextMatchFixtureId` answers, return exactly that id; otherwise keep the superset and push a note `fedCandidates: structural superset (refusal named no next match)`.

- [ ] **Step 9: Run — expect PASS** (`http-driver.test.ts`, `model-core.test.ts`, `model-run-cell.test.ts` whole files).

### (d) Spawn caps from the constant

- [ ] **Step 10:** In `ci-wiring.test.ts:314` and `workspace-wiring.test.ts:113` replace `timeout: 60_000` with `timeout: SPAWN_MS`, import `SPAWN_MS, spawnBudget` from `./spawn-budget.ts`, and give each enclosing `it` its budget as the third argument, `spawnBudget(<spawns in that test>)`. Add both files to whatever list `spawn-budget.test.ts` keeps of covered spawners (pin it); if it keeps none, add a scan test there: no `timeout: <digits>_000` literal in any `scripts/matrix/__tests__/*.test.ts` spawn call.
- [ ] **Step 11:** Run the three files; paste counts.

### (e) CLIs run through their package scripts

A bare `node` load crash cannot be mapped to 3 from inside the CLI (the crash precedes its code; `crash-exit.ts:10-12`). The guard is therefore that nothing documented runs a CLI bare.

- [ ] **Step 12: Failing test** `cli-invocation.test.ts`:

```ts
// W1b carry (e): a bare `node --experimental-strip-types scripts/matrix/<cli>.ts`
// loses crash-exit.ts's preload, so a load crash exits 1 — a verdict. Every
// documented invocation must go through the package script.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPO = new URL("../../..", import.meta.url).pathname;
const CLIS = ["run", "render", "gen-catalogue", "single-sport", "model", "parity"];
const BARE = new RegExp(`node\\s+(?:--[a-z-]+\\s+)*scripts/matrix/(?:${CLIS.join("|")})\\.ts`);

describe("CLI invocation (carry e)", () => {
  it("empty case first: the scan reads at least one file", () => {
    expect(tracked().length).toBeGreaterThan(0);
  });
  it("the pattern matches the bare form, and the preload form is exempt", () => {
    expect(BARE.test("node --experimental-strip-types scripts/matrix/run.ts --set x")).toBe(true);
    // `--import <path>` is a flag with a value, which the pattern's `--flag` run does not span.
    expect(BARE.test("node --experimental-strip-types --import ./scripts/matrix/lib/crash-exit.ts scripts/matrix/run.ts")).toBe(false);
    expect(BARE.test("pnpm run matrix:l3 -- --set x")).toBe(false);
  });
  it("no tracked doc, workflow or script runs a matrix CLI without the crash-exit preload", () => {
    const hits = tracked().flatMap((f) => readFileSync(`${REPO}${f}`, "utf8").split("\n").map((l, i) => ({ f, i: i + 1, l })))
      .filter(({ l }) => BARE.test(l) && !l.includes("--import ./scripts/matrix/lib/crash-exit.ts"));
    expect(hits.map(({ f, i }) => `${f}:${i}`)).toEqual([]);
  });
});

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "--", "*.md", "*.yml", "*.yaml", "*.sh", "package.json", "scripts/matrix/*.ts"], { cwd: REPO, encoding: "utf8" })
    .split("\n").filter((f) => f !== "" && !f.includes("/truth-runs/"));
}
```

`parity` is Task 13's CLI; listing it now means Task 13 cannot ship a bare invocation. Committed truth-run evidence is excluded: it records what was run, and rewriting history is not the point.

- [ ] **Step 13: Run.** Expected: FAIL naming each bare line (the CLIs' own header comments, e.g. `run.ts:5-7`, and any runbook). Fix each hit to the package-script form (`pnpm run matrix:l3 -- …`); where a header comment documents the bare form on purpose (`run.ts:40-43`, `render.ts:9-10`, `crash-exit.ts:10-12`), reword it to name the package script. Re-run → PASS.

- [ ] **Step 14: Mutation** (each kill named):
  - `maxCommands` optional in the schema → killed by "records how it was found";
  - replay ignores `fencesOn` (hard-code `false`) → killed by the two-case replay test;
  - `nextMatchFixtureId` returns `null` always → killed by `model-core.test.ts` "exactly f-9";
  - `#unwrap` drops `extra` → killed by `http-driver.test.ts`;
  - `BARE` regex accepts nothing (`/$^/`) → killed by "the pattern matches the bare form" (below). Once every hit is fixed, the scan alone cannot witness this mutant, so the file carries that unit case.

- [ ] **Step 15:** Scoped tsc + eslint on every changed `.ts`; commit `fix(matrix): W1b carries b-e — replay settings, next_match, spawn caps, CLI invocation`.

---

## Task 3: Results v3 — layer, driver, width; the 🚫 and ░ producers

**Files:**
- Modify: `scripts/matrix/lib/results.ts`, `scripts/matrix/lib/render-matrix.ts`, `scripts/matrix/run.ts:443`
- Test: `scripts/matrix/__tests__/results.test.ts`, `render-matrix.test.ts`, `committed-matrix.test.ts` (unchanged; must stay green on the v2 evidence)

**Interfaces:**
- Produces:
  ```ts
  export type Layer = "L1" | "L2" | "L3";
  export type DriverKind = "http" | "browser";
  export interface CaseResult { /* v2 fields */ layer: Layer; driver: DriverKind; width: number | null }
  export interface RunResults { schemaVersion: 3; /* … */ layer: Layer; driver: DriverKind }
  export type AnyRunResults = RunResultsV2 | RunResults;
  export function parseResults(json: unknown): AnyRunResults;   // v2 or v3
  export interface DecideInput { /* … */ noPath?: { wave: string; reason: string } | null; notRun?: string | null }
  ```

- [ ] **Step 1: Failing tests** (`results.test.ts`; state the empty case first):

```ts
  it("empty case first: a v3 run with zero cases parses (the CLI, not the schema, refuses an empty run)", () => {
    expect(parseResults({ ...V3_RUN, cases: [] }).schemaVersion).toBe(3);
  });
  it("committed v2 evidence still parses, and reads as layer L3 over http", () => {
    const v2 = JSON.parse(readFileSync(W1B_SLICE_RESULTS, "utf8"));
    const r = parseResults(v2);
    expect(r.schemaVersion).toBe(2);
    expect(r.cases.length).toBe(24);
  });
  it("a v3 case must carry layer, driver and width; http carries width null, browser a width from the seven or 1280", () => {
    expect(() => parseResults({ ...V3_RUN, cases: [{ ...V3_CASE, width: 1280, driver: "http" }] })).toThrow(/width/);
    expect(() => parseResults({ ...V3_RUN, cases: [{ ...V3_CASE, driver: "browser", width: 999 }] })).toThrow(/width/);
    expect(parseResults({ ...V3_RUN, cases: [{ ...V3_CASE, driver: "browser", width: 320, layer: "L1" }] }).cases[0]!.width).toBe(320);
  });
  it("decideState: noPath yields 🚫 no_path naming the wave; notRun yields ░ not_run; both lose to an error and to a deferral", () => {
    expect(decideState({ checks: [], deferred: null, error: null, noPath: { wave: "W4", reason: "no route" } })).toEqual({ state: "no_path", reason: "W4: no route" });
    expect(decideState({ checks: [], deferred: null, error: null, notRun: "no scenario script yet" })).toEqual({ state: "not_run", reason: "no scenario script yet" });
    expect(decideState({ checks: [], deferred: null, error: "boom", noPath: { wave: "W4", reason: "x" } }).state).toBe("red");
    expect(decideState({ checks: [], deferred: { wave: "W1-driving", reason: "r" }, error: null, notRun: "x" }).state).toBe("later");
  });
  it("noPath and notRun are never set together (a named refusal)", () => {
    expect(() => decideState({ checks: [], deferred: null, error: null, noPath: { wave: "W4", reason: "x" }, notRun: "y" })).toThrow(/both/);
  });
```

`W1B_SLICE_RESULTS` = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-slice/results.json` (pin the path from `committed-matrix.test.ts:21-23`). In `render-matrix.test.ts`: a v3 run with one 🚫 and one ░ case renders both glyphs in their cells, and a cell holding ✅ + 🚫 renders 🚫 (severity: `no_path` above `works`, `render-matrix.ts:16`).

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.**
  - Keep the v2 schema as `RunResultsSchemaV2` (unchanged) and add `RunResultsSchemaV3`: `schemaVersion: z.literal(3)`, run-level `layer`, `driver`, and per case `layer: z.enum(["L1","L2","L3"])`, `driver: z.enum(["http","browser"])`, `width: z.number().int().nullable()`, with a `superRefine`: http ⇒ width null; browser ⇒ width ∈ `BROWSER_WIDTHS = [1280, ...L2_WIDTHS]` (import `L2_WIDTHS` from `pairs.ts`).
  - `parseResults` = `z.union([V3, V2])`; `writeResults` writes v3 only.
  - `decideState`: after `error` and `deferred`, `if (input.noPath && input.notRun) throw new Error("decideState: noPath and notRun both set")`; then `noPath` → `{ state: "no_path", reason: \`${wave}: ${reason}\` }`; `notRun` → `{ state: "not_run", reason }`; then the existing vacuity rules.
  - `render-matrix.ts` accepts `AnyRunResults`.
  - `run.ts:443` writes `schemaVersion: 3, layer: "L3", driver: "http"` and every `CaseResult` gets `layer: "L3", driver: "http", width: null` (Task 6 makes these follow the CLI).
- [ ] **Step 4: Run — expect PASS**: `results.test.ts`, `render-matrix.test.ts`, `committed-matrix.test.ts`, `run-cli.test.ts`, `render-cli.test.ts` (whole files). Paste counts.
- [ ] **Step 5: Mutation:** drop the http⇒null refine → killed by "must carry layer…"; swap the `noPath`/`error` order → killed by "both lose to an error"; `parseResults` = V3 only → killed by "committed v2 evidence still parses".
- [ ] **Step 6:** Scoped tsc + eslint; commit `feat(matrix): results v3 (layer, driver, width) and the 🚫/░ producers`.

---
## Task 4: Browser foundations — budgets, viewports, pinned selectors, session, the product's own response, evidence

**Files:**
- Create: `scripts/matrix/lib/browser/{budget,viewports,selectors,session,respond,evidence}.ts`, `scripts/matrix/lib/pads/execute.ts` (copy of the bench's private executor, ruling 38)
- Create: `scripts/matrix/lib/driver/envelope.ts` (moved out of `http-driver.ts`, one authority for the api-v1 envelope)
- Modify: `scripts/matrix/lib/driver/http-driver.ts` (use `envelope.ts`), `scripts/matrix/__tests__/boundary.test.ts`, `strip-types-loadable.test.ts`
- Test: `scripts/matrix/__tests__/{browser-budget,viewports,selectors,respond,evidence,pad-execute}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // pads/execute.ts (COPIED from scripts/bench/lib/drivers/scorer.ts:232-268)
  export const HANDLED_KINDS: readonly TapStep["kind"][];
  export async function executeStep(page: PadPage, step: TapStep, waitMs: number): Promise<void>;
  export async function executeSteps(page: PadPage, steps: readonly TapStep[], waitMs: number): Promise<void>;
  // budget.ts
  export const TAP_PACE_MS: number;          // re-export of bench TAP_PACING_MS (350), ruling 38
  export const HOLD_MS_DEFAULT: number;      // 10_000, queue.ts
  export const MIN_HOLD_MS: number;          // 500, queue.ts
  export const SLACK_MS = 2_000;
  export const FLOOR_MS = 15_000;
  export function holdMsFromEnv(env: Readonly<Record<string, string | undefined>>): number; // mirrors resolveHoldMs
  export function budgetMs(p: { base?: number; taps?: number; holds?: number; holdMs: number }): number;
  // viewports.ts
  export type BrowserWidth = 1280 | 320 | 360 | 375 | 390 | 430 | 768 | 834;
  export const BROWSER_WIDTHS: readonly BrowserWidth[];
  export const VIEWPORT: Readonly<Record<BrowserWidth, { width: number; height: number }>>;
  // selectors.ts
  export interface Pin { file: string; needle: string }
  export const TESTID: Readonly<Record<string, { id: string } & Pin>>;
  export const NAME: Readonly<Record<string, { text: string } & ({ dictKey: string } | Pin)>>;
  export function templateLabel(row: TemplateRowKey): string;  // dictionaries/en/ui.json format.template.<row>.label
  // envelope.ts
  export function unwrapEnvelope<T>(method: string, path: string, status: number, body: unknown): T; // throws RefusedCall
  // session.ts
  export interface CaseBrowser { page: Page; close(): Promise<void> }
  export async function openBrowser(): Promise<Browser>;
  export async function newCaseBrowser(browser: Browser, o: { base: string; cookies: Readonly<Record<string, string>>; width: BrowserWidth }): Promise<CaseBrowser>;
  // respond.ts
  export async function actAndAwait<T>(page: Page, want: { method: string; path: RegExp }, act: () => Promise<void>, budget: number): Promise<{ data: T; path: string }>;
  // evidence.ts
  export interface ShotPage { screenshot(o: { path: string; fullPage: boolean }): Promise<unknown>; evaluate<R>(fn: () => R): Promise<R> }
  export class Evidence {
    constructor(dir: string, caseSlug: string, fs?: EvidenceFs);
    shot(page: ShotPage, label: string, o?: { mustDiffer?: string }): Promise<void>;
    checks(): CheckResult[];   // "visual-evidence" and "no-horizontal-scroll"
  }
  ```

- [ ] **Step 0: Chromium.** `cd <worktree> && pnpm exec playwright install chromium; echo EXIT=$?`. Then pin, with file:line, into the task report: the `resolveHoldMs` body (`queue.ts:172-195`); `HUMAN_FASTEST_REPEAT_MS` (`use-pad-pipeline.ts:384`); the seven viewport pairs (`playwright.config.ts:190-262`); that bench `tap-play.ts:47-68` `CONSENT_SEED`/`seedConsent` still match `apps/web/src/lib/consent.ts` (the bench pin `tap-play.test.ts:585-603` is green on this tree); the onboarding step `auth.setup.ts:46-47`.

### Budgets (class 20)

- [ ] **Step 1: Failing test** `browser-budget.test.ts`:

```ts
  it("the constants are the product's, read from its source (a text pin, never an import)", () => {
    expect(src("apps/web/src/components/v2/scorepad/queue.ts")).toMatch(new RegExp(`HOLD_MS_DEFAULT\\s*=\\s*${fmt(HOLD_MS_DEFAULT)}\\b`));
    expect(src("apps/web/src/components/v2/scorepad/queue.ts")).toMatch(new RegExp(`MIN_HOLD_MS\\s*=\\s*${fmt(MIN_HOLD_MS)}\\b`));
    expect(src("apps/web/src/components/v2/scorepad/use-pad-pipeline.ts")).toMatch(new RegExp(`HUMAN_FASTEST_REPEAT_MS\\s*=\\s*${fmt(TAP_PACE_MS)}\\b`));
  });
  it("holdMsFromEnv mirrors resolveHoldMs: unset, blank, non-numeric and below-floor all fall back to the DEFAULT", () => {
    for (const v of [undefined, "", "abc", String(MIN_HOLD_MS - 1)]) expect(holdMsFromEnv({ NEXT_PUBLIC_SCOREPAD_HOLD_MS: v })).toBe(HOLD_MS_DEFAULT);
    expect(holdMsFromEnv({ NEXT_PUBLIC_SCOREPAD_HOLD_MS: "3000" })).toBe(3000);
  });
  it("budgetMs grows with taps and holds, in the constants, never below the floor", () => {
    expect(budgetMs({ holdMs: 3000 })).toBe(FLOOR_MS);
    const a = budgetMs({ taps: 42, holdMs: 3000 });
    expect(a).toBe(Math.max(FLOOR_MS, 42 * (TAP_PACE_MS + SLACK_MS)));
    expect(budgetMs({ taps: 42, holds: 42, holdMs: 10_000 }) - budgetMs({ taps: 42, holds: 42, holdMs: 3000 })).toBe(42 * 7000);
  });
  it("no flat timeout literal in the browser layer: every wait is a budgetMs", () => {
    const flat = browserSources().flatMap((f) => [...src(f).matchAll(/timeout:\s*\d[\d_]*/g)].map((m) => `${f}: ${m[0]}`));
    expect(browserSources().length).toBeGreaterThan(0);
    expect(flat).toEqual([]);
  });
```

`fmt(n)` renders `10_000`-style or plain digits (accept both: `(?:10_000|10000)`). `browserSources()` lists `scripts/matrix/lib/browser/**/*.ts`, `scripts/matrix/lib/pads/**/*.ts` and `scripts/matrix/lib/driver/browser-driver.ts` that exist (the scan is extended automatically as later tasks add files; the non-empty assertion is the R25 count). The `resolveHoldMs` fallback rules are pinned from the Step 0 read — if the product's rules differ from "unusable → default", copy the product's rules and say so in the report.

- [ ] **Step 2: Run — FAIL. Step 3: implement `budget.ts`:**

```ts
// Every browser wait in the matrix is derived from the product's own constants
// (AGENTS class 20): a flat timeout beside a derived cost is a latent red.
export const HOLD_MS_DEFAULT = 10_000;   // queue.ts HOLD_MS_DEFAULT (text-pinned)
export const MIN_HOLD_MS = 500;         // queue.ts MIN_HOLD_MS (text-pinned)
// Ruling 38: the bench's pacing floor, pinned there to use-pad-pipeline.ts HUMAN_FASTEST_REPEAT_MS
// (scorer-driver.test.ts:696-698); a faster same-side repeat is dropped. Re-exported so budgets read one name.
export { TAP_PACING_MS as TAP_PACE_MS } from "../../../bench/lib/drivers/scorer.ts";
export const SLACK_MS = 2_000;          // one round trip plus a render, per step
export const FLOOR_MS = 15_000;         // navigation + first paint on a prod build
export const HOLD_ENV = "NEXT_PUBLIC_SCOREPAD_HOLD_MS";

export function holdMsFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[HOLD_ENV]?.trim() ?? "";
  const n = Number(raw);
  return raw === "" || !Number.isFinite(n) || n < MIN_HOLD_MS ? HOLD_MS_DEFAULT : Math.round(n);
}

export function budgetMs(p: { base?: number; taps?: number; holds?: number; holdMs: number }): number {
  const taps = p.taps ?? 0;
  const holds = p.holds ?? 0;
  return Math.max(FLOOR_MS, (p.base ?? 0) + taps * (TAP_PACE_MS + SLACK_MS) + holds * (p.holdMs + SLACK_MS));
}
```

- [ ] **Step 4: Run — PASS.**

### Viewports

- [ ] **Step 5: Failing test** `viewports.test.ts`: parse `apps/web/playwright.config.ts` as text, extract every `width: N, height: M` inside the seven mobile/tablet projects, and assert `VIEWPORT[w]` equals each, and that `BROWSER_WIDTHS` is `[1280, ...L2_WIDTHS]` in that order; `VIEWPORT[1280]` is `{1280, 900}` (the bench's `ORGANISER_VIEWPORT`, `scorer.ts:230`, text-pinned). Empty case first: the parse finds exactly 7 pairs (a regex that found 0 would read vacuously).
- [ ] **Step 6: implement `viewports.ts`** (a frozen literal table), run — PASS.

### Selectors

Each entry names the product file where the needle must appear. The pin test reads the files as text; nothing is imported from `apps/web`.

- [ ] **Step 7: Write `selectors.ts`** with this table (every line from scout C/D, re-pinned at Step 0):

```ts
export const TESTID = Object.freeze({
  templateStartBlank: { id: "template-start-blank", file: "apps/web/src/components/v2/template-gallery.tsx", needle: "template-start-blank" },
  builderName:        { id: "division-builder-name", file: "apps/web/src/components/v2/division-builder.tsx", needle: "division-builder-name" },
  builderNext:        { id: "division-builder-next", file: "apps/web/src/components/v2/division-builder.tsx", needle: "division-builder-next" },
  builderCreate:      { id: "division-builder-create", file: "apps/web/src/components/v2/division-builder.tsx", needle: "division-builder-create" },
  launchStart:        { id: "launch-start-division", file: "apps/web/src/components/v2/launch-actions.tsx", needle: "launch-start-division" },
  startConfirm:       { id: "start-confirm-confirm", file: "apps/web/src/components/v2/start-confirm-dialog.tsx", needle: "start-confirm" },
  gateConfirm:        { id: "board-gate-confirm", file: "apps/web/src/components/v2/board/schedule-gate-dialog.tsx", needle: "board-gate" },
  railTrigger:        { id: "stage-rail-trigger", file: "apps/web/src/components/v2/desk/stage-rail.tsx", needle: "stage-rail-trigger" },
  railSheet:          { id: "stage-rail-sheet", file: "apps/web/src/components/v2/desk/stage-rail.tsx", needle: "stage-rail-sheet" },
  stageGenerate:      { id: "stage-generate", file: "apps/web/src/components/v2/desk/stage-rail.tsx", needle: "stage-generate" },
  stageComplete:      { id: "stage-complete", file: "apps/web/src/components/v2/desk/stage-rail.tsx", needle: "stage-complete" },
  entrantWithdraw:    { id: "entrant-row-withdraw", file: "apps/web/src/components/v2/entrants-panel.tsx", needle: "entrant-row-withdraw" },
  runSheetFilter:     { id: "run-sheet-filter", file: "apps/web/src/components/v2/stages-panel.tsx", needle: "run-sheet-filter" },
  scorePad:           { id: "score-pad", file: "apps/web/src/components/v2/fixture-console.tsx", needle: "score-pad" },
  // Pad and console chassis testids are NOT restated here (ruling 38): they are the bench's
  // START_MATCH_TESTID, SEND_NOW_TESTID, FINALIZE_TESTID, FORFEIT_TESTID, FORFEIT_SIDE_TESTID_PREFIX,
  // PROMPT_REASON_TESTID, PROMPT_SUBMIT_TESTID, DOCK_CHIP_TESTID_PREFIX (scorer.ts:165-176), and the
  // sheet/tile/half selectors come from its selectorForTapStep (:140). Only the pins the bench
  // lacks are added, in PAD_PINS below.
});
/** Needles the bench's own pins never check (facts-E §4: `score-start-match`, `pad-send-now`,
 *  `score-finalize`, `data-tile-id`, `pad-sheet-number`, `pad-sheet-confirm` are unpinned
 *  bench-side). Each maps a bench constant, or a `selectorForTapStep` output, to the product
 *  file it must appear in, so a product rename reds HERE and not as a timeout mid-run. */
export const PAD_PINS = Object.freeze([
  { name: "START_MATCH_TESTID", needle: "score-start-match", file: "apps/web/src/components/v2/fixture-console.tsx" },
  { name: "FINALIZE_TESTID", needle: "score-finalize", file: "apps/web/src/components/v2/fixture-console.tsx" },
  { name: "SEND_NOW_TESTID", needle: "pad-send-now", file: "apps/web/src/components/v2/scorepad/v3/detail-dock.tsx" },
  { name: "tile", needle: "data-tile-id", file: "apps/web/src/components/v2/scorepad/v3/tile-grid.tsx" },
  { name: "number", needle: "pad-sheet-number", file: "apps/web/src/components/v2/scorepad/v3/guided-sheet.tsx" },
  { name: "confirm", needle: "pad-sheet-confirm", file: "apps/web/src/components/v2/scorepad/v3/guided-sheet.tsx" },
  { name: "choice", needle: "data-choice-option-id", file: "apps/web/src/components/v2/scorepad/v3/guided-sheet.tsx" },
  { name: "DEVICE_HANDOVER_PHONE", needle: "device-handover-phone", file: "apps/web/src/components/v2/fixture-console.tsx" },
]);
export const NAME = Object.freeze({
  addEntrant:       { text: "Add entrant", file: "apps/web/src/components/v2/entrants-panel.tsx", needle: "Add entrant" },        // hardcoded English (scout C)
  withdrawConfirm:  { text: "Withdraw entrant", dictKey: "<pin at Step 0>" },
  sportSelect:      { text: "Sport", dictKey: "<pin at Step 0>" },
  variantSelect:    { text: "Variant", dictKey: "<pin at Step 0>" },
  formatTab:        { text: "Format", dictKey: "<pin at Step 0>" },
  endsOn:           { text: "Ends on", dictKey: "<pin at Step 0>" },
  createCompetition:{ text: "Create", dictKey: "<pin at Step 0>" },
});
```

The `<pin at Step 0>` values are the en dictionary keys whose values render those labels; the executor finds each with `grep -a` in `apps/web/src/dictionaries/en/ui.json` and in the component (which key the component passes to `t()`), and writes the key in. Data-role selectors (`[data-role="v3-scorebug-half"]`, `[data-tile-id]`, `[data-choice-option-id]`, `[data-row-action=…]`, `li[data-fixture-no]`) get a third table `DATA` with the same `{file, needle}` pins (files: `scorepad/v3/pad-host.tsx`, `tile-grid.tsx`, `guided-sheet.tsx`, `desk/run-sheet-row.tsx`).

- [ ] **Step 8: Failing test** `selectors.test.ts`:

```ts
  it("empty case first: every table is non-empty", () => {
    expect(Object.keys(TESTID).length).toBeGreaterThan(0);
    expect(Object.keys(NAME).length).toBeGreaterThan(0);
    expect(Object.keys(DATA).length).toBeGreaterThan(0);
  });
  it("every testid and data needle appears in the file it is pinned to", () => {
    const missing = [...Object.entries(TESTID), ...Object.entries(DATA)].filter(([, p]) => !src(p.file).includes(p.needle)).map(([k, p]) => `${k}: ${p.needle} not in ${p.file}`);
    expect(missing).toEqual([]);
  });
  it("every PAD_PINS needle is the bench's own value and appears in its product file", () => {
    const bench: Record<string, string> = { START_MATCH_TESTID, FINALIZE_TESTID, SEND_NOW_TESTID };
    for (const p of PAD_PINS) if (p.name in bench) expect(bench[p.name], p.name).toBe(p.needle);
    for (const kind of ["tile", "number", "confirm", "choice"] as const) {
      const pin = PAD_PINS.find((p) => p.name === kind)!;
      const step = kind === "tile" ? { kind, tileId: "x" } : kind === "choice" ? { kind, optionId: "x" } : kind === "number" ? { kind, value: 1 } : { kind };
      expect(selectorForTapStep(step as TapStep), kind).toContain(pin.needle);
    }
    const missing = PAD_PINS.filter((p) => !src(p.file).includes(p.needle)).map((p) => `${p.name}: ${p.needle} not in ${p.file}`);
    expect(PAD_PINS.length).toBe(8);
    expect(missing).toEqual([]);
  });
  it("every dictionary-pinned name is the en dictionary's value, and no key is a placeholder", () => {
    const ui = JSON.parse(src("apps/web/src/dictionaries/en/ui.json")) as Record<string, string>;
    const wrong = Object.entries(NAME).filter(([, n]) => "dictKey" in n && (n.dictKey.startsWith("<") || ui[n.dictKey] !== n.text)).map(([k, n]) => `${k}: ${"dictKey" in n ? n.dictKey : ""} → ${"dictKey" in n ? ui[n.dictKey] : ""}`);
    expect(wrong).toEqual([]);
  });
  it("templateLabel reads the en dictionary for every template row", () => {
    for (const row of TEMPLATE_ROW_KEYS) expect(templateLabel(row)).toBe(JSON.parse(src("apps/web/src/dictionaries/en/ui.json"))[`format.template.${row}.label`]);
    expect(templateLabel("league")).toBe("League");
  });
```

- [ ] **Step 9: Run — FAIL until Step 7's keys are filled; then PASS.**

### The product's own response

- [ ] **Step 10: Extract `envelope.ts`** from `http-driver.ts` (`Envelope`, `errorOf`, `#unwrap`'s body) as `unwrapEnvelope(method, path, status, body)`; HttpDriver's `#unwrap` becomes a call to it. Run `http-driver.test.ts` whole — unchanged counts (a pure move).

- [ ] **Step 11: Failing test** `respond.test.ts`, against a structural fake page (no browser): `actAndAwait` resolves with the data of the FIRST response matching method + path that arrives after `act` begins; ignores a matching GET when POST was asked; throws the `RefusedCall` `unwrapEnvelope` builds for a 422 (code and message intact, `extra` carried); throws a named `NoProductResponse(method, pathRe, budget)` when none arrives within the budget — never returns `undefined`. The fake implements only `waitForResponse(pred, {timeout})`, which is all `actAndAwait` may use.

- [ ] **Step 12: Implement `respond.ts`:**

```ts
import type { Page, Response } from "playwright";
import { unwrapEnvelope } from "../driver/envelope.ts";

export class NoProductResponse extends Error {
  constructor(method: string, path: RegExp, ms: number) {
    super(`browser: the UI sent no ${method} ${path.source} within ${ms} ms — the click reached nothing`);
    this.name = "NoProductResponse";
  }
}

/** Clicks through `act` and resolves on the product's OWN answer to the request
 *  the UI made (Review Focus 4): the scenario sees exactly what HttpDriver would
 *  have seen, refusals included. */
export async function actAndAwait<T>(page: Pick<Page, "waitForResponse">, want: { method: string; path: RegExp }, act: () => Promise<void>, budget: number): Promise<{ data: T; path: string }> {
  const matches = (r: Response) => r.request().method() === want.method && want.path.test(new URL(r.url()).pathname);
  const waiting = page.waitForResponse(matches, { timeout: budget }).catch(() => { throw new NoProductResponse(want.method, want.path, budget); });
  await act();
  const r = await waiting;
  const path = new URL(r.url()).pathname;
  const body: unknown = await r.json().catch(() => null);
  return { data: unwrapEnvelope<T>(want.method, path, r.status(), body), path };
}
```

- [ ] **Step 13: Run — PASS.**

### Session

- [ ] **Step 14: Implement `session.ts`.** `openBrowser()` = `chromium.launch({ headless: true })`. `newCaseBrowser` creates a context with `viewport: VIEWPORT[width]`, `locale: "en"`, `baseURL: base`; adds the session's cookies (`seazn_session`, `seazn_org` and any others in the jar) with `url: base`; adds `context.addInitScript(seedConsent, CONSENT_SEED)` (imported from `scripts/bench/lib/tap-play.ts`, ruling 38 — the same pre-answer that keeps the banner off the controls and stops live PostHog capture); opens one page. `ensureOnboarded(page)` performs the pinned onboarding step only if the first navigation lands on the onboarding route. `close()` closes the context. No unit test beyond load (Step 17); it is proven live in Task 8, and its failure modes (no chromium, wrong cookie) are environment faults the runner reports as an ABORT, not a case red.

### Evidence (class 10)

- [ ] **Step 15: Failing test** `evidence.test.ts` with an in-memory `EvidenceFs` and a fake `ShotPage`:

```ts
  it("empty case first: no shots → visual-evidence fails as vacuous (checked 0 is a failure, R25)", () => {
    const ev = new Evidence("/r", "case", memFs());
    const v = ev.checks().find((c) => c.id === "visual-evidence")!;
    expect(v.verdict).toBe("fail");
    expect(v.checked).toBe(0);
  });
  it("a missing or empty file reds visual-evidence by label", async () => {
    const fs = memFs({ failWrite: "02-started" });
    const ev = new Evidence("/r", "case", fs);
    await ev.shot(fakePage("A"), "01-built");
    await ev.shot(fakePage("B"), "02-started");
    expect(ev.checks().find((c) => c.id === "visual-evidence")!.evidence.join()).toMatch(/02-started/);
  });
  it("a must-differ pair with identical pixels reds; differing pixels pass", async () => {
    const ev = new Evidence("/r", "case", memFs());
    await ev.shot(fakePage("SAME"), "01-before");
    await ev.shot(fakePage("SAME"), "02-after", { mustDiffer: "01-before" });
    expect(ev.checks().find((c) => c.id === "visual-evidence")!.verdict).toBe("fail");
    const ok = new Evidence("/r", "case2", memFs());
    await ok.shot(fakePage("X"), "01-before");
    await ok.shot(fakePage("Y"), "02-after", { mustDiffer: "01-before" });
    expect(ok.checks().find((c) => c.id === "visual-evidence")!.verdict).toBe("pass");
  });
  it("no-horizontal-scroll: checked = states probed; a scrollWidth over clientWidth reds with its label and numbers", async () => {
    const ev = new Evidence("/r", "case", memFs());
    await ev.shot(fakePage("A", { scrollWidth: 320, clientWidth: 320 }), "01-a");
    await ev.shot(fakePage("B", { scrollWidth: 426, clientWidth: 320 }), "02-b");
    const c = ev.checks().find((k) => k.id === "no-horizontal-scroll")!;
    expect(c.checked).toBe(2);
    expect(c.verdict).toBe("fail");
    expect(c.evidence).toEqual(["02-b: page scrollWidth 426 > clientWidth 320"]);
  });
```

- [ ] **Step 16: Implement `evidence.ts`.** `shot` evaluates `document.scrollingElement` widths first, then writes the full-page PNG to `<dir>/shots/<caseSlug>/<label>.png` through `fs`, reads it back, and records `{label, bytes, sha256}` (sha256 via `node:crypto` `createHash`; it hashes bytes, it is not entropy, so the reference gate does not apply here). `checks()` returns exactly two `CheckResult`s. A write that throws is recorded as missing, never rethrown: the case still judges its other checks.

### The pad executor (copied from the bench, ruling 38)

- [ ] **Step 16a: Failing test** `pad-execute.test.ts`, with a fake `PadPage` whose locators record calls and whose `count()` is scripted:

```ts
  it("releaseHold with nothing held is a no-op (count 0 → no click, no wait)", async () => {
    const page = fakePage({ counts: { '[data-testid="pad-send-now"]': [0] } });
    await executeStep(page, { kind: "releaseHold" }, 1000);
    expect(page.calls).toEqual([["count", '[data-testid="pad-send-now"]']]);
  });
  it("releaseHold tolerates the hold releasing itself between count and click", async () => {
    const page = fakePage({ counts: { '[data-testid="pad-send-now"]': [1, 0] }, clickThrows: ['[data-testid="pad-send-now"]'] });
    await expect(executeStep(page, { kind: "releaseHold" }, 1000)).resolves.toBeUndefined();
  });
  it("releaseHold rethrows when the click failed and the dock is still there", async () => {
    const page = fakePage({ counts: { '[data-testid="pad-send-now"]': [1, 1] }, clickThrows: ['[data-testid="pad-send-now"]'] });
    await expect(executeStep(page, { kind: "releaseHold" }, 1000)).rejects.toThrow();
  });
  it("number fills, never clicks; every wait uses the caller's budget, not a literal", async () => {
    const page = fakePage({});
    await executeStep(page, { kind: "number", value: 21 }, 4321);
    expect(page.calls).toEqual([["waitFor", '[data-testid="pad-sheet-number"]', 4321], ["fill", '[data-testid="pad-sheet-number"]', "21"]]);
  });
  it("the copy's case list equals the bench TapStep kinds (a new bench kind reds here, not mid-run)", () => {
    const benchKinds = [...src("scripts/bench/lib/drivers/scorer.ts").matchAll(/\|\s*\{\s*readonly kind: "(\w+)"/g)].map((m) => m[1]).sort();
    expect(benchKinds.length).toBe(10);
    expect(HANDLED_KINDS.slice().sort()).toEqual(benchKinds);
  });
```

- [ ] **Step 16b: Run — FAIL. Step 16c: Write `lib/pads/execute.ts`.** Copy `scorer.ts:232-268` (`executeStep`/`executeSteps`) verbatim, with two changes:
  - (a) Every `TAP_WAIT_TIMEOUT_MS` becomes the `waitMs` parameter. The caller passes `Math.max(TAP_WAIT_TIMEOUT_MS, budgetMs({ taps: 1, holds: 0, holdMs }))`, so a slow width never reds as a timeout (class 20).
  - (b) Export `HANDLED_KINDS = ["tile","choice","number","confirm","testid","half","chip","offeredChip","releaseHold","text"] as const`.

  The file header says: `// COPIED from scripts/bench/lib/drivers/scorer.ts:232-268 (private there; ruling 38). Keep in step by hand; pad-execute.test.ts pins the kind list.`

  **Step 16d: PASS.** Task 5's `forfeitUi` and Task 7's replay both use it.

- [ ] **Step 17: Boundary and loadability (ruling 38).** In `scripts/matrix/__tests__/boundary.test.ts`:
  1. Widen the allow-list (line 15) to exactly:
     ```ts
     const ALLOWED_BENCH = new Set([
       "scripts/bench/lib/http.ts", "scripts/bench/lib/plan.ts", "scripts/bench/lib/env.ts",
       // Ruling 38 (2026-09-29): the tap vocabulary, the ledger reader, the generic adapter and the
       // consent/device-link helpers are imported, not copied. scorer.ts and tap-play.ts reach
       // pack-schema through simulate.ts — a second transitive load ruling 38 accepts by name.
       "scripts/bench/lib/ledger.ts", "scripts/bench/lib/drivers/scorer.ts",
       "scripts/bench/lib/drivers/adapters/generic.ts", "scripts/bench/lib/tap-play.ts",
     ]);
     ```
  2. Add a named-export refusal, because ruling 38 allows only the sport-blind parts of two of those files:
     ```ts
     // Ruling 38: the bench's match loop fixes the widths (organiser 1280, scorer 390) and always
     // finalizes, which breaks HTTP parity. Refused by name wherever it is imported from.
     const REFUSED_BENCH_EXPORTS = ["playMatchByTaps", "createTapPlayer", "browserTapPlayer"];
     it.each(MODULES.map((f) => [relative(MATRIX, f), f]))("%s never imports the bench match loop", (_rel, file) => {
       const src = readFileSync(file, "utf8");
       for (const name of REFUSED_BENCH_EXPORTS) expect(new RegExp(`\\b${name}\\b`).test(src), name).toBe(false);
     });
     ```
  3. Add a transitive-closure test: walk relative imports from every shipped matrix module (the same `SPEC` regex, value imports only, following `.ts` files under the repo; count visited files and assert the count > 50 so an empty walk reds); assert no visited path contains `run-suite`, `seed.ts`, `seed-plan`, `validate-pack` or `scripts/smoke`, and that `scripts/bench/lib/pack-schema.ts` IS visited (a positive pair — if a refactor drops the load, the ruling-38 comment goes stale and this reds so it is re-read).
  4. No file under `scripts/matrix/` outside `lib/browser/`, `lib/pads/` and `lib/driver/browser-driver.ts` imports `"playwright"` (scan every `.ts`; the count of scanned files is asserted > 0).
  5. Add every new module to `strip-types-loadable.test.ts`.
  Mutations (Step 18): add `"scripts/bench/lib/tap-setup.ts"` to an import in a scratch module → the allow-list test reds; import `playMatchByTaps` → the refusal reds; point the closure walk at an empty list → the count guard reds.

- [ ] **Step 18: Run** `browser-budget`, `viewports`, `selectors`, `respond`, `evidence`, `pad-execute`, `http-driver`, `boundary`, `strip-types-loadable` test files. Paste counts.

- [ ] **Step 19: Mutation:** `holdMsFromEnv` returns the raw number unguarded → killed by "falls back to the DEFAULT"; `budgetMs` drops the `holds` term → killed by "grows with … holds"; `Evidence` skips the must-differ comparison → killed by "identical pixels reds"; `actAndAwait` returns `null` data on non-2xx → killed by the 422 case; a `timeout: 5000` literal added to `respond.ts` → killed by "no flat timeout literal".

- [ ] **Step 20:** Scoped tsc + eslint; commit `feat(matrix): browser foundations — budgets, viewports, pinned selectors, product responses, evidence`.

---

## Task 5: Organiser page objects

**Files:**
- Create: `scripts/matrix/lib/browser/pages/{paths,competition,division-builder,entrants,launch,stage-rail,run-sheet,fixture-console,standings,public-division}.ts`
- Test: `scripts/matrix/__tests__/page-objects.test.ts` (pure parts only)

**Interfaces:**
- Consumes: `TESTID`, `NAME`, `DATA`, `templateLabel` (T4); `actAndAwait` (T4); `Evidence` (T4); wire types from `driver/types.ts`.
- Produces (every method returns the product's own JSON through `actAndAwait`):
  ```ts
  export interface PageCtx { page: Page; base: string; orgSlug: string; holdMs: number; evidence: Evidence }
  export const paths: { competitionNew(o): string; divisionNew(o, comp): string; division(o, comp, div, tab?): string; fixture(o, comp, div, no): string; publicDivision(o, comp, div, tab?): string };
  export function createCompetitionUi(c: PageCtx, input: { name: string }): Promise<CompetitionOut>;          // POST /api/v1/competitions
  export function createDivisionUi(c: PageCtx, compSlug: string, compId: string, input: { name: string; sportKey: string; variantKey: string; row: TemplateRowKey }): Promise<{ division: DivisionOut; stages: StageOut[] }>;
  export function addEntrantsUi(c: PageCtx, where: DivisionWhere, entrants: readonly { displayName: string; kind: EntrantKind }[]): Promise<EntrantRow[]>;
  export function startUi(c: PageCtx, where: DivisionWhere): Promise<StartOut>;
  export function generateUi(c: PageCtx, where: DivisionWhere, stageId: string): Promise<GenerateOut>;
  export function completeStageUi(c: PageCtx, where: DivisionWhere, stageId: string): Promise<CompleteOut>;
  export function withdrawUi(c: PageCtx, where: DivisionWhere, entrant: { id: string; displayName: string }): Promise<WithdrawOut>;
  export function openFixtureUi(c: PageCtx, where: DivisionWhere, fixtureNo: number): Promise<void>;
  export function forfeitUi(c: PageCtx, side: "home" | "away", reason: "walkover" | "retired hurt"): Promise<PostedEventWire[]>;
  export function finalizeUi(c: PageCtx, fixtureId: string): Promise<void>;
  export function readStandingsUi(c: PageCtx, where: DivisionWhere): Promise<UiTable[]>;   // [] when the stage kind has no table
  export function readPublicUi(c: PageCtx, where: DivisionWhere): Promise<{ tables: UiTable[]; champion: string | null }>;
  export interface DivisionWhere { compSlug: string; divSlug: string; divisionId: string }
  export interface UiTable { rows: { rank: number; name: string }[] }
  export function openFoldIfFolded(page: Page, trigger: Locator, body: Locator, budget: number): Promise<"opened" | "unfolded">;
  export function tablesFromCells(cells: readonly (readonly string[])[]): UiTable;   // pure
  ```

The organiser facts each function uses (Appendix A) are restated in its code comment with component:line. Every function shoots evidence after the state it proves, with `mustDiffer` on the state before it where the screen must change.

- [ ] **Step 1: Pure pieces first — failing tests** `page-objects.test.ts`:

```ts
  it("paths: the organiser and public routes the product serves (text-pinned to the app router folders)", () => {
    expect(paths.division("o", "c", "d", "fixtures")).toBe("/o/o/c/c/d/d?tab=fixtures");
    expect(paths.fixture("o", "c", "d", 7)).toBe("/o/o/c/c/d/d/f/7");
    expect(paths.publicDivision("o", "c", "d", "standings")).toBe("/shared/o/c/d?tab=standings");
    for (const dir of ["apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]", "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]"]) expect(existsSync(join(REPO, dir))).toBe(true);
  });
  it("fold gate keys on trigger visibility, never width: visible → open, hidden → leave", async () => {
    const opened: string[] = [];
    expect(await openFoldIfFolded(fakePage(), fakeLocator({ visible: true, onClick: () => opened.push("t") }), fakeLocator({ attached: true }), 1000)).toBe("opened");
    expect(await openFoldIfFolded(fakePage(), fakeLocator({ visible: false, onClick: () => opened.push("x") }), fakeLocator({ attached: true }), 1000)).toBe("unfolded");
    expect(opened).toEqual(["t"]);
  });
  it("tablesFromCells: empty case first, then rank order kept as the page shows it (never re-sorted)", () => {
    expect(tablesFromCells([])).toEqual({ rows: [] });
    expect(tablesFromCells([["2", "B"], ["1", "A"]]).rows).toEqual([{ rank: 2, name: "B" }, { rank: 1, name: "A" }]);
  });
```

The fakes implement only `isVisible`, `click`, `waitFor({state})` — the subset `openFoldIfFolded` may call. Order is kept as shown because the comparison against the API table (Task 6) must see a mis-ordered page.

- [ ] **Step 2: Run — FAIL. Step 3: implement `paths.ts`, `openFoldIfFolded` (in `stage-rail.ts`), `tablesFromCells` (in `standings.ts`). Run — PASS.**

- [ ] **Step 4: Implement the page objects.** Each follows this shape (competition shown in full; the others list their steps, selectors and the response they await):

```ts
// competition.ts — /competitions/new → template-gallery "start blank" → wizard
// (template-gallery.tsx:565; competition-wizard.tsx:184,244,265).
export async function createCompetitionUi(c: PageCtx, input: { name: string }): Promise<CompetitionOut> {
  const { page } = c;
  await page.goto(paths.competitionNew(c.orgSlug));
  await page.getByTestId(TESTID.templateStartBlank.id).click();
  await page.getByPlaceholder(NAME.competitionNamePlaceholder.text).fill(input.name);
  await page.getByLabel(new RegExp(`^${NAME.endsOn.text}`)).fill("2030-12-31");
  // Unlisted, as HttpDriver creates it (http-driver.ts:113-125): public reads work
  // and the public-dashboard cap can never degrade it (VisibilityDegraded).
  await page.locator("label", { hasText: NAME.visibilityUnlisted.text }).click();
  const { data } = await actAndAwait<CompetitionOut>(page, { method: "POST", path: /^\/api\/v1\/competitions$/ },
    () => page.getByRole("button", { name: new RegExp(NAME.createCompetition.text, "i") }).click(), budgetMs({ base: FLOOR_MS, holdMs: c.holdMs }));
  await c.evidence.shot(page, "01-competition-created");
  return data;
}
```

(`competitionNamePlaceholder` = "Summer Championship 2026" and `visibilityUnlisted` are two more `NAME` entries; add them in Task 4's table.) The rest:

  - **`createDivisionUi`** (`division-builder.tsx:588-1139`): goto `paths.divisionNew`; fill `division-builder-name`; select the "Sport" select by option VALUE `sportKey` (pin that option values are sport keys at Step 0; if they are ids, select by the sport's display name from `dictionaries/en`); wait for the Variant select to repopulate, select `variantKey`; click tab "Format"; click `page.locator("label", { hasText: templateLabel(row) })` with exact text (the radio is sr-only, `:772-812`); leave every knob untouched (the builder's defaults ARE `BUILDER_DEFAULT_KNOBS`, `catalogue.ts:43-48`); step `division-builder-next` to the last tab; click `division-builder-create` inside ONE `Promise.all` of two `waitForResponse`s — POST `/api/v1/competitions/<id>/divisions` and POST `/api/v1/divisions/<id>/stages` — each unwrapped by `unwrapEnvelope`; shoot `02-division-built`. Return both answers.
  - **`addEntrantsUi`** (`entrants-panel.tsx:1034-1136`): goto `?tab=entrants`; per entrant: choose Kind in the "Kind" group (aria-label pin), fill the name input (placeholder per kind: "Alex Doe" / "Alice & Bob" / "Riverside CC", pins), click "Add entrant", await POST `/api/v1/divisions/<id>/entrants`. One entrant per request, in seed order. Shoot `03-entrants`. **Seed assignment is a Step 0 pin**: read what seed the single-add form sends (none? next?). If it sends none and the product assigns seeds in insertion order, the harness adds in seed order and says so in a comment. If the product leaves seeds null, `life-built-as-posted` will red, which is a real organiser finding ("the add form cannot seed"); record it, do not work around it.
  - **`startUi`** (`launch-actions.tsx:141`; `start-confirm-dialog.tsx:81`; `schedule-gate-dialog.tsx:98`): click `launch-start-division`, then `start-confirm-confirm`, awaiting POST `/divisions/<id>/start`. If that answer is 422 `SCHEDULE_UNACKNOWLEDGED_WARNINGS` (catch the `RefusedCall` by code), click `board-gate-confirm` and await the second POST (the UI retries with `acknowledge_warnings: true`, `launch-actions.tsx:100-105`). Any other refusal propagates. Shoot `04-started` with `mustDiffer: "03-entrants"`.
  - **`generateUi` / `completeStageUi`** (`desk/stage-rail.tsx:316,401,531,607`): goto `?tab=fixtures`; the rail for `stageId` is `[data-stage-id="<id>"]` (pin; if the rail carries no stage id, pin the rail order = stage seq and index it); `openFoldIfFolded(railTrigger, railSheet)`; click `stage-generate` / `stage-complete`; await POST `/stages/<id>/generate` / `/complete`. Shoot `05-generated` / `08-completed`. `stage-complete` is clicked at most once per stage — the driver enforces it (HttpDriver's DriverMisuse rule, `http-driver.ts:210-232`).
  - **`withdrawUi`** (`entrants-panel.tsx:1571`): goto `?tab=entrants`; the row containing the entrant's display name; `entrant-row-withdraw`; `getByRole("alertdialog").getByRole("button", { name: NAME.withdrawConfirm.text })`; await POST `/entrants/<id>/withdraw`. Shoot `06-withdrawn`.
  - **`openFixtureUi`** (`stages-panel.tsx:556,1417`; `desk/run-sheet-row.tsx:436-562`): goto `?tab=fixtures`; if `run-sheet-filter` offers `[data-filter=all]` and it is not selected, click it (the "today" default hides rows on match day); click `li[data-fixture-no="<no>"] [data-row-action]` whose action is one of `open_pad`, `score`, `result`; wait for URL `…/f/<no>`; wait for `score-start-match` or `score-pad` attached.
  - **`forfeitUi`** (`fixture-console.tsx:1365,1378,119,128`): the steps are the bench's own `organiserStepsFor({ type: "core.forfeit", payload: { by, reason } }, { cfg, entrants })` (`scorer.ts:322-355`: toggle → side button → typed reason → submit; ruling 38), run through the copied `executeStep` (Task 4, `lib/pads/execute.ts`). Reload first, as bench `reloadConsoleBeforeAction` does (`tap-play.ts:456`): a console loaded before the fixture's last event answers SEQ_CONFLICT; collect every POST `/fixtures/<id>/events` answer until one carries a terminal status (the console may post `core.start` first, as HttpDriver does when the fixture is scheduled). Shoot `07-forfeit`.
  - **`finalizeUi`** (`fixture-console.tsx:1260-1274`): reload (the console polls every 15 s and renders `score-finalize` only once it knows the match is decided — bench `tap-play.ts:445-455`), then `FINALIZE_TESTID`; await the POST it makes (pin at Step 0: `/fixtures/<id>/events` with `core.finalize`, or `/fixtures/<id>/finalize`); shoot `09-finalized`.
  - **`readStandingsUi`** (`d/[divSlug]/page.tsx:83,850`; `standings-table.tsx`): goto `?tab=standings`; for each table, the rank and name cells in DOM order (pin the row/cell selectors), through `tablesFromCells`. A stage kind outside `TABLE_KINDS` renders no table: return `[]`.
  - **`readPublicUi`** (`app/(public)/shared/…/page.tsx:239,507,529`): anonymous? No — the public page is read in the same context (it needs no auth); goto `paths.publicDivision(…,"standings")`; tables as above; champion = the banner's name text (`:239`) or null.

- [ ] **Step 5: Scoped tsc + eslint over `lib/browser/pages/*.ts`; strip-types-loadable list extended; run the Task 4 + Task 5 tests.** No live run yet (Task 8 walks these). Commit `feat(matrix): organiser page objects`.

- [ ] **Step 6: Mutation:** `openFoldIfFolded` keys on `page.viewportSize().width < 768` instead of visibility → killed by "fold gate keys on trigger visibility"; `tablesFromCells` sorts by rank → killed by "never re-sorted".

---

## Task 6: `BrowserDriver`, the mixed-driver ledger, and `run.ts --driver browser --width`

**Files:**
- Create: `scripts/matrix/lib/driver/mixed.ts`, `scripts/matrix/lib/driver/browser-driver.ts`
- Modify: `scripts/matrix/lib/driver/types.ts` (optional `finalize?`), `scripts/matrix/lib/driver/http-driver.ts` (`finalize`, `ledger` over bench `fetchFixtureLedger`), `scripts/matrix/run.ts`, `package.json` (`matrix:browser`)
- Test: `scripts/matrix/__tests__/{mixed-driver,browser-driver}.test.ts`, `run-cli.test.ts`

**Interfaces:**
- Consumes: page objects (T5), `Evidence` (T4), `HttpDriver`.
- Produces:
  ```ts
  // mixed.ts
  export const ACTION_TYPES = ["createCompetition", "createDivision", "addEntrants", "start", "generate", "score", "forfeit", "withdraw", "completeStage", "standingsView", "publicView"] as const;
  export type ActionType = (typeof ACTION_TYPES)[number];
  export class MixedLedger {
    record(a: ActionType, via: "browser" | "http"): void;
    exempt(a: ActionType, reason: string): void;       // http by necessity, with the owner of the missing path
    wantsBrowser(a: ActionType, policy: "first" | "all"): boolean;
    coverage(): CheckResult;                           // id "mixed-driver-coverage"
  }
  // browser-driver.ts
  export interface BrowserDriverOptions { http: HttpDriver; ctx: PageCtx; spec: CaseSpec; padPolicy: "first" | "all"; pads: PadRegistry }
  export class BrowserDriver implements OrganiserDriver { checks(): CheckResult[]; /* + every OrganiserDriver method */ }
  // types.ts
  interface OrganiserDriver { finalize?(fixtureId: string): Promise<FixtureStateOut> }
  // run.ts
  interface Cli { driver: "http" | "browser"; width: BrowserWidth | null; /* … */ }
  interface RunDeps { openBrowserRun?(): Promise<BrowserRun> }
  interface BrowserRun { caseDriver(o: { base: string; session: Session; orgId: string; orgSlug: string; spec: CaseSpec; width: BrowserWidth; padPolicy: "first" | "all"; reportDir: string }): Promise<{ driver: OrganiserDriver & { checks(): CheckResult[] }; close(): Promise<void> }>; close(): Promise<void> }
  ```

### The ledger

- [ ] **Step 1: Failing tests** `mixed-driver.test.ts`:

```ts
  it("empty case first: a case that invoked no action is a vacuous coverage (checked 0 → fail)", () => {
    const c = new MixedLedger().coverage();
    expect(c).toMatchObject({ id: "mixed-driver-coverage", verdict: "fail", checked: 0 });
  });
  it("policy first: the first call of a type goes to the browser, every later one to http; policy all: score always browser", () => {
    const l = new MixedLedger();
    expect(l.wantsBrowser("generate", "first")).toBe(true);
    l.record("generate", "browser");
    expect(l.wantsBrowser("generate", "first")).toBe(false);
    l.record("score", "browser");
    expect(l.wantsBrowser("score", "all")).toBe(true);
    expect(l.wantsBrowser("generate", "all")).toBe(false);   // "all" widens only score (and finalize) — organiser actions stay first-only
  });
  it("a missing browser action reds by name (Review Focus 1)", () => {
    const l = new MixedLedger();
    l.record("createCompetition", "browser");
    l.record("generate", "http");
    const c = l.coverage();
    expect(c.verdict).toBe("fail");
    expect(c.checked).toBe(2);
    expect(c.evidence).toEqual(["generate: invoked 1×, never in the browser"]);
  });
  it("an exemption passes its type only with a reason naming a wave, and the reason is kept as evidence", () => {
    const l = new MixedLedger();
    l.record("createDivision", "http");
    expect(() => l.exempt("createDivision", "no organiser UI")).toThrow(/wave/);
    l.exempt("createDivision", "no organiser UI for page_playoff_only → W4");
    expect(l.coverage()).toMatchObject({ verdict: "pass", checked: 1, evidence: ["createDivision: exempt — no organiser UI for page_playoff_only → W4"] });
  });
```

- [ ] **Step 2: Run — FAIL. Step 3: implement `mixed.ts`** (a `Map<ActionType, {browser: number; http: number; exempt: string | null}>`; `exempt` requires `/→ W\d|→ W1-driving/`; `coverage()` lists each invoked type without a browser run and without an exemption). **Step 4: PASS.**

### The driver

- [ ] **Step 5: Failing tests** `browser-driver.test.ts`, with `FakeLeagueDriver` (`__tests__/fake-driver.ts`) standing in for the HttpDriver and a fake page-object module injected through the options (the driver takes its page functions as a `pages` option defaulting to the real module, so the test needs no browser):

  - **"a refused UI action throws RefusedCall with the product's code"** (Review Focus 4): the fake `startUi` throws `RefusedCall(…, 422, "SCHEDULE_BLOCKING_CONFLICTS", …)`; `driver.start()` rejects with that same instance class and code, and the ledger records `start` as browser (the click happened).
  - **"first call browser, second http"**: two `generate()` calls → the fake `generateUi` called once, the http fake once.
  - **"reads never touch the page"**: `getDivision`, `listStages`, `listEntrants`, `listFixtures`, `fixtureState`, `rebuild`, `patchDivisionConfig`, `replaceStagesProbe` each call the http fake and no page function.
  - **"builder output vs the harness's bodies"**: the fake builder answers stages equal to `stagesForRow("league")` → `builder-posted-as-harness` passes with `checked` = stage count; answers `legs: 1` where the bodies say 3 (triple_rr's known defect shape) → fails naming `config.legs`, and `postStages` returns the BUILT stages (what the organiser really got), not the bodies.
  - **"API-only row: created over http, organiser-ui-path fails naming the wave, coverage exempts createDivision"** for each of the five `API_ONLY_ROWS`, the wave from D7's table (derived by a lookup the test restates from design §8, not from the driver).
  - **"completeStage twice → DriverMisuse"**, as HttpDriver.
  - **"callCount counts browser and http calls"**.

- [ ] **Step 6: Run — FAIL. Step 7: implement `browser-driver.ts`.** The class holds `http`, `ctx`, `spec`, `ledger`, `built: StageOut[] | null`, `where: DivisionWhere | null`, `checks: CheckResult[]`, `completed: Set<string>`. Method by method:

  - `createCompetition(input)`: browser (first, always): `createCompetitionUi`; the same `OrgMismatch` / `VisibilityDegraded` checks HttpDriver makes (`http-driver.ts:118,123`), then `ledger.record`.
  - `createDivision(compId, input)`:
    - `API_ONLY_ROWS` row → `http.createDivision`; push `organiser-ui-path` **fail** `no organiser control builds <row> → <wave>` (`API_ONLY_UI_WAVE` table in this file: knockout_third_place/page_playoff_only/stepladder_only → W4; group_only/group_group_ko → W5); `ledger.exempt("createDivision", …)` with the same text. The two template-only cells (group_only × badminton, group_group_ko × cricket) push `organiser-ui-path` **abstain** `reachable only through catalog template <key>; driving it → W1-driving`.
    - template row → `createDivisionUi(…, row: spec.row)`; keep `built` and `where`; push `organiser-ui-path` pass (checked 1).
  - `postStages(divId, bodies)`: when `built` exists, compare `normalise(built)` with `normalise(bodies)` (kind, seq, config and progression, keys sorted; ids and statuses dropped) into `builder-posted-as-harness` (checked = `max(len)`; evidence = each differing path `stage[1].config.legs: built 1, harness 3`), and return `built` as `StageRef[]`. Otherwise `http.postStages`.
  - `addEntrants`, `start`, `withdraw`: browser when `wantsBrowser`, via the page objects; else http. A withdraw needs the entrant's display name: read it from `http.listEntrants` (a read).
  - `generate(stageId)`: browser when wanted → `generateUi`; else http.
  - `postStream(fixtureId, events, prefix)`: browser when `wantsBrowser("score", padPolicy)` → the pad path (Task 7 fills it; in this task it throws `DriverMisuse("pad path lands in Task 7")` and the tests cover only the http branch); else http.
  - `forfeit`: browser when wanted → `openFixtureUi` + `forfeitUi`; else http.
  - `completeStage(stageId)`: refuse a repeat (`DriverMisuse`); browser when wanted → `completeStageUi`; else http.
  - `standings(stageId, poolId)`: always `http.standings` (the scenario needs the data); when `wantsBrowser("standingsView")`, also `readStandingsUi` and compare with the API rows mapped to display names (from `http.listEntrants`) → `ui-standings-match`: pass when every UI table's name order equals the API table for its pool; **abstain** "no organiser table for <kind>" when the UI shows none and the kind is outside `league|group|swiss` (false premise 2); fail otherwise (a table the API has and the page does not, or a different order).
  - `publicStandings(ref)`: always http; when wanted, `readPublicUi` → `ui-public-standings-match` (as above) and `ui-champion-shown`: after a completed knockout stage, the banner names the API's rank-1 entrant; abstain before completion or for a table kind (its table is the proof).
  - `finalize(fixtureId)`: browser → `finalizeUi`, then `http.fixtureState`.
  - reads and probes: http.
  - `checks()`: the pushed checks + `ledger.coverage()` + `ctx.evidence.checks()`.

  HttpDriver gains `finalize(fixtureId)` (POST `/api/v1/fixtures/<id>/finalize`, `route.ts:11`) and `ledger(fixtureId, sinceSeq = 0)`, a thin wrapper over the bench's `fetchFixtureLedger(base, session, fixtureId, sinceSeq, transport)` (`scripts/bench/lib/ledger.ts:125`; exclusive `since_seq`, seq-sorted, envelope-checked) that returns its `LedgerRow[]`. Each gets an `http-driver.test.ts` case against the fake transport; the ledger case asserts the exclusive bound (`since 3` never returns seq 3), because the bench hardened exactly that.

- [ ] **Step 8: Run — PASS** (`mixed-driver`, `browser-driver`, `http-driver` whole files).

### The runner

- [ ] **Step 9: Failing tests** in `run-cli.test.ts`:
  - `--driver browser` without `--width` → usage refusal, exit 2; `--width 999` → refusal naming the allowed widths; `--width` with `--driver http` → refusal.
  - With an injected `openBrowserRun` fake: every case gets its own `caseDriver` (one per case, closed in `finally` even when the scenario throws), the case's checks include the driver's `checks()`, and `results.json` records `layer: "L1"`, `driver: "browser"`, `width` as asked, caseIds suffixed `@<width>`.
  - `openBrowserRun` rejects (no chromium) → exit 3 ABORTED with the message, and no case is recorded as a product red.
  - The browser run is closed exactly once, after the last case, including when a case aborts the run.

- [ ] **Step 10: Implement.** `parseCli` gains `driver` (default `http`) and `width`; the checks above. `execute` opens the browser run once (only for `--driver browser`) and closes it in its `finally`. `runCase` builds the driver through `caseDriver` for browser runs (else `driverFor`, unchanged), merges `driver.checks()` after `evaluateInvariants(...)` and the scenario's assertions, and closes it in `finally`. `realDeps.openBrowserRun` = `openBrowser()` + a `caseDriver` that makes `newCaseBrowser`, an `Evidence(join(reportDir, runId), slug(caseId))`, a fresh `HttpDriver` on the same session, and the `BrowserDriver`. The scenario's `padPolicy` (Task 7 adds it to `Scenario`) defaults to `"first"`. Add to `package.json`: `"matrix:browser": "node --experimental-strip-types --import ./scripts/matrix/lib/crash-exit.ts scripts/matrix/run.ts --driver browser"`.

- [ ] **Step 11: Run — PASS** (`run-cli.test.ts` whole, `results.test.ts`, `mixed-driver`, `browser-driver`).
- [ ] **Step 12: Mutation:** `wantsBrowser` always false → killed by "policy first"; `coverage()` ignores `http`-only types → killed by "a missing browser action reds by name"; `postStages` returns the harness bodies instead of the built stages → killed by "builder output vs the harness's bodies"; `runCase` skips `driver.checks()` → killed by the run-cli "case's checks include" test; `caseDriver.close` skipped on a throw → killed by the "closed in finally" test.
- [ ] **Step 13:** Scoped tsc + eslint; commit `feat(matrix): BrowserDriver, mixed-driver ledger, --driver browser`.

---
## Task 7: Pad replay — framework, generic and badminton adapters, the PADPROOF scenario

**Files:**
- Create: `scripts/matrix/lib/pads/{types,replay,generic,badminton,index}.ts`, `scripts/matrix/lib/scenarios/pad-proof.ts`, `scripts/matrix/lib/pad-proof-set.ts`, `scripts/matrix/lib/driver/padpage-assignability.ts`
- Modify: `scripts/matrix/lib/driver/types.ts` (`PostedEvent.stored?`), `scripts/matrix/lib/driver/browser-driver.ts` (the pad path), `scripts/matrix/lib/scenarios/common.ts` (`decideFixture` folds the stored stream), `scripts/matrix/lib/scenarios/types.ts` (`"PADPROOF"`, `Scenario.padPolicy?`), `scripts/matrix/lib/scenarios/index.ts`, `scripts/matrix/run.ts` (`SETS["pad-proof"]`)
- Test: `scripts/matrix/__tests__/{pad-replay,pad-adapters,pad-proof,decide-stored}.test.ts`

**Interfaces:**
- Consumes (bench, ruling 38): `TapStep`, `TapAdapter`, `TapAdapterContext`, `PadPage`, `selectorForTapStep`, `START_MATCH_TESTID`, `FINALIZE_TESTID`, `TAP_WAIT_TIMEOUT_MS` from `scripts/bench/lib/drivers/scorer.ts`; `genericAdapter`, `GENERIC_TOLERATED_EXTRA_KEYS` from `scripts/bench/lib/drivers/adapters/generic.ts`; `LedgerRow` from `scripts/bench/lib/ledger.ts`. Matrix: `BrowserDriver` (T6), `HttpDriver.ledger` (T6), `budgetMs`, `TAP_PACE_MS` (T4), `generateStream` (`streams/index.ts`), `foldStream` (`scenarios/common.ts` import).
- Produces:
  ```ts
  // lib/pads/types.ts
  export interface Fallback { eventType: string; why: string; rowsFor(event: StreamEvent, ctx: TapAdapterContext): number }   // why cites file:line
  export interface MatrixPadAdapter extends TapAdapter {
    /** Every event type this sport's matrix generator emits (streams/<sport>.ts). Each is mapped by
     *  stepsFor or declared in fallbacks; pad-adapters.test.ts enforces it. */
    readonly emits: readonly string[];
    /** Types the pad cannot write one-for-one. stepsFor still returns the taps, which write `rows`
     *  `rowsFor` ledger rows; those rows are judged by fold, not by payload. */
    readonly fallbacks: readonly Fallback[];
    /** Keys an expected payload carries as null that the pad omits (the fold reads absent ≡ null). */
    nullAsAbsentKeys?(eventType: string): readonly string[];
  }
  // lib/pads/replay.ts
  export interface ReplayDeps { ledger(sinceSeq: number): Promise<readonly LedgerRow[]>; tip(): Promise<number>; sleep(ms: number): Promise<void>; holdMs: number }
  export type RowVerdict = "equal" | "tolerated" | "fallback" | "mismatch" | "missing";
  export interface ReplayRow { expected: StreamEvent; stored: readonly LedgerRow[]; verdict: RowVerdict; note: string | null }
  export interface ReplayResult { rows: ReplayRow[]; stored: StreamEvent[]; findings: string[] }
  export async function replayEvents(page: PadPage, adapter: MatrixPadAdapter, events: readonly StreamEvent[], ctx: TapAdapterContext, deps: ReplayDeps): Promise<ReplayResult>;
  export function compareRow(expected: StreamEvent, row: LedgerRow, adapter: MatrixPadAdapter): { verdict: "equal" | "tolerated" | "mismatch"; note: string | null };
  // lib/pads/index.ts
  export const PAD_ADAPTERS: Readonly<Partial<Record<string, MatrixPadAdapter>>>;   // grows T7→T11
  // driver/types.ts
  interface PostedEvent { stored?: StreamEvent }   // the ledger row as the product holds it (pad path only)
  // scenarios/types.ts
  type ScenarioKey = "LIFECYCLE" | "M1" | "R4" | "F1" | "DENIED" | "PADPROOF";
  interface Scenario { padPolicy?: "first" | "all" }   // default "first"
  // pad-proof-set.ts
  export const padProofPlanner: PlanCases;             // one case per sport, row league, scenario PADPROOF
  ```

### Step 0 — premises, pinned in a browser before any adapter is written

- [ ] **Step 0: Confirm, with the live stack from the Global Constraints recipe, by driving a browser (not by reading code).** Paste what was seen into the task report:
  1. At **320** and **1280**, on a started league|generic fixture in the console (`/o/<org>/c/<comp>/d/<div>/f/<no>`), `[data-testid="score-pad"]` is visible, and `score-start-match` is visible before start. If the pad is hidden at 320, **stop**: D2's premise is false. Record it and ask the owner; do not switch to a device link.
  2. league|badminton at builder default (`bwf`, bestOf 3): after `score-start-match`, `[data-tile-id="setScore"]` is visible and enabled (`data-tile-disabled` absent), and tapping it opens a sheet with exactly two `pad-sheet-number` steps (home, then away). Enter 21 / 13 and confirm. Read back the ledger row with `GET /api/v1/fixtures/<id>/events?since_seq=<tip>`, write down its `type` and its **exact payload keys**, and note whether the ledger gained the row without `pad-send-now` (immediate) or only after it (held).
  3. Tap `setScore` again and enter 21 / 13 for set 2. The fixture reaches `decided`, and `score-finalize` appears after a reload (the console polls every 15 s: bench `reloadConsoleBeforeAction`, `tap-play.ts:456`).
  4. generic in `win_loss` mode: does the pad offer a `draw` tile (`generic.tsx:513`) when `allowDraws` is true? Tap it and record the row's exact payload. The matrix emits `{isDraw: true}` (`streams/generic.ts:13`).
  5. Record `HOLD_MS` as served (`NEXT_PUBLIC_SCOREPAD_HOLD_MS`, 3000 in the recipe build).

  Anything that contradicts the adapter code below becomes a false premise in the report, and the code is changed to match what was seen. That is the brief-is-a-hypothesis rule, not a blocker.

### The executor

The copied `executeStep` landed in Task 4 (`lib/pads/execute.ts`, Steps 16a–16d). This task only consumes it.

### The replay

- [ ] **Step 5: Failing tests** `pad-replay.test.ts`, using a fake page plus a fake ledger that appends one row per mapped event when its last step is clicked:

```ts
  it("empty case first: no events → no taps, no rows, no findings", async () => {
    const r = await replayEvents(fakePage({}), stubAdapter(), [], CTX, fakeDeps([]));
    expect(r).toEqual({ rows: [], stored: [], findings: [] });
  });
  it("one event → its steps → one row compared exactly", async () => {
    const deps = fakeDeps([{ type: "badminton.game.summary", payload: { home: 21, away: 13 } }]);
    const r = await replayEvents(fakePage({}), badmintonAdapter, [{ type: "badminton.game.summary", payload: { home: 21, away: 13 } }], CTX, deps);
    expect(r.rows.map((x) => x.verdict)).toEqual(["equal"]);
    expect(r.stored).toEqual([{ type: "badminton.game.summary", payload: { home: 21, away: 13 } }]);
  });
  it("a row whose payload differs is a mismatch naming the key, and replay stops there (the next tap would build on a wrong state)", async () => {
    const deps = fakeDeps([{ type: "badminton.game.summary", payload: { home: 21, away: 12 } }]);
    const events = [SUMMARY(21, 13), SUMMARY(21, 13)];
    const r = await replayEvents(fakePage({}), badmintonAdapter, events, CTX, deps);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ verdict: "mismatch", note: expect.stringContaining("away") });
    expect(r.findings[0]).toMatch(/stopped after event 1 of 2/);
  });
  it("no row within the derived budget is `missing`, never a hang; the budget grows with HOLD_MS", async () => {
    const short = await replayEvents(fakePage({}), badmintonAdapter, [SUMMARY(21, 13)], CTX, fakeDeps([], { holdMs: 500 }));
    expect(short.rows[0].verdict).toBe("missing");
    expect(fakeDeps.lastPolls(500)).toBeLessThan(fakeDeps.lastPolls(3000));
  });
  it("a tolerated extra key passes and is kept as a note; an untolerated one fails", () => {
    const row = { id: "r", seq: 2, type: "generic.score", payload: { points: 1, person: "p1" } };
    expect(compareRow({ type: "generic.score", payload: { points: 1 } }, row, genericPad)).toMatchObject({ verdict: "tolerated" });
    expect(compareRow({ type: "generic.score", payload: { points: 1 } }, { ...row, payload: { points: 1, x: 1 } }, genericPad).verdict).toBe("mismatch");
  });
  it("nullAsAbsent: an expected null the pad omits is equal only for the declared key", () => {
    const pad = { ...stubAdapter(), nullAsAbsentKeys: (t: string) => (t === "carrom.board.summary" ? ["queenTo"] : []) };
    const row = (p: object) => ({ id: "r", seq: 2, type: "carrom.board.summary", payload: p });
    expect(compareRow({ type: "carrom.board.summary", payload: { winner: "a", opponentCoinsLeft: 9, queenTo: null } }, row({ winner: "a", opponentCoinsLeft: 9 }), pad).verdict).toBe("equal");
    expect(compareRow({ type: "carrom.board.summary", payload: { winner: "a", opponentCoinsLeft: 9, queenTo: "b" } }, row({ winner: "a", opponentCoinsLeft: 9 }), pad).verdict).toBe("mismatch");
  });
  it("a fallback event collects exactly its declared row count and is judged `fallback`, not per payload", async () => {
    const pad = stubAdapter({ fallbacks: [{ eventType: "cricket.innings.summary", why: "cricket.tsx:2579", rowsFor: () => 3 }] });
    const deps = fakeDeps([ROW("cricket.innings.summary"), ROW("cricket.innings.summary"), ROW("cricket.innings.close")]);
    const r = await replayEvents(fakePage({}), pad, [{ type: "cricket.innings.summary", payload: {} }], CTX, deps);
    expect(r.rows[0]).toMatchObject({ verdict: "fallback" });
    expect(r.rows[0].stored).toHaveLength(3);
  });
  it("paces every tap after the first by TAP_PACE_MS (the product drops a faster same-side repeat)", async () => {
    const deps = fakeDeps([ROW("x"), ROW("x")]);
    await replayEvents(fakePage({}), halfTapAdapter, [HALF("home"), HALF("home")], CTX, deps);
    expect(deps.sleeps.filter((ms) => ms === TAP_PACE_MS).length).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 6: Run — FAIL. Step 7: Write `replay.ts`.**

```ts
// One generated event → the adapter's taps → the ledger rows those taps wrote, compared with the
// event. Ruling 38: the bench's one-event-one-row contract and its exact bidirectional payload
// comparison (scorer.ts:480-496), rebuilt here without playMatchByTaps' fixed widths and
// unconditional finalize.
import type { LedgerRow } from "../../../bench/lib/ledger.ts";
import type { PadPage, TapAdapterContext } from "../../../bench/lib/drivers/scorer.ts";
import { TAP_WAIT_TIMEOUT_MS } from "../../../bench/lib/drivers/scorer.ts";
import { budgetMs, TAP_PACE_MS } from "../browser/budget.ts";
import type { StreamEvent } from "../streams/types.ts";
import { executeStep } from "./execute.ts";
import type { MatrixPadAdapter } from "./types.ts";

const POLL_MS = 200;

export function compareRow(expected: StreamEvent, row: LedgerRow, adapter: MatrixPadAdapter): { verdict: "equal" | "tolerated" | "mismatch"; note: string | null } {
  if (row.type !== expected.type) return { verdict: "mismatch", note: `type ${row.type}, expected ${expected.type}` };
  const want = (expected.payload ?? {}) as Record<string, unknown>;
  const got = (row.payload ?? {}) as Record<string, unknown>;
  const nullOk = new Set(adapter.nullAsAbsentKeys?.(expected.type) ?? []);
  const tolerable = new Set(adapter.tolerableExtraKeys?.(expected.type) ?? []);
  for (const [k, v] of Object.entries(want)) {
    if (!(k in got) && v === null && nullOk.has(k)) continue;
    if (JSON.stringify(got[k]) !== JSON.stringify(v)) return { verdict: "mismatch", note: `${k}: stored ${JSON.stringify(got[k])}, generated ${JSON.stringify(v)}` };
  }
  const extra = Object.keys(got).filter((k) => !(k in want));
  const bad = extra.filter((k) => !tolerable.has(k));
  if (bad.length > 0) return { verdict: "mismatch", note: `untolerated key(s) ${bad.join(", ")}` };
  return extra.length > 0 ? { verdict: "tolerated", note: `tolerated ${extra.map((k) => `${k}=${JSON.stringify(got[k])}`).join(", ")}` } : { verdict: "equal", note: null };
}

export async function replayEvents(page: PadPage, adapter: MatrixPadAdapter, events: readonly StreamEvent[], ctx: TapAdapterContext, deps: ReplayDeps): Promise<ReplayResult> {
  const out: ReplayResult = { rows: [], stored: [], findings: [] };
  let tip = await deps.tip();
  let tapped = false;
  for (const [i, ev] of events.entries()) {
    const fallback = adapter.fallbacks.find((f) => f.eventType === ev.type) ?? null;
    let steps;
    try { steps = adapter.stepsFor(ev, ctx); } catch (e) {
      out.findings.push(`event ${i + 1} (${ev.type}): no tap route — ${(e as Error).message}`);
      break;
    }
    const waitMs = Math.max(TAP_WAIT_TIMEOUT_MS, budgetMs({ taps: 1, holds: 0, holdMs: deps.holdMs }));
    for (const step of steps) {
      if (tapped && step.kind !== "releaseHold") await deps.sleep(TAP_PACE_MS);
      tapped = true;
      await executeStep(page, step, waitMs);
    }
    await executeStep(page, { kind: "releaseHold" }, waitMs);
    const want = fallback?.rowsFor(ev, ctx) ?? 1;
    const deadline = budgetMs({ taps: steps.length, holds: 1, holdMs: deps.holdMs });
    let rows: readonly LedgerRow[] = [];
    for (let waited = 0; rows.length < want && waited <= deadline; waited += POLL_MS) {
      if (waited > 0) await deps.sleep(POLL_MS);
      rows = await deps.ledger(tip);
    }
    if (rows.length < want) {
      out.rows.push({ expected: ev, stored: rows, verdict: "missing", note: `${rows.length} of ${want} row(s) within ${deadline}ms` });
      out.findings.push(`stopped after event ${i + 1} of ${events.length}: row missing`);
      break;
    }
    const mine = rows.slice(0, want);
    tip = mine.at(-1)!.seq;
    out.stored.push(...mine.map((r) => ({ type: r.type, payload: r.payload })));
    if (fallback !== null) { out.rows.push({ expected: ev, stored: mine, verdict: "fallback", note: fallback.why }); continue; }
    const c = compareRow(ev, mine[0], adapter);
    out.rows.push({ expected: ev, stored: mine, verdict: c.verdict, note: c.note });
    if (c.verdict === "mismatch") { out.findings.push(`stopped after event ${i + 1} of ${events.length}: ${c.note}`); break; }
  }
  return out;
}
```

  `ReplayDeps.tip` is `(await http.fixtureState(id)).last_seq`, **the server's tip, never a count of taps**, because a held tap is not yet sequenced (`ledger.ts:137-143`). **Step 8: PASS.**

### Adapters: generic and badminton

- [ ] **Step 9: Failing tests** `pad-adapters.test.ts`. It is parameterised over `PAD_ADAPTERS`, so every later task's adapters join it with no new test code:

```ts
  it("empty case first: the registry is non-empty and every key is a real sport in registry order", () => {
    const keys = Object.keys(PAD_ADAPTERS);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual(SPORT_KEYS.filter((k) => k in PAD_ADAPTERS));   // wave order, never re-sorted
  });
  it.each(Object.entries(PAD_ADAPTERS))("%s: emits equals what its generator actually emits across every outcome it accepts", (sport, a) => {
    const seen = new Set<string>();
    for (const req of requestsFor(sport)) {          // builder-default cfg; home win, away win, draw where drawsAllowed, forfeit
      try { for (const e of generateStream(req)) seen.add(e.type); } catch (e) { if (!(e instanceof GeneratorUnsupported)) throw e; }
    }
    expect(seen.size).toBeGreaterThan(0);
    expect([...a!.emits].sort()).toEqual([...seen].filter((t) => t !== "core.forfeit").sort());  // forfeit is organiser-only (organiserStepsFor)
  });
  it.each(Object.entries(PAD_ADAPTERS))("%s: every emitted type is routed (stepsFor returns ≥1 step) or declared a fallback with a file:line reason", (sport, a) => {
    for (const req of requestsFor(sport)) {
      let evs: StreamEvent[] = [];
      try { evs = generateStream(req); } catch { continue; }
      for (const e of evs.filter((x) => x.type !== "core.forfeit")) {
        expect(a!.stepsFor(e, { cfg: req.cfg, entrants: { home: req.home, away: req.away } }).length, `${e.type}`).toBeGreaterThan(0);
        const fb = a!.fallbacks.find((f) => f.eventType === e.type);
        if (fb) expect(fb.why).toMatch(/\.tsx?:\d+/);
      }
    }
  });
  it("generic delegates to the bench's genericAdapter for every route the bench maps", () => {
    const req = genericReq("score", { kind: "decided", winner: "home" });
    for (const e of generateStream(req)) expect(genericPad.stepsFor(e, ctxOf(req))).toEqual(genericAdapter.stepsFor(e, ctxOf(req)));
  });
  it("generic win_loss draw is the pad's draw tile (the bench throws here, generic.ts:166-170)", () => {
    const req = genericReq("win_loss", { kind: "draw" });
    const draw = generateStream(req).find((e) => e.type === "generic.result")!;
    expect(() => genericAdapter.stepsFor(draw, ctxOf(req))).toThrow();
    expect(genericPad.stepsFor(draw, ctxOf(req))).toEqual([{ kind: "tile", tileId: GENERIC_DRAW_TILE_ID }]);
  });
  it("badminton: a set summary is the setScore sheet with the generated numbers, home first", () => {
    const req = badmintonReq({ kind: "decided", winner: "away" });
    const sums = generateStream(req).filter((e) => e.type === "badminton.game.summary");
    expect(sums.length).toBe(2);                     // bwf bestOf 3, straight sets: derived from the engine preset, not typed
    expect(badmintonPad.stepsFor(sums[0], ctxOf(req))).toEqual([
      { kind: "tile", tileId: "setScore" },
      { kind: "number", value: (sums[0].payload as { home: number }).home }, { kind: "confirm" },
      { kind: "number", value: (sums[0].payload as { away: number }).away }, { kind: "confirm" },
    ]);
  });
  it("pins: each adapter's tile ids and event types are the product's own exports", () => {
    expect(GENERIC_DRAW_TILE_ID).toBe(genericSkinDrawTileId());            // regex-extracted from generic.tsx in beforeAll
    expect(BADMINTON_SET_SCORE_TILE).toBe(BadmintonSkin.SET_SCORE_TILE_ID); // test-only import of badminton.tsx
    expect(BADMINTON_SUMMARY).toBe(BadmintonSkin.SUMMARY_TYPE);
  });
```

  `requestsFor(sport)` builds `StreamRequest`s from the **engine's** builder-default preset. It uses `pickVariant`'s rule, restated from `division-builder.tsx:56-67` and pinned by a regex over that file, never typed values, so a preset change moves the test (class 19). Whether a draw is requested follows `drawsAllowed`.

- [ ] **Step 10: Run — FAIL. Step 11: Write the adapters.**

  `lib/pads/generic.ts`:
  ```ts
  // generic — the bench's genericAdapter (ruling 38) plus the one route it leaves owed: a
  // win_loss draw, which the pad authors with its draw tile (generic.tsx:513, Step 0 item 4).
  import { genericAdapter } from "../../../bench/lib/drivers/adapters/generic.ts";
  import type { MatrixPadAdapter } from "./types.ts";

  export const GENERIC_DRAW_TILE_ID = "draw";            // generic.tsx:513 — pinned in pad-adapters.test.ts

  export const genericPad: MatrixPadAdapter = {
    sport: "generic",
    emits: ["core.start", "generic.result"],
    fallbacks: [],
    stepsFor(event, ctx) {
      const p = event.payload as Record<string, unknown> | null;
      if (event.type === "generic.result" && p !== null && p.isDraw === true && Object.keys(p).length === 1) return [{ kind: "tile", tileId: GENERIC_DRAW_TILE_ID }];
      return genericAdapter.stepsFor(event, ctx);
    },
    tolerableExtraKeys: (t) => genericAdapter.tolerableExtraKeys?.(t) ?? [],
  };
  ```
  If Step 0 item 4 showed that the draw tile writes something other than `{isDraw: true}`, the route is still kept, and the key the pad adds goes in `tolerableExtraKeys` with its file:line. If the pad offers no draw at all, `stepsFor` throws `"win_loss draw has no pad route → W1d"`, and the row is recorded in the per-adapter table (T15).

  `lib/pads/badminton.ts`:
  ```ts
  // badminton — the setScore tile authors the coarse game summary the matrix generator emits
  // (badminton.tsx:909 SET_SCORE_TILE_ID, :950 offered when no game is in progress, :1036-1050 the
  // sheet: number steps home then away). One event → one row.
  import { START_MATCH_TESTID } from "../../../bench/lib/drivers/scorer.ts";
  import type { MatrixPadAdapter } from "./types.ts";

  export const BADMINTON_SET_SCORE_TILE = "setScore";
  export const BADMINTON_SUMMARY = "badminton.game.summary";

  export const badmintonPad: MatrixPadAdapter = {
    sport: "badminton",
    emits: ["core.start", BADMINTON_SUMMARY],
    fallbacks: [],
    stepsFor(event) {
      if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
      if (event.type === BADMINTON_SUMMARY) {
        const { home, away } = event.payload as { home: number; away: number };
        return [{ kind: "tile", tileId: BADMINTON_SET_SCORE_TILE }, { kind: "number", value: home }, { kind: "confirm" }, { kind: "number", value: away }, { kind: "confirm" }];
      }
      throw new Error(`badmintonPad: no tap route for ${event.type}`);
    },
    tolerableExtraKeys: () => [],     // Step 0 item 2 decides; any key added here carries badminton.tsx:<line>
  };
  ```
  `lib/pads/index.ts`: `PAD_ADAPTERS = Object.freeze({ badminton: badmintonPad, generic: genericPad })`, **in the order `SPORT_KEYS` lists them** (the registry's wave order; class 18).

  `lib/driver/padpage-assignability.ts` is a compile-time proof that a Playwright `Page` is a bench `PadPage` with no cast. It is copied in shape from `scripts/bench/lib/drivers/padpage-assignability.ts:16-28`, including its `@ts-expect-error` negative control, and is checked by `tsc -p tsconfig.scripts.json`.

- [ ] **Step 12: PASS** (`pad-adapters`, `pad-replay`).

### The pad path in the driver, and folding what the product stored

- [ ] **Step 13: Failing tests.**
  - `browser-driver.test.ts` gains:
    - **"postStream on the pad path: taps via the injected replay; returns PostedEvents carrying `stored`"**. The fake replay returns two stored rows, and `postStream` returns two `PostedEvent`s whose `stored` equals them, with `seq` taken from the rows.
    - **"a sport with no adapter is not tapped: http, and `pad-route` abstains naming the owning task"**.
    - **"a replay finding is a failing `pad-ledger-as-generated` check naming the fixture and the event index"**.
    - **"the pad path never finalizes"**. After `postStream`, no finalize call reaches the fake pages or the http fake. Finalize is PADPROOF's own step (Review Focus 2's parity guard).
  - `decide-stored.test.ts` (with `FakeLeagueDriver`):
    - **"when every PostedEvent carries `stored`, decideFixture folds the stored stream and records it as the fixture's stream"**. A stored summary differing from the generated one (21-12 vs 21-13) yields the stored fold's outcome in `rec.parity`, and `rec.streams` holds the stored events.
    - **"without `stored` (the http path), decideFixture is unchanged"**. The existing `scenarios.test.ts` cases stay green with unchanged counts, pasted.

- [ ] **Step 14: Run — FAIL. Step 15: Implement.**
  - `PostedEvent.stored?: StreamEvent` goes in `types.ts`.
  - In `decideFixture` (`common.ts:176-180`), replace `const whole = [...prior, ...now];` with:
    ```ts
    // W1c: the pad path returns the ledger rows the product actually stored; fold those, so the
    // browser run is judged on what the product holds, never on what the harness meant to send.
    const sent = posted.length > 0 && posted.every((p) => p.stored !== undefined) ? posted.map((p) => p.stored!) : now;
    const whole = [...prior, ...sent];
    ```
    Keep `rec.events += now.length` as it is: counts are harness-intended events, which is what `counts.events` has always meant.
  - `BrowserDriver.postStream`, when `ledger.wantsBrowser("score", padPolicy)` and `PAD_ADAPTERS[spec.sport]` exists, does the following:
    1. `openFixtureUi` (T5).
    2. `replayEvents(page, adapter, events, { cfg, entrants: { home, away } }, { ledger: (s) => http.ledger(id, s), tip: async () => (await http.fixtureState(id)).last_seq, sleep, holdMs: holdMsFromEnv() })`. `home`/`away` come from `http.listFixtures`, a read.
    3. Push `pad-ledger-as-generated`: `checked` = rows compared; fail on any `mismatch`/`missing` or on any finding; evidence = each row's note.
    4. Return `PostedEvent[]` built from the stored rows (`seq`, `status`/`outcome` from one trailing `http.fixtureState`, `event_id` = row id, `stored`).
    5. `ledger.record("score", "browser")`.

    Otherwise it takes the http branch and, when no adapter exists, pushes `pad-route` abstain `no pad adapter for <sport> yet → W1c Task <9|10|11>`, so the case is never green on a promise.

  **Step 16: PASS**, plus the whole `scenarios.test.ts` and `browser-driver.test.ts`, with counts pasted.

### PADPROOF — every fixture on the pad, then finalized

- [ ] **Step 17: Failing tests** `pad-proof.test.ts` (FakeLeagueDriver plus the fake BrowserDriver hooks):
  - **"empty case first: a league with no fixtures is a failing `pad-finalized` (checked 0)"**.
  - **"3 entrants → 3 fixtures; outcomes [home win, draw-or-away-win, away win]"**. The middle outcome is a draw exactly where `drawsAllowed(sport, cfg, "league")` is true, derived from the engine and not typed. Every fixture is posted through `postStream` with `padPolicy: "all"`, then finalized through `driver.finalize`. `pad-finalized` passes with `checked` 3 when every `fixtureState` is `finalized`.
  - **"pad-outcome-as-requested: each fixture's stored-stream fold matches its request"** (via `matchesRequest`). The canary adds the deliberately wrong winner, as M1 does (`withCanary`).
  - **"a driver without `finalize` fails `pad-finalized` naming it"** (HttpDriver in a non-browser run cannot claim this proof).
  - **"planner: one case per sport in PAD_ADAPTERS order, row league, scenario PADPROOF, width from --width; a sport not in PAD_ADAPTERS is ScenarioUnsupported naming its task"**.

- [ ] **Step 18: Run — FAIL. Step 19: Implement.**

  `scenarios/pad-proof.ts`:
  ```ts
  // PADPROOF (W1c D3): the pad itself decides a whole league, and every result is finalized from
  // the console, so the fold, the standings and the finalize path are all proven through the
  // product's own controls. Builder-default config: the length a real organiser gets.
  export const padProof: Scenario = {
    key: "PADPROOF",
    entrantCount: 3,
    canaryCheck: "pad-outcome-as-requested",
    padPolicy: "all",
    async run(ctx) {
      if (ctx.driver.finalize === undefined) throw new ScenarioUnsupported("W1c", "PADPROOF needs a driver that finalizes (the browser driver)");
      const rec = new Recorder();
      const setup = await setUpDivision(ctx, rec, 3);
      const drawOk = drawsAllowed(ctx.spec.sport, ctx.cfg, "league");
      const plan: RequestedOutcome[] = [{ kind: "decided", winner: "home" }, drawOk ? { kind: "draw" } : { kind: "decided", winner: "away" }, { kind: "decided", winner: "away" }];
      const fixtures = (await ctx.driver.listFixtures(setup.division.id)).sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0));
      for (const [i, f] of fixtures.entries()) await decideFixture(ctx, rec, setup, f, plan[i % plan.length]);
      const finalized: { ok: boolean; note: string }[] = [];
      for (const f of fixtures) { const s = await ctx.driver.finalize(f.id); finalized.push({ ok: s.status === "finalized", note: `${f.id}: ${s.status}` }); }
      const complete = await finishStage(ctx, rec, setup);
      const observed = await snapshot(ctx, rec, setup, { complete, configEdit: null, withdrawal: null });
      return { observed, events: rec.events, notes: rec.notes, assertions: [
        builtAsPosted(setup.built, observed), foldParity(rec), resultsAsPosted(rec, observed),
        assertion("pad-finalized", finalized.length === 0 ? [{ ok: false, note: "no fixture to finalize" }] : finalized),
        assertion("pad-outcome-as-requested", withCanary(rec.parity.map((p) => ({ ok: p.request === "match", note: `${p.fixtureId}: request ${p.request}` })), rec.parity.map((p) => ({ ok: p.request !== "match", note: `${p.fixtureId}: canary expects a mismatch` })), ctx.spec.canary)),
        stageCompleted(observed), loopBounded(rec, observed),
      ] };
    },
  };
  ```
  `assertion` already fails a zero-item check (R25). The exact `withCanary` and `assertion` signatures are read from `assertions.ts` at implementation time, and the call is written to match them, not to this sketch.

  `pad-proof-set.ts` sets `padProofPlanner = () => Object.keys(PAD_ADAPTERS).map((sport) => ({ caseId: `league|${sport}|PADPROOF`, row: "league", sport, variant: builderDefaultVariant(sport), scenario: "PADPROOF", canary: false }))`. `builderDefaultVariant` is the pinned `pickVariant` rule from Step 9. `run.ts` then gets `SETS["pad-proof"] = padProofPlanner`, and PADPROOF refuses `--driver http` with a usage error (exit 2).

  **Step 20: PASS** (`pad-proof`, `run-cli`, `scenarios`).

### Proof

- [ ] **Step 21: Mutations, each killed by a named test.**

  | Mutation | Killed by |
  |---|---|
  | `compareRow` ignores extra keys | "a tolerated extra key passes… an untolerated one fails" |
  | `nullAsAbsent` applied to every key | "nullAsAbsent… only for the declared key" |
  | `replayEvents` continues after a mismatch | "replay stops there" |
  | `tip` counted from taps instead of the server | the live run in Step 23 reds (recorded as a live kill; the unit fakes cannot see it) |
  | `decideFixture` folds `now` even when `stored` is set | "decideFixture folds the stored stream" |
  | `postStream` finalizes | "the pad path never finalizes" |
  | badminton steps swap home/away | "home first" |
  | generic draw falls through to the bench (throws) | "generic win_loss draw is the pad's draw tile" |

- [ ] **Step 22: Scoped gate.** `cd <exec worktree> && ./node_modules/.bin/tsc -p tsconfig.scripts.json --noEmit` (via `rtk proxy`), eslint over the new files, then the vitest JSON template over `pad-replay pad-adapters pad-proof decide-stored browser-driver scenarios run-cli boundary strip-types-loadable`. Paste `numPassedTests/numTotalTests` and confirm that `.testResults[].name` resolves inside the exec worktree.

- [ ] **Step 23: Live pad proof: generic and badminton, at 1280 and at 320.** Use the live-run recipe from the Global Constraints:
  ```
  cd <exec worktree> && pnpm matrix:browser --set pad-proof --width 1280 --run-id w1c-t7-1280 --report-dir docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1c-t7 ; echo EXIT=$?
  cd <exec worktree> && pnpm matrix:browser --set pad-proof --width 320  --run-id w1c-t7-320  --report-dir docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1c-t7 ; echo EXIT=$?
  ```
  Expected: both cases ✅ at both widths. Every row of `pad-ledger-as-generated` must be `equal` or `tolerated`, `pad-finalized` must be `checked 3`, and `mixed-driver-coverage` must pass. Paste the `results.json` state and every check's `verdict/checked` per case. Open three screenshots per case (start, mid-set sheet, finalized) and confirm that they exist and that they **differ** (class 10). A red is a finding: record it with its row note and carry on to Task 8. Never loosen a comparison to turn it green.

- [ ] **Step 24: Commit** `feat(matrix): pad replay (bench tap vocabulary), generic + badminton adapters, PADPROOF`.

---

## Task 8: Walkthrough A — the first L1 slice through the browser, reviewed screen by screen

This is the first place a person could see the whole organiser path. No new modules. It proves Tasks 4–7 together on two sports, and it is the gate before any more adapters are built.

**Files:**
- Create: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1c-walkthrough-a/{results.json,README.md,shots/…}` (evidence only)
- Modify: none in code. A defect found here is fixed in the task that owns the module, with its own failing test first, and that task's commit is amended forward as a new commit.

- [ ] **Step 1: HTTP baseline for the same cases.**
  ```
  cd <exec worktree> && pnpm matrix:l3 --only league --scenario LIFECYCLE --run-id w1c-wa-http ; echo EXIT=$?
  ```
  Filter the evidence to the generic and badminton cases, and paste their states. Both must be ✅. If they are not, stop: the browser run cannot be judged against a red baseline (class 14).

- [ ] **Step 2: Browser, both widths.** Run `pnpm matrix:browser --only league --scenario LIFECYCLE --width 1280 …` and then `--width 320`. With `padPolicy: "first"`, each case drives:
  - every organiser action type once in the browser: create competition, the division through the builder, entrants, start, generate, score (the first fixture, on the pad), forfeit, standings view and public view;
  - everything else over HTTP.

- [ ] **Step 3: Read every browser check** in both `results.json` files and paste one line per check (`id verdict checked`):
  - `mixed-driver-coverage` passes, and `checked` equals the number of distinct action types the scenario invoked;
  - `builder-posted-as-harness` passes;
  - `organiser-ui-path` passes;
  - `ui-standings-match`, `ui-public-standings-match`;
  - `pad-ledger-as-generated`;
  - `no-horizontal-scroll`;
  - `visual-evidence`.

  None may be `checked 0`, because zero checked is a failure (R25).

- [ ] **Step 4: Per-screen visual verdicts (class 11).** For each case × width, open every captured screen:
  - builder (sport/variant chosen, format chosen);
  - entrants (added);
  - launch (started);
  - stage rail (generated; at 320 after its fold opened);
  - run sheet (filter widened);
  - console (pad before start, pad mid-entry, decided);
  - standings;
  - public division.

  Write one verdict line per screen into `README.md`: `<screen> @<width>: ok | defect <what the eye sees>`. Crop the images with the house trap in mind (full-page shots swamp context). A screen that looks identical to its predecessor is a harness defect (nothing opened), never a pass.

- [ ] **Step 5: Parity preview.** Diff the browser and HTTP cases by hand for this slice: state, and each common check's verdict/checked. Task 13 automates this; doing it here once by hand calibrates the automation's expected output.

- [ ] **Step 6: Re-run the 320 leg twice more** (a flaky-shaped gate, class 8) and paste all three states. If any differ, it is a flake finding with the differing check named. It is not averaged away.

- [ ] **Step 7: Reviewer gate.** Dispatch the reviewer over the branch diff to this point, with Review Focus 1–5 and this walkthrough's README as its inputs. Fix every Important finding in the task that owns the code, test first. Commit the evidence: `docs(matrix): W1c walkthrough A — league × generic/badminton @1280/@320`.
## Tasks 9–11: The other nine sport adapters

The three tasks share one recipe. Each is a separate task because each adds its own product-side pins and its own live pad proof, and a reviewer could reject one sport family while approving another.

**The recipe, per sport:**
1. **Step 0, in a browser** (not by reading code): at the sport's builder-default variant, on a started fixture at 320, tap the route written below once per emitted event type. For each, read the row back from `GET /events?since_seq=<tip>`, write down its type and **exact payload keys**, and note whether it held (needed `pad-send-now`) or landed immediately. Any difference from the table below is a false premise. Record it, and change the adapter to what was seen.
2. **Pins** (in `pad-adapters.test.ts`, one `it` per sport): each tile id, choice option id and event type the adapter names equals the product's own export (a test-only import of the skin), or a regex over the skin's source if it is not exported, extracted in `beforeAll` so a reformat cannot break collection (the bench's pattern, `scorer-driver.test.ts:741-800`).
3. **A route test** per emitted type: the adapter's steps for one generated event, with the numbers taken from `generateStream`'s own output, never typed.
4. **Fallbacks**: a type the pad cannot write one-for-one is declared in `fallbacks` with a file:line `why` and a `rowsFor` that the route test asserts equals the number of rows the steps write in the fake ledger.
5. **Rosters**: added only when Step 0 shows that the pad refuses without them. Rosters are always **full size** (`playersPerSide` from the engine's resolved cfg), because a short lineup changes the engine's all-out (`cricket.ts:625-629`) and so changes what the same stream means. A roster is seeded over HTTP for **both** drivers' cases of that sport (`lib/scenarios/rosters.ts`, from `apps/web/e2e/helpers.ts:2098` `seedRosteredFixture`'s wire shapes: `POST /api/v1/persons`, entrant members, `PUT /api/v1/fixtures/:id/lineups/:entrantId`), so parity compares like with like.
6. **Register** in `PAD_ADAPTERS` at the sport's `SPORT_KEYS` position. The parameterised tests from Task 7 then cover it with no new structural test code.
7. **Live pad proof** at 1280 and 320: `pnpm matrix:browser --set pad-proof --width <w> …` (the set runs every registered adapter, so earlier sports re-run as a regression). Paste each case's state and `pad-ledger-as-generated` / `pad-finalized` verdict/checked, and open three screenshots per new sport (exists, and differs).
8. **Mutate once** per sport: swap the home/away order, or drop one step. The route test must red, and its name is pasted.
9. **Commit** `feat(matrix): <sports> pad adapters`.

Every "Route" cell below comes from the pad scout (Appendix B) and from reading the skin. None has been driven yet. Step 0 exists to find where they are wrong.

---

## Task 9: tabletennis, volleyball, tennis — the set-summary family

**Files:** Create `scripts/matrix/lib/pads/{tabletennis,volleyball,tennis}.ts`. Modify `lib/pads/index.ts` and `__tests__/pad-adapters.test.ts`.

| Sport (builder default) | Emits (`streams/*.ts`) | Route | Step 0 must settle |
|---|---|---|---|
| tabletennis (`bo5`: bestOf 5, 11, winBy 2) | `core.start`, `tabletennis.game.summary {home, away}` × 3 | `START_MATCH_TESTID`; tile `setScore` (`tabletennis.tsx:757,838`) → number home, confirm, number away, confirm (`:968` sheet) | Is `serveAnchor` (`:759`) required before `setScore` is enabled? If it is, prepend `{tile serveAnchor}` plus its choice steps to the first summary only, and record the extra row it writes: `rowsFor` becomes 2 for that event, judged by fold (a fallback) |
| volleyball (`beach`: bestOf 3, 21/15) | `core.start`, `volleyball.set.summary {home, away}` × 2 | `START_MATCH_TESTID`; tile `setScore` (`volleyball.tsx:921`) → the same four steps | Does an unopened set's opener sheet (`tapSheet`, `:716`) intercept `setScore`? Does beach need a roster? (The indoor spec seeds 6 positioned players; beach rosterless is unverified) |
| tennis (`tour`: bestOf 3, 6-game sets) | `core.start`, `tennis.set_summary {home, away}` × 2 (6-3) | `START_MATCH_TESTID`; tile `setScore` (`tennis.tsx:702-709`) → number home, confirm, number away, confirm. The tie-break steps are `when: tbShape` (`:880-889`), so a 6-3 set never asks them | That `tbShape` is false at 6-3, so the payload has no `tb` key; and whether the sheet's first step is home or away |

Adapter shape (tabletennis shown; volleyball and tennis differ only in the constants in the table):

```ts
// tabletennis — the setScore tile authors the coarse game summary (tabletennis.tsx:757 tile id,
// :838 offered when no game is in progress, :968 the sheet's event). One event → one row.
import { START_MATCH_TESTID } from "../../../bench/lib/drivers/scorer.ts";
import type { MatrixPadAdapter } from "./types.ts";

export const TABLETENNIS_SET_SCORE_TILE = "setScore";
export const TABLETENNIS_SUMMARY = "tabletennis.game.summary";

export const tabletennisPad: MatrixPadAdapter = {
  sport: "tabletennis",
  emits: ["core.start", TABLETENNIS_SUMMARY],
  fallbacks: [],
  stepsFor(event) {
    if (event.type === "core.start") return [{ kind: "testid", testid: START_MATCH_TESTID }];
    if (event.type === TABLETENNIS_SUMMARY) {
      const { home, away } = event.payload as { home: number; away: number };
      return [{ kind: "tile", tileId: TABLETENNIS_SET_SCORE_TILE }, { kind: "number", value: home }, { kind: "confirm" }, { kind: "number", value: away }, { kind: "confirm" }];
    }
    throw new Error(`tabletennisPad: no tap route for ${event.type}`);
  },
  tolerableExtraKeys: () => [],
};
```

Three near-identical files are the house's "three similar lines beat a premature abstraction". Do **not** extract a `setScorePad(sport, type)` factory in this task. If Task 11 adds a fourth, the reviewer decides then.

Specific tests:
- **"tennis: a 6-3 set's steps carry no tie-break numbers"**: the steps for `generateStream`'s first `tennis.set_summary` are exactly 5.
- **"volleyball beach: two set summaries, the second to 21 not 15"**: derived from the engine's beach preset (`finalSetTo` applies only at set index bestOf−1).

**Live:** the pad-proof set now runs 5 sports × 2 widths. Paste all 10 states.

---

## Task 10: football, hockey, icehockey — goals and period markers

**Files:** Create `scripts/matrix/lib/pads/{football,hockey,icehockey}.ts` and, only if Step 0 requires it, `scripts/matrix/lib/scenarios/rosters.ts`. Modify `lib/pads/index.ts`, `__tests__/pad-adapters.test.ts`, and `scenarios/common.ts` (`setUpDivision` calls `seedRosters` after generate for a sport in `ROSTERED_SPORTS`; that set is empty unless Step 0 fills it).

| Sport (builder default) | Emits | Route | Step 0 must settle |
|---|---|---|---|
| football (`11-a-side`: 2×45, no ET, no shootout) | `core.start`; `football.goal {by, minute: 10}` (decided only); `football.period {phase: "HT"}`, `{phase: "FT"}` | start; `goal-home` / `goal-away` tile (`football.tsx:763`) → it HOLDS → `releaseHold`; tile `period` (`:854`) → choice `HT`; tile `period` → choice `FT` (`deciders-fullmatch.spec.ts:163-166`) | The goal row's payload keys. The pad stamps its own `minute` (from the clock or a sheet), so `minute: 10` is almost certainly not reproducible. **Expected declaration:** `football.goal` is a fallback (`rowsFor` 1, judged by fold: the side is what decides the result, the minute does not), with the `why` citing the goal builder's line. Also: can a goal be recorded with no lineup? If not, `ROSTERED_SPORTS` gains football, with 11 per side |
| hockey (`fih-outdoor`: 4×15, no OT, no shootout) | `core.start`; `hockey.goal {by}` (decided only); `hockey.period.advance {to}` for Q2, Q3, Q4, FT | start; `goal-home` / `goal-away` (`period-shared.ts:904`); tile `advance` (`:952`), one tap per label, IMMEDIATE | Whether the pad's advance row is exactly `{to}`, and whether the goal adds keys (`person`, `minute`) → tolerated with file:line, or a fallback |
| icehockey (`iihf`: 3×20, OT 5′, shootout 5) | as hockey with P2, P3, FT; never a draw (`supportsDraws` false) | as hockey | That a 1-0 at P3's end decides without OT (the stream relies on it); the advance label set |

`advance` carries no label choice (it is one tap to the next period), so the adapter checks that the label it is about to write is the one the event names. It keeps a per-fixture cursor over `periodLabels(count)` (imported from `streams/period.ts`, one authority) and throws `advance would write <next>, event names <to>` on a mismatch. That throw becomes a replay finding, never a silent wrong tap.

Specific tests:
- **"hockey: 4 advances in label order, and a wrong-order event throws naming both labels"**.
- **"football: a declared fallback's rowsFor equals the rows its steps write in the fake ledger"** (1 for the goal).
- **"rosters, if added: playersPerSide comes from the engine's resolved cfg (not typed), and the same roster is seeded for the http and browser cases"**. This test is written only if Step 0 fills `ROSTERED_SPORTS`, and the step says which way it went.

**Live:** 8 sports × 2 widths. Paste 16 states.

---

## Task 11: cricket, boardgame, carrom — then all eleven, live

**Files:** Create `scripts/matrix/lib/pads/{cricket,boardgame,carrom}.ts`. Modify `lib/pads/index.ts`, `__tests__/pad-adapters.test.ts`, and `lib/scenarios/rosters.ts` if cricket needs it.

| Sport (builder default) | Emits | Route | Step 0 must settle |
|---|---|---|---|
| boardgame (`blitz`) | `core.start`; `boardgame.result {winner, method: "checkmate"}`, or a draw `{winner: null, method: "agreement"}` | start; half `home` / `away` → dock method chip `checkmate` → `releaseHold` (`boardgame-result.spec.ts:135,181,195`); draw: tile `draw` (`boardgame.tsx:399`) → its method `agreement` if asked → `releaseHold` | The method chip id for checkmate, whether the draw tile asks for a method or stamps its own, and the exact result payload keys |
| carrom (`club-29`) | `core.start`; `carrom.board.summary {winner, opponentCoinsLeft: 9, queenTo: null}` × n | start; tile `board` (`carrom.tsx:373`) → choice `home` / `away` (winner) → number 9 → confirm → `releaseHold` (`carrom-match.spec.ts:172-188`) | `nullAsAbsentKeys("carrom.board.summary") = ["queenTo"]`, with the reason at `carrom.tsx:440-446` ("`queenTo` is simply never asked here, which reads exactly like an explicit `null` to the fold"); and whether the winner option ids are `home` / `away` or entrant ids |
| cricket (`t20`: 120 balls, 11 a side) | `core.start`; `cricket.innings.summary {runs, wickets, legalBalls}` × 2, **non-partial** | **Fallback.** The pad authors `cricket.innings.summary` only as an over summary: `partial: true`, cumulative, with at most one over of balls per sheet (`cricket.tsx:2565-2590`, `overSummary`). One generated innings is therefore ⌈legalBalls / ballsPerOver⌉ over-summary sheets, followed by the innings close (`inningsCloseSheet`, registered in `buildSheets` at `cricket.tsx:2594`), unless the innings ended itself (all out, or the chase passing its target) | That the over-summary tile is offered on a fresh innings at `fidelity !== "fine"` (`:1515`); what `inningsClose` writes; whether the chase auto-decides on the over that passes the target (so no close row); whether any lineup (openers, bowler) is demanded before the first sheet → if it is, `ROSTERED_SPORTS` gains cricket with **11** per side |

The cricket route spreads the innings' runs as evenly as whole numbers allow: `floor(runs/overs)` each, with the remainder on the last over. Its wickets go on the last over, and its balls fill each over to `ballsPerOver` with the remainder on the last. The resulting stored sum equals the generated summary. A test asserts that the sum of the steps' runs, wickets and balls equals the event's payload, for both innings of both outcomes, and that `rowsFor` equals `overs + (closes ? 1 : 0)`. The fold then judges the stored stream, and `pad-outcome-as-requested` proves that it reaches the same result.

Specific tests:
- **"cricket: over steps sum to the generated innings, and rowsFor matches"**. Both innings, both outcomes, with `ballsPerOver` from the engine cfg.
- **"carrom: queenTo null ≡ absent only for board.summary"**.
- **"boardgame: a draw's steps never tap a half"**.

**Live, the full pad-proof set:** 11 sports × 1280 and 320 = 22 cases. Paste the table:

```
sport  width  state  pad-ledger-as-generated (equal/tolerated/fallback/mismatch/missing)  pad-finalized  wall-clock
```

Every ✅ must come with `pad-finalized checked 3`. For every red, the report names the event index and the row note. Re-run the whole set twice more (class 8) and paste all three runs' states. Any sport that is red in all three runs gets a row in Task 15's per-adapter table, stating the owning wave (W1d, or the product programme if the pad is the defect).
## Task 12: Layer planners — L1, L2 from the committed file, the width sweep, the API-only set

**Files:**
- Create: `scripts/matrix/lib/layers.ts`
- Modify: `scripts/matrix/run.ts` (`--layer L1|L2`; `SETS["width-sweep"]`, `SETS["api-only-browser"]`)
- Test: `scripts/matrix/__tests__/layers.test.ts`, `run-cli.test.ts`

**Interfaces:**
- Consumes: `slicePlanner` / `planSliceCases` (`slice.ts:58-70`), `L2Run` / `L2_WIDTHS` (`pairs.ts:22-37`), `catalogue/l2-pairs.json`, `ATOMIC` / `HARNESS_SCENARIO` / `KNOWN_NO_PATH` / `KNOWN_UI_NO_PATH` (`scenario-catalogue.ts:144-188`), `API_ONLY_ROWS` (`catalogue.ts`), `decideState` with `noPath` / `notRun` (T3).
- Produces:
  ```ts
  export interface LayerCase { spec: CaseSpec; layer: "L1" | "L2"; width: BrowserWidth; noPath: string | null; notRun: string | null }
  export function planL1(filter: { only?: string; scenario?: ScenarioKey }, widths: readonly BrowserWidth[]): LayerCase[];   // slice cells × LIFECYCLE × widths
  export function planL2(pairs: { runs: readonly L2Run[] }, cells: ReadonlySet<string>): LayerCase[];                     // filter only; never re-plans
  export const widthSweepPlanner: PlanCases;    // league|badminton LIFECYCLE @ 360/375/390/430/768/834
  export const apiOnlyBrowserPlanner: PlanCases; // each API_ONLY row × generic, LIFECYCLE @1280
  ```

- [ ] **Step 1: Failing tests** `layers.test.ts`:
  - **"empty case first: an L2 filter that matches no cell plans zero runs, and run.ts refuses a zero-case plan (exit 2, 'nothing planned')"**. A layer that runs nothing must never report green.
  - **"planL2 never re-plans: every planned run's n, scenario, row, sport, preset and width are the committed entry's, byte for byte"**. Compare against `l2-pairs.json` read as JSON, for the slice's cells.
  - **"slice L2 = 68 runs: 3 executed, and the rest carry 🚫 or ░ with a reason"**. The expected figures come from filtering the committed file inside the test (`runs.filter(r => SLICE_CELLS.has(cellId(r.row, r.sport)))`), and the count is asserted to equal the filter's own length, not the literal 68. The 68 is written only in a comment, so a regenerated catalogue moves the test, not the plan. The three executed runs are exactly those whose atom has a `HARNESS_SCENARIO` entry. The 🚫 runs are exactly those whose atom has `knownNoPath` or `l2NoPath`, with the reason naming that wave. Everything else is ░ `"no scenario script yet"`.
  - **"🚫 and ░ both set is impossible"**. `planL2` never produces both, and `decideState` throws if handed both (T3's guard, reached here from a real planner output).
  - **"planL1: 6 slice cells × 1 scenario × 2 widths = 12 cases, caseIds suffixed @width, layer L1"** (derived from `SLICE_ROWS × SLICE_SPORTS`, not typed).
  - **"width sweep: exactly the six L2 widths other than 320, in L2_WIDTHS order"** (derived: `L2_WIDTHS.filter(w => w !== 320)`).
  - **"api-only browser set: one case per API_ONLY row, in catalogue order"**.

- [ ] **Step 2: Run — FAIL. Step 3: Implement `layers.ts`.** `planL2` reads the committed file through `pairs.ts`'s own parser and maps each run as follows:
  - `HARNESS_SCENARIO[atom]` present → an executed case (`spec.scenario` = that key, `layer: "L2"`, `width: run.width`);
  - otherwise `knownNoPath ?? l2NoPath` → `noPath: "<wave>: <atom title>"`;
  - otherwise `notRun: "no scenario script yet (atom <id>)"`.

  `run.ts`:
  - `--layer L1` → `planL1` at the widths given by `--width` (repeatable; at least one required);
  - `--layer L2` → `planL2` over the slice cells;
  - planned 🚫/░ cases are recorded without a driver (`decideState` with `noPath`/`notRun`), so they appear in `results.json` and `MATRIX.md` as their states and are never dropped (R13).

  **Step 4: PASS.**
- [ ] **Step 5: Mutations:**
  - `planL2` re-derives widths from `L2_WIDTHS` → killed by "never re-plans";
  - drop the ░ branch → killed by "the rest carry 🚫 or ░";
  - accept a zero plan → killed by "empty case first".

- [ ] **Step 6:** Scoped gate, then commit `feat(matrix): L1/L2 layer planners, width sweep, API-only browser set`.

---

## Task 13: Parity — HTTP and browser verdicts compared per case

**Files:**
- Create: `scripts/matrix/parity.ts` (CLI), `scripts/matrix/lib/parity.ts`
- Modify: `package.json` (`"matrix:parity": "node --experimental-strip-types --import ./scripts/matrix/lib/crash-exit.ts scripts/matrix/parity.ts"`), `__tests__/cli-invocation.test.ts` (CLIS gains parity)
- Test: `scripts/matrix/__tests__/parity.test.ts`

**Interfaces:**
```ts
export const BROWSER_ONLY_PREFIXES = ["ui-", "visual-", "no-horizontal-scroll", "mixed-", "builder-", "organiser-ui-path", "pad-"] as const;
export interface ParityRow { caseId: string; kind: "state" | "check" | "missing"; id: string | null; http: string; browser: string }
export interface ParityReport { compared: number; checks: number; diffs: ParityRow[] }
export function compareRuns(http: Results, browser: Results): ParityReport;
// parity.ts: parity.ts <http results.json> <browser results.json> [--out parity.md]
// exit 0 = parity; 1 = a difference; 2 = usage; 3 = unreadable input (the house exit codes, carry (e) / F-6)
```

- [ ] **Step 1: Failing tests** `parity.test.ts`:
  - **"empty case first: two results with no common case is exit 1 'compared 0' — never parity"**.
  - **"caseIds match after stripping @width; one browser width per http case is compared, and several widths each compared"**.
  - **"a state difference is a row; a common check whose verdict OR checked differs is a row"**. `checked` counts too, because a browser run that checked fewer fixtures is not the same verdict.
  - **"browser-only checks are ignored by prefix, and a browser-only check appearing in the http run is itself a diff"**. The http driver must never emit them, so their presence means the run was mislabeled.
  - **"a case present on one side only is a `missing` row"**.
  - **"v2 http evidence (no layer/driver/width) parses as http"**. Committed W1a/W1b evidence is the baseline.
  - **"CLI exit codes: 0 / 1 / 2 / 3, via the package script"** (spawned under `spawnBudget`, T2(d)).

- [ ] **Step 2–4:** FAIL → implement → PASS. The markdown writes one table per diff kind, plus the header line `compared <n> cases, <m> common checks, <d> differences`.
- [ ] **Step 5: Mutations:**
  - compare verdict only (ignore `checked`) → killed;
  - treat `compared 0` as parity → killed;
  - drop the http-side browser-prefix guard → killed.
- [ ] **Step 6:** Commit `feat(matrix): parity CLI — HTTP vs browser verdicts per case`.

---

## Task 14: The live evidence — every layer, every set, reviewed per screen

No new code. A defect found here is fixed in the owning task's module with a failing test first, as a new commit, and the affected run is repeated.

Before starting: a fresh DB and prod server via the `seazn-local-env` skill. Confirm that `show data_directory` is this session's and that `SMOKE_BASE` is `http://localhost:<port>`. Write `EXIT=$?` from every run. Evidence goes under `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1c-<name>/`.

- [ ] **Step 1: HTTP baseline, the slice (L3 of the slice cells, 24 cases).** Run `pnpm matrix:l3 --run-id w1c-http-slice`. It must match W1b's committed slice states. Any drift stops the wave (class 14).
- [ ] **Step 2: L1 browser, 12 cases.** Run `pnpm matrix:browser --layer L1 --width 1280 --width 320 --run-id w1c-l1`.
- [ ] **Step 3: L2 browser, the slice.** Run `pnpm matrix:browser --layer L2 --run-id w1c-l2`, which gives 3 executed and the rest 🚫/░. Paste the state histogram, and confirm that 🚫 + ░ + executed equals the planned total.
- [ ] **Step 4: Pad proof, 11 sports × 1280/320.** This is the Task 11 run, repeated on this fresh stack.
- [ ] **Step 5: Width sweep, 6 cases.** Run `--set width-sweep`. At 768/834 the stage-rail fold toggle is hidden, and the page object must not click it (class 22).
- [ ] **Step 6: API-only browser set, 5 cases.** Run `--set api-only-browser`. Each case must carry `organiser-ui-path` ❌ naming W4/W5, or ⏳ where `setUpDivision` defers the multi-stage row to W1-driving. Paste which it was per row.
- [ ] **Step 7: Parity.**
  ```
  pnpm matrix:parity truth-runs/w1c-http-slice/results.json truth-runs/w1c-l1/results.json --out truth-runs/w1c-l1/parity.md ; echo EXIT=$?
  ```
  Expected: EXIT 0. Every difference is a finding. It is triaged into one of three buckets:
  - a harness fault, fixed in its owning task;
  - a browser-path product defect, routed to its wave;
  - an HTTP/browser divergence the product intends, which needs an owner ruling (never assumed).
- [ ] **Step 8: Per-screen visual verdicts (class 11).** For the L1 run: every captured screen × both widths, one verdict line each in `truth-runs/w1c-l1/README.md`. For the pad proof: three screens per sport × both widths. For the sweep: the stage rail and the console at each width. Confirm that the images exist, **differ** where the states differ, and that the last shot was taken after the state being proven (class 10).
- [ ] **Step 9: Flaky-shaped gates, three times.** Re-run Steps 2 and 4 twice more and paste all three state columns. A case that differs across runs is a flake finding with its check named.
- [ ] **Step 10: Commit the evidence**: `docs(matrix): W1c truth runs — L1, L2 slice, pad proof, sweep, API-only, parity`.
- [ ] **Step 11: Whole-branch review.** Dispatch the reviewer over `origin/main...HEAD`, with Review Focus 1–5, this task's READMEs and the Task 11 per-adapter table. Fix every Critical and Important finding, test first, and re-run the scoped gate plus the affected live runs. Paste the reviewer's final verdict.

---

## Task 15: `_INDEX.md` — the W1c row, per-adapter status for W1d, rulings, findings

**Files:** Modify `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md` and the memory entry `project_format_matrix_programme.md`.

- [ ] **Step 1: The W1c status row.** Record:
  - the counts from Task 14, with the paths to each `results.json`;
  - the parity result;
  - the per-screen verdict files;
  - the review verdict;
  - PR number and merge commit, once they exist.

- [ ] **Step 2: Per-adapter table for W1d.** One row per sport with these columns:
  - builder-default variant;
  - route per emitted event type: `one-for-one` / `tolerated <keys>` / `fallback <why>`;
  - rosters (none / full, with the count);
  - pad-proof at 1280 and 320 (state × 3 runs);
  - what W1d may assume.

  A sport red in all three runs says so and names its owner.

- [ ] **Step 3: Rulings and recommendations.**
  - Rulings 37 and 38 are already recorded.
  - D1 (O3) and D2–D9 are listed as **recommendations**, exactly as the owner ruled on them at plan review. Anything the owner did not rule on stays a recommendation and is never labelled a ruling (class 17).

- [ ] **Step 4: False premises.** Add the planning list (1–9) plus every Step 0 premise that proved false, each with what was seen.

- [ ] **Step 5: Findings routed** (each with evidence and its wave):
  - ranks 2..n have no page → W4 (brackets), W7 (ladder, americano, mexicano) (D6);
  - builder controls missing for thirdPlace, bracketReset, Swiss pairing and group-only → W4/W5;
  - `triple_rr` builder writes `legs 1` (if `builder-posted-as-harness` reds as predicted);
  - "Add entrant" / "Import CSV" / "Existing team" / "New entrant" and the AddStageForm kind labels are hardcoded English, which breaks the four-locale rule → the entrants surface's owner. W1c does not fix it (D4);
  - abandon has no pad route (the bench's `organiserStepsFor` throws on `core.abandon`, `scorer.ts:326-328`) and the console's Abandon button has no testid;
  - the stale bench comment cites (false premise 9) → the bench index, for B07b+;
  - every product defect from Tasks 8, 11 and 14.

- [ ] **Step 6: Memory.** Update the programme memory entry (W1c done, counts, the PR, what W1d needs first) and its `MEMORY.md` index line.
- [ ] **Step 7: Commit** `docs(matrix): W1c index — status, per-adapter table, findings`, then open the PR (body ending with the attribution line), and ask the owner whether to dispatch e2e for the branch (`workflow_dispatch`; pushes to feature branches trigger nothing).

---

## Appendix A — organiser UI, as read (facts C, `fce1ccdbf`; re-pin at Task 4 Step 0)

| Action | Route | Control | API it answers with | Folds < 768? |
|---|---|---|---|---|
| Create competition | `/o/[org]/c/new` | `template-start-blank` → name, "Ends on", visibility label, Create (`competition-wizard.tsx:184,244,265`) | POST `/api/v1/competitions` | no |
| Create division | `/o/[org]/c/[comp]/d/new` | `division-builder-name`; "Sport" and "Variant" selects; tabs Basics / Eligibility / Format / Scheduling; `division-builder-next`; `division-builder-create` on the last tab | POST divisions → POST stages → PUT schedule-settings (`division-builder.tsx:431,444,458`) | no |
| Format + knobs | builder, Format tab | template label text `format.template.<key>.label`; "Legs" (1/2), "Pools", "Rounds" (1–15), "Qualify to finals", `division-builder-carry` | client-side `buildTemplateStages` (`format-templates.ts:333`) | no |
| Add entrant | `?tab=entrants` | "Kind" group, name input, "Add entrant" (hardcoded English) | POST `/divisions/:id/entrants` | no |
| Generate | `?tab=fixtures` | `stage-generate` inside the stage rail | POST `/stages/:id/generate` | **yes**: `stage-rail-trigger` → `stage-rail-sheet` |
| Start | division header | `launch-start-division` → `start-confirm-confirm` → on warnings `board-gate-confirm` | POST `/divisions/:id/start` (+ `acknowledge_warnings` on retry) | no |
| Open pad | run sheet → `/f/[no]` | `li[data-fixture-no]` → `[data-row-action=open_pad\|score\|result]`; filter defaults to "today" (`run-sheet-filter` → all) | GET state/events | no |
| Forfeit | console | bench `organiserStepsFor` (`score-forfeit` → side → reason → submit) | POST events `core.forfeit` | no |
| Finalize | console | `score-finalize` (only once decided; reload first) | POST events / finalize (Task 5 Step 0 pins which) | no |
| Withdraw | `?tab=entrants` | `entrant-row-withdraw` → alertdialog "Withdraw entrant" | POST `/entrants/:id/withdraw` | no |
| Complete stage | `?tab=fixtures` | `stage-complete` in the rail | POST `/stages/:id/complete` | **yes** (rail) |
| Standings | `?tab=standings` | server table; only league / group / swiss | none (server) | no |
| Public | `/shared/[org]/[comp]/[div]?tab=standings` | tabs; champion banner (rank 1, no testid) | server | no |
| Final ranks 2..n, rank override | — | **no UI** | API only | — |

## Appendix B — pads and bench reuse (facts D + E)

**Shared plumbing** (all 11 sports are v3; `resolvePad` throws on a missing skin):
- start `score-start-match`;
- tiles `[data-tile-id]`;
- halves `[data-role="v3-scorebug-half"][data-side]`;
- sheet steps `pad-sheet-number` / `pad-sheet-confirm` / `[data-choice-option-id]`;
- holds release through `pad-send-now` (only when the dock has chips);
- the double-submit window is 250 ms, and same-side repeats are paced at 350 ms;
- console forfeit is an authority-band control; there is no pad retire or abandon control.

**Builder defaults** (`pickVariant`, `division-builder.tsx:56-67`): cricket t20, tennis tour, icehockey iihf, hockey fih-outdoor; everything else is the first system variant by name. That makes volleyball **beach**, carrom **club-29** and boardgame **blitz**, which no spec runs today.

| Sport | Generator emits | Pad route (Tasks 7/9/10/11) | Expected declaration |
|---|---|---|---|
| generic | start, `generic.result` | bench `genericAdapter` + draw tile | one-for-one |
| badminton | start, `game.summary` ×2 | `setScore` sheet | one-for-one |
| tabletennis | start, `game.summary` ×3 | `setScore` sheet (± `serveAnchor`) | one-for-one (fallback on the first summary only if the anchor is required) |
| volleyball | start, `set.summary` ×2 | `setScore` sheet | one-for-one |
| tennis | start, `set_summary` ×2 | `setScore` sheet, no tie-break steps | one-for-one |
| football | start, goal, period HT/FT | goal tile + hold release; period tile → choice | goal = fallback (minute); periods one-for-one |
| hockey | start, goal, advance ×4 | goal tile; advance tile | one-for-one (tolerated keys decided at Step 0) |
| icehockey | start, goal, advance ×3 | as hockey | as hockey |
| cricket | start, innings.summary ×2 (non-partial) | over-summary sheets (partial, cumulative) + innings close | fallback, judged by fold |
| boardgame | start, `result` | half + method chip, or draw tile | one-for-one |
| carrom | start, `board.summary` ×n | board sheet: winner choice + coins | one-for-one, `queenTo` null ≡ absent |

**Bench reuse (ruling 38):**
- *Imported*: `ledger.ts`; `scorer.ts`'s `TapStep`, `selectorForTapStep`, chassis testids, `TAP_PACING_MS`, `TAP_WAIT_TIMEOUT_MS`, `PadPage`, `TapAdapter`, `organiserStepsFor`; `genericAdapter`; `tap-play.ts`'s `seedConsent` / `CONSENT_SEED`.
- *Copied*: `executeStep` / `executeSteps` (Task 4); the `comparePayload` / seq-anchored poll design (Task 7); the `padpage-assignability` proof (Task 7).
- *Refused by name*: `playMatchByTaps`, `createTapPlayer`, `browserTapPlayer`.

---

## Self-Review

1. **Prompt coverage.**
   - L1 browser lifecycle → Tasks 5, 6, 8, 12, 14.
   - L2 from the committed file, never re-planned → Task 12.
   - The mixed driver (ruling 15) → Task 6 `MixedLedger` + `mixed-driver-coverage`.
   - Pad adapters for the other ten sports → Tasks 7, 9, 10, 11.
   - Parity → Task 13.
   - O3 widths → D1 plus the Task 12 sweep.
   - 🚫/░ producers → Tasks 3 and 12.
   - The W1b follow-ups (a)–(e) → Tasks 1 and 2.
   - Visual sign-off per screen → Tasks 8 and 14.
   - Four test types → the Global Constraints table.
   - `_INDEX` → Task 15.

   No prompt requirement is without a task.
2. **Placeholder scan.** The `<pin at Step 0>` dictionary keys in Task 4 are deliberate: Step 0 fills them from a named file, and `selectors.test.ts` fails while any key still starts with `<`, so a skipped fill cannot pass. Every other value is written or derived.
3. **Type consistency.**
   - `MatrixPadAdapter` (T7) is used unchanged by T9–T11.
   - `Fallback.rowsFor` is the same signature in T7's test, replay and the T11 cricket route.
   - `PostedEvent.stored` is the same in T7's driver and `decideFixture`.
   - `executeStep(page, step, waitMs)` is the same in T4, T5 (`forfeitUi`) and T7.
   - `TAP_PACE_MS` is one name, re-exported from the bench.
   - `LayerCase` and `BrowserWidth` match T3's `BROWSER_WIDTHS`.
4. **Review Focus.** Each of the five has a named test in its owning task:
   - RF1 → `mixed-driver.test.ts` "a missing browser action reds by name";
   - RF2 → `pad-replay` / `pad-adapters` plus the live `pad-ledger-as-generated`;
   - RF3 → the Task 5 fold tests and the Task 12 sweep;
   - RF4 → `browser-driver.test.ts` "a refused UI action throws RefusedCall with the product's code";
   - RF5 → `evidence.test.ts` must-differ plus the Task 8/14 per-screen verdicts.
