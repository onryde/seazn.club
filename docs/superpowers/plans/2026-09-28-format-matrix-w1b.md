# Format × Sport Matrix — W1b (catalogues + reference skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** W1b fixes what the programme will test and how big that is. It commits these files, each generated deterministically:
- the design §4 scenarios split into atomic cases (ruling 30 added M12 and split M4);
- an applicability drop list with a reason per drop;
- a floor per row;
- a pair-covering variant set;
- an L2 pair file;
- the §6.2 layer counts.

It also delivers:
- a `⛔ refused` state produced by an entitlement deny;
- the API-only row bodies;
- a `forEachSport` helper with a CI listing of unreasoned single-sport tests;
- an empty `packages/reference/` behind a CI import gate;
- a fast-check command model that hunts transition bugs such as #879 through the real server on W1a's slice.

**Architecture:** Everything builds on W1a's harness under `scripts/matrix/`.
- **Pure generators.** The generators in `lib/` are the scenario catalogue, variants, applicability and pairs. They have no DB, no clock and no randomness. They turn engine declarations (`module.variants`, `supportsDraws`, the committed `*.schema.json`) and product declarations (`SPORT_RULES`, `buildRuleOverride`, `buildTemplateStages`, `STAGE_RULES_SPORTS`, `showsOnePointsField`) into committed JSON.
- **Drift gate.** A `gen-catalogue.ts` CLI writes or checks the committed JSON. A drift test runs in the existing strict CI matrix step.
- **L3 additions.** A denied scenario, a probe case set and the fast-check model plug into W1a's `RunDeps`, `HttpDriver` and invariants. They are not rebuilt.
- **Reference package.** `packages/reference` is a new pnpm workspace. It is wired into the root chains, the Dockerfile and CI, and guarded by `scripts/reference-boundary.ts`.

**Tech Stack:**
- Node 26 `--experimental-strip-types`, with no enums, namespaces or parameter properties, and `.ts` import suffixes.
- TypeScript 7 (`typescript-native`) via `tsconfig.scripts.json`.
- vitest 4 via `packages/engine`'s binary.
- zod 4.
- fast-check 3.23 (`fc.commands`, `fc.asyncModelRun`, `fc.check`).
- pnpm 10 workspaces.
- `@seazn/engine` subpaths.

**Spec:** `docs/superpowers/specs/2026-09-27-format-matrix-design.md`, sections §3, §4, §5, §6.2, §7.2, §7.3, §7.3a, §7.5 item 1, §11 (O9, O10) and §12.
- Prompt: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/W1b-catalogues-reference.md`.
- `_RULES.md`: R7–R13 and R25–R29.
- `_INDEX.md`: rulings 7, 10, 21, 22–24, the W1a session status and the "carried to later waves" entries.
- `docs/superpowers/TEST-STRATEGY.md`: the house test authority (owner ruling 2026-09-28).
- House style follows `docs/superpowers/plans/2026-09-27-format-matrix-w1a.md`.

Where the spec and the tree disagree, see **False premises found in planning** below. The tree wins.

---

## Step 0 — anchors (re-pinned 2026-09-28 against `b92ef16dd`, the W1a head)

| Fact | Where |
|---|---|
| `stagesForRow` throws `RowBuildDeferred(row,"W1b")` for the 5 API-only rows | `scripts/matrix/lib/catalogue.ts:101` |
| W1a deferrals routed to "W1b": ladder/americano/mexicano, multi-stage, team rosters | `scripts/matrix/lib/scenarios/common.ts:90,92,94` |
| `decideState` yields only red / later / works; `CASE_STATES` lists `refused` | `scripts/matrix/lib/results.ts:16,126-137` |
| `InvariantSpec`, `INVARIANTS` = [I1..I6], `evaluateInvariant` enforces R25 | `scripts/matrix/lib/invariants.ts:13-21,285-306` |
| I1 abstains on `late_entry` (the fact #879 creates) and reads `s.field` | `scripts/matrix/lib/invariants.ts:28-60` |
| `ObservedStage.field` = "every entrant added to the division" | `scripts/matrix/lib/observed.ts` (`ObservedStage`) |
| `GENERIC_ERROR_CODES` contains `PAYMENT_REQUIRED` | `scripts/matrix/lib/observed.ts` (`GENERIC_ERROR_CODES`) |
| Fake answers **409** for every engine refusal | `scripts/matrix/__tests__/fake-driver.ts:166` |
| Product maps engine codes via `ENGINE_HTTP` (`?? 422`) | `apps/web/src/server/api-v1/http.ts:20-60,158` |
| `EngineErrorCode` is a zod enum (value + type) | `packages/engine/src/core/errors.ts:7-29` |
| `execute()` calls `planSliceCases`/`planCanaryCase` directly | `scripts/matrix/run.ts:238` |
| Zero-cases test splices `SLICE_ROWS` in place | `scripts/matrix/__tests__/run-cli.test.ts:422-436` |
| `recordGenerate` is module-private | `scripts/matrix/lib/scenarios/common.ts:125` |
| `createStages` gates `formats.double_elim` (double_elim, page_playoff) then `formats.advanced` (americano, ladder, byes, cross_feeds, placements) before any insert | `apps/web/src/server/usecases/stages.ts:373-382`; `apps/web/src/server/usecases/format-gates.ts:38-52` (imports `server-only`) |
| `replaceStages` deletes the stages in its own `withTenant` tx, THEN calls `createStages` (which gates) | `apps/web/src/server/usecases/stages.ts:543-546` |
| Knockout generate reads `cfg.thirdPlace === true` | `apps/web/src/server/usecases/stages.ts:1652` |
| `rebuildStageFixtures` → `RebuildOutcome {created, existing, fixtures, removed}`; 409 `STAGE_HAS_RESULTS`, 422 `STAGE_NOT_ROOT` | `apps/web/src/server/usecases/stages.ts:2941-2964`; route `apps/web/src/app/api/v1/stages/[id]/rebuild/route.ts` |
| `PUT /api/v1/divisions/{id}/stages` exists (replace) | `apps/web/src/app/api/v1/divisions/[id]/stages/route.ts:18` |
| `core.void` payload `{event_id}` is lifted into the envelope's `voids` | `apps/web/src/server/usecases/scoring.ts:200-203` |
| `resolveVoids` drops voided events; a void of a void is `INVALID_EVENT` | `packages/engine/src/core/events.ts:178-214` |
| `SPORT_RULES`, `buildRuleOverride`, `visibleRuleFields`, `STAGE_RULES_SPORTS`, `showsOnePointsField`; no imports (strip-types loadable) | `apps/web/src/lib/match-rules.ts:17,323,851,862,914,956` |
| Engine config schemas are unbounded (e.g. badminton `setTo.maximum` = 9007199254740991); UI bounds live in `SPORT_RULES` (badminton `setTo` 11–30) | `packages/engine/src/sports/setbased/badminton.schema.json`; `match-rules.ts:227-233` |
| `titleCase` (variant display name) is NOT exported | `scripts/sync-sports.ts:32-36,78` |
| Builder variant order `order by is_system desc, name` | `scripts/matrix/lib/seed-org.ts` (`variantKeysInBuilderOrder`) |
| t20-super8 template: group(4) → group(2, topNPerGroup 2, snake, setup) → knockout(topNPerGroup 2, rank_order, setup) | `apps/web/src/server/templates/catalog/t20-super8.json` |
| Builder bodies: groups_ko / group_playoffs / group_stepladder / ko_plate | `apps/web/src/lib/format-templates.ts` (`buildTemplateStages`), printed 2026-09-28 |
| `builtinModules` order (wave order) with a comment "Order is not significant" | `packages/engine/src/sports/index.ts:22-35` |
| boardgame `supportsDraws` returns true for every stage kind | `packages/engine/src/sports/boardgame/boardgame.ts:767-771` |
| Root `lint` / `typecheck` / `test` are explicit per-workspace chains | `package.json:22,23,25` |
| Dockerfile copies only root, web and engine manifests before `pnpm install --frozen-lockfile` | `Dockerfile:13-15,22` |
| CI gates job: turbo typecheck `:92`, `engine:boundary` `:93`, turbo lint `:167`, `lint:scripts` `:179`, strict matrix step `:197-229`; container job `:492-527` | `.github/workflows/ci.yml` |
| Engine CI job runs engine tests only when `packages/engine/**` changed | `.github/workflows/ci.yml:372-399` |
| fast-check `^3` in `apps/web/package.json:75` and `packages/engine/package.json:56`; **absent from root `package.json`** | — |
| Main checkout's `node_modules/fast-check` is a real directory (not a pnpm link) | `stat` 2026-09-28 |
| Playwright viewport widths 320/360/375/390/430/768/834 | `apps/web/playwright.config.ts:195-258` |

Before building on any line above, the executor pins it again (AGENTS class 5). A line that has moved is a note in the task report, not a blocker.

---

## Global Constraints

- **Worktree and branch.**
  - **Prerequisite met.** #891 (the docs) and #896 (W1a) are merged to `main` at `a5f813404`, and main's e2e is green. Execution gets its own worktree off `origin/main`: `/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec` on branch `feat/format-matrix-w1b` (Task 1 Step 0). The planning worktree `format-matrix-w1b` (branch `docs/format-matrix-w1b-plan`) is not used for execution.
  - The anchors were re-pinned at W1a head `b92ef16dd`. `git diff b92ef16dd origin/main` is empty for every anchor file (checked at `64e009f2d`: `scripts/matrix/**`, `match-rules.ts`, `format-gates.ts`, `stages.ts`, `sports/index.ts`, `testkit/index.ts`, `Dockerfile`, `ci.yml`, `package.json`). Step 0 still re-pins them (class 5).
  - Every shell command starts `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && …`, because cwd resets between calls.
  - Use cherry-pick, never rebase. A squash merge breaks ancestry, so a rebase would replay W1a.
  - Never edit the main checkout. Never `git stash`: the stash stack is shared.
  - No heredocs. Write commit messages with the editor tool into `$TMPDIR/w1b-msg.txt`, then `git commit -F "$TMPDIR/w1b-msg.txt" -- <paths>`.
  - Every message ends with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **pnpm, never npm install.** A fresh worktree has no `node_modules`, so run `pnpm install --frozen-lockfile` first (Task 1 Step 0). Only Tasks 12 and 13 change the lockfile, using `pnpm install` / `pnpm add`. Never symlink main's `node_modules`.
  - This worktree is nested under the main checkout, so a package missing from the worktree resolves UPWARD into main's `node_modules`. Task 13 has a test for this trap.
- **Local verification = ONLY the tests, specs and walkthroughs that cover the files you changed** (owner, 2026-09-28; `AGENTS.md`). Never the full gate, the full vitest suite or the full e2e suite.
  - The template, with `<N>` = the task number and `<files>` = the exact test paths:
    ```bash
    cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && rm -f "$TMPDIR/w1b-t<N>.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w1b-t<N>.json" --testTimeout=30000 <files>; echo EXIT=$?
    cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const files=r.testResults.map(t=>t.name);const bad=files.filter(f=>!f.startsWith(process.argv[2]));console.log(JSON.stringify({total:r.numTotalTests,passed:r.numPassedTests,failed:r.numFailedTests,failedSuites:r.numFailedTestSuites,files:files.length,stray:bad}))' "$TMPDIR/w1b-t<N>.json" "$PWD/"
    ```
  - Green means all of:
    - `failed == 0`;
    - `failedSuites == 0`;
    - `passed == total > 0`;
    - `files` equals the number of paths you passed;
    - `stray` is empty.
  - Positionals are literal substring filters, so a typo runs a subset and reports green. Paste the JSON line into the task report and pin `total`. During a mutation sweep, a mutant that fails to parse shrinks `total` and reads as a survivor.
  - Never trust `rtk` summaries: `PASS(0) FAIL(0)` is a suite that failed to collect.
- **tsc and eslint on changed files only.**
  - Scoped tsc. With the Write tool, create `$TMPDIR/w1b-tsc-<N>.json`:
    ```json
    {"extends":"/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec/tsconfig.scripts.json","include":[],"files":[<absolute changed .ts paths>],"compilerOptions":{"incremental":false,"typeRoots":["/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec/node_modules/@types"]}}
    ```
    Then run `cd <worktree> && rtk proxy node node_modules/typescript-native/bin/tsc -p "$TMPDIR/w1b-tsc-<N>.json"; echo EXIT=$?`. For `packages/*` files, `extends` is that package's `tsconfig.json`.
  - eslint: `cd <worktree> && rtk proxy ./node_modules/.bin/eslint <changed scripts/ files>; echo EXIT=$?`. For a package, run `cd <worktree>/packages/<pkg> && rtk proxy ./node_modules/.bin/eslint <files>`.
  - An empty eslint output is clean only with `EXIT=0`.
- **`grep -a` always.** Files here report as `Binary file … matches`.
- **Strip-types rules.** No `enum`, `namespace` or constructor parameter properties. Error subclasses assign their fields in the constructor body. Every relative import carries `.ts`. Engine imports use subpaths. `scripts/matrix/__tests__/strip-types-loadable.test.ts` spawns node against every shipped module; extend its list with each new module.
- **Boundary** (R3; `scripts/matrix/__tests__/boundary.test.ts`):
  - From `scripts/bench/lib/` the only allowed imports are `http.ts`, `plan.ts` and `env.ts`.
  - From `apps/web` the only allowed imports are `format-templates.ts` and, from Task 5, `apps/web/src/lib/match-rules.ts`.
  - `lib/invariants.ts` and `lib/observed.ts` stay type-only apart from observed.ts's pure helpers.
- **Test authority** (`docs/superpowers/TEST-STRATEGY.md`, R9, R13, R25, R28):
  - Before writing tests, list the change's state transitions and its empty case, and test both.
  - Every invariant, property, sweep and generator reports how many items it checked, and **zero checked is a failure**.
  - Expected values come from the engine's declarations (`module.variants`, `supportsDraws`, `*.schema.json`, `EngineErrorCode.options`) or the product's declared sources (`SPORT_RULES`, `ENGINE_HTTP`, `format-gates.ts`, the template JSON), which are text-pinned when unimportable. They never come from the code under test.
  - "Cannot happen" becomes a named refusal plus a test that reaches it.
  - Sweep the sport registry by default. A single-sport test carries `// single-sport: <reason>`.
- **Mutation** (R17, class 3). Each task's last test step lists `mutant → killing test`. Copy the file with `cp <file> "$TMPDIR/w1b-bak-<name>"`, apply the mutant, run the named test file, see it red (and pin `total`), then restore with `cp "$TMPDIR/w1b-bak-<name>" <file>`. **Never** use `git checkout <file>`: it restores the index and silently deletes uncommitted work. Report each kill, not a count.
- **Determinism** (R11, trap 5). The generators never call `Math.random`, `Date.now`, `new Date`, `crypto.*random*` or `performance.now`. `committed-catalogue.test.ts` scans their source for it.
  - Every ordering is an explicit sort, or registry order (`builtinModules`, `ROW_KEYS`, `PARENTS`).
  - Registry order is **never sorted** (trap 4; AGENTS class 18).
- **Scope fences.**
  - There are no runtime changes to `apps/web/**` or `packages/engine/**`. The engine test helper in Task 11 lives in `packages/engine/src/testkit/`, which no product code imports (verified 2026-09-28: `grep -arln "@seazn/engine/testkit" apps/web/src` returns only tests).
  - A product red is a FINDING recorded in `_INDEX.md` and routed to its wave, never fixed here.
  - Do not touch `scripts/bench/**`, `.github/workflows/e2e.yml` or any scheduled workflow.
  - Stryker and shadow invariants are W1d and W10 (ruling 21).
- **Public repo** (R14a). Use synthetic identities only, of the forms `delivered+matrix-<runId>@resend.dev` and "Matrix Player N". Every error and all evidence go through `redact()`. Every writer refuses on `findSecrets()`.
- **Live runs** (Task 15 only) follow `~/.claude/skills/seazn-local-env/SKILL.md`:
  - fresh DB via `db:apply` + `sync:sports`;
  - `BENCH_EXPECTED_DATA_DIR` = `show data_directory`;
  - **no `REDIS_URL`**;
  - PostHog and Sentry blanked;
  - `SMOKE_BASE=http://localhost:<port>` (never 127.0.0.1);
  - a fresh run id;
  - a clean tree before evidence runs (the harness commit must not end `-dirty`).
- **Owner rulings 26–30 (2026-09-28) are binding:** O9 (26), O10 (27), Q-A (28), Q-B (29), and M12 plus the M4 split (30). The Decisions section records 26–29 with their reasoning, and Tasks 4, 6, 7, 15 and 16 apply 30. An agent's own recommendation is never labelled a ruling (AGENTS.md class 17).

### The four test types, as they apply here

| Type | Meaning in W1b |
|---|---|
| Unit | Each generator, predicate, invariant, command, and the gate is tested DB-free under `scripts/matrix/__tests__/`, `packages/reference/test/` or `packages/engine/src/testkit/`. |
| Regression | The committed-file drift test (Task 8); W1a's suites stay green; shrunk model failures become named regression cases (R29, Task 14). |
| E2E / live | The probe set and the model run through the real server over HTTP (Task 15). There is no browser layer in W1b (W1c). |
| Smoke | Task 15's slice re-run: W1a's 24 cases stay ✅ under the new invariant set. |

---

## Review Focus

These are the five failure modes most likely to bite a person using this software (the next wave's implementer, the owner reading `MATRIX.md`) that no functional test would exercise. Each one's pinning test sits in its owning task.

1. **A committed catalogue file drifts from its generator.** A hand-edited `variants.json`, or a predicate changed without regenerating, would make the published counts and drops describe a matrix nobody runs. Expected: CI reds on any byte difference, naming the file. Pinned by `committed-catalogue.test.ts` "drift" (Task 8).
2. **A local-only green: `fast-check` resolves from main's stray `node_modules/fast-check`**, a real directory left by an old npm install. The nested worktree resolves upward into it. CI's fresh pnpm install has no root link, so the model would fail to COLLECT only in CI. Expected: the resolved realpath lives under this worktree's `node_modules/.pnpm/`. Pinned by `fast-check-resolution.test.ts` (Task 13).
3. **The model rediscovers #879 on every run and never explores past it.** fast-check stops at the first failure, so one known bug masks every other transition bug. Expected: an open regression fences its trigger, the other commands still run at least once per cell, and the report names the fence and its blocked count. Pinned by `model-run-cell.test.ts` "fenced" (Task 14).
4. **An entitlement deny made invisible by the Redis entitlement cache** (`ent:<org>:*`, 300 s TTL, only when `REDIS_URL` is set). The ⛔ probe would read the Pro plan and report ✅ or ❌ instead of ⛔. Expected: a run that includes a deny case refuses to start while `REDIS_URL` is non-empty. Pinned by `run-cli.test.ts` "refuses deny cases under REDIS_URL" (Task 10).
5. **The builder's default variant differs between the offline derivation (codepoint sort of `titleCase` names) and the live DB (`order by name` under the DB collation).** Every default-config applicability decision would then be about the wrong variant. Expected: a live run aborts, naming the sport and both keys. Pinned by `run-cli.test.ts` "builder-default drift aborts" (Task 10) and `variants.test.ts` "offline default" (Task 5).

---

## False premises found in planning

Each has file:line evidence. They are to be recorded in `_INDEX.md` "False premises found" (Task 16).

1. **"fast-check is already a dependency of both apps/web and packages/engine — no setup is owed"** (`docs/superpowers/TEST-STRATEGY.md:93-97`). This is true for those two workspaces (`apps/web/package.json:75`, `packages/engine/package.json:56`) and false for `scripts/`.
   - The root `package.json` has no fast-check.
   - pnpm links a package only into the importer that declares it (`node_modules/.modules.yaml` lists `fast-check@3.23.2` as `private`).
   - The main checkout's `/Users/ashokhein/github/seazn.club/node_modules/fast-check` is a real directory, not a pnpm link, so it resolves locally and in every nested worktree, but in no CI job.
   - Setup IS owed: a root devDependency (Task 13).
2. **Design §5: boundary classes "minimum, default, maximum" come from the module's declared settings.** The engine's `configSchema` declares no finite bounds. For example, `badminton.schema.json` `setTo` is `{exclusiveMinimum:0, maximum:9007199254740991}`. The organiser-facing bounds live only in `apps/web/src/lib/match-rules.ts` `SPORT_RULES` (badminton `setTo` min 11, max 30, `:227-233`). Task 5 takes its classes from `SPORT_RULES` and validates each through the engine's `configSchema` (`resolveSportCfg`).
3. **Design §7.5: the model "checks every invariant after every step", which would catch #879.**
   - I1, the pair-once invariant, abstains on `late_entry` (`scripts/matrix/lib/invariants.ts:31`), and late entry is exactly the fact #879 needs.
   - I4 fails by construction mid-sequence ("never asked to complete").
   - I2 requires a completed stage.

   Task 2 therefore adds I7 (no pair over `legs`, no abstentions) and a `stepSafe` subset.
4. **W1b prompt: "Routed gaps: none".** W1a routes four deferrals to "W1b" by name:
   - `scripts/matrix/lib/scenarios/common.ts:90` (ladder, americano and mexicano driving);
   - `:92` (multi-stage rows);
   - `:94` (team rosters);
   - `scripts/matrix/lib/catalogue.ts:101` (API-only row bodies).

   Only the last is in W1b's scope list, and this plan closes it (Task 3). The other three are driving work that the scope list does not name. This plan re-routes them through ruling 28 (Q-A) below and a guard test (Task 4), rather than silently absorbing or dropping them.
5. **A "⛔ refused" state exists in the harness.** `CASE_STATES` lists it (`results.ts:16`), but `decideState` can never return it (`results.ts:126-137`). Ruling 24's denied state needs a producer (Task 9).
6. **"Order is not significant"** (`packages/engine/src/sports/index.ts:22`). This contradicts `AGENTS.md` class 18 and trap 4: `builtinModules` order is the grid's column order and wave order. W1b does not edit the engine's runtime comment. `forEachSport` pins the order by test (Task 11), and the correction is routed to the next engine-touching wave as a one-line comment fix.
7. **"The double_elim denied state" is one case** (ruling 24's wording). The product gates `formats.double_elim` on `double_elim` AND `page_playoff` (`format-gates.ts:39`), and `formats.advanced` on `americano` and `ladder` (`:46-47`). Seven offered rows are therefore gated:
   - `formats.double_elim`: double_elim, group_playoffs, swiss_playoff, page_playoff_only;
   - `formats.advanced`: americano, mexicano, ladder.

   Task 9 builds all seven.
8. **Hypothesis to confirm live, not yet a fact:** "a refused format change leaves the format as it was." `replaceStages` deletes every stage in its own committed transaction (`stages.ts:543`) and only then calls `createStages`, which gates (`:546`, `:373-382`). A 402 PUT therefore likely leaves the division with NO stages. The check `denied-put-keeps-stages` (Task 9) settles it live in Task 15. If red, it is a product finding routed to W9 (operational).
9. **Design §4 names "chess tiebreak" as an M6 decider.** boardgame declares no decider in `configSchema` (`boardgame.schema.json`: byeScore, clock, colors, scoring, variant), and `supportsDraws` is true for every kind (`boardgame.ts:767-771`, "KO chess resolves ties via multi-game mini-matches, modelled at the fixture layer"). M6 has no config switch on boardgame. Task 6 records the drop with this reason, and the question is routed to W4 (knockout family).
10. **Ruling 30 cites "a football award-policy abandon" as an M4b example.** The engine has one: `abandonPolicy` is `replay|award` with default `replay` in football, hockey and icehockey (`football.ts:173`, `period/kernel.ts:219`, the three `*.schema.json`), and `award` decides the match (`football.ts:1657`, `period/kernel.ts:1450`). But no organiser screen can choose it: `SPORT_RULES` has no `abandonPolicy` field (`match-rules.ts`, 0 hits), so `configKeysFor` never emits it. The API's division `config` is a free record (`api-v1/schemas.ts:391`), so an HTTP caller may set it; Task 15 Step 3b tests that.
    - W1b drops football, hockey and icehockey M4b with this reason (Task 6).
    - Routed to W2 with M12b's missing control.
    - Found by reading, not by running.
11. **Hypothesis to confirm live (ruling 30; audit ST-G1, rulebook CR-2 and F-18), not yet a fact:** "an abandon that the engine scores reaches the table." Any `core.abandon` in a fixture's stream sets its status to `abandoned` (`apps/web/src/server/engine-db/append-event.ts:146`). `abandoned` maps to the engine's `void` (`apps/web/src/lib/fixture-engine-status.ts:17-19`), and `void` is outside `COUNTS_FOR_STANDINGS` (`packages/engine/src/competition/stage.ts:24`).
    - So a cricket no-result (1 point each by ICC 16.10.3 and `points.noResult`), a two-innings abandon (a draw) and a football award would all be dropped from the table.
    - Task 15 Step 3b drives the product to confirm or refute this. If confirmed, it is a finding routed to W5 (standings) and W2 (what an abandon is worth). No check is ever loosened to pass.

---

## Decisions — owner rulings 26–29 (2026-09-28)

The owner ruled on each of these as the plan recommended (`_INDEX.md` "Owner rulings" 26–29). Each ruling keeps its reasoning, so a later reader can see why. Ruling 30 (M12, M4 split) came after and is applied in Tasks 4, 6, 7, 15 and 16.

**O9 — entry path E: its own scenarios, or an axis multiplying M and C.**
- **Ruled (26):** E stays four scenarios of its own. E4 splits into E4a (device link) and E4b (printed-sheet scan), giving E1, E2, E3, E4a and E4b. Only E2 (single-event result over the API) is in L3. E1 and E3 are browser-only and E4a/E4b need times, so those four are L2.
- **Owner value:** each entry path is proven at least once per applicable format and sport, and the M and C families are not multiplied by 5, one copy per entry path. Most of those copies could not run in L3 anyway, because only E2 does.
- **Rejected alternative:** E as an axis, with every M and C atomic case repeated per entry path. L3 would be unchanged. L2 would grow by four extra copies of every applicable M and C pair target.
- **Plan:** follows ruling 26 in Tasks 4, 6, 7 and 8.

**O10 — reference import mode.**
- **Ruled (27):** `import type` only, from `@seazn/engine/core`. It must be the statement form `import type {…} from`. Inline `import { type X }` is refused, because strip-types keeps `import {} from "…"` as a runtime load.
- **Owner value:** one authority for domain types (EntrantId, StageKind, MatchOutcome), with zero runtime coupling. The reference model cannot call the engine it is judging (R7), and a type rename in the engine reds the reference package at typecheck instead of drifting.
- **Rejected alternative:** a leaf types package (`packages/types`). It needs either an engine refactor to import from it (a runtime change, out of W1b scope) or duplicated types that drift. Revisit only if a family needs a type that core does not export.
- **Plan:** follows ruling 27 in Task 12.

**Q-A — who drives what W1a deferred to "W1b".**
- **Ruled (28):** multi-stage seeding, team rosters, ladder, americano and mexicano driving, parallel workers, and I2's DE, stepladder and page-playoff champion rules become their own driving wave, "W1-driving", before W1d's truth run.
- **Owner value:** W1d's first full run would otherwise show those rows as ⏳ "W1b" after W1b has shipped, a routing that points at a closed wave.
- **Plan behaviour:** W1b keeps the ⏳ deferrals but renames their wave to `"W1-driving"`. `scenario-catalogue.test.ts` fails if any `ScenarioUnsupported`/`RowBuildDeferred` in `scripts/matrix/**` names a wave whose `_INDEX.md` status row says "done" (Task 4).

**Q-B — what a variant case runs.**
- **Ruled (29):** LIFECYCLE only.
- **Owner value:** a variant is about the sport's config reaching the ledger and the table correctly. LIFECYCLE exercises every fixture's stream through the variant's cfg and the table, while every scenario × variant would multiply L3 by ~5.
- **Plan:** follows ruling 29 in Tasks 8 and 10.

---

## File Structure

```
scripts/matrix/
  lib/driver/engine-http.ts        (T1)  ENGINE_HTTP_STATUS, engineHttpStatus — the product's status map, text-pinned
  lib/invariants.ts                (T2)  + stepSafe, I7, I8, stage-field guard, evaluateStepInvariants
  lib/observed.ts                  (T2)  + ObservedStage.fieldSource
  lib/scenarios/common.ts          (T2,T10) export recordGenerate; fieldSource; division config from spec.overrides
  lib/catalogue.ts                 (T3)  builderStages(); API-only row bodies
  lib/scenario-catalogue.ts        (T4)  design parents → atomic cases (counts derived, T4), layers, harness map, regression loader
  lib/variants.ts                  (T5)  titleCase copy, offline builder default, boundary classes, pairwise cover, scorability
  lib/applicability.ts             (T6)  CellFacts, combinators, RULES (one per atomic id), planL3, floors
  lib/pairs.ts                     (T7)  L2 greedy pair cover, width rotation
  lib/counts.ts                    (T8)  §6.2 formulas
  gen-catalogue.ts                 (T8)  --write | --check over the five committed files
  catalogue/variants.json          (T8)  committed, generated
  catalogue/drop-list.json         (T8)  committed, generated
  catalogue/floors.json            (T8)  committed, generated (never lowered without --accept-lower-floors)
  catalogue/l2-pairs.json          (T8)  committed, generated
  catalogue/counts.json            (T8)  committed, generated
  catalogue/regressions.json       (T4, T14) committed by hand from a shrunk failure (R29)
  lib/results.ts                   (T9)  decideState gains `mandated`
  lib/scenarios/denied.ts          (T9)  DENIED scenario (⛔)
  lib/format-gates-copy.ts         (T9)  expectedGate — text-pinned copy of format-gates.ts
  lib/driver/types.ts              (T9,T13) RefusedCall.featureKey, replaceStagesProbe, rebuild
  lib/driver/http-driver.ts        (T9,T13) feature_key capture, PUT probe, rebuild
  lib/seed-org.ts                  (T9)  MatrixSql.denyFeature, prepareCaseOrg deny
  lib/probe-set.ts                 (T10) the w1b-probe planner
  run.ts                           (T1,T10) planner seam, --set, REDIS guard, builder-default guard, overrides/deny plumbing
  single-sport.ts                  (T11) R26 listing CLI (--check against the baseline)
  single-sport-baseline.json       (T11) committed ratchet
  lib/model/ledger-fold.ts         (T13) effective-stream fold with voids through the real engine
  lib/model/state.ts               (T13) ModelState, observe(), step checks
  lib/model/commands.ts            (T13) fast-check commands
  lib/model/fences.ts              (T14) known-regression fences
  lib/model/run-cell.ts            (T14) one cell: fc.check over fc.asyncModelRun, counts, vacuity
  model.ts                         (T14) CLI: seeds, --seed/--path/--runs/--regressions/--no-fences, report JSON
  __tests__/…                      one test file per module above (named in each task)
packages/engine/src/testkit/for-each-sport.ts (+ .test.ts)  (T11)
packages/reference/{package.json,tsconfig.json,eslint.config.mjs,src/index.ts,test/*.test.ts}  (T12)
scripts/reference-boundary.ts      (T12)
package.json                       (T1 none; T8,T11,T12,T13 scripts/deps)
Dockerfile                         (T12) + packages/reference manifest COPY
.github/workflows/ci.yml           (T11,T12) + single-sport check, reference boundary, reference tests (strict)
docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md  (T16)
docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-*/  (T15) evidence
```

Every new `scripts/matrix/**` test file is picked up by the existing strict CI matrix step (`ci.yml:197-229`). That step already fails on zero tests, failed suites, passed ≠ total and stray files.

---
## Task 1: W1a hygiene — product statuses in the fake, a planner seam in run.ts

W1a carries 3 and 4. The fake must answer engine refusals with the product's own status map. `execute()` must take its case list from an injectable planner, so that the zero-cases test stops splicing `SLICE_ROWS`, and so that Tasks 10 and 14 have a seam to plug into.

**Files:**
- Create: `scripts/matrix/lib/driver/engine-http.ts`
- Modify: `scripts/matrix/__tests__/fake-driver.ts:166`
- Modify: `scripts/matrix/run.ts` (`RunDeps`, `execute` at `:215-271`)
- Test: `scripts/matrix/__tests__/engine-http.test.ts` (new), `scripts/matrix/__tests__/run-cli.test.ts:422-436`, `scripts/matrix/__tests__/strip-types-loadable.test.ts`

**Interfaces:**
- Consumes: `EngineErrorCode` (zod enum, `@seazn/engine/core`); `RefusedCall` (`lib/driver/types.ts`); `planSliceCases`, `planCanaryCase`, `SLICE_SPORTS` (`lib/slice.ts`).
- Produces:
  - `ENGINE_HTTP_STATUS: Readonly<Record<EngineErrorCode, number>>`
  - `engineHttpStatus(code: string | null): number`
  - in `run.ts`:
    - `interface PlannerCli { only?: string; scenario?: string; canary?: string; set?: string }`
    - `interface CasePlanner { readonly sports: readonly string[]; plan(variantFor: (sport: string) => string): CaseSpec[] }`
    - `type PlanCases = (cli: PlannerCli) => CasePlanner`
    - `const slicePlanner: PlanCases`
    - `RunDeps.planCases?: PlanCases`

- [ ] **Step 0: Set up the worktree** (once, for the whole plan)

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b && git fetch origin && git merge-base --is-ancestor a5f813404 origin/main && echo W1A-ON-MAIN
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b && git worktree add /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec -b feat/format-matrix-w1b origin/main; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && git cherry-pick "$(git log -1 --format=%H docs/format-matrix-w1b-plan -- docs/superpowers/plans/2026-09-28-format-matrix-w1b.md)" && pnpm install --frozen-lockfile; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && git diff --stat b92ef16dd HEAD -- scripts/matrix apps/web/src/lib/match-rules.ts apps/web/src/server/usecases/format-gates.ts apps/web/src/server/usecases/stages.ts packages/engine/src/sports/index.ts
```
The first command runs from the planning worktree only because the exec worktree does not exist yet. Expected results:
- `W1A-ON-MAIN`, then EXIT=0 twice.
- An empty diff stat. The last command re-pins the plan's anchors: if it lists a file, re-read that file's anchors in the Step 0 table before building on them (class 5).

`docs/format-matrix-w1b-plan` is a local branch, so it is visible from every worktree.

- [ ] **Step 1: Write the failing tests**

`scripts/matrix/__tests__/engine-http.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineErrorCode } from "@seazn/engine/core";
import { describe, expect, it } from "vitest";
import { stagesForRow } from "../lib/catalogue.ts";
import { ENGINE_HTTP_STATUS, engineHttpStatus } from "../lib/driver/engine-http.ts";
import { RefusedCall } from "../lib/driver/types.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** ENGINE_HTTP's entries, read from the product's source (http.ts imports
 *  next/server, so it cannot be imported here). Comments are stripped first. */
function productTable(): Record<string, number> {
  const src = readFileSync(resolve(REPO, "apps/web/src/server/api-v1/http.ts"), "utf8");
  const at = src.indexOf("export const ENGINE_HTTP");
  const end = src.indexOf("\n};", at);
  if (at === -1 || end === -1) throw new Error("http.ts: ENGINE_HTTP literal not found");
  const body = src.slice(at, end).replace(/\/\/[^\n]*/g, "");
  return Object.fromEntries([...body.matchAll(/^\s*([A-Z_]+):\s*(\d{3}),?\s*$/gm)].map((m) => [m[1], Number(m[2])]));
}

describe("engine-http — the product's status map, text-pinned", () => {
  it("equals ENGINE_HTTP in api-v1/http.ts entry for entry, and covers every EngineErrorCode", () => {
    const product = productTable();
    const codes = EngineErrorCode.options;
    expect(Object.keys(product).length).toBeGreaterThan(0); // anti-vacuity: the parse found entries
    expect(Object.keys(product).length).toBe(codes.length);
    expect(new Set(Object.keys(product))).toEqual(new Set(codes));
    expect({ ...ENGINE_HTTP_STATUS }).toEqual(product);
  });

  it("an unknown or missing code falls back to 422, as http.ts:158 does (`?? 422`)", () => {
    expect(engineHttpStatus(null)).toBe(422);
    expect(engineHttpStatus("NOT_AN_ENGINE_CODE")).toBe(422);
    expect(engineHttpStatus("SEQ_CONFLICT")).toBe(409);
    expect(engineHttpStatus("MODULE_DUPLICATE")).toBe(500);
  });

  it("the fake answers an engine refusal with the product's status, not a blanket 409 (W1a carry 3)", async () => {
    // single-sport: the fake scores through the real engine; badminton's rally
    // stream is the one the fake's league path is exercised with in W1a.
    const d = new FakeLeagueDriver();
    await d.createCompetition({ name: "c", slug: "c" });
    await d.createDivision("c1", { name: "d", slug: "d", sportKey: "badminton", variantKey: "bwf" });
    await d.postStages("d1", stagesForRow("league"));
    await d.addEntrants("d1", [1, 2].map((n) => ({ displayName: `Matrix Player ${n}`, seed: n, kind: "individual" as const })));
    await d.start("d1");
    const [f] = await d.listFixtures("d1");
    const cfg = resolveSportCfg("badminton", "bwf");
    const win = generateStream({ sportKey: "badminton", cfg, stageKind: "league", home: f!.home_entrant_id!, away: f!.away_entrant_id!, outcome: { kind: "win", winner: "home" } });
    await d.postStream(f!.id, win, "first");
    const err: unknown = await d.postStream(f!.id, win, "second").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedCall);
    const r = err as RefusedCall;
    expect(EngineErrorCode.options).toContain(r.code);
    expect(r.status).toBe(ENGINE_HTTP_STATUS[r.code as keyof typeof ENGINE_HTTP_STATUS]);
    expect(r.status).not.toBe(409); // a re-posted decided stream is never a seq conflict
  });
});
```

In `run-cli.test.ts`, replace the zero-cases test at `:422-436`:

```ts
  it("zero cases: results.json and the 'No cases run' banner are written, exit 1 (planner seam, no shared-state edit)", async () => {
    capture();
    const dir = dirFor();
    const planCases = () => ({ sports: [] as string[], plan: () => [] });
    expect(await runSlice(deps({ planCases }), ["--run-id", "t8", "--report-dir", dir])).toBe(1);
    expect(resultsIn(dir, "t8").cases).toEqual([]);
    expect(readFileSync(join(dir, "t8", "MATRIX.md"), "utf8")).toContain("No cases run");
    expect([...SLICE_ROWS]).toEqual(["league", "knockout", "swiss"]); // untouched
  });

  it("the default planner is the slice: 24 cases over the slice sports, variants read once per slice sport", async () => {
    capture();
    const dir = dirFor();
    const d = deps();
    expect(await runSlice(d, ["--run-id", "t8b", "--report-dir", dir])).toBe(0);
    const cases = resultsIn(dir, "t8b").cases;
    expect(cases.length).toBe(SLICE_ROWS.length * 2 * 4);
    expect(new Set(cases.map((c) => c.sport))).toEqual(new Set(["generic", "badminton"]));
  });
```

Add `"scripts/matrix/lib/driver/engine-http.ts"` to the module list in `strip-types-loadable.test.ts`.

- [ ] **Step 2: Run the tests and watch them fail for the right reason**

Run the Global Constraints template with `<N>`=1 and `<files>` = `scripts/matrix/__tests__/engine-http.test.ts scripts/matrix/__tests__/run-cli.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts`.
Expected: the engine-http suite FAILS TO COLLECT (`Cannot find module '../lib/driver/engine-http.ts'`), so `failedSuites ≥ 1`. The zero-cases test fails: `planCases` is ignored, so 24 cases run and it exits 0, not 1.

- [ ] **Step 3: Implement**

`scripts/matrix/lib/driver/engine-http.ts`:

```ts
// The product's EngineErrorCode → HTTP status map (apps/web/src/server/api-v1/http.ts
// ENGINE_HTTP), restated because http.ts imports next/server and cannot load
// under node --experimental-strip-types. engine-http.test.ts pins it entry for
// entry against that file's text and against EngineErrorCode.options, so a
// new engine code or a changed status reds here first (W1a carry 3).
import type { EngineErrorCode } from "@seazn/engine/core";

export const ENGINE_HTTP_STATUS: Readonly<Record<EngineErrorCode, number>> = Object.freeze({
  SEQ_CONFLICT: 409,
  SCHEDULE_CONFLICT: 409,
  INVALID_EVENT: 422,
  WRONG_PHASE: 422,
  ALREADY_DECIDED: 422,
  LINEUP_INVALID: 422,
  CONFIG_INVALID: 422,
  STAGE_NOT_READY: 422,
  DRAW_NOT_ALLOWED: 422,
  QUALIFICATION_INVALID: 422,
  ELIGIBILITY: 422,
  MODULE_NOT_FOUND: 422,
  MODULE_DUPLICATE: 500,
  NON_MONOTONIC_TIME: 422,
  EXPEDITE_WRONG_WINNER: 422,
  SUB_WINDOW_EXCEEDED: 422,
  UNKNOWN_PHASE: 422,
  GAME_AWARD_DURING_TIEBREAK: 422,
  SEEDING_RULES_MISSING: 422,
  SEEDING_MAP_SLOT_INVALID: 422,
  SEEDING_MAP_SOURCE_INVALID: 422,
  SEEDING_BESTNTH_UNEQUAL_POOLS: 422,
  SEEDING_MAP_SOURCE_AMBIGUOUS: 422,
});

/** http.ts:158 answers `ENGINE_HTTP[err.code] ?? 422`. */
export function engineHttpStatus(code: string | null): number {
  if (code !== null && Object.hasOwn(ENGINE_HTTP_STATUS, code)) return ENGINE_HTTP_STATUS[code as EngineErrorCode];
  return 422;
}
```

`fake-driver.ts:166`: import `engineHttpStatus` from `../lib/driver/engine-http.ts` and replace the literal:

```ts
          const c = typeof code === "string" ? code : null;
          throw new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, engineHttpStatus(c), c, (e as Error).message);
```

`run.ts`: add after `RunDeps`:

```ts
/** What a planner may read from the command line. */
export interface PlannerCli { only?: string; scenario?: string; canary?: string; set?: string }

/** A case list and the sports whose builder variant order it needs from the DB
 *  (read once each, before planning). W1a carry 4: tests inject one instead of
 *  editing SLICE_ROWS in place. */
export interface CasePlanner {
  readonly sports: readonly string[];
  plan(variantFor: (sport: string) => string): CaseSpec[];
}
export type PlanCases = (cli: PlannerCli) => CasePlanner;

export const slicePlanner: PlanCases = (cli) => ({
  sports: SLICE_SPORTS,
  plan: (variantFor) => (cli.canary !== undefined
    ? [planCanaryCase(variantFor, cli.canary)]
    : planSliceCases(variantFor, { only: cli.only, scenario: cli.scenario })),
});
```

Add `planCases?: PlanCases;` to `RunDeps` with the doc comment "Defaults to `slicePlanner`." In `execute()`, replace the order loop and the `specs` line:

```ts
    const planner = (deps.planCases ?? slicePlanner)({ only: cli.only, scenario: cli.scenario, canary: cli.canary });
    const order = new Map<string, string[]>();
    for (const s of planner.sports) order.set(s, await db.variantKeysInBuilderOrder(s));
    const variantFor = (s: string) => builderDefaultVariant(s, order.get(s) ?? []);
    const specs = planner.plan(variantFor);
```

- [ ] **Step 4: Run the tests and see them pass**

Use the same command as Step 2. Expected: green by the Global Constraints definition, with `files` = 3. Paste the JSON line.

- [ ] **Step 5: Mutation check**

- `ENGINE_HTTP_STATUS.ALREADY_DECIDED: 409` → killed by `engine-http.test.ts` "equals ENGINE_HTTP" and "the fake answers…".
- Drop the `SEEDING_MAP_SOURCE_AMBIGUOUS` entry and cast the object → killed by "covers every EngineErrorCode".
- `engineHttpStatus` returns 409 on fallback → killed by "falls back to 422".
- Fake back to a literal `409` → killed by "the fake answers…".
- `execute` ignores `deps.planCases` → killed by run-cli "zero cases".

Restore each mutant from its `cp` backup.

- [ ] **Step 6: Scoped tsc + eslint**

Run tsc and eslint (Global Constraints recipe) on `scripts/matrix/lib/driver/engine-http.ts scripts/matrix/run.ts scripts/matrix/__tests__/fake-driver.ts`. Expected: EXIT=0 for both.

- [ ] **Step 7: Commit**

Message file text:
```
fix(matrix): the fake answers engine refusals with the product's statuses; run.ts takes a planner

ENGINE_HTTP_STATUS restates api-v1's ENGINE_HTTP, pinned entry for entry
against http.ts's text and EngineErrorCode.options. The fake used 409 for
every engine code (W1a carry 3). run.ts's case list now comes from an
injectable planner, so the zero-cases test no longer empties SLICE_ROWS in
place (W1a carry 4).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && git commit -F "$TMPDIR/w1b-msg.txt" -- scripts/matrix/lib/driver/engine-http.ts scripts/matrix/__tests__/engine-http.test.ts scripts/matrix/__tests__/fake-driver.ts scripts/matrix/run.ts scripts/matrix/__tests__/run-cli.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts
```
(`git add` new files first.)

---

## Task 2: Invariants — `stepSafe`, I7 (no pair over legs), I8 (generate named), the stage-field guard

This task closes false premise 3 and W1a carry 1. It adds a step-safe subset of invariants for the model (Task 13), and an invariant that is still judged after a late entry. Task 13 relies on the second: I1 abstains exactly where #879 lives. It also makes a division-wide `field` on a later stage fail loudly instead of passing wrongly.

**Files:**
- Modify: `scripts/matrix/lib/invariants.ts` (spec interface `:13-21`, I1 `:28-60`, registry `:285`, `evaluateInvariants` `:301-306`)
- Modify: `scripts/matrix/lib/observed.ts` (`ObservedStage`)
- Modify: `scripts/matrix/lib/scenarios/common.ts:125` (export `recordGenerate`), `snapshot` (`:293`)
- Test: `scripts/matrix/__tests__/invariants.test.ts` (pins `:29-34`, `:52`, `:525-529` plus new cases), `scripts/matrix/__tests__/scenarios.test.ts`, `scripts/matrix/__tests__/results.test.ts`, `scripts/matrix/__tests__/run-cli.test.ts` (only where they count invariant checks)

**Interfaces:**
- Consumes: `twoSided`, `isNamedRefusal` (`observed.ts`).
- Produces:
  - `InvariantSpec.stepSafe: boolean`
  - `ObservedStage.fieldSource: "division" | "seeded"`
  - `INVARIANTS` = [I1..I8] in id order
  - `STEP_INVARIANTS: readonly InvariantSpec[]` (I6, I7, I8)
  - `evaluateStepInvariants(run: ObservedRun): CheckResult[]`
  - `export async function recordGenerate(ctx, rec, stageId): Promise<FixtureRow[] | null>` (unchanged body, now exported)

State transitions and empty cases to test:
- no stage of the kind → abstain;
- no two-sided fixture yet → abstain;
- a pair at exactly `legs` → pass;
- a pair over `legs` after a late entry → fail while I1 abstains;
- no generate recorded → abstain;
- a generic-code refusal → fail;
- a stage with seq 2 and a division-wide field → fail.

- [ ] **Step 1: Write the failing tests** (append to `invariants.test.ts`, reusing its `stage()` / `run()` / `fx()` helpers)

First, set the `stage()` helper's default to `fieldSource: "division"`. Then update the three pins:

```ts
  it("registry: eight invariants in id order", () => {
    expect(INVARIANTS.map((s) => s.id)).toEqual([
      "I1-rr-pair-once-per-leg", "I2-bracket-one-champion-ranks-permutation", "I3-table-points-equal-declared", "I4-nothing-ends-stuck",
      "I5-config-edit-never-rescores", "I6-swiss-no-rematch", "I7-rr-no-pair-over-legs", "I8-generate-named",
    ]);
  });
  it("'any'-kind invariants are I4, I5 and I8", () => {
    expect(INVARIANTS.filter((s) => s.stageKinds === "any").map((s) => s.id)).toEqual(["I4-nothing-ends-stuck", "I5-config-edit-never-rescores", "I8-generate-named"]);
  });
  it("the step-safe subset is exactly I6, I7, I8 — the ones that hold after EVERY organiser step", () => {
    expect(STEP_INVARIANTS.map((s) => s.id)).toEqual(["I6-swiss-no-rematch", "I7-rr-no-pair-over-legs", "I8-generate-named"]);
    expect(STEP_INVARIANTS.length).toBeGreaterThan(0);
  });
```

The ids above are W1a's, copied from `invariants.ts:29,88,160,200,237,259` at `b92ef16dd`. Re-pin them first: if one differs, the file wins (class 5).

New cases:

```ts
describe("I7 — no round-robin pair over its legs (step-safe, no abstentions)", () => {
  const I7 = INVARIANTS.find((s) => s.id === "I7-rr-no-pair-over-legs")!;
  it("empty case first: no league/group stage → abstain", () => {
    expect(evaluateInvariant(I7, run([stage({ kind: "knockout" })])).verdict).toBe("abstain");
  });
  it("no two-sided fixture yet → abstain (nothing generated), never a vacuous pass", () => {
    const r = evaluateInvariant(I7, run([stage({ fixtures: [] })]));
    expect(r).toMatchObject({ verdict: "abstain", checked: 0 });
  });
  it("a 4-field single round robin: 6 pairs, each once → pass, checked 6", () => {
    const f = [["a", "b"], ["c", "d"], ["a", "c"], ["b", "d"], ["a", "d"], ["b", "c"]].map(([h, w], i) => fx({ id: `f${i}`, home: h!, away: w! }));
    expect(evaluateInvariant(I7, run([stage({ fixtures: f })]))).toMatchObject({ verdict: "pass", checked: 6 });
  });
  it("#879's shape: a late entrant, then Generate duplicates a pair → I7 FAILS while I1 abstains on late_entry", () => {
    const f = [["a", "b"], ["a", "b"], ["a", "e"]].map(([h, w], i) => fx({ id: `f${i}`, home: h!, away: w! }));
    const r = run([stage({ fixtures: f, field: ["a", "b", "e"] })], { facts: ["late_entry"] });
    expect(evaluateInvariant(I7, r).verdict).toBe("fail");
    expect(evaluateInvariant(I7, r).evidence[0]).toMatch(/a~b meets 2× in stage 1 \(legs 1\)/);
    expect(evaluateInvariant(INVARIANTS[0]!, r).verdict).toBe("abstain"); // the witness I7 exists for
  });
  it("legs from the stage config: 2 meetings at legs 2 pass, 3 fail", () => {
    const two = [0, 1].map((i) => fx({ id: `f${i}`, home: "a", away: "b" }));
    expect(evaluateInvariant(I7, run([stage({ fixtures: two, config: { legs: 2 } })])).verdict).toBe("pass");
    const three = [0, 1, 2].map((i) => fx({ id: `f${i}`, home: "a", away: "b" }));
    expect(evaluateInvariant(I7, run([stage({ fixtures: three, config: { legs: 2 } })])).verdict).toBe("fail");
  });
});

describe("I8 — every Generate answer is fixtures or a named refusal", () => {
  const I8 = INVARIANTS.find((s) => s.id === "I8-generate-named")!;
  const g = (status: number, code: string | null) => ({ status, code, total: 0, created: 0 });
  it("empty case first: no generate recorded → abstain", () => {
    expect(evaluateInvariant(I8, run([stage({ generates: [] })])).verdict).toBe("abstain");
  });
  it("200 and 422 STAGE_NOT_READY pass (checked 2); 409 CONFLICT, 500 INTERNAL and a code-less 422 fail", () => {
    expect(evaluateInvariant(I8, run([stage({ generates: [g(200, null), g(422, "STAGE_NOT_READY")] })]))).toMatchObject({ verdict: "pass", checked: 2 });
    for (const bad of [g(409, "CONFLICT"), g(500, "INTERNAL"), g(422, null)]) {
      expect(evaluateInvariant(I8, run([stage({ generates: [bad] })])).verdict).toBe("fail");
    }
  });
});

describe("I1 — a later stage's field must be observed per stage (W1a carry 1)", () => {
  it("seq 2 with a division-wide field FAILS by name rather than judging the wrong entrants", () => {
    const r = evaluateInvariant(INVARIANTS[0]!, run([stage({ seq: 2, fieldSource: "division" })]));
    expect(r.verdict).toBe("fail");
    expect(r.evidence.join(" ")).toMatch(/stage seq 2: field is division-wide/);
  });
  it("seq 2 with a seeded field is judged normally", () => {
    const f = [fx({ id: "f1", home: "a", away: "b" })];
    expect(evaluateInvariant(INVARIANTS[0]!, run([stage({ seq: 2, fieldSource: "seeded", field: ["a", "b"], fixtures: f })])).verdict).toBe("pass");
  });
});

it("evaluateStepInvariants returns exactly the step-safe ids", () => {
  const out = evaluateStepInvariants(run([stage({})]));
  expect(out.map((c) => c.id)).toEqual(STEP_INVARIANTS.map((s) => s.id));
});
```

Then run `grep -an "toHaveLength\|evaluateInvariants\|INVARIANTS" scripts/matrix/__tests__/scenarios.test.ts scripts/matrix/__tests__/results.test.ts scripts/matrix/__tests__/run-cli.test.ts`. Any assertion that counts invariant checks as a typed number (6) becomes `INVARIANTS.length` (derived, R9).

- [ ] **Step 2: Run and watch them fail**

Use the template with `<N>`=2 and `<files>` = `scripts/matrix/__tests__/invariants.test.ts`. Expected: FAILS to collect or fails on the missing `STEP_INVARIANTS` / `evaluateStepInvariants` exports, and on the 6-id registry pin.

- [ ] **Step 3: Implement**

`observed.ts`, inside `ObservedStage`, after `field`:

```ts
  /** Where `field` came from: "division" = every entrant of the division (right
   *  for a root stage), "seeded" = the entrants the product placed into THIS
   *  stage (a later stage). I1 refuses to judge a later stage on a
   *  division-wide field (W1a carry 1). */
  fieldSource: "division" | "seeded";
```

`invariants.ts`:

```ts
export interface InvariantSpec {
  readonly id: string;
  readonly description: string;
  readonly stageKinds: readonly string[] | "any";
  readonly abstainOn: readonly CaseFact[];
  readonly abstainOnStageConfig: readonly string[];
  readonly requiresCompletedStage: boolean;
  /** Holds after EVERY organiser action, not only at the end of a lifecycle —
   *  the fast-check model (W1b Task 13) evaluates only these after each step. */
  readonly stepSafe: boolean;
  check(stages: readonly ObservedStage[], run: ObservedRun): InvariantResult;
}
```

Set `stepSafe` for each spec, with the reason as a trailing comment:
- I1 `false` (it owes every pair: incomplete until generated);
- I2 `false` (it needs a completed bracket);
- I3 `false` (a mid-sequence void or cascade leaves the table's truth to W2/W5's rulebooks);
- I4 `false` (it fails by construction before complete);
- I5 `false` (its producer is the config probe, not a step);
- I6 `true`.

At the top of I1's per-stage loop:

```ts
    for (const s of stages) {
      if (s.seq > 1 && s.fieldSource !== "seeded") {
        fails.push(`stage seq ${s.seq}: field is division-wide — per-stage entrants were not observed (W1a carry 1)`);
        continue;
      }
```

Add I7 and I8 after I6:

```ts
const I7: InvariantSpec = {
  id: "I7-rr-no-pair-over-legs",
  description: "no round-robin pair meets more often than the stage's legs — after every step, late entries included",
  stageKinds: ["league", "group"],
  // Deliberately none: this is the check that still speaks after a late entry,
  // a withdrawal or a void — where I1 abstains and #879 lives.
  abstainOn: [],
  abstainOnStageConfig: [],
  requiresCompletedStage: false,
  stepSafe: true,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    for (const s of stages) {
      const legs = typeof s.config.legs === "number" ? s.config.legs : 1;
      const met = new Map<string, string[]>();
      for (const f of s.fixtures.filter(twoSided)) {
        const k = pairKey(f.home!, f.away!);
        met.set(k, [...(met.get(k) ?? []), f.id]);
      }
      for (const [k, ids] of [...met].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        checked++;
        if (ids.length > legs) fails.push(`${k} meets ${ids.length}× in stage ${s.seq} (legs ${legs}): ${ids.join(", ")}`);
      }
    }
    // Before Generate there is nothing to judge: abstain, never a vacuous pass.
    // The model's per-cell rule (Task 14) still demands checked > 0 over a cell.
    if (checked === 0) return ABSTAIN("no two-sided fixture yet");
    return result(fails, checked);
  },
};

const I8: InvariantSpec = {
  id: "I8-generate-named",
  description: "every Generate answer is fixtures (2xx) or a named refusal",
  stageKinds: "any",
  abstainOn: [],
  abstainOnStageConfig: [],
  requiresCompletedStage: false,
  stepSafe: true,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    for (const s of stages) for (const g of s.generates) {
      checked++;
      const ok = (g.status >= 200 && g.status < 300) || isNamedRefusal(g.status, g.code);
      if (!ok) fails.push(`stage ${s.seq}: generate → ${g.status} ${g.code ?? "(no code)"}`);
    }
    if (checked === 0) return ABSTAIN("no generate recorded");
    return result(fails, checked);
  },
};

export const INVARIANTS: readonly InvariantSpec[] = Object.freeze([I1, I2, I3, I4, I5, I6, I7, I8]);
export const STEP_INVARIANTS: readonly InvariantSpec[] = Object.freeze(INVARIANTS.filter((s) => s.stepSafe));
```

Extract the mapping inside `evaluateInvariants` into `toCheck(spec, r)`, then:

```ts
export function evaluateStepInvariants(run: ObservedRun): CheckResult[] {
  return STEP_INVARIANTS.map((spec) => toCheck(spec, evaluateInvariant(spec, run)));
}
```

`common.ts`: change `async function recordGenerate` to `export async function recordGenerate`. In `snapshot`, add `fieldSource: "division"` beside `field`. W1a only snapshots a single root stage (multi-stage is deferred at `:92`).

- [ ] **Step 4: Run and see them pass**

Use the template with `<files>` = `scripts/matrix/__tests__/invariants.test.ts scripts/matrix/__tests__/scenarios.test.ts scripts/matrix/__tests__/results.test.ts scripts/matrix/__tests__/run-cli.test.ts`. Expected: green, `files` = 4.

- [ ] **Step 5: Mutation check**

- I7 `ids.length > legs` → `>=` → killed by "4-field single round robin".
- I7 abstains on `late_entry` → killed by "#879's shape".
- I7's `if (checked === 0) return ABSTAIN` removed → killed by "no two-sided fixture yet" (R25 turns it into a fail).
- I8 `|| isNamedRefusal(...)` removed → killed by "422 STAGE_NOT_READY pass".
- I8 accepts any 4xx → killed by "409 CONFLICT … fail".
- I1's seq guard deleted → killed by "seq 2 with a division-wide field FAILS".
- I6 `stepSafe: false` → killed by the step-safe pin.

- [ ] **Step 6: Scoped tsc + eslint**

Run them on `scripts/matrix/lib/invariants.ts scripts/matrix/lib/observed.ts scripts/matrix/lib/scenarios/common.ts`. Expected: EXIT=0.

- [ ] **Step 7: Commit**

Message: `feat(matrix): step-safe invariants, I7 no pair over legs, I8 generate named, per-stage field guard` plus a body naming false premise 3 and W1a carry 1, and the trailer. Paths: the 3 lib files and the touched test files.

---

## Task 3: API-only row bodies

This closes `catalogue.ts:101` (false premise 4). The five API-only rows get stage bodies derived from product authorities: the builder's own bodies, the t20-super8 catalog template, and the knockout generator's `cfg.thirdPlace` read. The remaining W1a deferrals are renamed from "W1b" to "W1-driving" (recommendation Q-A).

**Files:**
- Modify: `scripts/matrix/lib/catalogue.ts:94-112`
- Modify: `scripts/matrix/lib/scenarios/common.ts:90,92,94` (the wave string only)
- Test: `scripts/matrix/__tests__/catalogue.test.ts` (replace `:87-94`), `scripts/matrix/__tests__/scenarios.test.ts` (any assertion on the "W1b" deferral text)

**Interfaces:**
- Consumes: `buildTemplateStages`, `applyStandingsCarry`, `clampKnob` (`format-templates.ts`).
- Produces:
  - `builderStages(row: TemplateRowKey, knobs?: TemplateKnobs): StageDraft[]` (the pre-seq builder output)
  - `stagesForRow(row: string, knobs?): StagePostBody[]` builds all 21 rows
  - `SUPER8: Readonly<{ firstPools: 4; secondPools: 2; take: 2 }>`
  - `DRIVING_WAVE = "W1-driving"`, exported from `lib/scenarios/common.ts`

- [ ] **Step 1: Write the failing tests** (in `catalogue.test.ts`, replacing "API-only rows are a named refusal routed to W1b")

```ts
import { readFileSync } from "node:fs";
// (REPO resolved as elsewhere in this file)
const super8 = JSON.parse(readFileSync(resolve(REPO, "apps/web/src/server/templates/catalog/t20-super8.json"), "utf8")) as
  { divisions: { stages: { kind: string; groups?: number; progression?: unknown }[] }[] };

describe("API-only rows — bodies derived from product authorities", () => {
  it("empty case first: an unknown row is still refused, never a silent league", () => {
    expect(() => stagesForRow("nope")).toThrow(UnknownRow);
  });
  it("every one of the 21 rows builds, seq 1..n, and none throws RowBuildDeferred", () => {
    let built = 0;
    for (const row of ROW_KEYS) {
      const s = stagesForRow(row);
      expect(s.map((x) => x.seq)).toEqual(s.map((_, i) => i + 1));
      built++;
    }
    expect(built).toBe(TEMPLATE_ROW_KEYS.length + API_ONLY_ROWS.length);
  });
  it("group_only = the builder's groups_ko stage 1, alone", () => {
    expect(stagesForRow("group_only")).toEqual([{ ...builderStages("groups_ko")[0], seq: 1 }]);
  });
  it("group_group_ko matches t20-super8.json: kinds, pool counts and both progressions", () => {
    const tpl = super8.divisions[0]!.stages;
    const got = stagesForRow("group_group_ko");
    expect(got.map((s) => s.kind)).toEqual(tpl.map((s) => s.kind));
    expect(got.slice(0, 2).map((s) => (s.config as { pools: { count: number } }).pools.count)).toEqual(tpl.slice(0, 2).map((s) => s.groups));
    expect(got.map((s) => s.progression ?? null)).toEqual(tpl.map((s) => s.progression ?? null));
  });
  it("knockout_third_place sets config.thirdPlace, the key the product's knockout generate reads", () => {
    const src = readFileSync(resolve(REPO, "apps/web/src/server/usecases/stages.ts"), "utf8");
    expect(src).toContain("thirdPlace: cfg.thirdPlace === true");
    expect(stagesForRow("knockout_third_place")).toEqual([{ ...builderStages("knockout")[0], config: { thirdPlace: true }, seq: 1 }]);
  });
  it("page_playoff_only / stepladder_only = the builder's second stage with no feed", () => {
    expect(stagesForRow("page_playoff_only")).toEqual([{ ...builderStages("group_playoffs")[1], progression: null, seq: 1 }]);
    expect(stagesForRow("stepladder_only")).toEqual([{ ...builderStages("group_stepladder")[1], progression: null, seq: 1 }]);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Use the template with `<N>`=3 and `<files>` = `scripts/matrix/__tests__/catalogue.test.ts`. Expected: fails on `builderStages` not exported, and on `RowBuildDeferred` thrown for `group_only`.

- [ ] **Step 3: Implement** (`catalogue.ts`: replace `stagesForRow` and add below it)

```ts
/** The builder's own bodies for a template row (division-builder.tsx:383-392):
 *  clamp → buildTemplateStages → carry "none". Seq is added by stagesForRow. */
export function builderStages(row: TemplateRowKey, knobs: TemplateKnobs = BUILDER_DEFAULT_KNOBS): StageDraft[] {
  // The product would silently build a league for a key it has dropped.
  if (!STAGE_TEMPLATES.some((t) => t.key === row)) throw new UnknownRow(row);
  const clamped: TemplateKnobs = {
    ...knobs,
    qualified: clampKnob(knobs.qualified, BUILDER_KNOB_BOUNDS.qualified.min, BUILDER_KNOB_BOUNDS.qualified.max),
    poolCount: clampKnob(knobs.poolCount, BUILDER_KNOB_BOUNDS.poolCount.min, BUILDER_KNOB_BOUNDS.poolCount.max),
  };
  return applyStandingsCarry(buildTemplateStages(row, clamped), "none");
}

/** apps/web/src/server/templates/catalog/t20-super8.json — the product's one
 *  group → group → knockout shape. Pinned field by field by catalogue.test.ts. */
export const SUPER8 = Object.freeze({ firstPools: 4, secondPools: 2, take: 2 } as const);

const feed = (placement: "snake" | "rank_order") =>
  ({ sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: SUPER8.take }] }], placement, timing: "setup" }) as unknown as StageDraft["progression"];

function apiOnlyStages(row: ApiOnlyRowKey, knobs: TemplateKnobs): StageDraft[] {
  switch (row) {
    case "group_only":
      return [builderStages("groups_ko", knobs)[0]!];
    case "group_group_ko": {
      const group = builderStages("groups_ko", knobs)[0]!;
      return [
        { ...group, config: { ...group.config, pools: { count: SUPER8.firstPools } } },
        { ...group, name: "Second group stage", config: { ...group.config, pools: { count: SUPER8.secondPools } }, progression: feed("snake") },
        { kind: "knockout", name: "Knockout", config: {}, progression: feed("rank_order") } as StageDraft,
      ];
    }
    case "knockout_third_place":
      return [{ ...builderStages("knockout", knobs)[0]!, config: { thirdPlace: true } }];
    case "page_playoff_only":
      return [{ ...builderStages("group_playoffs", knobs)[1]!, progression: null }];
    case "stepladder_only":
      return [{ ...builderStages("group_stepladder", knobs)[1]!, progression: null }];
  }
}

export function stagesForRow(row: string, knobs: TemplateKnobs = BUILDER_DEFAULT_KNOBS): StagePostBody[] {
  let drafts: StageDraft[];
  if ((API_ONLY_ROWS as readonly string[]).includes(row)) drafts = apiOnlyStages(row as ApiOnlyRowKey, knobs);
  else if ((TEMPLATE_ROW_KEYS as readonly string[]).includes(row)) drafts = builderStages(row as TemplateRowKey, knobs);
  else throw new UnknownRow(row);
  return drafts.map((s, i) => ({ ...s, seq: i + 1 }));
}
```

The `!` on an array index is flagged by scripts lint (no `noUncheckedIndexedAccess`), so drop it if eslint reports `no-unnecessary-type-assertion`. `RowBuildDeferred` stays exported: `run.ts` still catches it, and a later wave may throw it again.

`common.ts`: add `export const DRIVING_WAVE = "W1-driving";` with this comment:

```ts
/** Ruling 28 (Q-A): driving breadth W1a deferred — ladder /
 *  americano / mexicano, multi-stage seeding, team rosters — is its own wave.
 *  A deferral names a wave that is not done (scenario-catalogue.test.ts). */
```

At `:90`, `:92` and `:94`, replace `"W1b"` with `DRIVING_WAVE`. Update any `scenarios.test.ts` assertion that expects the literal `"W1b"` so it expects `DRIVING_WAVE`.

- [ ] **Step 4: Run and see them pass**

Use the template with `<files>` = `scripts/matrix/__tests__/catalogue.test.ts scripts/matrix/__tests__/scenarios.test.ts scripts/matrix/__tests__/run-cli.test.ts`. Expected: green, `files` = 3.

- [ ] **Step 5: Mutation check**

- `thirdPlace: false` → killed by "knockout_third_place".
- Second-stage placement `"rank_order"` → killed by "group_group_ko matches t20-super8.json".
- `SUPER8.firstPools: 2` → same test.
- `page_playoff_only` keeps its progression → killed by "page_playoff_only / stepladder_only".
- Drop the `UnknownRow` guard in `builderStages` → killed by W1a's existing "unknown row" tests in `catalogue.test.ts`.

- [ ] **Step 6: Scoped tsc + eslint** on `scripts/matrix/lib/catalogue.ts scripts/matrix/lib/scenarios/common.ts`.

- [ ] **Step 7: Commit** — `feat(matrix): API-only row bodies from the builder, the t20-super8 template and the knockout's thirdPlace; W1 driving deferrals renamed`.

---

## Task 4: The atomic scenario catalogue (ruling 26: E stays its own scenarios; ruling 30: M12, M4 split)

The design §4 catalogue becomes data:
- the design's parents, whose count the design declares ("Catalogue (N scenario IDs") and the test reads;
- the atomic cases they split into;
- a layer per atom;
- the W1a harness mapping;
- the design's known 🚫 list, and its UI-only 🚫 list (ruling 30);
- a regression-case loader (R29).

Ruling 30 (owner, 2026-09-28) set four of these atoms:
- M4 splits into M4a, "abandoned, no result", and M4b, "abandoned with a result".
- M12, "player injured mid-match (team sport)", is new, with three atoms:
  - M12a: a substitute comes on and the match continues.
  - M12b: there is no replacement, so the team plays short.
  - M12c: a cricket batter retires hurt, then resumes.
- M12b is 🚫 in L2 only. `core.lineup.retirement` has an HTTP route, but no pad or console control sends it. The atom stays in both layers, and its `l2NoPath` names W2.

It also carries the Q-A guard.

**Counts are derived, never typed** (pre-flight ruling R-PF2). They are stated only here, as a plan-time expectation. No test, commit message or later task restates them:
- `PARENTS.length`: the design declares 70.
- `ATOMIC.length`: 94 at plan time, after ruling 30. It is Σ max(1, atoms) over the parents.
- `l3Atomic().length`: 87.
- `l2Atomic().length`: 93.

Record all four from Step 4's output. If the output differs from these, the output wins, and the difference is a finding to explain rather than a number to edit.

**Split rule:**
- Split when the parent's text names alternative organiser inputs, conditions or choices.
- Never split on an outcome the product or rulebook decides (design §4, "Outcomes the product chooses are expected values, not inputs").
- Never split on a sport-determined mechanism (that is the variant axis).
- A parent whose design text contains `vs`, `or` or `/` must either split or carry a written `noSplit` reason. This is enforced.

**Files:**
- Create: `scripts/matrix/lib/scenario-catalogue.ts`, `scripts/matrix/catalogue/regressions.json`
- Test: `scripts/matrix/__tests__/scenario-catalogue.test.ts` (new); add the module to `strip-types-loadable.test.ts`

**Interfaces:**
- Consumes: `ROW_KEYS`, `SPORT_KEYS`, `cellId` (`catalogue.ts`); `ScenarioKey` (`scenarios/types.ts`).
- Produces:
  - `type Family = "R"|"M"|"F"|"D"|"P"|"Q"|"X"|"C"|"E"`
  - `type Layer = "L2"|"L3"`
  - `interface AtomicScenario { id; parent; family; title; layers: readonly Layer[]; l3Excluded: string | null; knownNoPath: string | null; l2NoPath: string | null }`. `knownNoPath` is the owning wave of a design 🚫 with no route in any layer. `l2NoPath` is the owning wave of a UI-only 🚫 (ruling 30), which has an HTTP route but no screen.
  - `PARENTS`
  - `ATOMIC: readonly AtomicScenario[]` (catalogue order)
  - `LIFECYCLE_ID = "LIFECYCLE"`
  - `l3Atomic(): AtomicScenario[]`
  - `l2Atomic(): AtomicScenario[]`
  - `HARNESS_SCENARIO: Readonly<Record<string, ScenarioKey>>`
  - `interface RegressionCase { id; title; issue; cell; variant; check; seed; path; replayPath; fence; status; found; runId }` (`replayPath`: pre-flight ruling R-PF9)
  - `parseRegressions(json: unknown): RegressionCase[]`
  - `REGRESSIONS_PATH`

- [ ] **Step 1: Write the failing test** (`scripts/matrix/__tests__/scenario-catalogue.test.ts`)

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCENARIO_KEYS } from "../lib/slice.ts";
import {
  ATOMIC, HARNESS_SCENARIO, LIFECYCLE_ID, PARENTS, REGRESSIONS_PATH, l2Atomic, l3Atomic, parseRegressions,
} from "../lib/scenario-catalogue.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const design = readFileSync(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-design.md"), "utf8");
const section = design.slice(design.indexOf("Catalogue ("), design.indexOf("**Known 🚫"));
const ID = /\b([RMFDPQXCE]\d{1,2}) /g;
/** Each design id with its text up to the next id or line end. */
const designTexts = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const line of section.split("\n").filter((l) => l.startsWith("- "))) {
    const hits = [...line.matchAll(ID)];
    hits.forEach((m, i) => out.set(m[1]!, line.slice(m.index! + m[0].length, hits[i + 1]?.index ?? line.length).replace(/ · $/, "")));
  }
  return out;
};

describe("scenario catalogue — parents are the design's §4 list, in order", () => {
  it("the design declares its own count, and PARENTS has exactly those ids in design order", () => {
    const declared = Number(/Catalogue \((\d+) scenario IDs/.exec(design)?.[1]);
    const ids = [...designTexts().keys()];
    expect(declared).toBeGreaterThan(0);
    expect(ids.length).toBe(declared);
    expect(PARENTS.map((p) => p.id)).toEqual(ids);
  });
  it("every compound the design names is split", () => {
    const named = /such as ([A-Z0-9, ]+) become/.exec(design.replace(/\n/g, " "))?.[1]?.split(/,\s*/).map((s) => s.trim()) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const id of named) expect(PARENTS.find((p) => p.id === id)?.atoms.length ?? 0, id).toBeGreaterThan(1);
  });
  it("an alternative wording (vs / or / slash) is split or carries a written noSplit reason", () => {
    let judged = 0;
    for (const [id, text] of designTexts()) {
      if (!/\bvs\b|\bor\b|\//.test(text)) continue;
      judged++;
      const p = PARENTS.find((x) => x.id === id)!;
      expect(p.atoms.length > 1 || (p.noSplit ?? "").length > 10, `${id}: "${text}"`).toBe(true);
    }
    expect(judged).toBeGreaterThan(0);
  });
  it("noSplit is only ever on an unsplit parent", () => {
    for (const p of PARENTS) if (p.noSplit !== undefined) expect(p.atoms.length, p.id).toBe(0);
  });
});

describe("atomic cases", () => {
  it("empty-case guard: ATOMIC is non-empty and derived (a split parent yields its atoms, others yield themselves)", () => {
    const expected = PARENTS.reduce((n, p) => n + Math.max(1, p.atoms.length), 0);
    expect(expected).toBeGreaterThan(0);
    expect(ATOMIC.length).toBe(expected);
    expect(new Set(ATOMIC.map((a) => a.id)).size).toBe(ATOMIC.length);
    for (const a of ATOMIC) expect(a.id).toMatch(/^[RMFDPQXCE]\d{1,2}[a-c]?$/);
  });
  it("the design's needs-times parents each have an L3-excluded atom", () => {
    const named = (/Cases that need times\*\* \(([^)]+)\)/.exec(design.replace(/\n/g, " "))?.[1] ?? "")
      .split(/,\s*/).filter((s) => /^[RMFDPQXCE]\d{1,2}$/.test(s));
    expect(named.length).toBeGreaterThan(0); // E4, X1, D5 as of 2026-09-28
    for (const p of named) {
      const atoms = ATOMIC.filter((a) => a.parent === p);
      expect(atoms.some((a) => a.l3Excluded !== null), p).toBe(true);
    }
  });
  it("ruling 26: E2 is the only entry-path atom in L3", () => {
    expect(l3Atomic().filter((a) => a.family === "E").map((a) => a.id)).toEqual(["E2"]);
  });
  it("every atom is on at least one layer; L2 excludes only the API-only E2", () => {
    for (const a of ATOMIC) expect(a.layers.length, a.id).toBeGreaterThan(0);
    expect(ATOMIC.filter((a) => !a.layers.includes("L2")).map((a) => a.id)).toEqual(["E2"]);
    expect(l2Atomic().length + 1).toBe(ATOMIC.length);
  });
  it("the design's known 🚫 parents are marked, each with its owning wave", () => {
    const text = design.slice(design.indexOf("**Known 🚫"), design.indexOf("**Cases that need times"));
    const listed = new Set([...text.matchAll(/\b([RMFDPQXCE]\d{1,2})\b/g)].map((m) => m[1]!));
    listed.delete("X3"); // named in that paragraph as "built in W2", not as 🚫
    const marked = new Set(ATOMIC.filter((a) => a.knownNoPath !== null).map((a) => a.parent));
    expect(listed.size).toBeGreaterThan(0);
    expect(marked).toEqual(listed);
  });
  it("ruling 30: the design's UI-only 🚫 atoms carry l2NoPath with the named wave, and stay in both layers", () => {
    const from = design.slice(design.indexOf("**Known UI-only 🚫"));
    const para = from.slice(0, from.indexOf("\n\n"));
    const listed = [...para.matchAll(/\b([RMFDPQXCE]\d{1,2}[a-c])\b/g)].map((m) => m[1]!);
    const wave = /owed to (W\d+)/.exec(para)?.[1];
    expect(listed.length).toBeGreaterThan(0); // M12b as of 2026-09-28
    expect(wave).toBeDefined();
    expect(ATOMIC.filter((a) => a.l2NoPath !== null).map((a) => a.id)).toEqual(listed);
    for (const id of listed) {
      const a = ATOMIC.find((x) => x.id === id)!;
      expect(a.l2NoPath, id).toBe(wave);
      expect(a.layers, id).toEqual(["L2", "L3"]); // L3 runs over HTTP; the L2 run records the 🚫
      expect(a.knownNoPath, id).toBeNull(); // not a design-wide 🚫: the API route exists
    }
  });
  it("the W1a harness map points at real atoms and real W1a scenarios", () => {
    const ids = new Set([LIFECYCLE_ID, ...ATOMIC.map((a) => a.id)]);
    expect(Object.keys(HARNESS_SCENARIO).length).toBe(4);
    for (const [atom, key] of Object.entries(HARNESS_SCENARIO)) {
      expect(ids.has(atom), atom).toBe(true);
      expect(SCENARIO_KEYS).toContain(key);
    }
  });
});

describe("regression cases (R29)", () => {
  const base = { id: "MB-001", title: "t", issue: "#879", cell: "league|generic", variant: "score", check: "I7-rr-no-pair-over-legs", seed: 42, path: "0:1", replayPath: "CC:B", fence: null, status: "open", found: "2026-09-28", runId: "fm-w1b-model" };
  it("empty case first: the committed file parses to a list (empty until a shrunk failure is committed)", () => {
    const rs = parseRegressions(JSON.parse(readFileSync(resolve(REPO, REGRESSIONS_PATH), "utf8")));
    expect(Array.isArray(rs)).toBe(true);
  });
  it("a well-formed entry parses; an unknown cell, a duplicate id, a bad id or a missing seed is refused", () => {
    expect(parseRegressions({ schemaVersion: 1, regressions: [base] })).toHaveLength(1);
    expect(() => parseRegressions({ schemaVersion: 1, regressions: [{ ...base, cell: "nope|generic" }] })).toThrow();
    expect(() => parseRegressions({ schemaVersion: 1, regressions: [base, base] })).toThrow(/duplicate/);
    expect(() => parseRegressions({ schemaVersion: 1, regressions: [{ ...base, id: "X-1" }] })).toThrow();
    const { seed: _s, ...noSeed } = base;
    expect(() => parseRegressions({ schemaVersion: 1, regressions: [noSeed] })).toThrow();
  });
  it("replayPath (R-PF9): a null one parses, a missing or empty one is refused", () => {
    expect(parseRegressions({ schemaVersion: 1, regressions: [{ ...base, replayPath: null }] })[0]!.replayPath).toBeNull();
    const { replayPath: _r, ...noReplay } = base;
    expect(() => parseRegressions({ schemaVersion: 1, regressions: [noReplay] })).toThrow();
    expect(() => parseRegressions({ schemaVersion: 1, regressions: [{ ...base, replayPath: "" }] })).toThrow();
  });
});

describe("Q-A guard — a deferral never names a finished wave", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : e.endsWith(".ts") ? [join(d, e)] : []));
  it("every wave a ScenarioUnsupported/RowBuildDeferred names has an _INDEX status row that is not done", () => {
    const index = readFileSync(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md"), "utf8");
    const rows = new Map([...index.matchAll(/^\| (W[\w-]+) \| [^|]* \| (.*) \|$/gm)].map((m) => [m[1]!, m[2]!]));
    const waves = new Set<string>();
    for (const f of walk(resolve(REPO, "scripts/matrix/lib"))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/new ScenarioUnsupported\(\s*"([^"]+)"/g)) waves.add(m[1]!);
      for (const m of src.matchAll(/new RowBuildDeferred\([^,]+,\s*"([^"]+)"/g)) waves.add(m[1]!);
      if (/new ScenarioUnsupported\(\s*DRIVING_WAVE/.test(src)) waves.add("W1-driving");
    }
    expect(waves.size).toBeGreaterThan(0);
    for (const w of waves) {
      expect(rows.has(w), `${w} has no status row in _INDEX.md`).toBe(true);
      expect(rows.get(w), w).toMatch(/^(not started|in progress|awaiting)/i);
    }
  });
});
```

The Q-A guard fails until Task 16 adds the `W1-driving` status row. So Step 3 adds that row to `_INDEX.md` now, with the status `not started (ruling 28)`. Task 16 re-confirms it.

- [ ] **Step 2: Run and watch it fail**

Use the template with `<N>`=4 and `<files>` = `scripts/matrix/__tests__/scenario-catalogue.test.ts`. Expected: FAILS TO COLLECT (no module).

- [ ] **Step 3: Implement** `scripts/matrix/lib/scenario-catalogue.ts`

```ts
// Design §4's scenario catalogue as data (R11: a reviewed file, never a draw).
// The design's parents in design order, split into atoms by the rule in the W1b plan
// Task 4: split on alternative organiser INPUTS or CONDITIONS, never on an
// outcome the product/rulebook decides, never on a sport's own mechanism.
// Ruling 26 (O9): E stays four scenarios; only E2 runs in L3.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ROW_KEYS, SPORT_KEYS, cellId, type RowKey } from "./catalogue.ts";
import type { ScenarioKey } from "./scenarios/types.ts";

export type Family = "R" | "M" | "F" | "D" | "P" | "Q" | "X" | "C" | "E";
export type Layer = "L2" | "L3";
interface Atom { readonly suffix: "a" | "b" | "c"; readonly title: string }
export interface ParentScenario { readonly id: string; readonly title: string; readonly atoms: readonly Atom[]; readonly noSplit?: string }

const P = (id: string, title: string, atoms: readonly Atom[] = [], noSplit?: string): ParentScenario =>
  Object.freeze(noSplit === undefined ? { id, title, atoms } : { id, title, atoms, noSplit });
const A = (suffix: Atom["suffix"], title: string): Atom => ({ suffix, title });

export const PARENTS: readonly ParentScenario[] = Object.freeze([
  P("R1", "late entry before Start"),
  P("R2", "late entry after Start"),
  P("R3", "withdrawal before Start"),
  P("R4", "withdrawal mid-event after some results", [
    A("a", "before half the entrant's matches are played"),
    A("b", "at or after half the entrant's matches are played"),
    A("c", "with some of the entrant's fixtures already finalized"),
  ]),
  P("R5", "withdrawal after the entrant has played all their matches"),
  P("R6", "withdrawal of an entrant already drawn into a later bracket/playoff slot", [],
    "bracket vs playoff slot is the row's shape (applicability), not an organiser input"),
  P("R7", "disqualification (status only, no fixture cascade today)"),
  P("R8", "entrant deleted"),
  P("R9", "pair/team rename or lineup change mid-event", [A("a", "pair/team rename mid-event"), A("b", "lineup change mid-event")]),
  P("R10", "waitlist promotion after the draw"),
  P("R11", "duplicate entrant", [A("a", "same person entered twice"), A("b", "same person in two partnerships in one division")]),
  P("R12", "doubles partner withdraws", [A("a", "→ a substitute joins"), A("b", "→ the pair is dissolved")]),
  P("R13", "entrant moved to another division after the draw"),
  P("R14", "retires from one match, continues in the next"),
  P("R15", "leaves after their last match and is still paired next round"),
  P("R16", "substitute / different lineup in a team match (stats attribution)", [],
    "'substitute' and 'different lineup' name one input: a changed team lineup"),
  P("M1", "walkover in only one match"),
  P("M2", "double walkover"),
  P("M3", "retirement mid-match (partial score)"),
  // Ruling 30: split on whether the abandon carries a result.
  P("M4", "abandoned", [
    A("a", "with no result"),
    A("b", "with a result (a cricket DLS decision, a football award-policy abandon)"),
  ]),
  P("M5", "draw in a stage that cannot end level"),
  P("M6", "tie after regulation → decider", [], "the decider is the sport's mechanism (variant axis), not an organiser input"),
  P("M7", "void a decided result", [A("a", "before the next match started"), A("b", "after the next match started")]),
  P("M8", "correct a finalized score", [A("a", "winner stays"), A("b", "winner flips")]),
  P("M9", "forfeit/award by the organiser", [A("a", "forfeit (core.forfeit)"), A("b", "award (core.award)")]),
  P("M10", "disqualification mid-match"),
  P("M11", "a rules change attempted mid-match — must refuse (ruling 12)"),
  // Ruling 30.
  P("M12", "player injured mid-match (team sport)", [
    A("a", "a substitute comes on and the match continues"),
    A("b", "no replacement: the team plays short"),
    A("c", "a cricket batter retires hurt, then resumes"),
  ]),
  P("F1", "odd field (byes)"),
  P("F2", "field below the format's minimum"),
  P("F3", "non-power-of-two bracket"),
  P("F4", "unequal pools"),
  P("F5", "ties", [A("a", "two-way tie"), A("b", "three-or-more-way tie")]),
  P("F6", "everyone level"),
  P("F7", "tie falling through to lots"),
  P("F8", "protected seeds"),
  P("D1", "two divisions merged"),
  P("D2", "one division split"),
  P("D3", "seeding changed after the draw is published"),
  P("D4", "separation", [A("a", "same-club separation"), A("b", "same-country separation")]),
  P("D5", "re-draw after fixtures are published or timed", [A("a", "after fixtures are published (untimed)"), A("b", "after fixtures are timed")]),
  P("D6", "format changed after entries close"),
  P("D7", "stage rules changed after Start"),
  P("P1", "complete a stage with a fixture pending"),
  P("P2", "group → knockout with a qualifying tie unresolved"),
  P("P3", "Generate after a roster change"),
  P("P4", "Rebuild after results exist"),
  P("P5", "undo", [A("a", "undo Generate"), A("b", "undo Pair next round")]),
  P("P6", "per-stage rule override (a best-of-3 final)"),
  P("P7", "rank override"),
  P("Q1", "qualifier decided then corrected after the knockout draw", [A("a", "decided by lots"), A("b", "decided by the organiser")]),
  P("Q2", "group winner withdraws after qualifying", [], "promote-next vs bye is the rulebook's answer (an expected value), not an input"),
  P("Q3", "third-place match skipped → shared 3rd"),
  P("Q4", "final not played", [A("a", "→ joint winners"), A("b", "→ decided by table")]),
  P("Q5", "plate", [A("a", "plate entrant withdraws"), A("b", "a main-draw loser declines the plate")]),
  P("X1", "weather stops play mid-round", [A("a", "resumed next day"), A("b", "cancelled")]),
  P("X2", "event cut short: standings and winner from an incomplete table"),
  P("X3", "round shortened on the fly (fixture-level format override before start)"),
  P("X4", "a disrupted match", [A("a", "resumed from its saved score"), A("b", "replayed from scratch"), A("c", "replayed after a protest")]),
  P("C1", "scores swapped home/away", [], "one input: the two sides' scores exchanged"),
  P("C2", "result entered on the wrong match"),
  P("C3", "protest upheld", [A("a", "result overturned"), A("b", "replayed a day later")]),
  P("C4", "ineligible player → retroactive forfeits across the table"),
  P("C5", "points deduction (conduct) applied to the table"),
  P("C6", "late correction", [A("a", "after the stage is complete"), A("b", "after the event is complete")]),
  P("C7", "result annulled weeks later"),
  P("E1", "phone pad"),
  P("E2", "single-event result over the API"),
  P("E3", "Bo1 points editor"),
  P("E4", "device link / printed scorer-sheet scan", [A("a", "device link"), A("b", "printed scorer-sheet scan")]),
]);

/** Design §4 "Cases that need times" and the browser-only entry paths: never L3. */
const L3_EXCLUDED: Readonly<Record<string, string>> = Object.freeze({
  E1: "browser-only: the phone pad (L2)",
  E3: "browser-only: the Bo1 points editor (L2)",
  E4a: "needs times (design §4): device link",
  E4b: "needs times (design §4): printed-sheet surface",
  X1a: "needs times (design §4)",
  X1b: "needs times (design §4)",
  D5b: "needs times (design §4): the re-draw of a timed schedule",
});
/** L3-only: the API path has no browser counterpart. */
const L2_EXCLUDED = new Set(["E2"]);

/** Design §4 "Known 🚫 at design time" with the wave that owes each a build-or-refuse ruling. */
const KNOWN_NO_PATH: Readonly<Record<string, string>> = Object.freeze({ D1: "W9", D2: "W9", R13: "W9", D4: "W4", Q4: "W4", C5: "W5" });
/** Design §4 "Known UI-only 🚫" (ruling 30), keyed by ATOM: an HTTP route
 *  exists (L3 runs), but no screen sends it (the L2 run records 🚫). M12b's
 *  `core.lineup.retirement` has no pad or console control, and no
 *  minimum-players rule exists; both are owed to W2. */
const KNOWN_UI_NO_PATH: Readonly<Record<string, string>> = Object.freeze({ M12b: "W2" });

export interface AtomicScenario {
  readonly id: string;
  readonly parent: string;
  readonly family: Family;
  readonly title: string;
  readonly layers: readonly Layer[];
  readonly l3Excluded: string | null;
  readonly knownNoPath: string | null;
  readonly l2NoPath: string | null;
}

export const ATOMIC: readonly AtomicScenario[] = Object.freeze(PARENTS.flatMap((p) => {
  const atoms = p.atoms.length === 0 ? [{ id: p.id, title: p.title }] : p.atoms.map((a) => ({ id: `${p.id}${a.suffix}`, title: `${p.title}: ${a.title}` }));
  return atoms.map((a) => {
    const l3Excluded = L3_EXCLUDED[a.id] ?? null;
    const layers: Layer[] = [...(L2_EXCLUDED.has(a.id) ? [] : ["L2" as const]), ...(l3Excluded === null ? ["L3" as const] : [])];
    return Object.freeze({ id: a.id, parent: p.id, family: p.id[0] as Family, title: a.title, layers, l3Excluded, knownNoPath: KNOWN_NO_PATH[p.id] ?? null, l2NoPath: KNOWN_UI_NO_PATH[a.id] ?? null });
  });
}));

export const LIFECYCLE_ID = "LIFECYCLE";
export const l3Atomic = (): AtomicScenario[] => ATOMIC.filter((a) => a.layers.includes("L3"));
export const l2Atomic = (): AtomicScenario[] => ATOMIC.filter((a) => a.layers.includes("L2"));

/** Atoms a W1a scenario already drives. R4a is W1a's R4 (seed 3 withdraws
 *  after round 1 of 8: under half played). */
export const HARNESS_SCENARIO: Readonly<Record<string, ScenarioKey>> = Object.freeze({ LIFECYCLE: "LIFECYCLE", M1: "M1", R4a: "R4", F1: "F1" });

// --- R29: shrunk fast-check failures as named regression cases ---------------
export const REGRESSIONS_PATH = "scripts/matrix/catalogue/regressions.json";
const CELLS = new Set(ROW_KEYS.flatMap((r) => SPORT_KEYS.map((s) => cellId(r as RowKey, s))));
const RegressionSchema = z.strictObject({
  id: z.string().regex(/^MB-\d{3}$/),
  title: z.string().min(1),
  issue: z.string().regex(/^#\d+$/).nullable(),
  cell: z.string().refine((c) => CELLS.has(c), "cell is not on the grid"),
  variant: z.string().min(1),
  check: z.string().min(1),
  seed: z.number().int(),
  path: z.string().min(1),
  /** fast-check's commands replay hint (`fc.commands(…, { replayPath })`): with
   *  seed + path alone the shrunk command list may not reproduce (R-PF9).
   *  null only when the counterexample carried none. */
  replayPath: z.string().min(1).nullable(),
  fence: z.string().min(1).nullable(),
  status: z.enum(["open", "fixed"]),
  found: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runId: z.string().min(1),
});
export type RegressionCase = z.infer<typeof RegressionSchema>;
const FileSchema = z.strictObject({ schemaVersion: z.literal(1), regressions: z.array(RegressionSchema) });

export function parseRegressions(json: unknown): RegressionCase[] {
  const { regressions } = FileSchema.parse(json);
  const seen = new Set<string>();
  for (const r of regressions) {
    if (seen.has(r.id)) throw new Error(`regressions: duplicate id ${r.id}`);
    seen.add(r.id);
  }
  return regressions;
}

export function loadRegressions(repoRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")): RegressionCase[] {
  return parseRegressions(JSON.parse(readFileSync(resolve(repoRoot, REGRESSIONS_PATH), "utf8")));
}
```

`scripts/matrix/catalogue/regressions.json`:

```json
{
  "schemaVersion": 1,
  "regressions": []
}
```

In `_INDEX.md`'s status table, add a row after W1d:
`| W1-driving | L3 driving breadth W1a deferred: multi-stage seeding, team rosters, ladder/americano/mexicano, parallel workers, I2 champion rules for DE/stepladder/page-playoff | not started (ruling 28) |`.

- [ ] **Step 4: Run and see it pass** — same command as Step 2, plus `scripts/matrix/__tests__/strip-types-loadable.test.ts`. Expected: green, `files` = 2. Record `PARENTS.length`, `ATOMIC.length`, `l3Atomic().length` and `l2Atomic().length` in the task report. Both come from the test output: add a `console.log` in a one-off run, never an assertion on a typed number.

- [ ] **Step 5: Mutation check**

- Delete the X4 atoms → killed by "every compound the design names is split".
- Delete R16's `noSplit` → killed by "alternative wording".
- Remove `E2` from `L2_EXCLUDED` → killed by "L2 excludes only the API-only E2".
- Add `E3` to L3 (delete its `L3_EXCLUDED` line) → killed by "ruling 26".
- Drop `C5` from `KNOWN_NO_PATH` → killed by "known 🚫".
- Ruling 30: restore M4's `noSplit` with no atoms → killed by "every compound the design names is split" (the design now names M4).
- Ruling 30: delete `M12b` from `KNOWN_UI_NO_PATH`, or key it `M12` → killed by "UI-only 🚫" (the list comes back empty, or names the parent).
- Ruling 30: add `M12: "W2"` to `KNOWN_NO_PATH` (`KNOWN_NO_PATH` is keyed by parent, so this makes the whole parent a design-wide 🚫) → killed by "known 🚫", because the design does not list M12, and by "UI-only 🚫", because `knownNoPath` must be null.
- Revert common.ts to `"W1b"` with the `_INDEX` W1b row edited to "done" in a scratch copy → killed by the Q-A guard. Use the backup/restore rule on `_INDEX.md`.

- [ ] **Step 6: Scoped tsc + eslint** on `scripts/matrix/lib/scenario-catalogue.ts`.

- [ ] **Step 7: Commit** — `feat(matrix): the atomic scenario catalogue — design parents split into atomic cases, layers, R29 regression file`. Include `_INDEX.md` (the W1-driving row only).

---
## Task 5: The variant set — builder default, boundary classes, a pair-wise cover, scorability

Design §5 asks for every organiser-settable field of every sport, covered pair-wise across (row, preset), with boundary classes (min, default = blank, max, one interior value). The classes come from `SPORT_RULES` (false premise 2). Every combination is built by the product's own `buildRuleOverride` over the product's `visibleRuleFields`, then validated by the engine's `configSchema`. The cover is a deterministic greedy algorithm, so a regeneration is a reviewed diff (R11, trap 5).

**Files:**
- Create: `scripts/matrix/lib/variants.ts`
- Modify: `scripts/matrix/__tests__/boundary.test.ts` (add `apps/web/src/lib/match-rules.ts` to `ALLOWED_WEB`)
- Test: `scripts/matrix/__tests__/variants.test.ts` (new); add the module to `strip-types-loadable.test.ts`

**Interfaces:**
- Consumes:
  - `SPORT_RULES`, `RuleField`, `buildRuleOverride`, `visibleRuleFields` (match-rules.ts)
  - `ROW_KEYS`, `SPORT_KEYS`, `builderDefaultVariant`, `stagesForRow` (catalogue.ts)
  - `resolveSportCfg`, `sportModule`, `variantKeys` (sport-cfg.ts)
  - `generateStream`, `matchesRequest` (streams)
  - `foldStream` (fold.ts)
- Produces:
  - `titleCase(key)`, `offlineVariantOrder(sport)`, `offlineBuilderDefault(sport)`
  - `interface Level { cls: string; raw: string }`, `levelsOf(field: RuleField): Level[]`, `class FieldUnbounded`
  - `interface Factor { name: string; levels: readonly Level[] }`, `factorsFor(sport): Factor[]`
  - `buildVariant(sport, preset, values): { ok: true; overrides; cfg } | { ok: false; reason }`
  - `interface VariantCase { id; sport; row: RowKey; preset; classes: Record<string,string>; values: Record<string,string>; overrides: Record<string,unknown>; scorable: string | null }`
  - `interface Uncoverable { sport; a; b; reason }`
  - `interface SportVariants { sport; defaultPreset; factors; pairs; covered; cases: VariantCase[]; uncoverable: Uncoverable[] }`
  - `buildSportVariants(sport, deps?: { validate?: typeof buildVariant }): SportVariants`
  - `class VariantGenerationStuck`
  - `scorable(vc): string | null`

- [ ] **Step 1: Write the failing test** (`scripts/matrix/__tests__/variants.test.ts`)

```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPORT_RULES, type RuleField } from "../../../apps/web/src/lib/match-rules.ts";
import { BUILDER_PREFERRED_VARIANT, ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { resolveSportCfg, variantKeys } from "../lib/sport-cfg.ts";
import {
  FieldUnbounded, VariantGenerationStuck, buildSportVariants, buildVariant, factorsFor, levelsOf,
  offlineBuilderDefault, scorable, titleCase,
} from "../lib/variants.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (p: string) => readFileSync(resolve(REPO, p), "utf8");
/** The body of a top-level `function <name>(…) {…}`, whitespace-normalised. */
function bodyOf(text: string, name: string): string {
  const at = text.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`no function ${name}`);
  let i = text.indexOf("{", text.indexOf(")", at));
  const start = i;
  for (let depth = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) break;
  }
  return text.slice(start, i + 1).replace(/\s+/g, " ");
}
const ALL = SPORT_KEYS.map((s) => buildSportVariants(s)); // one generation for the file

describe("builder default variant, derived offline", () => {
  it("titleCase is sync-sports.ts's (text-pinned) and sync-sports names every system variant with it", () => {
    const sync = src("scripts/sync-sports.ts");
    expect(bodyOf(src("scripts/matrix/lib/variants.ts"), "titleCase")).toBe(bodyOf(sync, "titleCase"));
    expect(sync).toMatch(/values \(\$\{module\.key\}, \$\{variantKey\}, \$\{titleCase\(variantKey\)\}/);
  });
  it("empty case first: a sport with no variants is refused by name", () => {
    expect(() => offlineBuilderDefault("no-such-sport")).toThrow();
  });
  it("sweeps the registry: every sport's default is one of its own variants; the preferred ones win", () => {
    let n = 0;
    for (const s of SPORT_KEYS) {
      const d = offlineBuilderDefault(s);
      expect(variantKeys(s)).toContain(d);
      const pref = BUILDER_PREFERRED_VARIANT[s];
      if (pref !== undefined && variantKeys(s).includes(pref)) expect(d).toBe(pref);
      n++;
    }
    expect(n).toBe(SPORT_KEYS.length);
  });
  it("ruling 24's recorded defaults hold: volleyball → beach, chess (boardgame) → blitz", () => {
    expect(offlineBuilderDefault("volleyball")).toBe("beach");
    expect(offlineBuilderDefault("boardgame")).toBe("blitz");
  });
});

describe("boundary classes (from SPORT_RULES — the engine schema is unbounded)", () => {
  it("empty cases first: an unbounded number field and an option-less select are refused", () => {
    expect(() => levelsOf({ key: "x", label: "x", kind: "number", build: () => ({}) } as RuleField)).toThrow(FieldUnbounded);
    expect(() => levelsOf({ key: "x", label: "x", kind: "select", options: [], build: () => ({}) } as RuleField)).toThrow(FieldUnbounded);
  });
  it("every SPORT_RULES number field has min < max; interior is strictly between; blank is last", () => {
    let n = 0;
    for (const s of SPORT_KEYS) for (const f of SPORT_RULES[s] ?? []) {
      const ls = levelsOf(f);
      expect(ls.at(-1)).toEqual({ cls: "blank", raw: "" });
      if (f.kind === "number") {
        n++;
        expect(f.min! < f.max!, `${s}.${f.key}`).toBe(true);
        const mid = ls.find((l) => l.cls === "interior");
        if (mid !== undefined) expect(Number(mid.raw) > f.min! && Number(mid.raw) < f.max!).toBe(true);
      }
    }
    expect(n).toBeGreaterThan(0);
  });
});

describe("the pair-wise cover", () => {
  it("sweeps all 11 sports in registry order (never sorted)", () => {
    expect(ALL.map((v) => v.sport)).toEqual([...SPORT_KEYS]);
  });
  it("every pair of factor levels is covered by a case or listed uncoverable with a reason — counted independently", () => {
    let pairs = 0;
    for (const v of ALL) {
      const fs = factorsFor(v.sport);
      const label = (f: number, l: number) => `${fs[f]!.name}=${fs[f]!.levels[l]!.cls}`;
      const cls = (c: (typeof v.cases)[number], f: number) => (f === 0 ? c.row : f === 1 ? c.preset : c.classes[fs[f]!.name] ?? "blank");
      for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++)
        for (let a = 0; a < fs[i]!.levels.length; a++) for (let b = 0; b < fs[j]!.levels.length; b++) {
          pairs++;
          const covered = v.cases.some((c) => cls(c, i) === fs[i]!.levels[a]!.cls && cls(c, j) === fs[j]!.levels[b]!.cls);
          const listed = v.uncoverable.some((u) => u.a === label(i, a) && u.b === label(j, b) && u.reason.length > 0);
          expect(covered || listed, `${v.sport}: ${label(i, a)} × ${label(j, b)}`).toBe(true);
        }
      expect(v.pairs).toBe(v.covered + v.uncoverable.length);
    }
    expect(pairs).toBeGreaterThan(0);
  });
  it("every case is valid for the engine and carries exactly what buildRuleOverride builds", () => {
    let n = 0;
    for (const v of ALL) for (const c of v.cases) {
      expect(() => resolveSportCfg(c.sport, c.preset, c.overrides)).not.toThrow();
      const again = buildVariant(c.sport, c.preset, c.values);
      expect(again.ok && again.overrides).toEqual(c.overrides);
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });
  it("a value for a field the editor hides is never a case (badminton best-of-1 hides setTo)", () => {
    // single-sport: best-of-1's single points field is declared for the set sports; badminton is the pinned example.
    const b = ALL.find((v) => v.sport === "badminton")!;
    expect(b.uncoverable.some((u) => u.a.startsWith("bestOf=option:1") && u.b.startsWith("setTo=") && !u.b.endsWith("blank"))).toBe(true);
    expect(b.cases.some((c) => c.values.bestOf === "1" && (c.values.setTo ?? "") !== "")).toBe(false);
  });
  it("deterministic: a second generation is identical", () => {
    expect(SPORT_KEYS.map((s) => buildSportVariants(s))).toEqual(ALL);
  });
  // Pre-flight ruling R-PF3. For a PURE validate both refusals are unreachable:
  // every field factor has a blank level and the preset factor has the default,
  // so each fill can re-choose the value the pair was already validated with.
  // The refusals guard a validate that is NOT a pure function of its inputs.
  // Reaching them therefore takes a stateful validate — one that answers ok for
  // a budget of calls and then refuses — and the budgets come from the
  // generator's call shape, not from its output:
  //   - pass 1 calls validate once per pair (P = Σ over factor pairs |Li|·|Lj|);
  //   - when all P pairs pass, the first uncovered pair is (row level 0,
  //     preset level 0), so the first completion tries every level of every
  //     field factor once (T1 = Σ over fields |Lk|) and then re-checks the
  //     complete case (call P + T1 + 1).
  // A wrong budget lands on the OTHER site, whose message differs, so the test
  // fails loudly rather than passing vacuously.
  const budgeted = (budget: number) => {
    let calls = 0;
    return (_s: string, _p: string, _v: Record<string, string>) =>
      ++calls <= budget ? ({ ok: true, overrides: {}, cfg: {} } as const) : ({ ok: false, reason: `refused call ${calls}` } as const);
  };
  const callShape = (sport: string) => {
    const L = factorsFor(sport).map((f) => f.levels.length);
    let P = 0;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) P += L[i]! * L[j]!;
    return { fields: factorsFor(sport).slice(2), P, T1: L.slice(2).reduce((a, b) => a + b, 0) };
  };
  it("a fill with no valid level is a named refusal naming the factor (registry sweep)", () => {
    let judged = 0;
    for (const s of SPORT_KEYS) {
      const { fields, P } = callShape(s);
      if (fields.length === 0) continue; // no field factor to fill: the complete-case test below covers this sport
      expect(() => buildSportVariants(s, { validate: budgeted(P) }), s).toThrow(VariantGenerationStuck);
      expect(() => buildSportVariants(s, { validate: budgeted(P) }), s).toThrow(`no valid level for '${fields[0]!.name}'`);
      judged++;
    }
    expect(judged).toBeGreaterThan(0);
  });
  it("a complete case that fails its re-check is a named refusal (registry sweep)", () => {
    let judged = 0;
    for (const s of SPORT_KEYS) {
      const { P, T1 } = callShape(s);
      expect(() => buildSportVariants(s, { validate: budgeted(P + T1) }), s).toThrow("'(complete case)'");
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
  });
  it("covers every row: each sport has a case on each of the 21 rows", () => {
    for (const v of ALL) expect(new Set(v.cases.map((c) => c.row)).size, v.sport).toBe(ROW_KEYS.length);
  });
});

describe("scorability (the generatability sweep)", () => {
  it("each sport's default preset with no override is scorable on every row", () => {
    let n = 0;
    for (const s of SPORT_KEYS) for (const row of ROW_KEYS) {
      expect(scorable({ id: "x", sport: s, row, preset: offlineBuilderDefault(s), classes: {}, values: {}, overrides: {}, scorable: null }), `${row}|${s}`).toBeNull();
      n++;
    }
    expect(n).toBe(ROW_KEYS.length * SPORT_KEYS.length);
  });
  it("every case records scorable = null or a reason, and each sport has at least one scorable case", () => {
    for (const v of ALL) {
      expect(v.cases.filter((c) => c.scorable === null).length, v.sport).toBeGreaterThan(0);
      for (const c of v.cases) expect(c.scorable === null || c.scorable.length > 0).toBe(true);
    }
  });
});
```

In `boundary.test.ts`, add `"apps/web/src/lib/match-rules.ts"` to `ALLOWED_WEB`. Leave the test's own assertion that the list is exactly what the harness imports as it is.

- [ ] **Step 2: Run and watch it fail**

Use the template with `<N>`=5 and `<files>` = `scripts/matrix/__tests__/variants.test.ts scripts/matrix/__tests__/boundary.test.ts`. Expected: variants FAILS TO COLLECT. boundary passes (no import yet) or reds on an unused allowlist entry. If W1a's boundary test demands every allowed path be imported, add the entry in Step 3 instead, and note that.

- [ ] **Step 3: Implement** `scripts/matrix/lib/variants.ts`

```ts
// Config variants (design §5). Per sport, every field the organiser can set
// (SPORT_RULES) is covered PAIR-WISE across (row, preset) with boundary
// classes — the engine's configSchema is unbounded (false premise 2), so the
// bounds are the product's. Each combination is what the product's own
// buildRuleOverride builds over the fields visibleRuleFields shows, validated
// by the engine's configSchema. Deterministic greedy cover: no clock, no
// randomness (R11) — a regeneration is a reviewed diff of variants.json.
import type { StageKind } from "@seazn/engine/core";
import { SPORT_RULES, buildRuleOverride, visibleRuleFields, type RuleField } from "../../../apps/web/src/lib/match-rules.ts";
import { ROW_KEYS, builderDefaultVariant, stagesForRow, type RowKey } from "./catalogue.ts";
import { foldStream } from "./fold.ts";
import { resolveSportCfg, sportModule, variantKeys } from "./sport-cfg.ts";
import { generateStream, matchesRequest } from "./streams/index.ts";

/** scripts/sync-sports.ts:32-36 (not exported there) — the display name every
 *  system variant is stored under, and so what the builder orders by
 *  (`order by is_system desc, name`). Text-pinned by variants.test.ts. */
export function titleCase(key: string): string {
  return key
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The builder's variant order for a fresh org, derived offline: system
 *  variants by name in CODEPOINT order. The live DB sorts by its collation;
 *  run.ts refuses a run where the two defaults differ (Review Focus 5). */
export function offlineVariantOrder(sport: string): string[] {
  return [...variantKeys(sport)].sort((a, b) => byCodepoint(titleCase(a), titleCase(b)) || byCodepoint(a, b));
}

export function offlineBuilderDefault(sport: string): string {
  return builderDefaultVariant(sport, offlineVariantOrder(sport));
}

export interface Level { readonly cls: string; readonly raw: string }

export class FieldUnbounded extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`variants: field '${field}' declares no finite bound/option set — no boundary classes exist`);
    this.name = "FieldUnbounded";
    this.field = field;
  }
}

/** min, max, one interior value (when the range has one), then blank = the
 *  preset's own default (no override). Bools: on / off / blank. Selects: every
 *  option, then blank. */
export function levelsOf(field: RuleField): Level[] {
  switch (field.kind) {
    case "number": {
      if (field.min === undefined || field.max === undefined) throw new FieldUnbounded(field.key);
      const out: Level[] = [{ cls: "min", raw: String(field.min) }, { cls: "max", raw: String(field.max) }];
      const mid = Math.round((field.min + field.max) / 2);
      if (mid > field.min && mid < field.max) out.push({ cls: "interior", raw: String(mid) });
      out.push({ cls: "blank", raw: "" });
      return out;
    }
    case "bool":
      return [{ cls: "on", raw: "on" }, { cls: "off", raw: "off" }, { cls: "blank", raw: "" }];
    case "select": {
      const opts = field.options ?? [];
      if (opts.length === 0) throw new FieldUnbounded(field.key);
      return [...opts.map((o) => ({ cls: `option:${o.value}`, raw: o.value })), { cls: "blank", raw: "" }];
    }
  }
}

export interface Factor { readonly name: string; readonly levels: readonly Level[] }

export function factorsFor(sport: string): Factor[] {
  return [
    { name: "row", levels: ROW_KEYS.map((r) => ({ cls: r, raw: r })) },
    { name: "preset", levels: offlineVariantOrder(sport).map((v) => ({ cls: v, raw: v })) },
    ...(SPORT_RULES[sport] ?? []).map((f) => ({ name: f.key, levels: levelsOf(f) })),
  ];
}

export type Built = { readonly ok: true; readonly overrides: Record<string, unknown>; readonly cfg: unknown } | { readonly ok: false; readonly reason: string };

/** As the editor would send it: only visible fields may carry a value, and the
 *  override crosses the wire as JSON (an `undefined` delete-marker from a
 *  field's buildOnBlank is dropped, as JSON.stringify drops it). */
export function buildVariant(sport: string, preset: string, values: Record<string, string>): Built {
  const inherited = ((sportModule(sport).variants as Record<string, unknown>)[preset] ?? {}) as Record<string, unknown>;
  const visible = new Set(visibleRuleFields(sport, values, inherited).map((f) => f.key));
  for (const [k, v] of Object.entries(values)) {
    if (v !== "" && !visible.has(k)) return { ok: false, reason: `${k} is not shown with these values (visibleRuleFields)` };
  }
  const overrides = JSON.parse(JSON.stringify(buildRuleOverride(sport, values, inherited))) as Record<string, unknown>;
  try {
    return { ok: true, overrides, cfg: resolveSportCfg(sport, preset, overrides) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface VariantCase {
  readonly id: string;
  readonly sport: string;
  readonly row: RowKey;
  readonly preset: string;
  readonly classes: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, string>>;
  readonly overrides: Readonly<Record<string, unknown>>;
  readonly scorable: string | null;
}
export interface Uncoverable { readonly sport: string; readonly a: string; readonly b: string; readonly reason: string }
export interface SportVariants {
  readonly sport: string;
  readonly defaultPreset: string;
  readonly factors: number;
  readonly pairs: number;
  readonly covered: number;
  readonly cases: VariantCase[];
  readonly uncoverable: Uncoverable[];
}

export class VariantGenerationStuck extends Error {
  constructor(sport: string, factor: string, at: string) {
    super(`variants: ${sport}: no valid level for '${factor}' after ${at} — refusing to skip the pair`);
    this.name = "VariantGenerationStuck";
  }
}

export function buildSportVariants(sport: string, deps: { validate?: typeof buildVariant } = {}): SportVariants {
  const validate = deps.validate ?? buildVariant;
  const fs = factorsFor(sport);
  const F = fs.length;
  const defaultPreset = offlineBuilderDefault(sport);
  const presetIx = fs[1]!.levels.findIndex((l) => l.raw === defaultPreset);
  const lvl = (f: number, l: number): Level => fs[f]!.levels[l]!;
  const label = (f: number, l: number): string => `${fs[f]!.name}=${lvl(f, l).cls}`;
  const valuesOf = (asg: readonly number[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let k = 2; k < F; k++) if (asg[k]! >= 0 && lvl(k, asg[k]!).raw !== "") out[fs[k]!.name] = lvl(k, asg[k]!).raw;
    return out;
  };
  const presetOf = (asg: readonly number[]): string => lvl(1, asg[1]! >= 0 ? asg[1]! : presetIx).raw;
  const check = (asg: readonly number[]): Built => validate(sport, presetOf(asg), valuesOf(asg));
  const key = (i: number, a: number, j: number, b: number): string => `${i}:${a}|${j}:${b}`;

  const uncovered = new Map<string, readonly [number, number, number, number]>();
  for (let i = 0; i < F; i++) for (let j = i + 1; j < F; j++)
    for (let a = 0; a < fs[i]!.levels.length; a++) for (let b = 0; b < fs[j]!.levels.length; b++) uncovered.set(key(i, a, j, b), [i, a, j, b]);
  const pairs = uncovered.size;

  // A pair invalid with every other factor at its default can never be covered.
  const uncoverable: Uncoverable[] = [];
  for (const [k, [i, a, j, b]] of [...uncovered]) {
    const asg = new Array<number>(F).fill(-1);
    asg[i] = a;
    asg[j] = b;
    const r = check(asg);
    if (!r.ok) {
      uncovered.delete(k);
      uncoverable.push({ sport, a: label(i, a), b: label(j, b), reason: r.reason });
    }
  }

  const cases: VariantCase[] = [];
  while (uncovered.size > 0) {
    const [i, a, j, b] = uncovered.values().next().value!;
    const asg = new Array<number>(F).fill(-1);
    asg[i] = a;
    asg[j] = b;
    for (let k = 0; k < F; k++) {
      if (asg[k]! >= 0) continue;
      let best = -1;
      let bestGain = -1;
      for (let v = 0; v < fs[k]!.levels.length; v++) {
        const trial = [...asg];
        trial[k] = v;
        if (!check(trial).ok) continue;
        let gain = 0;
        for (let m = 0; m < F; m++) {
          if (m === k || trial[m]! < 0) continue;
          if (uncovered.has(m < k ? key(m, trial[m]!, k, v) : key(k, v, m, trial[m]!))) gain++;
        }
        if (gain > bestGain) { best = v; bestGain = gain; }
      }
      if (best < 0) throw new VariantGenerationStuck(sport, fs[k]!.name, asg.map((x, f) => (x >= 0 ? label(f, x) : "")).filter(Boolean).join(", "));
      asg[k] = best;
    }
    const built = check(asg);
    if (!built.ok) throw new VariantGenerationStuck(sport, "(complete case)", built.reason);
    for (let x = 0; x < F; x++) for (let y = x + 1; y < F; y++) uncovered.delete(key(x, asg[x]!, y, asg[y]!));
    const classes: Record<string, string> = {};
    for (let k = 2; k < F; k++) classes[fs[k]!.name] = lvl(k, asg[k]!).cls;
    const partial = { id: `${sport}#${String(cases.length + 1).padStart(3, "0")}`, sport, row: lvl(0, asg[0]!).raw as RowKey, preset: presetOf(asg), classes, values: valuesOf(asg), overrides: built.overrides };
    cases.push({ ...partial, scorable: scorable({ ...partial, scorable: null }) });
  }
  return { sport, defaultPreset, factors: F, pairs, covered: pairs - uncoverable.length, cases, uncoverable };
}

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Can the harness score a fixture under this case? Win for each side, on the
 *  row's first stage kind, generated then folded through the real engine. */
export function scorable(vc: VariantCase): string | null {
  let cfg: unknown;
  try { cfg = resolveSportCfg(vc.sport, vc.preset, vc.overrides as Record<string, unknown>); } catch (e) { return `cfg: ${errText(e)}`; }
  const stageKind = stagesForRow(vc.row)[0]!.kind as StageKind;
  for (const winner of ["home", "away"] as const) {
    const req = { sportKey: vc.sport, cfg, stageKind, home: "matrix-home", away: "matrix-away", outcome: { kind: "win", winner } as const };
    try {
      const events = generateStream(req);
      const out = foldStream(sportModule(vc.sport), cfg, req.home, req.away, events).outcome;
      if (matchesRequest(req, out) !== "match") return `win-${winner}: folded ${JSON.stringify(out)}`;
    } catch (e) {
      return `win-${winner}: ${errText(e)}`;
    }
  }
  return null;
}
```

Performance note: `ALL` generates about 1,000 cases. Measure the test file's duration. If it exceeds 20 s, memoise `buildVariant` per `(preset, JSON.stringify(values))` inside `buildSportVariants` and record the before and after durations in the report. Do not raise `--testTimeout`.

- [ ] **Step 4: Run and see it pass** — same command as Step 2. Expected: green, `files` = 2. Report each sport's `cases.length`, `pairs`, `uncoverable.length` and unscorable count from a one-off `node --experimental-strip-types -e` print. These are the first real §5 numbers.

- [ ] **Step 5: Mutation check**

- `titleCase` without `.replace(/[-_]+/g, " ")` → killed by the titleCase pin.
- `byCodepoint` reversed → killed by "ruling 24's recorded defaults".
- Drop the interior level → killed by the pair-cover test (pair counts change, and the committed file changes in Task 8). The cover test itself still passes, so name the second killer: Task 8 drift.
- Remove the visibility check in `buildVariant` → killed by "a value for a field the editor hides".
- Replace the per-fill `if (best < 0) throw …` with `if (best < 0) best = 0;` → killed by "a fill with no valid level is a named refusal" (R-PF3).
- Delete the complete-case re-check (`const built = check(asg); if (!built.ok) throw …`, keeping `overrides: {}`) → killed by "a complete case that fails its re-check" (R-PF3).
- `if (gain > bestGain)` → `>=` → still a valid cover (an equivalent mutant for coverage). Record it as equivalent, killed only by Task 8 drift.
- `scorable` returns `null` always → killed by nothing here. Record it as a survivor of this file, killed by Task 8's committed `scorable` fields (drift) only if some case is unscorable. If every case is scorable, record it as equivalent on today's registry.

- [ ] **Step 6: Scoped tsc + eslint** on `scripts/matrix/lib/variants.ts`.

- [ ] **Step 7: Commit** — `feat(matrix): the variant set — SPORT_RULES boundary classes, a deterministic pair-wise cover per sport, scorability through the real engine`.

---

## Task 6: Applicability — predicates, the format gate, variant binding, per-row and per-scenario floors (E predicates follow ruling 26)

Each atomic case gets a predicate over the facts of one cell: the row's real stage bodies, the sport's resolved config, its entrant kinds and the row's format gate. Its **drop reason** is written next to it.

A variant-dependent predicate is handled differently. M4b, M5, M6, M8a, C1 and E3 read the config. If one of them fails at the builder default, it **binds** to the first committed variant case that enables it, rather than dropping the cell (design §4: "E3 needs best-of-1, M5/M6 need a decider switched on").

Trap 1 has three guards:
- Every predicate mutated to `return false` must lower some row's count.
- Every narrowing predicate carries a keep witness and a drop witness, which kills `return true`.
- Every L3 scenario applies somewhere.

**Files:**
- Create: `scripts/matrix/lib/applicability.ts`, `scripts/matrix/lib/format-gates-copy.ts`
- Modify: `scripts/matrix/lib/sport-cfg.ts` (add `entrantKindsFor`)
- Test: `scripts/matrix/__tests__/applicability.test.ts`, `scripts/matrix/__tests__/format-gates-copy.test.ts` (new); add both modules to `strip-types-loadable.test.ts`

**Interfaces:**
- Consumes:
  - `stagesForRow`, `ROW_KEYS`, `SPORT_KEYS`, `cellId` (catalogue.ts)
  - `ATOMIC`, `l3Atomic`, `LIFECYCLE_ID` (scenario-catalogue.ts)
  - `offlineBuilderDefault`, `SportVariants`, `VariantCase` (variants.ts)
  - `drawsAllowed`, `resolveSportCfg` (sport-cfg.ts)
  - `STAGE_RULES_SPORTS`, `showsOnePointsField` (match-rules.ts)
  - `StageKind` (engine core, runtime `.options`)
- Produces:
  - `expectedGate(stages): "formats.double_elim" | "formats.advanced" | null`
  - `entrantKindsFor(sport, cfg): string[]`
  - `interface CellFacts { row; sport; preset; cfg; stages: StageFact[]; entrantKinds; gate }`
  - `cellFacts(row, sport, preset?, overrides?)`
  - `type Predicate = (f: CellFacts) => boolean`
  - `interface WitnessCell { cell: string; preset?: string; values?: Record<string,string> }`
  - `interface Rule { when: Predicate; reason: string; variantDependent: boolean; witness: { keep: WitnessCell; drop: WitnessCell } | null }`
  - `RULES: Readonly<Record<string, Rule>>` (keys = `LIFECYCLE` + every atomic id)
  - `DECIDERS`
  - `ABANDON_RESULTS` (ruling 30, M4b)
  - `decide(rule, row, sport, variants): { applies: boolean; bound: string | null }`
  - `interface PlannedCase { cell; row; sport; scenario; preset; bound: string | null }`
  - `interface Drop { cell; row; sport; scenario; reason }`
  - `planL3({ rules?, variants, only? }): { cases: PlannedCase[]; drops: Drop[] }`
  - `rowCounts(cases)`, `scenarioCounts(cases)`

- [ ] **Step 1: Write the failing tests**

`scripts/matrix/__tests__/format-gates-copy.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { ADVANCED_CONFIG_KEYS, ADVANCED_KINDS, DOUBLE_ELIM_KINDS, expectedGate } from "../lib/format-gates-copy.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const gates = readFileSync(resolve(REPO, "apps/web/src/server/usecases/format-gates.ts"), "utf8");
const stages = readFileSync(resolve(REPO, "apps/web/src/server/usecases/stages.ts"), "utf8");
const fnBody = (name: string) => { const at = gates.indexOf(`export function ${name}(`); return gates.slice(at, gates.indexOf("\n}\n", at)); };

describe("expectedGate — a text-pinned copy of format-gates.ts (server-only, unimportable)", () => {
  it("the double-elim gate's kinds, the advanced gate's kinds and config keys match the product's text", () => {
    const de = [...fnBody("stageNeedsDoubleElimGate").matchAll(/kind === "([a-z_]+)"/g)].map((m) => m[1]);
    const adv = fnBody("stageNeedsAdvancedFormatsGate");
    expect(de.length).toBeGreaterThan(0);
    expect(de).toEqual([...DOUBLE_ELIM_KINDS]);
    expect([...adv.matchAll(/stage\.kind === "([a-z_]+)"/g)].map((m) => m[1])).toEqual([...ADVANCED_KINDS]);
    expect([...adv.matchAll(/stage\.config\?\.([a-z_]+) !== undefined/g)].map((m) => m[1])).toEqual([...ADVANCED_CONFIG_KEYS]);
  });
  it("createStages checks the double-elim gate before the advanced gate (so a row hitting both reports double_elim)", () => {
    const at = stages.indexOf("export async function createStages(");
    const body = stages.slice(at, stages.indexOf("\n}\n", at));
    expect(body.indexOf("stageNeedsDoubleElimGate(")).toBeGreaterThan(0);
    expect(body.indexOf("stageNeedsDoubleElimGate(")).toBeLessThan(body.indexOf("stageNeedsAdvancedFormatsGate("));
  });
  it("empty case first: no stages → no gate", () => {
    expect(expectedGate([])).toBeNull();
  });
  it("over the 21 rows: the seven gated rows (false premise 7), the rest ungated", () => {
    const gated = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) !== null);
    expect(gated).toEqual(["group_playoffs", "swiss_playoff", "double_elim", "americano", "mexicano", "ladder", "page_playoff_only"]);
    expect(ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) === "formats.advanced")).toEqual(["americano", "mexicano", "ladder"]);
  });
});
```

That list is registry order: `group_playoffs` and `swiss_playoff` sit before `double_elim` in `TEMPLATE_ROW_KEYS`, and `page_playoff_only` comes among the API-only rows. Re-pin it against `ROW_KEYS` before running.

`scripts/matrix/__tests__/applicability.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, type RowKey } from "../lib/catalogue.ts";
import { ATOMIC, LIFECYCLE_ID, l3Atomic } from "../lib/scenario-catalogue.ts";
import { buildSportVariants } from "../lib/variants.ts";
import { ABANDON_RESULTS, DECIDERS, RULES, cellFacts, planL3, rowCounts, scenarioCounts, type Rule, type WitnessCell } from "../lib/applicability.ts";
import { sportModule } from "../lib/sport-cfg.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const variants = SPORT_KEYS.map((s) => buildSportVariants(s));
const base = planL3({ variants });
const factsAt = (w: WitnessCell) => {
  const [row, sport] = w.cell.split("|") as [RowKey, string];
  return cellFacts(row, sport, w.preset, w.values === undefined ? {} : undefined, w.values);
};

describe("applicability — rules cover the catalogue", () => {
  it("one rule per atomic id plus LIFECYCLE, and nothing else", () => {
    expect(new Set(Object.keys(RULES))).toEqual(new Set([LIFECYCLE_ID, ...ATOMIC.map((a) => a.id)]));
  });
  it("every narrowing rule states a drop reason and carries a keep/drop witness (kills `return true`)", () => {
    let narrowing = 0;
    for (const [id, r] of Object.entries(RULES)) {
      if (r.witness === null) { expect(r.reason, id).toBe(""); continue; }
      narrowing++;
      expect(r.reason.length, id).toBeGreaterThan(10);
      expect(r.when(factsAt(r.witness.keep)), `${id} keep ${r.witness.keep.cell}`).toBe(true);
      expect(r.when(factsAt(r.witness.drop)), `${id} drop ${r.witness.drop.cell}`).toBe(false);
    }
    expect(narrowing).toBeGreaterThan(0);
  });
  it("every non-narrowing rule applies to every cell at the builder default (it is `always`, not a hidden narrowing)", () => {
    let judged = 0;
    for (const [id, r] of Object.entries(RULES)) if (r.witness === null) for (const row of ROW_KEYS) for (const s of SPORT_KEYS) {
      judged++;
      expect(r.when(cellFacts(row, s)), `${id} ${row}|${s}`).toBe(true);
    }
    expect(judged).toBeGreaterThan(0);
  });
});

describe("applicability — the L3 plan", () => {
  it("empty case first: a rule set where nothing applies plans LIFECYCLE only, and drops name their reason", () => {
    const none: Record<string, Rule> = Object.fromEntries(Object.keys(RULES).map((k) => [k, k === LIFECYCLE_ID ? RULES[k]! : { when: () => false, reason: "test: nothing applies", variantDependent: false, witness: null }]));
    const p = planL3({ rules: none, variants });
    expect(p.cases.length).toBe(ROW_KEYS.length * SPORT_KEYS.length);
    expect(p.drops.every((d) => d.reason === "test: nothing applies")).toBe(true);
  });
  it("LIFECYCLE runs in every one of the 231 cells; every drop has a non-empty reason", () => {
    expect(base.cases.filter((c) => c.scenario === LIFECYCLE_ID).length).toBe(ROW_KEYS.length * SPORT_KEYS.length);
    expect(base.drops.every((d) => d.reason.length > 0)).toBe(true);
  });
  it("every L3 scenario applies to at least one cell (else its predicate is untestable)", () => {
    const c = scenarioCounts(base.cases);
    for (const a of l3Atomic()) expect(c[a.id] ?? 0, a.id).toBeGreaterThan(0);
  });
  it("trap 1 — every predicate mutated to `return false` lowers some row's count below the unmutated plan", () => {
    const floors = rowCounts(base.cases);
    let mutated = 0;
    for (const id of [LIFECYCLE_ID, ...l3Atomic().map((a) => a.id)]) {
      const rules = { ...RULES, [id]: { ...RULES[id]!, when: () => false, variantDependent: false } };
      const only = planL3({ rules, variants, only: [id] });
      const was = planL3({ variants, only: [id] });
      const now = rowCounts(only.cases);
      const before = rowCounts(was.cases);
      expect(ROW_KEYS.some((r) => (now[r] ?? 0) < (before[r] ?? 0)), id).toBe(true);
      expect(ROW_KEYS.every((r) => (floors[r] ?? 0) >= (before[r] ?? 0))).toBe(true);
      mutated++;
    }
    expect(mutated).toBe(l3Atomic().length + 1);
  });
  it("variant binding: M6 on football binds to a committed variant with a decider on, never drops", () => {
    // single-sport: football's builder default has extraTime/shootout off — the pinned example of a bound case.
    const m6 = base.cases.filter((c) => c.scenario === "M6" && c.sport === "football");
    expect(m6.length).toBe(ROW_KEYS.length);
    const vc = variants.find((v) => v.sport === "football")!.cases;
    for (const c of m6) {
      expect(c.bound).not.toBeNull();
      const bound = vc.find((x) => x.id === c.bound)!;
      expect(DECIDERS.football!(cellFacts(c.row, "football", bound.preset, bound.overrides as Record<string, unknown>).cfg)).toBe(true);
    }
  });
  it("the planner is deterministic and walks the registry in order", () => {
    expect(planL3({ variants })).toEqual(base);
    const cells = [...new Set(base.cases.map((c) => c.cell))];
    expect(cells.slice(0, SPORT_KEYS.length)).toEqual(SPORT_KEYS.map((s) => `${ROW_KEYS[0]}|${s}`));
  });
});

describe("DECIDERS — every key read is declared by the sport's configSchema", () => {
  it("each decider reads only keys in <sport>.schema.json's configSchema.properties", () => {
    const SCHEMA: Record<string, string> = {
      football: "football/football.schema.json", cricket: "cricket/cricket.schema.json", icehockey: "icehockey/icehockey.schema.json",
      hockey: "hockey/hockey.schema.json", carrom: "carrom/carrom.schema.json",
    };
    const reads: Record<string, string[]> = { football: ["extraTime", "shootout"], cricket: ["superOver"], icehockey: ["overtime", "shootout"], hockey: ["overtime", "shootout"], carrom: ["tieBoard"] };
    expect(Object.keys(DECIDERS)).toEqual(Object.keys(reads));
    for (const [sport, keys] of Object.entries(reads)) {
      const props = (JSON.parse(readFileSync(resolve(REPO, "packages/engine/src/sports", SCHEMA[sport]!), "utf8")) as { configSchema: { properties: Record<string, unknown> } }).configSchema.properties;
      for (const k of keys) expect(Object.keys(props), `${sport}.${k}`).toContain(k);
    }
  });
});

describe("ruling 30 — M4b: ABANDON_RESULTS agrees with the real engine's abandon", () => {
  const SCHEMA: Record<string, string> = {
    football: "football/football.schema.json", hockey: "hockey/hockey.schema.json",
    icehockey: "icehockey/icehockey.schema.json", cricket: "cricket/cricket.schema.json",
  };
  const ABANDON = { type: "core.abandon", payload: { reason: "matrix: witness" } };
  type Ev = { type: string; payload: unknown };
  /** Streams an abandon may follow: every prefix of a decided home-win stream,
   *  plus one cricket-only candidate. Cricket's generator is coarse, one
   *  closed summary per innings, so no prefix is a chase in progress; the
   *  extra candidate is a partial chase at exactly the cfg's own minimum for
   *  a result (minOversForResult × ballsPerOver, cricket.ts:1152). */
  const candidates = (sport: string, cfg: Readonly<Record<string, unknown>>): Ev[][] => {
    let stream: Ev[];
    try {
      stream = generateStream({ sportKey: sport, cfg, stageKind: "league", home: "H", away: "A", outcome: { kind: "win", winner: "home" } });
    } catch (e) {
      if (!(e instanceof GeneratorUnsupported)) throw e;
      stream = [START]; // cricket two-innings has no generator (KNOWN_UNSUPPORTED); START alone opens the match
    }
    const out = stream.map((_, i) => stream.slice(0, i + 1));
    if (sport === "cricket" && stream.length > 1) {
      const c = cfg as { minOversForResult: number; ballsPerOver: number };
      out.push([...stream.slice(0, 2), { type: "cricket.innings.summary", payload: { runs: 1, wickets: 0, legalBalls: c.minOversForResult * c.ballsPerOver, partial: true } }]);
    }
    return out;
  };
  /** Does an abandon, after SOME undecided candidate, fold to a RESULT (not
   *  null, not no_result)? Folded through the real engine (fold.ts), never
   *  judged from the table. */
  const resultOnAbandon = (sport: string, cfg: Readonly<Record<string, unknown>>): boolean => {
    const m = sportModule(sport);
    for (const prefix of candidates(sport, cfg)) {
      if (foldStream(m, cfg, "H", "A", prefix).outcome !== null) continue; // decided: an abandon now is refused
      try {
        const o = foldStream(m, cfg, "H", "A", [...prefix, ABANDON]).outcome;
        if (o !== null && o.kind !== "no_result") return true;
      } catch { /* WRONG_PHASE: this candidate cannot be abandoned; try the next */ }
    }
    return false;
  };
  it("each key ABANDON_RESULTS reads is declared by the sport's configSchema", () => {
    const reads: Record<string, string[]> = { football: ["abandonPolicy"], hockey: ["abandonPolicy"], icehockey: ["abandonPolicy"], cricket: ["dls", "inningsPerSide"] };
    expect(Object.keys(ABANDON_RESULTS)).toEqual(Object.keys(reads));
    for (const [sport, keys] of Object.entries(reads)) {
      const props = (JSON.parse(readFileSync(resolve(REPO, "packages/engine/src/sports", SCHEMA[sport]!), "utf8")) as { configSchema: { properties: Record<string, unknown> } }).configSchema.properties;
      for (const k of keys) expect(Object.keys(props), `${sport}.${k}`).toContain(k);
    }
  });
  it("registry sweep: at the builder default, ABANDON_RESULTS answers what the engine folds (anti-vacuity: every sport judged)", () => {
    let judged = 0;
    for (const s of SPORT_KEYS) {
      const cfg = cellFacts("league", s).cfg;
      expect(ABANDON_RESULTS[s]?.(cfg) ?? false, s).toBe(resultOnAbandon(s, cfg));
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
  });
  it("every ABANDON_RESULTS arm has a config under which the engine really yields a result (no inert arm)", () => {
    // Engine-declared switches, not organiser reachability: abandonPolicy is an
    // API-only key (false premise 10), so it is passed as a raw override here.
    const on: Record<string, { preset?: string; overrides?: Record<string, unknown>; values?: Record<string, string> }[]> = {
      football: [{ overrides: { abandonPolicy: "award" } }],
      hockey: [{ overrides: { abandonPolicy: "award" } }],
      icehockey: [{ overrides: { abandonPolicy: "award" } }],
      cricket: [{ values: { dls: "on" } }, { preset: "test" }],
    };
    let judged = 0;
    for (const [s, cfgs] of Object.entries(on)) for (const c of cfgs) {
      const cfg = cellFacts("league", s, c.preset, c.overrides ?? {}, c.values).cfg;
      expect(ABANDON_RESULTS[s]!(cfg), `${s} ${JSON.stringify(c)}`).toBe(true);
      expect(resultOnAbandon(s, cfg), `${s} ${JSON.stringify(c)}`).toBe(true);
      judged++;
    }
    expect(judged).toBe(5);
  });
  it("M4b binds only through a committed variant, and drops every sport the organiser cannot reach (configKeysFor, the editor's own key set)", () => {
    let judged = 0;
    for (const s of Object.keys(ABANDON_RESULTS)) {
      const planned = base.cases.filter((c) => c.scenario === "M4b" && c.sport === s);
      const editorKeys = configKeysFor(s);
      if (!editorKeys.has("abandonPolicy") && !editorKeys.has("dls") && !variants.find((v) => v.sport === s)!.cases.some((x) => x.preset === "test")) {
        expect(planned, `${s}: no organiser path to an abandon with a result`).toEqual([]);
        expect(base.drops.some((d) => d.scenario === "M4b" && d.sport === s), s).toBe(true);
      } else {
        expect(planned.length, s).toBeGreaterThan(0);
        for (const c of planned) expect(c.bound, `${s} ${c.cell}: never applies at the builder default`).not.toBeNull();
      }
      judged++;
    }
    expect(judged).toBe(Object.keys(ABANDON_RESULTS).length);
  });
});

describe("ruling 30 — M12", () => {
  it("M12a/M12b apply exactly where R16 does (team entrants), and M12c exactly where the module declares cricket.retire", () => {
    let judged = 0;
    for (const row of ROW_KEYS) for (const s of SPORT_KEYS) {
      const f = cellFacts(row, s);
      expect(RULES.M12a!.when(f), `M12a ${row}|${s}`).toBe(RULES.R16!.when(f));
      expect(RULES.M12b!.when(f), `M12b ${row}|${s}`).toBe(RULES.R16!.when(f));
      expect(RULES.M12c!.when(f), `M12c ${row}|${s}`).toBe(Object.hasOwn(sportModule(s).eventSchemas ?? {}, "cricket.retire"));
      judged++;
    }
    expect(judged).toBe(ROW_KEYS.length * SPORT_KEYS.length);
  });
});
```

The M4b binding test needs these imports added to `applicability.test.ts`:

```ts
import { configKeysFor } from "../../../apps/web/src/lib/match-rules.ts";
import { foldStream } from "../lib/fold.ts";
import { generateStream } from "../lib/streams/index.ts";
import { GeneratorUnsupported, START } from "../lib/streams/types.ts";
```

Before relying on these, re-pin three names. Confirm that `GeneratorUnsupported` is exported from `streams/types.ts`: `streams/index.ts` imports it from there. Confirm that `configKeysFor` is exported at `match-rules.ts:989`. Confirm that the cricket preset key is `"test"` at `cricket.ts:3559`.

A plan-time offline fold was run on 2026-09-28 in the exec worktree, with W1a's `fold.ts` and stream generators. It read, not ran, the product. What it showed:
- At every sport's builder default, `resultOnAbandon` is false.
- Each of the five "on" configs is true:
  - football, hockey and icehockey `award` after the first goal;
  - cricket DLS through the partial chase;
  - cricket `test` at `[START]`, which folds to a draw.
- Without the cricket partial-chase candidate, the DLS arm reads false, because the coarse summaries never leave a chase open. So the candidate is load-bearing; never drop it to "simplify".

The M4b branch condition names only three routes by which an organiser can reach an abandon with a result:
- an `abandonPolicy` editor key;
- the `dls` editor key;
- the cricket `test` preset.

On 2026-09-28 only cricket has a route, so the planned cases are cricket's. Football, hockey and icehockey drop (false premise 10).

`cellFacts` takes the fifth argument `values` (raw editor values). When `values` is given, `overrides` comes from `buildVariant(sport, preset, values)`. This lets a witness say "badminton at best-of-1" the way an organiser types it.

- [ ] **Step 2: Run and watch them fail**

Use the template with `<N>`=6 and `<files>` = `scripts/matrix/__tests__/applicability.test.ts scripts/matrix/__tests__/format-gates-copy.test.ts`. Expected: both FAIL TO COLLECT.

- [ ] **Step 3: Implement**

`scripts/matrix/lib/format-gates-copy.ts`:

```ts
// Text-pinned copy of apps/web/src/server/usecases/format-gates.ts (it imports
// "server-only", so it cannot load here). createStages checks the double-elim
// gate FIRST, then the advanced gate, before any insert (stages.ts:373-382);
// format-gates-copy.test.ts pins both bodies and the order.
export const DOUBLE_ELIM_KINDS: readonly string[] = Object.freeze(["double_elim", "page_playoff"]);
export const ADVANCED_KINDS: readonly string[] = Object.freeze(["americano", "ladder"]);
export const ADVANCED_CONFIG_KEYS: readonly string[] = Object.freeze(["byes", "cross_feeds", "placements"]);

export type FormatGate = "formats.double_elim" | "formats.advanced";

export function expectedGate(stages: readonly { kind: string; config?: Readonly<Record<string, unknown>> }[]): FormatGate | null {
  if (stages.some((s) => DOUBLE_ELIM_KINDS.includes(s.kind))) return "formats.double_elim";
  if (stages.some((s) => ADVANCED_KINDS.includes(s.kind) || ADVANCED_CONFIG_KEYS.some((k) => s.config?.[k] !== undefined))) return "formats.advanced";
  return null;
}
```

`sport-cfg.ts`, beside `entrantKindFor`:

```ts
/** Every entrant kind the sport's model allows under this cfg (a division
 *  picks one; the default is entrantKindFor). Doubles-capable sports list
 *  "pair" here though they default to "individual". */
export function entrantKindsFor(sportKey: string, cfg: unknown): string[] {
  return [...effectiveEntrantModel(sportModule(sportKey).entrantModel ?? null, cfg).kinds];
}
```

Before relying on it, confirm that `effectiveEntrantModel(...).kinds` exists in `packages/engine/src/sport`. It is read at `tennis.ts:55`, `badminton.ts:80` and `tabletennis.ts:89` as `{ kinds, defaultKind }`.

`scripts/matrix/lib/applicability.ts`:

```ts
// Applicability over (row, sport, variant) — design §4. Each atomic case has a
// predicate over one cell's FACTS (the row's real stage bodies, the sport's
// resolved cfg, its entrant kinds, the row's format gate) and the reason a
// cell is dropped. A predicate that reads the cfg binds to the first committed
// variant case that satisfies it before it drops anything. Trap 1's guards
// live in applicability.test.ts. Pure and deterministic (R11).
import { StageKind } from "@seazn/engine/core";
import { STAGE_RULES_SPORTS, showsOnePointsField } from "../../../apps/web/src/lib/match-rules.ts";
import { ROW_KEYS, SPORT_KEYS, cellId, stagesForRow, type RowKey } from "./catalogue.ts";
import { expectedGate, type FormatGate } from "./format-gates-copy.ts";
import { ATOMIC, LIFECYCLE_ID, l3Atomic } from "./scenario-catalogue.ts";
import { drawsAllowed, entrantKindsFor, resolveSportCfg, sportModule } from "./sport-cfg.ts";
import { buildVariant, offlineBuilderDefault, type SportVariants } from "./variants.ts";

export interface StageFact { readonly kind: string; readonly config: Readonly<Record<string, unknown>>; readonly takes: readonly string[] }
export interface CellFacts {
  readonly row: RowKey;
  readonly sport: string;
  readonly preset: string;
  readonly cfg: Readonly<Record<string, unknown>>;
  readonly stages: readonly StageFact[];
  readonly entrantKinds: readonly string[];
  readonly gate: FormatGate | null;
}

const stageFactsMemo = new Map<string, StageFact[]>();
function stageFacts(row: RowKey): StageFact[] {
  let out = stageFactsMemo.get(row);
  if (out === undefined) {
    out = stagesForRow(row).map((s) => ({
      kind: s.kind,
      config: s.config as Record<string, unknown>,
      takes: ((s.progression as { sources?: { take?: { kind: string }[] }[] } | null)?.sources ?? []).flatMap((x) => (x.take ?? []).map((t) => t.kind)),
    }));
    stageFactsMemo.set(row, out);
  }
  return out;
}

export function cellFacts(row: RowKey, sport: string, preset: string = offlineBuilderDefault(sport), overrides: Record<string, unknown> = {}, values?: Record<string, string>): CellFacts {
  let o = overrides;
  if (values !== undefined) {
    const b = buildVariant(sport, preset, values);
    if (!b.ok) throw new Error(`applicability: witness values invalid for ${sport}/${preset}: ${b.reason}`);
    o = b.overrides;
  }
  const cfg = resolveSportCfg(sport, preset, o) as Record<string, unknown>;
  const stages = stageFacts(row);
  return { row, sport, preset, cfg, stages, entrantKinds: entrantKindsFor(sport, cfg), gate: expectedGate(stages) };
}

// --- combinators -------------------------------------------------------------
export type Predicate = (f: CellFacts) => boolean;
const always: Predicate = () => true;
const and = (...ps: Predicate[]): Predicate => (f) => ps.every((p) => p(f));
const or = (...ps: Predicate[]): Predicate => (f) => ps.some((p) => p(f));
const not = (p: Predicate): Predicate => (f) => !p(f);
const hasKind = (...kinds: string[]): Predicate => (f) => f.stages.some((s) => kinds.includes(s.kind));
const multiStage: Predicate = (f) => f.stages.length > 1;
const tableFed: Predicate = (f) => f.stages.length > 1 && ["league", "group", "swiss"].includes(f.stages[0]!.kind);
const entrant = (...kinds: string[]): Predicate => (f) => f.entrantKinds.some((k) => kinds.includes(k));
const ranked = hasKind("league", "group", "swiss", "americano", "ladder");
const bracket = hasKind("knockout", "double_elim", "stepladder", "page_playoff");
const plate: Predicate = (f) => f.stages.some((s) => s.takes.includes("roundLosers"));
const thirdPlace: Predicate = (f) => f.stages.some((s) => s.kind === "knockout" && s.config.thirdPlace === true);
const losersContinue = or(hasKind("league", "group", "swiss", "double_elim", "americano", "ladder", "page_playoff"), plate);
const ALL_KINDS: readonly string[] = StageKind.options;
const drawIn = (f: CellFacts, kind: string): boolean => drawsAllowed(f.sport, f.cfg, kind as StageKind);
/** M5: some stage of the row refuses a level result, and the sport CAN end level somewhere under this cfg. */
const levelRefusedHere: Predicate = (f) => f.stages.some((s) => !drawIn(f, s.kind)) && ALL_KINDS.some((k) => drawIn(f, k));
/** Scoreless: generic's win_loss mode records a winner only (match-rules.ts resultMode options). */
const scoreless: Predicate = (f) => f.sport === "generic" && f.cfg.resultMode === "win_loss";
/** The product's own condition for the Bo1 points editor (match-rules.ts showsOnePointsField). */
const bestOfOneEditor: Predicate = (f) => showsOnePointsField(f.sport, {}, f.cfg as Record<string, unknown>);

/** A decider switched on in the resolved cfg. Keys pinned against each sport's
 *  committed <sport>.schema.json (applicability.test.ts). boardgame has none:
 *  KO chess ties resolve at the fixture layer (boardgame.ts:767-769) — false
 *  premise 9, routed to W4. */
export const DECIDERS: Readonly<Record<string, (cfg: Readonly<Record<string, unknown>>) => boolean>> = Object.freeze({
  football: (c) => (c.extraTime as { enabled?: unknown } | undefined)?.enabled === true || c.shootout === true,
  cricket: (c) => c.superOver === true,
  icehockey: (c) => c.overtime != null || c.shootout != null,
  hockey: (c) => c.overtime != null || c.shootout != null,
  carrom: (c) => c.tieBoard === "extra",
});
const decider: Predicate = (f) => DECIDERS[f.sport]?.(f.cfg) ?? false;

/** Ruling 30, M4b: the cfg lets an abandon YIELD A RESULT (engine applyAbandon).
 *  football/hockey/icehockey only under abandonPolicy "award" (football.ts:1657,
 *  period/kernel.ts:1450; every schema defaults to "replay"). Cricket when DLS
 *  is on (a chase past minOversForResult, cricket.ts:1152-1161) or at two
 *  innings a side (a draw, cricket.ts:1143). Every other sport's abandon
 *  replays (null) or records no_result. Keys pinned against each schema.json,
 *  and each arm witnessed by a real fold (applicability.test.ts). */
export const ABANDON_RESULTS: Readonly<Record<string, (cfg: Readonly<Record<string, unknown>>) => boolean>> = Object.freeze({
  football: (c) => c.abandonPolicy === "award",
  hockey: (c) => c.abandonPolicy === "award",
  icehockey: (c) => c.abandonPolicy === "award",
  cricket: (c) => (c.dls as { enabled?: unknown } | undefined)?.enabled === true || c.inningsPerSide === 2,
});
const abandonWithResult: Predicate = (f) => ABANDON_RESULTS[f.sport]?.(f.cfg) ?? false;
/** Ruling 30, M12c: read from the module's own event declarations
 *  (module.ts `eventSchemas`), not a typed sport list. */
const declaresEvent = (type: string): Predicate => (f) => Object.hasOwn(sportModule(f.sport).eventSchemas ?? {}, type);

// --- rules -------------------------------------------------------------------
export interface WitnessCell { readonly cell: string; readonly preset?: string; readonly values?: Readonly<Record<string, string>> }
export interface Rule {
  readonly when: Predicate;
  /** The drop reason; "" for a rule that never drops. */
  readonly reason: string;
  /** Reads the cfg: bind to a committed variant before dropping. */
  readonly variantDependent: boolean;
  readonly witness: { readonly keep: WitnessCell; readonly drop: WitnessCell } | null;
}
const ALWAYS: Rule = Object.freeze({ when: always, reason: "", variantDependent: false, witness: null });
const rule = (when: Predicate, reason: string, keep: string | WitnessCell, drop: string | WitnessCell, variantDependent = false): Rule =>
  Object.freeze({ when, reason, variantDependent, witness: { keep: typeof keep === "string" ? { cell: keep } : keep, drop: typeof drop === "string" ? { cell: drop } : drop } });

const T = "league|generic";
const KO = "knockout|generic";

export const RULES: Readonly<Record<string, Rule>> = Object.freeze({
  [LIFECYCLE_ID]: ALWAYS,
  R1: ALWAYS, R2: ALWAYS, R3: ALWAYS, R4a: ALWAYS,
  R4b: rule(hasKind("league", "group"), "the 50% expunge threshold exists only in league/group stages (lib/table-withdrawal.ts); elsewhere a later withdrawal is R4a's input", T, "swiss|generic"),
  R4c: ALWAYS, R5: ALWAYS,
  R6: rule(multiStage, "single-stage row: there is no later bracket or playoff slot to be drawn into", "league_ko|generic", T),
  R7: ALWAYS, R8: ALWAYS,
  // Drop witness is boardgame, NOT T: generic has no entrantModel, so
  // effectiveEntrantModel gives it every kind and R9a applies there (R-PF4;
  // boardgame is individual-only under all three presets, checked offline).
  R9a: rule(entrant("pair", "team"), "the sport's entrant model allows neither pairs nor teams: nothing to rename as a pair/team", "league|football", "league|boardgame"),
  R9b: rule(entrant("team"), "no team entrants in this sport's model: there is no lineup to change", "league|football", "league|badminton"),
  R10: ALWAYS,
  R11a: ALWAYS,
  R11b: rule(entrant("pair"), "no pair entrants in this sport's model: nobody can be in two partnerships", "league|badminton", "league|football"),
  R12a: rule(entrant("pair"), "no pair entrants in this sport's model: there is no doubles partner", "league|badminton", "league|football"),
  R12b: rule(entrant("pair"), "no pair entrants in this sport's model: there is no pair to dissolve", "league|badminton", "league|football"),
  R13: ALWAYS,
  R14: rule(losersContinue, "every stage is single-loss elimination: a retirement ends the entrant's event", T, KO),
  R15: rule(hasKind("swiss", "americano"), "the whole schedule is generated at once: nobody is paired 'next round' after leaving", "swiss|generic", T),
  R16: rule(entrant("team"), "no team entrants in this sport's model: no team lineup to substitute into", "league|football", "league|badminton"),
  M1: ALWAYS, M2: ALWAYS, M3: ALWAYS,
  // Ruling 30. M4a: every sport can abandon with no result at its builder
  // default (replay → null, or no_result below cricket's minimum overs).
  M4a: ALWAYS,
  M4b: rule(abandonWithResult, "no organiser-reachable config lets an abandon yield a result here: football/hockey/icehockey need abandonPolicy \"award\", which no editor field sets (configKeysFor; false premise 10); cricket needs DLS on or two innings a side; every other sport's abandon replays or records no result (ABANDON_RESULTS)", { cell: "league|cricket", values: { dls: "on" } }, "league|badminton", true),
  M5: rule(levelRefusedHere, "either every stage of the row accepts a level result, or the sport never ends level under this config (supportsDraws)", "knockout|football", "knockout|badminton", true),
  M6: rule(decider, "no decider is switched on in this config and no committed variant switches one on (DECIDERS; boardgame declares none)", "knockout|icehockey", "knockout|badminton", true),
  M7a: ALWAYS, M7b: ALWAYS,
  M8a: rule(not(scoreless), "generic win_loss records a winner only: there is no score to correct while keeping the winner", T, { cell: T, preset: "win_loss" }, true),
  M8b: ALWAYS, M9a: ALWAYS, M9b: ALWAYS, M10: ALWAYS, M11: ALWAYS,
  // Ruling 30. M12a/M12b follow R16's rule (team entrants). M12c is cricket's retired hurt.
  M12a: rule(entrant("team"), "no team entrants in this sport's model: no substitute can come on for an injured player", "league|football", "league|badminton"),
  M12b: rule(entrant("team"), "no team entrants in this sport's model: there is no team to play short", "league|football", "league|badminton"),
  M12c: rule(declaresEvent("cricket.retire"), "the sport declares no retired-hurt event (module eventSchemas has no cricket.retire; ruling 30: cricket only)", "league|cricket", "league|football"),
  F1: ALWAYS, F2: ALWAYS,
  F3: rule(hasKind("knockout", "double_elim"), "no knockout or double-elimination bracket in this row: nothing to size to a power of two", KO, T),
  F4: rule(hasKind("group"), "no pooled (group) stage in this row", "groups_ko|generic", T),
  F5a: rule(ranked, "bracket-only row: places come from elimination, there is no points table to tie", T, KO),
  F5b: rule(ranked, "bracket-only row: places come from elimination, there is no points table to tie", T, KO),
  F6: rule(ranked, "bracket-only row: there is no table in which everyone can be level", T, KO),
  F7: rule(ranked, "bracket-only row: no table tiebreak can fall through to lots", T, KO),
  F8: rule(hasKind("knockout", "double_elim", "group", "stepladder", "page_playoff", "swiss"), "no seeded placement in this row: everyone meets everyone, or pairing follows standings only", KO, T),
  D1: ALWAYS, D2: ALWAYS, D3: ALWAYS, D4a: ALWAYS, D4b: ALWAYS, D5a: ALWAYS, D5b: ALWAYS, D6: ALWAYS, D7: ALWAYS,
  P1: ALWAYS,
  P2: rule(tableFed, "no table-fed later stage: nothing qualifies from a table", "groups_ko|generic", KO),
  P3: ALWAYS, P4: ALWAYS, P5a: ALWAYS,
  P5b: rule(hasKind("swiss"), "Pair next round (and its undo, /unpair) exists only for swiss stages", "swiss|generic", T),
  P6: rule((f) => STAGE_RULES_SPORTS.has(f.sport), "the sport has no per-stage rules (STAGE_RULES_SPORTS)", "knockout|badminton", "knockout|football"),
  P7: rule(ranked, "bracket-only row: there is no rank table to override", T, KO),
  Q1a: rule(tableFed, "no table-fed later stage: no qualifier is decided by lots", "groups_ko|generic", KO),
  Q1b: rule(tableFed, "no table-fed later stage: no qualifier is decided by the organiser", "groups_ko|generic", KO),
  Q2: rule(tableFed, "no table-fed later stage: nobody qualifies from a group", "groups_ko|generic", KO),
  Q3: rule(thirdPlace, "no third-place match in this row (knockout config.thirdPlace)", "knockout_third_place|generic", KO),
  Q4a: rule(bracket, "no final in this row: league/swiss/rotation formats end on a table", KO, T),
  Q4b: rule(and(bracket, tableFed), "no table to fall back on: the final is not fed by a table stage", "league_ko|generic", KO),
  Q5a: rule(plate, "no plate stage in this row", "ko_plate|generic", KO),
  Q5b: rule(plate, "no plate stage in this row", "ko_plate|generic", KO),
  X1a: ALWAYS, X1b: ALWAYS,
  X2: rule(ranked, "bracket-only row: a cut-short event has no table to take standings from", T, KO),
  X3: ALWAYS, X4a: ALWAYS, X4b: ALWAYS, X4c: ALWAYS,
  C1: rule(not(scoreless), "generic win_loss records a winner only: there are no scores to swap", T, { cell: T, preset: "win_loss" }, true),
  C2: ALWAYS, C3a: ALWAYS, C3b: ALWAYS,
  C4: rule(ranked, "bracket-only row: there is no table for retroactive forfeits to rewrite", T, KO),
  C5: rule(ranked, "bracket-only row: there is no table to deduct points from", T, KO),
  C6a: ALWAYS, C6b: ALWAYS, C7: ALWAYS,
  // Ruling 26 (O9): E stays its own scenarios.
  E1: ALWAYS, E2: ALWAYS,
  E3: rule(bestOfOneEditor, "not best of 1 under this config and no committed variant makes it best of 1 (showsOnePointsField)", { cell: "league|badminton", values: { bestOf: "1" } }, "league|badminton", true),
  E4a: ALWAYS, E4b: ALWAYS,
});

/** Applies at the builder default, else (variant-dependent rules only) bound
 *  to the first committed variant case that satisfies it, else dropped. */
export function decide(r: Rule, row: RowKey, sport: string, variants: readonly SportVariants[]): { applies: boolean; bound: string | null; preset: string } {
  const def = offlineBuilderDefault(sport);
  if (r.when(cellFacts(row, sport, def))) return { applies: true, bound: null, preset: def };
  if (r.variantDependent) {
    for (const vc of variants.find((v) => v.sport === sport)?.cases ?? []) {
      if (r.when(cellFacts(row, sport, vc.preset, vc.overrides as Record<string, unknown>))) return { applies: true, bound: vc.id, preset: vc.preset };
    }
  }
  return { applies: false, bound: null, preset: def };
}

export interface PlannedCase { readonly cell: string; readonly row: RowKey; readonly sport: string; readonly scenario: string; readonly preset: string; readonly bound: string | null }
export interface Drop { readonly cell: string; readonly row: RowKey; readonly sport: string; readonly scenario: string; readonly reason: string }

export class MissingRule extends Error {
  constructor(id: string) { super(`applicability: no rule for scenario '${id}'`); this.name = "MissingRule"; }
}

export function planL3(input: { rules?: Readonly<Record<string, Rule>>; variants: readonly SportVariants[]; only?: readonly string[] }): { cases: PlannedCase[]; drops: Drop[] } {
  const rules = input.rules ?? RULES;
  const ids = [LIFECYCLE_ID, ...l3Atomic().map((a) => a.id)].filter((id) => input.only === undefined || input.only.includes(id));
  const cases: PlannedCase[] = [];
  const drops: Drop[] = [];
  for (const row of ROW_KEYS) for (const sport of SPORT_KEYS) {
    const cell = cellId(row, sport);
    for (const id of ids) {
      const r = rules[id];
      if (r === undefined) throw new MissingRule(id);
      const d = decide(r, row, sport, input.variants);
      if (d.applies) cases.push({ cell, row, sport, scenario: id, preset: d.preset, bound: d.bound });
      else drops.push({ cell, row, sport, scenario: id, reason: r.variantDependent ? `${r.reason} — no committed variant enables it` : r.reason });
    }
  }
  return { cases, drops };
}

export const rowCounts = (cases: readonly PlannedCase[]): Record<string, number> =>
  cases.reduce<Record<string, number>>((m, c) => ({ ...m, [c.row]: (m[c.row] ?? 0) + 1 }), {});
export const scenarioCounts = (cases: readonly { scenario: string }[]): Record<string, number> =>
  cases.reduce<Record<string, number>>((m, c) => ({ ...m, [c.scenario]: (m[c.scenario] ?? 0) + 1 }), {});

/** Every atomic id has a rule (guarded again by the test). */
for (const a of ATOMIC) if (RULES[a.id] === undefined) throw new MissingRule(a.id);
```

Two notes on this code:
- `rowCounts` / `scenarioCounts` use a spread reduce for clarity. If the planner runs slowly, change them to a `Map` loop.
- `cellFacts` performs a zod parse per call. Memoise it on `row|sport|preset|JSON(overrides)` inside `decide` if `applicability.test.ts` exceeds 20 s, and report the durations.

- [ ] **Step 4: Run and see them pass** — same command as Step 2. Expected: green, `files` = 2. If a witness fails, the predicate or the witness is wrong. Read the stage facts (`cellFacts(...)`) and fix whichever disagrees with the product. Never delete the witness.

- [ ] **Step 5: Mutation check**

- The `return false` sweep is in the test itself: each L3 id is mutated in-process (LIFECYCLE plus every `l3Atomic()` id; the test asserts the count).
- `return true` on each narrowing rule: apply it to R4b, M4b, M5, M12c, E3 and Q3 by hand, one at a time. Each is killed by its drop witness.
- Ruling 30: `ABANDON_RESULTS.cricket` without its `inningsPerSide === 2` arm → killed by "every ABANDON_RESULTS arm has a config…" (the `test` preset case). `ABANDON_RESULTS.football` → `c.abandonPolicy !== "replay"` survives, because the enum has only two members. Record it as an equivalent mutant.
- Ruling 30: `resultOnAbandon` returns `false` without folding → killed by the same test, since every arm must fold to a result. This is the positive half of the builder-default sweep, which such a helper would otherwise pass vacuously.
- Ruling 30: M12a's predicate → `entrant("pair", "team")` → killed by the M12 sweep: badminton allows pairs, and R16 says no.
- `levelRefusedHere` without the `ALL_KINDS.some` clause → killed by M5's drop witness (badminton never ends level).
- `DECIDERS.carrom` → `c.tieBoard === "draw"` → killed by "M6 … binds" only if carrom is involved. Name the real killer: the carrom schema default `tieBoard: "extra"` makes M6 apply at the default, so the mutant moves carrom cells to bound or dropped. That is a drift in Task 8's committed drop list.
- `expectedGate` without `page_playoff` → killed by "the seven gated rows".
- Swapped gate order → killed by the format-gates-copy order pin.

- [ ] **Step 6: Scoped tsc + eslint** on `scripts/matrix/lib/applicability.ts scripts/matrix/lib/format-gates-copy.ts scripts/matrix/lib/sport-cfg.ts`.

- [ ] **Step 7: Commit** — `feat(matrix): applicability — predicates with drop reasons and witnesses, variant binding, the format-gate copy`.

---

## Task 7: The L2 pair file (ruling 26 decides which E atoms are L2)

The rule for L2 (design §6.2): every applicable (row, scenario) and (sport, scenario) pair runs at least once in the browser, with widths rotating across the seven. The cover is greedy and deterministic, and it is written to a committed file in Task 8. W1c runs it, and confirms the width list (O3).

Ruling 30 leaves the planner unchanged. Atoms with a known path gap still get their L2 runs: the design's 🚫 parents (D1, D2, R13 and the rest) and the UI-only M12b. W1c reads `knownNoPath` / `l2NoPath` from the catalogue and records 🚫 for those runs rather than dropping them, so the gap stays visible in `MATRIX.md`.

**Files:**
- Create: `scripts/matrix/lib/pairs.ts`
- Test: `scripts/matrix/__tests__/pairs.test.ts` (new); add the module to `strip-types-loadable.test.ts`

**Interfaces:**
- Consumes: `RULES`, `decide`, `Rule` (applicability.ts); `l2Atomic` (scenario-catalogue.ts); `ROW_KEYS`, `SPORT_KEYS` (catalogue.ts); `SportVariants`.
- Produces:
  - `L2_WIDTHS: readonly [320, 360, 375, 390, 430, 768, 834]`
  - `interface L2Run { n; scenario; row; sport; preset; bound; width; covers: ("row"|"sport")[] }`
  - `planL2({ rules?, variants, only? }): { runs: L2Run[]; targets: { rowScenario: number; sportScenario: number }; perScenario: Record<string, number> }`

- [ ] **Step 1: Write the failing test** (`scripts/matrix/__tests__/pairs.test.ts`)

```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { RULES, decide } from "../lib/applicability.ts";
import { L2_WIDTHS, planL2 } from "../lib/pairs.ts";
import { l2Atomic } from "../lib/scenario-catalogue.ts";
import { buildSportVariants } from "../lib/variants.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const variants = SPORT_KEYS.map((s) => buildSportVariants(s));
const plan = planL2({ variants });

describe("L2 pair file", () => {
  it("the seven widths are the Playwright mobile viewport widths (W1c confirms, O3)", () => {
    const cfg = readFileSync(resolve(REPO, "apps/web/playwright.config.ts"), "utf8");
    const widths = [...cfg.matchAll(/viewport: \{ width: (\d+)/g)].map((m) => Number(m[1])).filter((w) => w < 1000);
    expect(widths.length).toBeGreaterThan(0);
    expect([...new Set(widths)].sort((a, b) => a - b)).toEqual([...L2_WIDTHS]);
  });
  it("empty case first: a scenario that applies nowhere gets zero runs and is reported, not hidden", () => {
    const id = l2Atomic()[0]!.id;
    const p = planL2({ variants, rules: { ...RULES, [id]: { ...RULES[id]!, when: () => false, variantDependent: false } }, only: [id] });
    expect(p.runs).toEqual([]);
    expect(p.perScenario[id]).toBe(0);
  });
  it("every applicable (row, scenario) and (sport, scenario) pair is covered by an applicable run — counted", () => {
    let judged = 0;
    for (const a of l2Atomic()) {
      const r = RULES[a.id]!;
      const runs = plan.runs.filter((x) => x.scenario === a.id);
      for (const row of ROW_KEYS) if (SPORT_KEYS.some((s) => decide(r, row, s, variants).applies)) { judged++; expect(runs.some((x) => x.row === row), `${a.id} row ${row}`).toBe(true); }
      for (const s of SPORT_KEYS) if (ROW_KEYS.some((row) => decide(r, row, s, variants).applies)) { judged++; expect(runs.some((x) => x.sport === s), `${a.id} sport ${s}`).toBe(true); }
      for (const x of runs) expect(decide(r, x.row, x.sport, variants).applies, `${a.id} ${x.row}|${x.sport}`).toBe(true);
    }
    expect(judged).toBe(plan.targets.rowScenario + plan.targets.sportScenario);
    expect(judged).toBeGreaterThan(0);
  });
  it("every L2 scenario has at least one run (the L2 half of trap 1)", () => {
    for (const a of l2Atomic()) expect(plan.perScenario[a.id] ?? 0, a.id).toBeGreaterThan(0);
  });
  it("widths rotate: each width's share differs from another's by at most one; n is 1..runs", () => {
    const by = L2_WIDTHS.map((w) => plan.runs.filter((r) => r.width === w).length);
    expect(Math.max(...by) - Math.min(...by)).toBeLessThanOrEqual(1);
    expect(plan.runs.map((r) => r.n)).toEqual(plan.runs.map((_, i) => i + 1));
  });
  it("deterministic", () => {
    expect(planL2({ variants })).toEqual(plan);
  });
});
```

- [ ] **Step 2: Run and watch it fail** — use the template with `<N>`=7 and `<files>` = `scripts/matrix/__tests__/pairs.test.ts`. Expected: FAILS TO COLLECT.

- [ ] **Step 3: Implement** `scripts/matrix/lib/pairs.ts`

```ts
// L2 (design §6.2): every applicable (row, scenario) and (sport, scenario)
// pair runs at least once in the browser, widths rotating across the seven.
// Greedy and deterministic: per scenario in catalogue order, rows in registry
// order take the first sport that still needs covering, then leftover sports
// take the first applicable row. Committed by gen-catalogue.ts (R11).
import { ROW_KEYS, SPORT_KEYS, type RowKey } from "./catalogue.ts";
import { RULES, decide, type Rule } from "./applicability.ts";
import { l2Atomic } from "./scenario-catalogue.ts";
import type { SportVariants } from "./variants.ts";

/** apps/web/playwright.config.ts mobile projects (pinned by pairs.test.ts). */
export const L2_WIDTHS = Object.freeze([320, 360, 375, 390, 430, 768, 834] as const);

export interface L2Run {
  readonly n: number;
  readonly scenario: string;
  readonly row: RowKey;
  readonly sport: string;
  readonly preset: string;
  readonly bound: string | null;
  readonly width: number;
  readonly covers: readonly ("row" | "sport")[];
}

export function planL2(input: { rules?: Readonly<Record<string, Rule>>; variants: readonly SportVariants[]; only?: readonly string[] }): {
  runs: L2Run[]; targets: { rowScenario: number; sportScenario: number }; perScenario: Record<string, number>;
} {
  const rules = input.rules ?? RULES;
  const runs: L2Run[] = [];
  const targets = { rowScenario: 0, sportScenario: 0 };
  const perScenario: Record<string, number> = {};
  for (const a of l2Atomic().filter((x) => input.only === undefined || input.only.includes(x.id))) {
    const r = rules[a.id]!;
    const memo = new Map<string, ReturnType<typeof decide>>();
    const app = (row: RowKey, s: string) => {
      const k = `${row}|${s}`;
      let d = memo.get(k);
      if (d === undefined) { d = decide(r, row, s, input.variants); memo.set(k, d); }
      return d;
    };
    const rows = ROW_KEYS.filter((row) => SPORT_KEYS.some((s) => app(row, s).applies));
    const sports = SPORT_KEYS.filter((s) => ROW_KEYS.some((row) => app(row, s).applies));
    targets.rowScenario += rows.length;
    targets.sportScenario += sports.length;
    const sportsLeft = new Set(sports);
    const push = (row: RowKey, s: string, covers: ("row" | "sport")[]) => {
      const d = app(row, s);
      const n = runs.length + 1;
      runs.push({ n, scenario: a.id, row, sport: s, preset: d.preset, bound: d.bound, width: L2_WIDTHS[(n - 1) % L2_WIDTHS.length]!, covers });
    };
    for (const row of rows) {
      const s = SPORT_KEYS.find((x) => sportsLeft.has(x) && app(row, x).applies) ?? SPORT_KEYS.find((x) => app(row, x).applies)!;
      push(row, s, sportsLeft.delete(s) ? ["row", "sport"] : ["row"]);
    }
    for (const s of SPORT_KEYS.filter((x) => sportsLeft.has(x))) push(ROW_KEYS.find((row) => app(row, s).applies)!, s, ["sport"]);
    perScenario[a.id] = runs.filter((x) => x.scenario === a.id).length;
  }
  return { runs, targets, perScenario };
}
```

- [ ] **Step 4: Run and see it pass** — same command. Expected: green, `files` = 1. Report `runs.length` and the two target counts.

- [ ] **Step 5: Mutation check**

- Width index `n % 7` (off by one) → killed by "widths rotate … n is 1..runs"? It is not, because the rotation stays balanced. Name the killer: Task 8 drift (the committed widths). Record it as a survivor here.
- Skip the leftover-sports loop → killed by "every … (sport, scenario) pair is covered".
- Pick `rows` without the applicability filter → killed by "every applicable … run" (`decide(...).applies` false).
- `perScenario` counted before pushing → killed by "every L2 scenario has at least one run".

- [ ] **Step 6: Scoped tsc + eslint** on `scripts/matrix/lib/pairs.ts`.

- [ ] **Step 7: Commit** — `feat(matrix): the L2 pair cover — every applicable (row, scenario) and (sport, scenario) once, widths rotating`.

---

## Task 8: `gen-catalogue.ts`, the five committed files, the §6.2 counts and the drift gate

This task writes the reviewed files that later waves measure against:
- `variants.json`
- `drop-list.json` (grouped by scenario and reason, cells by row)
- `floors.json` (per row and per scenario; never lowered silently)
- `l2-pairs.json`
- `counts.json` (the §6.2 formulas with their values)

A drift test in the existing strict CI matrix step reds on any byte difference (Review Focus 1).

**Files:**
- Create: `scripts/matrix/lib/counts.ts`, `scripts/matrix/gen-catalogue.ts`, `scripts/matrix/catalogue/{variants,drop-list,floors,l2-pairs,counts}.json` (generated)
- Modify: `package.json` (`"matrix:catalogue": "node --experimental-strip-types scripts/matrix/gen-catalogue.ts"`)
- Test: `scripts/matrix/__tests__/committed-catalogue.test.ts` (new); add `gen-catalogue.ts` and `lib/counts.ts` to `strip-types-loadable.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–7; `loadRegressions`; `expectedGate` via `cellFacts(row, "generic").gate`.
- Produces:
  - `CATALOGUE_DIR = "scripts/matrix/catalogue"`
  - `GENERATED = ["variants.json","drop-list.json","floors.json","l2-pairs.json","counts.json"] as const`
  - `generateCatalogue(repoRoot: string): Record<(typeof GENERATED)[number], string>`
  - `interface Floors { schemaVersion: 1; perRow: Record<string, number>; perScenarioL3: Record<string, number>; perScenarioL2: Record<string, number> }`
  - `lowered(prev: Floors, next: Floors): string[]`, `zeros(next: Floors): string[]`
  - `interface Counts` (below)
  - `computeCounts(...)`
  - CLI exit codes: 0 ok, 1 drift, 2 refused (a floor lowered without `--accept-lower-floors`, or a zero floor)

§6.2 formulas, written into `counts.json` verbatim:
- **L1** = cells × 2 widths (1280, 320) = 231 × 2 = 462.
- **L2** = the number of runs in `l2-pairs.json`. `pairTargets` = applicable (row, scenario) + (sport, scenario) pairs.
- **L3** = Σ over the 231 cells of (1 LIFECYCLE + applicable L3 atomic cases, variant-bound ones included) + variant cases (Q-B: LIFECYCLE each) + denied cases (one per gated row, generic) + regression cases.

- [ ] **Step 1: Write the failing test** (`scripts/matrix/__tests__/committed-catalogue.test.ts`)

```ts
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { CATALOGUE_DIR, GENERATED, generateCatalogue } from "../gen-catalogue.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fresh = generateCatalogue(REPO);

describe("committed catalogue files (R11, Review Focus 1)", () => {
  it("drift: every generated file equals its committed copy byte for byte", () => {
    let n = 0;
    for (const f of GENERATED) {
      expect(readFileSync(resolve(REPO, CATALOGUE_DIR, f), "utf8"), `${f} drifted — run: pnpm matrix:catalogue -- --write, and review the diff`).toBe(fresh[f]);
      n++;
    }
    expect(n).toBe(5);
  });
  it("deterministic: a second generation in the same process is identical", () => {
    expect(generateCatalogue(REPO)).toEqual(fresh);
  });
  it("no clock and no randomness in any generator module (trap 5)", () => {
    const mods = ["lib/scenario-catalogue.ts", "lib/variants.ts", "lib/applicability.ts", "lib/format-gates-copy.ts", "lib/pairs.ts", "lib/counts.ts", "gen-catalogue.ts"];
    for (const m of mods) {
      const src = readFileSync(resolve(REPO, "scripts/matrix", m), "utf8").replace(/\/\/[^\n]*/g, "");
      expect(src, m).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now|crypto\.\w*random/i);
    }
  });
  it("floors: every row and every scenario has a floor above zero", () => {
    const floors = JSON.parse(fresh["floors.json"]) as { perRow: Record<string, number>; perScenarioL3: Record<string, number>; perScenarioL2: Record<string, number> };
    expect(Object.keys(floors.perRow)).toEqual([...ROW_KEYS]);
    for (const [k, v] of [...Object.entries(floors.perRow), ...Object.entries(floors.perScenarioL3), ...Object.entries(floors.perScenarioL2)]) expect(v, k).toBeGreaterThan(0);
  });
  it("registry order, never sorted: variants by SPORT_KEYS, drop cells by ROW_KEYS then SPORT_KEYS", () => {
    const v = JSON.parse(fresh["variants.json"]) as { sports: { sport: string }[] };
    expect(v.sports.map((s) => s.sport)).toEqual([...SPORT_KEYS]);
    const d = JSON.parse(fresh["drop-list.json"]) as { groups: { cells: Record<string, string[]> }[] };
    for (const g of d.groups) {
      const rows = Object.keys(g.cells);
      expect(rows).toEqual(ROW_KEYS.filter((r) => rows.includes(r)));
      for (const r of rows) expect(g.cells[r]).toEqual(SPORT_KEYS.filter((s) => g.cells[r]!.includes(s)));
    }
  });
  it("counts: L1 = cells × 2; L2 = the pair file's runs; L3 = the sum of its declared parts", () => {
    const c = JSON.parse(fresh["counts.json"]) as { grid: { cells: number }; l1: { value: number }; l2: { value: number }; l3: { lifecycle: number; atomicApplicable: number; variantCases: number; denied: number; regressions: number; value: number } };
    const l2 = JSON.parse(fresh["l2-pairs.json"]) as { runs: unknown[] };
    expect(c.grid.cells).toBe(ROW_KEYS.length * SPORT_KEYS.length);
    expect(c.l1.value).toBe(c.grid.cells * 2);
    expect(c.l2.value).toBe(l2.runs.length);
    expect(c.l3.value).toBe(c.l3.lifecycle + c.l3.atomicApplicable + c.l3.variantCases + c.l3.denied + c.l3.regressions);
    expect(c.l3.lifecycle).toBe(c.grid.cells);
    expect(c.l3.denied).toBeGreaterThan(0);
  });
});

describe("gen-catalogue CLI", () => {
  const cli = (args: string[], root: string) =>
    spawnSync(process.execPath, ["--experimental-strip-types", resolve(REPO, "scripts/matrix/gen-catalogue.ts"), ...args, "--root", root], { encoding: "utf8", timeout: 120_000 });
  const copy = () => {
    const root = mkdtempSync(join(tmpdir(), "w1b-cat-"));
    mkdirSync(join(root, CATALOGUE_DIR), { recursive: true });
    cpSync(resolve(REPO, CATALOGUE_DIR), join(root, CATALOGUE_DIR), { recursive: true });
    return root;
  };
  it("--check on the repo exits 0", () => {
    const r = cli(["--check"], REPO);
    expect(r.status, r.stderr).toBe(0);
  });
  it("--check exits 1 and names the file when a committed file was hand-edited", () => {
    const root = copy();
    try {
      const p = join(root, CATALOGUE_DIR, "variants.json");
      writeFileSync(p, readFileSync(p, "utf8").replace('"schemaVersion": 1', '"schemaVersion": 1 '));
      const r = cli(["--check"], root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("variants.json");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("--write refuses (exit 2) to lower a committed floor without --accept-lower-floors, naming the row", () => {
    const root = copy();
    try {
      const p = join(root, CATALOGUE_DIR, "floors.json");
      const f = JSON.parse(readFileSync(p, "utf8")) as { perRow: Record<string, number> };
      f.perRow.league = f.perRow.league! + 1000;
      writeFileSync(p, `${JSON.stringify(f, null, 2)}\n`);
      const r = cli(["--write"], root);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/league: \d+ → \d+/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

`--root` only redirects where the committed files are read and written, and where `regressions.json` is read from. The generators themselves always read the product and engine sources through their imports.

- [ ] **Step 2: Run and watch it fail** — use the template with `<N>`=8 and `<files>` = `scripts/matrix/__tests__/committed-catalogue.test.ts`. Expected: FAILS TO COLLECT.

- [ ] **Step 3: Implement**

`scripts/matrix/lib/counts.ts`:

```ts
// Design §6.2's layer sizes, derived from the committed files (W1b owes the
// formulas and the real numbers). Pure.
import { ROW_KEYS, SPORT_KEYS } from "./catalogue.ts";
import { cellFacts, scenarioCounts, type Drop, type PlannedCase } from "./applicability.ts";
import { ATOMIC, PARENTS, l2Atomic, l3Atomic, type RegressionCase } from "./scenario-catalogue.ts";
import type { L2Run } from "./pairs.ts";
import type { SportVariants } from "./variants.ts";

export interface Counts {
  schemaVersion: 1;
  grid: { rows: number; sports: number; cells: number };
  catalogue: { parents: number; atomic: number; atomicL3: number; atomicL2: number };
  l1: { formula: string; value: number };
  l2: { formula: string; value: number; pairTargets: number };
  l3: { formula: string; lifecycle: number; atomicApplicable: number; bound: number; variantCases: number; denied: number; regressions: number; value: number };
  drops: { total: number; byScenario: Record<string, number> };
  variants: { perSport: Record<string, number>; uncoverablePairs: number; unscorable: number };
}

export function computeCounts(input: {
  l3: { cases: readonly PlannedCase[]; drops: readonly Drop[] };
  l2: { runs: readonly L2Run[]; targets: { rowScenario: number; sportScenario: number } };
  variants: readonly SportVariants[];
  regressions: readonly RegressionCase[];
}): Counts {
  const cells = ROW_KEYS.length * SPORT_KEYS.length;
  const lifecycle = input.l3.cases.filter((c) => c.scenario === "LIFECYCLE").length;
  const atomicApplicable = input.l3.cases.length - lifecycle;
  const variantCases = input.variants.reduce((n, v) => n + v.cases.length, 0);
  const denied = ROW_KEYS.filter((r) => cellFacts(r, "generic").gate !== null).length;
  return {
    schemaVersion: 1,
    grid: { rows: ROW_KEYS.length, sports: SPORT_KEYS.length, cells },
    catalogue: { parents: PARENTS.length, atomic: ATOMIC.length, atomicL3: l3Atomic().length, atomicL2: l2Atomic().length },
    l1: { formula: "cells × 2 widths (1280, 320)", value: cells * 2 },
    l2: { formula: "runs in l2-pairs.json (≥ applicable (row, scenario) pairs)", value: input.l2.runs.length, pairTargets: input.l2.targets.rowScenario + input.l2.targets.sportScenario },
    l3: {
      formula: "Σ cells (1 LIFECYCLE + applicable L3 atomic, variant-bound included) + variant cases (LIFECYCLE each) + denied cases (one per gated row) + regression cases",
      lifecycle, atomicApplicable, bound: input.l3.cases.filter((c) => c.bound !== null).length,
      variantCases, denied, regressions: input.regressions.length,
      value: lifecycle + atomicApplicable + variantCases + denied + input.regressions.length,
    },
    drops: { total: input.l3.drops.length, byScenario: scenarioCounts(input.l3.drops) },
    variants: {
      perSport: Object.fromEntries(input.variants.map((v) => [v.sport, v.cases.length])),
      uncoverablePairs: input.variants.reduce((n, v) => n + v.uncoverable.length, 0),
      unscorable: input.variants.reduce((n, v) => n + v.cases.filter((c) => c.scorable !== null).length, 0),
    },
  };
}
```

`scripts/matrix/gen-catalogue.ts`:

```ts
// Writes or checks the committed W1b catalogue files (R11: regenerating is a
// reviewed diff). Default --check: exit 1 on drift, naming the file. --write
// refuses (exit 2) to lower a committed floor unless --accept-lower-floors,
// and always refuses a zero floor (trap 1).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ROW_KEYS, SPORT_KEYS } from "./lib/catalogue.ts";
import { planL3, rowCounts, scenarioCounts } from "./lib/applicability.ts";
import { computeCounts } from "./lib/counts.ts";
import { planL2 } from "./lib/pairs.ts";
import { ATOMIC, LIFECYCLE_ID, l2Atomic, l3Atomic, loadRegressions } from "./lib/scenario-catalogue.ts";
import { buildSportVariants } from "./lib/variants.ts";

export const CATALOGUE_DIR = "scripts/matrix/catalogue";
export const GENERATED = ["variants.json", "drop-list.json", "floors.json", "l2-pairs.json", "counts.json"] as const;
export type Generated = (typeof GENERATED)[number];
export interface Floors { schemaVersion: 1; perRow: Record<string, number>; perScenarioL3: Record<string, number>; perScenarioL2: Record<string, number> }

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const GEN = "scripts/matrix/gen-catalogue.ts";

export function generateCatalogue(repoRoot: string): Record<Generated, string> {
  const variants = SPORT_KEYS.map((s) => buildSportVariants(s));
  const l3 = planL3({ variants });
  const l2 = planL2({ variants });
  const regressions = loadRegressions(repoRoot);
  const order = [LIFECYCLE_ID, ...ATOMIC.map((a) => a.id)];
  const groups = new Map<string, { scenario: string; reason: string; cells: Record<string, string[]> }>();
  for (const d of l3.drops) {
    const k = `${d.scenario}\u0000${d.reason}`;
    const g = groups.get(k) ?? { scenario: d.scenario, reason: d.reason, cells: {} };
    (g.cells[d.row] ??= []).push(d.sport);
    groups.set(k, g);
  }
  const dropGroups = [...groups.values()]
    .sort((a, b) => order.indexOf(a.scenario) - order.indexOf(b.scenario) || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0))
    .map((g) => ({ ...g, count: Object.values(g.cells).reduce((n, s) => n + s.length, 0) }));
  const s3 = scenarioCounts(l3.cases);
  const floors: Floors = {
    schemaVersion: 1,
    perRow: Object.fromEntries(ROW_KEYS.map((r) => [r, rowCounts(l3.cases)[r] ?? 0])),
    perScenarioL3: Object.fromEntries([LIFECYCLE_ID, ...l3Atomic().map((a) => a.id)].map((id) => [id, s3[id] ?? 0])),
    perScenarioL2: Object.fromEntries(l2Atomic().map((a) => [a.id, l2.perScenario[a.id] ?? 0])),
  };
  return {
    "variants.json": json({ schemaVersion: 1, generatedBy: GEN, sports: variants }),
    "drop-list.json": json({ schemaVersion: 1, generatedBy: GEN, basis: "builder-default variant per sport, derived offline; variant-dependent scenarios bound to variants.json first", total: l3.drops.length, groups: dropGroups }),
    "floors.json": json(floors),
    "l2-pairs.json": json({ schemaVersion: 1, generatedBy: GEN, widths: [320, 360, 375, 390, 430, 768, 834], targets: l2.targets, runs: l2.runs }),
    "counts.json": json(computeCounts({ l3, l2, variants, regressions })),
  };
}

export const lowered = (prev: Floors, next: Floors): string[] =>
  (["perRow", "perScenarioL3", "perScenarioL2"] as const).flatMap((k) =>
    Object.entries(prev[k]).filter(([id, v]) => (next[k][id] ?? 0) < v).map(([id, v]) => `${id}: ${v} → ${next[k][id] ?? 0}`));
export const zeros = (next: Floors): string[] =>
  (["perRow", "perScenarioL3", "perScenarioL2"] as const).flatMap((k) => Object.entries(next[k]).filter(([, v]) => v <= 0).map(([id]) => `${k}.${id}`));

export function main(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { write: { type: "boolean" }, check: { type: "boolean" }, "accept-lower-floors": { type: "boolean" }, root: { type: "string" } } });
  const root = values.root ?? process.cwd();
  const out = generateCatalogue(root);
  const path = (f: Generated) => resolve(root, CATALOGUE_DIR, f);
  const read = (f: Generated): string | null => { try { return readFileSync(path(f), "utf8"); } catch { return null; } };
  if (values.write === true) {
    const next = JSON.parse(out["floors.json"]) as Floors;
    const z = zeros(next);
    if (z.length > 0) { process.stderr.write(`gen-catalogue: refusing — zero floor(s): ${z.join(", ")}\n`); return 2; }
    const prevText = read("floors.json");
    if (prevText !== null && values["accept-lower-floors"] !== true) {
      const low = lowered(JSON.parse(prevText) as Floors, next);
      if (low.length > 0) { process.stderr.write(`gen-catalogue: refusing to lower floors without --accept-lower-floors:\n  ${low.join("\n  ")}\n`); return 2; }
    }
    for (const f of GENERATED) writeFileSync(path(f), out[f]);
    process.stdout.write(`gen-catalogue: wrote ${GENERATED.length} files\n`);
    return 0;
  }
  for (const f of GENERATED) {
    if (read(f) !== out[f]) { process.stderr.write(`gen-catalogue: ${f} differs from the generator — run with --write and review the diff\n`); return 1; }
  }
  process.stdout.write(`gen-catalogue: ${GENERATED.length} files match\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
```

Add `"matrix:catalogue": "node --experimental-strip-types scripts/matrix/gen-catalogue.ts"` to the root `package.json` `scripts`.

- [ ] **Step 4: Generate the committed files and review them**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && node --experimental-strip-types scripts/matrix/gen-catalogue.ts --write; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && node -e 'const c=require("./scripts/matrix/catalogue/counts.json");console.log(JSON.stringify({l1:c.l1.value,l2:c.l2.value,l3:c.l3,drops:c.drops.total,catalogue:c.catalogue,variants:c.variants}))'
```

Expected: EXIT=0, followed by one JSON line. Review `drop-list.json` by hand (R11, "show it"):
- Every group's reason must read true for every cell listed in it.
- Open three groups at random and check one cell each against `cellFacts`.
- Paste the group count and the three spot checks into the report.

- [ ] **Step 5: Run and see it pass** — use the template with `<files>` = `scripts/matrix/__tests__/committed-catalogue.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts`. Expected: green, `files` = 2.

- [ ] **Step 6: Mutation check**

- Hand-edit one `reason` in `drop-list.json` → killed by "drift".
- `L1 = cells × 1` → killed by "counts".
- Remove the `zeros` refusal, then set a scenario's rule to `() => false` and run `--write` against a temp copy → a floor of 0 is written. Killed by "floors: every … above zero" once the file is committed. Also run it by hand with the refusal present: exit 2.
- `lowered` returns `[]` → killed by the CLI "--write refuses".
- A `Math.random()` added to `pairs.ts` inside a comment-free expression → killed by "no clock and no randomness".

- [ ] **Step 7: Scoped tsc + eslint** on `scripts/matrix/lib/counts.ts scripts/matrix/gen-catalogue.ts`.

- [ ] **Step 8: Commit** — `feat(matrix): committed W1b catalogue — variants, drop list, floors, L2 pairs and §6.2 counts, with a drift gate`. The body carries the counts JSON line, and states that `drop-list.json` was reviewed with the three spot checks.

---
## Task 9: The denied state (⛔) — an entitlement-override deny, a mandated refusal, the PUT hypothesis

Ruling 24 fixes the mechanism: the denied state comes from an `org_entitlement_overrides` deny, not from a plan downgrade. Two gates are involved: `formats.double_elim` and `formats.advanced`. Seven rows hit one of them (false premise 7). The gate check is sport-independent (`format-gates.ts`), so each gated row gets one denied case, on generic.

This is not the override deny that `scripts/bench/lib/dls-gate.ts:28-38` rejected. That one staged a paywall no customer can hit. Both of these gates are sold (Pro), so a Community org meets this exact 402 in the product.

The scenario asserts three things:
- the refusal is named: 402 `PAYMENT_REQUIRED` carrying the expected `feature_key`;
- nothing was created;
- a PUT that replaces the stages with a gated body keeps the stages that were already there.

The third item tests false premise 8's hypothesis. `replaceStages` deletes the stages (`stages.ts:543`) before `createStages` gates (`:373-382`). If the live run reds that item, the red is a finding routed to W9. It is not a harness bug and not a product change here.

**Files:**
- Modify: `scripts/matrix/lib/results.ts` (`DecideInput.mandated`)
- Modify: `scripts/matrix/lib/driver/types.ts` (`RefusedCall.featureKey`, `StagesProbe`, `OrganiserDriver.replaceStagesProbe`)
- Modify: `scripts/matrix/lib/driver/http-driver.ts` (capture `feature_key`; `replaceStagesProbe`)
- Modify: `scripts/matrix/lib/seed-org.ts` (`MatrixSql.denyFeature`, the gate, `matrixSqlOver`, `prepareCaseOrg` input `deny`)
- Create: `scripts/matrix/lib/scenarios/denied.ts`
- Modify: `scripts/matrix/lib/scenarios/types.ts` (`ScenarioKey` gains `"DENIED"`; `Scenario.mandatedRefusal?`, `Scenario.evaluatesInvariants?`; `CaseSpec.deny?`), `scripts/matrix/lib/scenarios/index.ts`
- Modify: `scripts/matrix/lib/slice.ts` (`SliceScenarioKey`; the `SCENARIO_KEYS`/`CANARY_CHECK` retype and its three casts — R-PF5)
- Modify: `scripts/matrix/run.ts` (`runCase` passes `deny`, honours `evaluatesInvariants` and `mandatedRefusal`; `RunDeps.prepareCaseOrg` input gains `deny?`; `realDeps` forwards it)
- Modify: `scripts/matrix/__tests__/fake-driver.ts` (`FakeDeniedDriver`)
- Test: `results.test.ts`, `http-driver.test.ts`, `seed-org.test.ts`, `run-cli.test.ts` (extend); `scripts/matrix/__tests__/denied.test.ts` (new)

**Interfaces:**
- Consumes: `expectedGate`, `FormatGate` (Task 6); `stagesForRow` (Task 3); `isNamedRefusal` (observed.ts).
- Produces:
  - `DecideInput.mandated?: string | null`: when non-null and every applied check passed over at least one item, the state is `refused`.
  - `RefusedCall.featureKey: string | null`, as a 6th constructor parameter that defaults to `null`.
  - `interface StagesProbe { status: number; code: string | null; featureKey: string | null }`
  - `OrganiserDriver.replaceStagesProbe(divisionId: string, stages: readonly StagePostBody[]): Promise<StagesProbe>`, which never throws on 4xx.
  - `MatrixSql.denyFeature(input: { orgId: string; featureKey: string; reason: string }): Promise<void>`
  - `prepareCaseOrg(deps, input: { name; slug; deny?: readonly string[] })`
  - `Scenario.mandatedRefusal?: (spec: CaseSpec) => string`
  - `Scenario.evaluatesInvariants?: boolean` (defaults to true)
  - `CaseSpec.deny?: readonly string[]`
  - `denied: Scenario` (key `"DENIED"`, entrantCount 0, canaryCheck null)
  - `DENIED_CHECKS = ["denied-refused-named", "denied-nothing-created", "denied-put-keeps-stages"] as const`

- [ ] **Step 1: Write the failing tests**

`results.test.ts`, appended:

```ts
describe("decideState — mandated refusal (⛔, Task 9)", () => {
  const pass = (id: string, checked = 1): CheckResult => ({ id, kind: "assertion", verdict: "pass", checked, reason: "", evidence: [] });
  it("empty case first: a mandated refusal with no checks is still vacuous red, never ⛔", () => {
    expect(decideState({ checks: [], deferred: null, error: null, mandated: "denied: formats.double_elim" }).state).toBe("red");
  });
  it("all checks pass → refused, carrying the mandate as the reason", () => {
    expect(decideState({ checks: [pass("a")], deferred: null, error: null, mandated: "denied: formats.double_elim" })).toEqual({ state: "refused", reason: "denied: formats.double_elim" });
  });
  it("a failed check beats the mandate: red", () => {
    const failed: CheckResult = { ...pass("b"), verdict: "fail", reason: "stages deleted" };
    expect(decideState({ checks: [pass("a"), failed], deferred: null, error: null, mandated: "x" }).state).toBe("red");
  });
  it("a zero-item applied check beats the mandate: vacuous red", () => {
    expect(decideState({ checks: [pass("a", 0)], deferred: null, error: null, mandated: "x" }).state).toBe("red");
  });
  it("no mandate: unchanged — works", () => {
    expect(decideState({ checks: [pass("a")], deferred: null, error: null }).state).toBe("works");
    expect(decideState({ checks: [pass("a")], deferred: null, error: null, mandated: null }).state).toBe("works");
  });
});
```

`http-driver.test.ts`, appended (this uses the file's `fake`, `ok`, `err` and `drv`):

```ts
describe("HttpDriver — denied stages (Task 9)", () => {
  const body = [{ seq: 1, kind: "double_elim", config: {}, progression: null }] as never;
  it("postStages on a 402 throws a RefusedCall carrying feature_key", async () => {
    const { t } = fake([(c) => (c.method === "POST" ? err(402, "PAYMENT_REQUIRED", { feature_key: "formats.double_elim" }) : undefined)]);
    const e = await drv(t).postStages("d1", body).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RefusedCall);
    expect((e as RefusedCall).status).toBe(402);
    expect((e as RefusedCall).code).toBe("PAYMENT_REQUIRED");
    expect((e as RefusedCall).featureKey).toBe("formats.double_elim");
  });
  it("a refusal without feature_key carries null (empty case)", async () => {
    const { t } = fake([() => err(422, "INVALID_STAGE")]);
    const e = await drv(t).postStages("d1", body).catch((x: unknown) => x);
    expect((e as RefusedCall).featureKey).toBeNull();
  });
  it("replaceStagesProbe PUTs the body and returns the refusal without throwing", async () => {
    const { t, calls } = fake([(c) => (c.method === "PUT" ? err(402, "PAYMENT_REQUIRED", { feature_key: "formats.advanced" }) : undefined)]);
    expect(await drv(t).replaceStagesProbe("d1", body)).toEqual({ status: 402, code: "PAYMENT_REQUIRED", featureKey: "formats.advanced" });
    expect(calls).toMatchObject([{ path: "/api/v1/divisions/d1/stages", method: "PUT", body }]);
  });
  it("replaceStagesProbe on 2xx returns status with null code and key", async () => {
    const { t } = fake([() => ok([{ id: "s1" }])]);
    expect(await drv(t).replaceStagesProbe("d1", body)).toEqual({ status: 200, code: null, featureKey: null });
  });
});
```

`seed-org.test.ts` needs three changes:
- Add `async denyFeature() { calls.push("denyFeature"); }` to `recording().inner`.
- Add `() => sql.denyFeature({ orgId: "o1", featureKey: "formats.advanced", reason: "r" })` to `everyMethod`.
- Append:

```ts
describe("denyFeature (ruling 24) — gated, upserted, read back", () => {
  const DENY_ROWS = (text: string): unknown[] =>
    text.startsWith("select bool_value") ? [{ bool_value: false, expires_at: null }] : [];
  it("a foreign data_directory refuses it and runs nothing but the one probe", async () => {
    const { db, seen } = fakeClient("/usr/local/var/postgres");
    await expect(matrixSqlOver(db, "/tmp/pg-fm").denyFeature({ orgId: "o1", featureKey: "formats.double_elim", reason: "matrix denied" })).rejects.toBeInstanceOf(DataDirMismatch);
    expect(seen).toEqual([PROBE]);
  });
  it("one transaction: re-prove, upsert false with no expiry, read back", async () => {
    const { db, seen } = fakeClient("/tmp/pg-fm", DENY_ROWS);
    await matrixSqlOver(db, "/tmp/pg-fm").denyFeature({ orgId: "o1", featureKey: "formats.double_elim", reason: "matrix denied" });
    expect(shape(seen)).toEqual(["db show data_directory", "BEGIN", "tx show data_directory", "tx insert into org_entitlement_overrides", "tx select bool_value, expires_at from org_entitlement_overrides where org_id = $ and feature_key = $", "COMMIT"]);
    const ins = seen.filter((s): s is Stmt => typeof s !== "string")[2]!;
    expect(ins.values).toEqual(["o1", "formats.double_elim", "matrix denied"]);
    expect(ins.text).toMatch(/values \(\$, \$, false, \$\) on conflict \(org_id, feature_key\) do update set bool_value = false, int_value = null, reason = excluded\.reason, expires_at = null$/);
  });
  it("a read-back that is not a live false refuses (and rolls back)", async () => {
    for (const row of [[], [{ bool_value: true, expires_at: null }], [{ bool_value: false, expires_at: "2030-01-01T00:00:00Z" }]]) {
      const { db, seen } = fakeClient("/tmp/pg-fm", (t) => (t.startsWith("select bool_value") ? row : []));
      await expect(matrixSqlOver(db, "/tmp/pg-fm").denyFeature({ orgId: "o1", featureKey: "formats.advanced", reason: "r" })).rejects.toThrow(/deny did not hold/);
      expect(seen.at(-1)).toBe("ROLLBACK");
    }
  });
});
```

In the existing `describe("prepareCaseOrg")` block (`seed-org.test.ts:274`):
- Add `async denyFeature(i) { order.push(`deny ${i.orgId} ${i.featureKey}`); },` to its `fakeSql`.
- Append:

```ts
  it("denies AFTER provisioning, each key once, in order; no deny → no deny call (ruling 24)", async () => {
    const order: string[] = [];
    const t: Transport = { async raw(_b, s, path, method = "GET", body) { order.push(`${method} ${path}`); s.cookies[PRODUCT_ORG_COOKIE] = (body as { org_id: string }).org_id; return okData({ ok: true }); } };
    const deps = { sql: fakeSql(order), transport: t, base: "http://localhost:1", session: fresh(), userId: "u1", plan: "pro", provision: async (o: string, p: string) => { order.push(`provision ${o} ${p}`); } };
    await prepareCaseOrg(deps, { name: "Matrix 1", slug: "m-r-1", deny: ["formats.double_elim", "formats.advanced"] });
    expect(order).toEqual(["insert u1 Matrix 1 m-r-1", "POST /api/orgs/active", "provision o9 pro", "deny o9 formats.double_elim", "deny o9 formats.advanced"]);
    order.length = 0;
    await prepareCaseOrg({ ...deps, session: fresh() }, { name: "Matrix 1", slug: "m-r-1" });
    expect(order.some((l) => l.startsWith("deny"))).toBe(false);
  });
```

`scripts/matrix/__tests__/denied.test.ts` (new):

```ts
import { describe, expect, it } from "vitest";
import { ROW_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { expectedGate } from "../lib/format-gates-copy.ts";
import { DENIED_CHECKS, denied } from "../lib/scenarios/denied.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { FakeDeniedDriver } from "./fake-driver.ts";

const GATED = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) !== null);
const spec = (row: string): CaseSpec => ({ caseId: `${row}|generic|score|DENIED`, row: row as never, sport: "generic", variant: "score", scenario: "DENIED", canary: false, deny: [expectedGate(stagesForRow(row))!] });
const ctx = (row: string, driver: FakeDeniedDriver) => ({ driver, spec: spec(row), orgSlug: "o", cfg: null, tag: "t" });
// The fake's deny table is written here, from format-gates.ts's text — never from expectedGate.
const DENY = new Map([["double_elim", "formats.double_elim"], ["page_playoff", "formats.double_elim"], ["americano", "formats.advanced"], ["ladder", "formats.advanced"]]);

describe("DENIED scenario", () => {
  it("sweeps the seven gated rows (false premise 7); the count is pinned", () => {
    expect(GATED.length).toBe(7);
  });
  it("gate-first product: all three checks pass on every gated row, each over ≥1 item", async () => {
    let n = 0;
    for (const row of GATED) {
      const out = await denied.run(ctx(row, new FakeDeniedDriver(DENY, { deleteFirst: false })));
      expect(out.assertions.map((a) => a.id)).toEqual([...DENIED_CHECKS]);
      for (const a of out.assertions) { expect(a.verdict, `${row} ${a.id}: ${a.reason}`).toBe("pass"); expect(a.checked).toBeGreaterThan(0); }
      n++;
    }
    expect(n).toBe(7);
  });
  it("delete-first product (today's replaceStages, stages.ts:543 before :373): denied-put-keeps-stages fails, naming the lost stage", async () => {
    const out = await denied.run(ctx("double_elim", new FakeDeniedDriver(DENY, { deleteFirst: true })));
    const put = out.assertions.find((a) => a.id === "denied-put-keeps-stages")!;
    expect(put.verdict).toBe("fail");
    expect(put.evidence.join(" ")).toMatch(/league stage .* gone after the refused PUT/);
  });
  it("a product that does NOT refuse the gated row reds denied-refused-named (the witness the other way)", async () => {
    const out = await denied.run(ctx("double_elim", new FakeDeniedDriver(new Map(), { deleteFirst: false })));
    expect(out.assertions.find((a) => a.id === "denied-refused-named")!.verdict).toBe("fail");
  });
  it("a refusal naming the WRONG feature reds denied-refused-named", async () => {
    const wrong = new Map([...DENY].map(([k]) => [k, "formats.other"]));
    const out = await denied.run(ctx("double_elim", new FakeDeniedDriver(wrong, { deleteFirst: false })));
    const named = out.assertions.find((a) => a.id === "denied-refused-named")!;
    expect(named.verdict).toBe("fail");
    expect(named.evidence.join(" ")).toContain("formats.double_elim");
  });
  it("an ungated row is a misuse, refused by name before any call", async () => {
    const d = new FakeDeniedDriver(DENY, { deleteFirst: false });
    await expect(denied.run(ctx("league", d))).rejects.toThrow(/league is not a gated row/);
    expect(d.callCount).toBe(0);
  });
  it("declares a mandated refusal naming the gate, and opts out of the fixture invariants", () => {
    expect(denied.evaluatesInvariants).toBe(false);
    expect(denied.mandatedRefusal!(spec("ladder"))).toBe("denied: formats.advanced (ruling 24)");
  });
});
```

`run-cli.test.ts`, appended to "runSlice — a run":

```ts
  it("a DENIED case: deny keys reach prepareCaseOrg, invariants are skipped, the state is ⛔ refused", async () => {
    const dir = dirFor();
    const planCases = () => ({ sports: ["generic"], deniesFeatures: true, plan: (v: (s: string) => string) => [
      { caseId: "double_elim|generic|score|DENIED", row: "double_elim", sport: "generic", variant: v("generic"), scenario: "DENIED", canary: false, deny: ["formats.double_elim"] },
    ] as never });
    const d = deps({ planCases, driverFor: (_b, _s, orgId) => new FakeDeniedDriver(new Map([["double_elim", "formats.double_elim"]]), { deleteFirst: false }, orgId) });
    capture();
    expect(await runSlice(d, ["--run-id", "den", "--report-dir", dir])).toBe(0);
    expect(d.orgs[0]).toMatchObject({ deny: ["formats.double_elim"] });
    const [c] = resultsIn(dir, "den").cases;
    expect(c!.state).toBe("refused");
    expect(c!.checks.every((k) => k.kind === "assertion")).toBe(true);
  });
```

`deniesFeatures` is added to `CasePlanner` in Task 10. In this task, the property is extra and harmless: the literal is cast `as never` only at `plan`'s return, and the planner object itself is typed by `RunDeps.planCases`. If tsc rejects the extra property before Task 10, drop it here, and Task 10 Step 1 adds it back.

- [ ] **Step 2: Run and watch them fail** — use the template with `<N>`=9 and `<files>` = `scripts/matrix/__tests__/results.test.ts scripts/matrix/__tests__/http-driver.test.ts scripts/matrix/__tests__/seed-org.test.ts scripts/matrix/__tests__/denied.test.ts scripts/matrix/__tests__/run-cli.test.ts`. Expected:
  - denied.test.ts FAILS TO COLLECT;
  - results fails on `refused`;
  - http-driver fails on `featureKey` / `replaceStagesProbe is not a function`;
  - seed-org fails on `denyFeature`;
  - run-cli fails on the new case.

- [ ] **Step 3: Implement**

`results.ts`: add `mandated?: string | null;` to `DecideInput`. In `decideState`, insert one line after the `empty` check, just before the final `works` return:

```ts
  if (input.mandated != null) return { state: "refused", reason: input.mandated };
```

`driver/types.ts`:

```ts
export interface StagesProbe { status: number; code: string | null; featureKey: string | null }
```

- Add `replaceStagesProbe(divisionId: string, stages: readonly StagePostBody[]): Promise<StagesProbe>;` to `OrganiserDriver`, with the doc comment "A probe: PUT /divisions/:id/stages; returns the refusal, never throws on 4xx."
- `RefusedCall` gains `readonly featureKey: string | null;` and a 6th constructor parameter `featureKey: string | null = null`, assigned last. The message is unchanged.

`http-driver.ts`:
- `Envelope.error` object type gains `feature_key?: string`.
- `#unwrap` passes `e.feature_key ?? null` as the 6th argument.
- Add:

```ts
  async replaceStagesProbe(divisionId: string, stages: readonly StagePostBody[]): Promise<StagesProbe> {
    const r = await this.#send(`/api/v1/divisions/${divisionId}/stages`, "PUT", stages);
    if (is2xx(r)) return { status: r.status, code: null, featureKey: null };
    const e = errorOf(r);
    return { status: r.status, code: e.code ?? null, featureKey: e.feature_key ?? null };
  }
```

`errorOf`'s return type gains `feature_key?: string`.

`seed-org.ts`:
- `MatrixSql` gains `denyFeature(input: { orgId: string; featureKey: string; reason: string }): Promise<void>;`
- `gateOnOwnDataDir` gains `async denyFeature(input) { await proven(); return inner.denyFeature(input); },`
- `matrixSqlOver` gains:

```ts
    async denyFeature({ orgId, featureKey, reason }) {
      // Ruling 24: the denied state is an override deny (lib/entitlements.ts:
      // a live override wins over the plan). Upsert, then read back: an
      // expired or true row would let the gate through and the case would
      // read as an entitlement bug instead of the harness's own miss.
      await db.begin(async (tx) => {
        const [dir] = await tx<{ data_directory: string }[]>`show data_directory`;
        const actual = dir?.data_directory ?? "";
        if (actual !== expectedDataDir) throw new DataDirMismatch(expectedDataDir, actual);
        await tx`
          insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
          values (${orgId}, ${featureKey}, false, ${reason}) on conflict (org_id, feature_key) do update set bool_value = false, int_value = null, reason = excluded.reason, expires_at = null`;
        const [row] = await tx<{ bool_value: boolean | null; expires_at: string | null }[]>`
          select bool_value, expires_at from org_entitlement_overrides where org_id = ${orgId} and feature_key = ${featureKey}`;
        if (row?.bool_value !== false || row.expires_at !== null) throw new Error(`seed-org: deny did not hold for ${featureKey} (read back ${JSON.stringify(row ?? null)})`);
      });
    },
```

- `prepareCaseOrg` input type becomes `{ name: string; slug: string; deny?: readonly string[] }`. After `await deps.provision(org.orgId, deps.plan);` add:

```ts
  for (const featureKey of input.deny ?? []) await deps.sql.denyFeature({ orgId: org.orgId, featureKey, reason: "format-matrix denied state (ruling 24)" });
```

`scenarios/types.ts`:
- `ScenarioKey` = `"LIFECYCLE" | "M1" | "R4" | "F1" | "DENIED"`.
- `CaseSpec` gains `deny?: readonly string[]`.
- `Scenario` gains:

```ts
  /** ⛔: the case's expected state is `refused` (decideState's `mandated`). */
  mandatedRefusal?: (spec: CaseSpec) => string;
  /** false: the fixture invariants do not apply (no stage was ever built). Default true. */
  evaluatesInvariants?: boolean;
```

- `slice.ts`: `SCENARIO_KEYS` stays the four slice keys. Declare `type SliceScenarioKey = Exclude<ScenarioKey, "DENIED">`, type `SCENARIO_KEYS` as `readonly SliceScenarioKey[]` and `CANARY_CHECK` as `Readonly<Record<SliceScenarioKey, string | null>>`, so the slice plan cannot grow a DENIED case by accident. The retype breaks the casts that feed `includes` (pre-flight ruling R-PF5): an argument cast to the wider `ScenarioKey` is not assignable to the narrowed array's element type. So change them in this same task:
  - `slice.ts:18` — the `Object.fromEntries(…) as Record<ScenarioKey, …>` cast → `as Record<SliceScenarioKey, string | null>`;
  - `slice.ts:39` — `SCENARIO_KEYS.includes(filter.scenario as ScenarioKey)` → `as SliceScenarioKey`;
  - `slice.ts:46` — `withCanary.includes(scenario as ScenarioKey)` → `as SliceScenarioKey`, and the `return scenario as ScenarioKey` on the next line → `as SliceScenarioKey` (still assignable to `checkCanary`'s declared `ScenarioKey` return).

  Re-pin the three line numbers with `grep -an "as ScenarioKey" scripts/matrix/lib/slice.ts` before editing; after the edit that grep prints nothing. This task's scoped tsc must list `scripts/matrix/lib/slice.ts`.

`scripts/matrix/lib/scenarios/denied.ts`:

```ts
// ⛔ denied (ruling 24): the case org carries an org_entitlement_overrides
// deny for the row's gate. Three assertions: the refusal is named (402
// PAYMENT_REQUIRED + the gate's feature_key); nothing was created; and a PUT
// replacing working stages with the gated body keeps them (false premise 8:
// replaceStages deletes before createStages gates — a red here routes to W9).
import { stagesForRow } from "../catalogue.ts";
import { RefusedCall, type StagesProbe } from "../driver/types.ts";
import { expectedGate } from "../format-gates-copy.ts";
import { assertion } from "./assertions.ts";
import type { CaseSpec, Scenario, ScenarioContext, ScenarioOutput } from "./types.ts";

export const DENIED_CHECKS = ["denied-refused-named", "denied-nothing-created", "denied-put-keeps-stages"] as const;
const LEAGUE = [{ seq: 1, kind: "league", config: { legs: 1 }, progression: null }] as const;

const gateOf = (spec: CaseSpec): string => {
  const g = expectedGate(stagesForRow(spec.row));
  if (g === null) throw new Error(`denied: ${spec.row} is not a gated row — no denied case exists for it`);
  return g;
};

const namedItems = (what: string, got: { status: number; code: string | null; featureKey: string | null } | null, want: string) => [
  { ok: got?.status === 402, note: `${what}: status ${got?.status ?? "none (accepted)"}, want 402` },
  { ok: got?.code === "PAYMENT_REQUIRED", note: `${what}: code ${got?.code ?? "none"}, want PAYMENT_REQUIRED` },
  { ok: got?.featureKey === want, note: `${what}: feature_key ${got?.featureKey ?? "none"}, want ${want}` },
];

export const denied: Scenario = {
  key: "DENIED",
  entrantCount: 0,
  canaryCheck: null,
  evaluatesInvariants: false,
  mandatedRefusal: (spec) => `denied: ${gateOf(spec)} (ruling 24)`,
  async run(ctx: ScenarioContext): Promise<ScenarioOutput> {
    const want = gateOf(ctx.spec); // before any call
    const gated = stagesForRow(ctx.spec.row);
    const slug = `m-${ctx.tag.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.slice(0, 60).replace(/-+$/, "");
    const competition = await ctx.driver.createCompetition({ name: `Matrix ${ctx.spec.caseId}`, slug });
    const division = await ctx.driver.createDivision(competition.id, { name: "Matrix denied", slug: "d", sportKey: ctx.spec.sport, variantKey: ctx.spec.variant });
    let post: { status: number; code: string | null; featureKey: string | null } | null = null;
    try {
      await ctx.driver.postStages(division.id, gated);
    } catch (e) {
      if (!(e instanceof RefusedCall)) throw e;
      post = { status: e.status, code: e.code, featureKey: e.featureKey };
    }
    const after = await ctx.driver.listStages(division.id);
    // The PUT probe: a division with a working stage, replaced by the gated body.
    const second = await ctx.driver.createDivision(competition.id, { name: "Matrix denied put", slug: "d2", sportKey: ctx.spec.sport, variantKey: ctx.spec.variant });
    const kept = await ctx.driver.postStages(second.id, LEAGUE);
    const put: StagesProbe = await ctx.driver.replaceStagesProbe(second.id, gated);
    const afterPut = await ctx.driver.listStages(second.id);
    const assertions = [
      assertion("denied-refused-named", namedItems("POST stages", post, want)),
      assertion("denied-nothing-created", [{ ok: after.length === 0, note: `${after.length} stage(s) exist after the refused POST` }]),
      assertion("denied-put-keeps-stages", [
        ...namedItems("PUT stages", put.status >= 200 && put.status < 300 ? null : put, want),
        ...kept.map((s) => ({ ok: afterPut.some((x) => x.id === s.id && x.kind === s.kind), note: `league stage ${s.id} gone after the refused PUT` })),
      ]),
    ];
    return {
      observed: { caseId: ctx.spec.caseId, facts: [], stages: [], withdrawal: null, configEdit: null },
      assertions, events: 0, notes: [`gate ${want}: POST ${post?.status ?? "accepted"}, PUT ${put.status}, stages kept ${afterPut.length}/${kept.length}`],
    };
  },
};
```

Each `note` is the failure text: `assertion()` (`assertions.ts:25-30`) puts only the notes of failing items into `evidence`, and uses the first as `reason`.

`scenarios/index.ts`: add `DENIED: denied` to `SCENARIOS`.

`run.ts` `runCase`:
- Pass `deny: spec.deny` in the `prepareCaseOrg` input.
- Replace the checks line with:

```ts
    const scenario = SCENARIOS[spec.scenario];
    const out = await scenario.run({ driver, spec, orgSlug: org.orgSlug, cfg: resolveSportCfg(spec.sport, spec.variant), tag: `${run.runId}-${i + 1}` });
    checks = [...(scenario.evaluatesInvariants === false ? [] : evaluateInvariants(out.observed)), ...out.assertions].map(redactCheck);
    mandated = scenario.mandatedRefusal?.(spec) ?? null;
```

Declare `let mandated: string | null = null;` beside `deferred`, and pass `mandated` into `decideState`.

`RunDeps.prepareCaseOrg`'s input type becomes `{ name: string; slug: string; deny?: readonly string[] }`. `realDeps` already forwards `input` whole.

`fake-driver.ts`:

```ts
/** A product that gates stage kinds by feature (deny: kind → feature_key).
 *  deleteFirst mirrors today's replaceStages (stages.ts: delete, THEN gate). */
export class FakeDeniedDriver extends FakeLeagueDriver {
  readonly deny: ReadonlyMap<string, string>;
  readonly deleteFirst: boolean;
  readonly byDivision = new Map<string, StageRef[]>();
  #divisions = 0;
  constructor(deny: ReadonlyMap<string, string>, opts: { deleteFirst: boolean }, orgId = "org-fake") {
    super(orgId);
    this.deny = deny;
    this.deleteFirst = opts.deleteFirst;
  }
  override createDivision(c: string, i: { name: string; slug: string; sportKey: string; variantKey: string; config?: Record<string, unknown> }): Promise<DivisionRef> {
    return super.createDivision(c, i).then((d) => { const id = `d${++this.#divisions}`; this.byDivision.set(id, []); return { ...d, id }; });
  }
  #refusal(stages: readonly StagePostBody[]): RefusedCall | null {
    const hit = stages.find((s) => this.deny.has(s.kind));
    return hit === undefined ? null : new RefusedCall("POST", "/api/v1/divisions/d/stages", 402, "PAYMENT_REQUIRED", "upgrade", this.deny.get(hit.kind)!);
  }
  override postStages(d: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
    return settle(() => {
      this.log("postStages");
      const refused = this.#refusal(stages);
      if (refused !== null) throw refused;
      const made = stages.map((s, k) => ({ id: `${d}-s${k + 1}`, seq: s.seq, kind: s.kind, config: { ...s.config }, status: "pending" }));
      this.byDivision.set(d, made);
      return made.map((s) => ({ ...s }));
    });
  }
  override listStages(d: string): Promise<StageRef[]> { return settle(() => { this.log("listStages"); return (this.byDivision.get(d) ?? []).map((s) => ({ ...s })); }); }
  replaceStagesProbe(d: string, stages: readonly StagePostBody[]): Promise<StagesProbe> {
    return settle(() => {
      this.log("replaceStagesProbe");
      if (this.deleteFirst) this.byDivision.set(d, []);
      const refused = this.#refusal(stages);
      if (refused !== null) return { status: 402, code: "PAYMENT_REQUIRED", featureKey: refused.featureKey };
      this.byDivision.set(d, stages.map((s, k) => ({ id: `${d}-r${k + 1}`, seq: s.seq, kind: s.kind, config: { ...s.config }, status: "pending" })));
      return { status: 200, code: null, featureKey: null };
    });
  }
}
```

`FakeLeagueDriver` also needs `replaceStagesProbe`, because the interface demands it. It answers `{ status: 422, code: "UNSUPPORTED_IN_FAKE", featureKey: null }` and logs the call. `FakeLeagueDriver` has no `replaceStagesProbe` of its own to override, so `FakeDeniedDriver`'s method needs no `override` keyword. Adding the method to the base class does require one: in that case, mark the subclass method `override`.

- [ ] **Step 4: Run and see them pass** — same command as Step 2. Expected: green, `files` = 5.

- [ ] **Step 5: Mutation check**

- `decideState` without the `mandated` line → killed by "all checks pass → refused".
- `mandated` checked before the `failed` filter → killed by "a failed check beats the mandate".
- `#unwrap` drops `feature_key` → killed by "postStages on a 402…".
- `denyFeature` without the read-back → killed by "a read-back that is not a live false refuses".
- `prepareCaseOrg` denies before `provision` → killed by the order test.
- `gateOnOwnDataDir` without the `denyFeature` wrapper → killed by the gate sweep over `everyMethod`.
- `denied-put-keeps-stages` without the `kept.map` items → killed by "delete-first product".
- `runCase` ignores `evaluatesInvariants` → killed by "a DENIED case" (invariant checks appear).

- [ ] **Step 6: Scoped tsc + eslint** on every file under **Files:** except the tests.

- [ ] **Step 7: Commit** — `feat(matrix): the denied state — an override deny per gated row, a mandated ⛔, and the replace-stages probe`. Body: "denied-put-keeps-stages tests false premise 8's hypothesis. A live red there routes to W9."

---

## Task 10: The W1b probe set — API-only rows, the denied cases and two variant cases, live-runnable

This set is the smallest one that drives the new L3 paths against the real product:
- the single-stage API-only rows;
- all seven denied cases;
- one committed variant case each for generic and badminton, with the override on the wire.

Two refusals protect the evidence:
- A run whose planner denies features refuses when `REDIS_URL` is set. `lib/entitlements.ts` caches through `@/lib/cache`, which is a no-op without `REDIS_URL`; with Redis on, a cached allow can hide the SQL deny for its TTL (Review Focus 4).
- A run whose live builder default differs from the offline one refuses. The committed drop list assumes the offline default (Review Focus 5).

**Files:**
- Create: `scripts/matrix/lib/probe-set.ts`
- Modify:
  - `scripts/matrix/run.ts` (`--set`; the planner is chosen in `runSlice`; `CasePlanner.deniesFeatures`; the REDIS and builder-default guards; `runCase` resolves the cfg with `spec.overrides`)
  - `scripts/matrix/lib/scenarios/types.ts` (`CaseSpec.row: RowKey`, `CaseSpec.overrides?`)
  - `scripts/matrix/lib/scenarios/common.ts` (`setUpDivision` posts `config`; `BuiltReadback.posted.config`)
  - `scripts/matrix/lib/scenarios/assertions.ts` (`builtAsPosted` compares the overridden keys)
  - `scripts/matrix/__tests__/fake-driver.ts` (the cfg includes overrides)
- Test: `scripts/matrix/__tests__/probe-set.test.ts` (new); `run-cli.test.ts`, `scenarios.test.ts` (extend)

**Interfaces:**
- Consumes: `slicePlanner`, `PlanCases`, `CasePlanner` (Task 1); `stagesForRow`, `ROW_KEYS` (Task 3); `offlineBuilderDefault`, `VariantCase` (Task 5); `expectedGate` (Task 6); the committed `variants.json` (Task 8); `SLICE_ROWS` (slice.ts).
- Produces:
  - `PROBE_SET = "w1b-probe"`
  - `probePlanner: PlanCases`
  - `PROBE_API_ROWS`
  - `CasePlanner.deniesFeatures: boolean`
  - `class UnknownSet`
  - `class RedisHidesDeny`
  - `class BuilderDefaultDrift`
  - `CaseSpec.overrides?: Readonly<Record<string, unknown>>`
  - `BuiltReadback.posted.config: Readonly<Record<string, unknown>>`

- [ ] **Step 1: Write the failing tests**

`scripts/matrix/__tests__/probe-set.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_ONLY_ROWS, ROW_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { expectedGate } from "../lib/format-gates-copy.ts";
import { PROBE_API_ROWS, PROBE_SET, probePlanner } from "../lib/probe-set.ts";
import { SLICE_ROWS } from "../lib/slice.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const committed = JSON.parse(readFileSync(resolve(REPO, "scripts/matrix/catalogue/variants.json"), "utf8")) as { sports: { sport: string; cases: { id: string; row: string; preset: string; overrides: Record<string, unknown>; scorable: string | null }[] }[] };
const specs = probePlanner({ set: PROBE_SET }).plan(offlineBuilderDefault);

describe("the w1b-probe set", () => {
  it("names its set and needs the DB's variant order for generic and badminton only", () => {
    expect(PROBE_SET).toBe("w1b-probe");
    expect([...probePlanner({ set: PROBE_SET }).sports]).toEqual(["generic", "badminton"]);
    expect(probePlanner({ set: PROBE_SET }).deniesFeatures).toBe(true);
  });
  it("API-only LIFECYCLE: exactly the single-stage, ungated API-only rows, on generic (multi-stage stays deferred to W1-driving)", () => {
    // single-sport: the rows' shapes are sport-independent; generic is the cheapest sport to drive.
    const want = API_ONLY_ROWS.filter((r) => stagesForRow(r).length === 1 && expectedGate(stagesForRow(r)) === null);
    expect(want.length).toBeGreaterThan(0);
    expect([...PROBE_API_ROWS]).toEqual(want);
    const got = specs.filter((s) => s.scenario === "LIFECYCLE" && s.overrides === undefined);
    expect(got.map((s) => s.row)).toEqual(want);
    expect(got.every((s) => s.sport === "generic" && s.deny === undefined)).toBe(true);
  });
  it("DENIED: one case per gated row in registry order, each denying exactly its own gate", () => {
    const gated = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) !== null);
    const got = specs.filter((s) => s.scenario === "DENIED");
    expect(got.map((s) => s.row)).toEqual(gated);
    for (const s of got) expect(s.deny).toEqual([expectedGate(stagesForRow(s.row))]);
  });
  it("variant LIFECYCLE: per sport, the FIRST committed case with a non-empty override, scorable, on a slice row", () => {
    let n = 0;
    for (const sport of ["generic", "badminton"]) {
      const want = committed.sports.find((x) => x.sport === sport)!.cases.find((c) => Object.keys(c.overrides).length > 0 && c.scorable === null && (SLICE_ROWS as readonly string[]).includes(c.row));
      expect(want, `${sport}: no committed variant case qualifies`).toBeDefined();
      const got = specs.find((s) => s.sport === sport && s.overrides !== undefined)!;
      expect({ row: got.row, variant: got.variant, overrides: got.overrides }).toEqual({ row: want!.row, variant: want!.preset, overrides: want!.overrides });
      expect(got.caseId.endsWith(`|${want!.id}`)).toBe(true);
      n++;
    }
    expect(n).toBe(2);
  });
  it("case ids are unique; the whole set is the three parts and nothing else", () => {
    expect(new Set(specs.map((s) => s.caseId)).size).toBe(specs.length);
    expect(specs.length).toBe(PROBE_API_ROWS.length + 7 + 2);
  });
});
```

`run-cli.test.ts`, appended to "runSlice — refusals first":

```ts
  it("an unknown --set is refused before the DB", async () => {
    const d = deps(); capture();
    expect(await runSlice(d, ["--set", "nope"])).toBe(2);
    expect(d.order).toEqual([]);
  });
  it("--set with --only/--scenario/--canary is a usage refusal", async () => {
    capture();
    for (const extra of [["--only", "league|generic"], ["--scenario", "M1"], ["--canary", "M1"]]) expect(await runSlice(deps(), ["--set", "w1b-probe", ...extra])).toBe(2);
  });
  it("Review Focus 4: a planner that denies features refuses when REDIS_URL is set, naming it, before the DB", async () => {
    const d = deps({ env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999", REDIS_URL: "redis://localhost:6379" } });
    const { err } = capture();
    expect(await runSlice(d, ["--set", "w1b-probe"])).toBe(2);
    expect(err.join("")).toMatch(/REDIS_URL/);
    expect(d.order).toEqual([]);
  });
  it("…and the slice (which denies nothing) still runs with REDIS_URL set", async () => {
    const d = deps({ env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999", REDIS_URL: "redis://x" } });
    capture();
    expect(await runSlice(d, ["--run-id", "rs", "--report-dir", dirFor(), "--only", "league|generic", "--scenario", "LIFECYCLE"])).toBe(0);
  });
```

`run-cli.test.ts`, appended to "runSlice — a run":

```ts
  it("runCase resolves the case cfg WITH its overrides (the scenario scores under what the division stores)", async () => {
    const cfgs: unknown[] = [];
    wrapScenario("LIFECYCLE", (out) => out, (ctx) => { cfgs.push(ctx.cfg); return ctx; });
    const planCases = () => ({ sports: ["generic"], deniesFeatures: false, plan: (v: (s: string) => string) => [
      { caseId: "league|generic|score|LIFECYCLE|v", row: "league", sport: "generic", variant: v("generic"), scenario: "LIFECYCLE", canary: false, overrides: { allowDraws: false } },
    ] as never });
    capture();
    await runSlice(deps({ planCases }), ["--run-id", "ov", "--report-dir", dirFor()]);
    expect(cfgs.length).toBe(1);
    expect((cfgs[0] as { allowDraws?: unknown }).allowDraws).toBe(false);
  });
```

`run-cli.test.ts`, appended to "runSlice — aborts after the start gates":

```ts
  it("Review Focus 5: a live builder default that differs from the offline one refuses (exit 2) naming both keys, before any case", async () => {
    const d = deps({ openDb: async () => ({
      userIdForEmail: async () => "u1",
      variantKeysInBuilderOrder: async (s: string) => (s === "generic" ? ["win_loss", "score"] : ["bwf", "short"]),
      chooseTopPublicPlan: async () => "pro",
      dispose: async () => {},
    }) });
    const { err } = capture();
    expect(await runSlice(d, ["--run-id", "drift", "--report-dir", dirFor()])).toBe(2);
    expect(err.join("")).toMatch(/generic.*win_loss.*score/);
    expect(d.orgs).toEqual([]);
  });
```

`scenarios.test.ts`: add a block beside the existing fake-driven LIFECYCLE tests on `league|generic`. Generic's editor fields are `resultMode` (select) and `allowDraws` (bool) (`match-rules.ts:778-792`). The override is built the way the editor builds it:

```ts
describe("LIFECYCLE with a variant override (Task 10)", () => {
  const inherited = sportModule("generic").variants.score as Record<string, unknown>;
  const overrides = buildRuleOverride("generic", { allowDraws: "off" }, inherited);
  const spec = (o?: Record<string, unknown>) => ({ caseId: "league|generic|score|LIFECYCLE|v", row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false, ...(o === undefined ? {} : { overrides: o }) }) as never;
  const run = (driver: FakeLeagueDriver, o?: Record<string, unknown>) =>
    SCENARIOS.LIFECYCLE.run({ driver, spec: spec(o), orgSlug: "o", cfg: resolveSportCfg("generic", "score", o ?? {}), tag: "t" });
  it("the override is non-empty (else this block proves nothing)", () => {
    expect(Object.keys(overrides).length).toBeGreaterThan(0);
  });
  it("life-built-as-posted judges one more item per overridden key, and passes", async () => {
    const plain = (await run(new FakeLeagueDriver())).assertions.find((a) => a.id === "life-built-as-posted")!;
    const withO = (await run(new FakeLeagueDriver(), overrides)).assertions.find((a) => a.id === "life-built-as-posted")!;
    expect(withO.verdict).toBe("pass");
    expect(withO.checked).toBe(plain.checked + Object.keys(overrides).length);
  });
  it("a product that stores something else under the key reds it, naming config.<key>", async () => {
    class Tampered extends FakeLeagueDriver {
      override getDivision() { return super.getDivision().then((d) => ({ ...d, config: { ...d.config, allowDraws: !(d.config.allowDraws as boolean) } })); }
    }
    const a = (await run(new Tampered(), overrides)).assertions.find((x) => x.id === "life-built-as-posted")!;
    expect(a.verdict).toBe("fail");
    expect(a.evidence.join(" ")).toContain("config.allowDraws");
  });
});
```

Import `buildRuleOverride` from `../../../apps/web/src/lib/match-rules.ts` and `sportModule`/`resolveSportCfg` from `../lib/sport-cfg.ts`. `overrides` is expected to be `{ allowDraws: false }`, and the key name in the last assertion comes from it. If `buildRuleOverride` answers another key, use `Object.keys(overrides)[0]` in both the tamper and the assertion.

- [ ] **Step 2: Run and watch them fail** — use the template with `<N>`=10 and `<files>` = `scripts/matrix/__tests__/probe-set.test.ts scripts/matrix/__tests__/run-cli.test.ts scripts/matrix/__tests__/scenarios.test.ts`. Expected: probe-set FAILS TO COLLECT; the run-cli and scenarios additions fail.

- [ ] **Step 3: Implement**

`scripts/matrix/lib/probe-set.ts`:

```ts
// --set w1b-probe: the smallest live set that drives W1b's new L3 paths —
// single-stage API-only rows (LIFECYCLE, generic), every denied case, and one
// committed variant case per slice sport with its override on the wire.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ONLY_ROWS, ROW_KEYS, stagesForRow, type RowKey } from "./catalogue.ts";
import { expectedGate } from "./format-gates-copy.ts";
import type { CaseSpec } from "./scenarios/types.ts";
import { SLICE_ROWS } from "./slice.ts";
import type { VariantCase } from "./variants.ts";
import type { PlanCases } from "../run.ts";

export const PROBE_SET = "w1b-probe";
export const PROBE_API_ROWS: readonly RowKey[] = Object.freeze(API_ONLY_ROWS.filter((r) => stagesForRow(r).length === 1 && expectedGate(stagesForRow(r)) === null));
const VARIANT_SPORTS = ["generic", "badminton"] as const;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function committedVariant(sport: string): VariantCase {
  const file = JSON.parse(readFileSync(resolve(REPO, "scripts/matrix/catalogue/variants.json"), "utf8")) as { sports: { sport: string; cases: VariantCase[] }[] };
  const vc = file.sports.find((s) => s.sport === sport)?.cases.find((c) => Object.keys(c.overrides).length > 0 && c.scorable === null && (SLICE_ROWS as readonly string[]).includes(c.row));
  if (vc === undefined) throw new Error(`probe-set: no committed scorable variant case with an override on a slice row for ${sport}`);
  return vc;
}

export const probePlanner: PlanCases = () => ({
  sports: VARIANT_SPORTS,
  deniesFeatures: true,
  plan: (variantFor) => {
    const out: CaseSpec[] = [];
    const g = variantFor("generic");
    for (const row of PROBE_API_ROWS) out.push({ caseId: `${row}|generic|${g}|LIFECYCLE`, row, sport: "generic", variant: g, scenario: "LIFECYCLE", canary: false });
    for (const row of ROW_KEYS) {
      const gate = expectedGate(stagesForRow(row));
      if (gate !== null) out.push({ caseId: `${row}|generic|${g}|DENIED`, row, sport: "generic", variant: g, scenario: "DENIED", canary: false, deny: [gate] });
    }
    for (const sport of VARIANT_SPORTS) {
      const vc = committedVariant(sport);
      out.push({ caseId: `${vc.row}|${sport}|${vc.preset}|LIFECYCLE|${vc.id}`, row: vc.row, sport, variant: vc.preset, scenario: "LIFECYCLE", canary: false, overrides: vc.overrides });
    }
    return out;
  },
});
```

`probe-set.ts` imports the `PlanCases` type from `run.ts`, and `run.ts` imports `probePlanner` as a value, which makes a cycle. A type-only import is erased under strip-types, so the cycle is harmless at runtime. Still, `strip-types-loadable.test.ts` must load `probe-set.ts`, and `import type` is the form that guarantees the erasure. Keep it `import type`.

`run.ts`:
- `CasePlanner` gains `readonly deniesFeatures: boolean;`, and `slicePlanner` answers `false`.
- `Cli` and `parseCli` gain `set?: string` (`parseArgs` option `set: { type: "string" }`). With `--only`, `--scenario` or `--canary` it returns `{ usage: "--set runs a named set; it takes no --only, --scenario or --canary" }`.
- Add:

```ts
export const SETS: Readonly<Record<string, PlanCases>> = Object.freeze({ [PROBE_SET]: probePlanner });
export class UnknownSet extends Error { constructor(v: string) { super(`matrix: unknown --set '${v}' (allowed: ${Object.keys(SETS).join(", ")})`); this.name = "UnknownSet"; } }
export class RedisHidesDeny extends Error { constructor() { super("matrix: this run plants entitlement denies, and REDIS_URL is set — lib/entitlements.ts caches through Redis, so a cached allow can hide the deny. Unset REDIS_URL (seazn-local-env: no Redis) and rerun."); this.name = "RedisHidesDeny"; } }
export class BuilderDefaultDrift extends Error {
  constructor(sport: string, live: string, offline: string) {
    super(`matrix: ${sport}: the live builder default is '${live}' but the committed catalogue assumes '${offline}' (DB collation vs codepoint order) — regenerate or fix the ordering before trusting any case`);
    this.name = "BuilderDefaultDrift";
  }
}
```

In `runSlice`, after the `checkCanary`/`checkSliceFilter` block and before `SMOKE_BASE`:

```ts
  let planner: CasePlanner;
  try {
    const choose = deps.planCases ?? (cli.set === undefined ? slicePlanner : SETS[cli.set]);
    if (choose === undefined) throw new UnknownSet(cli.set!);
    planner = choose({ only: cli.only, scenario: cli.scenario, canary: cli.canary, set: cli.set });
  } catch (e) { warn(`matrix: ${errText(e)}`); return EXIT.REFUSED; }
  if (planner.deniesFeatures && (deps.env.REDIS_URL ?? "").trim() !== "") { warn(errText(new RedisHidesDeny())); return EXIT.REFUSED; }
```

Then:
- `execute` takes `planner` as a 4th parameter and drops its own planner line from Task 1.
- After the `order` loop, add:

```ts
    for (const s of planner.sports) {
      const live = builderDefaultVariant(s, order.get(s) ?? []);
      const offline = offlineBuilderDefault(s);
      if (live !== offline) throw new BuilderDefaultDrift(s, live, offline);
    }
```

- In `runSlice`'s final catch, `BuilderDefaultDrift` maps to `EXIT.REFUSED`, as the data-dir errors do.
- `runCase`'s cfg becomes `resolveSportCfg(spec.sport, spec.variant, spec.overrides ?? {})`.

`scenarios/types.ts`: `CaseSpec.row: RowKey` (import `RowKey`), plus `overrides?: Readonly<Record<string, unknown>>`.

`common.ts` `setUpDivision`:
- `createDivision(..., { ..., config: { ...(ctx.spec.overrides ?? {}) } })`.
- `built.posted` gains `config: ctx.spec.overrides ?? {}`.
- `BuiltReadback.posted` gains `config: Readonly<Record<string, unknown>>`.

`assertions.ts` `builtAsPosted`: after the variant item, add

```ts
  const expected = resolveSportCfg(posted.sport, posted.variant, { ...posted.config }) as Record<string, unknown>;
  for (const k of Object.keys(posted.config)) {
    items.push({ ok: canonical(division.config[k]) === canonical(expected[k]), note: `division config.${k}: built ${canonical(division.config[k])}, the engine resolves ${canonical(expected[k])}` });
  }
```

The expected value is the engine's own parse of preset plus override (the product stores the parsed cfg, `divisions.ts createDivision`), never the raw override. Import `resolveSportCfg` from `../sport-cfg.ts`.

`fake-driver.ts` `createDivision`: `this.cfg = resolveSportCfg(i.sportKey, i.variantKey, i.config ?? {});`, which scores under the override as the product's `config_snapshot` does.

- [ ] **Step 4: Run and see them pass** — same command as Step 2. Expected: green, `files` = 3. Also re-run the whole W1a matrix test set touched by the `CaseSpec` change: `<files>` = `scripts/matrix/__tests__/slice.test.ts scripts/matrix/__tests__/results.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts`, with `probe-set.ts` added to its module list.

- [ ] **Step 5: Mutation check**

- `probePlanner.deniesFeatures: false` → killed by the REDIS test.
- Drop the `REDIS_URL` guard → killed by the same test.
- Drift loop compares `live !== live` → killed by the Review Focus 5 test.
- `builtAsPosted` without the override loop → killed by the variant negative in `scenarios.test.ts`.
- `runCase` without `spec.overrides` → killed by run-cli "runCase resolves the case cfg WITH its overrides".
- `PROBE_API_ROWS` without the gate filter → killed by "exactly the single-stage, ungated".

- [ ] **Step 6: Scoped tsc + eslint** on `scripts/matrix/lib/probe-set.ts scripts/matrix/run.ts scripts/matrix/lib/scenarios/types.ts scripts/matrix/lib/scenarios/common.ts scripts/matrix/lib/scenarios/assertions.ts`.

- [ ] **Step 7: Commit** — `feat(matrix): --set w1b-probe — API-only rows, denied cases and committed variant cases, with Redis and builder-default guards`.

---

## Task 11: `forEachSport` and the single-sport ratchet (R26)

R26 has two parts:
- Tests under `packages/engine/src/{scheduling,competition}` and the standings/progression code sweep the sport registry through one shared helper.
- A test pinned to one sport carries a one-line reason, and CI lists unreasoned single-sport tests.

The helper lives in the engine's test-only `./testkit` export, which is already published (`packages/engine/package.json` `exports["./testkit"]`). It never sorts, because registry order is wave order (trap 4). The registry's own comment "Order is not significant" (`sports/index.ts:22`) is false premise 6. That comment is not touched: it is a `packages/engine` source line, and the scope fence routes it to the owning wave.

The scanner is a ratchet. `single-sport-baseline.json` lists today's unreasoned pins, and `--check` fails in two cases: a new unreasoned pin, and a baseline entry that no longer exists (a stale entry keeps the ratchet honest).

**Files:**
- Create: `packages/engine/src/testkit/for-each-sport.ts`, `packages/engine/src/testkit/for-each-sport.test.ts`
- Modify: `packages/engine/src/testkit/index.ts` (one `export *` line)
- Create: `scripts/matrix/single-sport.ts`, `scripts/matrix/catalogue/single-sport-baseline.json`
- Modify: `package.json` (`"matrix:single-sport": "node --experimental-strip-types scripts/matrix/single-sport.ts"`), `.github/workflows/ci.yml` (one step after `engine:boundary`)
- Test: `scripts/matrix/__tests__/single-sport.test.ts` (new); `ci-wiring.test.ts` (extend)

**Interfaces:**
- Consumes: `builtinModules` (`packages/engine/src/sports/index.ts`); `AnySportModule`.
- Produces:
  - `interface SportCase { readonly key: string; readonly index: number; readonly module: AnySportModule }`
  - `sportCases(modules?: readonly AnySportModule[]): SportCase[]`
  - `forEachSport(fn: (c: SportCase) => void, modules?): number`
  - `class EmptySportRegistry`
  - `scanSingleSport(repoRoot: string): { scanned: number; pins: Pin[] }`
  - `interface Pin { file: string; line: number; sport: string; reasoned: boolean }`
  - `checkRatchet(pins, baseline): { added: string[]; stale: string[] }`

- [ ] **Step 1: Write the failing tests**

`packages/engine/src/testkit/for-each-sport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { EmptySportRegistry, forEachSport, sportCases } from "./for-each-sport.ts";

describe("forEachSport (R26)", () => {
  it("empty case first: an empty registry is refused by name, never a silent zero-iteration pass", () => {
    expect(() => sportCases([])).toThrow(EmptySportRegistry);
    expect(() => forEachSport(() => {}, [])).toThrow(EmptySportRegistry);
  });
  it("walks the registry in ITS order — never sorted (trap 4: wave order, not alphabetical)", () => {
    const keys = sportCases().map((c) => c.key);
    expect(keys).toEqual(builtinModules.map((m) => m.key));
    expect(keys).not.toEqual([...keys].sort());
  });
  it("returns the count it visited, and the index is the registry position", () => {
    const seen: string[] = [];
    const n = forEachSport((c) => { expect(builtinModules[c.index]!.key).toBe(c.key); seen.push(c.key); });
    expect(n).toBe(builtinModules.length);
    expect(n).toBeGreaterThan(0);
    expect(seen.length).toBe(n);
  });
  it("a throwing body names the sport it failed on", () => {
    expect(() => forEachSport((c) => { if (c.index === 1) throw new Error("boom"); })).toThrow(new RegExp(`sport ${builtinModules[1]!.key}: boom`));
  });
});
```

`scripts/matrix/__tests__/single-sport.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { BASELINE_PATH, checkRatchet, loadBaseline, scanSingleSport, SCOPE_DIRS, SCOPE_NAME } from "../single-sport.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "w1b-ss-"));
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
  return root;
}

describe("single-sport scanner (R26)", () => {
  it("empty case first: a tree with nothing in scope scans zero files — and the CLI treats zero as a failure", () => {
    const root = tree({ "README.md": "x" });
    try { expect(scanSingleSport(root).scanned).toBe(0); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("finds a quoted sport key in an in-scope test; a `// single-sport:` reason on the line or the line above marks it reasoned", () => {
    const root = tree({
      "packages/engine/src/scheduling/a.test.ts": `const x = "badminton";\n// single-sport: bracket shape is sport-free\nconst y = 'generic';\n`,
      "apps/web/src/server/usecases/__tests__/stage-progression.test.ts": "sportKey: `tennis`\n",
      "apps/web/src/server/usecases/__tests__/other.test.ts": `const z = "football";\n`,
    });
    try {
      const r = scanSingleSport(root);
      expect(r.scanned).toBe(2);
      expect(r.pins.map((p) => [p.file, p.line, p.sport, p.reasoned])).toEqual([
        ["apps/web/src/server/usecases/__tests__/stage-progression.test.ts", 1, "tennis", false],
        ["packages/engine/src/scheduling/a.test.ts", 1, "badminton", false],
        ["packages/engine/src/scheduling/a.test.ts", 3, "generic", true],
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("a file that sweeps (forEachSport / sportCases / SPORT_KEYS / builtinModules) is not a pin", () => {
    const root = tree({ "packages/engine/src/competition/b.test.ts": `forEachSport((c) => {});\nconst k = "generic";\n` });
    try { expect(scanSingleSport(root).pins).toEqual([]); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("the ratchet: a new unreasoned pin and a stale baseline entry both fail; an identical set passes", () => {
    const pin = { file: "a.test.ts", line: 3, sport: "generic", reasoned: false };
    expect(checkRatchet([pin], [])).toEqual({ added: ["a.test.ts:generic"], stale: [] });
    expect(checkRatchet([], ["a.test.ts:generic"])).toEqual({ added: [], stale: ["a.test.ts:generic"] });
    expect(checkRatchet([pin], ["a.test.ts:generic"])).toEqual({ added: [], stale: [] });
    expect(checkRatchet([{ ...pin, reasoned: true }], [])).toEqual({ added: [], stale: [] });
  });
  it("the sport list is the registry's (not a typed table)", () => {
    const root = tree(Object.fromEntries(SPORT_KEYS.map((s, i) => [`packages/engine/src/scheduling/s${i}.test.ts`, `const k = "${s}";\n`])));
    try { expect(scanSingleSport(root).pins.map((p) => p.sport).sort()).toEqual([...SPORT_KEYS].sort()); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("the committed baseline equals today's repo: --check is green, and it scanned a non-zero number of files", () => {
    const r = scanSingleSport(REPO);
    expect(r.scanned).toBeGreaterThan(0);
    expect(checkRatchet(r.pins, loadBaseline(REPO))).toEqual({ added: [], stale: [] });
    expect(SCOPE_DIRS.length).toBeGreaterThan(0);
    expect(SCOPE_NAME.test("stage-progression.test.ts")).toBe(true);
    expect(BASELINE_PATH).toBe("scripts/matrix/catalogue/single-sport-baseline.json");
  });
});
```

`ci-wiring.test.ts`, appended:

```ts
  it("R26: the gates job runs the single-sport ratchet right after engine:boundary", () => {
    const lines = ci.split("\n");
    const at = lines.findIndex((l) => l.trim() === "- run: npm run engine:boundary");
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]!.trim()).toBe("- run: pnpm matrix:single-sport --check --against HEAD^1");
    expect(pkg.scripts["matrix:single-sport"]).toBe("node --experimental-strip-types scripts/matrix/single-sport.ts");
  });
```

- [ ] **Step 2: Run and watch them fail**

- The scripts tests: use the template with `<N>`=11 and `<files>` = `scripts/matrix/__tests__/single-sport.test.ts scripts/matrix/__tests__/ci-wiring.test.ts`.
- The engine test runs from the engine package:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec/packages/engine && rm -f "$TMPDIR/w1b-t11e.json" && ./node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w1b-t11e.json" src/testkit/for-each-sport.test.ts; echo EXIT=$?
```

Judge it with the template's node one-liner. The prefix argument is `$PWD/` of the engine package, so any test outside `packages/engine/` shows as stray. Expected: both FAIL TO COLLECT, and the ci-wiring addition fails.

- [ ] **Step 3: Implement**

`packages/engine/src/testkit/for-each-sport.ts`:

```ts
// R26: tests that sweep sports walk the registry through here — in the
// registry's own order, which is wave order (never sort it; AGENTS.md class
// 18). An empty registry is a refusal, not a vacuous pass (R25).
import type { AnySportModule } from "../sport/index.ts";
import { builtinModules } from "../sports/index.ts";

export interface SportCase { readonly key: string; readonly index: number; readonly module: AnySportModule }

export class EmptySportRegistry extends Error {
  constructor() { super("forEachSport: the sport registry is empty — a sweep over nothing proves nothing (R25)"); this.name = "EmptySportRegistry"; }
}

export function sportCases(modules: readonly AnySportModule[] = builtinModules): SportCase[] {
  if (modules.length === 0) throw new EmptySportRegistry();
  return modules.map((module, index) => ({ key: module.key, index, module }));
}

/** Runs fn once per sport and returns how many it visited. */
export function forEachSport(fn: (c: SportCase) => void, modules: readonly AnySportModule[] = builtinModules): number {
  const cases = sportCases(modules);
  for (const c of cases) {
    try { fn(c); } catch (e) { throw new Error(`sport ${c.key}: ${e instanceof Error ? e.message : String(e)}`, { cause: e }); }
  }
  return cases.length;
}
```

Re-pin the `AnySportModule` import path: `grep -an "export type AnySportModule\|export interface AnySportModule" -r packages/engine/src`.

`packages/engine/src/testkit/index.ts`: append `export * from "./for-each-sport.ts";`. It is pure (no `node:fs`), so it belongs in the published barrel under that file's own rule.

`scripts/matrix/single-sport.ts`:

```ts
// R26: lists unreasoned single-sport pins in the sweep's scope and ratchets
// them against a committed baseline. In scope: every *.test.ts under
// packages/engine/src/{scheduling,competition}, and every *.test.ts under
// packages/engine/src or apps/web/src whose name says standings, progression,
// seeding or tiebreak. A pin = a quoted registry sport key in a file that does
// not sweep; a `// single-sport: <reason>` on the line or the line above marks
// it reasoned. --check: exit 1 on a new unreasoned pin or a stale baseline
// entry; exit 2 when zero files were scanned.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SPORT_KEYS } from "./lib/catalogue.ts";

export const SCOPE_DIRS = ["packages/engine/src/scheduling", "packages/engine/src/competition"] as const;
export const NAME_ROOTS = ["packages/engine/src", "apps/web/src"] as const;
export const SCOPE_NAME = /(standing|progression|seeding|tiebreak)[^/]*\.test\.ts$/i;
export const SWEEPS = /\b(forEachSport|sportCases|SPORT_KEYS|builtinModules)\b/;
export const BASELINE_PATH = "scripts/matrix/catalogue/single-sport-baseline.json";
const REASON = /\/\/\s*single-sport:\s*\S/;

export interface Pin { file: string; line: number; sport: string; reasoned: boolean }

function walk(dir: string, out: string[]): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".test.ts")) out.push(p);
  }
}

export function scanSingleSport(root: string): { scanned: number; pins: Pin[] } {
  const files = new Set<string>();
  for (const d of SCOPE_DIRS) { const out: string[] = []; walk(resolve(root, d), out); out.forEach((f) => files.add(f)); }
  for (const d of NAME_ROOTS) { const out: string[] = []; walk(resolve(root, d), out); out.filter((f) => SCOPE_NAME.test(f)).forEach((f) => files.add(f)); }
  const sportRe = new RegExp(`["'\`](${SPORT_KEYS.join("|")})["'\`]`, "g");
  const pins: Pin[] = [];
  for (const abs of [...files].sort()) {
    const text = readFileSync(abs, "utf8");
    if (SWEEPS.test(text)) continue;
    const lines = text.split("\n");
    lines.forEach((l, i) => {
      for (const m of l.matchAll(sportRe)) {
        pins.push({ file: relative(root, abs).split("\\").join("/"), line: i + 1, sport: m[1]!, reasoned: REASON.test(l) || (i > 0 && REASON.test(lines[i - 1]!)) });
      }
    });
  }
  return { scanned: files.size, pins };
}

const keyOf = (p: Pin): string => `${p.file}:${p.sport}`;

export function checkRatchet(pins: readonly Pin[], baseline: readonly string[]): { added: string[]; stale: string[] } {
  const now = [...new Set(pins.filter((p) => !p.reasoned).map(keyOf))];
  return { added: now.filter((k) => !baseline.includes(k)), stale: baseline.filter((k) => !now.includes(k)) };
}

export function loadBaseline(root: string): string[] {
  return (JSON.parse(readFileSync(resolve(root, BASELINE_PATH), "utf8")) as { schemaVersion: 1; unreasoned: string[] }).unreasoned;
}

export function main(argv: string[], root = process.cwd()): number {
  const { scanned, pins } = scanSingleSport(root);
  if (scanned === 0) { process.stderr.write("single-sport: scanned ZERO files — the scope is wrong, not clean\n"); return 2; }
  const unreasoned = pins.filter((p) => !p.reasoned);
  if (argv.includes("--write-baseline")) {
    writeFileSync(resolve(root, BASELINE_PATH), `${JSON.stringify({ schemaVersion: 1, unreasoned: [...new Set(unreasoned.map(keyOf))] }, null, 2)}\n`);
    process.stdout.write(`single-sport: baseline written (${scanned} files, ${unreasoned.length} unreasoned pins)\n`);
    return 0;
  }
  for (const p of unreasoned) process.stdout.write(`unreasoned single-sport test: ${p.file}:${p.line} pins "${p.sport}"\n`);
  if (!argv.includes("--check")) return 0;
  const { added, stale } = checkRatchet(pins, loadBaseline(root));
  for (const k of added) process.stderr.write(`::error::new unreasoned single-sport pin ${k} — sweep with forEachSport, or add \`// single-sport: <reason>\`\n`);
  for (const k of stale) process.stderr.write(`::error::stale single-sport baseline entry ${k} — remove it from ${BASELINE_PATH}\n`);
  process.stdout.write(`single-sport: ${scanned} files scanned, ${unreasoned.length} unreasoned, ${added.length} new, ${stale.length} stale\n`);
  return added.length + stale.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
```

Generate the baseline, then review it:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && node --experimental-strip-types scripts/matrix/single-sport.ts --write-baseline; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && node --experimental-strip-types scripts/matrix/single-sport.ts --check; echo EXIT=$?
```

Expected: EXIT=0 twice. The planning scan found 5 files with double-quoted sport keys in scope:
- `stage-progression.test.ts`
- `progression-multi-source.test.ts`
- `progression-bye-is-decided.test.ts`
- `data-standings-timestamp.test.ts`
- `standings-pool-order-wiring.test.ts`

Single and backtick quotes may add more. Paste the file count and the entry count into the report. W1b does **not** add reasons to those files: they belong to other waves' code (scope fence), and the ratchet only stops the list from growing.

`ci.yml`: directly after `      - run: npm run engine:boundary`, add `      - run: pnpm matrix:single-sport --check --against HEAD^1`.

`package.json`: add the `matrix:single-sport` script.

- [ ] **Step 4: Run and see them pass** — the same two commands as Step 2. Expected: green; `files` = 2 (scripts) and 1 (engine).

- [ ] **Step 5: Mutation check**

- `sportCases` returns `[...modules].sort(...)` → killed by "never sorted".
- The `modules.length === 0` guard removed → killed by the empty case.
- `SWEEPS` never matches → killed by "a file that sweeps".
- `checkRatchet` ignores stale entries → killed by the ratchet test.
- Ask a reviewer to delete one baseline entry → `--check` exits 1, naming it.
- The `scanned === 0` refusal removed → killed by nothing in vitest, because the CLI branch is not unit-tested. Record it as a survivor, and add `expect(main(["--check"], emptyTreeRoot)).toBe(2)` to the empty-case test, which closes it.

- [ ] **Step 6: Scoped tsc + eslint**
  - scripts: on `scripts/matrix/single-sport.ts`;
  - engine: the changed testkit files only, never the whole package (pre-flight ruling R-PF7; the owner's changed-files rule). Use the Global Constraints template with `extends` set to `/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec/packages/engine/tsconfig.json` and `files` set to the three absolute paths `…/packages/engine/src/testkit/for-each-sport.ts`, `…/packages/engine/src/testkit/for-each-sport.test.ts` and `…/packages/engine/src/testkit/index.ts`, written to `$TMPDIR/w1b-tsc-11-engine.json`. Run `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && rtk proxy node node_modules/typescript-native/bin/tsc -p "$TMPDIR/w1b-tsc-11-engine.json"; echo EXIT=$?`. tsc still follows those files' imports into the engine, so an error it prints under another path is one these files caused or exposed; record it rather than widen the scope. Then eslint: `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec/packages/engine && rtk proxy ./node_modules/.bin/eslint src/testkit/for-each-sport.ts src/testkit/for-each-sport.test.ts src/testkit/index.ts; echo EXIT=$?`.

- [ ] **Step 7: Commit** — `feat(engine,matrix): forEachSport in the testkit, and a CI ratchet over unreasoned single-sport tests (R26)`.

---

## Task 12: `packages/reference` skeleton, its import boundary, its CI step and its Dockerfile line (ruling 27)

The package ships empty of families (design §7.2): each wave adds the families its signed rulebooks cover.

**Ruling 27 (O10), which this task implements:** the reference may import from `@seazn/engine` only in the statement form `import type { … } from "@seazn/engine/core"` or `export type { … } from "@seazn/engine/core"`. The inline form `import { type X } from …` is refused, because Node's strip-types keeps an inline-type import as a side-effect `import {} from "…"`, which loads the engine at runtime. The leaf-types-package alternative was rejected; if it is ever revisited, only `ALLOWED_ENGINE` and the gate test's allowed fixture change.

Trap 2 is that the package is invisible to the root chains, so the test named below checks each root chain. Trap 3 is the bench pack types (`pack-schema.ts:144-145`): the gate refuses any relative import that leaves `packages/reference/src`.

**Files:**
- Create:
  - `packages/reference/package.json`, `packages/reference/tsconfig.json`, `packages/reference/eslint.config.mjs`
  - `packages/reference/src/index.ts`, `packages/reference/src/index.test.ts`
  - `packages/reference/test/boundary-gate.test.ts`
- Create: `scripts/reference-boundary.ts`
- Modify:
  - `package.json` (`reference:boundary`; add the package to the `lint`, `typecheck` and `test` chains)
  - `Dockerfile` (one `COPY` line)
  - `.github/workflows/ci.yml` (`npm run reference:boundary` after the single-sport step; a strict "Reference package tests (DB-free)" step after the matrix step)
  - `pnpm-lock.yaml` (via `pnpm install`)
- Test: `scripts/matrix/__tests__/workspace-wiring.test.ts` (new); `scripts/matrix/__tests__/ci-wiring.test.ts` (generalise the step parser; add the reference step's cases)

**Interfaces:**
- Consumes: `@seazn/engine/core` types (`MatchOutcome`, `StageKind` as a type only).
- Produces:
  - `packages/reference`: `interface ReferenceFamily { readonly id: string; readonly rulebook: string; readonly stageKinds: readonly StageKindName[]; readonly sports: readonly string[] | "any" }`, `FAMILIES: readonly ReferenceFamily[]` (empty), `familiesFor(stageKind: StageKindName, sport: string): ReferenceFamily[]`, `class NoReferenceFamily`, `requireFamily(stageKind, sport): ReferenceFamily`
  - `scripts/reference-boundary.ts`: `checkReferenceBoundary(srcDir: string): { scanned: number; violations: Violation[] }`, `interface Violation { file: string; line: number; specifier: string; reason: string }`
  - `ci-wiring.test.ts`: `stepOf(text, name)`, `runNamedStep(name, reportFile, o)`

- [ ] **Step 1: Write the failing tests**

`packages/reference/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FAMILIES, NoReferenceFamily, familiesFor, requireFamily } from "./index.ts";

describe("reference skeleton (design §7.2: ships empty of families)", () => {
  it("empty case first: no family exists yet", () => {
    expect(FAMILIES).toEqual([]);
  });
  it("familiesFor answers [] for any stage kind and sport while empty", () => {
    expect(familiesFor("league", "generic")).toEqual([]);
  });
  it("requireFamily is a named refusal, never an undefined oracle", () => {
    expect(() => requireFamily("knockout", "tennis")).toThrow(NoReferenceFamily);
    expect(() => requireFamily("knockout", "tennis")).toThrow(/no reference family for knockout × tennis/);
  });
  it("FAMILIES is frozen: a wave adds families in source, never at run time", () => {
    expect(Object.isFrozen(FAMILIES)).toBe(true);
  });
});
```

`packages/reference/test/boundary-gate.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkReferenceBoundary } from "../../../scripts/reference-boundary.ts";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function src(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "w1b-ref-"));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
  return root;
}
const reasons = (root: string) => { try { return checkReferenceBoundary(root).violations.map((v) => `${v.specifier}: ${v.reason}`); } finally { rmSync(root, { recursive: true, force: true }); } };

describe("reference boundary gate (ruling 27: statement-form import type from @seazn/engine/core only)", () => {
  it("empty case first: a src dir with no .ts files scans zero — the CLI refuses that", () => {
    const root = src({ "README.md": "x" });
    try { expect(checkReferenceBoundary(root).scanned).toBe(0); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("the real package is clean, and scanned > 0 files", () => {
    const r = checkReferenceBoundary(join(PKG, "src"));
    expect(r.scanned).toBeGreaterThan(0);
    expect(r.violations).toEqual([]);
  });
  it("allowed: statement import type / export type from @seazn/engine/core, and relative imports inside src", () => {
    expect(reasons(src({
      "a.ts": `import type { MatchOutcome } from "@seazn/engine/core";\nexport type { StageKind } from "@seazn/engine/core";\nimport { b } from "./b.ts";\n`,
      "b.ts": "export const b = 1;\n",
    }))).toEqual([]);
  });
  it("refused, each by name", () => {
    const got = reasons(src({ "a.ts": [
      `import { buildStandings } from "@seazn/engine/core";`,
      `import { type MatchOutcome } from "@seazn/engine/core";`,
      `import type { X } from "@seazn/engine/competition";`,
      `import type { P } from "../../../scripts/bench/lib/pack-schema.ts";`,
      `import { s } from "../../../apps/web/src/lib/match-rules.ts";`,
      `import postgres from "postgres";`,
      `const m = await import("./b.ts");`,
      `const t = Date.now();`,
    ].join("\n") }));
    expect(got).toEqual([
      "@seazn/engine/core: engine imports must be `import type { … }` statements (a value import couples the oracle to the code it checks)",
      "@seazn/engine/core: inline `{ type X }` is refused — strip-types keeps it as a runtime import of the engine",
      "@seazn/engine/competition: only @seazn/engine/core types may be imported",
      "../../../scripts/bench/lib/pack-schema.ts: relative import leaves packages/reference/src (the bench pack types import engine runtime values — trap 3)",
      "../../../apps/web/src/lib/match-rules.ts: relative import leaves packages/reference/src (the bench pack types import engine runtime values — trap 3)",
      "postgres: not an allowed import (relative within src, or @seazn/engine/core types)",
      "./b.ts: dynamic import() is refused",
      "Date.now(: nondeterministic token (the reference must answer the same way every time)",
    ]);
  });
});
```

`scripts/matrix/__tests__/workspace-wiring.test.ts`:

```ts
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
const workspaces = ["apps", "packages"].flatMap((d) => readdirSync(resolve(REPO, d)).map((n) => `${d}/${n}`)).filter((w) => existsSync(resolve(REPO, w, "package.json")));

describe("workspace wiring (trap 2: a new package is invisible to the root chains)", () => {
  it("the workspace list is non-empty and includes packages/reference", () => {
    expect(workspaces.length).toBeGreaterThan(2);
    expect(workspaces).toContain("packages/reference");
  });
  it("the Dockerfile COPYs every workspace manifest BEFORE pnpm install --frozen-lockfile", () => {
    const docker = read("Dockerfile").split("\n");
    const install = docker.findIndex((l) => l.includes("pnpm install --frozen-lockfile"));
    expect(install).toBeGreaterThan(0);
    for (const w of workspaces) {
      const at = docker.findIndex((l) => l.trim() === `COPY ${w}/package.json ${w}/`);
      expect(at, `${w}: no COPY line`).toBeGreaterThan(-1);
      expect(at, `${w}: COPY after install`).toBeLessThan(install);
    }
  });
  it("every workspace with a lint/typecheck/test script is in the root chain of that name", () => {
    let judged = 0;
    for (const w of workspaces) {
      const scripts = (JSON.parse(read(`${w}/package.json`)) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const s of ["lint", "typecheck", "test"] as const) {
        if (scripts[s] === undefined) continue;
        judged++;
        expect(pkg.scripts[s], `root ${s} misses ${w}`).toContain(`npm run ${s} --workspace ${w}`);
      }
    }
    expect(judged).toBeGreaterThanOrEqual(9);
  });
  it("packages/reference: every bare import in src is a declared dependency", () => {
    const ref = JSON.parse(read("packages/reference/package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = new Set([...Object.keys(ref.dependencies ?? {}), ...Object.keys(ref.devDependencies ?? {})]);
    const files = readdirSync(resolve(REPO, "packages/reference/src")).filter((f) => f.endsWith(".ts"));
    let bare = 0;
    for (const f of files) for (const m of read(`packages/reference/src/${f}`).matchAll(/from\s+"([^".][^"]*)"/g)) {
      bare++;
      const name = m[1]!.startsWith("@") ? m[1]!.split("/").slice(0, 2).join("/") : m[1]!.split("/")[0]!;
      expect(declared.has(name), `${f}: ${m[1]} is not declared`).toBe(true);
    }
    expect(bare).toBeGreaterThan(0);
  });
});
```

`judged >= 9` is apps/web, engine and reference × lint, typecheck and test. Re-pin it: if `apps/web` has no `test` script of that exact name, set the floor to the counted number and say why in the report. The floor stays above zero.

`ci-wiring.test.ts` needs three changes:
- Rename `matrixStep(text)` to `stepOf(text, name)`, with `STEP_HEAD` computed from `name`, and keep `const matrixStep = (t: string) => stepOf(t, STEP_NAME)` so existing call sites stay as they are.
- Generalise `runStep` to `runNamedStep(name, reportFile, o)`, and keep `runStep = (o) => runNamedStep(STEP_NAME, "vitest-results-matrix.json", o)`.
- Append:

```ts
describe("reference CI wiring (Task 12)", () => {
  const REF = "Reference package tests (DB-free)";
  const REF_REPORT = "vitest-results-reference.json";
  const refReport = (root: string, o: { total: number; passed: number; failedSuites?: number; files?: string[] }) => ({
    numTotalTests: o.total, numPassedTests: o.passed, numFailedTests: o.total - o.passed, numFailedTestSuites: o.failedSuites ?? 0,
    testResults: (o.files ?? [join(root, "packages/reference/src/index.test.ts")]).map((name) => ({ name })),
  });
  it("the step exists right after the matrix step, and the boundary gate runs after the single-sport ratchet", () => {
    const lines = ci.split("\n");
    const m = lines.indexOf(`      - name: ${STEP_NAME}`);
    const r = lines.indexOf(`      - name: ${REF}`);
    expect(m).toBeGreaterThan(0);
    expect(r).toBeGreaterThan(m);
    expect(lines.slice(m + 1, r).some((l) => l.startsWith("      - "))).toBe(false);
    const ss = lines.findIndex((l) => l.trim() === "- run: pnpm matrix:single-sport --check --against HEAD^1");
    expect(lines[ss + 1]!.trim()).toBe("- run: npm run reference:boundary");
    expect(stepOf(ci, REF).keys).toEqual(["name", "run"]);
  });
  it("green on a full pass inside packages/reference", () => {
    expect(runNamedStep(REF, REF_REPORT, { json: (root) => refReport(root, { total: 4, passed: 4 }), exit: 0 }).status).toBe(0);
  });
  it("red on zero tests, a failed-to-collect suite, a skip, and a stray file", () => {
    expect(runNamedStep(REF, REF_REPORT, { json: (root) => refReport(root, { total: 0, passed: 0, files: [] }), exit: 0 }).status).not.toBe(0);
    expect(runNamedStep(REF, REF_REPORT, { json: (root) => refReport(root, { total: 4, passed: 4, failedSuites: 1 }), exit: 0 }).status).not.toBe(0);
    expect(runNamedStep(REF, REF_REPORT, { json: (root) => refReport(root, { total: 4, passed: 3 }), exit: 0 }).status).not.toBe(0);
    expect(runNamedStep(REF, REF_REPORT, { json: (root) => refReport(root, { total: 4, passed: 4, files: [join(root, "scripts/x.test.ts")] }), exit: 0 }).status).not.toBe(0);
  });
});
```

`runNamedStep` copies the report to wherever the stand-in vitest was told to write it. Its body is W1a's `runStep` with `vitest-results-matrix.json` replaced by `reportFile` (in the stale-report line only). The existing stand-in already writes to the `--outputFile` path.

- [ ] **Step 2: Run and watch them fail**

- Scripts: use the template with `<N>`=12 and `<files>` = `scripts/matrix/__tests__/workspace-wiring.test.ts scripts/matrix/__tests__/ci-wiring.test.ts`. Expected: workspace-wiring fails on `packages/reference` absent, and the reference CI cases fail.
- The two package tests cannot collect yet (no package), which is expected.

- [ ] **Step 3: Implement**

`packages/reference/package.json`:

```json
{
  "name": "@seazn/reference",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "node ../../node_modules/typescript-native/bin/tsc --noEmit",
    "lint": "eslint"
  },
  "devDependencies": {
    "@eslint/js": "^9",
    "@seazn/engine": "workspace:*",
    "@types/node": "^26",
    "eslint": "^9",
    "typescript": "6.0.3",
    "typescript-eslint": "^8",
    "typescript-native": "npm:typescript@7.0.2",
    "vitest": "^4.1.11"
  }
}
```

Copy the version ranges exactly from `packages/engine/package.json`'s `devDependencies`, and re-pin them there first. `@seazn/engine` is a **dev** dependency: it is needed for types only, and nothing imports it at runtime.

`packages/reference/tsconfig.json` is `packages/engine/tsconfig.json` with `include` narrowed to `["src/**", "test/**"]`. Copy the engine file and edit only `include`.

`packages/reference/eslint.config.mjs` is `packages/engine/eslint.config.mjs` copied, with any engine-path-specific blocks deleted: read it first and keep only the generic `recommendedTypeChecked`, `no-console` and `ban-ts-comment` blocks. Add one rule that makes the gate's statement-form rule also a lint error:

```js
  { files: ["src/**/*.ts"], rules: { "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "separate-type-imports" }] } },
```

`packages/reference/src/index.ts`:

```ts
// @seazn/reference — independent oracles written FROM THE RULEBOOK, never from
// engine code (design §7.2), by a different agent than the one fixing the
// engine in that wave. W1b ships it EMPTY of families; each wave adds the
// families its signed rulebooks cover, before fixing anything. Imports:
// relative within src, and `import type { … } from "@seazn/engine/core"`
// statements only (ruling 27) — scripts/reference-boundary.ts.
import type { StageKind } from "@seazn/engine/core";

export type StageKindName = StageKind;

export interface ReferenceFamily {
  readonly id: string;
  /** The signed rulebook section this family answers from. */
  readonly rulebook: string;
  readonly stageKinds: readonly StageKindName[];
  readonly sports: readonly string[] | "any";
}

export const FAMILIES: readonly ReferenceFamily[] = Object.freeze([]);

export class NoReferenceFamily extends Error {
  constructor(stageKind: string, sport: string) {
    super(`reference: no reference family for ${stageKind} × ${sport} — no oracle, so no exact check`);
    this.name = "NoReferenceFamily";
  }
}

export function familiesFor(stageKind: StageKindName, sport: string): ReferenceFamily[] {
  return FAMILIES.filter((f) => f.stageKinds.includes(stageKind) && (f.sports === "any" || f.sports.includes(sport)));
}

export function requireFamily(stageKind: StageKindName, sport: string): ReferenceFamily {
  const [f] = familiesFor(stageKind, sport);
  if (f === undefined) throw new NoReferenceFamily(stageKind, sport);
  return f;
}
```

`StageKind` in `@seazn/engine/core` is a zod enum value plus a same-named type. `import type { StageKind }` takes the type. Confirm with `grep -an "export type StageKind\|export const StageKind" -r packages/engine/src/core`. If only the value exists, use `import type { StageKind } …` together with `type StageKindName = import("@seazn/engine/core").StageKind`, provided tsc accepts it. Otherwise declare `type StageKindName = string` and record the finding under O10: that would be the case in which type-only proves insufficient, which the design names as the trigger for the leaf-types alternative.

`scripts/reference-boundary.ts`:

```ts
// The reference package's import boundary (design §7.2, ruling 27):
// relative imports that stay inside packages/reference/src, and statement-form
// `import type` / `export type` from @seazn/engine/core. Everything else —
// engine values, inline `{ type X }` (strip-types keeps it as a runtime
// import), other engine subpaths, anything leaving src (the bench pack types
// import engine runtime values, trap 3), dynamic import, require, and
// nondeterministic tokens — is a violation. Zero files scanned is a refusal.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface Violation { file: string; line: number; specifier: string; reason: string }
export const ALLOWED_ENGINE = "@seazn/engine/core";
const BANNED_TOKENS = ["Date.now(", "Math.random(", "new Date()"] as const;
const STATIC = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/;
const BARE_IMPORT = /^\s*import\s+["']([^"']+)["']/;
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']/;
const REQUIRE = /\brequire\s*\(\s*["']([^"']+)["']/;

function tsFiles(dir: string, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (n.endsWith(".ts") && !n.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

export function checkReferenceBoundary(srcDir: string): { scanned: number; violations: Violation[] } {
  const root = resolve(srcDir);
  const files = tsFiles(root).sort();
  const violations: Violation[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    // Join multi-line import statements onto their first line for matching.
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((raw, i) => {
      const line = raw.replace(/\/\/.*$/, "");
      const add = (specifier: string, reason: string) => violations.push({ file: rel, line: i + 1, specifier, reason });
      for (const t of BANNED_TOKENS) if (line.includes(t)) add(t, "nondeterministic token (the reference must answer the same way every time)");
      const dyn = DYNAMIC.exec(line);
      if (dyn) { add(dyn[1]!, "dynamic import() is refused"); return; }
      const req = REQUIRE.exec(line);
      if (req) { add(req[1]!, "require() is refused"); return; }
      const bare = BARE_IMPORT.exec(line);
      if (bare) { add(bare[1]!, "side-effect import is refused"); return; }
      let stmt = line;
      for (let k = i + 1; !/\bfrom\s+["']/.test(stmt) && /^\s*(import|export)\b/.test(line) && k < lines.length && k < i + 20; k++) stmt += ` ${lines[k]}`;
      const m = STATIC.exec(stmt);
      if (!m) return;
      const [, , typeKw, clause, spec] = m as unknown as [string, string, string | undefined, string, string];
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (!target.startsWith(root + "/")) add(spec, "relative import leaves packages/reference/src (the bench pack types import engine runtime values — trap 3)");
        return;
      }
      if (spec.startsWith("@seazn/engine")) {
        if (spec !== ALLOWED_ENGINE) { add(spec, "only @seazn/engine/core types may be imported"); return; }
        if (typeKw === undefined && /\{\s*type\s/.test(clause)) { add(spec, "inline `{ type X }` is refused — strip-types keeps it as a runtime import of the engine"); return; }
        if (typeKw === undefined) add(spec, "engine imports must be `import type { … }` statements (a value import couples the oracle to the code it checks)");
        return;
      }
      add(spec, "not an allowed import (relative within src, or @seazn/engine/core types)");
    });
  }
  return { scanned: files.length, violations };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { scanned, violations } = checkReferenceBoundary(resolve("packages/reference/src"));
  for (const v of violations) process.stderr.write(`FAIL ${v.file}:${v.line} ${v.specifier} — ${v.reason}\n`);
  if (scanned === 0) process.stderr.write("reference:boundary scanned ZERO files — refusing\n");
  process.stdout.write(`reference:boundary: ${scanned} files, ${violations.length} violation(s)\n`);
  process.exitCode = scanned === 0 || violations.length > 0 ? 1 : 0;
}
```

The gate test expects one violation per offending line, in file order. `export type { StageKind } from …` matches `STATIC` with `typeKw = "type "`. Excluding test files mirrors `engine-boundary.ts`: tests may import the gate script itself.

Root `package.json`:
- Add `"reference:boundary": "node --experimental-strip-types scripts/reference-boundary.ts"`.
- `lint` gains ` && npm run lint --workspace packages/reference` (before `lint:scripts`).
- `typecheck` gains ` && npm run typecheck --workspace packages/reference`.
- `test` gains ` && npm run test --workspace packages/reference`.

`Dockerfile`: after `COPY packages/engine/package.json packages/engine/`, add `COPY packages/reference/package.json packages/reference/`.

`ci.yml`:
- After `      - run: pnpm matrix:single-sport --check --against HEAD^1`, add `      - run: npm run reference:boundary`.
- Directly after the matrix step's closing `'`, add a step named `Reference package tests (DB-free)`. Its `run: |` block is the matrix block with these substitutions:
  - `vitest-results-matrix.json` → `vitest-results-reference.json`;
  - positional `scripts/matrix` → `packages/reference`;
  - `path.join(process.cwd(), "scripts", "matrix")` → `path.join(process.cwd(), "packages", "reference")`;
  - every message's "matrix" → "reference".

  Write it out in full in the YAML, not by reference, with a 6-line comment above it: "Trap 2 — tests are not run through turbo; a new package's tests need an explicit step. Same strict judge as the matrix step." The engine's vitest binary is used from the repo root with a positional, as in the matrix step, so the package's own `vitest` devDependency serves only `npm run test --workspace packages/reference`.

Install and update the lockfile:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && pnpm install; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && git diff --stat pnpm-lock.yaml
```

Expected: EXIT=0, and a `pnpm-lock.yaml` diff that adds only the `packages/reference` importer block. If the diff touches other importers, stop and report it: an unrelated lock drift must not ride in this commit.

- [ ] **Step 4: Run and see them pass**
  - Scripts: same command as Step 2. Expected green, `files` = 2.
  - Package: from the package, `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec/packages/reference && rm -f "$TMPDIR/w1b-t12r.json" && ../engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w1b-t12r.json" src/index.test.ts test/boundary-gate.test.ts; echo EXIT=$?`, judged with prefix `$PWD/`. Expected green, `files` = 2.
  - Gate CLI: `cd <worktree> && npm run reference:boundary; echo EXIT=$?` → `1 files, 0 violation(s)`, EXIT=0.

- [ ] **Step 5: Deliberate violation proof (the "Done when" wording)**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && cp packages/reference/src/index.ts "$TMPDIR/ref-index.bak" && printf '\nimport { buildStandings } from "@seazn/engine/core";\n' >> packages/reference/src/index.ts && npm run reference:boundary; echo EXIT=$?; cp "$TMPDIR/ref-index.bak" packages/reference/src/index.ts && npm run reference:boundary; echo EXIT=$?
```

Expected: first `FAIL index.ts:<n> @seazn/engine/core — engine imports must be …` with EXIT=1, then EXIT=0. Paste both lines into the report and into the commit body.

- [ ] **Step 6: Mutation check**

- Gate: the `typeKw === undefined` value-import branch deleted → killed by "refused, each by name".
- The `root + "/"` containment check → `true` → killed by the same test (the pack-schema line).
- Remove the Dockerfile line → killed by workspace-wiring.
- Drop the reference from the root `test` chain → killed by workspace-wiring.
- The CI step's stray check deleted → killed by "red on … a stray file".
- `FAMILIES` not frozen → killed by the freeze test.

- [ ] **Step 7: Scoped tsc + eslint**
  - The package's own `npm run typecheck --workspace packages/reference` and `npm run lint --workspace packages/reference`, via `rtk proxy`; read `✖ N problems`.
  - Scripts: `scripts/reference-boundary.ts`.

- [ ] **Step 8: Commit** — `feat(reference): the empty reference package, its import boundary gate, CI step and Dockerfile line`. The body names ruling 27 as the rule the gate enforces, and pastes the violation proof.

---
## Task 13: The fast-check model core — dependency, ledger fold, model state, commands, the model fake

The design (§7.5 item 1) asks for a command model over the organiser actions, checked after every step. Two things are checked:
- the step-safe invariants from Task 2 (I6, I7, I8). False premise 3 explains why "every invariant" is wrong: I1 abstains on late entry, and I2 and I4 hold only at the end;
- fold parity: the product's outcome for each fixture whose ledger the model fully knows equals the engine's fold of that ledger, with voids resolved.

The commands are the ten organiser actions named in §7.5. Every product refusal must be named (`isNamedRefusal`). An unnamed one is a violation, never a skip.

`fast-check` is a dev dependency of `packages/engine` only (`packages/engine/package.json` devDependencies `"fast-check": "^3"`). The root has none, so `scripts/` cannot import it under pnpm's strict linker (false premise 1). A nested worktree would resolve it upward into the main checkout's stray `node_modules/fast-check`. The resolution test pins the realpath to this checkout's `.pnpm` store (Review Focus 2).

**Files:**
- Modify: `package.json` + `pnpm-lock.yaml` (`pnpm add -D -w fast-check@^3`)
- Modify: `scripts/matrix/lib/driver/types.ts` (`OrganiserDriver.rebuild`), `scripts/matrix/lib/driver/http-driver.ts` (`rebuild`), `scripts/matrix/__tests__/fake-driver.ts` (`FakeLeagueDriver.rebuild` refuses by name)
- Create: `scripts/matrix/lib/model/ledger-fold.ts`, `scripts/matrix/lib/model/state.ts`, `scripts/matrix/lib/model/commands.ts`, `scripts/matrix/lib/model/fences.ts`
- Create: `scripts/matrix/__tests__/model-fake-driver.ts`
- Test: `scripts/matrix/__tests__/fast-check-resolution.test.ts`, `scripts/matrix/__tests__/model-core.test.ts` (new); `http-driver.test.ts` (extend); add the four model modules to `strip-types-loadable.test.ts`

**Interfaces:**
- Consumes:
  - `evaluateStepInvariants`, `STEP_INVARIANTS` (Task 2)
  - `isNamedRefusal`, `toObservedOutcome`, `sameOutcome`, `isTerminal` (observed.ts)
  - `generateStream` (streams)
  - `START` (streams/types.ts)
  - `lineupsFor`, `FOLD_OPTIONS`, `OFFLINE_RECORDED_AT` (fold.ts)
  - `sportModule`, `entrantKindFor` (sport-cfg.ts)
  - `RefusedCall`, `OrganiserDriver` (driver/types.ts); `GenerateObs` (observed.ts)
- Produces:
  - `OrganiserDriver.rebuild(stageId: string): Promise<void>`, which throws `RefusedCall` on a refusal.
  - `interface LedgerEntry { id: string; seq: number; type: string; payload: unknown; voids?: string }`, `ledgerEnvelopes(fixtureId, entries)`, `liveEntries(entries)`, `foldLedger(sport, cfg, home, away, entries): MatchOutcome | null`
  - `COMMAND_KINDS = ["Start","AddEntrant","Withdraw","Score","Walkover","Void","Correct","Generate","Rebuild","Complete"] as const`, `type CommandKind`
  - `interface FixtureModel { id: string; home: string | null; away: string | null; status: string; ledger: LedgerEntry[] | null }`
  - `class ModelState` (fields below), `newModelState(input)`
  - `class ModelViolation extends Error { check: string; evidence: string[] }`
  - `checkStep(m: ModelState, d: OrganiserDriver): Promise<void>`
  - `commandOf(kind, k, w, fences): fc.AsyncCommand<ModelState, OrganiserDriver>`, `modelCommands(opts: { fences: boolean }): fc.Arbitrary<fc.AsyncCommand<ModelState, OrganiserDriver>>[]`
  - `interface Fence { id: string; issue: string; blocks: CommandKind; applies(m: ModelState): boolean }`, `FENCES`, `fenceBlocking(m, kind, enabled): Fence | null`
  - `class ModelFakeDriver extends FakeLeagueDriver` with the options `{ fault879?: boolean; lieOutcome?: boolean; unnamedCompleteRefusal?: boolean }`

- [ ] **Step 1: Add the dependency and write the resolution test**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && pnpm add -D -w fast-check@^3; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && git diff --stat package.json pnpm-lock.yaml
```

Expected: EXIT=0. `package.json` gains one `devDependencies` line, and the lock gains a root importer entry, deduplicated to the engine's resolved `fast-check` 3.x.

`scripts/matrix/__tests__/fast-check-resolution.test.ts`:

```ts
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
const pkg = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(resolve(REPO, "package.json"), "utf8"))) as { devDependencies?: Record<string, string> };

describe("fast-check resolves from THIS checkout (Review Focus 2)", () => {
  it("is a root devDependency on major 3, like the engine's", () => {
    expect(pkg.devDependencies?.["fast-check"]).toMatch(/^\^3/);
  });
  it("scripts/ resolves it inside this checkout's node_modules/.pnpm — not a parent checkout's stray copy", () => {
    const at = realpathSync(createRequire(import.meta.url).resolve("fast-check"));
    expect(at.startsWith(`${REPO}${sep}node_modules${sep}.pnpm${sep}`), at).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing model tests**

`scripts/matrix/__tests__/model-core.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { START } from "../lib/streams/types.ts";
import { generateStream } from "../lib/streams/index.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { foldLedger, liveEntries, type LedgerEntry } from "../lib/model/ledger-fold.ts";
import { COMMAND_KINDS, ModelViolation, checkStep, commandOf, modelCommands, newModelState, type CommandKind, type ModelState } from "../lib/model/commands.ts";
import { FENCES, fenceBlocking } from "../lib/model/fences.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

const cfg = resolveSportCfg("generic", "score");
const win = (winner: "home" | "away") => generateStream({ sportKey: "generic", cfg, stageKind: "league", home: "h", away: "a", outcome: { kind: "win", winner } });
const entries = (evs: { type: string; payload: unknown }[]): LedgerEntry[] => evs.map((e, i) => ({ id: `x${i + 1}`, seq: i + 1, type: e.type, payload: e.payload }));

async function fresh(opts: ConstructorParameters<typeof ModelFakeDriver>[0] = {}): Promise<{ m: ModelState; d: ModelFakeDriver }> {
  const d = new ModelFakeDriver(opts);
  const m = await newModelState({ driver: d, row: "league", sport: "generic", variant: "score", entrants: 4, tag: "t" });
  return { m, d };
}
/** A hand-written command sequence: each step must be runnable, then runs. */
async function play(m: ModelState, d: ModelFakeDriver, steps: [CommandKind, number, number?][], fences = true): Promise<void> {
  for (const [kind, k, w] of steps) {
    const c = commandOf(kind, k, w ?? 0, fences);
    expect(c.check(m), `${kind} should be runnable`).toBe(true);
    await c.run(m, d);
  }
}

describe("ledger fold (void-aware, the engine's own fold)", () => {
  it("empty case first: an empty ledger folds to no outcome", () => {
    expect(foldLedger("generic", cfg, "h", "a", [])).toBeNull();
  });
  it("a win stream folds to its winner", () => {
    expect(foldLedger("generic", cfg, "h", "a", entries(win("home")))).toMatchObject({ kind: "win", winner: "h" });
  });
  it("voiding every live event, newest first, folds back to no decision; liveEntries is empty", () => {
    const e = entries(win("home"));
    const voids = [...e].reverse().map((t, i) => ({ id: `v${i + 1}`, seq: e.length + i + 1, type: "core.void", payload: {}, voids: t.id }));
    const all = [...e, ...voids];
    expect(liveEntries(all)).toEqual([]);
    const out = foldLedger("generic", cfg, "h", "a", all);
    expect(out === null || out.kind !== "win").toBe(true);
  });
  it("a void naming an unknown event is the engine's named refusal, not a silent pass", () => {
    expect(() => foldLedger("generic", cfg, "h", "a", [...entries(win("home")), { id: "v", seq: 99, type: "core.void", payload: {}, voids: "nope" }])).toThrow(/core\.void targets unknown/);
  });
});

describe("model commands — preconditions", () => {
  it("empty case first: before Start, only Start and AddEntrant are runnable", async () => {
    const { m } = await fresh();
    const runnable = COMMAND_KINDS.filter((k) => commandOf(k, 0, 0, true).check(m));
    expect(runnable).toEqual(["Start", "AddEntrant"]);
  });
  it("one arbitrary per command kind, in COMMAND_KINDS order (the ten §7.5 names), each generating its own kind", () => {
    const arbs = modelCommands({ fences: true });
    expect(arbs.length).toBe(10);
    expect(arbs.map((a) => fc.sample(a, { numRuns: 1, seed: 7 })[0]!.toString().split("(")[0])).toEqual([...COMMAND_KINDS]);
    expect([...COMMAND_KINDS]).toEqual(["Start", "AddEntrant", "Withdraw", "Score", "Walkover", "Void", "Correct", "Generate", "Rebuild", "Complete"]);
  });
});

describe("model commands — a correct product passes every step", () => {
  it("each command kind runs once, every step is checked, fold parity compares > 0 fixtures", async () => {
    const { m, d } = await fresh();
    // Order matters: Correct needs a decided fixture, so it runs before any void.
    // Fences off: this fake has no #879, and the late-entry fence would withhold Generate.
    await play(m, d, [["Start", 0], ["Score", 0, 0], ["Score", 0, 1], ["Correct", 0], ["Walkover", 0, 1], ["Void", 0], ["AddEntrant", 0], ["Generate", 0], ["Rebuild", 0], ["Withdraw", 0], ["Complete", 0]], false);
    for (const k of COMMAND_KINDS) expect(m.counts[k].ran, k).toBeGreaterThan(0);
    expect(m.counts.Score.accepted).toBeGreaterThan(0);
    expect(m.counts.Rebuild.refused).toBe(1); // results exist → STAGE_HAS_RESULTS, named
    expect(m.foldParity).toBeGreaterThan(0);
    expect(m.stepChecks.get("I8-generate-named") ?? 0).toBeGreaterThan(0);
    expect(m.stepChecks.get("I7-rr-no-pair-over-legs") ?? 0).toBeGreaterThan(0);
  });
});

describe("model commands — each fault is caught at the step that causes it", () => {
  it("#879: a late entrant then Generate duplicates pairs → I7 at that step (fences OFF)", async () => {
    const { m, d } = await fresh({ fault879: true });
    await play(m, d, [["Start", 0], ["AddEntrant", 0]], false);
    const e = await play(m, d, [["Generate", 0]], false).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelViolation);
    expect((e as ModelViolation).check).toBe("I7-rr-no-pair-over-legs");
  });
  it("#879 needs a late entrant: with fault879 on, Start then Generate (no AddEntrant) duplicates nothing (R-PF8)", async () => {
    const { m, d } = await fresh({ fault879: true });
    await play(m, d, [["Start", 0], ["Generate", 0]], false);
    expect(m.counts.Generate.ran).toBe(1);
    expect(m.stepChecks.get("I7-rr-no-pair-over-legs") ?? 0).toBeGreaterThan(0);
  });
  it("…and with fences ON, Generate is not offered after a late entry on a league stage, and the fence is counted", async () => {
    const { m, d } = await fresh({ fault879: true });
    await play(m, d, [["Start", 0], ["AddEntrant", 0]]);
    expect(commandOf("Generate", 0, 0, true).check(m)).toBe(false);
    expect(m.fenced.get("late-entry-then-generate")).toBe(1);
    expect(fenceBlocking(m, "Generate", true)?.issue).toBe("#879");
    expect(fenceBlocking(m, "Generate", false)).toBeNull();
  });
  it("a product that lies about an outcome → model-fold-parity", async () => {
    const { m, d } = await fresh({ lieOutcome: true });
    const e = await play(m, d, [["Start", 0], ["Score", 0, 0]]).catch((x: unknown) => x);
    expect((e as ModelViolation).check).toBe("model-fold-parity");
  });
  it("an unnamed refusal → model-refusal-named", async () => {
    const { m, d } = await fresh({ unnamedCompleteRefusal: true });
    const e = await play(m, d, [["Start", 0], ["Complete", 0]]).catch((x: unknown) => x);
    expect((e as ModelViolation).check).toBe("model-refusal-named");
  });
  it("checkStep on a model with nothing to judge reports zero, never a pass (R25)", async () => {
    const { m, d } = await fresh();
    await checkStep(m, d);
    expect(m.foldParity).toBe(0);
    expect([...m.stepChecks.values()].every((n) => n === 0)).toBe(true);
  });
  it("FENCES is non-empty and each names an open issue", () => {
    expect(FENCES.length).toBeGreaterThan(0);
    for (const f of FENCES) expect(f.issue).toMatch(/^#\d+$/);
  });
});

describe("model walkover uses the product's forfeit composition", () => {
  it("a scheduled fixture's walkover posts START then core.forfeit (as HttpDriver.forfeit does)", async () => {
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Walkover", 0, 0]]);
    const f = [...m.fixtures.values()].find((x) => (x.ledger ?? []).some((e) => e.type === "core.forfeit"))!;
    expect(f.ledger!.map((e) => e.type)).toEqual([START.type, "core.forfeit"]);
  });
});
```

`commandOf(kind, k, w, fences)` builds one command directly. `k` picks the candidate and `w` the side or winner. `modelCommands` wraps the same constructor in `fc.nat()` arbitraries, so a hand-written sequence and a generated one run identical code.

`http-driver.test.ts`, appended:

```ts
describe("HttpDriver — rebuild (Task 13)", () => {
  it("POSTs /stages/:id/rebuild with no body and resolves on 2xx", async () => {
    const { t, calls } = fake([(c) => (c.path === "/api/v1/stages/s1/rebuild" ? ok({ created: 3 }) : undefined)]);
    await drv(t).rebuild("s1");
    expect(calls).toMatchObject([{ path: "/api/v1/stages/s1/rebuild", method: "POST", body: {} }]);
  });
  it("a refusal throws RefusedCall with the product's code", async () => {
    const { t } = fake([() => err(409, "STAGE_HAS_RESULTS")]);
    await expect(drv(t).rebuild("s1")).rejects.toMatchObject({ status: 409, code: "STAGE_HAS_RESULTS" });
  });
});
```

- [ ] **Step 3: Run and watch them fail** — use the template with `<N>`=13 and `<files>` = `scripts/matrix/__tests__/fast-check-resolution.test.ts scripts/matrix/__tests__/model-core.test.ts scripts/matrix/__tests__/http-driver.test.ts`. Expected: resolution passes (the dependency landed in Step 1); model-core FAILS TO COLLECT; http-driver fails on `rebuild is not a function`. To confirm the resolution test can fail, see Step 6's mutation.

- [ ] **Step 4: Implement**

`driver/types.ts`: add `rebuild(stageId: string): Promise<void>;` to `OrganiserDriver`.

`http-driver.ts`:

```ts
  async rebuild(stageId: string): Promise<void> {
    // stages.ts rebuildStageFixtures: refuses whole (409 STAGE_HAS_RESULTS) once any fixture carries a result.
    await this.#call<unknown>(`/api/v1/stages/${stageId}/rebuild`, "POST", {});
  }
```

`fake-driver.ts` `FakeLeagueDriver`: `rebuild(): Promise<void> { return settle(() => { this.log("rebuild"); throw new RefusedCall("POST", "/api/v1/stages/s1/rebuild", 422, "UNSUPPORTED_IN_FAKE", "fake: rebuild"); }); }`

`scripts/matrix/lib/model/ledger-fold.ts`:

```ts
// The model's view of one fixture's ledger, folded by the engine exactly as
// the product folds it (foldMatchWithStoppage resolves voids first,
// core/events.ts:525). A core.void's payload is {} — the product lifts
// payload.event_id into the envelope's `voids` (scoring.ts).
import { foldMatchWithStoppage, type EventEnvelope, type MatchOutcome } from "@seazn/engine/core";
import { FOLD_OPTIONS, OFFLINE_RECORDED_AT, lineupsFor } from "../fold.ts";
import { sportModule } from "../sport-cfg.ts";

export interface LedgerEntry { readonly id: string; readonly seq: number; readonly type: string; readonly payload: unknown; readonly voids?: string }

export function ledgerEnvelopes(fixtureId: string, entries: readonly LedgerEntry[]): EventEnvelope[] {
  return entries.map((e) => ({
    id: e.id, fixtureId, seq: e.seq, type: e.type,
    payload: e.type === "core.void" ? {} : e.payload,
    recordedAt: OFFLINE_RECORDED_AT, recordedBy: null,
    ...(e.voids === undefined ? {} : { voids: e.voids }),
  }));
}

/** Entries neither voided nor themselves a void. */
export function liveEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const voided = new Set(entries.flatMap((e) => (e.voids === undefined ? [] : [e.voids])));
  return entries.filter((e) => e.type !== "core.void" && !voided.has(e.id));
}

export function foldLedger(sport: string, cfg: unknown, home: string, away: string, entries: readonly LedgerEntry[]): MatchOutcome | null {
  if (entries.length === 0) return null;
  const m = sportModule(sport);
  const state: unknown = foldMatchWithStoppage(m, cfg as never, lineupsFor(home, away), ledgerEnvelopes("model", entries), FOLD_OPTIONS).state;
  return m.outcome(state);
}
```

`scripts/matrix/lib/model/fences.ts`:

```ts
// Known product bugs the random walk must not rediscover on every run (they
// would dominate every shrink and hide the next bug — Review Focus 3). A
// fence blocks one command while its condition holds; --no-fences lifts all
// of them, and each fenced bug is ALSO a committed regression case (R29).
import type { CommandKind, ModelState } from "./commands.ts";

export interface Fence { readonly id: string; readonly issue: string; readonly blocks: CommandKind; applies(m: ModelState): boolean }

export const FENCES: readonly Fence[] = Object.freeze([
  {
    id: "late-entry-then-generate",
    issue: "#879",
    blocks: "Generate",
    // Round-robin stages only: a late entrant followed by Generate duplicates every existing pair.
    applies: (m: ModelState) => m.lateEntry && (m.stageKind === "league" || m.stageKind === "group"),
  },
]);

export function fenceBlocking(m: ModelState, kind: CommandKind, enabled: boolean): Fence | null {
  if (!enabled) return null;
  return FENCES.find((f) => f.blocks === kind && f.applies(m)) ?? null;
}
```

`fences.ts` imports only types from `commands.ts`, which strip-types erases, so the import cycle is harmless.

`scripts/matrix/lib/model/state.ts` holds the model and its step check. `commands.ts` re-exports these symbols, so tests import from one place:

```ts
// The model the fast-check commands mutate, and the check that runs after
// every command: the step-safe invariants over what the product shows now,
// fold parity for every fixture whose whole ledger the model knows, and — in
// the commands — every refusal named.
import type { FixtureRow, OrganiserDriver } from "../driver/types.ts";
import { evaluateStepInvariants } from "../invariants.ts";
import { sameOutcome, toObservedOutcome, type GenerateObs, type ObservedFixture, type ObservedRun } from "../observed.ts";
import { entrantKindFor, resolveSportCfg } from "../sport-cfg.ts";
import { stagesForRow, type RowKey } from "../catalogue.ts";
import { foldLedger, type LedgerEntry } from "./ledger-fold.ts";

export const COMMAND_KINDS = ["Start", "AddEntrant", "Withdraw", "Score", "Walkover", "Void", "Correct", "Generate", "Rebuild", "Complete"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export interface FixtureModel { id: string; home: string | null; away: string | null; status: string; ledger: LedgerEntry[] | null }

export class ModelViolation extends Error {
  readonly check: string;
  readonly evidence: string[];
  constructor(check: string, evidence: string[]) {
    super(`${check}: ${evidence.slice(0, 3).join("; ")}`);
    this.name = "ModelViolation";
    this.check = check;
    this.evidence = evidence;
  }
}

export interface ModelState {
  readonly sport: string;
  readonly variant: string;
  readonly cfg: unknown;
  readonly kind: "individual" | "pair" | "team";
  readonly stageKind: string;
  readonly stageConfig: Record<string, unknown>;
  readonly divisionId: string;
  readonly stageId: string;
  readonly tag: string;
  entrants: string[];
  withdrawn: Set<string>;
  started: boolean;
  completed: boolean;
  lateEntry: boolean;
  posts: number;
  fixtures: Map<string, FixtureModel>;
  generates: GenerateObs[];
  counts: Record<CommandKind, { ran: number; accepted: number; refused: number }>;
  stepChecks: Map<string, number>;
  foldParity: number;
  fenced: Map<string, number>;
  history: string[];
}

/** A fresh division (not started) with `entrants` entrants on the row's single stage. */
export async function newModelState(input: { driver: OrganiserDriver; row: RowKey; sport: string; variant: string; entrants: number; tag: string; competitionId?: string }): Promise<ModelState> {
  const bodies = stagesForRow(input.row);
  if (bodies.length !== 1) throw new Error(`model: ${input.row} is multi-stage — the model drives single-stage rows (W1a's slice)`);
  const cfg = resolveSportCfg(input.sport, input.variant);
  const kind = entrantKindFor(input.sport, cfg);
  if (kind === "team") throw new Error(`model: ${input.sport} fields teams — rosters are W1-driving`);
  const d = input.driver;
  const competitionId = input.competitionId ?? (await d.createCompetition({ name: `Matrix model ${input.tag}`, slug: `m-${input.tag}`.slice(0, 60) })).id;
  const division = await d.createDivision(competitionId, { name: `Matrix model ${input.tag}`, slug: `d-${input.tag}`.slice(0, 60).toLowerCase().replace(/[^a-z0-9-]+/g, "-"), sportKey: input.sport, variantKey: input.variant });
  const [stage] = await d.postStages(division.id, bodies);
  if (stage === undefined) throw new Error("model: postStages answered no stage");
  const added = await d.addEntrants(division.id, Array.from({ length: input.entrants }, (_, i) => ({ displayName: `Matrix Model ${i + 1}`, seed: i + 1, kind })));
  const zero = () => ({ ran: 0, accepted: 0, refused: 0 });
  return {
    sport: input.sport, variant: input.variant, cfg, kind, stageKind: stage.kind, stageConfig: stage.config,
    divisionId: division.id, stageId: stage.id, tag: input.tag,
    entrants: added.map((e) => e.id), withdrawn: new Set(), started: false, completed: false, lateEntry: false, posts: 0,
    fixtures: new Map(), generates: [],
    counts: Object.fromEntries(COMMAND_KINDS.map((k) => [k, zero()])) as ModelState["counts"],
    stepChecks: new Map(), foldParity: 0, fenced: new Map(), history: [],
  };
}

/** Folds the product's fixture list into the model: new fixtures start with an
 *  empty known ledger; a fixture gone from the list (a rebuild) leaves it. */
export function absorbFixtures(m: ModelState, rows: readonly FixtureRow[]): void {
  const mine = rows.filter((r) => r.stage_id === m.stageId);
  const ids = new Set(mine.map((r) => r.id));
  for (const id of [...m.fixtures.keys()]) if (!ids.has(id)) m.fixtures.delete(id);
  for (const r of mine) {
    const f = m.fixtures.get(r.id);
    if (f === undefined) m.fixtures.set(r.id, { id: r.id, home: r.home_entrant_id, away: r.away_entrant_id, status: r.status, ledger: [] });
    else { f.status = r.status; f.home = r.home_entrant_id; f.away = r.away_entrant_id; }
  }
}

const toObserved = (r: FixtureRow): ObservedFixture => ({
  id: r.id, stageId: r.stage_id, poolId: r.pool_id, roundNo: r.round_no, home: r.home_entrant_id, away: r.away_entrant_id,
  status: r.status, outcome: toObservedOutcome(r.outcome), declared: null,
});

export async function checkStep(m: ModelState, d: OrganiserDriver): Promise<void> {
  const rows = await d.listFixtures(m.divisionId);
  absorbFixtures(m, rows);
  const mine = rows.filter((r) => r.stage_id === m.stageId);
  const run: ObservedRun = {
    caseId: m.tag,
    facts: [...(m.lateEntry ? (["late_entry"] as const) : []), ...(m.withdrawn.size > 0 ? (["withdrawn"] as const) : [])],
    stages: [{
      id: m.stageId, seq: 1, kind: m.stageKind, config: m.stageConfig, field: [...m.entrants], fieldSource: "division",
      fixtures: mine.map(toObserved), standings: [], generates: [...m.generates], pairRounds: [], complete: null,
    }],
    withdrawal: null, configEdit: null,
  };
  for (const c of evaluateStepInvariants(run)) {
    m.stepChecks.set(c.id, (m.stepChecks.get(c.id) ?? 0) + c.checked);
    if (c.verdict === "fail") throw new ModelViolation(c.id, c.evidence.length > 0 ? c.evidence : [c.reason]);
  }
  for (const r of mine) {
    const f = m.fixtures.get(r.id);
    if (f?.ledger == null || f.ledger.length === 0 || r.home_entrant_id === null || r.away_entrant_id === null) continue;
    const want = toObservedOutcome(foldLedger(m.sport, m.cfg, r.home_entrant_id, r.away_entrant_id, f.ledger));
    const got = toObservedOutcome(r.outcome);
    if (!sameOutcome(want, got)) {
      // Events the model did not post (a withdrawal cascade, a retry) make the
      // ledger unknown, not wrong: re-read the tip before calling it a lie.
      const st = await d.fixtureState(r.id);
      if (st.last_seq !== f.ledger.length) { f.ledger = null; continue; }
      throw new ModelViolation("model-fold-parity", [`fixture ${r.id}: product ${JSON.stringify(got)}, engine fold of the ledger ${JSON.stringify(want)} (${f.ledger.length} events)`]);
    }
    m.foldParity++;
  }
}
```

`scripts/matrix/lib/model/commands.ts`:

```ts
// The ten organiser commands of design §7.5, as fast-check async commands over
// (ModelState, OrganiserDriver). Each carries k (which candidate) and w (which
// side / winner) as plain fields, generated by fc.nat() — so a shrunk path
// replays exactly. After every command: checkStep. Every product refusal must
// be named (observed.ts isNamedRefusal), or it is a violation.
import fc from "fast-check";
import { RefusedCall, type OrganiserDriver, type PostedEvent } from "../driver/types.ts";
import { isNamedRefusal, isTerminal } from "../observed.ts";
import { generateStream } from "../streams/index.ts";
import { START, type StreamEvent } from "../streams/types.ts";
import { fenceBlocking } from "./fences.ts";
import { liveEntries, type LedgerEntry } from "./ledger-fold.ts";
import { COMMAND_KINDS, ModelViolation, absorbFixtures, checkStep, type CommandKind, type FixtureModel, type ModelState } from "./state.ts";

export { COMMAND_KINDS, ModelViolation, checkStep, newModelState, type CommandKind, type ModelState } from "./state.ts";

const MAX_ENTRANTS = 8;
const seated = (f: FixtureModel) => f.home !== null && f.away !== null;
const pick = <T>(xs: readonly T[], k: number): T => xs[k % xs.length]!;
const open = (m: ModelState) => [...m.fixtures.values()].filter((f) => seated(f) && f.ledger !== null && f.ledger.length === 0 && !isTerminal(f.status));
const withLive = (m: ModelState) => [...m.fixtures.values()].filter((f) => f.ledger !== null && liveEntries(f.ledger).length > 0);
const decided = (m: ModelState) => [...m.fixtures.values()].filter((f) => seated(f) && f.ledger !== null && f.status === "decided");

abstract class Cmd implements fc.AsyncCommand<ModelState, OrganiserDriver> {
  abstract readonly kind: CommandKind;
  k: number;
  w: number;
  readonly fences: boolean;
  constructor(k: number, w: number, fences: boolean) { this.k = k; this.w = w; this.fences = fences; }
  protected abstract ready(m: ModelState): boolean;
  protected abstract act(m: ModelState, d: OrganiserDriver): Promise<void>;
  check(m: ModelState): boolean {
    if (!this.ready(m)) return false;
    const fence = fenceBlocking(m, this.kind, this.fences);
    if (fence !== null) { m.fenced.set(fence.id, (m.fenced.get(fence.id) ?? 0) + 1); return false; }
    return true;
  }
  async run(m: ModelState, d: OrganiserDriver): Promise<void> {
    m.counts[this.kind].ran++;
    m.history.push(this.toString());
    try {
      await this.act(m, d);
      m.counts[this.kind].accepted++;
    } catch (e) {
      if (!(e instanceof RefusedCall)) throw e;
      if (!isNamedRefusal(e.status, e.code)) throw new ModelViolation("model-refusal-named", [`${this.toString()}: ${e.method} ${e.path} → ${e.status} ${e.code ?? "(no code)"}`]);
      m.counts[this.kind].refused++;
      this.onRefused(m, e);
    }
    await checkStep(m, d);
  }
  protected onRefused(_m: ModelState, _e: RefusedCall): void {}
  toString(): string { return `${this.kind}(${this.k},${this.w})`; }
}

/** Posts events and records them in the fixture's ledger. A refusal part-way
 *  leaves the ledger unknown (the posted prefix is not reported). */
async function post(m: ModelState, d: OrganiserDriver, f: FixtureModel, events: readonly StreamEvent[], voids?: string): Promise<PostedEvent[]> {
  const prefix = `${m.tag}:${f.id}:p${++m.posts}`;
  try {
    const out = await d.postStream(f.id, events, prefix);
    out.forEach((p, i) => f.ledger?.push({ id: p.event_id, seq: p.seq, type: events[i]!.type, payload: events[i]!.payload, ...(voids === undefined ? {} : { voids }) }));
    const last = out.at(-1);
    if (last !== undefined) f.status = last.status;
    return out;
  } catch (e) {
    f.ledger = null;
    throw e;
  }
}

const winStream = (m: ModelState, f: FixtureModel, winner: "home" | "away") =>
  generateStream({ sportKey: m.sport, cfg: m.cfg, stageKind: m.stageKind as never, home: f.home!, away: f.away!, outcome: { kind: "win", winner } });

class Start extends Cmd {
  readonly kind = "Start" as const;
  protected ready(m: ModelState) { return !m.started; }
  protected async act(m: ModelState, d: OrganiserDriver) {
    await d.start(m.divisionId);
    m.started = true;
    absorbFixtures(m, await d.listFixtures(m.divisionId));
  }
}
class AddEntrant extends Cmd {
  readonly kind = "AddEntrant" as const;
  protected ready(m: ModelState) { return m.entrants.length < MAX_ENTRANTS && !m.completed; }
  protected async act(m: ModelState, d: OrganiserDriver) {
    const n = m.entrants.length + 1;
    const [e] = await d.addEntrants(m.divisionId, [{ displayName: `Matrix Model ${n}`, seed: n, kind: m.kind }]);
    if (e !== undefined) m.entrants.push(e.id);
    if (m.started) m.lateEntry = true;
  }
}
class Withdraw extends Cmd {
  readonly kind = "Withdraw" as const;
  protected ready(m: ModelState) { return m.started && m.withdrawn.size === 0 && m.entrants.length > 2; }
  protected async act(m: ModelState, d: OrganiserDriver) {
    const id = pick(m.entrants, this.k);
    await d.withdraw(id);
    m.withdrawn.add(id);
    // The cascade posts events the model did not write: those ledgers are unknown now.
    for (const f of m.fixtures.values()) if (f.home === id || f.away === id) f.ledger = null;
  }
}
class Score extends Cmd {
  readonly kind = "Score" as const;
  protected ready(m: ModelState) { return m.started && open(m).length > 0; }
  protected async act(m: ModelState, d: OrganiserDriver) {
    const f = pick(open(m), this.k);
    await post(m, d, f, winStream(m, f, this.w % 2 === 0 ? "home" : "away"));
  }
}
class Walkover extends Cmd {
  readonly kind = "Walkover" as const;
  protected ready(m: ModelState) { return m.started && open(m).length > 0; }
  protected async act(m: ModelState, d: OrganiserDriver) {
    const f = pick(open(m), this.k);
    const by = this.w % 2 === 0 ? f.home! : f.away!;
    // HttpDriver.forfeit's composition on a scheduled fixture (http-driver.ts:170-176).
    await post(m, d, f, [START, { type: "core.forfeit", payload: { by, reason: "walkover" } }]);
  }
}
class Void extends Cmd {
  readonly kind = "Void" as const;
  protected ready(m: ModelState) { return m.started && withLive(m).length > 0; }
  protected async act(m: ModelState, d: OrganiserDriver) {
    const f = pick(withLive(m), this.k);
    const target = liveEntries(f.ledger!).at(-1)!;
    await post(m, d, f, [{ type: "core.void", payload: { event_id: target.id } }], target.id);
  }
}
class Correct extends Cmd {
  readonly kind = "Correct" as const;
  protected ready(m: ModelState) { return m.started && decided(m).length > 0; }
  protected async act(m: ModelState, d: OrganiserDriver) {
    const f = pick(decided(m), this.k);
    const live: LedgerEntry[] = [...liveEntries(f.ledger!)].reverse();
    for (const t of live) await post(m, d, f, [{ type: "core.void", payload: { event_id: t.id } }], t.id);
    await post(m, d, f, winStream(m, f, this.w % 2 === 0 ? "away" : "home"));
  }
}
class Generate extends Cmd {
  readonly kind = "Generate" as const;
  protected ready(m: ModelState) { return m.started && !m.completed; }
  protected async act(m: ModelState, d: OrganiserDriver) {
    const g = await d.generate(m.stageId);
    m.generates.push({ status: 200, code: null, total: g.fixtures.length, created: g.created });
    absorbFixtures(m, await d.listFixtures(m.divisionId));
  }
  protected override onRefused(m: ModelState, e: RefusedCall) { m.generates.push({ status: e.status, code: e.code, total: 0, created: 0 }); }
}
class Rebuild extends Cmd {
  readonly kind = "Rebuild" as const;
  protected ready(m: ModelState) { return m.started && !m.completed; }
  protected async act(m: ModelState, d: OrganiserDriver) {
    await d.rebuild(m.stageId);
    absorbFixtures(m, await d.listFixtures(m.divisionId));
  }
}
class Complete extends Cmd {
  readonly kind = "Complete" as const;
  protected ready(m: ModelState) { return m.started && !m.completed; }
  protected async act(m: ModelState, d: OrganiserDriver) {
    await d.completeStage(m.stageId);
    m.completed = true;
  }
  // A named (4xx) refusal committed nothing and stays retryable (HttpDriver,
  // design §6.4). A 5xx is never named, so it ends the run as a violation
  // before HttpDriver's never-repeat guard could matter.
}

const CTORS: Readonly<Record<CommandKind, new (k: number, w: number, fences: boolean) => Cmd>> = {
  Start, AddEntrant, Withdraw, Score, Walkover, Void, Correct, Generate, Rebuild, Complete,
};

export function commandOf(kind: CommandKind, k: number, w: number, fences: boolean): fc.AsyncCommand<ModelState, OrganiserDriver> {
  return new CTORS[kind](k, w, fences);
}

export function modelCommands(opts: { fences: boolean }): fc.Arbitrary<fc.AsyncCommand<ModelState, OrganiserDriver>>[] {
  return COMMAND_KINDS.map((kind) => fc.tuple(fc.nat({ max: 63 }), fc.nat({ max: 1 })).map(([k, w]) => commandOf(kind, k, w, opts.fences)));
}
```

`scripts/matrix/__tests__/model-fake-driver.ts`:

```ts
// A league-only product for the model's unit tests: appends late entrants,
// generates only missing pairs, folds each fixture's ledger with voids through
// the engine, refuses a rebuild once any fixture has a result (stages.ts: 409
// STAGE_HAS_RESULTS). With fault879 it reproduces issue #879's SHAPE, not a
// blanket fault: only once an entrant has been added AFTER the stage started
// does Generate seat every pair again (pre-flight ruling R-PF8). Before that,
// fault879 generates exactly as the correct product does, so the fenced run
// sees no failure and the shrunk path must contain the late AddEntrant.
import { RefusedCall, type EntrantKind, type EntrantRow, type FixtureStateOut, type GenerateOut, type PostedEvent } from "../lib/driver/types.ts";
import { foldLedger, type LedgerEntry } from "../lib/model/ledger-fold.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { FakeLeagueDriver, type FakeFixture } from "./fake-driver.ts";

type Opts = { fault879?: boolean; lieOutcome?: boolean; unnamedCompleteRefusal?: boolean };

export class ModelFakeDriver extends FakeLeagueDriver {
  readonly opts: Opts;
  readonly ledgers = new Map<string, LedgerEntry[]>();
  #eventNo = 0;
  /** An entrant was added after the stage started (#879's trigger). Reset per division. */
  #lateEntrant = false;
  constructor(opts: Opts = {}) { super("org-model"); this.opts = opts; }
  /** One driver serves every property run of a cell (model.ts), as HttpDriver
   *  does: a new division starts empty. Fixture ids keep counting (minted). */
  override createDivision(c: string, i: Parameters<FakeLeagueDriver["createDivision"]>[1]): ReturnType<FakeLeagueDriver["createDivision"]> {
    this.entrants = [];
    this.fixtures = [];
    this.ledgers.clear();
    this.stage = null;
    this.completed = false;
    this.#lateEntrant = false;
    return super.createDivision(c, i);
  }
  override addEntrants(_d: string, es: readonly { displayName: string; seed: number; kind: EntrantKind }[]): Promise<EntrantRow[]> {
    return Promise.resolve().then(() => {
      this.log("addEntrants");
      // FakeLeagueDriver.start() flips the stage from "pending" to "active".
      if (es.length > 0 && this.stage !== null && this.stage.status !== "pending") this.#lateEntrant = true;
      const made = es.map((e, i) => ({ id: `e${this.entrants.length + i + 1}`, display_name: e.displayName, seed: e.seed, status: "registered" }));
      this.entrants = [...this.entrants, ...made];
      return made.map((e) => ({ ...e }));
    });
  }
  override generate(): Promise<GenerateOut> {
    return Promise.resolve().then(() => {
      this.log("generate");
      const key = (a: string, b: string) => (a < b ? `${a}~${b}` : `${b}~${a}`);
      const have = new Set(this.fixtures.map((f) => key(f.home_entrant_id!, f.away_entrant_id!)));
      const duplicates = this.opts.fault879 === true && this.#lateEntrant; // #879 needs roster growth after start
      let created = 0;
      for (const [r, pairs] of this.circle().entries()) for (const [h, a] of pairs) {
        if (h === "BYE" || a === "BYE") continue;
        if (!duplicates && have.has(key(h, a))) continue;
        this.seat(100 + r, h, a);
        created++;
      }
      return { created, existing: this.fixtures.length - created, fixtures: this.rows() };
    });
  }
  override postStream(id: string, events: readonly StreamEvent[]): Promise<PostedEvent[]> {
    return Promise.resolve().then(() => {
      this.log("postStream");
      const f = this.fixtures.find((x) => x.id === id)!;
      const ledger = this.ledgers.get(id) ?? [];
      const out: PostedEvent[] = [];
      for (const ev of events) {
        const eid = `ev${++this.#eventNo}`;
        const target = ev.type === "core.void" ? String((ev.payload as { event_id: string }).event_id) : undefined;
        const next = [...ledger, { id: eid, seq: ledger.length + 1, type: ev.type, payload: ev.type === "core.void" ? {} : ev.payload, ...(target === undefined ? {} : { voids: target }) }];
        let outcome: unknown;
        try { outcome = foldLedger(this.sport, this.cfg, f.home_entrant_id!, f.away_entrant_id!, next); } catch (e) {
          throw new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 422, "INVALID_EVENT", (e as Error).message);
        }
        ledger.push(next.at(-1)!);
        f.events = [...f.events, ev];
        f.outcome = this.opts.lieOutcome && outcome !== null ? { ...(outcome as object), winner: "nobody" } : outcome;
        f.status = outcome === null ? "in_play" : ledger.some((e) => e.type === "core.forfeit" && !ledger.some((v) => v.voids === e.id)) ? "forfeited" : "decided";
        out.push({ seq: ledger.length, status: f.status, outcome: f.outcome, event_id: eid });
      }
      this.ledgers.set(id, ledger);
      return out;
    });
  }
  override fixtureState(id: string): Promise<FixtureStateOut> {
    return Promise.resolve().then(() => { const f = this.fixtures.find((x) => x.id === id)!; return { status: f.status, last_seq: (this.ledgers.get(id) ?? []).length, outcome: f.outcome }; });
  }
  override rebuild(): Promise<void> {
    return Promise.resolve().then(() => {
      this.log("rebuild");
      if (this.fixtures.some((f: FakeFixture) => f.outcome !== null)) throw new RefusedCall("POST", "/api/v1/stages/s1/rebuild", 409, "STAGE_HAS_RESULTS", "stage already has recorded results");
      this.fixtures = [];
      for (const [r, pairs] of this.circle().entries()) for (const [h, a] of pairs) if (h !== "BYE" && a !== "BYE") this.seat(r + 1, h, a);
    });
  }
  override completeStage(): ReturnType<FakeLeagueDriver["completeStage"]> {
    if (this.opts.unnamedCompleteRefusal) return Promise.reject(new RefusedCall("POST", "/api/v1/stages/s1/complete", 500, null, "boom"));
    return super.completeStage();
  }
}
```

Before relying on it, confirm that `FakeLeagueDriver.withdraw` exists and cascades in a way the model tolerates (`fake-driver.ts:189`). The model marks the withdrawn entrant's ledgers unknown whatever the fake does.

`isNamedRefusal` (`observed.ts:99-101`) is false for any 5xx and for the generic codes, `PAYMENT_REQUIRED` included. The model therefore treats a 402 as unnamed, which is right for these commands: none of them is gated. The DENIED scenario judges its 402 by status, code and `feature_key` explicitly (Task 9), never through `isNamedRefusal`.

- [ ] **Step 5: Run and see them pass** — same command as Step 3. Expected: green, `files` = 3. Then run `strip-types-loadable.test.ts` with the four model modules added to its list.

- [ ] **Step 6: Mutation check**

- `fast-check-resolution`: temporarily point the test's expected prefix at `${REPO}/../node_modules` (by hand, restored from `cp`) → it reds. This proves the check discriminates.
- `checkStep` without the invariant loop → killed by "#879 … → I7 at that step".
- `checkStep` without the parity loop → killed by "a product that lies".
- The `st.last_seq !== f.ledger.length` escape widened to `true` → killed by "a product that lies".
- `Cmd.run` swallows unnamed refusals → killed by "an unnamed refusal".
- `fenceBlocking` ignores `enabled` → killed by the fence test (`fenceBlocking(m, "Generate", false)` must be null).
- `open(m)` without `ledger.length === 0` → killed by the Walkover composition test (a second START is posted onto a decided fixture, and the fake refuses it by name, which leaves the Walkover composition assertion false).
- `liveEntries` ignores voids → killed by the ledger-fold void test.
- `ModelFakeDriver.generate`'s `duplicates` without `&& this.#lateEntrant` (the blanket fault) → killed by "#879 needs a late entrant" (R-PF8). The inverse, `#lateEntrant` never set in `addEntrants` → killed by "#879: a late entrant then Generate duplicates pairs".

- [ ] **Step 7: Scoped tsc + eslint** on `scripts/matrix/lib/model/*.ts scripts/matrix/lib/driver/types.ts scripts/matrix/lib/driver/http-driver.ts scripts/matrix/__tests__/model-fake-driver.ts`.

- [ ] **Step 8: Commit** — `feat(matrix): the fast-check model core — void-aware ledger fold, ten organiser commands, step checks and the #879 fence`.

---

## Task 14: The model runner — per-cell `fc.check`, logged seeds, anti-vacuity, known vs new failures, `model.ts` CLI

Each cell runs `fc.check` over `fc.commands`, and each run of the property builds a fresh division in the cell's org. Four rules govern the output:
- The seed is derived from `(runId, cell)` with no clock, logged, and written to the report.
- A failure prints its seed, its path and the shrunk command list.
- A failure that matches a committed open regression (same cell and check) is **known**; any other is **new**, and exits 1.
- Per cell, zero is a failure: every command kind ran, a Score was accepted, each step invariant checked more than zero items, and fold parity compared more than zero fixtures (R25).

**Controller amendment after Task 13's fix rounds (binding; it overrides any code block below that disagrees).** Task 13 grew `ModelState` after this task was written. Read `scripts/matrix/lib/model/state.ts` for the real shape before coding. The reducer and report must carry the new fields:
- **`counts`:** `CommandCounts` is now `{ ran, accepted, refused, expected, unexpected }`. `absorb` sums all five, with no `as` cast that drops fields. `CellReport.counts` carries all five.
- **Unknown ledgers:** `absorb` also sums `m.unknowns` into `CellReport.unknowns: Record<"retried" | "tip-moved", number>`.
- **Findings:** it merges `m.findings` into `CellReport.findings: Record<string, { count: number; evidence: string[] }>`, keeping at most 3 evidence lines per id.
- **Informative steps:** it sums `informativeSteps(m).checked` (state.ts; a `CheckResult` whose `checked` is the accepted-step count) into `CellReport.informativeSteps: number`. Aggregate **per cell, across runs**; one uninformative run is not a vacuous cell.
- **Vacuity:** the vacuity block adds `informativeSteps === 0` → `vacuous.push("no informative step (model-informative-steps)")`.
- **Unexpected refusals:** a non-zero `counts[k].unexpected` for any kind is reported as a NEW failure with check `model-unexpected-refusal` (unless a committed open regression matches), not merely counted.
- **CLI output:**
  - `model.ts` prints one `finding <id> ×<count>` line per finding id. A known finding (e.g. `CD-T13b`) never changes the exit code.
  - The report JSON carries `unknowns`, `findings` and `informativeSteps` per cell.
- **fast-check size:** pick the `fc.commands` size and `maxCommands` default. The fast-check default yields about 2 accepted steps per run. Measure accepted steps per run on the fake with the chosen setting, and record the number in the report file.
- **#879 test:** the fences-OFF test expects the pre-Start shape `Generate → AddEntrant → Generate` with no Start (the test below is already amended).

**Files:**
- Create: `scripts/matrix/lib/model/run-cell.ts`, `scripts/matrix/model.ts`
- Modify: `package.json` (`"matrix:model": "node --experimental-strip-types scripts/matrix/model.ts"`), `.gitignore` if `matrix-report/` does not already cover the new report (it does; the test pins it)
- Test: `scripts/matrix/__tests__/model-run-cell.test.ts`, `scripts/matrix/__tests__/model-cli.test.ts` (new); add both modules to `strip-types-loadable.test.ts`

**Interfaces:**
- Consumes:
  - `modelCommands`, `newModelState`, `ModelViolation`, `COMMAND_KINDS`, `STEP_INVARIANTS`, `FENCES` (Task 13)
  - `RegressionCase`, `loadRegressions` (Task 4)
  - `realDeps`, `describeCommit`, `EXIT`, `RUN_ID_MAX` (run.ts)
  - `findSecrets`, `redact` (redact.ts)
  - `stringsIn`, `SecretInResults` (results.ts)
  - `SLICE_ROWS`, `SLICE_SPORTS` (slice.ts)
  - `builderDefaultVariant`, `cellId` (catalogue.ts)
  - `offlineBuilderDefault` (variants.ts)
- Produces:
  - `seedFor(runId: string, cell: string): number` (FNV-1a 32-bit, as a signed int for fast-check)
  - `interface CellFailure { check: string; seed: number; path: string; replayPath: string | null; commands: string[]; evidence: string[]; known: string | null }` — `commands` lists only the commands that RAN (`CommandWrapper.hasRan`), and `replayPath` is the counterexample's `metadataForReplay()` hint (R-PF9)
  - `interface CellReport { cell: string; variant: string; seed: number; runs: number; numRuns: number; interrupted: boolean; counts: ModelState["counts"] (summed); stepChecks: Record<string, number>; foldParity: number; fenced: Record<string, number>; vacuous: string[]; failure: CellFailure | null }`
  - `runCell(input: RunCellInput): Promise<CellReport>`
  - `interface RunCellInput { cell: string; row: RowKey; sport: string; variant: string; newDriverState: (n: number) => Promise<{ model: ModelState; real: OrganiserDriver }>; runs: number; maxCommands: number; seed: number; path?: string; replayPath?: string; fences: boolean; timeLimitMs: number; regressions: readonly RegressionCase[] }`
  - `model.ts`: `fnv1a32(text): number`, `runModel(deps: ModelDeps, argv: string[]): Promise<number>`, `interface ModelDeps extends Pick<RunDeps, "env" | "harnessCommit" | "preflight" | "openDb" | "signIn" | "prepareCaseOrg" | "driverFor"> {}`, `MODEL_USAGE`

- [ ] **Step 1: Write the failing tests**

`scripts/matrix/__tests__/model-run-cell.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { COMMAND_KINDS, newModelState } from "../lib/model/commands.ts";
import { runCell, type RunCellInput } from "../lib/model/run-cell.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

const input = (over: Partial<RunCellInput> & { fault879?: boolean } = {}): RunCellInput => {
  const { fault879, ...rest } = over;
  return {
    cell: "league|generic", row: "league", sport: "generic", variant: "score",
    newDriverState: async (n) => {
      const real = new ModelFakeDriver({ fault879: fault879 === true });
      return { real, model: await newModelState({ driver: real, row: "league", sport: "generic", variant: "score", entrants: 4, tag: `t${n}` }) };
    },
    runs: 40, maxCommands: 12, seed: 42, fences: true, timeLimitMs: 60_000, regressions: [],
    ...rest,
  };
};

describe("runCell", () => {
  it("empty case first: one run of one command is VACUOUS — reported, never a pass", async () => {
    const r = await runCell(input({ runs: 1, maxCommands: 1 }));
    expect(r.failure).toBeNull();
    expect(r.vacuous.length).toBeGreaterThan(0);
  });
  it("a correct product: no failure; every kind ran; Score accepted; each step invariant and fold parity counted > 0", async () => {
    const r = await runCell(input());
    expect(r.failure, JSON.stringify(r.failure)).toBeNull();
    expect(r.vacuous).toEqual([]);
    for (const k of COMMAND_KINDS) expect(r.counts[k].ran, k).toBeGreaterThan(0);
    expect(r.stepChecks["I7-rr-no-pair-over-legs"]).toBeGreaterThan(0);
    expect(r.stepChecks["I8-generate-named"]).toBeGreaterThan(0);
    expect(r.foldParity).toBeGreaterThan(0);
    expect(r.numRuns).toBe(40);
    expect(r.seed).toBe(42);
  });
  it("Review Focus 3 — fenced: #879 present, fences ON → no failure, and the fence fired (the walk kept exploring past it)", async () => {
    const r = await runCell(input({ fault879: true }));
    expect(r.failure).toBeNull();
    expect(r.fenced["late-entry-then-generate"]).toBeGreaterThan(0);
  });
  it("fences OFF → #879 found on I7; the shrunk path is Generate, AddEntrant, Generate before any Start; seed and path logged", async () => {
    const r = await runCell(input({ fault879: true, fences: false }));
    expect(r.failure?.check).toBe("I7-rr-no-pair-over-legs");
    const cmds = r.failure!.commands.map((c) => c.split("(")[0]);
    // #879 is pre-Start (T13 fix round 1): after Start the roster lock refuses AddEntrant.
    expect(cmds.indexOf("Start")).toBe(-1);
    expect(cmds.indexOf("Generate")).toBeGreaterThan(-1);
    expect(cmds.indexOf("AddEntrant")).toBeGreaterThan(cmds.indexOf("Generate"));
    expect(cmds.lastIndexOf("Generate")).toBeGreaterThan(cmds.indexOf("AddEntrant"));
    // Only commands that RAN are listed (R-PF9): the step that threw is the last one.
    expect(cmds.at(-1)).toBe("Generate");
    expect(r.failure!.path.length).toBeGreaterThan(0);
    expect(r.failure!.replayPath).toMatch(/\S/);
    expect(r.failure!.known).toBeNull();
  });
  it("replay: the reported seed + path + replayPath reproduce the same failure and the same shrunk commands (R29, R-PF9)", async () => {
    const first = await runCell(input({ fault879: true, fences: false }));
    const again = await runCell(input({ fault879: true, fences: false, seed: first.failure!.seed, path: first.failure!.path, replayPath: first.failure!.replayPath ?? undefined, runs: 1 }));
    expect(again.failure?.check).toBe(first.failure!.check);
    expect(again.failure?.commands).toEqual(first.failure!.commands);
    expect(again.failure?.replayPath).toBe(first.failure!.replayPath);
  });
  it("a failure matching an OPEN committed regression on the same cell and check is known, by id", async () => {
    const reg = { id: "MB-001", title: "#879", issue: "#879", cell: "league|generic", variant: "score", check: "I7-rr-no-pair-over-legs", seed: 1, path: "0", replayPath: null, fence: "late-entry-then-generate", status: "open" as const, found: "2026-09-28", runId: "t" };
    const r = await runCell(input({ fault879: true, fences: false, regressions: [reg] }));
    expect(r.failure?.known).toBe("MB-001");
    const fixed = await runCell(input({ fault879: true, fences: false, regressions: [{ ...reg, status: "fixed" }] }));
    expect(fixed.failure?.known).toBeNull();
  });
  it("deterministic: the same seed gives the same report", async () => {
    expect(await runCell(input({ runs: 15 }))).toEqual(await runCell(input({ runs: 15 })));
  });
});
```

`scripts/matrix/__tests__/model-cli.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_USAGE, fnv1a32, runModel, seedFor, type ModelDeps } from "../model.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

afterEach(() => { vi.restoreAllMocks(); });
const quiet = () => { const err: string[] = []; vi.spyOn(process.stdout, "write").mockImplementation(() => true); vi.spyOn(process.stderr, "write").mockImplementation((s) => { err.push(String(s)); return true; }); return err; };
const deps = (over: Partial<ModelDeps> & { fault879?: boolean } = {}): ModelDeps => ({
  env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999" },
  harnessCommit: async () => "abc1234",
  preflight: async () => ({ ok: true, refusals: [] }),
  openDb: async () => ({ userIdForEmail: async () => "u1", variantKeysInBuilderOrder: async (s: string) => (s === "generic" ? ["score", "win_loss"] : ["bwf", "short"]), chooseTopPublicPlan: async () => "pro", dispose: async () => {} }),
  signIn: async () => ({ cookies: {} }),
  prepareCaseOrg: async (_c, i) => ({ orgId: `org-${i.slug}`, orgSlug: i.slug }),
  driverFor: () => new ModelFakeDriver({ fault879: over.fault879 === true }),
  ...over,
});

describe("model.ts", () => {
  it("fnv1a32 matches the published FNV-1a 32-bit vectors; seedFor hashes `${runId}|${cell}`", () => {
    // Test vectors from the FNV reference (isthe.com/chongo/tech/comp/fnv): "" → 0x811c9dc5, "a" → 0xe40c292c, "foobar" → 0xbf9cf968.
    expect(fnv1a32("")).toBe(0x811c9dc5 | 0);
    expect(fnv1a32("a")).toBe(0xe40c292c | 0);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968 | 0);
    expect(seedFor("a", "league|generic")).toBe(fnv1a32("a|league|generic"));
    expect(seedFor("a", "league|generic")).not.toBe(seedFor("b", "league|generic"));
  });
  it("usage refusals exit 2 before any DB work: unknown cell, bad --runs, --path without --seed, --replay-path without --path", async () => {
    quiet();
    const d = deps({ openDb: async () => { throw new Error("must not open"); } });
    expect(await runModel(d, ["--cell", "nope|generic"])).toBe(2);
    expect(await runModel(d, ["--runs", "0"])).toBe(2);
    expect(await runModel(d, ["--path", "0:1"])).toBe(2);
    expect(await runModel(d, ["--seed", "1", "--replay-path", "CC:B"])).toBe(2);
    expect(MODEL_USAGE).toMatch(/--no-fences/);
    expect(MODEL_USAGE).toMatch(/--replay-path/);
  });
  it("a fenced run over one cell exits 0 and writes model-report.json with the logged seed", async () => {
    quiet();
    const dir = mkdtempSync(join(tmpdir(), "w1b-model-"));
    expect(await runModel(deps(), ["--run-id", "mr", "--report-dir", dir, "--cell", "league|generic", "--runs", "40", "--max-commands", "12"])).toBe(0);
    const rep = JSON.parse(readFileSync(join(dir, "mr", "model-report.json"), "utf8")) as { cells: { cell: string; seed: number; failure: unknown; vacuous: string[] }[] };
    expect(rep.cells.map((c) => c.cell)).toEqual(["league|generic"]);
    expect(rep.cells[0]!.seed).toBe(seedFor("mr", "league|generic"));
    expect(rep.cells[0]!.failure).toBeNull();
  });
  it("a NEW failure exits 1 and prints a regression stub carrying seed and path", async () => {
    const err = quiet();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
    const dir = mkdtempSync(join(tmpdir(), "w1b-model-"));
    expect(await runModel(deps({ fault879: true }), ["--run-id", "mr2", "--report-dir", dir, "--cell", "league|generic", "--runs", "40", "--max-commands", "12", "--no-fences"])).toBe(1);
    expect(out.join("") + err.join("")).toMatch(/"check": "I7-rr-no-pair-over-legs"[\s\S]*"seed": -?\d+[\s\S]*"path": "/);
  });
  it("a vacuous cell exits 1 (R25)", async () => {
    quiet();
    expect(await runModel(deps(), ["--run-id", "mr3", "--report-dir", mkdtempSync(join(tmpdir(), "w1b-model-")), "--cell", "league|generic", "--runs", "1", "--max-commands", "1"])).toBe(1);
  });
});
```

- [ ] **Step 2: Run and watch them fail** — use the template with `<N>`=14 and `<files>` = `scripts/matrix/__tests__/model-run-cell.test.ts scripts/matrix/__tests__/model-cli.test.ts`. Expected: both FAIL TO COLLECT.

- [ ] **Step 3: Implement**

`scripts/matrix/lib/model/run-cell.ts`:

```ts
// One cell's model run: fc.check over fc.commands, each property run on a
// fresh division. Seeded (the caller derives the seed; nothing here reads a
// clock), path-replayable, time-boxed. A shrunk failure reports its check,
// seed, path and command list; it is KNOWN when an open committed regression
// names the same cell and check (R29). Anti-vacuity per cell (R25).
import fc from "fast-check";
import type { RowKey } from "../catalogue.ts";
import type { OrganiserDriver } from "../driver/types.ts";
import { STEP_INVARIANTS } from "../invariants.ts";
import type { RegressionCase } from "../scenario-catalogue.ts";
import { COMMAND_KINDS, ModelViolation, modelCommands, type ModelState } from "./commands.ts";

export interface RunCellInput {
  cell: string; row: RowKey; sport: string; variant: string;
  newDriverState: (n: number) => Promise<{ model: ModelState; real: OrganiserDriver }>;
  runs: number; maxCommands: number; seed: number; path?: string; replayPath?: string; fences: boolean; timeLimitMs: number;
  regressions: readonly RegressionCase[];
}
export interface CellFailure { check: string; seed: number; path: string; replayPath: string | null; commands: string[]; evidence: string[]; known: string | null }

/** The shape fast-check 3.23 hands back as `counterexample[0]` for
 *  `fc.commands` (CommandsIterable; re-pinned in node_modules/fast-check/lib/types). */
type RanCommands = { commands: readonly { hasRan: boolean; toString(): string }[]; metadataForReplay(): string };
/** `metadataForReplay()` is `replayPath="<json string>"`, or "" when the log is disabled. */
const replayPathOf = (shrunk: RanCommands): string | null => {
  const m = /^replayPath=(".*")$/.exec(shrunk.metadataForReplay());
  return m === null ? null : (JSON.parse(m[1]!) as string);
};
export interface CellReport {
  cell: string; variant: string; seed: number; runs: number; numRuns: number; interrupted: boolean;
  counts: ModelState["counts"]; stepChecks: Record<string, number>; foldParity: number; fenced: Record<string, number>;
  vacuous: string[]; failure: CellFailure | null;
}

export async function runCell(input: RunCellInput): Promise<CellReport> {
  const counts = Object.fromEntries(COMMAND_KINDS.map((k) => [k, { ran: 0, accepted: 0, refused: 0 }])) as ModelState["counts"];
  const stepChecks: Record<string, number> = {};
  const fenced: Record<string, number> = {};
  let foldParity = 0;
  let n = 0;
  let last: ModelState | null = null;
  const absorb = (m: ModelState) => {
    for (const k of COMMAND_KINDS) { counts[k].ran += m.counts[k].ran; counts[k].accepted += m.counts[k].accepted; counts[k].refused += m.counts[k].refused; }
    for (const [id, c] of m.stepChecks) stepChecks[id] = (stepChecks[id] ?? 0) + c;
    for (const [id, c] of m.fenced) fenced[id] = (fenced[id] ?? 0) + c;
    foldParity += m.foldParity;
  };
  const constraints = { maxCommands: input.maxCommands, ...(input.replayPath === undefined ? {} : { replayPath: input.replayPath }) };
  const prop = fc.asyncProperty(fc.commands(modelCommands({ fences: input.fences }), constraints), async (cmds) => {
    const setup = await input.newDriverState(++n);
    last = setup.model;
    try {
      await fc.asyncModelRun(() => setup, cmds);
    } finally {
      absorb(setup.model);
    }
  });
  const details = await fc.check(prop, {
    seed: input.seed, numRuns: input.runs, interruptAfterTimeLimit: input.timeLimitMs, markInterruptAsFailure: false,
    ...(input.path === undefined ? {} : { path: input.path }),
  });
  let failure: CellFailure | null = null;
  if (details.failed) {
    const err: unknown = (details as { errorInstance?: unknown }).errorInstance ?? details.error;
    const check = err instanceof ModelViolation ? err.check : "model-error";
    const evidence = err instanceof ModelViolation ? err.evidence : [err instanceof Error ? `${err.name}: ${err.message}` : String(err)];
    const shrunk = details.counterexample?.[0] as RanCommands | undefined;
    // Only the commands that ran: the shrunk iterable also holds generated
    // commands the failing run never reached (R-PF9).
    const commands = shrunk === undefined ? [] : shrunk.commands.filter((c) => c.hasRan).map((c) => c.toString());
    const reg = input.regressions.find((r) => r.status === "open" && r.cell === input.cell && r.check === check);
    failure = { check, seed: details.seed, path: details.counterexamplePath ?? "", replayPath: shrunk === undefined ? null : replayPathOf(shrunk), commands, evidence, known: reg?.id ?? null };
  }
  const vacuous: string[] = [];
  if (failure === null) {
    for (const k of COMMAND_KINDS) if (counts[k].ran === 0) vacuous.push(`command ${k} never ran`);
    if (counts.Score.accepted === 0) vacuous.push("no Score was accepted");
    // I6 is swiss-only: a league cell owes it no count; a swiss cell does.
    const kind = last === null ? null : (last as ModelState).stageKind;
    for (const s of STEP_INVARIANTS) {
      const applies = s.stageKinds === "any" || (kind !== null && s.stageKinds.includes(kind));
      if (applies && (stepChecks[s.id] ?? 0) === 0) vacuous.push(`step invariant ${s.id} checked zero items`);
    }
    if (foldParity === 0) vacuous.push("fold parity compared zero fixtures");
  }
  return { cell: input.cell, variant: input.variant, seed: input.seed, runs: input.runs, numRuns: details.numRuns, interrupted: details.interrupted, counts, stepChecks, foldParity, fenced, vacuous, failure };
}
```

Re-pin these fast-check v3 names in `node_modules/fast-check/lib/types` before typing the code: `fc.check`'s `RunDetails` fields (`failed`, `interrupted`, `numRuns`, `seed`, `counterexample`, `counterexamplePath`, `error`, `errorInstance`) and the `fc.commands` constraints `maxCommands` and `replayPath`. Keep only the names that exist. For `counterexample[0]` (R-PF9), `CommandsIterable` exposes `commands: CommandWrapper[]` and `metadataForReplay(): string`, and each `CommandWrapper` carries `hasRan: boolean`: check with `grep -a "commands:\|metadataForReplay\|hasRan" node_modules/fast-check/lib/types/check/model/commands/CommandsIterable.d.ts node_modules/fast-check/lib/types/check/model/commands/CommandWrapper.d.ts`. Checked at plan time on fast-check 3.23.2: a 6-command counterexample of which 3 ran printed `replayPath="CC:B"`, and `fc.check` with `{ seed, path, numRuns: 1 }` plus `fc.commands(…, { replayPath: "CC:B" })` reproduced the same three commands. Listing the whole iterable, as the first draft did, listed all six.

`scripts/matrix/model.ts`:

```ts
// The fast-check model over W1a's slice, run live (design §7.5, R29):
//   npm run matrix:model -- [--run-id ID] [--report-dir DIR] [--cell row|sport]...
//     [--runs 20] [--max-commands 10] [--seed N --path P [--replay-path R]] [--no-fences]
//     [--regressions] [--time-limit MS] [--base URL]
// Seeds are derived from (run id, cell) and logged; nothing reads a clock for
// them. Exit 0: no new failure and nothing vacuous. 1: a new failure or a
// vacuous cell. 2: refused (usage / environment). 3: aborted.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { builderDefaultVariant, cellId, type RowKey } from "./lib/catalogue.ts";
import { redact, findSecrets } from "./lib/redact.ts";
import { SecretInResults, stringsIn } from "./lib/results.ts";
import { loadRegressions, type RegressionCase } from "./lib/scenario-catalogue.ts";
import { SLICE_ROWS, SLICE_SPORTS } from "./lib/slice.ts";
import { ownerEmail, requireOwnDataDir } from "./lib/seed-org.ts";
import { newModelState } from "./lib/model/commands.ts";
import { runCell, type CellReport } from "./lib/model/run-cell.ts";
import { EXIT, RUN_ID_MAX, realDeps, type RunDeps } from "./run.ts";

export type ModelDeps = Pick<RunDeps, "env" | "harnessCommit" | "preflight" | "openDb" | "signIn" | "prepareCaseOrg" | "driverFor">;
export const MODEL_USAGE = "usage: model.ts [--run-id ID] [--report-dir DIR] [--cell row|sport]... [--runs N] [--max-commands N] [--seed N --path P [--replay-path R]] [--no-fences] [--regressions] [--time-limit MS] [--base URL]";
const SLICE_CELLS = SLICE_ROWS.flatMap((r) => SLICE_SPORTS.map((s) => cellId(r, s)));

/** FNV-1a, 32-bit, over UTF-8 bytes, as a signed int (fast-check seeds are ints). */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, "utf8")) { h ^= b; h = Math.imul(h, 0x01000193); }
  return h | 0;
}

export function seedFor(runId: string, cell: string): number {
  return fnv1a32(`${runId}|${cell}`);
}

const say = (s: string) => { process.stdout.write(`${redact(s)}\n`); };
const warn = (s: string) => { process.stderr.write(`${redact(s)}\n`); };

export async function runModel(deps: ModelDeps, argv: string[]): Promise<number> {
  let v: Record<string, string | boolean | string[] | undefined>;
  try {
    v = parseArgs({ args: argv, options: {
      "run-id": { type: "string" }, "report-dir": { type: "string" }, cell: { type: "string", multiple: true },
      runs: { type: "string" }, "max-commands": { type: "string" }, seed: { type: "string" }, path: { type: "string" }, "replay-path": { type: "string" },
      "no-fences": { type: "boolean" }, regressions: { type: "boolean" }, "time-limit": { type: "string" }, base: { type: "string" },
    } }).values;
  } catch (e) { warn(`model: ${(e as Error).message}\n${MODEL_USAGE}`); return EXIT.REFUSED; }
  const int = (k: string, dflt: number, min: number) => { const s = v[k] as string | undefined; const n = s === undefined ? dflt : Number(s); return Number.isInteger(n) && n >= min ? n : null; };
  const runs = int("runs", 20, 1);
  const maxCommands = int("max-commands", 10, 1);
  const timeLimitMs = int("time-limit", 120_000, 1_000);
  const cells = (v.cell as string[] | undefined) ?? SLICE_CELLS;
  const bad = cells.find((c) => !SLICE_CELLS.includes(c));
  if (runs === null || maxCommands === null || timeLimitMs === null || bad !== undefined || (v.path !== undefined && v.seed === undefined) || (v["replay-path"] !== undefined && v.path === undefined) || (v.seed !== undefined && !/^-?\d+$/.test(v.seed as string))) {
    warn(`model: ${bad !== undefined ? `unknown cell '${bad}' (the model runs W1a's slice: ${SLICE_CELLS.join(", ")})` : "bad arguments"}\n${MODEL_USAGE}`);
    return EXIT.REFUSED;
  }
  const slugged = ((v["run-id"] as string | undefined) ?? `w1b-model`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (slugged === "" || slugged.length > RUN_ID_MAX) { warn(`model: --run-id must slug to 1-${RUN_ID_MAX} characters`); return EXIT.REFUSED; }
  const base = (v.base as string | undefined) ?? deps.env.SMOKE_BASE;
  if (!base) { warn("model: no --base and no SMOKE_BASE"); return EXIT.REFUSED; }
  try { requireOwnDataDir(deps.env); } catch (e) { warn(`model: ${(e as Error).message}`); return EXIT.REFUSED; }
  const pf = await deps.preflight(base);
  if (!pf.ok) { for (const r of pf.refusals) warn(`preflight refused: ${r.reason} — ${r.detail}`); return EXIT.REFUSED; }
  let regressions: RegressionCase[];
  try { regressions = loadRegressions(); } catch (e) { warn(`model: regressions.json: ${(e as Error).message}`); return EXIT.REFUSED; }

  const harnessCommit = await deps.harnessCommit();
  const reports: CellReport[] = [];
  const db = await deps.openDb();
  try {
    const owner = ownerEmail(slugged);
    const session = await deps.signIn(base, owner);
    const userId = await db.userIdForEmail(owner);
    const plan = await db.chooseTopPublicPlan();
    const replays = v.regressions === true ? regressions.filter((r) => cells.includes(r.cell)) : [];
    const jobs = v.regressions === true
      ? replays.map((r) => ({ cell: r.cell, seed: r.seed, path: r.path, replayPath: r.replayPath ?? undefined, runs: 1, fences: false, variantOverride: r.variant }))
      : cells.map((c) => ({ cell: c, seed: v.seed !== undefined ? Number(v.seed) : seedFor(slugged, c), path: v.path as string | undefined, replayPath: v["replay-path"] as string | undefined, runs, fences: v["no-fences"] !== true, variantOverride: undefined as string | undefined }));
    if (jobs.length === 0) { warn("model: nothing to run (no cells, or --regressions with no committed case on these cells)"); return EXIT.NO_SIGNAL; }
    for (const [i, job] of jobs.entries()) {
      const [row, sport] = job.cell.split("|") as [RowKey, string];
      const variant = job.variantOverride ?? builderDefaultVariant(sport, await db.variantKeysInBuilderOrder(sport));
      const org = await deps.prepareCaseOrg({ base, session, userId, plan }, { name: `Matrix model ${slugged} ${i + 1}`, slug: `mm-${slugged}-${i + 1}` });
      const real = deps.driverFor(base, session, org.orgId);
      const comp = await real.createCompetition({ name: `Matrix model ${job.cell}`, slug: `mm-${slugged}-${i + 1}` });
      say(`[${i + 1}/${jobs.length}] ${job.cell} (${variant}) seed=${job.seed}${job.path === undefined ? "" : ` path=${job.path}`}${job.replayPath === undefined ? "" : ` replayPath=${job.replayPath}`} fences=${job.fences ? "on" : "off"}`);
      const rep = await runCell({
        cell: job.cell, row, sport, variant, runs: job.runs, maxCommands: maxCommands, seed: job.seed, path: job.path, replayPath: job.replayPath, fences: job.fences, timeLimitMs, regressions,
        newDriverState: async (n) => ({ real, model: await newModelState({ driver: real, row, sport, variant, entrants: 4, tag: `${slugged}-${i + 1}-${n}`, competitionId: comp.id }) }),
      });
      reports.push(rep);
      say(rep.failure === null ? `  ${rep.vacuous.length === 0 ? "ok" : `VACUOUS: ${rep.vacuous.join("; ")}`} — ${rep.numRuns} runs, parity ${rep.foldParity}, fenced ${JSON.stringify(rep.fenced)}`
        : `  FAILURE ${rep.failure.check}${rep.failure.known === null ? " (NEW)" : ` (known ${rep.failure.known})`}: ${rep.failure.commands.join(" → ")}`);
    }
  } catch (e) {
    warn(`model: aborted — ${(e as Error).message}`);
    return EXIT.ABORTED;
  } finally {
    try { await db.dispose(); } catch (e) { warn(`model: db dispose failed — ${(e as Error).message}`); }
  }
  const out = { schemaVersion: 1, runId: slugged, harnessCommit, cells: reports };
  const secrets = stringsIn(out).flatMap((s) => findSecrets(s));
  if (secrets.length > 0) { warn(`model: ${new SecretInResults(secrets.length).message}`); return EXIT.ABORTED; }
  const dir = join((v["report-dir"] as string | undefined) ?? "matrix-report", slugged);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "model-report.json"), `${JSON.stringify(out, null, 2)}\n`);
  say(`model report → ${join(dir, "model-report.json")}`);
  const fresh = reports.filter((r) => r.failure !== null && r.failure.known === null);
  for (const r of fresh) {
    say(`regression stub for scripts/matrix/catalogue/regressions.json (name it, date it, link its issue):\n${JSON.stringify({ id: "MB-NNN", title: "", issue: null, cell: r.cell, variant: r.variant, check: r.failure!.check, seed: r.failure!.seed, path: r.failure!.path, replayPath: r.failure!.replayPath, fence: null, status: "open", found: "YYYY-MM-DD", runId: slugged }, null, 2)}`);
  }
  return fresh.length > 0 || reports.some((r) => r.failure === null && r.vacuous.length > 0) ? EXIT.NO_SIGNAL : EXIT.OK;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runModel(realDeps(), process.argv.slice(2));
```

The regression stub prints `"MB-NNN"`, `"YYYY-MM-DD"` and an empty title **on purpose**. It is a paste template that a human completes, and `parseRegressions` refuses it until then (id regex, date regex). It is not a plan placeholder.

`package.json`: add `"matrix:model": "node --experimental-strip-types scripts/matrix/model.ts"`.

- [ ] **Step 4: Run and see them pass** — same command as Step 2. Expected: green, `files` = 2. Record `numRuns` and wall time per test. If a runCell test exceeds 20 s on the fake, lower `runs` in that test and say so in the report. Never raise `--testTimeout`.

- [ ] **Step 5: Mutation check**

- `fnv1a32` with the wrong prime → killed by the published vectors. `seedFor` without the `|` → killed by `seedFor(...) === fnv1a32("a|league|generic")`.
- `runCell` without the vacuity block → killed by "empty case first: … VACUOUS".
- Known matching ignores `status` → killed by the `fixed` half of the known test.
- `fences: true` hard-coded → killed by "fences OFF → #879 found".
- `markInterruptAsFailure: true` → survives on the fake, which never hits the limit. Record it as a survivor: the time box is exercised only in the live run.
- `model.ts` exits 0 on a new failure → killed by "a NEW failure exits 1".
- `commands` lists the whole shrunk iterable (the `.filter((c) => c.hasRan)` removed) → killed by "the step that threw is the last one" in "fences OFF → #879 found", provided the shrunk counterexample still holds a command that never ran. If it does not on the fake, record the mutant as a survivor of this file, not a kill (R-PF9).
- `replayPath` dropped from the `fc.commands` constraints → run it. A red on the replay test is the kill. A green means seed + path alone reproduced the fake's counterexample: record it as a survivor on the fake, judged live only by Task 15 Step 6's replay.
- The `--replay-path` without `--path` refusal removed → killed by the usage-refusal test.

- [ ] **Step 6: Scoped tsc + eslint** on `scripts/matrix/lib/model/run-cell.ts scripts/matrix/model.ts`.

- [ ] **Step 7: Commit** — `feat(matrix): the model runner — seeded per-cell fc.check, known vs new failures, anti-vacuity, matrix:model`.

---

## Task 15: The live walkthrough — the slice re-run, the probe set, the model, the first regression

The execution worktree `format-matrix-w1b-exec` was made off `origin/main` in Task 1 Step 0, after #896 merged (`a5f813404`). Confirm it holds only W1b commits on top of `origin/main`: `git log --oneline origin/main..HEAD`.

**Files:**
- Create: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-probe/{results.json,MATRIX.md}`, `truth-runs/w1b-abandon/abandon-probe.json` (ruling 30, Step 3b) and `truth-runs/w1b-model/model-report.json`
- Modify: `scripts/matrix/catalogue/regressions.json` (the first MB case, if the model finds one), and the regenerated `scripts/matrix/catalogue/counts.json` (a regression moves the L3 count)
- Test: `committed-catalogue.test.ts` (the drift gate re-run), `scenario-catalogue.test.ts` (the regression file parses)

- [ ] **Step 1: Stand up the environment (seazn-local-env skill)**

Invoke the `seazn-local-env` skill (`~/.claude/skills/seazn-local-env/SKILL.md`) and follow its recipe exactly for a fresh, owned database and a production server. The skill is the authority for the commands. This step fixes only the constraints the evidence depends on:

- Fresh DB: `db:apply` **and** `sync:sports` (AGENTS.md: `db:apply` alone is not a fresh schema).
- Run `show data_directory` on your own server, and export exactly that value as `BENCH_EXPECTED_DATA_DIR`. If `pg_ctl` said "Address already in use", the DB is not yours: stop.
- `REDIS_URL` unset. The probe set refuses otherwise (Review Focus 4), and that refusal is the intended behaviour, not a reason to set a flag.
- PostHog and Sentry keys blanked in the server's env: a local server otherwise sends to live PostHog.
- `SMOKE_BASE=http://localhost:<port>`: `localhost`, never `127.0.0.1`.
- A fresh run id per run: `w1b-slice-0928a`, `w1b-probe-0928a`, `w1b-model-0928a` (bump the letter on a re-run).
- A clean tracked tree before any evidence run: `cd <worktree> && git status --porcelain --untracked-files=no` must print nothing, or the evidence names `<sha>-dirty`.

Record the port, the data directory, the harness SHA and the server build SHA in the report.

- [ ] **Step 2: The slice re-run (no regression)**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && npm run matrix:l3 -- --run-id w1b-slice-0928a --report-dir matrix-report; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && node -e 'const r=require("./matrix-report/w1b-slice-0928a/results.json");const by={};for(const c of r.cases)by[c.state]=(by[c.state]||0)+1;console.log(JSON.stringify({harness:r.harnessCommit,cases:r.cases.length,by}))'
```

Expected: EXIT=0 and `{"cases":24,"by":{"works":24}}`, matching W1a's committed `truth-runs/w1a-slice/results.json`. Any case that differs is a finding. Diff its checks against W1a's evidence, then decide whether it is environment (AGENTS.md class 14) or a regression from Tasks 1–14. Never re-run a red away.

- [ ] **Step 3: The probe set**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && npm run matrix:l3 -- --set w1b-probe --run-id w1b-probe-0928a --report-dir matrix-report; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && node -e 'const r=require("./matrix-report/w1b-probe-0928a/results.json");for(const c of r.cases)console.log(c.state.padEnd(8),c.caseId,"|",c.reason.slice(0,140))'
```

Expected: `probeRows().api.length + probeRows().denied.length + 2` lines, the same sum Task 10's "the probe set" test pins (13 after Task 10's fix round 1 added `page_playoff_only`'s allowed path: 4 + 7 + 2). Read it from the code rather than typing it:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && node --experimental-strip-types -e 'const { probeRows } = await import("./scripts/matrix/lib/probe-set.ts"); const r = probeRows(); console.log(JSON.stringify({ apiRows: r.api, denied: r.denied.map((d) => d.row), expected: r.api.length + r.denied.length + 2 }))'
```

The printed `expected` must equal the line count above; a mismatch is a finding before any state is read. Record each case's state and reason in the report. Each one reads differently:

- **Before reading any state:** confirm the server was started without Redis. `ps eww -p <server pid> | grep -c REDIS_URL` must print `0` (Task 10 m-2: the harness guard can see only its own environment). An exit 2 naming `PlanLacksGate` means the case org's plan does not grant a gate. That is an environment/catalogue fact, not a product ❌; fix it by choosing a granting plan per case (`bench/lib/plan.ts` `chooseGrantingPlan`).
- **DENIED ×`probeRows().denied.length` (7).** ⛔ `refused` means all three checks held. A ❌ on `denied-put-keeps-stages` confirms false premise 8 live: `replaceStages` deletes before it gates. Record it as a finding **routed to W9**, with the case id and evidence, and change no product code. A ❌ on `denied-refused-named` means the deny did not reach the gate. Check `REDIS_URL` and the read-back first (environment before defect).
- **API-only LIFECYCLE ×`probeRows().api.length` (4, including `page_playoff_only`'s allowed path).** Each state is data, whatever it is. A ❌ is a finding for the row's owning wave, per the design's wave table. A ⏳ must name `W1-driving`.
- **Variant ×2.** These are expected to be ✅. A ❌ on `life-built-as-posted` naming `config.<key>` means the product stores the override differently from the engine's parse: a finding.

Copy the evidence:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && mkdir -p docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-probe && cp matrix-report/w1b-probe-0928a/results.json matrix-report/w1b-probe-0928a/MATRIX.md docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-probe/
```

- [ ] **Step 3b: The abandon check (ruling 30; false premise 11, audit ST-G1)**

This step answers one question by driving the product: does an abandon that the ENGINE scores reach the product's table? The reading is that it does not. Any `core.abandon` makes the fixture `abandoned` (`append-event.ts:146`), which becomes `void` (`fixture-engine-status.ts:17-19`), which is not counted (`stage.ts:24`).

There are four legs. Each gets its own case org, a one-stage league division, two entrants and one fixture. Each leg's expected table worth is the sport's own `standingsDelta` over the exact stream posted (`fold.ts` `declaredPoints`), never a typed number. The badminton leg is the control. Its abandon folds to `null`, so it must NOT count, and a probe that cannot tell counting from voiding proves nothing.

With the Write tool, write this to `$TMPDIR/w1b-abandon-probe.mts`. That is your scratchpad: never write it inside the worktree, and never commit it. The plan is its record.

```ts
// W1b Task 15 Step 3b — ruling 30 / ST-G1: does an engine-scored abandon reach the table?
// Synthetic identities only (ownerEmail); writes no secret.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const W = "/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec/scripts/matrix";
const { realDeps } = await import(`${W}/run.ts`);
const { ownerEmail, requireOwnDataDir } = await import(`${W}/lib/seed-org.ts`);
const { builderDefaultVariant, stagesForRow } = await import(`${W}/lib/catalogue.ts`);
const { entrantKindFor, resolveSportCfg, sportModule } = await import(`${W}/lib/sport-cfg.ts`);
const { declaredPoints, foldStream } = await import(`${W}/lib/fold.ts`);
const { START } = await import(`${W}/lib/streams/types.ts`);
const { RefusedCall } = await import(`${W}/lib/driver/types.ts`);

const [runId = "w1b-abandon-0928a", reportDir = "matrix-report"] = process.argv.slice(2);
type Ev = { type: string; payload: unknown };
const ABANDON: Ev = { type: "core.abandon", payload: { reason: "matrix: abandoned (ruling 30 probe)" } };
interface Leg { id: string; atom: "M4a" | "M4b"; sport: string; variant: string | null; config: Record<string, unknown>; stream: (home: string) => Ev[]; engineKind: string | null }
// engineKind is a GUARD, not the verdict: the leg is only evidence if the real
// engine folds its stream to that kind (checked below before anything is posted).
const LEGS: Leg[] = [
  { id: "badminton-control", atom: "M4a", sport: "badminton", variant: null, config: {}, stream: () => [START, ABANDON], engineKind: null },
  { id: "cricket-no-result", atom: "M4a", sport: "cricket", variant: null, config: {}, stream: () => [START, ABANDON], engineKind: "no_result" },
  { id: "cricket-test-draw", atom: "M4b", sport: "cricket", variant: "test", config: {}, stream: () => [START, ABANDON], engineKind: "draw" },
  // abandonPolicy is API-only config (false premise 10): the editor cannot set it.
  { id: "football-award", atom: "M4b", sport: "football", variant: null, config: { abandonPolicy: "award" }, stream: (home) => [START, { type: "football.goal", payload: { by: home, minute: 10 } }, ABANDON], engineKind: "award" },
];

async function runLeg(deps: any, ctx: any, db: any, leg: Leg, i: number): Promise<Record<string, unknown>> {
  const base = { leg: leg.id, atom: leg.atom, sport: leg.sport };
  try {
    const org = await deps.prepareCaseOrg(ctx, { name: `Matrix ${runId} ab ${i + 1}`, slug: `m-${runId}-ab-${i + 1}` });
    const driver = deps.driverFor(ctx.base, ctx.session, org.orgId);
    const variant = leg.variant ?? builderDefaultVariant(leg.sport, await db.variantKeysInBuilderOrder(leg.sport));
    const cfg = resolveSportCfg(leg.sport, variant, leg.config);
    const comp = await driver.createCompetition({ name: `Matrix abandon ${leg.id}`, slug: `m-${runId}-ab-${i + 1}` });
    const div = await driver.createDivision(comp.id, { name: `Matrix ${leg.sport}`, slug: "d", sportKey: leg.sport, variantKey: variant, config: leg.config });
    await driver.postStages(div.id, stagesForRow("league"));
    await driver.addEntrants(div.id, [1, 2].map((n) => ({ displayName: `Matrix Side ${n}`, seed: n, kind: entrantKindFor(leg.sport, cfg) })));
    await driver.start(div.id);
    const stage = (await driver.listStages(div.id))[0];
    const seated = (rows: any[]) => rows.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    let fixtures = seated(await driver.listFixtures(div.id));
    if (fixtures.length === 0) fixtures = seated((await driver.generate(stage.id)).fixtures);
    const f = fixtures[0];
    if (f === undefined) throw new Error("no seated fixture after start and generate");
    const home: string = f.home_entrant_id;
    const away: string = f.away_entrant_id;
    const events = leg.stream(home);
    const m = sportModule(leg.sport);
    const folded = foldStream(m, cfg, home, away, events).outcome;
    if ((folded?.kind ?? null) !== leg.engineKind) {
      return { ...base, variant, verdict: "invalid", why: `the engine folds this stream to ${folded?.kind ?? "null"}, the leg assumes ${leg.engineKind ?? "null"}` };
    }
    const ctxStage = { kind: stage.kind, ...(f.pool_id ? { poolId: f.pool_id } : {}), ...(f.round_no ? { roundNo: f.round_no } : {}) };
    const dp = declaredPoints(m, cfg, ctxStage, home, away, events);
    const declared = dp === null ? null : { home: dp.home, away: dp.away };
    await driver.postStream(f.id, events, `${runId}-ab-${i + 1}:${f.id}`);
    const state = await driver.fixtureState(f.id);
    const table = await driver.standings(stage.id, f.pool_id);
    const row = (id: string) => table.rows.find((r: any) => r.entrantId === id) ?? null;
    const h = row(home);
    const a = row(away);
    const product = { fixtureStatus: state.status, outcome: state.outcome, home: h, away: a };
    if (h === null || a === null || h.played === undefined || a.played === undefined || h.points === undefined || a.points === undefined) {
      return { ...base, variant, declared, product, verdict: "unjudgeable", why: "a table row, or its played/points, is missing on the wire" };
    }
    let verdict: string;
    if (declared === null) verdict = h.played === 0 && a.played === 0 ? "void-correct" : "counted-nothing";
    else if (h.played === 1 && a.played === 1 && h.points === declared.home && a.points === declared.away) verdict = "counts";
    else if (h.played === 0 && a.played === 0) verdict = "voided";
    else verdict = "differs";
    return { ...base, variant, engineOutcome: folded, declared, product, verdict };
  } catch (e) {
    if (e instanceof RefusedCall) return { ...base, verdict: "refused", refusal: { method: e.method, path: e.path, status: e.status, code: e.code } };
    return { ...base, verdict: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<number> {
  const env = process.env;
  const base = env.SMOKE_BASE;
  if (!base) { console.error("abandon-probe: SMOKE_BASE is unset (Step 1)"); return 2; }
  requireOwnDataDir(env); // the RF3 own-DB proof, before any write
  const deps = realDeps();
  const pf = await deps.preflight(base);
  if (!pf.ok) { for (const r of pf.refusals) console.error(`preflight refused: ${r.reason} — ${r.detail}`); return 2; }
  const db = await deps.openDb();
  try {
    const owner = ownerEmail(runId);
    const session = await deps.signIn(base, owner);
    const ctx = { base, session, userId: await db.userIdForEmail(owner), plan: await db.chooseTopPublicPlan() };
    const legs: Record<string, unknown>[] = [];
    for (const [i, leg] of LEGS.entries()) {
      const r = await runLeg(deps, ctx, db, leg, i);
      legs.push(r);
      console.log(`${String(r.verdict).padEnd(15)} ${leg.id}${r.why ? ` — ${r.why}` : ""}`);
    }
    const judged = legs.filter((r) => ["counts", "voided", "differs", "void-correct", "counted-nothing"].includes(String(r.verdict)));
    const control = legs.find((r) => r.leg === "badminton-control")?.verdict ?? "missing";
    const scored = judged.filter((r) => r.leg !== "badminton-control");
    const stG1 = control !== "void-correct" ? "PROBE-BROKEN"
      : scored.some((r) => r.verdict === "voided") ? "CONFIRMED"
      : scored.length > 0 && scored.every((r) => r.verdict === "counts") ? "REFUTED" : "UNRESOLVED";
    const report = { runId, judged: judged.length, control, stG1, legs };
    mkdirSync(join(reportDir, runId), { recursive: true });
    writeFileSync(join(reportDir, runId, "abandon-probe.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`ST-G1 ${stG1} — judged ${judged.length}/${LEGS.length}, control ${control}`);
    return judged.length === 0 ? 1 : 0; // zero judged is a failure (anti-vacuity), never a pass
  } finally {
    await db.dispose();
  }
}
process.exitCode = await main();
```

Before running, re-pin the calls against `run.ts`, which Task 1 changed (`realDeps`, `RunDeps.preflight`/`openDb`/`signIn`/`prepareCaseOrg`/`driverFor`), and against `lib/driver/types.ts`. If one moved, fix the probe, not the product. The legs were folded offline at plan time (2026-09-28), with this result:
- badminton `bwf` → `null`;
- cricket `t20` → `no_result`, worth 1/1;
- cricket `test` → `draw`, worth 1/1;
- football award → `award` to the home side, worth 3/0.

Run it in the same shell environment as Step 3 (Step 1's exports):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && node --experimental-strip-types "$TMPDIR/w1b-abandon-probe.mts" w1b-abandon-0928a matrix-report; echo EXIT=$?
```

Expected: EXIT=0, four verdict lines, then `ST-G1 <verdict> — judged N/4, control void-correct`. Read each outcome as follows:
- **`control` is not `void-correct`.** The run is `PROBE-BROKEN`. Stop, fix the probe, and re-run under a new run id. The other legs mean nothing until the control holds.
- **`CONFIRMED`: at least one scored leg is `voided`.** The fixture reads `abandoned`, and both rows read `played 0` against a declared worth (1/1, 1/1 or 3/0). This is the reading, and it is a finding. Record it with the leg ids and the evidence path, **routed to W5 (standings) and W2 (what an abandon is worth)**. Change no product code, and never loosen a verdict to pass.
- **`REFUTED`: every scored leg `counts`.** False premise 11 is wrong. Record it as a refuted hypothesis in `_INDEX.md` "False premises found", naming ST-G1 and the run.
- **A `refused` leg is data.** Two cases need their own reading:
  - `football-award` refused at `createDivision` on `config` means `abandonPolicy` is not even API-settable. Record it with false premise 10: M4b football then has no path at all, routed to W2.
  - A team-entrant refusal at `addEntrants` or on the first post, with a named code such as a roster or lineup requirement, is the `team rosters` deferral (`W1-driving`) showing up live. Record it, and do not build rosters here.
- **`UNRESOLVED` with no leg `voided`.** Say exactly which legs were judged. Never re-run a red away (AGENTS.md class 14 applies only to an environment signature).

Copy the evidence:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && mkdir -p docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-abandon && cp matrix-report/w1b-abandon-0928a/abandon-probe.json docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-abandon/
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && grep -acE 'seazn_org|sb-|@|Bearer|postgres://' docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-abandon/abandon-probe.json; echo "secret-shaped lines above (expect 0)"
```

- [ ] **Step 3c: The tied-knockout check (ruling 32; candidate defect CD-T6)**

This step answers one question by driving the product: what happens to a knockout bracket when a cricket match at the builder default (t20, super over off) ends on equal runs?

What is known before the run:
- The engine folds equal runs at the builder default to `{kind:"tie"}`. Task 6 proved this offline with a real fold, `applicability.ts` tie probe.
- The product's knockout draw guard checks only `kind === "draw"` (`append-event.ts:335-345`).
- `competition.ts:147-163` assumes a tie never reaches a bracket.

That is a reading, not a run.

**Setup.** One case org and one cricket division at the builder-default variant (`builderDefaultVariant`, never a typed `"t20"`). One knockout stage (`stagesForRow("knockout")`) with **4** entrants, so a semi-final tie shows whether the final gets seated. Start it, then take the first seated semi-final.

**Build the stream.** Reuse the equal-runs stream builder that Task 6's tie probe uses; import it, don't copy it. **Guard:** fold the exact stream through the real engine before posting. It must fold to `kind === "tie"`, or the run is `PROBE-BROKEN`. Then post the stream event by event through `HttpDriver`, and record every status and error code.

**Observe and record** in `truth-runs/w1b-tie-ko/tie-ko-probe.json`:
- (a) Was any post refused? Record the named code and the event index.
- (b) The fixture's status and result after the last post.
- (c) Whether the final is seated with a winner of that semi-final: its home/away entrant ids.
- (d) The stage's completion state after the other semi-final is completed with an ordinary win. Use the generator's normal win stream, folded and guarded to `kind === "win"`.

**Control.** Run the same division shape with an ordinary win in the first semi. Its final MUST be seated, or the probe cannot tell a stall from a slow seat and proves nothing.

**Verdicts:**
- **`CONFIRMED`:** the tie posts without refusal, the fixture completes, and the final is never seated (the control is seated). Record this in `_INDEX.md` as a finding with the evidence path, **routed to W4 (knockout family) and W2 (what a tie is worth in a knockout)**. Change no product code, and never loosen a verdict to pass.
- **`GUARDED`:** a post is refused with a named code, so the product blocks the tie. Record the code. CD-T6 is refuted as a stall. Route "a tied T20 knockout cannot be completed at the builder default, and the organiser's recovery path is unknown" to W2 as a product question.
- **`RESOLVED`:** the final is seated with a winner the engine chose (for example, a tiebreak the reading missed). Record it as a refuted hypothesis in "False premises found", and name the rule that resolved it.
- **`UNRESOLVED`:** anything else. Say exactly what was observed. A team-roster refusal at `addEntrants` is the `W1-driving` deferral showing up live. Record it, and do not build rosters here.

**Where the probe lives.** Write it with the Write tool to `$TMPDIR/w1b-tie-ko-probe.mts`, alongside the Step 3b probe. Take its imports and shape from that probe: synthetic identities, `ownerEmail`, `requireOwnDataDir`, and a run id of `w1b-tie-ko-0928a`. Never commit it. Copy the evidence to `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-tie-ko/`, then run the same secret-shape grep as Step 3b (expect 0). Add the Step 3c verdict line (`CD-T6 <verdict> — control seated`) to the Step 6 commit message body.

- [ ] **Step 3d: Withdrawing a board-game entrant after Start (finding CD-T13 / F1)**

This step answers one question by driving the product: can an organiser withdraw a boardgame entrant once the division has started, without leaving it half-updated?

**What is known before the run** (from reading the code plus an in-process fold, not a run; confirmed by the Task 13 review):
- The product's withdrawal walkover posts a bare `core.forfeit` to each unplayed fixture (`withdrawal.ts:105-112`).
- The boardgame module refuses a forfeit before `core.start` (`boardgame.ts:616-617`).
- The Step 4 model cells are generic and badminton only, so nothing else in W1b drives this.

**Setup.** One case org and one boardgame division at the builder-default variant (`builderDefaultVariant`, never typed). One league stage with **4** entrants. Start it, then generate. Complete exactly one fixture with an ordinary win, with the stream folded and guarded to `kind === "win"`. Then withdraw one entrant who has at least two unplayed fixtures, through the product's own withdraw endpoint.

**Record** in `truth-runs/w1b-withdraw-boardgame/withdraw-probe.json`:
- (a) the withdraw call's HTTP status and code;
- (b) every fixture of the withdrawn entrant: its status and result before and after;
- (c) whether any fixture was changed while another was not (a partial application);
- (d) the standings rows read back.

**Control.** The same shape on `generic` must withdraw cleanly, with every unplayed fixture of the entrant walked over. Without the control, the probe cannot tell a boardgame refusal from a broken withdraw.

**Verdicts:**
- **`CONFIRMED`:** the withdraw is refused or fails part-way on boardgame (a 4xx/5xx, or a partial application) while the control is clean. Record it in `_INDEX.md` as a finding, with the evidence path, **routed to W2 (does a boardgame forfeit before start count, and what is it worth) and W9 (the withdraw flow must be all-or-nothing)**. Change no product code.
- **`REFUTED`:** boardgame withdraws cleanly. Record it as a refuted hypothesis in "False premises found", naming the rule that allowed it.
- **`UNRESOLVED`:** anything else. Say exactly what was observed.

**Probe mechanics.** Write the probe with the Write tool to `$TMPDIR/w1b-withdraw-probe.mts`, taking its shape from the Step 3b probe: synthetic identities, `ownerEmail`, `requireOwnDataDir`, run id `w1b-withdraw-0928a`. Never commit it. Copy the evidence to `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-withdraw-boardgame/`, then run the same secret-shape grep (expect 0). Add the line `CD-T13 <verdict> — control clean` to the Step 6 commit body.

- [ ] **Step 4: The model on the slice, fences on**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && npm run matrix:model -- --run-id w1b-model-0928a --report-dir matrix-report; echo EXIT=$?
```

Expected: six `[i/6]` lines, each with its `seed=`, then `ok — N runs, parity P, fenced {…}` with P > 0. A `VACUOUS` line is a failure of this task, not of the product: raise `--runs` or `--max-commands` for that cell and record why. A `FAILURE … (NEW)` line is a finding. Keep its printed stub for Step 6. Expect a known-finding line `CD-T13b` (the roster lock's code-less 422) on any cell where Start then AddEntrant was drawn: a count, never a stop, routed to W9. Also expect **zero** `model-unexpected-refusal` on the knockout cells for a Void/Correct after the fed match started: that 409 NEXT_MATCH_STARTED is an expected refusal (T13 fix round 2). A non-zero count there is a model bug, not a product finding.

- [ ] **Step 5: The model with fences off on the #879 cell**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && npm run matrix:model -- --run-id w1b-model-0928b --report-dir matrix-report --cell 'league|generic' --no-fences; echo EXIT=$?
```

Expected: EXIT=1 and `FAILURE I7-rr-no-pair-over-legs (NEW)`, with a shrunk path of `Generate → … AddEntrant → … Generate` and **no Start** (#879 is pre-Start — after Start the roster lock refuses the entrant; T13 fix round 1). That is #879 reproduced by the model. If it does **not** fail, record that as a finding (#879 may already be fixed on main; check the issue), and commit no regression.

- [ ] **Step 6: Commit the regression and replay it**

With the Write tool, fill `scripts/matrix/catalogue/regressions.json` from the stub Step 5 printed:
- `id` `MB-001`, `title` "late entrant then Generate duplicates round-robin pairs", `issue` `#879`;
- `fence` `late-entry-then-generate`, `status` `open`, `found` `2026-09-28`, `runId` `w1b-model-0928b`;
- `cell`, `variant`, `check`, `seed`, `path` and `replayPath` exactly as printed (R-PF9: `replayPath` is what makes the shrunk command list reproduce; `null` only if the stub printed `null`).

Replay it:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && npm run matrix:model -- --run-id w1b-model-0928c --report-dir matrix-report --regressions; echo EXIT=$?
```

Expected: `FAILURE I7-rr-no-pair-over-legs (known MB-001)` and EXIT=0. A known failure does not fail the run. The replay's printed command list (only commands that ran) must equal Step 5's; a different list means the replay did not reproduce, which is a finding against R-PF9's replay, not a pass.

Regenerate the catalogue, because the regression count moves L3 (§6.2 formula):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && node --experimental-strip-types scripts/matrix/gen-catalogue.ts --write; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && git diff --stat scripts/matrix/catalogue/
```

Expected: only `counts.json` changes, with `l3.regressions` going from 0 to 1 and `l3.value` rising by 1.

Copy the model evidence:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && mkdir -p docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-model && cp matrix-report/w1b-model-0928a/model-report.json docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-model/model-report.json && cp matrix-report/w1b-model-0928b/model-report.json docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-model/model-report-no-fences.json
```

- [ ] **Step 7: Run the tests the regenerated files feed**

Use the template with `<N>`=15 and `<files>` = `scripts/matrix/__tests__/committed-catalogue.test.ts scripts/matrix/__tests__/scenario-catalogue.test.ts scripts/matrix/__tests__/committed-matrix.test.ts`. Expected: green, `files` = 3.

- [ ] **Step 8: Tear down the environment**

Follow the skill's teardown, which requires a positive ownership check before killing anything: stop only the server and the Postgres you started, identified by the PID and data directory you recorded in Step 1.

- [ ] **Step 9: Commit locally — no push, no PR (pre-flight ruling R-PF10)**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && git add scripts/matrix/catalogue/regressions.json scripts/matrix/catalogue/counts.json docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-probe docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-abandon docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1b-model && git commit -F "$TMPDIR/w1b-t15-msg.txt"; echo EXIT=$?
```

The message file, written with the Write tool, reads `test(matrix): W1b live evidence — slice 24/24, probe set, abandon check, model on the slice, MB-001 (#879)`, followed by a body that pastes the Step 2, 3 and 3b summaries (the 3b line is `ST-G1 <verdict> — judged N/4, control …`) and the Step 4–6 outcomes, and then the `Co-Authored-By` trailer.

Stop at the local commit. This task does not run `git push`, `gh pr create` or a CI watch: the controller pushes the branch and opens the PR. Hand the controller, in the task report, the four things its PR body carries:
- the matrix rows touched (R27): none of the product's rows, since this is a harness wave;
- the counts line from `counts.json`;
- rulings 26–30, cited as the owner's rulings they are;
- the findings routed, with their evidence paths.

When the controller has opened the PR, CI owes every job to completion, including the **container** job, which proves the Dockerfile line, and the gates job's three new steps. A `cancelled` job is not a pass. E2e does not run on a PR (AGENTS.md); nothing in W1b touches a browser path.

---

## Task 16: `_INDEX.md` — real §6.2 counts, the W1b row, the rulings applied, false premises, routed findings

**Controller amendment after Task 15 (binding; it overrides the step text below where they disagree).** The Task 15 report is gitignored, so `_INDEX.md` is the only lasting record. Read `truth-runs/**` and `regressions.json`, never memory, and record all of the following:

- **Model run cited.** Cite the final HEAD model run `truth-runs/w1b-model-final/`, not `w1b-model-0928a`, which is pre-fix. Give its per-cell verdicts. swiss|badminton needs `--runs 40`; at the default run count it is honestly vacuous, and the run records that reason.
- **Rulings made after this plan was written.** Record ruling 31 (VB/TT points floor 5 → W2), ruling 32 (tied T20 knockout checked live), ruling 33 (boardgame time control → W2), and the owner rulings of 2026-09-29:
  - the PUT-stages data loss stays in W9;
  - no browser/visual check in W1b (visuals → W1c);
  - the Pro-for-all-formats change is parked.
- **Regressions:** MB-001…MB-005 with their `match` text and owning wave:
  - MB-001, #879, pre-Start `Generate → AddEntrant → Generate`, re-pointed to 0929f because the Step 5 shrink was cut short by the division cap;
  - MB-002/003, a knockout withdraw of an entrant waiting for TBD → 422 → W9 + W4;
  - MB-004/005, knockout Generate 500 "would strand home_slot_label" → W4 + W9. The `away_slot_label` twin assertion at stages.ts:2672 is not yet seen live and would read NEW.
- **Routed findings (add these rows):**
  - **Data loss:** false premise 8 CONFIRMED live. A PUT to stages with a gated format returns 402, but the existing stage is already deleted, on all 7 DENIED rows. Routes to W9 (owner ruling).
  - **ST-G1:** CONFIRMED; routes to W5 + W2.
  - **CD-T6:** CONFIRMED. A tied T20 knockout semi completes as `decided` and never feeds the final. Routes to W4 + W2.
  - **CD-T13:** CONFIRMED. A board-game withdraw after Start is refused. It also half-applies when one fixture has already started. Routes to W2 + W9.
  - **CD-T13b:** the roster-lock 422 carries no code. It was counted live on the league and knockout cells. Routes to W9.
  - **CD-T8:** the boardgame time control is inert (ruling 33). Routes to W2.
  - **cricket#001:** record what the product did. It is an editor question for W2.
  - **`page_playoff_only` LIFECYCLE red:** this is a HARNESS defect (a fixed 8 entrants; a page playoff needs exactly 4), not a product ❌. The committed `truth-runs/w1b-probe/MATRIX.md` shows it as a product ❌; say so beside it. Routes to W1-driving.
  - **P7:** the rank-override route has no stage-kind guard. Routes to W5.
- **False premises found during execution (add these):**
  - The Redis check `ps eww … | grep -c REDIS_URL` is vacuous, because next-server rewrites its process title. The replacement witness commands are in the Task 15 fix-round evidence.
  - The #879 trigger is pre-Start, not post-Start (Task 13). The original plan's Start-first shape was false.
  - The Step 3d brief shape reached only the expunge path; a walkover shape was added.
  - `strip-types-loadable` needed no edit (Task 14).
  - `single-sport.test.ts` was red from T14 until T15 fix round 2. A scoped-gate gap: record that the scoped gate must include `single-sport.test.ts` whenever a `// single-sport:` header is touched.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md`

- [ ] **Step 1: Read the counts and the live outcomes from their files, not from memory**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && node -e 'const c=require("./scripts/matrix/catalogue/counts.json");console.log(JSON.stringify({grid:c.grid,catalogue:c.catalogue,l1:c.l1,l2:c.l2,l3:c.l3,drops:c.drops.total,variants:{uncoverable:c.variants.uncoverablePairs,unscorable:c.variants.unscorable,perSport:c.variants.perSport}},null,1))'
```

- [ ] **Step 2: Edit `_INDEX.md`**

These are Edit-tool changes, each anchored on the existing text:

1. The status table row `| W1b | … | not started |` becomes `| W1b | Catalogues (atomic cases, applicability, variants, pairs) + reference skeleton | **Tasks 1–16 done at <sha>; PR and CI: controller's (R-PF10).** Live: slice 24/24 ✅ (run w1b-slice-0928a); probe <tally> (w1b-probe-0928a, truth-runs/w1b-probe/); abandon check (ruling 30): ST-G1 <CONFIRMED|REFUTED|UNRESOLVED>, judged <N>/4 (w1b-abandon-0928a, truth-runs/w1b-abandon/); model on 6 slice cells, fences on: <ok/finding> (w1b-model-0928a); MB-001 = #879 (seed <s>, path <p>). |`. Fill each `<…>` from Steps 1–9 of Task 15 and Step 1 here. Every one is a value read from a file or a command's output, so none stays unfilled.
2. A new section `## W1b counts (design §6.2)` after "W1a session status". It holds a table of formula and value for L1, L2 (runs and pair targets), L3 (lifecycle + applicable atomic, with bound shown, + variant cases + denied + regressions = total), drops, and the variants per sport. Each value is quoted from `counts.json` and the formulas verbatim.
3. Rulings 26–30 are already under "Owner rulings" (O9, O10, Q-A, Q-B and ruling 30), so add nothing there and nothing under "Recommendations (mine — not rulings)". Confirm the five are present with `grep -anE "^(26|27|28|29|30)\. " _INDEX.md` (five lines). A new recommendation found while executing goes under "Recommendations", never under "Owner rulings".
4. Under "Decision log", add one dated line per W1b decision that was actually made in code, each with its commit SHA:
   - fake engine statuses aligned (carry 3);
   - planner seam (carry 4);
   - I1 multi-stage guard (carry 1);
   - denied via override (ruling 24 applied);
   - the statement-form `import type` boundary gate (ruling 27, the Task 12 SHA);
   - E as its own scenarios (ruling 26, the Task 4 SHA);
   - the W1-driving row and its guard (ruling 28), and variant cases running LIFECYCLE only (ruling 29);
   - ruling 30 applied: M4a/M4b and M12a/b/c in the catalogue, with M12b's `l2NoPath` (the Task 4 SHA). Their predicates and `ABANDON_RESULTS` are the Task 6 SHA.
5. Under "False premises found", add a `### Found during W1b planning and execution` list. It holds the plan's eleven false premises and hypotheses, each with its file:line, plus any found while executing. Premises 8 and 11 are hypotheses; record each as confirmed or refuted by its live check.
6. Add a "Findings routed" list. Give each finding its case or leg id, evidence path and owning wave. It holds each live ❌ and each confirmed hypothesis:
   - false premise 8 → W9;
   - false premise 9 → W4.

   Ruling 30 adds three rows, which are always written:
   - **ST-G1 (false premise 11).** Record Step 3b's verdict. `CONFIRMED` routes to **W5 (standings) + W2 (what an abandon is worth)**, citing the `voided` leg ids and `truth-runs/w1b-abandon/abandon-probe.json`. `REFUTED` goes under false premises instead. `UNRESOLVED` names the judged legs.
   - **M12b's missing play-short control, and the absent minimum-players rule** → W2. The source is the design's "Known UI-only 🚫" and the catalogue's `l2NoPath`.
   - **No organiser control for `abandonPolicy` (false premise 10)** → W2. It is joined by Step 3b's `football-award` outcome, if that leg was refused.

   If there are no other findings, write "none", and say which runs were checked.
7. Confirm that the `W1-driving` row Task 4 added still reads `not started (ruling 28)`.

- [ ] **Step 3: Verify the edit reads true against the files**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && grep -an "W1b counts\|MB-001\|Found during W1b\|W1-driving" docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1b-exec && grep -anE "<[a-z|/ ]+>" docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md | grep -a "W1b" ; echo "unfilled=$?"
```

Expected: the four anchors print, and `unfilled=1`, meaning grep found no leftover `<…>` on a W1b line.

Next, run the one test that reads `_INDEX.md`, the Q-A guard from Task 4: the template with `<N>`=16 and `<files>` = `scripts/matrix/__tests__/scenario-catalogue.test.ts`. Expected: green.

- [ ] **Step 4: Commit locally — no push (pre-flight ruling R-PF10)** — `docs(format-matrix): W1b status — §6.2 counts, rulings 26–30 applied, false premises, routed findings`, committed with an explicit pathspec (`-- docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md`). Stop there: the controller pushes to the PR branch and watches CI to completion.

---

## Self-Review

Run 2026-09-28 against the W1b prompt (`W1b-catalogues-reference.md`), design §3–§7.5 and §11–§12, and TEST-STRATEGY.md.

**1. Spec coverage**

| Requirement (W1b prompt / design) | Task |
|---|---|
| fast-check command model over organiser actions, run in L3 over HttpDriver, seeds logged (§7.5 item 1) | 13, 14, 15 (live) |
| A shrunk failure becomes a named regression case with its seed (R29) | 4 (schema), 14 (stub, known/new), 15 (MB-001) |
| `forEachSport` helper + CI listing of unreasoned single-sport tests (R26) | 11 |
| The design §4 scenarios split into atomic cases (ruling 30: M12 added, M4 split) | 4, 6 |
| Ruling 30: M12b is UI-only 🚫 (`l2NoPath`); the abandon-void check (ST-G1) is confirmed or refuted by driving the product | 4, 7 (note), 15 (Step 3b), 16 |
| Applicability over (format, sport, variant); committed drop list with reasons; per-row floors; `return false` mutation reds (R13, R17) | 6, 8 |
| Variant set with boundary classes; L2 pair file; both committed (R11) | 5, 7, 8 |
| `packages/reference` skeleton, boundary gate, Dockerfile line, explicit CI step, deliberate violation proof | 12 |
| Formulas and real counts for §6.2 in `_INDEX.md` | 8 (formulas), 16 (real numbers) |
| O9, O10, Q-A and Q-B carried as owner rulings 26–29, with owner value | Decisions section; 16 |
| Traps 1–5 | 1: Task 6 (the mutation sweep, witnesses, floors), Task 8 (zero-floor refusal). 2: Task 12 (workspace-wiring). 3: Task 12 (the gate refuses relative imports leaving src, pack-schema fixture). 4: Tasks 5, 6, 8, 11 (registry-order asserts). 5: Task 8 (no clock or randomness scan, drift gate). |
| W1a carries 1–4 | 1: Task 2. 2: Task 9 (ruling 24). 3: Task 1. 4: Task 1. |
| "No previously green check red" | Task 15 Step 2 (slice 24/24), Step 7 (the scoped tests); CI on the controller's PR (R-PF10) |
| Live walkthrough per the env recipe | 15 |
| Scoped verification only (no full gate) | Global Constraints; every task's verify names its files |

No gap is left open. One scope note: the design's weekly L3 workflow and PR row declaration (R27) are later waves' work (W1c), not W1b's, so they are absent by design.

**2. Placeholder scan.** `grep -anE "TBD|TODO|implement later|fill in|similar to Task"` over the plan finds nothing. Three kinds of intentional template text remain, each explained where it appears:
- `<N>` and `<files>` in the verify template (Global Constraints). They are substituted per task.
- The runtime regression stub's `MB-NNN` and `YYYY-MM-DD` (Task 14). They are a paste template that `parseRegressions` refuses until a human completes it.
- The `<…>` fields in Task 16's status row. They are filled from recorded outputs, and Step 3 checks that none remain.

**3. Type consistency**, checked by name across tasks:
- `RowKey`, `stagesForRow`, `ROW_KEYS`, `SPORT_KEYS`, `cellId`, `builderDefaultVariant`, `BUILDER_PREFERRED_VARIANT` (catalogue.ts)
- `offlineBuilderDefault`, `offlineVariantOrder`, `buildSportVariants`, `VariantCase`, `SportVariants` (Task 5 → 6, 7, 8, 10)
- `cellFacts`, `RULES`, `decide`, `planL3`, `rowCounts`, `scenarioCounts`, `DECIDERS`, `ABANDON_RESULTS` (Task 6 → 7, 8)
- `AtomicScenario.l2NoPath` (Task 4 → W1c; Task 7's note)
- `expectedGate` (Task 6 → 9, 10, 8)
- `planL2`, `L2_WIDTHS` (Task 7 → 8)
- `CasePlanner`, `PlanCases`, `slicePlanner` (Task 1 → 9, 10), with `deniesFeatures` added in Task 10. Task 9's test passes it early, and a note covers that ordering.
- `STEP_INVARIANTS`, `evaluateStepInvariants`, `ObservedStage.fieldSource` (Task 2 → 13)
- `RegressionCase`, `loadRegressions` (Task 4 → 8, 14)
- `RefusedCall.featureKey`, `StagesProbe`, `replaceStagesProbe` (Task 9 → 10)
- `OrganiserDriver.rebuild` (Task 13 → 14)
- `ModelState`, `COMMAND_KINDS`, `ModelViolation`, `modelCommands`, `newModelState`, `checkStep` (Task 13 → 14)

`FakeLeagueDriver` gains `replaceStagesProbe` (Task 9) and `rebuild` (Task 13), because the interface requires both.

**4. Review Focus.** Five items, each pinned in its owning task:

| # | Item | Test | Task |
|---|---|---|---|
| 1 | drift | `committed-catalogue.test.ts` | 8 |
| 2 | stray fast-check | `fast-check-resolution.test.ts` | 13 |
| 3 | #879 dominance | "Review Focus 3 — fenced" in `model-run-cell.test.ts` | 14 |
| 4 | REDIS hides the deny | run-cli "Review Focus 4" | 10 |
| 5 | builder-default collation drift | run-cli "Review Focus 5", and the `offlineBuilderDefault` sweep | 10, 5 |

## Execution Handoff

The plan is complete and saved to `docs/superpowers/plans/2026-09-28-format-matrix-w1b.md`. Please review it.

**Recommended execution: subagent-driven** (superpowers:subagent-driven-development), with one implementer and one reviewer per task, then a whole-branch review. The tasks chain through named interfaces (5→6→7→8, 1→9→10, 2→13→14). A wrong shape in an early catalogue task silently changes the committed floors that every later wave measures against, and 16 tasks is past the point where one session holds the context well. Tasks 11 and 12 are file-disjoint from 5–10 and could run in parallel worktrees. Keep them sequential anyway: both edit `package.json` and `ci.yml`, and AGENTS.md's parallel rule forbids overlapping file sets.

Prerequisite met: #891 and #896 are merged to `main` (`a5f813404`, main e2e green). Execution runs in its own worktree off `origin/main`, made by Task 1 Step 0. The owner ruled O9 and O10 (rulings 26 and 27) as the plan assumed, and Q-A and Q-B as rulings 28 and 29, so no task waits on an answer. Ruling 30 is applied in Tasks 4, 6, 7, 15 and 16.
