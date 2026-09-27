# Bench-as-library facts (scripts/bench) — for the HTTP-harness plan

Worktree: `/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix` (branch `docs/format-matrix-programme`, HEAD 782628af5).
All `file:line` below re-pinned against that tree on 2026-09-27. READ-ONLY survey; nothing was run.

---

## 0. Headline facts the plan must not get wrong

1. **The bench does not synthesise match events at run time.** It REPLAYS `pack.streams[].events` verbatim (after `@ref` -> uuid substitution). "Generators" exist only at PACK-BUILD time (`packs/build-packs/*.ts` + `lib/reconstruct.ts`). A harness that needs events for an arbitrary format/sport has to author them itself or build a pack.
2. **`runPackSuite` is ONE 4,099-line async function** (`lib/suites/run-suite.ts:1838-5936`). Every phase is inline in its body; only the fold's tap path (`playDivisionByTaps`, :3422) and advancement (`advanceDivision`, :3980) are closures, and both capture ~10 outer locals. Nothing between :1925 and :5838 is callable on its own today.
3. **Every phase after scheduling is gated on `input.sql !== undefined`** (PlanSql = a live Postgres handle). Without `sql`: no plan provisioning, no division start, no folds, no advance, no oracles. The HTTP API alone cannot set a plan; plan provisioning is raw SQL (`lib/plan.ts:530`) + an admin cache-bust call that requires temporarily flipping the owner to staff via SQL (`plan.ts:577-591`).
4. **Plan provisioning is buried inside the DLS-gate probe** (`lib/dls-gate.ts:964-1003`): `runDlsGateProbe` creates its own throwaway competition/divisions/fixtures, probes paywall cells, chooses the plan, and calls `provisionPlan`. There is no "just set the plan" helper wired into the runner; `provisionPlan` itself is exported and usable directly.
5. **Auth is magic-link cookie sessions only** — no API keys, no Bearer tokens anywhere in `scripts/bench/lib` (grep for `bearer|api[_-]?key` hits only comments). A production build must run with `AUTH_DEV_LINKS=1` or `login_url` is not exposed (bench.yml:181-188).
6. **`_tiny`'s registry row declares `play: { "d-tiny": "tap" }`** (`lib/suites/registry.ts`, the `_tiny` DEFINITION) — so in a real `_tiny` run, `d-tiny` is played by **Chromium tapping the pad**, not by HTTP. The single-event HTTP path (`simulateDivisionStreams`) is exercised live only by `suite11`'s `d-worlds` (index 0, default `api`). `_tiny`'s other streamed divisions (`d-badminton` idx 1, `d-tiebreak` idx 3) default to `import`.
7. **PackSchema is frozen** (post-B06b); additive change = owner escalation in the PR; `schemaVersion: z.literal(1)` at `lib/pack-schema.ts:1566`. See §7.

---

## 1. Directory map — `scripts/bench` (line counts from `wc -l`)

### Entry + packs
| File | Lines | Responsibility |
|---|---:|---|
| `bench.ts` | 437 | CLI: `parseCliArgs`, preflight, per-suite `runSuite`, `writeReport`; exit 1 on red |
| `packs/_tiny.json` | 1700 | Committed proof pack (4 divisions, 8 streams) |
| `packs/suite11.json` | 21888 | PDC darts pack (2 knockout divisions, 205 streams) |
| `packs/build-packs/_tiny.ts` | 1401 | Builds `_tiny.json` (hand-authored generic streams + reconstructed badminton stream) |
| `packs/build-packs/suite11.ts` | 1158 | Builds `suite11.json` from `data/*.json` |
| `packs/build-packs/data/README.md` | 41 | Source notes |
| `packs/build-packs/data/suite11-pdc-*.json` | 2266 / 3248 | Raw historical data |
| `packs/build-packs/__tests__/{_tiny,suite11,suite11-data}.test.ts` | 345/481/245 | Pack-builder tests |

### `lib/` (production)
| File | Lines | Responsibility |
|---|---:|---|
| `http.ts` | 149 | Cookie-jar client: `newSession`, `raw`, `call`, `request`, `signIn`, `BenchHttpError` |
| `log.ts` | 27 | pino `log` + `suiteLogger(key)`; reads `LOG_LEVEL` |
| `env.ts` | 675 | Preflight: port/host/DB/data_directory/catalog/health/placement/stripe/chromium probes |
| `pack-schema.ts` | 2531 | Zod `PackSchema` (frozen public contract), `fixtureKey`, `PackEvent`, `PackStream` |
| `pack-io.ts` | 187 | `loadPackFile`/`loadPackValue` (stage-0 gate), `formatFinding`, `expectedFixtureCount` |
| `pack-hash.ts` | 53 | `hashPack` (for `--keep` marker) |
| `pack-template.ts` | 119 | Pack authoring template |
| `validate-pack.ts` | 2503 | Offline validator `validatePack` (parse + fold every stream through the engine + compare expected) |
| `provenance.ts` | 55 | real/reconstructed/synthetic % |
| `seed-plan.ts` | 520 | PURE pack -> request-body plan (`buildSeedPlan`) |
| `seed.ts` | 1286 | HTTP seeding driver (`seedSuite`, `seedOfficialsAndClaims`, `runOfficialsAutoAssign`, `bindStreamFixtures`, `stageKey`) |
| `plan.ts` | 740 | `PlanSql` seam (raw SQL), `provisionPlan`, `bustOrgEntitlements`, plan choice, `createRealPlanSql` |
| `dls-gate.ts` | 1031 | Entitlement-gate probe; ALSO where the run's plan is chosen+provisioned |
| `schedule.ts` | 1474 | 7-step scheduling layer (`runScheduleLayer`), engine artifact I/O, `runDivisionStartLayer` |
| `checker.ts` | 959 | Independent constraint checker over fetched board |
| `certificate.ts` | 371 | Feasibility certificate protocol |
| `believability.ts` | 750 | Report-only schedule quality + engine delta |
| `board.ts` | 1205 | Board types, `judgeDivision`, history-board render |
| `simulate.ts` | 321 | Single-event fold via `POST /fixtures/{id}/events` |
| `import.ts` | 478 | Batch fold via `POST /divisions/{id}/events/import` |
| `ledger.ts` | 182 | Fixture ledger/status readers (tap path) |
| `reconstruct.ts` | 879 | Build-time legal-sequence generators (set-based rallies, period markers) |
| `special-state.ts` | 160 | Offline fold for specials on tapped fixtures |
| `advance.ts` | 362 | propose->assert->confirm->generate; `completeStageCapture`; `compareFinalRanks` |
| `qualifiers.ts` | 108 | Expected qualifier order for pooled sources |
| `oracle.ts` | 1650 | Readers (standings, fixtures, state, stats, suspensions, lineups) + comparators |
| `stats.ts` | 315 | Player-stats baseline (pre-fold) |
| `people.ts` | 368 | Claim acceptance, news auto-post enable + publish step |
| `register.ts` | 745 | Registration funnel driver (`runRegistrationDivision`, `resolveEntryMode`) |
| `tap-setup.ts` | 124 | Lineup save for tapped fixtures |
| `tap-play.ts` | 785 | Browser tap player (`browserTapPlayer`, `adapterForSport`, `playTapRounds`) |
| `report.ts` | 1384 | Zod report schema, `writeReport`, `renderMarkdown`, `gateOf`, `resolveRunId`, `oracleLogFields` |
| `drivers/types.ts` | 221 | Organiser/Captain/Player driver interfaces |
| `drivers/http.ts` | 293 | HTTP registration drivers |
| `drivers/browser.ts` | 734 | Playwright registration drivers |
| `drivers/scorer.ts` | 799 | Tap scorer driver (maps pack events -> taps) |
| `drivers/adapters/generic.ts` | 225 | ONLY tap adapter (generic sport) |
| `drivers/settings-body.ts` | 55 | Registration settings body |
| `drivers/padpage-assignability.ts` | 29 | Type assertion |
| `suites/run-suite.ts` | 5936 | `runPackSuite` + pure helpers |
| `suites/registry.ts` | 43 | `SUITE_REGISTRY` (`_tiny`, `suite11`), `lookupSuite`, `suiteKeys` |
| `suites/tiny.ts` | 72 | `TINY_PACK_PATH`, `runTinySuite` (thin wrapper) + re-exports |
| `suites/suite11.ts` | 35 | `SUITE11_PACK_PATH`, `runSuite11` |
| `suites/types.ts` | 102 | `PlayMode`, `PlayDeclaration`, `playModeFor`, `SuiteDefinition` |

### Tests — 56 `*.test.ts` files
`lib/__tests__/` 46 (+ helper fixtures `_advance-routes.ts`, `_board-fixtures.ts`, `_claim-routes.ts`, `_discipline-routes.ts`, `_division-phase.ts`, `_news-routes.ts`, `_oracle-routes.ts`, `_roundrobin-rounds.ts`, `_schedule-routes.ts`), `lib/drivers/__tests__/` 3, `lib/suites/__tests__/` 4, `packs/build-packs/__tests__/` 3.

---

## 2. `runPackSuite` phases (`lib/suites/run-suite.ts`)

Signature (:1838):
```ts
export async function runPackSuite(
  input: PackSuiteInput,
  opts: RunPackSuiteOptions,
): Promise<SuiteReport> {
```
```ts
export interface RunPackSuiteOptions extends PlayDeclaration {   // :301
  readonly suiteKey: string;
  readonly packPath: string;
}
```
`PackSuiteInput` (:674-904): `base`, `engine: "optimized"|"greedy"|"both"`, `keep`, `log: pino.Logger`, optional `packPath`, `transport?: SeedTransport`, `sql?: PlanSql`, `probeTransport`, `simTransport`, `importTransport`, `startTransport`, `advanceTransport`, `oracleTransport` (all `ProbeTransport` except start = `DivisionStartTransport`), `matchBoard?`, `specialSubjects?` (test injection), `cliEntry?`, `registrationDrivers?`, `tapPlayer?: TapPlayerFactory`, `resolveOrgSlug?`, `connectAccount?`, `setOrgCurrency?`, `reportDir?`, `runId?`, `recordVideoDir?`, `traceDir?`.

### Function-scope accumulators (declared :1850-1898) — written by MANY phases, read at the final return
`claimsSummary`, `newsSummary`, `t` (transport), `errors[]`, `warnings[]`, `oracles[]`, `timings{seedMs,scheduleMs,simMs,importMs}`, `registrationReports[]`, `scheduling[]`, `crossDivisionClashes`, `officialsByFixtureId`, `engineDelta`, `conflictCount`, `solver`, `simulation`, `importSimulation`, `divisionStart`, `tapState{player,report}`, `tapPlayedFixtureIds`.
**This is the #1 extraction blocker**: each phase pushes into these; a split needs a shared mutable `RunContext`/`Accumulator` object passed to every phase (or each phase returns a partial report to merge).

### Try-scoped locals shared across phases (declared inside `try {` at :1925)
`runTag`, `email` (:1929-1930), `s: Session` (:1932), `orgId` (:1935), `division0/stage0` (:2028-2029), `autoAssign`, `statsPlayerGranted`, `newsAutoGranted`, `deviceLinksGranted` (:2047-2066, written by P2, read by P5/P7/P9/P10/P14), `seedPlan` (:2190), `seeded: SeededSuite` (:2217 — read by every later phase), `divisionId/stageId` (:2242-2243), `newsEnable` (:2331, read by P14 at :5700), `layer`/`boardByRef` (:2470-2488), `completedStageIds` (:3978), `boardByDivision` (:4500, read by specials :4740), `refIdByKey` rebuilt 3× (:3497, :3714, :4142).

### Phase table (execution order)

| # | Phase | Lines | Functions called | Inputs -> outputs | State read/written (blockers) |
|---|---|---|---|---|---|
| P0 | **Pack stage (offline)** | 1900-1923 | `tinyPackStage(packPath)` (:940) -> `loadPackFile` + `buildSeedPlan` + `hashPack` | packPath -> `{pack, plan, packHash, warnings}`; early `return` red on refusal | writes `warnings`; **already extractable** (exported) |
| P1 | **Sign-in + `--keep` lookup** | 1925-2009 | `newSession`, `t.signIn`, `findExistingSeed` (:1585) | `keep`,`plan`,`packHash` -> `s`,`orgId`,`runTag`,`email`; early returns for `stale` (red) and `reuse` (`gate:"skipped"`) | early `return` of a whole `SuiteReport` from inside the phase — split must turn that into a discriminated result |
| — | resolve `division0`/`stage0` | 2011-2034 | — | plan -> first division/stage; throws if absent | used by P3 (id lookup), P7, P14 |
| P2 | **Plan/entitlement provisioning + DLS gate probe** | 2036-2173 (gated `input.sql`) | `runDlsGateProbe` (dls-gate.ts:818) — internally `chooseGrantingPlanForCapabilities` (:964) + `provisionPlan` (:1003) | `base,email,runTag,sql` -> `autoAssign`, `newsAutoGranted`, `deviceLinksGranted`, `statsPlayerGranted`; pushes oracles/errors/warnings | writes 4 capability `let`s consumed much later; creates its OWN throwaway divisions in the same org |
| P3 | **Seeding** (venues/courts, persons, competition, divisions, stages, entrants, `/generate`, officials, claim invites) | 2175-2314 | `registrationDivisionsOf` (:498), `seedSuite` (seed.ts:614), `fixtureCountIssue` (:1071), `leagueBoundStreamCount` (:1042), `packDeclaresLeagueStage` (:1067) | `plan` minus registration divisions -> `seeded: SeededSuite` (all ref->id maps) | `seedSuite` signs in AGAIN with a new session (same email) and asserts same org (:2236); official-invite oracle :2256-2273; `timings.seedMs` |
| P4 | **News auto-post enable** (must precede any fold) | 2316-2364 (gated) | `enableAutoPosts` (people.ts:259) | `seeded.divisionIdByRef` -> `newsEnable` | reads `newsAutoGranted`; `newsEnable` read by P14 |
| P5 | **Scheduling layer** | 2366-2894 | `resolveScheduleLocks` (:1464), build `ScheduleDivision[]` (:2415-2468, FIRST stage of every seeded division only), `runScheduleLayer` (schedule.ts:769), per-division `checkBoard`/`assessBelievability`/`certify`/`judgeDivision` (:2491-2723), solver summary (:2724-2753), officials auto-assign `runOfficialsAutoAssign` (:2755-2839, gated `autoAssign===true`) + checker re-run, `crossDivisionCourtClashes` (:2846), `writeEngineArtifact`/`readEngineArtifacts`/`assessEngineDelta` (:2875-2892) | `seeded`, `pack.divisions[].scheduleConfig`, `engine` -> `scheduling[]`, `conflictCount`, `solver`, `crossDivisionClashes`, `engineDelta`, `officialsByFixtureId` | NOT gated on `sql` (runs in every caller); `timings.scheduleMs` |
| P6 | **Division start** | 2896-2986 (gated) | `runDivisionStartLayer` (schedule.ts:1465) -> `POST /divisions/{id}/start` | every division with streams -> `divisionStart[]` | both fold paths refuse an unstarted division |
| P7 | **Player-stats baseline** (asserts EMPTY rows, so must precede folds) | 2988-3051 (gated) | `readPlayerStatsBaseline` (stats.ts:181), `playerStatsBaselineIssues` (:244) | division0 roster -> oracle | reads `statsPlayerGranted`, `email`, `orgId` |
| P8 | **Discipline carry / suspensions** (must precede folds: lineup PUT refused once decided) | 3053-3380 (gated) | `createManualSuspension`, `confirmSuspension`, `fetchActiveSuspensions`, `putFixtureLineup`, `fetchFixtureLineup`, `compareSuspensions`, `suspensionMismatchReasons` (oracle.ts) | `pack.expected.suspensions` -> oracles | `no_subject` oracle when empty (:3073-3097) |
| P9 | **First-stage fold** ("simulation/event posting") | 3382-3919; tap closure 3410-3670; dispatch 3672-3919 (gated) | per division `playModeFor(opts, ref, idx)` (types.ts): `tap` -> `playDivisionByTaps` (closure, Chromium); `api` -> `fetchDivisionFixtures` (round map) + `simulateDivisionStreams` (simulate.ts:298); `import` -> `importDivisionStreams` (import.ts:442) | streams whose stageRef is the division's FIRST stage -> `simulation`, `importSimulation`, `tapState.report`, `timings.simMs/importMs` | `playDivisionByTaps` captures `deviceLinksGranted`, `seeded`, `pack`, `s`, `tapState`, `tapPlayedFixtureIds`, `errors`, `warnings`, `oracles`, `input.tapPlayer`, `input.recordVideoDir/traceDir`; the import accumulators (:3726-3729) are block-scoped to this `if` |
| P10 | **Advancement + later-stage fold + complete stage** | 3921-4435 | closure `advanceDivision(division, idx, sourceStage, targetStage)` (:3980): `expectedQualifierOrder` (:440), `completeStageCapture` (source, :4087), `advanceStageSeeding` (:4091), later-stage fold via same dispatch (tap / `importDivisionStreams` / `simulateDivisionStreams`, :4153-4230), `completeStageCapture` (target, :4239), `compareFinalRanks` (:4273), `fetchStandings`+`compareRankCrossings` (:4305-4308), standings-vs-expected (:4325), `compareChampion` (:4362); driver loop :4403-4413 (gated); import accumulators folded :4423-4435 | `plan.divisions[].stages[i].progression` -> oracles; `importSimulation` extended | closure captures `completedStageIds`, `playDivisionByTaps`, `advanceImport*` lets (:3962-3965), `seeded`, `s`, `pack`, `opts` |
| P11 | **Outcome oracles** | 4437-5104 | `reportMatchOracle` closure (:4453) -> `compareMatches`; per-match block :4487-4568 (`fetchDivisionFixtures`, `fetchFixtureSideLines`, or injected `input.matchBoard`); standings tables + tie-order cascade :4569-4715 (`fetchStandings`, `compareStandings`, `compareTieOrderCascade`); specials :4716-4851 (`specialStateThroughPackEvents` for tapped fixtures, `fetchFixtureModuleState`, `compareSpecials`); leaderboards + person cards :4852-4990 (`fetchDivisionPlayerStats`, `compareLeaderboard`, `fetchPersonStats`, `comparePersonDivisionStat`); careers :4992-5104 (`fetchPersonCareerStats`, `compareCareerStats`) | `pack.expected.*` + `seeded` -> `oracles`, `errors` | specials reads `boardByDivision` (filled by per-match) and `tapPlayedFixtureIds` (filled by P9/P10) |
| P12 | **Claim acceptance** | 5106-5374 (gated + `seeded.officialsAndClaims`) | `acceptClaimInvites`, `tamperToken`, `fetchPersonStats` (people.ts / oracle.ts) | minted invites -> `claimsSummary`, oracles | runs after folds on purpose (stats drift check) |
| P13 | **Registration divisions** (currency write, Stripe Connect claim/release, funnel) | 5376-5678 | `input.setOrgCurrency ?? sql.setOrgCurrency` (:5402-5421), `connect.claim/release` (:5423-5459, :5649-5677), per division `resolveEntryMode`, `buildRealRegistrationDrivers` (:570) or `input.registrationDrivers`, `resolveOrgSlug` (:5530), `runRegistrationDivision` (:5552) | `pack.registration.byDivision` -> `registrationReports[]` | throws if pack declares currency and neither seam wired (:5410-5415); reads `process.env.STRIPE_CONNECT_TEST_ACCOUNT` (:5426) |
| P14 | **News publish** (LAST) | 5679-5837 | `publishTargets` (:1815), `runNewsStep` (people.ts:309) | `newsEnable`, division0 last-stage streams -> `newsSummary`, oracles | reads `newsEnable` from P4 |
| — | catch-all | 5839-5841 | — | any throw -> `errors.push(message)` | a phase that throws aborts all later phases; gate goes red |
| P15 | **Tap player close** | 5843-5869 | `tapState.player.close()`, `.artefacts()` | appends video/trace paths | outside the try |
| P16 | **Report assembly** | 5874-5935 | `computeProvenance(pack)` | all accumulators -> `SuiteReport`; `gate = errors.length===0 ? "green" : "red"` | the only reader of most accumulators |

Outside `runPackSuite` (in `bench.ts`): env preflight `createRealPreflightProbes` + `runPreflight` (bench.ts:359-383), plan-SQL construction `createRealPlanSql` (:390), report write `writeReport` (:420).

**Phase count: 17** (P0–P16), plus the two bench.ts bookends (preflight, report write).

### Ordering constraints that are load-bearing (documented in comments)
- P2 before P3 (`autoAssign` must be known before the scheduling walk; :2036-2046).
- P4 before any fold — drafting only happens while `auto_posts` is on; no second chance (:2316-2330).
- P6 before P9/P10 — both write paths refuse an unstarted division (:2896-2904).
- P7 and P8 before P9 — baseline asserts empty rows; lineup PUT refused once decided (:2988, :3058-3062).
- P10 before P11 — "FOLD EVERYTHING, THEN ASSERT" (:3921-3936, found by live run B06a T9).
- P13 after P11 (currency written before registration loop, :5392-5401); P14 last (:5679-5690).
- P9 folds only each division's FIRST stage; later stages are folded inside P10 (:3403-3409, :3767-3770).
- P5 schedules only `planned.stages[0]` per division; a multi-stage division gets a warning (:2430-2440).

### Extraction blockers (summary)
1. Shared mutable accumulators (listed above) — needs a context object.
2. Early `return`s of a complete `SuiteReport` from P0 and P1 (:1911, :1957, :1995).
3. Capability flags from P2 consumed by P5/P7/P9/P10/P14 — plan choice is not separable from the DLS probe without editing `dls-gate.ts`.
4. Closures `playDivisionByTaps` (:3422) and `advanceDivision` (:3980) capture ~10 outer bindings each; P10 calls P9's closure.
5. One try/catch (:1925/:5839) spans every phase: today a throw in P5 skips P6–P14 but still returns a report; an extracted pipeline must preserve that.
6. `refIdByKey` built three separate times in three scopes (:3497, :3714, :4142).
7. Import accumulators split across two scopes (:3726-3729 block-local; :3962-3965 for P10), merged at :4423-4435.
8. Tests: 12 test files call `runTinySuite`/`runPackSuite`/`runSuite11` end-to-end with fakes (e.g. `tiny-suite-simulate.test.ts` 46 calls, `tiny-suite-tap.test.ts` 13, `tiny-suite-registration.test.ts` 12, `tiny-suite.test.ts` 9, `tiny-suite-plan.test.ts` 7, `tiny-suite-scheduling.test.ts` 6, `run-suite.test.ts` 3, `tiny-suite-import.test.ts` 3, `tiny-suite-stats.test.ts` 3, `suite11-play-forward.test.ts` 2, `report.test.ts` 1). They pin phase ORDER through fake route recorders, so the public `runPackSuite(input, opts)` signature must survive a split.

---

## 3. Exported signatures (verbatim)

### 3.1 HTTP client — `lib/http.ts`
```ts
export interface Session {                       // :15
  cookies: Record<string, string>;
}
export function newSession(): Session {          // :19
export function cookieHeader(s: Session): string {   // :23
export interface RawJson {                       // :29
  ok: boolean;
  data?: unknown;
  error?: string;
  issues?: { path?: unknown[] }[];
}
export interface RawResult {                     // :36
  status: number;
  json: RawJson;
}
export async function raw(base: string, s: Session, path: string, method = "GET", body?: unknown): Promise<RawResult> {   // :42
export async function call(base: string, s: Session, path: string, method = "GET", body?: unknown): Promise<unknown> {     // :63
export async function signIn(                    // :73
  base: string,
  s: Session,
  email: string,
): Promise<{ has_org: boolean; org_id: string; redirect: string }> {
export class BenchHttpError extends Error {      // :103  (status, path, body)
export interface RequestOptions {                // :126
  method?: string;
  body?: unknown;
  allowStatus?: number[];
}
export async function request<T>(base: string, s: Session, path: string, opts: RequestOptions = {}): Promise<T> {   // :142
```
`raw` always sends `Content-Type: application/json` and a `cookie` header from the jar; `request` throws `BenchHttpError` on any `>=400` or `ok===false` not in `allowStatus`. Every function takes `base` explicitly; `http.ts` reads no env.

### 3.2 Auth / session acquisition
Only `signIn` above: `POST /api/auth/magic-link {email}` -> read `login_url` token -> `POST /api/auth/magic-link/consume {token}`. An unknown email creates the user AND auto-provisions an org (named "My organization"; slug server-minted `my-organization-N`). Email pattern used everywhere: `` `delivered+bench-${plan.org.slug}-${runTag}@resend.dev` `` (run-suite.ts:1930; seed.ts:620). No `POST /api/v1/orgs` exists (seed.ts header :47-60). No API-key path.

Transport seams (DI):
```ts
export interface SeedTransport {                 // seed.ts:150
  signIn(base: string, s: Session, email: string): Promise<{ has_org: boolean; org_id: string; redirect: string }>;
  request<T>(base: string, s: Session, path: string, opts?: RequestOptions): Promise<T>;
}
export const defaultTransport: SeedTransport = { signIn, request };   // seed.ts:155

export interface ProbeTransport extends SeedTransport {   // dls-gate.ts:162
// (adds) raw(...)
export const defaultProbeTransport: ProbeTransport = { ...defaultTransport, raw };   // dls-gate.ts:169
```
`SimTransport`, `ImportTransport`, `AdvanceTransport`, `OracleTransport`, `LedgerTransport` are all `{ raw(base, s, path, method?, body?): Promise<RawResult> }` (simulate.ts:70, import.ts:48, advance.ts:52, oracle.ts:62, ledger.ts:27).

### 3.3 setPlan / entitlements — `lib/plan.ts`
```ts
export const FREE_PLAN_KEY = "community";        // :100
export interface PlanSql {                       // :151  methods (lines are within the interface):
  entitlementRows(featureKey: string): Promise<readonly PlanEntitlementRow[]>;
  planCandidateInfo(planKeys: readonly string[]): Promise<readonly PlanCandidateInfo[]>;
  getOrgSubscriptionId(orgId: string): Promise<string | null>;
  updateSubscriptionPlan(subscriptionId: string, plan: string): Promise<void>;
  createSubscriptionForOrg(orgId: string, plan: string): Promise<string>;
  setOwnerStaff(orgId: string, on: boolean): Promise<void>;
  setDivisionActive(divisionId: string): Promise<void>;
  getOrgSlug(orgId: string): Promise<string>;
  claimConnectAccount(orgId: string, accountId: string): Promise<string | null>;
  releaseConnectAccount(orgId: string, previousHolderId: string | null, accountId: string): Promise<void>;
  setOrgCurrency(orgId: string, currency: string): Promise<void>;
}
export interface ProvisionPlanInput {            // :506
  readonly base: string;
  readonly orgId: string;
  readonly plan: string;
  readonly ownerSession: Session;
  readonly sql: PlanSql;
  readonly transport?: SeedTransport;
}
export async function provisionPlan(input: ProvisionPlanInput): Promise<void> {   // :530
export async function bustOrgEntitlements(input: BustEntitlementsInput): Promise<void> {   // :577
export function chooseGrantingPlanForCapabilities(   // :472
  requirements: readonly CapabilityRequirement[],
  candidates: readonly PlanCandidateInfo[],
): CapabilityPlanChoice {
export interface RealPlanSqlHandle { sql: PlanSql; dispose: () => Promise<void>; }   // :601
export function createRealPlanSql(): RealPlanSqlHandle {   // :612
```
`provisionPlan` = repoint/create `subscriptions` row via SQL, then `bustOrgEntitlements` (flip owner staff ON via SQL, `POST`+`DELETE /api/admin/orgs/{orgId}/entitlement-override` with `feature_key: "bench.cache.bust"`, flip staff OFF in `finally`). `createRealPlanSql` reads `DATABASE_URL` (throws lazily if unset), `DB_SCHEMA ?? "seazn_club"`, `DATABASE_SSL`.

Where the run actually provisions:
```ts
export interface DlsGateProbeInput {             // dls-gate.ts:419
  readonly base: string;
  readonly email: string;
  readonly runTag: string;
  readonly sql: PlanSql;
  readonly transport?: ProbeTransport;
}
export async function runDlsGateProbe(input: DlsGateProbeInput): Promise<DlsGateProbeResult> {   // dls-gate.ts:818
```
`DlsGateProbeResult` (:714) carries `orgId, provisionedPlan, officialsAutoGranted, unsatisfiedCapabilities, statsPlayerGranted, newsAutoGranted, deviceLinksGranted, deviceLinkGateProbed, deviceLinkWarnings, dlsFreeOnCommunityPlan, gatedFeatureProbed, cells`. Capabilities requested (:964-973): `cricket.dls`, `officials.auto`, `stats.player`, `news.auto`, `DEVICE_LINKS_FEATURE_KEY` (`scoring.device_links`).

### 3.4 Org / competition / division / entrant creation — `lib/seed-plan.ts` + `lib/seed.ts`
```ts
export function buildSeedPlan(pack: Pack): SeedPlan {   // seed-plan.ts:414
export interface SeedPlan { ... }                        // seed-plan.ts:320 (org, competition, divisions, persons, entrants, officials, claimInvites, expectedFixtureCounts, ...)

export function stageKey(divisionRef: string, stageRef: string): string {   // seed.ts:179  (JSON.stringify([divisionRef, stageRef]))
export interface SeededSuite {                   // seed.ts:183
  readonly orgId: string;
  readonly competitionId: string;
  readonly venueIdByRef: ReadonlyMap<string, string>;
  readonly courtIdByRef: ReadonlyMap<string, string>;
  readonly divisionIdByRef: ReadonlyMap<string, string>;
  readonly stageIdByRef: ReadonlyMap<string, string>;      // keyed by stageKey()
  readonly personIdByRef: ReadonlyMap<string, string>;
  readonly entrantIdByRef: ReadonlyMap<string, string>;
  readonly fixtureIdByKey: ReadonlyMap<string, string>;    // keyed by fixtureKey(divisionRef, extKey)
  readonly officialsAndClaims?: SeededOfficialsAndClaims;
}
export interface SeedSuiteInput {                // seed.ts:206
  readonly base: string;
  readonly plan: SeedPlan;
  readonly venues?: readonly PackVenue[];
  readonly streams: readonly PackStream[];
  readonly runTag: string;
  readonly transport?: SeedTransport;
  readonly competitionBranding?: Record<string, unknown>;
  readonly competitionVisibility?: "public" | "unlisted";
}
export async function seedSuite(input: SeedSuiteInput): Promise<SeededSuite> {   // seed.ts:614
export function bindStreamFixtures(              // seed.ts:309
export async function seedOfficialsAndClaims(    // seed.ts:975
export async function runOfficialsAutoAssign(    // seed.ts:1240
  input: RunOfficialsAutoAssignInput,
): Promise<OfficialsAutoAssignResult> {
```
`seedSuite` order (seed.ts:600-613 doc, body :614-760): sign in (new session) -> concurrently [venues+courts (`seedVenuesAndCourts` :394, private), persons (`seedPersons` :489, private), `POST /api/v1/competitions` then per division `POST /competitions/{id}/divisions` + `POST /divisions/{id}/stages` (array body)] -> `seedEntrants` (:550, private) -> per stage `POST /api/v1/stages/{id}/generate` -> `bindStreamFixtures` -> `seedOfficialsAndClaims` if any. **Venue/person/entrant helpers are NOT exported**; `seedSuite` is the only public creation entry and it does not accept an external session.

### 3.5 Stage create / generate / complete / advance — `lib/advance.ts`
Stage create + generate happen only inside `seedSuite` (no standalone export). Advancement:
```ts
export interface AdvanceStageSeedingInput {      // advance.ts:163
  readonly base: string;
  readonly session: Session;
  readonly stageId: string;
  readonly expectedQualifierEntrantIds: readonly string[];
  readonly transport?: AdvanceTransport;
}
export async function advanceStageSeeding(       // advance.ts:203
  input: AdvanceStageSeedingInput,
): Promise<AdvanceStageSeedingResult> {
// POST /stages/{id}/seed-proposal -> assert -> POST .../seed-proposal/confirm -> POST /stages/{id}/generate

export interface CompleteStageCapture {          // advance.ts:264
  readonly stageId: string;
  readonly completed: boolean;
  readonly finalRanks?: readonly string[];
  readonly divisionCompleted?: boolean;
}
export async function completeStageCapture(      // advance.ts:284
  base: string,
  session: Session,
  stageId: string,
  transport?: AdvanceTransport,
): Promise<CompleteStageCapture> {
// POST /api/v1/stages/{id}/complete {} ; finalRanks read off events[0] — the ONLY time they cross the wire

export function compareFinalRanks(               // advance.ts:345
  expected: readonly string[],
  actual: readonly string[] | undefined,
): FinalRanksComparison {
```
Division start:
```ts
export interface DivisionStartLayerInput {       // schedule.ts:1358
  base: string;
  session: Session;
  divisions: readonly DivisionToStart[];         // { divisionRef, divisionId }
  transport?: DivisionStartTransport;
}
export async function runDivisionStartLayer(     // schedule.ts:1465
  input: DivisionStartLayerInput,
): Promise<DivisionStartLayerResult> {           // { outcomes, allStarted }
// POST /api/v1/divisions/{id}/start (:1385)
```
Scheduling:
```ts
export interface ScheduleLayerInput {            // schedule.ts:264
  base: string;
  session: Session;
  orgId: string;
  divisions: readonly ScheduleDivision[];
  courtIdByRef: ReadonlyMap<string, string>;
  engine: RequestedEngine;
  transport?: SeedTransport;
  now?: () => number;
}
export async function runScheduleLayer(input: ScheduleLayerInput): Promise<ScheduleLayerResult> {   // schedule.ts:769
export async function writeEngineArtifact(reportDir: string, runId: string, engine: string, payload: unknown): Promise<string> {   // :1162
export async function readEngineArtifacts(reportDir: string, runId: string): Promise<Record<string, unknown>> {   // :1193
```
Routes (schedule.ts): PUT `/divisions/{id}/schedule-settings` :846, PATCH `/fixtures/{id}` (locks) :858, `/stages/{id}/schedule/auto` :903 (sends `only_unlocked:false` to request a BUILD), `/stages/{id}/schedule/apply` :930, `/divisions/{id}/schedule/validate` :947, GET `/divisions/{id}/fixtures` :958, `/orgs/{orgId}/venues` :989.

### 3.6 Event posting — `lib/simulate.ts` / `lib/import.ts`
```ts
export interface SimulateStreamsInput {          // simulate.ts:116
  readonly base: string;
  readonly session: Session;
  readonly streams: readonly PackStream[];
  readonly fixtureIdByKey: ReadonlyMap<string, string>;
  readonly refIdByKey: ReadonlyMap<string, string>;
  readonly roundByFixtureKey?: ReadonlyMap<string, number>;
  readonly transport?: SimTransport;
}
export async function simulateDivisionStreams(input: SimulateStreamsInput): Promise<SimulateResult> {   // simulate.ts:298
export function resolvePayloadRefs(              // simulate.ts:177
  value: unknown,
  refIdByKey: ReadonlyMap<string, string>,
  caller = "simulate",
): unknown {
export function computeEventsPerSecond(eventsSent: number, wallMs: number): number {   // simulate.ts:157

export interface ImportDivisionStreamsInput {    // import.ts:177
  readonly base: string;
  readonly session: Session;
  readonly divisionId: string;
  readonly importId: string;
  readonly streams: readonly PackStream[];
  readonly fixtureIdByKey: ReadonlyMap<string, string>;
  readonly refIdByKey: ReadonlyMap<string, string>;
  readonly transport?: ImportTransport;
  readonly caps?: { readonly streams: number; readonly eventsPerFixture: number; readonly eventsPerCall: number };
}
export async function importDivisionStreams(input: ImportDivisionStreamsInput): Promise<ImportResult> {   // import.ts:442
export function buildImportId(divisionRef: string, runId?: string): string {   // import.ts:292
```
**`expected_seq` tracking** (simulate.ts:10-21, :245-270): no state is read from the server; the loop sends `{ expected_seq: i, type: event.type, payload }` where `i` is the event's 0-based index in `stream.events` (empty ledger tip = 0, so first event is `expected_seq: 0`). POST `/api/v1/fixtures/{fixtureId}/events`. 201 -> next; 409/402/422 -> stop THAT fixture, record `SimulateFinding` (incl. `currentSeq` from 409 body); any other status -> throw `BenchHttpError`. Sequential per fixture; concurrent across fixtures within a "wave"; waves = ascending `round_no` from `roundByFixtureKey` (needed for brackets — flat Promise.all refuses later rounds with `WRONG_PHASE`). Import path sends no seq (server mints `i+1`); route `POST /api/v1/divisions/{id}/events/import` (import.ts:371). This assumes a fresh fixture ledger — it cannot resume a partially-scored fixture.

### 3.7 Standings / final-ranks / board readers — `lib/oracle.ts`
```ts
export async function fetchStandings(            // :198   GET /api/v1/stages/{id}/standings[?pool_id=]
  base: string,
  session: Session,
  stageId: string,
  poolId?: string,
  transport?: OracleTransport,
): Promise<StandingsWire> {
export async function fetchDivisionFixtures(     // :1427  GET /api/v1/divisions/{id}/fixtures
  base: string,
  session: Session,
  divisionId: string,
  transport?: OracleTransport,
): Promise<readonly FixtureWire[]> {
export async function fetchFixtureSideLines(     // :1465  GET /api/v1/fixtures/{id}/state (summary)
  base: string,
  session: Session,
  fixtureId: string,
  transport?: OracleTransport,
): Promise<readonly MatchSideLine[] | undefined> {
export async function fetchFixtureModuleState(   // :1634  GET /api/v1/fixtures/{id}/state
  base: string,
  session: Session,
  fixtureId: string,
  transport?: OracleTransport,
): Promise<unknown> {
export async function fetchDivisionPlayerStats(base: string, session: Session, divisionId: string, transport?: OracleTransport): Promise<DivisionPlayerStatsWire> {   // :215
export async function fetchPersonStats(base: string, session: Session, personId: string, divisionId?: string, transport?: OracleTransport): Promise<PersonStatsWire> {   // :231
export async function fetchPersonCareerStats(base: string, session: Session, personId: string, transport?: OracleTransport): Promise<PersonCareerStatsWire> {   // :248
export function standingsRankOrder(rows: readonly StandingsRowWire[]): readonly string[] {   // :570
```
Wire types: `StandingsRowWire` (:113: `entrantId, played, won, drawn, lost, points, metrics?, rank?, rankLocked?, tieUnbroken?, tieBreak?`), `StandingsWire` (:128: `stage_id, pool_id, rows, computed_through_seq, updated_at`), `FixtureWire` (:1448: `id, ext_key, status, round_no, outcome`). **Final ranks have no reader** — they exist only in `completeStageCapture`'s response (advance.ts:264 doc; `GET /divisions/{id}/history` never carries them).

### 3.8 Offline pack validator
```ts
export function validatePack(                    // validate-pack.ts:1318
  raw: unknown,
  opts: ValidatePackOptions,                     // { readonly expectedSuite: string }  (:262, REQUIRED)
): PackValidation {                              // { ok, findings, provenance, pack | null }  (:253)
export function bootRegistry(): typeof registry {            // :352
export function resolveDivisionCfg(                          // :557
export function packLineupPair(stream: PackStream): LineupPair {   // :514
export function packEnvelopes(stream: PackStream): EventEnvelope[] {   // :467
export function stageScopedFoldCfg(                          // :399

export async function loadPackFile(file: string): Promise<PackLoad> {        // pack-io.ts:96
export function loadPackValue(raw: unknown, file: string): PackLoad {       // pack-io.ts:87  (expectedSuite = basename(file,".json"))
export type PackLoad = PackLoadOk | PackLoadRefused;                        // pack-io.ts:61
export function formatFinding(finding: PackFinding): string {               // pack-io.ts:76
export async function tinyPackStage(packPath: string): Promise<TinyPackStage> {   // run-suite.ts:940
```
Note `loadPackValue` derives `expectedSuite` from the FILENAME — a generated pack must be named `<suite>.json` matching `pack.suite`.

### 3.9 Oracles / comparators — `lib/oracle.ts` (+ advance.ts)
```ts
export function compareMatches(expected: readonly ExpectedMatchRow[], actual: readonly ActualMatchRow[]): MatchComparison {   // :1331
export function compareStandings(expected: readonly ExpectedStandingsRow[], actual: readonly StandingsRowWire[]): StandingsComparison {   // :388
export function compareTieOrderCascade(cascade: readonly string[], rowsInRankOrder: readonly StandingsRowWire[]): TieOrderComparison {   // :523
export function compareRankCrossings(captured: readonly string[] | undefined, standings: readonly string[]): RankCrossingComparison {   // :612
export function compareChampion(expected: string, standingsRanked: readonly string[], captured: readonly string[] | undefined): ChampionComparison {   // :665
export function compareLeaderboard(metricKey: string, expected: readonly ExpectedLeaderboardEntry[], actual: DivisionPlayerStatsWire): LeaderboardComparison {   // :727
export function compareCareerStats(expected: readonly ExpectedCareerStat[], actual: PersonCareerStatsWire): { readonly matched: boolean; readonly entries: readonly CareerStatComparison[] } {   // :796
export function comparePersonDivisionStat(       // :832
export function compareSuspensions(expected: readonly ExpectedSuspension[], actual: { readonly active: readonly SuspensionWire[]; readonly sheets: readonly SuspensionFixtureSheet[] }): { readonly matched: boolean; readonly entries: readonly SuspensionComparison[] } {   // :997
export function compareSpecials(expected: readonly ResolvedSpecial[], subjects: ReadonlyMap<string, SpecialSubject>): SpecialsComparison {   // :1546
export function compareFinalRanks(expected: readonly string[], actual: readonly string[] | undefined): FinalRanksComparison {   // advance.ts:345
export function compareQualifiers(               // advance.ts:149
```
Row inputs: `ExpectedMatchRow` (:1244: `fixtureExtKey, outcome: MatchOutcome, perSide?`) — refs must ALREADY be resolved to entrant ids by the caller; `ActualMatchRow` (:1252: `extKey, status, roundNo, outcome: unknown, perSide?`). Render helpers: `renderStandingsMismatch` :450, `renderRankCrossingMismatch` :631, `renderChampionMismatch` :677, `renderLeaderboardMismatch` :758, `renderSideBySide` :275. Zero-subject rule: an empty expected set must be reported `verdict: "no_subject"`, never a pass (report.ts beside `OracleVerdict`, :114).

### 3.10 Report writer — `lib/report.ts`
```ts
export type SuiteReport = z.infer<typeof SuiteReport>;   // :761
export type BenchReport = z.infer<typeof BenchReport>;   // :789
export type OracleResult = z.infer<typeof OracleResult>; // :166
export function oracleVerdictOf(o: OracleResult): OracleVerdict {   // :170
export function oracleLogFields(kind: string, verdict: OracleVerdict): {   // :182
export function resolveRunId(cliArg: string | undefined, gitSha: string): string {   // :799
export function gateOf(report: Pick<BenchReport, "preflight" | "suites">): GateStatus {   // :812
export interface WrittenReport { dir: string; jsonPath: string; mdPath: string; }   // :817
export async function writeReport(reportDir: string, report: BenchReport): Promise<WrittenReport> {   // :823
export function renderMarkdown(report: BenchReport): string {   // :1369
```
`writeReport` Zod-parses `BenchReport` BEFORE writing (a new field not in the schema fails the write), writes `<reportDir>/<runId>/report.json` + `report.md`. `gateOf` reds on any suite gate `!== "green"` (so `"skipped"` reds).

---

## 4. How match events are produced

**Run time: none produced.** `simulateDivisionStreams`/`importDivisionStreams`/the tap driver replay `pack.streams[i].events` exactly, substituting `@ref` strings via `resolvePayloadRefs` (simulate.ts:177). Pack schema forbids `seq`/`id`/`fixtureId` in events (pack-schema.ts:26-39) and refuses `core.void` in a stream (pack-schema.ts:609-613).

**Build time (packs/build-packs):**
- Generic sport — hand-authored literals. `_tiny.ts`: `d-tiny` streams :351-412, `d-tiebreak` :1165-1212. `suite11.ts` (darts modelled as `generic`): `scoreEvents` :350-358, `worldsEvents` :376-390, womens :470-481.
- Set-based sports (side-attributed rallies) — `reconstructSetBasedStream` (reconstruct.ts:654) -> `reconstructSetRallies` (:342); emits `core.start` + one `{type: rallyType, payload:{wonBy}}` per point; deterministic via engine `mulberry32` seed stored in the pack. **Only caller: `_tiny.ts:727` for badminton (`rallyType: "badminton.rally"`, :735).** Header names badminton/volleyball/table-tennis as the intended users.
- Period sports — `fillPeriodMarkers` (reconstruct.ts:815) inserts whistles/period markers only (refuses any attributed action). **No caller in the tree.**
- No generator exists for cricket, tennis, football, hockey, etc.

**Event types per complete match (as authored today):**
| Sport | Complete match | Source |
|---|---|---|
| generic (score model) | `core.start` -> `generic.result {p1Score, p2Score}` | `_tiny.ts:359-361`, :409-411, :1173-1175, :1208-1210 |
| generic (tally) | `core.start` -> N × `generic.score {by:"@e-…", points, person:"@p-…"}` -> `generic.result` (empty payload) | `_tiny.ts:371-376`; `suite11.ts:350-358,389` |
| badminton | `core.start` -> N × `badminton.rally {wonBy}` (76 events for the `_tiny` fixture) — no result card | `_tiny.ts:727-738`, reconstruct.ts:342 |

**Walkover / forfeit / retire:**
- Walkover: `core.start` -> `core.forfeit { by: "@<loser entrant>", reason: "walkover" }`, no result card (suite11.ts:376-387). Folds to `{kind:"award", winner, method: reason}` (pack-schema.ts:1075-1090); fixture status derived `forfeited`.
- Retirement: same type, `core.forfeit { by: "@e-bravo", reason: "retired hurt" }` (`_tiny.ts:386-388`); asserted by the `retirement` special (`_tiny.ts:527-536`). Pack-schema header :108-110 also names `core.lineup.retirement` as a retirement type.
- `core.abandon` is organiser-only in the tap path (drivers/scorer.ts:309); no pack uses it.
- Tap path appends a bench-owned `core.finalize` (drivers/scorer.ts:762-771) — API/import paths do not finalize (fixtures end `decided`, not `finalized`).

---

## 5. How the bench is run

- Scripts (root `package.json`): `"bench:scheduler": "node --experimental-strip-types scripts/bench/bench.ts"` (:15), `"bench:build-packs": "node --experimental-strip-types scripts/bench/packs/build-packs/_tiny.ts"` (:16), `"lint:scripts": "eslint scripts"` (:50).
- CLI flags (`bench.ts:118-208`): `--suite <key>` (repeatable; validated against `SUITE_REGISTRY`), `--engine optimized|greedy|both` (an ASSERTION on what the solver reported, not a selector), `--keep` (default) / `--wipe`, `--report-dir` (default `bench-report`), `--base`, `--run-id` (default git SHA), `--entry admin|registration`, `--record-video[=dir]`, `--trace[=dir]`.
- BASE URL: `--base ?? process.env.SMOKE_BASE`; no default — throws (bench.ts:186-189). Preflight refuses port 3000/3100 (env.ts:32, :221) and host `127.0.0.1` (:235; use `localhost`).
- Env vars read by the bench process: `SMOKE_BASE` (bench.ts:186), `DATABASE_URL` (env.ts:390, plan.ts), `DB_SCHEMA` (default `seazn_club`, env.ts:400), `DATABASE_SSL` (:401), `BENCH_EXPECTED_DATA_DIR` (:442, optional), `PLACEMENT_SERVICE_HOST` (:518, default `placement.flycast:50051`, preflight probe only), `STRIPE_SECRET_KEY` (:630; `sk_live_` refused outright), `STRIPE_CONNECT_TEST_ACCOUNT` (:633; also run-suite.ts:5426), `STRIPE_WEBHOOK_SECRET` (:634), `STRIPE_LISTEN_STATUS_FILE`/`STRIPE_LISTEN_PID` (:327/:337), `LOG_LEVEL` (log.ts:20). Server-side (bench.yml): `AUTH_DEV_LINKS=1` (required for a prod build), `PLACEMENT_SERVICE_HOST/SECRET`, `NEXT_PUBLIC_SCOREPAD_HOLD_MS` (build-time, job level).
- DB guards (`createRealPreflightProbes`, env.ts:389-470): `DATABASE_URL` unset -> refuse; port 5432 (`DEV_DB_PORT`, :36) -> refuse `own_db_dev_db_port` BEFORE connecting; then `show data_directory`; mismatch with `BENCH_EXPECTED_DATA_DIR` -> refuse (check skipped when that var is unset). Also `sports_catalog_unsynced` (checks `sports.key='badminton'` and a system `sport_variants` row, :552-595), `own_port_unbound` (lsof `-sTCP:LISTEN`, ss fallback), `app_health_*` (`GET {base}/api/health`, 10 s). Placement is reported, NOT gating (only db/ownPort/catalog/health refuse, :254-256). Stripe/Chromium refuse only when `selectedDivisions` needs them — and `bench.ts:362` calls `runPreflight(config.base, probes)` with NO `selectedDivisions`, so they are warnings in practice.
- `_tiny` (minimal example): `packs/_tiny.json`, path `TINY_PACK_PATH` (suites/tiny.ts); built by `packs/build-packs/_tiny.ts`. Contents: org `bench-tiny-club` (UTC, no currency); venue `v-tiny` with courts `c-tiny-1`,`c-tiny-2`; divisions — `d-tiny` (generic/score, `s-league` league + `s-playoff` knockout fed `rankRange 1..2`), `d-badminton` (badminton/bwf, one league), `d-registration` (generic, knockout, `entry: registration-ui`, offline payment, 2 entries — excluded from `seedSuite`, driven by the registration funnel), `d-tiebreak` (generic, 3-entrant league incl. a team). 9 entrants, 11 persons, 8 streams (3 league + 1 playoff for d-tiny, 1 badminton reconstructed 76 events, 3 tiebreak), expected: matches 8, tables 3, champions 1, finalRanks 1, leaderboards 4, careers 2, suspensions 1, specials 1; officials 2, claimInvites 2. Play modes under the registry: `d-tiny` = **tap** (Chromium), `d-badminton` = import, `d-tiebreak` = import.
- `suite11`: 2 generic knockout divisions (`d-worlds` api single-POST, `d-womens` import), 205 streams.

---

## 6. Tests and workflows

- Unit tests: 56 `*.test.ts` under `scripts/bench/**/__tests__/`. **No vitest config for the bench** (only `apps/web/vitest.config.ts`, `packages/engine/vitest.config.ts` exist); CI invokes the engine package's binary with an explicit path:
  `ci.yml:194-195` — `./packages/engine/node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile=vitest-results-bench.json --testTimeout=30000 scripts/bench` (step "Bench lib unit tests (DB-free)", in the same job as eslint; DB-free BY DESIGN — all I/O through injected transports/`PreflightProbes`). No `package.json` script runs them. Lint: `ci.yml:177-178` `npm run lint:scripts`.
- `strip-types-loadable.test.ts` spawns a real `node --experimental-strip-types` import of every shipped module — new lib files must be strip-types-loadable (no TS enums/namespaces, `.ts` import suffixes).
- `.github/workflows/bench.yml`: triggers `workflow_dispatch` (inputs `suite` default `_tiny`, `engine` default `optimized`) and `pull_request` on `paths: .github/workflows/bench.yml` only; no cron (R84). Job: postgres:16 service on host port **5433** (5432 refused by preflight); env `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres`, `DATABASE_SSL=disable`, dummy `STRIPE_SECRET_KEY=sk_test_ci_bench_dummy`, `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000`, auth/JWT CI dummies. Steps: checkout -> pnpm install -> `npm run db:apply` -> `npm run sync:sports` -> `npm run build --workspace apps/web` (`SKIP_TYPECHECK=1`) -> build placement image `services/placement` -> `docker run -p 50051:50051 -e PLACEMENT_SERVICE_SECRET=ci-bench-secret` + TCP wait -> `npx playwright install chromium` (apps/web) -> start standalone server `node apps/web/.next/standalone/apps/web/server.js` with `PORT=3200`, `AUTH_DEV_LINKS=1`, `PLACEMENT_SERVICE_HOST=localhost:50051`, `PLACEMENT_SERVICE_SECRET`, `LOG_LEVEL=warn` (after copying `.next/static` and `public/` into standalone), poll `/api/health` 90×2 s -> `node --experimental-strip-types scripts/bench/bench.ts --suite … --engine … --base http://localhost:3200` -> upload `bench-report/` -> cat server log on failure. No Redis. No `--wipe` passed (fresh DB each run anyway). No `BENCH_EXPECTED_DATA_DIR`.

---

## 7. Reuse restrictions / owner sign-off

- **PackSchema freeze**: `lib/pack-schema.ts:8-12` ("public contract. It FREEZES at the end of session B06; an additive change after that is escalated to the owner in a PR, never landed silently"); refined by `docs/superpowers/specs/bench-product-value/bench-prompts/_RULES.md:104-107` ("PackSchema is FROZEN after **B06b** … Additive needs escalate to the owner in the PR, never land silently"). Reservation/escalation notes also at pack-schema.ts:503-553, :751-752, :1081-1085, :1426-1428, :1762-1763.
- **`schemaVersion`**: `lib/pack-schema.ts:1566` `schemaVersion: z.literal(1),` (doc :1545-1565: after the freeze, additive = owner escalation, breaking = bump this literal). `PackSchema` export :2518, `Pack` type :2531.
- **smoke.ts is never imported** (copy its shapes instead): `lib/http.ts:1-5`, `lib/env.ts:386`, `_RULES.md` §1 ("no smoke.ts refactor").
- **scripts/bench never imports apps/web in production code** (Global Constraint R39): `lib/drivers/adapters/generic.ts:9-15`, `drivers/scorer.ts` header. Restate + pin equal in a test instead.
- **Checker independence**: `_RULES.md:84-88` — checker imports no solver code and trusts no `/validate` output.
- **Oracle direction is sacred**: `_RULES.md:43-45`, pack-schema.ts:18-24 — no helper may write an outcome/verdict; packs carry raw events + expected values.
- **Single-POST path must stay covered**: `_RULES.md:69-72` — if batch import is used, one suite must stay on single-event POST (today that is suite11's `d-worlds`; `run-suite.ts:3390-3395`).
- **Timings never gate**: `_RULES.md:27-29`.
- **Scoring is free (owner ruling)**: `lib/dls-gate.ts:9-14`; the run reds if `cricket.dls` stops being granted on `community` (run-suite.ts:2098-2111).
- **Stripe Connect test account must be restored**: run-suite.ts:5390-5392 (smoke shares it).
- `_RULES.md` §1 also: one PR per session; never enable e2e.yml (stale vs AGENTS.md, which says e2e.yml is live on push to main); all 4 test types; re-verify every `file:line`.
