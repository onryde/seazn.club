# Review — engine-split Phase 1 implementation plan

Reviewed: `docs/superpowers/plans/2026-10-13-engine-split-phase1.md` (branch `docs/engine-split-design`, code = `origin/main` 5871c748e)
against the spec (`2026-10-13-engine-split-design.md`, D1–D30), the fact sheet, AGENTS.md, RULES.md and TEST-STRATEGY.md.
Reviewer: `reviewer` (Opus), 2026-10-14. Every claim below was checked by opening the file. Four were checked by running a probe
in a scratch directory (pnpm 10.34.5 `--prod` peer resolution, turbo 2.10.8 alias edge, the phone closure size, and vitest 4's
`list --json` formatter).

**Counts: 1 BLOCKER · 19 MAJOR · 24 MINOR.**

---

## BLOCKER

1. **BLOCKER — 1a-4 Step 6 (in-process seam test): the assertion `engine === "optimized"` cannot be reached with the fake as described.**
   The fake answers "each requested fixture on court index 0 at the request's first grid slot". With 2+ fixtures, that board overlaps itself,
   so the verifier gate returns `verifier_rejected` (`build.ts:2256`). With 1 fixture, it equals the greedy seed. `improved` needs a board
   *strictly better* than the seed (`build.ts:2357-2372`), so the result is still greedy. This holds for every input. A Sonnet implementer
   who sees only this task cannot satisfy the step. This is the spec §5.1 class-1 seam proof, so the step cannot be dropped.
   **Fix:** lift a scenario whose existing test already asserts `engine: "optimized"` (`build.test.ts:285`, `build-day-gate.test.ts:116`)
   together with that test's known-good solver outcome. Have the fake gRPC server return those assignments, mapped to wire indices through the
   request's own court and fixture order. Assert the returned board equals them. Then add one case where the fake returns an overlapping board,
   and assert `verifier_rejected`. That proves the decode path does not invent placements.

## MAJOR

2. **MAJOR — 1a-2 Steps 1–2 (equivalence snapshot): no scenario reaches the accepted-board path, and the "six inputs" are really one.**
   `build-determinism.test.ts` is `describe.skip` (`:54`), and its six `buildSchedule(` calls (`:56-98`) all pass the same 4-fixture,
   2-court input, varying only `wallMs` and `rlimit`. Every "resolving" scenario uses the fake from finding 1, so it collapses into
   `verifier_rejected`. That leaves the snapshot covering only reject, ERROR, UNKNOWN, INFEASIBLE and verifier_rejected. It never covers
   `optimized` (`:2413`) or the not-improved `already_optimal`/`ok` arm (`:2365-2377`). Those are the arms whose `placementInput`/`outcome`
   handling the port touches. There is also no empty-input scenario (TEST-STRATEGY rule 1), and no scenario with `existing` pins, `current`,
   `frozen` or `dependencies`, all of which shape `placementInput` (`:2060-2096`). D5's "no behaviour change is a test" is therefore proven only
   on the failure arms.
   **Fix:** build the scenarios from tests that already pin real outcomes, each with the outcome its source test uses:
   `build.test.ts:285` (optimized), an `already_optimal` case, a POLISH case with `frozen`/`current`, a pinned-`existing` INFEASIBLE case and
   0 fixtures. Name the source test of each scenario in a comment. Add `wallSeconds` to the `stable` replacer, or explain why elapsed time
   cannot cross a 500 ms rounding edge (`build.ts:2096`).

3. **MAJOR — 1a-2 Step 5 / Step 8 / 1a-3 Step 3: `__tests__/placement-integration.test.ts` (the live seam) is left out of the conversion, and its post-move wiring is not specified.**
   It calls `buildSchedule(input)` four times (`:245, :275, :323, :370`) and imports `../build.ts` and `../calendar.ts` (`:29-35`). Step 5's
   list omits it, so Step 8's engine typecheck goes red while the file still sits in the engine. After the move, the test must pass the real
   adapter, or the live job at `placement-ci.yml:405-411` silently tests greedy. That is the exact inert seam D29 exists to prevent, and nothing
   in the plan prevents it.
   **Fix:** in 1a-2, convert it with a solve that calls the still-local `solveBuild` (secret from env), and say so. In 1a-3 Step 3, re-point
   its imports to `@seazn/engine/scheduling` and pass `solve: placementSolver, log: schedulerLog`. Add a guard to the file: if any test reaches
   `solver_unavailable` while `PLACEMENT_SERVICE_HOST` is set (the `:317` localhost:1 case excepted), fail.

4. **MAJOR — 1a-1 (test-parity): `vitest list --json` silently drops every skipped test, so parity is blind to them.**
   vitest 4's `formatCollectedAsJSON` does `if (test.result().state === "skipped") continue;`
   (`node_modules/vitest/dist/chunks/cli-api.*.js:14652` in 4.1.9). The engine has 30 skip/skipIf/runIf/todo sites. In scheduling alone:
   `build-determinism.test.ts:54`, `build-budget.test.ts:101,137`, `placement-integration.test.ts:214`,
   `repair-decompose-cpsat-integration.test.ts:47`. A move that deletes a skipped test passes `unaccounted 0`. In 1a-3 Step 7, "generate the
   28 rehomed entries over the two reports" cannot work: the 4 placement-integration ids appear in neither report.
   **Fix:** collect ids with `vitest run -t '<no-match sentinel>' --reporter=json`. Skipped tests are then reported, not executed; confirm on
   one file containing `it.skip` that its id appears. Or have `testIds` refuse `list` input that has fewer ids than a static count. Add a
   fixture to the parity test containing a skipped test.

5. **MAJOR — 1a-1 (test-parity CLI): a ledger `to` is never checked, and the CLI takes one `--after`/`--root-after` although rehomes cross package roots.**
   `diffIds` accepts `e.to` as accounted without checking that it exists. A "rehomed" test that was actually deleted therefore passes.
   1a-3 Step 7 needs engine and scheduler reports on the after side. 1d-6 needs engine, root `scripts/__tests__` and `apps/web` reports.
   The specified CLI cannot express either.
   **Fix:** make `--before` and `--after` repeatable as `file=root` pairs. For fate ∈ {moved, rehomed, split, rewritten}, require `to` to be
   present in the union of after-ids, and report misses as unaccounted. Add a test for "ledger says rehomed, target absent ⇒ unaccounted".

6. **MAJOR — 1a-1 Step 3: `scripts/test-parity.mjs` without a `.d.mts` turns CI's gates job red.**
   `scripts/__tests__/*.test.ts` are type-checked by `tsc -p tsconfig.tools-tests.json` (`ci.yml:123`), which is strict and has no `allowJs`.
   A relative `.mjs` import with no declaration is therefore TS7016. The repo's precedent is a declaration twin beside every `.mjs` a test
   imports: `scripts/lib/tools-import-guard.d.mts`, `packages/engine/scripts/stryker-changed.d.mts`. The plan's scoped run (vitest only) will
   not see this.
   **Fix:** ship `scripts/test-parity.d.mts`, or write the script as `.ts` (strip-types), and add `tsc -p tsconfig.tools-tests.json` to the
   task's verify step.

7. **MAJOR — 1a-4 Step 5 (client-bundle guard): "follow the file's existing pattern" is false after the move; the test's own assertions flip red.**
   `client-graph-no-server-barrel.test.ts` DERIVES the forbidden specifiers from "engine exports whose graph reaches `@grpc/grpc-js`"
   (`:103-110`). It then asserts that the barrel and `${BARREL}/placement-client` are forbidden (`:117-126`). After 1a, the barrel no longer
   reaches grpc, and the `./scheduling/placement-client` export is deleted. Both assertions go red, and the derivation stops forbidding anything
   from the engine.
   **Fix:** rewrite the derivation over both packages' `exports` (engine and `@seazn/scheduler`). Assert that `@seazn/scheduler` and
   `@seazn/scheduler/placement-client` are forbidden. Decide and record whether `@seazn/engine/scheduling` is now client-importable. The
   barrel's own header (`scheduling/index.ts:1-20, :83`) and `build-guard.yml:17-18` say it is server-only because of grpc; update or retire
   those comments. Then run the mutate-once step.

8. **MAJOR — 1a-3/1a-4: `scripts/__tests__/z3-retirement-drift.test.ts` is not in any task, and the move reds it in CI's "Repo-root scripts tests" step (`ci.yml:811`).**
   - Its `LIVE_TREES` (`:48-60`) has no `packages/scheduler`.
   - Its two-way ledger of z3-mentioning files (`:389-396`) lists `packages/engine/src/scheduling/placement-client.ts` (`:282`). Once that file
     moves out of the scanned trees, "listed file with no z3 left" goes red.
   - Its retired-claim row for `packages/engine/src/scheduling/generated/scheduler.ts` (`:176`) then git-greps a path that does not exist and
     passes vacuously.
   - Its ">20 files" floor (`:323-327`) notes that "generated stubs alone put z3 in packages/engine/src".

   Separately, the engine's own `z3-dependency-retired.test.ts` `LIVE_TREES` (`:41-51`) also misses `packages/scheduler`, which leaves an
   unscanned tree.
   **Fix:** add both files to 1a-4 Step 7's update list. Add `packages/scheduler` to both `LIVE_TREES`. Re-point the ledger and claim paths.
   Widen the grep in Step 7 to `scripts/__tests__`, `tools/**/__tests__` and `apps/web/src/**/__tests__`.

9. **MAJOR — 1a-4 Step 7 (placement-ci.yml): replacing `:36-37` with `packages/scheduler/**` re-opens the gap the file's own header documents.**
   `placement-ci.yml:8-26` says `packages/engine/src/scheduling/**` is in the filter because the integration job "drives the real service
   through build.ts". A PR that rewrites build.ts's fallback must trigger it. After 1a, `build.ts` still builds the request and owns the
   fallback.
   **Fix:** keep `packages/engine/src/scheduling/**`, replace only `:37` (gen-proto) with `packages/scheduler/**`, and amend the header comment.
   Do the same in `placement-stg.yml:45-46`.

10. **MAJOR — 1a-4 Step 7 (new scheduler CI step): the repo's JSON judge counts skips as failures, and the scheduler package always has 4 skipped tests.**
    The `packages/reference` precedent is a step inside the `gates` job, not a job (`ci.yml:274-295`). Its judge fails when
    `numPassedTests !== numTotalTests` ("failed, skipped and todo all count against it"). `placement-integration.test.ts` skips without
    `PLACEMENT_SERVICE_HOST` (plan Step 6 expects 4 skipped).
    **Fix:** exclude `src/placement-integration.test.ts` from the scheduler CI step (placement-ci runs it). Keep the strict judge. Pin the
    exclusion with an assertion that the file runs in `placement-ci.yml`.

11. **MAJOR — 1b-1 Step 3 (rename): two tools/matrix tests pin `--filter @seazn/engine`, and neither is in the plan's grep scope or scoped gate.**
    - `tools/matrix/__tests__/ci-wiring.test.ts:500` pins `pnpm --filter @seazn/engine mutation:floor --check-file-against HEAD^1`
      (`ci.yml:126`).
    - `tools/matrix/__tests__/matrix-workflow.test.ts:1712` pins `pnpm install --frozen-lockfile --filter @seazn/engine...`
      (`mutation.yml:287,409`).

    Step 3 greps only `.github`, `package.json`, `turbo.json` and `scripts/`. Step 4 runs only `workspace-wiring.test.ts`. CI's gates
    matrix-harness step goes red.
    **Fix:** add both pins to the file list, widen the grep to `tools/`, and add both files to Step 4 and the batch gate. Notify the mutation
    session: `mutation.yml` is theirs (spec §15).

12. **MAJOR — 1b-2 Step 4 + 1d-5 Step 1: the published testkit's `rules/` read points outside the tarball.**
    `rules/` is at the package root (`packages/engine/rules/`), so the 1d-5 parser in `src/testkit/` reads `new URL("../../rules/", …)`, which
    is correct from `src`. From `dist/testkit/` the same URL resolves to `<pkg>/rules/`. `copy-assets.mjs` instead copies rules to
    `dist/rules/`, and `files: ["dist"]` excludes `<pkg>/rules/`. The two layouts are not mirrors: rules sits beside `src`, not inside it. The
    plan's check ("verify by running the pack-proof types fixture") only runs tsc, so it cannot see a runtime read. This breaks the app's root
    rules-reference test at the 2b cutover, when it imports the testkit from the registry.
    **Fix:** either ship `rules` at the package root (`files: ["dist", "rules"]`; spec §5.2 allows exactly this once a runtime read exists) and
    drop the dist copy, or resolve the directory by probing both locations with a named refusal if neither exists. Add a `node` pack-proof
    check that imports the parser from the tarball and parses ≥1 rule row.

13. **MAJOR — 1b-3 Step 1 (rn fixture): `npx react-native bundle` cannot run with the listed dependencies, and the hermesc path is wrong.**
    In RN 0.86.3, `@react-native-community/cli` is only an optional peer of `@react-native/community-cli-plugin` (its `package.json:40,44`).
    `react-native/cli.js:37,153` prints "react-native depends on @react-native-community/cli" and exits without it. `hermesc` is not under
    `react-native/sdks/hermesc`: it ships in `hermes-compiler@250829098.0.17` at `hermesc/{osx-bin,linux64-bin}/hermesc` (seen in the capture
    checkout's `node_modules/.pnpm`). The task's "if bundling fails, stop and report" will lead a Sonnet implementer to report a false zod/R4
    finding.
    **Fix:** add `@react-native-community/cli` to the fixture (pin a version compatible with 0.86), or drive Metro's `runBuild` API directly.
    Resolve hermesc via `require.resolve("hermes-compiler/package.json")` plus the platform dir. Make the count meaningful: assert the bundle
    holds ≥ the static phone closure (46 modules, finding 15). Today `__d(function` count ≥ 1 is satisfied by the entry module alone.

14. **MAJOR — 1b-x / 1c / 1d / 1e: the four test types are not owed per task, although Global Constraints says they are.**
    RULES.md:64-82 requires all four test types for every task: "A task with no literal UI … still owes an E2E test". Spec §12 asks for e2e
    "a scoring flow for 1e/1f" and smoke "covers the stg deploy that runs sync-sports". The 1b tasks change the package name, `zod` to
    peer-only, `sideEffects` and `exports`, and run no smoke or prod build. 1e has no e2e. 1c and 1d name no e2e/smoke, not even as "not
    applicable — reason".
    **Fix:** give each task an explicit four-type line. For 1b: a local prod build plus `scripts/smoke.ts`, and a `pnpm install --prod`
    rehearsal running `sync-sports` (see finding 34). For 1e: re-run the scoring walkthrough or spec that covers one sport. For 1c/1d: the
    regression tests are the guards themselves, and e2e is "not applicable" with the stated reason.

15. **MAJOR — 1c-1 Step 5 (mutate once): removing `./sport` does not red anything.**
    Measured on the tree: the value-import closure of `core`, `sport`, `sports` and `sports/*` is **46** modules. Without `./sport` it is
    **42**, still ≥ the `>= 40` floor. The plan's own wording ("the walked count drops (the >= 40 guard holds the floor)") concedes no red.
    TEST-STRATEGY rule 5: a guard nothing kills is not tested.
    **Fix:** assert that each phone subpath's entry module appears in the walked set (so dropping one reds). Assert `walked` equal to a closure
    count recorded with its date and reason, re-pinned deliberately when the engine grows. Specify that `import type` is not followed, and that
    an `exports` target that does not exist is a violation, not a smaller walk.

16. **MAJOR — 1e-2 Step 2: the epoch guard fails open when a sport's streams stop matching.**
    Streams match on config name + seed. If the config names change, or someone re-records with `UPDATE_GOLDEN` (which re-records the events
    themselves, `golden.ts:252-262`), every before-stream is unmatched. Then `changed = 0` and no bump is demanded. The only anti-vacuity guard
    is "N sports = 0 ⇒ exit 2". Spec §5.5 asks that each sport has ≥ 1 ledger and that the count is reported.
    **Fix:** per sport, require `matched ≥ 1` when the baseline had streams, and treat removed streams as violations without a bump. Print
    `matched/removed/added` per sport. Add the cases "config key renamed ⇒ violation" and "all streams removed ⇒ violation".

17. **MAJOR — 1e-2 Step 2: the guard compares only `outcome`/`summary`, so it is blind to mid-match fold changes, which is what a phone renders.**
    `GoldenStream` records `states` (the fold after each event) and `deltas` (`golden.ts:111-131`). A rule fix that changes the serve order,
    the current set score or event legality mid-match, but not the final outcome, folds differently on an outdated phone. The guard demands no
    bump. Spec §8: "any existing event sequence folds to a different result".
    **Fix:** a matched stream counts as changed if its `events` are identical and any of `states`, `outcome`, `summary`, `deltas` differ. If
    its `events` differ, it is a re-recorded stream: treat it as removed plus added (finding 16). Add a test where only `states[k]` differs.

18. **MAJOR — 1f-1 Step 1: nothing proves that the server refuses *only the sport that moved* (D26's defining property).**
    Every "lower" case mocks `foldEpochOf` to `real + 1` for all sports at once. A mutant that compares against
    `Math.max(...Object.values(FOLD_EPOCH))`, or any global epoch, survives all seven cases.
    **Fix:** add a case that bumps one sport (e.g. cricket) and leaves the rest. A badminton write at its real epoch is accepted. A cricket write
    at the old epoch is refused, and the body's `sport` names cricket. Mutate the comparison to a global max once and watch the new case red.

19. **MAJOR — Gap (spec carried into plan): tests outside the engine read engine-owned files that leave at 2b, and none are inventoried, which puts D23's "2b is count-identical" at risk.**
    `tools/matrix/__tests__/matrix-workflow.test.ts` reads `mutation.yml` at module top (`:1024`). 28 of its 112 tests assert on it, so the
    whole file (112 tests) fails to collect once `mutation.yml` leaves. `client-graph-no-server-barrel.test.ts:20` reads
    `packages/engine/package.json`. Both z3 ledgers scan `packages/engine/src`. 74 test files outside the engine mention `packages/engine`
    paths. Spec §5.4 inventories only the engine-to-monorepo direction, and §7 lists only `lock-isolation.test.ts`.
    **Fix:** add to 1d-6 a reverse inventory, "non-engine tests that read engine files", with each test's planned 2b fate in the ledger. Raise
    the spec gap to the owner as a REC.

20. **MAJOR — 1d-1 Step 4 (`MATRIX_RUNNER` → `STRYKER_RUNNER`): a tools/matrix pin reds, and the plan's stated rationale for deleting the cross-quote is false.**
    The runner premise is TRUE: `gh variable list` shows `MATRIX_RUNNER` unset (only `MATRIX_WEEKLY_ENABLED` and
    `STAGING_CRON_WORKER_URL`). However:
    - `matrix-workflow.test.ts:1040-1048` asserts that every mutation.yml job runs on `vars.MATRIX_RUNNER`.
    - `:34` pins the refusal message, which names `vars.MATRIX_RUNNER` (`mutation.yml:213`).
    - The figures `stryker-sizing.test.ts:922` cross-quotes sit in a comment justifying `max-parallel: 12`, about the org's shared hosted
      slots (`matrix-workflow.test.ts:1065-1071`). They are not about runner sharing.

    Spec §5.4 said to split out, not to delete.
    **Fix:** list `:34` and `:1040-1048` in 1d-1 with ledger entries. Move the max-parallel pin and its figures with `mutation.yml`, since
    they test that file, rather than deleting them. Coordinate with the mutation session before editing (spec §15).

## MINOR

21. **MINOR — 1a-4 Step 1:** the stated assertion `notSearchedReason === "solver_unavailable"` names the wrong field. `"solver_unavailable"`
    is a `status` (`build.ts:2154`); `notSearchedReason` is set only for `not_searched`. The base file is `describe.skipIf(!HAS_DB)`
    (`schedule-auto-cooldown.test.ts:161`), so "Step 2 FAIL" can be a silent skip. Require `DATABASE_URL` and non-skipped JSON counts. To
    prove the REAL adapter was reached rather than any throwing `solve`, add a call-through spy on `@seazn/scheduler/placement-client`'s
    `solveBuild` and assert one call.
22. **MINOR — 1a-4 Step 7:** the Dockerfile manifest pin is `tools/matrix/__tests__/workspace-wiring.test.ts:76-104` (derived over every
    workspace), not `dockerignore.test.ts` or `toolchain.test.ts`. Add `workspace-wiring.test.ts` to the 1a gate. The "packages/reference job
    (~:283)" is a step in `gates` (`ci.yml:274`).
23. **MINOR — 1a-4 Step 3:** `schedule-solver-telemetry.test.ts:229` calls `buildSchedule` directly and needs the ports too (Step 8's
    typecheck will catch it). Name it. Test helpers typed `BuildInput` (`build.test.ts:159-203, :1514`, `placement-integration.test.ts:121`)
    need a shared `Omit<BuildInput, "solve" | "log">` type. Export one name (e.g. `BuildProblem`) instead of each test inventing its own.
24. **MINOR — 1a-3 Step 3:** `placement-client.test.ts:11` imports `../core/clock.ts` too, so re-point it with the client.
    `stryker-groups.test.ts:155` (`generated/**` containment) must go with `:154/:157`, and `:157`'s expected 6 becomes 3. `Clock`/`systemClock`
    ARE exported from `@seazn/engine/core` (`core/index.ts:7`), so no barrel change is needed.
25. **MINOR — Review Focus 3 premise:** the stg/prod `pnpm install --prod` (`stg.yml:66`) runs Flyway and `sync-sports`, not the app. The
    app runs from the Docker image (full install plus Next standalone). The real deploy pins for the scheduler are
    `workspace-wiring.test.ts:76` (Dockerfile COPY before a frozen install) and the prod-build e2e in 1a-4 Step 9. The runtime-deps test is
    still worth keeping as hygiene. Re-word the focus item.
26. **MINOR — 1b-2:** copying `*.golden.json` into `dist` is unnecessary. `golden.ts`, `dossiers.ts`, `schema-snapshot.ts` and
    `conformance-pad.ts` are deliberately NOT in the testkit barrel (`testkit/index.ts:7-19`), and `exports` blocks deep imports, so a registry
    consumer cannot reach them. The fact sheet's "dist must carry golden.json" premise is false. Drop that copy and its "zero corpora" guard
    (otherwise ~2 MB of dead weight ships), or record why they must ship.
27. **MINOR — 1b-2/1b-3:** the testkit barrel exports `conformance.ts`, which imports `fast-check` and `vitest` (`conformance.ts:4-5`), but
    the published manifest declares neither. The `types` fixture installs only the tarball and zod, so it can fail on those `.d.ts` imports,
    or pass only by setting `skipLibCheck`. Declare both as optional peers (`peerDependenciesMeta`) and install them in the `types` fixture.
    Give the fixture a `package.json` with `"type": "module"`, or the `nodenext` leg reads `.ts` as CJS (TS1479).
28. **MINOR — 1b-2 Step 3:** naming the script `build` puts the engine's dist emit into every turbo `typecheck`/`build`. A probe with
    turbo 2.10.8 shows `@seazn/web#typecheck` depends on `@onryde/seazn-engine#build` once the engine has a build script (`turbo.json`
    typecheck `dependsOn ^build`; `ci.yml:104`, `build-guard.yml:86`, `ci.yml:1448`). The app reads `src`, so that work is wasted on every PR.
    Name it `build:dist` (and `pack:proof` calls that), or accept and record the cost. A per-package `outputs` needs
    `packages/engine/turbo.json`; the root `build.outputs` is shared.
29. **MINOR — 1b-4:** the plan's premise "use the `yaml` package already in the repo" is false: nothing declares or imports `yaml`. Parse
    the workflow by text, as `matrix-workflow.test.ts`'s `jobsOf` does. `canary-workflow.test.ts` and `package-identity.test.ts` read
    monorepo files from `packages/engine/test/`, which creates two new out-reaching tests in the batch before 1d rehomes them, and 1d-6's
    `/tmp/engine-alone` run skips untouched files, so it never sees them. Put both in `scripts/__tests__/` from the start, and drop the
    "rehomed at 2b" ledger entry. Derive `CONSUMERS` from the workspace manifests rather than a typed list.
30. **MINOR — 1d-5 Step 3:** the gates step running two files also changes the judge exercised by `rules-reference.test.ts:745` and `:761`,
    and invalidates `:685`'s title ("runs only this file"). A second step for the root file leaves all three true. Prefer it.
31. **MINOR — 1d-1 Step 6:** `pnpm install` in `/tmp/engine-alone` resolves without a lockfile (e.g. vitest `^4.1.11` floats). Record the
    resolved versions next to the run. Fixed `/tmp/*.json` output names across the plan (`/tmp/parity.json`, `/tmp/eq.json`, …) can be
    read stale or clobbered by a parallel session; `rm -f` first or use `mktemp`.
32. **MINOR — 1e-2 Step 1:** the fixture shapes do not match `GoldenCorpus`. `stream.config` is a config NAME string, `version` is a string
    ("1.0.0" in all 11 corpora), `configs` is a record, and `recordedBy`/`params` are required (`golden.ts:111-140`). Type `epochViolations`
    on the real interface and build fixtures from it. `config#seed` is unique in every corpus today (checked: 12–76 streams each, no
    collisions). The CLI module needs a main-module guard, so importing it from the test does not run it.
33. **MINOR — 1e-2 Step 4 vs spec §5.5:** the spec's mutation is "change one scoring constant in one sport". The plan hand-edits a golden
    JSON. Use the spec's chain instead: change the constant, `REBASELINE_GOLDEN=1` for that sport, then the guard names only that sport. That
    exercises the real path a rule fix takes.
34. **MINOR — 1b-2 (`zod` peer-only) vs `stg.yml:56-66`:** the stg comment says zod "sits in dependencies" so the `--prod` install resolves
    it. A probe with pnpm 10.34.5 confirms that a peer+dev-only zod gets no `packages/engine/node_modules/zod` under `--prod`. It then resolves
    only by walking up to the ROOT's own `zod` (root `package.json:95`, a prod dependency). That works today, but only incidentally.
    Pin it: add `zod` to `toolchain.test.ts`'s "deploy job's --prod install" list, and update the stg comment.
35. **MINOR — 1f-1 Step 3:** `scoreEvent` does not know the sport before `appendEvent`. `sport_key` is loaded inside
    `assertEntitledToScore` (`scoring.ts:478-499`), which returns only a replay. Name the insertion point. Decide the ordering relative to
    the cache replay (`:173-182`) and the durable replay (catch at the idem index). Today a retry of an ALREADY-ACCEPTED key after an epoch
    bump gets 201 when Redis is warm and 426 when it is cold. Add a test that pins one answer.
36. **MINOR — 1f-1:** three routes use the `"score"` actor (`events/route.ts:15`, `lineups/[entrantId]/route.ts:28`,
    `finalize/route.ts:15`), and only `events` is gated. State why the other two need no epoch (the server folds; lineups are inputs), or gate
    them. A `core.void` (undo) from an outdated phone is refused too; say so as the "after a void" answer.
37. **MINOR — process (R6):** spec §14 R6 says "check W2c's touched files before 1a". The plan has no such step, although 1a edits
    `build.ts`, `repair-decompose-cpsat.ts`, `schedule.ts`, `stryker.groups.mjs` and the engine manifest. Add a pre-flight diff against
    W2c's open branch.
38. **MINOR — process (D30 vs RULES.md):** RULES.md:48-49 still says "never Sonnet for any of the three". The Sonnet agent definitions are
    untracked in the main checkout (`.claude/agents/implementer-sonnet.md`, `reviewer-sonnet.md`), and their descriptions say
    "W2c-ONLY". Worktrees created from `origin/main` will not contain them. Amend RULES.md and the agent descriptions to cite D30, track
    the files, and run dispatches from a checkout that has them.
39. **MINOR — spec deviations not ledgered:** these are sanctioned in substance but never recorded as RECs:
    - parity script at root `scripts/` (spec: "lives in the engine and is copied to the app");
    - `vitest list` instead of reporter JSON;
    - golden ledgers replaced by the existing corpora;
    - `docs/contracts` capture contract deferred to S2 (spec §5.6);
    - `tools-import-guard` left until 2b (spec §5.4 table moves it in Phase 1);
    - `tools/bench` not a caller (spec §5.1 names it; fact sheet says no import);
    - the phone sends only `engine_epoch`, not `{sport, epoch}` (spec §8); the server's fixture sport is authoritative.

    Add them to D31 (or D32) for the owner.
40. **MINOR — spec R5 dropped:** §14 R5, "read one real Stryker incremental file in PR 1b's prep", has no step. Add it to 1b as a
    10-minute read.
41. **MINOR — doc drift left behind by 1a:**
    - `scheduling/index.ts:1-20, :83` (server-only because of grpc);
    - `build-guard.yml:17-18`;
    - `apps/web/src/lib/__tests__/swiss-pairing.test.ts:69`;
    - `tools/bench/lib/log.ts:4` and `env.ts:519-527` (cite engine paths that move);
    - `candidate-courts.ts:61` and `court-id-lattice-equivalence.test.ts:47` (cite `placement-client.ts`'s `IndexSpace`, now in another
      package).

    Sweep them in 1a-4 Step 7.
42. **MINOR — 1a-2 Step 5 count:** the fact sheet's spy counts hold (`"solveBuild")` occurs 55× in `build.test.ts`, 6× in
    `build-rest-lattice`). `build.test.ts` also spies `log.error` at `:686` as well as `:811`, so convert both to `recordingLogger`.
43. **MINOR — 1c-1 Step 3:** `\bprocess\.` misses `process?.env` and `globalThis.process`. Add both to the seeded refusals or state why they
    cannot occur (the closure has zero `process` reads today, measured).
44. **MINOR — 1a-2 equivalence vs the shared module cache:** the engine runs `isolate: false` (`vitest.config.ts`). A `queued` counter
    leaked by another file in the same worker would turn a scenario into `solver_busy` and flake the snapshot. Assert `queued`-sensitive
    state is clean at the start of the file (e.g. call once with `wallMs` small and expect not `solver_busy`), or run the file alone in
    Steps 2/6.

---

## A. Spec §5 coverage (each requirement → task)

| Spec item | Task | Status |
|---|---|---|
| 5.1 required `solve`/`log`, types move, call site, fallback unchanged, repair threads ports | 1a-2 | covered |
| 5.1 logger and client, stubs, gen-proto, `schedulerLog`, deps → `packages/scheduler` | 1a-3 | covered |
| 5.1 callers incl. `tools/bench` | 1a-4 | bench premise false, unrecorded (39) |
| 5.1 seam test, real `buildSchedule` + real adapter + fake gRPC | 1a-4 S6 | **cannot pass as written (1)** |
| 5.1 live integration test moves and keeps running live | 1a-3 | conversion unspecified (3) |
| 5.1 "no behaviour change" before/after | 1a-2 | failure arms only (2) |
| 5.2 rename + alias, verified for Next/vitest/strip-types/turbo | 1b-1 | turbo verified by probe; Next only via tsc; misses 2 pins (11) |
| 5.2 tsc emit, `publishConfig.exports`, manifest, `sideEffects` | 1b-2 | covered; rules/ asymmetry (12) |
| 5.2 "grep for runtime read of rules/ first" | — | not done; rules copied unconditionally (12, 26) |
| 5.2 packed-tarball proof ×4, counts | 1b-3 | rn leg unrunnable (13); weak count |
| 5.2 canaries | 1b-4 | covered |
| 5.3 phone-subpaths.json, static rule, walked count, Metro half, mutate | 1c-1 | mutate step not a kill (15) |
| 5.4 seven out-reaching tests + parity script + ledger | 1d-1…6, 1a-1 | covered; reverse direction missing (19); tool gaps (4, 5) |
| 5.5 per-sport ledgers ≥1 with count, FOLD_EPOCH on a phone subpath, HEAD^1 gate, mutate | 1e-1/2 | fail-open (16), states blind (17), mutation differs (33) |
| 5.6 epoch check, 426, refusal shape | 1f-1 | per-sport isolation untested (18) |
| 5.6 `engine_epoch_missing` | 1f | dropped as D31 REC: sound (server cannot tell capture from web pad, `auth.ts:245-278`, V222) |
| 5.6 contract in `docs/contracts` | 1f-2 | deferred to S2, not ledgered (39) |
| §12 four test types per PR | all | not met for 1b/1c/1d/1e (14) |
| §14 R5, R6 | — | missing (40, 37) |

## B–F. Verified premises (true, no finding)

- `BuildInput`/`BuildResult` fields: `engine`, `status`, `notSearchedReason` and `elapsedMs` exist (`build.ts:503-631`). All six log sites
  sit inside `buildSchedule`/`solveBuild`, so `input.log` reaches every one.
- The `vi.spyOn(await import(...), "solveBuild")` pattern works because the property is read at call time on a shared namespace (55 passing
  sites). The adapter's call-time `import("./placement-client.ts")` keeps the same seam. `apps/web` inlines workspace packages (real paths
  outside `node_modules`).
- `Clock`/`systemClock` are exported from `@seazn/engine/core`. `placement-client.ts` imports no engine domain types. The host is read per
  call (`placement-client.ts:750`), so `vi.stubEnv` works.
- pnpm 10.34.5 resolves `workspace:@onryde/seazn-engine@*` (probe). turbo 2.10.8 keeps the dependency edge through the alias (probe:
  `@seazn/web#typecheck` → `@onryde/seazn-engine#build`).
- The phone closure is 46 modules: no `node:*`, no `process`, nothing from `scheduling`, zod the only bare import (measured).
- vitest 4 `list --json` yields `{name: "a > b", file, projectName?, location?}`, matching the fixture apart from the skipped-test gap (4).
- `MATRIX_RUNNER` is unset; `AppendEventRequest` is at `schemas.ts:1839-1844`; ZodError → 400 `VALIDATION` (`http.ts:169-170`), so
  the e2e's `engine_epoch: 0 → 400` holds; there is no 426 anywhere today.
- Every line anchor checked in `build.ts`, `repair-decompose-cpsat.ts`, `stryker.groups.mjs`, `runtime-deps.test.ts`, `ci.yml`
  (:105/:126/:130/:304-311/:811), `Dockerfile:13-16`, `placement-ci.yml:36-37/:297-305/:405` and `rules-reference.test.ts` holds.

## The four questions, applied to the plan

1. **Second call.** 1a: the `queued` counter is untouched, but no equivalence scenario runs twice; finding 44 covers the shared module state.
   1f: case 6 covers two refusals. A retry of an accepted key after a bump is unpinned (35).
2. **Empty input.** No empty-fixture equivalence scenario (2). test-parity refuses zero ids. The epoch guard has no per-sport empty or
   zero-match refusal (16). The rn count is vacuous at 1 (13).
3. **After a withdrawal or void.** Corpora pin `module.outcome`/`summary`, not the kernel's `outcomeOf` overlays; the plan records this as a
   known limit. A void from an outdated phone is refused (36). The withdrawal cascade calls `scoreEvent` without an epoch
   (`withdrawal.ts:125-232`), so it is unaffected. Good, but no test pins it.
4. **Another sport.** 1a: not applicable, because scheduling is sport-agnostic. 1e: `FOLD_EPOCH` keys are derived from the registry.
   1f: the sweep covers all sports uniformly but not per-sport isolation (18).

## Review Focus assessment

Items 1, 2, 4 and 5 are the right risks. Item 3 aims at an install path that never boots the app (25). Items 1 and 2 need the fixes in 21
and 7 to be pinned for real. Five more belong on the list, ahead of item 3: the seam test that cannot pass (1), the failure-only
equivalence proof (2), the live integration test going inert (3), the rules/ path in the tarball (12), and the epoch guard failing open
(16, 17).

## Verdict

**Needs fixes before dispatch.** One step cannot pass as written (1). Several tasks would turn CI red outside their scoped gate (6, 8, 10,
11). The parity tool, the epoch guard and the per-sport refusal each have a fail-open mode that no test in the plan would catch (4, 5, 16,
17, 18).
