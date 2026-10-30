# Engine split 2b, Batch R close review (readers onto the installed surface)

Reviewer: Opus batch reviewer, 2026-10-30. Scope: `git diff origin/main a73b34e260` on `feat/engine-split-2b-readers`
(base `3372ccdec2`; R1 `c1240537c8`, R2 `a73b34e260`; 19 files, +509 / -87). Reviewed in a detached worktree at the tip, with a
second detached worktree at the base for the parity "before" side.

**Verdict: NEEDS FIXES.** 0 Critical, 3 Important, 6 minor. The R code is correct: no behaviour change, parity holds, the
installed tarball reads the corpora, and every guard I mutated died. The NEEDS FIXES rests on I1, an app reader of an engine
path that R exists to move and missed. I2 and I3 are gaps in the Batch E/A plan. They are doc-only, and they should land
before the tag so that Batch A starts from a complete list.

## What I ran (all scoped; judged from JSON plus `EXIT=0`)

| run | result |
|---|---|
| engine `src/testkit test/rules-reference.test.ts test/publish-manifest.test.ts test/pack-proof.test.ts` | 1477/1477, 35 files, 0 failed suites, EXIT=0 |
| tools/matrix `applicability`, `streams`, `scenarios` | 979/979, EXIT=0 |
| web, the four readers, `DATABASE_URL=` | 183 total: 128 passed, 55 skipped (DB-gated), 0 failed, EXIT=0. The corpus-derived tests all ran and passed (public-player-matches "every shipped module has a golden corpus" plus 11 per-module tests; timeline's sweeps; player-matches `LINES`) |
| sibling readers of the changed manifest and testkit: `toolchain`, `client-graph-no-server-barrel`, `outcome-readers` (web), `engine-bare-imports` (scripts) | 39/39 and 2/2, EXIT=0 |
| tsc: engine `--noEmit`, `tsconfig.tools-tests.json`, apps/web `typecheck` | all three EXIT=0 |
| eslint `--max-warnings 0` on the changed files (engine, tools, web) | clean. `pack-proof/node/**` is lint-ignored by design (`eslint.config.mjs:45`) |
| `npm run engine:boundary` | clean, 413 files |
| `fold-epoch-guard.ts --against 3372ccdec2` | 11 sports, 442 streams, 0 violations, STATS_FOLD_VERSION 7 -> 7 |
| `node pack-proof/run.mjs --only node` | green, EXIT=0: "11 corpora and the bye deltas read from the installed testkit, each equal to the workspace's file"; node: 311 checked |

## 1. Spec compliance (the eight items in the brief)

1. **Dist layout (deviation): sanctioned, harmless.** `scripts/copy-dist-data.mjs` copies to `dist/sports/**` and
   `dist/sport/__fixtures__/` rather than the plan's `dist/testkit/corpora/`. The result is one URL that is right from src
   and from dist, the same trick `rules-reference.ts:18` plays. **It holds in the installed tarball:** I ran
   `pack:proof --only node` myself and it was green. The installed `goldenCorpora()` read 11 corpora and each digest equals
   the workspace file's. I also probed the installed package's `node-testkit/node_modules/@onryde/seazn-engine/dist/`
   directly.
   - **Bloat.** I packed the base the same way and compared. Tarball 2,395,786 B -> 2,626,388 B (+230,602 B, +9.6%).
     Entries 452 -> 467, exactly 15 added: the 12 JSON files plus `dist/testkit/corpora.{js,d.ts,js.map}`. Unpacked size
     grows by about 3.3 MB.
   - **Leaks.** None. Nothing else from `src/` ships (no DOMAIN.md, no other fixture). The JSON cannot be imported through
     the exports map, because every `./sports/*` target ends in `/index.js`. No production web code imports the testkit;
     the only non-test importers are `tools/bench/lib/reconstruct.ts` and `tools/bench/packs/build-packs/_tiny.ts`. The
     testkit is not a phone subpath. The data is owner-sanctioned: D39(b), spec amendment §7.
2. **`files` needs no change: verified.** `files` = `["dist","rules","phone-subpaths.json"]`. The 12 JSON files are in the
   tarball. `publish-manifest.test.ts` asserts `pkg.files` contains `dist` and runs the copy step as declared in a scratch
   package: the exact JSON set, no dossier, no other fixture, idempotent on a second run, and both empty cases refused.
3. **LineupIssue: a public-API read, and it survives the move.** `lineupIssueKinds()` (`scenarios.test.ts:1213-1241`)
   resolves `@seazn/engine/sport` through package resolution (Bundler). It never names an engine file. I ran the same
   program twice:
   - from `tools/matrix/__tests__/`, it resolves `packages/engine/src/sport/catalog.ts`;
   - from the installed pack-proof fixture, it resolves `…/@onryde/seazn-engine/dist/sport/catalog.d.ts`.

   Both give the same 9 kinds as the old regex on `catalog.ts`. The comparisons are `.sort()`ed, so union order does not
   matter. Mutating `group_max` in `catalog.ts:68` reds the test.
4. **Readers that still read engine files by repo path.** See the Gap Hunt table. Most are covered by Batch E/A. Five are
   not: I1, I2 and I3.
5. **Parity: claims confirmed.** Collect-only `--isolate` at the base and at the tip, then `scripts/lib/test-parity.mjs`:
   - web, the four readers: 183 -> 183, `before-only 0 · after-only 0 · both 183 · unaccounted 0`, exit 0, no ledger
     needed;
   - matrix, the three files: 979 -> 979 (54/206/719 per file on both sides);
   - engine, the four changed files: 100 -> 113;
   - engine and matrix together with `ledgers/2b-readers.json`: `before-only 3 · after-only 16 · both 1076 ·
     unaccounted 0`, exit 0.

   Run without the engine report, the ledger shows its engine entries as `LEDGER-UNUSED`, as it should. The ledger only
   balances over both roots together.
6. **C-5 Swiss bye: correct by reading, and CI runs it.** `double-walkover-seating.test.ts:420` swaps
   `JSON.parse(readFileSync(<repo path>))` for `byeDeltas()`, which parses the same file. `corpora.test.ts` pins it
   deep-equal to the fixture, with keys equal to the shipped modules. It is still evaluated at module scope, so the non-DB
   collect proves the read: 5 passed and 14 skipped locally.
   - **CI.** The `smoke-db` job runs on `pull_request` with `DATABASE_URL` set (`ci.yml:816`). Its step at `ci.yml:1031`
     runs `src/server src/lib` with `--exclude "**/server/usecases/**/[i-z]*.test.*"` only, so `engine-db/__tests__/` is
     included and the C-5 test executes there.
7. **Anti-vacuity of `corpora.test.ts`: good.**
   - Every sweep asserts a non-zero count before it loops: `files.length > 0`, `shipped.length > 5`, fixture keys > 0, and
     `corpora.length > 0` after the naming loop.
   - Counts are equal to the disk listing and to `builtinModules`.
   - The reader itself refuses zero corpora.
   - The nested-directory witness is present (`a/deep/p.golden.json`, sport `a`, sorted first) and has teeth. I mutated
     four things one at a time: dropping the sort, dropping the zero-files refusal, dropping the own-key check, and naming
     the sport by its last directory. Each one reds 1-2 tests.
   - On the build side, dropping `process.exit(1)` in `copy-dist-data.mjs` reds publish-manifest (13/14). Copying no
     corpora reds pack-proof: the installed reader refuses with "no *.golden.json corpus under …/dist/sports".
8. **No behaviour change: confirmed.** The diff holds no `*.golden.json`, no `fold-epoch.ts`, no `stats.ts` and no
   `*.schema.json`. The only engine `src/` edits are under `testkit/`. `fold-epoch-guard` reports 0 violations over 442
   streams against the base.

**R2 equivalence, measured rather than assumed:**
- **Tie set.** Old `TIE_SOURCE_DIRS` = {cricket}; new `TIE_SPORTS` (`applicability.test.ts:54`, `streams.test.ts:31`) =
  {cricket}. The keys differ in kind, directory names before and module keys now, which is more correct for `setbased/*`.
- **Schema keys.** `schemaProps` via `z.toJSONSchema(..., {io:"input", target:"draft-2020-12"})` has the same options as
  `testkit/schema-snapshot.ts:47`. Its property-key set equals the committed `<sport>.schema.json` set for all 11 sports
  (key ORDER differs, and the test does not depend on order).
- **Mutation.** Removing `"tie"` from cricket's `reachableResultKinds` (`cricket.ts:4246`) reds 17 tests across
  applicability and streams, the LEVEL_PROBES guard among them. That satisfies R2 step 2 for both files.
- **zod.** tools/matrix and the engine resolve the same zod (`zod@4.4.3`).

## 2. Strengths (only what carries the verdict)

- The installed-tarball proof is a real differential. Digests are compared per corpus against the workspace's reader,
  zero corpora is refused, and a tarball without the copy step reds it.
- The testkit's disk-reading closure pin moves on purpose (`rules-reference.test.ts:366-368`, sorted). A corpora module
  that imported `golden.ts` would add a third reader and red it.
- dossiers' "no golden recorder in the barrel" pin was narrowed to the module specifier, with a positive control
  (`dossiers.test.ts:151-153`). It is a sanctioned narrowing, not a blind spot.

## 3. Issues

### Critical
None.

### Important

- **I1 — An R-scope reader was missed. `apps/web/src/components/v2/scorepad/v3/__tests__/w2e-retirement.test.ts:538-544`**
  (`ruleRow`) reads `packages/engine/rules/${file}` through an 8-level relative `new URL(…, import.meta.url)`.
  - **What depends on it.** It is used by "M12b cricket and generic offer none › the reason is the disposition row's…"
    (:547-557, 1 test).
  - **Why the plan missed it.** It was added 2026-10-29 (`f31cf86bbd`, W2e), after the 1d inventory. It is in no Section A
    row and no Batch A task.
  - **Effect.** ENOENT the day `packages/engine/**` is deleted. This is exactly the class Batch R exists to move, and the
    installed replacement already ships.
  - **Fix.** Look the row up through `allRows()` from `@seazn/engine/testkit` (`rules-reference.ts:60`; `RuleRow` carries
    `file`, `id`, `rule` and `status`), matching on `file` and `id`. `packages/reference/test/rule-rows.ts` already reads
    the rules this way. The test id is unchanged, so parity needs no ledger entry.

- **I2 — The fold-epoch guard falls between Batch E and Batch A.** `ci.yml:132` runs
  `pnpm --filter @onryde/seazn-engine --fail-if-no-match fold-epoch:check --against HEAD^1`. The "fold-epoch guard CI
  wiring" describe at `tools/matrix/__tests__/ci-wiring.test.ts:572-639` holds 4 tests and reads four engine files:
  `packages/engine/package.json` at describe scope (:573), `scripts/fold-epoch-guard.ts` (:612), the corpora directory
  (:624, the reader the implementer named) and `src/stats/stats.ts` (:632). That describe was added in 1e-2, after the
  inventory. The plan contains no mention of "fold-epoch" anywhere:
  - A2's ci.yml deletion list (`:105, :113, :126, :175-184`, the engine job, engine-pack) omits `:132`;
  - E1 step 2 moves only "18 (engine-pack and floor halves)";
  - E2's `gates` job omits the guard, and E2 step 2's missing-`HEAD^1` case names only the floor and single-sport gates,
    although this guard also reads `HEAD^1`.

  Effects:
  - the cutover PR's `gates` job reds, because `--fail-if-no-match` finds no workspace project;
  - the ci-wiring file reds;
  - worse, and silently: the engine repo would ship with no D15/D26 check that golden-stream changes carry an epoch bump.

  **Fix (plan amendment):**
  - E2 `gates` gains `fold-epoch:check --against HEAD^1`, plus the absent-baseline case of false premise 2 in its tests;
  - E1 step 2 moves the ci-wiring fold-epoch describe, re-rooted, with row 18;
  - A2 deletes `ci.yml:132`;
  - `ledgers/2b.json` records the 4 tests as `moved`.

- **I3 — Two more post-1d readers fall outside both the inventory and A3's parity file set.**
  - `scripts/__tests__/prod-release-epoch-workflow.test.ts:23-25,215`: module-scope
    `readdirSync(packages/engine/src/sports)`, so all 13 tests fail to collect at the move. The test pins the prod.yml
    step that A2 deletes (`prod.yml:89-110`), but no task deletes or ledgers the test.
  - `tools/matrix/__tests__/lint-warnings-gate.test.ts:51-57, :79, :170-176`: `EXPECTED` and `PROBE_FILE` pin
    `packages/engine` as a lint workspace, so the `toEqual` at :79 reds once discovery (:34-46) stops finding it.

  Neither file imports `@seazn/engine` and neither is an inventory row. A3 step 2 builds its parity list from
  `git grep -l '@seazn/engine'` plus the inventory, so both files' retirements and rewrites would be unledgered: a hole in
  D23 parity.

  **Fix:**
  - Append a dated "post-1d readers (found at 2b R close)" section to `reverse-inventory.md` listing I1, I2 (ci-wiring
    :572-639 and ci.yml:132) and these two files.
  - Give each a fate in A2/A3: prod-release-epoch is `retired` with the step (or `moved` with E4's report);
    lint-warnings-gate is a U-edit that drops the two engine entries (`rewritten`).
  - Add both files to A3's parity list.

### Minor

- **m1 — `TIE_SPORTS` now reads the declaration it guards** (`applicability.test.ts:54-56`, `streams.test.ts:31-33`).
  - **Why it matters.** `reachableResultKinds` is "the level results a TABLE can pay … empty in a bracket kind"
    (`sport/module.ts:1060-1064`). No sweep across all sports holds it to cover every level kind the fold emits:
    `decided-in.test.ts:360-409` pins cricket and draw⇔supportsDraws only. The old source scan was evidence independent of
    the declaration. With the new read, a future sport whose fold writes `kind: "tie"` but forgets the declaration hides
    from both the LEVEL_PROBES guard and the streams tie sweep.
  - **Status.** The plan sanctions this (rows 22/23, R2 step 1). The sets are equal today and the mutation kills, so this
    is not a defect.
  - **Suggestion.** When E1 moves the engine-side halves, keep a source-scan ⇔ `reachableResultKinds` parity test in the
    engine repo, where reading `src/` is legitimate.
- **m2 — Record the dist-layout deviation in the plan.** R1's Files bullet still says `dist/testkit/corpora/`. O8 and Batch
  E readers should look for `dist/sports/**/*.golden.json` and `dist/sport/__fixtures__/bye-deltas.json`. Note the +9.6%
  tarball in the PR body.
- **m3 — Mark reverse-inventory rows 5, 7, 8, 9, 22, 23 and 25a done**, citing `c1240537c8` and `a73b34e260`, the way row
  27 records "done in Phase 1". Re-pin the line refs E1 step 2 will use: row 25's engine-side caller scan moved from :1395
  to `scenarios.test.ts:1566-1571`.
- **m4 — `byeDeltas()` (`corpora.ts:55-57`) has no named refusal.** A missing file throws a raw ENOENT, and a non-object
  parse passes through. This is low risk, because build:dist refuses a missing fixture (tested) and `corpora.test.ts` pins
  keys equal to `builtinModules`. Optional: refuse a non-object or empty fixture the way the walker does.
- **m5 — Ledger file name.** Global Constraints names `ledgers/2b.json`; R writes `ledgers/2b-readers.json`. This is
  harmless, since R lands before the tag and A3's parity starts at the tag. Say so in the PR body.
- **m6 — The PR, not yet opened (branch pushed, no PR), owes two lines in its body:**
  - the `Matrix rows: none — engine relocation; no rule, fold or sport behaviour changes (golden ledgers byte-identical)`
    line;
  - R1's "smoke and e2e n/a (test-only surface)" statement.

## 4. Gap hunt

This is a sweep of every tracked non-engine file (docs, `*.md` and the lock excluded) for `packages/engine`,
`"packages", "engine"`, `../engine/`, and `engine/(src|test|scripts|rules|pack-proof|package.json)`, with comment lines
removed.

- **What the sweep found.** 175 files had a non-comment hit. Most are false positives:
  - `@seazn/engine/testkit` import lines that carry trailing comments;
  - SQL `--` comments in migrations;
  - catalogue evidence strings (A2-l);
  - `pr-rows`, `audit-ledger`, `single-sport`, `test-parity`, `dockerignore` and `tools-import-guard` path fixtures
    (Section B).
- **Other shapes.** A second pass found nothing new: `import.meta.resolve("@seazn…")`, `require.resolve("@seazn/engine…")`,
  `@seazn/engine/package.json`, `"engine", "src"`, and `../engine` with a quote after it (the hits are only the unrelated
  `games/*/engine`).

Live readers of engine paths, and whether Batch E/A covers each:

| reader (file:line) | Batch E/A coverage |
|---|---|
| `apps/web/src/__tests__/toolchain.test.ts` (row 1) | A3 |
| `apps/web/src/lib/__tests__/client-graph-no-server-barrel.test.ts:26` (row 2) | A3 |
| `apps/web/src/lib/__tests__/status-set-sweep.test.ts:23` (row 3) | A3 |
| `apps/web/src/server/engine-db/__tests__/append-event.test.ts:565` K7 (row 4) | E1 M + A3 |
| `apps/web/src/server/engine-db/__tests__/outcome-readers.test.ts` :10-23, :146, :228 (row 6) | E1 (engine half) + A3 |
| **`apps/web/src/components/v2/scorepad/v3/__tests__/w2e-retirement.test.ts:539`** | **NOT covered (I1)** |
| `packages/reference/test/boundary-gate.test.ts:18` (row 10) + `scripts/reference-boundary.ts:87` (A2-j) | A3 + A1 |
| `packages/scheduler/test/integration-runs-elsewhere.test.ts:238,360` (row 11) | A3 |
| `scripts/__tests__/engine-bare-imports.test.ts` (row 12, `walk(ROOT)`) | A3 (U) |
| `scripts/__tests__/engine-canary-workflow.test.ts` (row 13) | E1 retired + A2 |
| `scripts/__tests__/engine-package-identity.test.ts:15` (row 14) | A3 |
| `scripts/__tests__/main-module.test.ts:64,77` (row 15) | E1 + A3 |
| `scripts/__tests__/rules-reference.test.ts:17-19` and others (row 16) | A3 |
| **`scripts/__tests__/prod-release-epoch-workflow.test.ts:23-25,215`** | **NOT covered (I3)** |
| `tools/matrix/__tests__/matrix-workflow.test.ts` (row 17) | E1 + A3 |
| `tools/matrix/__tests__/ci-wiring.test.ts` :43-52, :84, :519-570, :641-680 (row 18) | E1 + A3 |
| **`tools/matrix/__tests__/ci-wiring.test.ts:572-639` (:573, :612, :624, :632)** | **NOT covered (I2)** |
| `tools/matrix/__tests__/fast-check-resolution.test.ts:18` (row 19) | A3 |
| `tools/matrix/__tests__/lock-isolation.test.ts:22,94,132` (row 20) | A3 |
| `tools/matrix/__tests__/workspace-wiring.test.ts:98,166` (row 21) | A3 |
| `tools/matrix/__tests__/americano-loop.test.ts:44` (row 24) | A3 D |
| `tools/matrix/__tests__/scenarios.test.ts:1566-1571` (row 25b) | E1 M + A3 |
| `tools/matrix/__tests__/http-driver.test.ts:1008` (row 26) | E1 + A3 |
| **`tools/matrix/__tests__/lint-warnings-gate.test.ts:53,172` (and :79)** | **NOT covered (I3)** |
| `tools/matrix/single-sport.ts:104-105` + baseline (A2-a) | E1 + A2/A3 |
| `tools/matrix/lib/audit-ledger.ts:34` (A2-b) | A3 |
| `ci.yml` :105, :126, :175-184, :247-:391, :564-:619, :648, :662, :950, :2328 | A2 |
| **`ci.yml:132` (fold-epoch:check)** | **NOT covered (I2)** |
| `prod.yml:105` | A2 |
| `Dockerfile:15`, root `package.json:39-54` | A1 |
| `scripts/ci-local.sh:358`, `scripts/mutate.ts:54` | A2 |
| `.gitignore:63-69` | dead lines after the move (harmless; E1 carries the engine copies) |

Other gap-hunt results:
- **No inert seam.** The four web readers and the three matrix readers call the real testkit export or the real module
  property. pack-proof drives the real installed reader.
- **No fail-open fallback.** The reader refuses zero corpora and a key mismatch. The copy step refuses an empty source.
  `lineupIssueKinds` throws on an unresolved import or a non-literal type. Those throws are reached by no test, but they
  fail closed: removing them lands on the `length > 0` and `toEqual` asserts, which still red.
- **No cache to invalidate.** `goldenCorpora()` reads fresh on each call, and that is tested.
- **apps/web vitest inlines `@seazn/engine`** (`apps/web/vitest.config.ts:176`). vite-node keeps the original file URL, so
  `../sports` resolves. After the cutover the resolved id is `@onryde/seazn-engine` and is externalized, which is the
  Node-native path pack-proof proves.

## 5. The four questions

1. **Second call?**
   - `goldenCorpora()` reads the disk fresh on each call; a caller's edit does not leak (tested).
   - `byeDeltas()` re-parses on each call.
   - `copy-dist-data.mjs` is idempotent over an existing dist (tested), and `build:dist` clears first.
   - pack-proof rebuilds dist each run.
   - `TIE_SPORTS` and `CORPORA` are computed once per module load.
2. **Empty input?**
   - The walker refuses an empty tree, or one with no `*.golden.json` (tested on both).
   - The build refuses a source with no corpus or no bye deltas (tested).
   - pack-proof refuses zero corpora (`requireChecked`) and a tarball without them (mutation-verified).
   - `engineKinds.length > 0`, `[...TIE_SPORTS].length > 0` and the DECIDERS `judged` counter guard the R2 sweeps.
3. **After a withdrawal or a void?** The only void-sensitive consumer is C-5 in `double-walkover-seating.test.ts` (a void
   moves the seats, then the bye credit). It reads byte-identical data through `byeDeltas()`. It is DB-gated, runs in CI
   `smoke-db` (`ci.yml:816`, `:1031`), and no fold moved (fold-epoch: 0 violations, 442 streams).
4. **Another sport?**
   - The corpora reader is sport-agnostic. It sweeps all 11 modules, with counts held to `builtinModules` and directories
     to `SPORT_DIRS`. The shared `setbased/` directory (3 sports) is covered in the walker test and in the publish-manifest
     scratch package.
   - R2's tie set is computed over every module × declared cfg × all 9 stage kinds.
   - The schema keys are equal for all 11 sports, not just the 5 DECIDERS sports.
   - One limit: the only tie sport is cricket, so a second tie-capable sport is untested today (see m1).

## Fixes (the review-fix commit on top of `a73b34e260`)

| finding | what the fix commit did |
|---|---|
| **I1** `w2e-retirement.test.ts` `ruleRow` read `packages/engine/rules/*.md` by repo path | `ruleRow` now looks the row up in `allRows()` from `@seazn/engine/testkit`, by `file` and `id`. The change is local to the rules read (the two imports at the top and the helper), so it merges cleanly with open PR #1083, whose hunk in this file is the band test near `RETIREMENT_BAND` (~:385-395). Parity: 24 → 24, `unaccounted 0`, no ledger entry (the test id is unchanged). Run with `DATABASE_URL=`: 24/24, EXIT=0. Mutation: negating the id match reds the disposition test (1 failed). Ignoring `file` survived, because rule ids are unique across the files, so one assertion was added to the same test (a real id asked of the wrong file is a refusal), and that mutant now reds too. |
| **I2** the fold-epoch guard (`ci.yml:132`, `ci-wiring.test.ts:572-639`) falls between Batch E and Batch A | Plan amended: E1 step 2 moves the 4-test describe with row 18 (ledger `moved` ×4); E2 `gates` gains `fold-epoch:check --against HEAD^1` and E2 step 2's absent-`HEAD^1` case names it; A2 deletes `ci.yml:132`; recorded as false premise 11. Reverse-inventory row 29 added. |
| **I3** `prod-release-epoch-workflow.test.ts` and `lint-warnings-gate.test.ts` outside the inventory and A3's parity set | Reverse-inventory rows 30 and 31 added with fates (30 `retired` with the `prod.yml` step, or `moved` with E4's report; 31 `rewritten`, drop the two engine entries). A3's file list names both rows, and A3 step 2 names both files explicitly because neither imports `@seazn/engine`. Recorded as false premise 12. Two corrections to the review: `lint-warnings-gate.test.ts` lives in `tools/matrix/__tests__/` (not `scripts/__tests__/`), and `prod-release-epoch-workflow.test.ts` collects 30 tests, not 13 (the row and the plan say 30). |
| **m1** `TIE_SPORTS` reads the declaration it guards | Plan: E1 step 2 now owes the engine repo a source-scan ⇔ `reachableResultKinds` parity test. Not built here (it belongs where reading `src/` is legitimate). |
| **m2** record the dist-layout deviation | Plan amended: R1's Files bullet, Deviation b (with the +9.6% tarball figure) and O8 now name `dist/sports/**` and `dist/sport/__fixtures__/`. |
| **m3** mark inventory rows done | Rows 5, 7, 8, 9, 22, 23, 25a and 28 carry "done in the 2b Batch R" with the sha. Row 25b's new line ref (`scenarios.test.ts:1566-1571`) is in row 25 and in E1 step 2. The Section F totals say which counts are the first 27 rows'. |
| **m4** `byeDeltas()` has no named refusal | **Skipped.** Optional and low risk (build:dist refuses a missing fixture, `corpora.test.ts` pins its keys to `builtinModules`); it would reopen the engine package and its pack-proof for no observed failure. |
| **m5** ledger file name | Plan's Batch R close says Batch R's ledger is `ledgers/2b-readers.json` and that `2b.json` starts at the tag. The PR body (not yet opened) should say the same. |
| **m6** PR body owes two lines | **Not a repo change.** The PR is not opened. The body owes the `Matrix rows: none — engine relocation; no rule, fold or sport behaviour changes (golden ledgers byte-identical)` line and "smoke and e2e n/a (test-only surface)". The plan's Batch R close now lists both. |
