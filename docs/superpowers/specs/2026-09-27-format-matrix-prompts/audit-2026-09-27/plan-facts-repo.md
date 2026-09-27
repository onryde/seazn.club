# Repo facts for packages/reference + harness + weekly workflow
Worktree: /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix @ 3136e1c1a (paths relative to it)
Worktree has NO node_modules (node_modules/typescript-native, packages/engine/node_modules/.bin/vitest absent) — install before verifying.

## 1. Workspace layout
pnpm-workspace.yaml:1-3        packages: "apps/*", "packages/*"   (glob — a new packages/reference is auto-included)
pnpm-workspace.yaml:38-40      publicHoistPattern pdfkit, exceljs only (strict linker; no blanket hoist)
package.json:5-9               npm "workspaces" mirror (apps/*, packages/*); "type":"module"; packageManager pnpm@10.34.5; engines node>=26
package.json:20                lint      = web lint && engine lint && lint:scripts   (explicit per-workspace chain — new pkg NOT included unless added)
package.json:21                typecheck = web typecheck && engine typecheck         (explicit chain)
package.json:22                typecheck:scripts = node node_modules/typescript-native/bin/tsc -p tsconfig.scripts.json
package.json:23                test      = web test && engine test                    (explicit chain)
package.json:15                bench:scheduler = node --experimental-strip-types scripts/bench/bench.ts
package.json:34                engine:boundary = node --experimental-strip-types scripts/engine-boundary.ts
package.json:50                lint:scripts = eslint scripts
package.json:54                root dependency "@seazn/engine": "workspace:*"
package.json:68-70             typescript 6.0.3 (for typescript-eslint) + typescript-native = npm:typescript@7.0.2 (the TS7 tsc)
turbo.json:20                  globalDependencies: tsconfig.scripts.json, scripts/**
turbo.json:50-57               tasks typecheck (dependsOn ^build) and lint — turbo runs them for EVERY workspace that has the script
Packages present: ONLY packages/engine (apps/: web only).
packages/engine/package.json:2     name @seazn/engine; no main; "exports" map of raw .ts (lines 7-30), e.g. "./core": "./src/core/index.ts"
packages/engine/package.json:32    "test": "vitest run"
packages/engine/package.json:39    "typecheck": "node ../../node_modules/typescript-native/bin/tsc --noEmit"
packages/engine/package.json:40    "lint": "eslint"
packages/engine/package.json:43-63 peer zod; deps @bufbuild/protobuf, @grpc/grpc-js, pino, zod; devDeps @eslint/js ^9, @types/node ^26, eslint ^9, fast-check ^3, typescript 6.0.3, typescript-eslint ^8, typescript-native npm:typescript@7.0.2, vitest ^4.1.11
apps/web/package.json:2,10-12      @seazn/web; lint "eslint"; typecheck = TS7 tsc --noEmit && tsc -p ../../tsconfig.scripts.json; test "vitest run"
apps/web/package.json:24           "@seazn/engine": "workspace:*"
TEMPLATE: packages/engine is the only (hence smallest) package. Copy its 4 files, trimmed:
  packages/engine/package.json, tsconfig.json, eslint.config.mjs, vitest.config.ts (drop z3 maxWorkers/coverage-threshold material).

## 2. Test runners
packages/engine/vitest.config.ts:48-67  environment node, include src/**/*.test.ts + test/**/*.test.ts, pool threads, isolate:false, maxWorkers from mem (z3-specific), v8 coverage thresholds lines 90
apps/web/vitest.config.ts:129         environment "node"; :162 exclude node_modules, dist, e2e/**, .next/**
No root vitest install/config. scripts/** tests run via ENGINE's binary with explicit path:
  ci.yml:195  ./packages/engine/node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile=vitest-results-bench.json --testTimeout=30000 scripts/bench
  ci.yml:683  same binary ... --outputFile=vitest-results-scripts.json --testTimeout=30000 scripts/__tests__
  scripts/ci-local.sh:325 mirrors this locally
Engine tests in CI: ci.yml:388  npm run test:coverage --workspace packages/engine  (engine job, gated by dorny/paths-filter ci.yml:346-352 on packages/engine/** + pnpm-lock.yaml)
Tests are NOT run via turbo — a new package's tests need an explicit CI step.

## 3. Lint
Flat config everywhere (eslint 9, defineConfig/globalIgnores from "eslint/config").
eslint.config.mjs (root) — scripts/ only; ignores apps/**, packages/** (:19-34); parserOptions.project ./tsconfig.scripts.json (:46); *.test.ts get disableTypeChecked (:122-132)
packages/engine/eslint.config.mjs — @eslint/js + tseslint.recommendedTypeChecked, projectService allowDefaultProject ["*.mjs"] (:63), no-console error (:93), ban-ts-comment (:99)
apps/web/eslint.config.mjs:82   no-restricted-imports (paths: next/link) scoped to src/app/o/**, src/app/admin/**
apps/web/eslint.config.mjs:106  no-restricted-imports (patterns group ["@/server/*","@/server/**","server-only"] + paths pino) scoped to src/lib/timeline-keys.ts
NO import-boundary tooling: no dependency-cruiser config, no eslint-plugin-boundaries, no import/no-restricted-paths. eslint-plugin-import@2.32.0 exists in pnpm-lock.yaml only transitively via eslint-config-next (apps/web devDep, apps/web/package.json:74) — not resolvable from another package under pnpm's strict linker.
Existing boundary GATE (script, not lint): scripts/engine-boundary.ts
  :8-17   BANNED_IMPORTS list (postgres, next, react, react-dom, ioredis, server-only, node:crypto, crypto)
  :47-53  bannedImport(): specifier.includes("apps/") -> banned; exact/prefix match on list
  :55     IMPORT_RE covers `from`, dynamic import(), require(), bare `import "x"`
  :57     export function checkEngineBoundary(srcDir): Violation[]
  :88-100 CLI entry: scans packages/engine/src, prints FAIL lines, exit 1 on violation
  wired: ci.yml:93  - run: npm run engine:boundary   (gates job)
  tested: packages/engine/test/boundary-gate.test.ts:7 imports checkEngineBoundary from ../../../scripts/engine-boundary.ts
Verbatim no-restricted-imports block shape (apps/web/eslint.config.mjs:104-125):
    files: ["src/lib/timeline-keys.ts"],
    rules: { "no-restricted-imports": ["error", {
      patterns: [{ group: ["@/server/*", "@/server/**", "server-only"], message: "..." }],
      paths: [{ name: "pino", message: "..." }] }] },

## 4. TypeScript
No root tsconfig base, no "extends", no project references, no "composite" in any tsconfig (grep of all three came up empty).
packages/engine/tsconfig.json:2-16  ES2022, lib ES2023, module ESNext, moduleResolution bundler, strict, noUncheckedIndexedAccess, noEmit, allowImportingTsExtensions, isolatedModules, esModuleInterop, skipLibCheck, types ["node"]; include src/**, test/**, scripts/**, vitest.config.ts
tsconfig.scripts.json:10-36  scripts/**/*.ts; module/moduleResolution nodenext; allowImportingTsExtensions; types node; paths "@/*" -> apps/web/src/*; EXCLUDES scripts/**/*.test.ts (so script tests are never typechecked)
apps/web/tsconfig.json:15,26-29  bundler resolution; "@/*" -> ./src/*
Per-package typecheck = `node ../../node_modules/typescript-native/bin/tsc --noEmit` (TS 7.0.2 native). docs/superpowers/RULES.md:20 "TypeScript **7**. Node **26**."
CI typecheck: ci.yml:92  - run: npx turbo run typecheck  (all workspaces with a typecheck script; scripts/ covered via apps/web's 2nd tsc half)

## 5. CI
Workflows: bench.yml build-guard.yml ci.yml claude-code-review.yml claude.yml e2e.yml help-shots.yml placement-ci.yml placement-prod.yml placement-stg.yml prod.yml stg.yml (same set on origin/main)
ci.yml:6-7   on: pull_request only
ci.yml jobs: gates(:63 "Typecheck + lint + drift gates"), test(:232 "Unit tests (apps/web) N/4"), engine(:338 "Engine coverage + sim matrix"), security(:417), container(:458 "docker build + TS 7 musl exec"), smoke-db(:521), smoke-db-usecases(:913), smoke-e2e(:1195)
gates steps: :75 pnpm install --frozen-lockfile | :92 npx turbo run typecheck | :93 npm run engine:boundary | :167 npx turbo run lint | :179 npm run lint:scripts | :195 bench lib vitest (above)
engine job: :346 dorny/paths-filter | :364 pnpm install | :388 npm run test:coverage --workspace packages/engine | :396 SIM_SEEDS=5 npm run sim:matrix --workspace packages/engine
container job: :469 docker build --target builder | :487 docker run ... npx turbo run typecheck (runs turbo typecheck INSIDE the image)
Dockerfile:13-15  pre-install COPY lists only root manifests + apps/web/package.json + packages/engine/package.json, then :22 pnpm install --frozen-lockfile, then :24 COPY . .
bench.yml:
  :9-15   "MANUAL ONLY (R84). There is deliberately no `schedule:` here" — cron only after three consecutive green manual runs
  :23-42  on: workflow_dispatch (inputs suite default _tiny, engine default optimized) + pull_request paths [.github/workflows/bench.yml]
  :58-75  services.postgres image postgres:16, ports 5433:5432, pg_isready healthcheck
  :80-106 job env DATABASE_URL postgresql://postgres:postgres@localhost:5433/postgres, DATABASE_SSL disable, AUTH_SECRET, DEVICE_LINK_KEK, SUPABASE_JWT_*, NEXT_PUBLIC_* stubs, STRIPE_SECRET_KEY dummy, NEXT_PUBLIC_SCOREPAD_HOLD_MS "3000"
  :115 pnpm install --frozen-lockfile | :117-121 cache Flyway CLI (~/.cache/seazn-flyway) | :124 npm run db:apply | :129 npm run sync:sports
  :131-134 npm run build --workspace apps/web with SKIP_TYPECHECK=1
  :143-151 docker buildx build services/placement -> placement-service:ci
  :153-168 docker run -d -p 50051:50051 -e PLACEMENT_SERVICE_SECRET=ci-bench-secret; TCP poll 15s
  :172-174 npx playwright install chromium (working-directory apps/web)
  :176-213 Start server: PORT 3200, AUTH_DEV_LINKS 1, PLACEMENT_SERVICE_HOST localhost:50051, PLACEMENT_SERVICE_SECRET, LOG_LEVEL warn; copies .next/static + public into .next/standalone/apps/web; node apps/web/.next/standalone/apps/web/server.js &; curl /api/health poll 90x2s
  :219-224 node --experimental-strip-types scripts/bench/bench.ts --suite ... --engine ... --base http://localhost:3200
  :229-239 upload bench-report/ artifact; cat bench-server.log on failure
Schedule precedent: help-shots.yml:6-9  on: schedule: - cron: "43 4 * * 1" # Mondays 04:43 UTC + workflow_dispatch; :15-17 permissions contents: read; :25-38 postgres:16 service on 5432.
  gh run list confirms schedule DOES fire in this repo: help-shots event=schedule on 09-21 (success), 09-14/09-07/08-31/08-24 (failure); fire times drift hours past the cron (10:10 UTC for 04:43).
  Memory note says 8 ops cron workflows moved to onryde/seazn.club.workflow in #757 — help-shots.yml is the only schedule: left here.
e2e.yml:86-89 on: push branches [main] + workflow_dispatch.

## 6. scripts/ conventions
Execution: node --experimental-strip-types <file>.ts (package.json:15,27-48; bench.yml:221). NO tsx anywhere (no tsx dep/script/CI use).
Strip-types cannot synthesize enums; the one TS enum source is packages/engine/src/scheduling/generated/scheduler.ts — any script import graph reaching it crashes at load (vitest does not catch).
Imports use explicit .ts specifiers (tsconfig.scripts.json nodenext + allowImportingTsExtensions).
Layout precedent: scripts/bench/bench.ts (CLI entry) + scripts/bench/lib/*.ts + scripts/bench/lib/__tests__/*.test.ts + scripts/bench/lib/drivers/{http,browser,scorer}.ts + scripts/bench/lib/suites/{registry,run-suite,tiny,suite11}.ts + scripts/bench/packs/*.json; repo-level script tests in scripts/__tests__/.
Bench HTTP/seed helpers: scripts/bench/lib/http.ts (newSession:19, call:64, signIn:75, request:141, BenchHttpError:103); scripts/bench/lib/seed.ts (seedSuite:614, seedOfficialsAndClaims:975, runOfficialsAutoAssign:1240); scripts/bench/lib/env.ts (runPreflight:195, createRealPreflightProbes:389; FORBIDDEN_BASE_PORTS refuses 3000/3100 per bench.yml:178-181).
CLI entry guard idiom: scripts/engine-boundary.ts:88  if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)

## 7. e2e
apps/web/playwright.config.ts:28   const BASE = process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000"; :138 use.baseURL BASE
:29 AUTH_STATE "e2e/.auth/pro.json"; :122 testDir ./e2e; :125 globalSetup ./e2e/global-setup.ts; no webServer block (:287, deliberate #342)
Projects (:143-277): setup(auth.setup.ts) | parallel (Desktop Chrome 1280x720, dep setup) | walkthrough (e2e/walkthrough/) | serial (SERIAL_SPECS :31) | mobile-se 375x667 | mobile-14 390x844 | mobile-320 320x568 | mobile-360 360x800 | mobile-430 430x932 | tablet-768 768x1024 | tablet-834 834x1194 (all mobile/tablet testMatch /mobile\.spec\.ts/) | gallery (/\.capture\.ts$/, no setup dep)
E2E_PROD_TARGET: apps/web/e2e/helpers.ts:284  export const PROD_TARGET = !!process.env.E2E_PROD_TARGET  (auth helpers mint login tokens in DB; config header :11-15); e2e.yml:362/959/1287 E2E_PROD_TARGET "1", :744/1168/1499 PLAYWRIGHT_BASE http://localhost:3000
Seeding helpers in apps/web/e2e/helpers.ts: apiJson:312, mintLoginPathBySql:341, loginUi:475, seedVenueWithCourts:1868, competitionPath:1926, divisionPath:1942, fixturePath:1959, addEntrantsViaApi:1978, createStageAndGenerate:1995, seedRosteredFixture:2098, scoreFixture:2237, scoreRemainingFixtures:2255, startBlankCompetition:2292, createCompetitionViaUi:2300, createDivisionViaUi:2347, seedScoredDivision:2373, setDivisionConfigSql:1058, setOrgPlanBySql:674 (77 exports total)
Other e2e kits: directory-kit.ts, entrant-rename-kit.ts, overlay-kit.ts, price-kit.ts, rs007-money-kit.ts, spectator-w2-kit.ts, scorepad-a11y-kit.ts, settings-support.ts, spectator-public-helpers.ts, own-account.ts, zone-split.ts
