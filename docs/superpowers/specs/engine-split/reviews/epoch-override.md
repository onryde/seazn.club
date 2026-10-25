# Engine split — epoch floor override, batch review (Opus)

- **Range:** `46b8c5739b..dc123a23f5` (6 commits).
- **Reviewed:** 2026-10-25.
- **Saved by:** the orchestrator, because the reviewer cannot write repo files.

## Verdict: NEEDS FIXES

There is 1 Important finding (I1, which needs an owner call), along with 5 Minor findings and 3 Nits. All mutants were killed, and the CI steps passed when replayed locally.

## Important

**I1. A typo in the lever takes the whole site down (`apps/web/instrumentation.ts:26-33`).**

- **What happens.** A malformed value makes boot rethrow. Next 16.3.6 caches the rejected instrumentation promise (`instrumentation-globals.external.js:51-70`), and `prepare()` never resets it (`base-server.js:1040-1052`), so every request returns a plain 500.
- **What was measured.** On a real standalone server with `footbal=2`:
  - `/api/health`, `/` and POST events all returned 500.
  - The process stayed alive.
  - The message was logged 129 times.
  - The Fly health check (`fly.toml:37-41`) goes red.
- **Why the throw is wrong here.** "OFF" (today's floors) is the safe direction, and it is already built at the gate (`engine-epoch-override.ts:96-109`). The module's own INERT rule, "must not take prod down", argues against throwing.
- **Fix (a), recommended.** In `register()`, keep the strict parse, `captureException`, `flush` and `log.error`, but do not rethrow. Invert the two junk-value register tests (`engine-epoch-override.test.ts:430-456`), and reword the docs to match.
- **Fix (b), alternative.** Keep the throw, and ship a preflight check that operators run before `fly secrets set`.

## Minor

- **M1. The gate fallback's Sentry call is dead (`engine-epoch-override.ts:103-105`).** Sentry is initialised only inside `register()`, and the fallback runs only where `register()` did not, so the call can never report anything. The docs overclaim it: spec `:315`, `.env.example:167` and module `:17-19`.
- **M2. "Log-only (quota)" is inaccurate (spec `:321`, module `:25`, `instrumentation.ts:34-35`).** `pinoIntegration` sends every pino level to Sentry Logs. These lines do reach Sentry; they just never become an Issue.
- **M3. The OpenAPI 426 `required` wording is stale while the lever is on (`openapi.ts:678` and `:201`, which become `v1.json`).** It still says "the server's fold epoch".
- **M4. The override leaks into later CI steps (`ci.yml:1875`).** The value is exported through `$GITHUB_ENV`, which reaches every later step in the job. The wiring test only pins the steps before it. Use a step output and set the value in the smoke step's own `env:` instead.
- **M5. A forgotten entry widens the gap at the next bump (`engine-epoch-override.ts:155`).** For example, `football=1` left in place after football moves 2→3 admits clients two majors behind. Owner call: either show "N majors behind" in the message, or escalate when the floor is more than one major behind.

## Nits

- `ci.yml:1880` overlays the live tree. This is harmless.
- `engine-epoch-override.test.ts:390`: the title still says `required`.
- `scoring-engine-epoch.test.ts:922`: the message says "zero rows" but the test asserts `toBe(2)`.

## Q1. Correctness

- The floor can never rise. The cache has no stored state, and the "min→override" mutant was killed.
- Only the named sport is lowered: the lookup is an exact own-key `Map.get` after `resolveModule`.
- No HTTP body echoes the value. It does appear in logs and in a single Sentry exception, and it is not a secret.

## Q2. CI edit (`ci.yml:1849-1913`)

- Port 3002 is distinct from every other port in the job.
- It reuses the standalone tree and does not rebuild.
- The floor is derived from `foldEpochOf('generic') - 1`.
- The health check, the ACTIVE line and the OVERRIDDEN line are each time-bounded.
- It adds about 10 s.
- The full smoke run is unchanged: `main()` never calls the suite, and exactly two `SMOKE_ONLY` lines exist.
- `smoke-select`: 5/5. Wiring: 7/7.

## Q3. CI register() gap: CONFIRMED

- **Cause.** The standalone tree has no `instrumentation.js`. Next swallows the ENOENT and skips `register()` (`instrumentation-globals.external.js:38-49`).
- **Affected servers.** No CI or e2e server overlays the compiled directory: the ci.yml Start server and R2004 steps, the e2e.yml `:1045`/`:1514`/`:1877` steps, and `seazn-env`.
- **Prod does run it,** through the Dockerfile `:106` overlay.
- **What CI never exercises:**
  - Sentry init. Low risk: CI has no DSN.
  - The `relayDriverMode` refusal. Low risk.
  - The outbox readiness check. Low risk.
  - `installPublicErrorNoStore`. This one is a real divergence: on CI, public 404s keep the ISR `s-maxage`, while prod sends no-store.
- **Fix.** Overlay `.next/server` in every Start-server step, ideally through one staging script. Use a blank `SENTRY_DSN` in `seazn-env`; otherwise local builds report to the real project.
- **Recommendation.** Fix it now in a separate small PR.

## Q4. End-to-end proof

The lever is proven. The chain is: env → `register` → ACTIVE log → gate → 201 / 426 with `required = floor`. Replayed locally: 10/10 steps passed, with ACTIVE logged once, OVERRIDDEN twice and ENGINE_OUTDATED twice.

## Q5. Tests

- 87/87 passed (34 + 7 + 46) on a fresh DB at v471.
- Mutants: 9 applied, 9 killed by assertions.
- Sequence coverage holds: second call, empty input, void, lever withdrawn, every sport.
