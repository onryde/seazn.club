# Engine split — design

**Status: APPROVED by the owner (2026-10-13, "approve"), including D29.** Every
decision below was ruled by the owner in chat, one question at a time; the
ledger (§16) records each with the owner's words. No code moves until W2e
merges (ruling 131), except Phase 1, which the owner explicitly allowed (D7).

**Progress (2026-10-16).** Phase 1 is complete: batches 1a–1f merged (#950,
#952, #958, #955, #960, #961), with the golden floor GF-1 (#962), the
FOLD_EPOCH/FOLD_MINOR split (#963, D34) and the release-time epoch report
(#964, warn-only). GF-2 (corpus format 3: kernel overlay, effective results and
player stats recorded and guarded) is this spec's last Phase 1 follow-up
(`engine-split/gf2-kernel-overlay-design.md`). Phase 2a and 2b wait on the
owner's go-ahead. The per-sport epoch floor override owed before the first
capture app release to real scorers is delivered (`ENGINE_EPOCH_FLOOR_OVERRIDE`,
default off, logged at boot; §5.6).

**Inputs.** Brief: `.superpowers/handoff/2026-10-08-w1d-close/engine-split-prompt.md`.
Fact check: `engine-split-facts.md` beside it (36 claims against `origin/main`
`5871c748e`; its corrections S1–S8 bind this spec). Read with `AGENTS.md`,
`docs/superpowers/RULES.md`, `docs/superpowers/TEST-STRATEGY.md`.

**Line numbers** in this file are against `origin/main` `5871c748e` and must be
re-pinned before any plan task builds on them (AGENTS.md class 5).

---

## 1. Purpose

Two outcomes, in this order (D6, D8):

1. **Isolation.** `@seazn/engine` stops sharing a repo, a lockfile and CI with
   the app. Engine CI and Stryker stop taxing app PRs; the engine's boundary
   becomes a repo wall, not a lint rule.
2. **A second consumer.** `onryde/seazn.club.capture` (Expo 57, RN 0.86,
   Hermes), sub-project S2 Remote Scoring, imports `@seazn/engine` to run the
   scoring rules natively on the phone — never a WebView of the web pad. The
   app "writes no scoring rules" (capture
   `docs/specs/2026-09-29-multi-mode-app-decisions.md` row 5, S2, R4).

Outcome 2 is why this is more than a relocation: the engine needs a
deliberate export surface, a semver that means something for phones in the
field, and a hard guarantee that the subpaths a phone imports run under Hermes.

### Success criteria

- The engine lives in `onryde/seazn.club.engine`, published to GitHub Packages
  as `@onryde/seazn-engine`, consumed everywhere as `@seazn/engine` (D18, D19).
- The engine is pure: no network, no env reads, no Node-only code on phone
  subpaths, and `zod` its only runtime dependency (D11, D25).
- The Python placement service lives in `onryde/seazn.club.placement`; the
  web owns the gRPC client in `packages/scheduler` (D12, D27).
- **Test parity holds literally at the move**: engine `numTotalTests` and the
  `.testResults[].name` set are identical before and after; same for app suites
  importing the engine (D23).
- The matrix sample is green against the pinned version.
- Stryker's first full run in the engine repo puts every family ≥ floor and
  within ±0.5 of the last monorepo full run (D20).
- A W2-style fix (engine change + matrix proof) is still reviewed as one unit
  (D17).
- A capture build installs `@seazn/engine` through the alias and bundles it
  under Metro/Hermes (D14, D24).

## 2. Scope

**In:** the engine move; the placement move (D12, D13); the solver and logger
ports (D11, D25); the build and publish pipeline; versioning with fold epochs
and the server-side minimum-epoch gate (D15, D26); CI in all three repos;
Stryker migration including the new per-PR changed-lines run (D20, D21); test
parity; cutover and rollback.

**Out (D5, D10):**

- Moving `tools/matrix` out — it stays beside `apps/web` and consumes a pinned
  engine.
- Choosing a paid runner (the repos are public; §13 records what changes if
  not).
- Any engine behaviour change. The ports (D11, D25) change the engine's API
  and dependencies, not what it computes; §5.1 makes that a tested claim.
- **The theme contract and `@seazn/engine/pad` extraction** — its own
  programme, named as capture S2's prerequisite (§15).

## 3. Target architecture

```
onryde/seazn.club.engine          onryde/seazn.club                    onryde/seazn.club.placement
(pure TS library)                 (app)                                (Python service)
─────────────────────             ──────────────────────────────       ────────────────────────────
src/, rules/, testkit             apps/web ───────────┐                src/  (CP-SAT, gRPC server)
Stryker config + scripts          apps/cron-worker    │                proto/scheduler.proto  (OWNER)
golden ledgers, FOLD_EPOCH        packages/scheduler ◀┘ implements     tests/, bench/
                                    ├ solver adapter    engine's       Dockerfile, fly.toml, DEPLOY.md
publishes                           ├ placement-client  solver port    
@onryde/seazn-engine ─────────┐     ├ generated stubs                  publishes ONLY
  (GitHub Packages)           │     └ proto/ (vendored, sha-pinned) ◀── container image → GHCR
                              │   packages/reference                     (tagged by commit)
installed as alias            │   tools/matrix, tools/bench
"@seazn/engine": ─────────────┴─▶ (and by seazn.club.capture, S2)
  "npm:@onryde/seazn-engine@^N"
```

| Repo | Owns | Publishes | Deploys |
|---|---|---|---|
| `seazn.club.engine` | engine source, `rules/`, testkit, Stryker, golden ledgers | `@onryde/seazn-engine` to GitHub Packages | nothing |
| `seazn.club.placement` | Python CP-SAT service, `proto/scheduler.proto`, Python bench | container image to GHCR | Fly (stg, prod) |
| `seazn.club` | app, cron-worker, `packages/scheduler`, `reference`, `matrix`, `bench` | nothing new | Fly app (stg, prod), cron worker |

**Why the placement client left the engine (D11).** Until C8
(`e9a7c54ab`, 2026-08-17) the engine solved schedules in-process with z3/WASM.
When the solver moved to the Python service, the call stayed where the solver
had been: `scheduling/build.ts:2123` dynamically imports `placement-client.ts`,
which opens gRPC and reads `PLACEMENT_SERVICE_HOST` (`placement-client.ts:748`);
`build.ts:2125` reads `PLACEMENT_SERVICE_SECRET`. That made the engine a network
client with secrets, gave it `@grpc/grpc-js` and `@bufbuild/protobuf`, and
already broke a production build once (`scheduling/index.ts:1-20`). A port
moves all of it to the web, where the deployed service is.

## 4. Phases

| Phase | Where | When | Content |
|---|---|---|---|
| **1** | monorepo | now, alongside W2c–W2e | ports; `packages/scheduler`; publishable engine; RN-safe gate; test rehoming; golden ledgers + fold epochs; min-epoch gate. Six PRs (§5). App stays `workspace:`. |
| **2a** | placement repo | after Phase 1's port PR (§5.1) merges | placement moves; rehearsal of the new-repo recipe (§6) |
| **2b** | engine repo | after W2e merges | engine moves; app switches to the registry (§7) |

Phase 1 may touch `packages/engine` while W2c–W2e run; that is the owner's
explicit narrowing of ruling 131 (D7). Each Phase 1 PR is small and announced to
the live engine sessions before it merges, so they rebase once.

## 5. Phase 1 — in the monorepo

### 5.1 PR 1a — solver port, logger port, `packages/scheduler` (D11, D25)

- `buildSchedule(input)` (`scheduling/build.ts:1157`) gains two **required**
  fields: `solve: PlacementSolver` and `log: EngineLogger`.
  - `PlacementSolver = (input: SolveBuildInput, ctx: { requestId: string }) => Promise<SolveBuildOutcome>`.
  - `SolveBuildInput` / `SolveBuildOutcome` move from `placement-client.ts`
    into the engine (they describe the engine's problem, not the wire).
  - **Required, not optional.** An optional `solve` defaulting to greedy is an
    inert seam (AGENTS.md class 1): a caller that forgets it silently loses
    CP-SAT and every test stays green. Required makes the compiler find every
    call site. Same for `log`, or refusal logging (`build-refusal-logged.test.ts`)
    could vanish silently.
- The call at `build.ts:2123` becomes `input.solve(placementInput, { requestId })`.
  The any-rejection → greedy fallback is unchanged, byte for byte in behaviour.
- `repairDecomposedCpsat` (`repair-decompose-cpsat.ts:338`, call at `:471`)
  takes and threads `solve` and `log`.
- `scheduling/logger.ts` (pino, `process.env.LOG_LEVEL`) leaves the engine.
- New `packages/scheduler` (`@seazn/scheduler`, private workspace package):
  - `placementSolver` (the adapter): reads `PLACEMENT_SERVICE_HOST` /
    `PLACEMENT_SERVICE_SECRET`, maps engine domain → wire (`courtIndexOf` etc.),
    calls the client.
  - `placement-client.ts`, `src/generated/scheduler.ts` and `scripts/gen-proto.ts`,
    moved from the engine. Until 2a, `gen-proto` reads the root `proto/`.
  - `schedulerLog`: the pino logger the engine used.
  - deps `@grpc/grpc-js`, `@bufbuild/protobuf`, `pino`.
- Callers: `apps/web/src/server/usecases/schedule.ts:1925` and `:2487`, and
  `tools/bench`, pass `placementSolver` and `schedulerLog`.
- Engine tests inject a fake `solve`. That replaces `build.test.ts`'s
  `vi.spyOn(await import("./placement-client.ts"))` seam, the recorded
  inert-mock trap.
- Engine `package.json` drops `@grpc/grpc-js`, `@bufbuild/protobuf`, `pino`.
  `test/runtime-deps.test.ts` is updated to the new, smaller set.
- **Proving the seam (class 1):** a test runs the REAL `buildSchedule` with the
  REAL `placementSolver` against an in-process fake gRPC server and asserts the
  placed schedule, so producer and consumer are both real. The existing live
  integration test (`placement-integration.test.ts`, run by `placement-ci.yml:405`)
  moves to `packages/scheduler` and keeps running against the live service. The
  e2e spec that drives "Build schedule" through the UI is re-run (the plan
  names it after grepping the route, class 16).
- **"No behaviour change" is a test, not a claim:** before the PR, record
  `buildSchedule` outputs for the existing scheduling fixtures through the old
  path; after, the same inputs through the port give identical results.

### 5.2 PR 1b — publishable engine (D14, D16, D19, D25)

- **Name.** The package is renamed `@onryde/seazn-engine` now. Workspace
  consumers keep importing `@seazn/engine` through a pnpm workspace alias
  (`"@seazn/engine": "workspace:@onryde/seazn-engine@*"`). At 2b only `workspace:`
  becomes `npm:` — the cutover diff is a version string.
  *Assumption to verify first in the PR:* pnpm's `workspace:<name>@<range>`
  alias resolves for Next, vitest, strip-types and turbo. Fallback: keep the
  name `@seazn/engine` in the workspace and rename only in the publish step.
- **Build.** `tsconfig.build.json` with `rewriteRelativeImportExtensions`,
  `declaration`, `declarationMap`, `sourceMap`, target ES2022, ESM, out `dist/`.
  Run by TS7 `typescript-native`.
  *Assumption to verify first:* TS7 supports `rewriteRelativeImportExtensions`.
  Fallback: tsdown with one shared chunk (D14).
- **Exports.** All 22 subpaths keep their names. The workspace `exports` still
  point at `./src/**.ts`, so concurrent sessions see no change in Phase 1;
  `publishConfig.exports` points each subpath at `{ types: "./dist/….d.ts",
  default: "./dist/….js" }`, so every published artifact is `dist/` only.
  This is not D14's rejected "two artifacts": the workspace path exists only
  until 2b, and the packed-tarball proof (below) tests exactly what consumers
  get. After 2b no consumer sees source.
- **Manifest.** Drop `"private": true`. `zod` becomes `peerDependencies` +
  `devDependencies` only (today both peer and dependency, facts #3 — two zod
  copies break schema composition in `apps/web/src/server/api-v1/schemas.ts`).
  `files: ["dist"]` (no `proto` after D11). The plan's first step for this PR
  greps for any runtime read of `rules/`; only if one exists is `rules` added
  to `files`.
  `publishConfig.registry = https://npm.pkg.github.com`. `sideEffects: false`
  after a check that no module has import-time side effects the app relies on.
- **Packed-tarball proof** (CI job, `engine-pack`): `pnpm pack`, then from a
  scratch directory OUTSIDE the workspace install the tarball and:
  1. run a Node strip-types script importing `@seazn/engine/sports` (the
     `sync-sports.ts` shape that runs in the stg/prod deploy);
  2. `next build` a minimal page and route handler importing `core` and `sport`
     with no `transpilePackages`;
  3. bundle the phone subpaths with Metro for Hermes (`react-native bundle` or
     `expo export --platform android`) in a minimal RN fixture;
  4. type-check a consumer against the `.d.ts`.
  Each step asserts a count of modules or files resolved; zero is a failure.
- **Canaries.** On every merge to `main` that touches the engine, publish
  `0.0.0-canary.<sha>` with dist-tag `canary`. No stable release in Phase 1.
  Capture's R4 spike pins an exact canary.

### 5.3 PR 1c — RN-safe gate (D25)

- One authority for "the phone subpaths": `packages/engine/phone-subpaths.json`.
  Initial list is decided in the plan from what S2 needs (core, sport, sports
  and the fold/ledger subpaths; the scout pass of 2026-10-13 is the input).
- `scripts/engine-boundary.ts` gains a rule: every module reachable from a phone
  subpath imports no `node:*` builtin, reads no `process`, and imports nothing
  from `scheduling`. The rule reports the number of modules it walked; zero
  fails.
- The Metro/Hermes bundle in `engine-pack` (§5.2) is the runtime half of the
  same guarantee. Mutate once: add a `node:fs` import to a phone module and
  watch both go red.

### 5.4 PR 1d — test rehoming and the parity script (D23)

Of 13 engine tests that mention repo paths, 7 reach out of the package:

| File | Reaches | Change |
|---|---|---|
| `test/stryker-outputs-ignored.test.ts:13` | `.github/workflows/mutation.yml` | path re-rooted at 2b (the workflow moves with it); no change in Phase 1 beyond a single `WORKFLOW_PATH` constant |
| `test/stryker-sizing.test.ts:884-961` | `mutation.yml`, `tools/matrix/__tests__/matrix-workflow.test.ts` | the `MATRIX_RUNNER`-sharing assertions split out to a `tools/matrix` test; the engine keeps the sizing assertions |
| `test/stryker-changed-lines.test.ts` | repo paths | re-rooted like the two above |
| `test/boundary-gate.test.ts:7`, `eslint.config.mjs:19` | root `scripts/engine-boundary.ts`, `scripts/lib/tools-import-guard.mjs` | both scripts move into `packages/engine/scripts/`; the app keeps a thin wrapper if it still gates `tools/` |
| `src/scheduling/window-single-source.test.ts` | reads `apps/web/src` | app-side assertion rehomed to an `apps/web` test importing the package |
| `src/scheduling/z3-dependency-retired.test.ts` | `git rev-parse --show-toplevel`, scans `tools/` | split: engine half stays, monorepo half rehomed to a root `scripts/__tests__` test |
| `test/rules-reference.test.ts` (reads `ci.yml:308`; rows proven by app/e2e/tools tests) | `ci.yml`, app tests | split: engine-proven rows stay; app-proven rows move to an app test |

The other 6 (`src/history/{history.sequence,types,history.registry}`,
`src/exports/build`, `src/testkit/schema-snapshot`, `src/testkit/golden-policy`)
only mention paths in comments or synthetic strings and move unchanged.
`golden-policy` shells out to git and fails closed outside a checkout; the
engine repo is a checkout, so it holds.

**The parity script** (`scripts/test-parity.mjs`, lives in the engine and is
copied to the app): input two vitest JSON reports; output the ids
(`file › describe › it`) only in A, only in B, and in both, plus counts. With
a ledger file it fails on any id not accounted for (moved / rehomed / rewritten,
each with a reason). Zero ids in either report fails (anti-vacuity). The PR 1d
ledger is committed beside the spec. Paths in ids are normalised relative to
the package root, so the same script compares the monorepo and the engine repo
at 2b.

### 5.5 PR 1e — golden ledgers and fold epochs (D15, D26)

- `packages/engine/golden-ledgers/<sport>/*.json`: synthetic event ledgers per
  registered sport, each with its folded result. Swept with `forEachSport`;
  each sport must have ≥ 1 ledger, and the test reports the count checked.
- **These are change detectors, not oracles.** Their expected values come from
  the engine itself at the time of recording, on purpose: their job is to
  notice that a result changed, never to say it is right (TEST-STRATEGY rule 3
  governs correctness tests, which stay as they are).
- `FOLD_EPOCH: Readonly<Record<SportKey, number>>`, exported from a phone
  subpath, starting at 1 for every sport.
- The golden test fails when a sport's ledger result changes unless that
  sport's `FOLD_EPOCH` entry is bumped in the same diff (it compares against
  the committed baseline at `HEAD^1`, the same pattern as the Stryker floor
  gate). Re-recording a ledger requires the bump.
- At 2b, the engine repo's changeset check adds: a changed `FOLD_EPOCH` forces
  a `major` changeset (D16), and a changed `FOLD_MINOR` with no changed
  `FOLD_EPOCH` forces at least a `minor` changeset (D34).
- Mutate once: change one scoring constant in one sport; the test must name
  that sport and only that sport.

### 5.6 PR 1f — server minimum-epoch gate (D15, D26)

> **Amended by D31 / D32c** (decision log): the refusal code is `ENGINE_OUTDATED`, not `engine_outdated`; `engine_epoch` is
> OPTIONAL and there is no `engine_epoch_missing` refusal (the server cannot tell a capture phone from the web pad: both use the
> same `dl_` device link); and the `docs/contracts` entry is deferred to capture S2 (no scoring-events contract exists today), with
> `docs/superpowers/specs/engine-split/capture-s2-handoff.md` standing in for it. The bullets below are the original text, kept
> for history.

- Any scoring write that carries a client epoch is checked: the server refuses
  when the client's epoch for that match's sport is lower than the server's
  `FOLD_EPOCH[sport]`. Refusal is HTTP 426 with
  `{ code: "engine_outdated", sport, required, got }` (a new refusal code in the
  API's existing refusal shape).
- The web pad never sends it (it is always the server's own build). A native
  client MUST send it; requests authenticated as a capture device without it
  are refused with `engine_epoch_missing` — otherwise an omitted header is a
  bypass.
- The contract (`docs/contracts/…`) gains the field and the refusal, so capture
  vendors it.
- Owed to capture S2's own design, recorded not decided: what a match **already
  in progress** does when the epoch moves (finish under the old rules, or stop
  and ask for an update).
- This PR does not block 2a or 2b; it must land before capture S2 ships.

**Delivered after 1f: the per-sport floor override (the emergency lever; owner ruling 2026-10-15, review 1f lens 3).** After a bump
reaches prod, every capture app on the old epoch is locked out of that sport until it updates, and the only way back used to be a
Fly rollback. `ENGINE_EPOCH_FLOOR_OVERRIDE=football=2,hockey=1` (a Fly secret; a restart applies it) LOWERS the floor for the
sports it names: the gate compares against `min(foldEpochOf(sport), override)`, so it can never raise one.
`apps/web/src/server/usecases/engine-epoch-override.ts` owns it.
- **Default off.** Unset or blank changes nothing. Production use is the point (it is not a local/ci-only `tunable()`).
- **Understood or off, never a guess.** An unknown sport (checked against the `FOLD_EPOCH` keys), an epoch that is not an integer >= 1,
  a duplicate sport, an empty pair or a pair with no `=` THROWS at boot (`instrumentation.ts`, beside `relayDriverMode()`: the process
  stays up and answers 500 until it is fixed; the throw is first sent to Sentry and flushed). A typo never ships as "no override", nor
  as a wrong floor. If boot was bypassed, the GATE does not throw: a value it cannot read is OFF (every sport keeps its declared
  floor, today's behaviour), reported once per distinct bad value to the log and to Sentry as an error, and never echoed in an HTTP body.
- **Loud.** Boot logs `ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE { sport, floor, declared }` once per sport and sends the same sentence to
  Sentry as a warning. An entry at or above the sport's own epoch is inert: boot logs `ENGINE_EPOCH_FLOOR_OVERRIDE_INERT` (log only)
  and does NOT throw, so a stale entry left behind by a later bump cannot take prod down. Each request admitted ONLY because of the
  lever logs `ENGINE_EPOCH_FLOOR_OVERRIDDEN { sport, floor, declared, got, via, deviceLinkId, fixtureId }`: at most one line per
  request that passed the gate (it says the gate admitted, not that a row was written; a cold retry of a key the ledger holds passes
  the gate again, and a stale `expected_seq` is still refused after admission). Per-request lines are log-only (the Sentry quota).
  In every line `floor` and `required` mean the effective floor and `declared` means the sport's own epoch.
- **Unchanged.** Absent `engine_epoch` is accepted (D31), ahead is accepted, a keyed retry replays before any refusal, and
  authorisation / entitlement / phase refusals still outrank the gate. The 426 code and shape are the same; under an override
  `required` reports the EFFECTIVE (lowered) floor, the number the client must reach, and the lockout log adds `declared`.

## 6. Phase 2a — placement repo (rehearsal; D13, D22, D27)

1. Tag `placement-split-base` in seazn.club at the last commit touching
   `services/placement/**` or `proto/**`.
2. Owner approves creating `onryde/seazn.club.placement` (public).
3. Import commit: `services/placement/**` → repo root, `proto/**` → `proto/`.
   Message cites `onryde/seazn.club@<tag sha>`. AGENTS.md states where
   pre-cutover history lives.
4. Placement CI: the Python test job, the docker job, `buf breaking` against
   `main`, and an image push to `ghcr.io/onryde/seazn-placement:<sha>` (public).
   Placement stg/prod deploy workflows move from `placement-stg.yml` /
   `placement-prod.yml`; the owner sets the Fly secrets in the new repo.
5. Web PR (one):
   - `packages/scheduler/proto/scheduler.proto` + `VENDORED.json`
     `{ placementCommit, sha256, imageTag }`, written by
     `pnpm --filter @seazn/scheduler vendor:proto <placement checkout>`.
   - `gen:proto` reads the vendored copy; the stub drift check
     (`placement-ci.yml:297-305` today) moves to `ci.yml`; a pin test checks the
     copy's sha256.
   - The live integration test runs against the GHCR image at `imageTag` as a
     service container.
   - Every workflow that builds the image from `services/placement` today —
     `ci.yml:857,1152,1428`, `e2e.yml:625,1158,1508`, `bench.yml:147` — pulls
     the pinned GHCR image instead.
   - Delete `services/placement/**`, `proto/**`, `placement-ci.yml`,
     `placement-stg.yml`, `placement-prod.yml`; add a guard that fails any PR
     re-adding them.
6. **Proof:** placement stg deploy from the new repo green; web CI integration
   test green against the image; "Build schedule" e2e green on the pinned image;
   bench run green.
7. **Rollback:** revert the web PR (restores the tree and workflows). The
   placement repo is left in place, never deleted.

**Proto change rule after 2a:** additive only (`buf breaking` enforces). Order:
placement PR → deploy placement → re-vendor in web. An un-re-vendored web keeps
working because the server accepts the old shape.

What 2a rehearses for 2b: the import commit, a new repo's CI, secrets,
publishing an artifact, the web-side guard, the parity proof shape and the
rollback.

## 7. Phase 2b — engine repo cutover (D20, D22, D23, D24)

**Freeze.** From W2e's merge until the cutover PR merges (~1 working day), no
PR touching `packages/engine` merges in seazn.club. Announced by a dated
AGENTS.md line, a message to every live session touching the engine, and a
temporary CI check failing engine-touching PRs. The ~10.8 h cold Stryker run
runs inside the freeze and gates the cutover PR's merge (step 6), so the freeze
is about one day from the import commit.

**Order.**

1. Tag `engine-split-base`.
2. Owner approves creating `onryde/seazn.club.engine` (public). Import commit:
   `packages/engine/**` → repo root. Repo set to merge commits (the `HEAD^1`
   gates rely on it).
3. Engine CI (§10.1) green. Parity script: engine report at the tag vs at the
   import commit — identical ids and `numTotalTests`. **The cold Stryker run
   starts now** (§11.2); its baseline is a monorepo full run on the
   `engine-split-base` commit (dispatched at step 1 unless the latest weekly
   run already covers that engine tree).
4. Package settings: grant seazn.club (and seazn.club.capture) read access to
   `@onryde/seazn-engine` under "Manage Actions access".
5. Owner merges the first Version PR; `1.0.0` publishes.
6. App cutover PR (one):
   - delete `packages/engine/**`; `"@seazn/engine": "npm:@onryde/seazn-engine@^1.0.0"`
     in every consumer (`apps/web`, `packages/reference`, `tools/matrix`,
     `tools/bench`, `packages/scheduler`, root);
   - root `.npmrc`: `@onryde:registry=https://npm.pkg.github.com` (no token in
     the file — auth comes from the environment);
   - Dockerfile: `RUN --mount=type=secret,id=npmrc` for `pnpm install`;
     `stg.yml` / `prod.yml` pass the secret to `docker/build-push-action`;
   - CI: `packages: read` and the token on every install step;
   - S3: tools/bench, tools/matrix, packages/reference, rules-reference and
     `scripts/__tests__` switch from `./packages/engine/node_modules/.bin/vitest`
     (`ci.yml:237,257,283,308,811`) to a root vitest devDependency;
   - monorepo Stryker retires in this PR: `mutation.yml`, the S4
     `pnpm-workspace.yaml` overrides and `lock-isolation.test.ts`'s pins are
     deleted (nothing is left to mutate). D20.3's "keep running until parity"
     is honoured by ordering, not overlap: **this PR merges only after the
     engine repo's cold run has passed parity** (step 3 starts it; ~11 h, inside
     the ~1-day freeze);
   - S7: `matrix-rows` (R27, `ci.yml:1751`) and `matrix-sample` trigger on
     "`@seazn/engine` version changed in a `package.json`";
   - guards: no committed `link:`/`file:` engine spec (D17); alias target is
     `@onryde/seazn-engine` (D19); `packages/engine/**` cannot be re-added.
7. App CI, matrix sample, stg deploy (including `sync-sports` against the
   registry install), and smoke all green. Parity script: app suites importing
   the engine, `workspace:` vs `1.0.0`, identical. Owner merges.

**In-flight branches.** `scripts/port-engine-branch.sh <branch>` takes the
branch's `packages/engine` diff, applies it with `git apply -p3` in an
engine-repo worktree, and opens the engine PR plus the paired app PR (D17).
The author ports their own branch; the script does the mechanics.

**Rollback.** Revert the app cutover PR — it restores `packages/engine` and
`workspace:` in one revert. The window closes at the first post-cutover merge
in the engine repo, so engine-repo merges hold until stg plus one prod deploy
are green. The engine repo and its packages are never deleted (standing rule).

**Proof the cutover worked:** D23 parity outputs (engine and app); `sync-sports`
in the stg and prod deploys on the registry install; the Docker build with the
secret; matrix sample on the pin; Stryker cold-run parity (§11); a capture
build installing `@seazn/engine` through the alias and bundling for Hermes.

## 8. Versioning and release (D15, D16, D26)

**Semver covers the TypeScript API and the fold outcome.**

| Bump | When |
|---|---|
| major | a breaking API change, or **any existing event sequence folds to a different result** (rule fixes included; a result confined to the standings deltas is a minor, D34); also whenever any `FOLD_EPOCH` entry changes |
| minor | additive: new sport, event type, subpath or API; also whenever a `FOLD_MINOR` entry changes with no `FOLD_EPOCH` entry changing (only server-computed output moved, D34) |
| patch | no observable change |

Accepted cost: majors are frequent while the W-waves fix rules. Consumers pin a
caret on the current major and bump deliberately.

**Changesets.** Every engine PR carries `.changeset/*.md`. CI fails a PR with
none, and fails one whose `FOLD_EPOCH` changed under a non-major changeset, or whose
`FOLD_MINOR` changed (with no `FOLD_EPOCH` change) under a changeset below minor. The
Changesets action keeps a "Version Packages" PR open; **the owner merges it**,
which publishes to GitHub Packages, tags `vX.Y.Z` and writes a GitHub Release.

**Channels.**

| Channel | Version | dist-tag | When |
|---|---|---|---|
| canary | `0.0.0-canary.<sha>` | `canary` | Phase 1, from the monorepo |
| PR snapshot | `0.0.0-pr<N>.<sha>` | `pr` | every engine-repo PR, after 2b |
| stable | `X.Y.Z` | `latest` | Version PR merge; `1.0.0` at 2b |

**Fold epochs, not majors, gate phones.** A major says "something changed";
`FOLD_EPOCH[sport]` says which sport. One cricket fix must not lock every phone
scoring badminton. Phones send `{ sport, epoch }`; the server refuses only the
sport that moved (§5.6).

## 9. Cross-repo dev loop (D17)

1. **Local.** In the app checkout, an uncommitted `pnpm.overrides`
   `"@seazn/engine": "link:../seazn.club.engine"`, with `tsc --watch` running in
   the engine. CI fails any committed `link:`/`file:` engine spec.
2. **Paired PRs — the unit of review.** The engine PR publishes
   `0.0.0-pr<N>.<sha>`. The app PR pins that exact version and carries the
   matrix rows, contract tests and any web change. Each links the other;
   reviewers review both. Merge order: engine PR → owner merges Version PR →
   release → app PR repins to the release (a one-line diff; CI re-runs) → merge.
3. **Downstream check on every engine PR.** Check out seazn.club `main`, install
   the PR snapshot, run app `tsc`, the W2c `apps/web/src/lib/match-rules/__tests__/*.contract.test.ts`
   (on main once W2c merges) and `tools/matrix` unit tests. No DB. The full
   matrix sample runs on the app PR.

TEST-STRATEGY rule 9 (PRs touching the engine declare their format × sport
rows) still binds: the engine PR declares the rows; the paired app PR runs them.

## 10. CI per repo

### 10.1 Engine repo

| Gate | From | Note |
|---|---|---|
| tsc, lint, unit tests + coverage, `sim:matrix` | `ci.yml:464-522` | moves |
| `engine:boundary` + RN-safe rule | `ci.yml:105` + §5.3 | moves, with its scripts |
| schema snapshot drift | `ci.yml:171-176` | moves |
| single-sport ratchet `--against HEAD^1` (R26) | `ci.yml:113` | duplicated: engine ratchets engine tests; the app keeps its own |
| Stryker floor gate `--check-file-against HEAD^1` | `ci.yml:126` | moves (§11) |
| `mutation.yml` (81 legs, weekly) | whole file | moves; weekly gate on its own `STRYKER_WEEKLY_ENABLED` |
| changeset required; `FOLD_EPOCH` ⇒ major; `FOLD_MINOR` (alone) ⇒ minor | new | §8 |
| golden ledgers | PR 1e | moves |
| per-PR changed-lines Stryker, advisory | new | §11 |
| downstream check | new | §9 |
| `engine-pack` tarball proof | PR 1b | moves |
| publish (canary / snapshot / release) | PR 1b + new | §8 |

### 10.2 App repo

- **Stays:** OpenAPI drift (`ci.yml:130`). `api-v1` schemas import engine zod
  schemas, so a bump that changes the API reddens the bump PR. That is the
  correct place. `build-guard.yml`, the matrix sample, `matrix-truth.yml`,
  `e2e.yml`, smoke.
- **Retargeted:** `matrix-rows` and the matrix sample (S7, §7 step 6).
- **Own vitest** (S3).
- **New guards:** `link:`/`file:` spec; alias target; `packages/engine/**` and
  `services/placement/**` re-add; scheduler stub drift + vendor pin (§6);
  min-epoch gate tests (§5.6).

### 10.3 Placement repo

Python tests, docker build, `buf breaking`, GHCR push, stg/prod deploys (§6).

### 10.4 Registry auth (D18)

| Where | Credential | Rule |
|---|---|---|
| App CI | `GITHUB_TOKEN`, `permissions: packages: read`; package grants the repo read | never printed |
| App Docker build (`stg.yml`, `prod.yml`) | BuildKit `--secret id=npmrc` | never in a layer, never in `.npmrc` committed |
| Engine repo publish | `GITHUB_TOKEN`, `packages: write` | publish job only |
| Local dev | personal token with `read:packages` in `~/.npmrc` | documented in each AGENTS.md |
| Capture EAS builds | `NPM_TOKEN` EAS secret + `.npmrc` | capture's own setup |
| GHCR image pull | none (public image) | |

## 11. Stryker migration (D20, D21)

1. **Floors carried unchanged.** All ten family floors in `stryker-floor.json`
   (competition 77.9, core 88.7, modules 65.2, draws 70.9, cricket 71.1,
   football 71.3, setbased 74.5, nested 73.7, other 73.3, period 68.6) move as
   they are.
2. **Parity is a deliberate cold run.** The first full run in the engine repo
   (81 legs, ~10.8 h at 12 slots, free while public) must put every family
   ≥ floor **and** within ±0.5 of the last monorepo full-run score. Outside ±0.5
   is investigated before the monorepo copy retires. No cache seeding — the cut
   fingerprints hash files relative to the engine dir (`stryker-matrix.mjs:18-19`),
   so nothing needs re-keying, and a cold run is the independent evidence.
3. **Parity before retirement.** The monorepo copy cannot outlive
   `packages/engine`, so overlap is replaced by ordering: the app cutover PR —
   which deletes `mutation.yml`, the S4 `pnpm-workspace.yaml` overrides and
   `tools/matrix/__tests__/lock-isolation.test.ts`'s pins — merges only after
   the engine repo's cold run passes parity (§7 steps 3 and 6).
4. **`HEAD^1` gates.** Same meaning in the engine repo (merge commits, so on a
   PR `HEAD^1` is the base). The import commit has no parent: a test pins that
   the gates treat a missing `HEAD^1` as "no baseline, check the floor file
   against itself", never as a pass by crash.
5. **Durable incremental files.** Each leg uploads its incremental json as a
   workflow artifact (90 days). Restore tries the Actions cache, then the
   latest artifact for that leg. Supabase Storage only if artifacts prove
   insufficient, and never the production project.
6. **`STRYKER_RUNNER`**, separate from `MATRIX_RUNNER`; unset ⇒ `ubuntu-latest`.
7. **Per-PR changed-lines run** (new; `scripts/stryker-changed.mjs` exists only
   as a local tool today). Advisory first: survivors on changed lines are posted
   as a PR comment, with timing recorded. After ~4 weeks, at a dated checkpoint,
   it becomes blocking — a survivor fails the PR unless recorded in
   `stryker-equivalent.json` in the same PR — with timeout and refactor-only
   exemption set from the data.
8. `MUTATION.md:549`'s "11.5 h" is stale (now ~10.8 h after #947); the moved
   doc is corrected in the import.

## 12. Test parity (D23)

Summarised from §5.4 and §7:

- **Phase 1 (PR 1d):** the 7 out-reaching tests are split or rehomed, in one
  repo, with a ledger. The parity script fails on any unaccounted id or on zero.
- **2a:** parity script on `packages/scheduler` + web suites importing the
  scheduler, before vs after.
- **2b:** engine report at `engine-split-base` vs the import commit — identical
  ids, identical `numTotalTests`. App suites importing the engine — `workspace:`
  vs `1.0.0` — identical. Matrix sample green on the pin. Stryker within ±0.5.
- **Every count is checked from the JSON reporter, with `.testResults[].name`
  confirmed** (AGENTS.md: `rtk` summaries and `--root` both lie).

**Each Phase 1 PR owes the four test types** (RULES.md): unit; e2e (traced
forward to the user flow — "Build schedule" for 1a, a scoring flow for 1e/1f);
smoke (`scripts/smoke.ts` covers the stg deploy that runs `sync-sports`);
regression (the specific trap each PR guards: inert `solve`, a phone module
importing `node:*`, a golden change without an epoch bump, a missing client
epoch). Each guard added is mutated once (TEST-STRATEGY rule 5).

## 13. Going private later (D3)

Flip visibility on any of the three repos, then:

- set `STRYKER_RUNNER` (and `MATRIX_RUNNER`) to a paid runner (research:
  `.superpowers/handoff/2026-10-08-w1d-close/runner-research.md`; a cold
  Stryker run hosted is ~$86);
- GHCR placement image becomes private: the app's image pulls need a token
  (`packages: read`, same grant as the engine package);
- nothing else. Registry auth is already in place everywhere (D18).

## 14. Risks and assumptions

| # | Assumption / risk | Verified by | Fallback |
|---|---|---|---|
| R1 | TS7 supports `rewriteRelativeImportExtensions` | PR 1b, first commit | tsdown, one shared chunk |
| R2 | Metro resolves package `exports` for these subpaths | `engine-pack` step 3 | `react-native` condition or Metro `unstable_enablePackageExports` |
| R3 | pnpm `workspace:<name>@*` alias works for Next/vitest/strip-types/turbo | PR 1b | rename only in the publish step |
| R4 | Engine runs fast enough on a budget Android under Hermes | capture's R4 spike, against a canary | out of this programme; reported back |
| R5 | Stryker incremental files hold engine-relative paths (facts #23: likely, unverified) | read one real file in PR 1b's prep | irrelevant to parity (cold run); matters only for cache reuse |
| R6 | Phase 1 PRs collide with W2c–W2e edits in `scheduling/` and `package.json` | announce + small PRs; check W2c's touched files before 1a | sequence 1a after the colliding W2c PR |
| R7 | A rule fix ships under a minor because nobody re-recorded a golden ledger | golden test fails on any result change, not on re-record | — |
| R8 | GitHub Packages token missing in some install path (a script, a worktree, an agent) | `engine-pack` + cutover proof; AGENTS.md note | the alias install fails loudly (401), never silently |

## 15. Owed to other programmes

- **Theme + pad extraction (D10)** — its own programme, capture S2's
  prerequisite: (a) theme tokens exported as a vendored contract
  (`docs/contracts/sport-theme.v1.json`, generated from `SPORT_PALETTES` in
  `apps/web/src/components/v2/scorepad/v3/sport-theme.ts`, with a drift test);
  (b) the pad's rule-bearing data (event types, sanction levels, bands —
  today inside `scorepad/v3/skins/*.tsx`, ~13k lines mixed with React UI and web
  i18n) extracted into `@seazn/engine/pad`, a minor release. Finding for
  capture: its S2 row calls the skins "already pure data"; they are not.
- **Capture S2:** sends `{ sport, epoch }` on every scoring write; designs the
  in-progress-match behaviour when an epoch moves (§5.6); EAS `NPM_TOKEN`.
- **f-w2c / W2d / W2e:** rebase once over each Phase 1 PR; freeze notice at 2b.
- **Mutation session (post-#947):** owns current Stryker sizing until 2b; the
  cold-run parity check needs its last full-run scores.

## 16. Decision ledger

`OWNER` = the owner ruled it in chat, quoted in Source. `FACT` = verified.

| # | Date | Decision | Status | Source |
|---|---|---|---|---|
| D1 | 2026-10-13 | Cut over after W2e. W2c/W2d/W2e finish in the monorepo; design and plan now, no code moves before W2e merges (narrowed by D7). | OWNER | format-matrix `_INDEX.md` ruling 131 |
| D2 | 2026-10-13 | Repo name `onryde/seazn.club.engine`. Not created during design; creation is a plan step the owner approves. | OWNER | brief |
| D3 | 2026-10-13 | Engine repo PUBLIC for now; hosted Actions free. Going private later must be a settings change plus a runner variable, not a redesign (§13). | OWNER | brief, ruling 131 |
| D4 | 2026-10-13 | seazn.club is public today. | FACT | `gh repo view` (facts #35) |
| D5 | 2026-10-13 | Out of scope: moving the matrix out, choosing a runner, any engine behaviour change. | OWNER | brief |
| D6 | 2026-10-13 | Purpose is isolation **plus a second consumer**: `seazn.club.capture` S2 Remote Scoring imports `@seazn/engine`. So: a deliberate export surface, a real semver and a changelog from day one; phone subpaths must bundle under Metro/Hermes. | OWNER | "B, for mobile app in remote scoring" / "seazn.club.capture" |
| D7 | 2026-10-13 | **Phased.** Phase 1 in the monorepo alongside W2c–W2e (build, exports, RN gate, tarball proof, canaries; app stays `workspace:`); then the moves. The owner allows Phase 1's packaging changes before W2e — a narrowing of ruling 131, not a reversal. | OWNER | "A" to Q2 |
| D8 | 2026-10-13 | Capture's remote scoring is **native UI, never a WebView**, with a theme similar to the web pad's. The phone needs rules, theme tokens and the pad's rule data — none as React/DOM code. | OWNER | "we are planning to build native remote scoring with similar theme" / "not importing webview" |
| D9 | 2026-10-13 | Move list: engine (`src`, `rules/`, testkit, Stryker) moves; `packages/reference`, `tools/bench`, `tools/matrix`, `apps/cron-worker` stay; the live placement integration test moves to the app side; the 13 path-mentioning tests are handled per §5.4. (Its proto and placement rows are superseded by D11, D12, D27.) | OWNER | "i" to Q3 |
| D10 | 2026-10-13 | Theme contract + `@seazn/engine/pad` extraction is its own programme, capture S2's prerequisite (§15). | OWNER | "i" to Q3 |
| D11 | 2026-10-13 | Placement client leaves the engine via a solver port, in Phase 1 (§5.1). Engine drops gRPC, protobuf and the env reads. Stryker unaffected (`stryker.groups.mjs:1` excludes placement scheduling). | OWNER | "A" to Q5 |
| D12 | 2026-10-13 | Three repos, shape **Z**: engine = pure TS library; `onryde/seazn.club.placement` = Python service + `proto/` + Fly deploy; web `packages/scheduler` = solver adapter + gRPC client + stubs from a vendored, sha-pinned proto. Why Z over Y (placement publishing a TS client): `proto/` had 13 commits, all in 2026-08, none since. Amended by D27. | OWNER | "keep the scheduler as a package in web and also move out python to the new repo"; "Z" |
| D13 | 2026-10-13 | Placement repo moves first (2a), as a rehearsal for the engine move (2b). | OWNER | "Z, placement first as rehearsal" |
| D14 | 2026-10-13 | Build = plain `tsc` emit (TS7, `rewriteRelativeImportExtensions`): per-file ESM + `.d.ts` + source maps in `dist/`, ES2022; 22 subpaths keep their names. Rejected: per-subpath bundles (duplicate modules → identity bugs); shipping source + compiled (two artifacts). | OWNER | "A" to Q4 |
| D15 | 2026-10-13 | Semver covers the TS API **and** the fold outcome; golden-ledger test enforces; server-side minimum gate is in this programme (refined by D26). | OWNER | "c" to Q6 |
| D16 | 2026-10-13 | Release = Changesets; owner merges the Version PR; canaries in Phase 1, `1.0.0` at 2b, PR snapshots after. Rejected: release-please, manual tags. | OWNER | "approve you rec" to Q7 |
| D17 | 2026-10-13 | Dev loop: local `link:` override (CI-guarded), paired PRs pinned to a PR snapshot, downstream check on every engine PR (§9). | OWNER | "yes" to Q8 |
| D18 | 2026-10-13 | Registry = GitHub Packages, over public npmjs.com. Accepted: install auth everywhere; scope must be `@onryde`. | OWNER | "GitHub Packages" to Q9 |
| D19 | 2026-10-13 | Published `@onryde/seazn-engine`, installed under the alias `@seazn/engine`; zero import changes. The engine's 27 internal `@seazn/engine` mentions are comments only. CI pins the alias target. | OWNER | "A" to Q10 |
| D20 | 2026-10-13 | Stryker migration per §11 items 1–6. | OWNER | "Ok" to Q11 |
| D21 | 2026-10-13 | Per-PR changed-lines Stryker: advisory first, blocking after ~4 weeks at a dated checkpoint (§11.7). | OWNER | "Ok" to Q11 |
| D22 | 2026-10-13 | Fresh history: one import commit per new repo citing `onryde/seazn.club@<sha>`; tags `placement-split-base` / `engine-split-base`; pre-cutover history and SHAs stay in seazn.club, which is never rewritten or deleted. Rejected: `filter-repo` (monorepo-wide messages and `#NNN` PR numbers that read as the new repo's). | OWNER | "I prefer B" to Q12 |
| D23 | 2026-10-13 | Test parity: rehome the 7 out-reaching tests in Phase 1 with a ledger; the 2b move is then count-identical (§5.4, §12). | OWNER | "Ok" to Q13 |
| D24 | 2026-10-13 | Cutover per §7: ~1-day freeze, one app cutover PR, in-flight porting script, revert-based rollback closing at the first engine-repo merge. | OWNER | "Ok" to Q14 |
| D25 | 2026-10-13 | Logger becomes a port (engine's only runtime dep → `zod`); `zod` peer-only; RN-safe gate in `engine-boundary`. | OWNER | "Ok" to Section 1 |
| D26 | 2026-10-13 | Per-sport fold epoch (`FOLD_EPOCH`) refines D15: phones send `{sport, epoch}`; the server refuses only the sport that moved. In-progress-match behaviour owed to capture S2. | OWNER | "Ok" to Section 1 |
| D27 | 2026-10-13 | Web gets the gRPC client by vendoring the proto into `packages/scheduler` (`VENDORED.json` `{placementCommit, sha256, imageTag}`) and generating stubs; placement CI runs `buf breaking`; placement publishes **only a container image** to GHCR, which web CI, e2e and bench pull. | OWNER | "Ok" to the D27 amendment |
| D28 | 2026-10-13 | CI per repo per §10, including registry auth (§10.4) and the going-private delta (§13). | OWNER | "approve" to Section 2 |
| D29 | 2026-10-13 | Spec-writing defaults, approved with the spec: `solve` and `log` are **required** fields (§5.1, inert-seam reason); package renamed in Phase 1 with a pnpm workspace alias (§5.2); `publishConfig.exports` keeps the workspace on source until 2b (§5.2); min-epoch refusal is HTTP 426 `engine_outdated`, and a capture request without an epoch is refused `engine_epoch_missing` (§5.6); weekly Stryker gets its own `STRYKER_WEEKLY_ENABLED` (§10.1); **D20.3's overlap replaced by ordering** — the monorepo Stryker copy cannot outlive `packages/engine`, so the cutover PR merges only after the engine repo's cold run passes parity, which keeps the freeze at ~1 day (§7, §11.3). | OWNER | "approve" to the written spec |
| D30 | 2026-10-13 | **Execution topology for this programme's plans:** batches; each task implemented AND task-reviewed on **Sonnet** (`implementer-sonnet` / `reviewer-sonnet`), each batch reviewed on **Opus** (`reviewer`). Extends the owner's 2026-10-13 W2c-only Sonnet exception (RULES.md) to the engine-split programme. | OWNER | "ready to execute as a batches with sOnnect for task and review and opus for batch reiew" |
| D31 | 2026-10-14 | **`engine_epoch` is optional; no `engine_epoch_missing` refusal** (amends D29). The server cannot tell a capture phone from the web pad: both use the same `dl_` device link (`apps/web/src/server/api-v1/auth.ts:245-278`), `device_links` has no source column (`V222__device_links.sql:6-15`), and capture-minted links are also shown as QR codes for browsers. Capture S2 sends the field on every write from its first release. Refusal code `ENGINE_OUTDATED` (API's UPPER_SNAKE convention). The phone sends only `engine_epoch`; the fixture's sport on the server is authoritative (refines §8's `{sport, epoch}`). | OWNER | "approve" (2026-10-14), on the recommendation from Phase 1 plan scouting + Opus plan review |
| D32 | 2026-10-14 | **Plan-level deviations from this spec, for the owner:** (a) parity script lives at root `scripts/lib/test-parity.mjs` (beside its `.d.mts` twin, as `tools-tests-typecheck` requires) (spec §5.4 said "in the engine, copied to the app") and collects ids with a no-match `vitest run -t`, not `vitest list` (which drops skipped tests); (b) §5.5's new golden ledgers are the EXISTING corpora (`src/sports/*/<key>.golden.json`), guarded on `events`/`states`/`outcome`/`summary`/`deltas`; (c) §5.6's `docs/contracts` capture contract for score events is deferred to capture S2 (no events contract exists today); (d) `tools-import-guard` stays until 2b; (e) `tools/bench` is not a `buildSchedule` caller (§5.1 premise false); (f) `rules/` ships at the package root (`files: ["dist","rules"]`), golden corpora do not ship (unreachable through `exports`); (g) the `MATRIX_RUNNER`→`STRYKER_RUNNER` rename moves to 2b (it touches the mutation session's files and tools/matrix pins); (h) `@seazn/engine/scheduling` becomes client-importable after 1a (no gRPC left), and its "server-only" comments are retired; (i) **spec gap:** §5.4 inventories only engine tests that read the monorepo — the reverse direction (≥74 non-engine test files read engine-owned paths, e.g. `tools/matrix/__tests__/matrix-workflow.test.ts` reads `mutation.yml`) needs an inventory with a 2b fate per file, added to Phase 1 batch 1d. | OWNER | "approve" (2026-10-14), on the recommendation from Opus plan review `docs/superpowers/specs/engine-split/reviews/plan-phase1.md` |
| D33 | 2026-10-14 | **Plan task 1a-0 approved:** D30 (Sonnet task implement+review, Opus batch review) is recorded in `docs/superpowers/RULES.md` as an engine-split programme exception beside the W2c one. Phase 1 plan rev 2 (`6452f970d`) approved for execution. | OWNER | "approve" (2026-10-14) |
| D34 | 2026-10-15 | **A sport's fold version is a pair (major, minor)** (refines D26 and D31; answers the "bumps are also forced by deltas-only changes" cost recorded in the 1e review, D32b note). `FOLD_EPOCH` / `foldEpochOf` are unchanged and mean the **major**: anything a phone computes moved (a golden stream's `states`, `outcome` or `summary`), or a stream was removed or re-recorded (identity change, including any change to its raw config object, so the config-in-input rule still blocks laundering). The server's gate (batch 1f) compares the major only. New `FOLD_MINOR` / `foldMinorOf`, in the same import-free `src/sport/fold-epoch.ts` (frozen, registry-keyed, on `./sport`, phone closure still 47 modules), move when **only server-computed output** moved: a stream whose states, outcome and summary are identical and whose `deltas` differ. A minor needs no app update and refuses no phone. **Every module embeds its config in its state, so changing an existing default VALUE (a `pointsMap` of `2/0` becoming `3/0`, a `cap`) moves states and is a MAJOR**; the golden replay reds on it and `REBASELINE_GOLDEN` cannot land it. The real minors, each walked through the tooling with the replay green: a change to the code of `standingsDelta` / `supportsDraws`; credit on a metric that is not displayed (the set kernels' `points_won` credited by a forfeit; credit the summary reads, football's `goalCredit`, is a major); a default that only ADDS a key. A division's own config, set by an organiser, never owes a version change. The premise that a phone never computes or renders `standingsDelta` / `supportsDraws` / non-headline credit is a contract (stated in `fold-epoch.ts` and the capture S2 handoff), not something the code enforces; if a phone ever does, this decision is to be revisited. Order: the pair `(major, minor)` per sport goes up lexicographically; a major that rose may reset the minor to 0; a minor bump never settles a change owed as a major; both kinds in one sport owe the major; anything ambiguous rounds up to major. A baseline without `FOLD_MINOR` reads as minor 0. Initial values: every sport major 1, minor 0. Not changed: a harness-only rewrite that moves a state string without changing its meaning is still a major (digest comparison stays open); the kernel and `core.*` gaps in `GOLDEN-POLICY.md` still owe a manual major. | OWNER | "yes, do it now along with 1f" (2026-10-15), on the recommendation to split the version so a scoring change the phone does not compute does not lock out older phones; the examples above are corrected per the 1e-M review F1, option (i), as relayed by the controller 2026-10-15 (`reviews/1e-minor.md`) |
