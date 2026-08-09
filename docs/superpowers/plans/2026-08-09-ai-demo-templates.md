# Pick-a-Template AI Schedule Demo (#364) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `/[lang]/scheduling` marketing page gains a section where a visitor picks one of three templates and watches a recorded real AI Schedule Architect run replay through the actual product components, with zero runtime LLM calls.

**Architecture:** Thin fixtures — each committed JSON stores the seeded inputs (`SchedulePack`/`CompetitionPack`, board fixtures, movable ids) and the verified wire response, captured once via an env-gated vitest harness that calls the real `aiPlanForDivision`/`aiPlanForCompetition` against a throwaway schema. Trace, diff and price are recomputed at render by the product's own pure functions (`buildScheduleTrace` extracted, `computeAiDiff`, `quoteRun`). A drift-guard unit suite re-verifies every fixture against today's code.

**Tech Stack:** Next.js (repo's TS7/Node26 toolchain), vitest, Playwright, postgres.js, zod. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-09-ai-demo-templates-design.md` (amended by Task 0).

## Global Constraints

- No server routes, no credit spend, no runtime model call. Only server-file edits allowed: adding `export` to existing functions in `schedule-ai.ts`.
- Every user-facing string in all 4 locale dictionaries (`apps/web/src/dictionaries/{en,es,fr,nl}/marketing.json`), flat dotted keys. After adding keys: `npm run i18n:gen-keys` and `npm run i18n:check` — `git status --porcelain` clean after gen.
- UI verified at desktop AND 375px (project `mobile-se` is 375×667); no horizontal page scroll.
- Pre-commit every time: `npm run openapi:gen && git status --porcelain` empty.
- Never `git stash` (shared stack); worktree `/Users/ashokhein/github/seazn.club/.claude/worktrees/ai-demo-templates-364`, branch `worktree-ai-demo-templates-364`. Prefix every verify command with `cd <abs worktree> && `.
- Vitest green is judged ONLY from `--reporter=json` (`numPassedTests`/`numTotalTests`); rtk summaries lie about collection failures.
- DB work: NEVER the local dev DB. Test DB on :54329 per `seazn-local-env`; fresh schema = `db:apply` AND `sync:sports`.
- Anchor dates are literal ISO strings (repo seed convention); `Date.now()` only for run-unique tags, never fixture data.
- HTML-body assertions anchor on `="` (RSC serialises omitted props as `"$undefined"`).

## Reference shelf (verified file:line, all under `apps/web/src/` unless noted)

- `components/v2/board/ai-trace.tsx:45` `AiTrace {phase; events: TraceEvent[]; running; onFlag?}`; `TraceEvent {t: "step"|"log"|"flag"|"clean"; text}` (:22-28). Caller remounts via `key={traceNonce}` to replay.
- `components/v2/board/ai-console.tsx:1375` `buildScheduleTrace(plan: AiPlanResponse, courts: number, msg): {events, flaggedIds}` — reads only `plan.proposal.length`, `plan.blocking`, `plan.warnings`, `plan.usage.repair_rounds`; keys `board.ai.trace.*`.
- `components/v2/board/ai-diff-panel.tsx:25` `AiDiffPanel {plan: AiPlanResponse; fixtures: AiConsoleFixture[]; excluded: string[]; onToggleExclude}`; keys `board.ai.*`, `board.conflict.*` (fallback `CONFLICT_LABEL` in `board/types.ts:63`).
- `components/v2/board/ai-diff.ts` — `AiFixtureRef {id; scheduled_at; court_label}` (:11), `AiConsoleFixture extends AiFixtureRef + {code; matchup; isFinal; isJunior; stage_id; division_id?; status; home_entrant_id; away_entrant_id}` (:21), `computeAiDiff` (:112), `blockingConflictKey` (:184).
- `lib/ai-rung.ts` — `RungInput {movableFixtures; entrants; courts}` (:122), `predictRung(input, weights)` (:157), `quoteRun(lines: QuoteLineInput[], weights): Quote` (:239, joint = `Σ−1` credits), `schedulingRungWeights()` (:58, env-fallback defaults, client-safe).
- `server/usecases/schedule-ai.ts` — `buildSchedulePack(auth, divisionId, opts)` (:570, exported; `mode: "generate"|"refine"|"repair"`, movable = `status === "scheduled"`, repair 422s on empty scope), `structuralCheck(plan, movableIds, pack)` (:1505, UNEXPORTED — reads `pack.settings.courts` + `pack.fixtures.movable[]`), `toEngineAssignments` (:1557, exported), `verifyConfig(pack)` (:1679, exported), `toObstacleAssignments` / `packFeedDependencies` (UNEXPORTED, used at :1846-48), `runAiPlan` (:1822, exported), `aiPlanForDivision(auth, divisionId, input)` (:2469).
- `server/usecases/competition-schedule-ai.ts` — `buildCompetitionPack(auth, competitionId, divisionIds, opts)` (:405), `toJointEngineAssignments` (:1175), `toJointObstacleAssignments` (:1241), `jointFeedDependencies` (:1263), `verifyConfigFor` (:1308), `jointStructuralCheck` (~:1417), `verifyJoint` (~:1557), `partitionConflicts` (:1546) — all exported; `aiPlanForCompetition(auth, competitionId, input)` (:2316).
- `server/api-v1/schemas.ts` — `AiPlanRequest` (:1954, `instruction` REQUIRED 3-4000 chars, `mode`, `scope?`, `rung?`), `AiPlanResponse` (:2110), `AiCompetitionPlanResponse` (:2313, adds `division_id` per proposal row, `divergent_courts`, `divisions[]`), `AiPlanConflict {fixtureId; reason; detail?; rule?}` (:2014), `CreateStage {seq; kind; name; config}` (:519), `StageKind` enum incl. `league|group|knockout` (:27). Group pools: `config: {pools: {count: N}}`, seeded snake (stages.ts:558-575).
- `server/usecases/__tests__/_seed.ts` — `seedOrg(plan?): {auth: AuthCtx}` (:30), `GENERIC_CONFIG` (:14), full seed example `seedFutureDivision` (:86-117 — createCompetition → createDivision → createEntrants → createStages → generateStageFixtures → raw `update fixtures set scheduled_at/court_label`).
- `server/usecases/__tests__/ai-credit-wallet-spend.test.ts` — `SCHEDULE_SETTINGS_CONFIG` + `schedule_settings` insert (:64-88), `grantCredits` ledger insert (:177-180), provider mock shape (:39-45 — capture harness must NOT use the mock).
- `lib/i18n.ts:77` `getDictionary(locale, ns)` (server-only, merges en base); `components/i18n/dict-provider.tsx` `DictProvider {dict; locale}` (:17), `useMsg` (:78, `{name}` interpolation, miss → key).
- e2e: `playwright.config.ts` (no webServer; `PLAYWRIGHT_BASE ?? :3000`; projects setup/parallel/serial + `mobile-se` 375×667; serial-vs-parallel by filename regex at :31); unauth marketing pattern `e2e/marketing-scheduling.spec.ts:4-13` (`test.use({storageState:{cookies:[],origins:[]}})`).
- smoke: `scripts/smoke.ts` `marketingSuite()` (:8948, already fetches `/scheduling`), `check(label, cond)` (:82); suites awaited in `main()` (:628-751).
- Dictionaries: `dictionaries/en/ui.json` 196KB holds all 367 `board.ai.*`/`board.conflict.*` keys — never ship whole to a public page.

---

### Task 0: Amend the spec — three premises corrected by scouting

**Files:**
- Modify: `docs/superpowers/specs/2026-08-09-ai-demo-templates-design.md`

**Interfaces:** none (docs).

Scouting falsified three spec statements. Fix them before any code so implementers don't build on them:

- [ ] **Step 1: Joint trace.** Replace the sentence claiming the joint console "has its own composition" with: `ai-competition-console.tsx` renders NO trace at all (no composer, no `AiTrace`). The demo's T2 panel therefore mirrors the real joint console — per-division placed ledger, review/diff, flat conflict list, Σ−1 price — with no trace spine. Trace replay is T1/T3 only. No new product behavior is invented for the demo.
- [ ] **Step 2: Capture location.** Replace `scripts/capture-ai-demo.ts` with the env-gated vitest harness (`CAPTURE_AI_DEMO=1`, `apps/web/src/demo/ai-templates/__capture__/capture.test.ts`, root npm script `capture:ai-demo`). Reason: `scripts/` drive HTTP only and cannot reach `buildSchedulePack`/the pack; apps/web vitest already imports usecases directly (repo precedent for env-gated writer: `REBASELINE_GOLDEN=1`).
- [ ] **Step 3: Determinism + fixture content.** (a) Usecases mint UUIDs server-side, so byte-identical re-runs are impossible on raw ids; determinism is asserted after first-seen UUID→placeholder normalization (the existing pack-determinism approach). Names, times, structure, counts remain literal-fixed. (b) The raw `AiSchedulePlan` never crosses any exported boundary (`AiPlanResult` is post-verify) — the fixture stores the verified `response` verbatim; the drift guard runs `structuralCheck` over a plan-shaped projection of `response.proposal` + `response.unschedulable` (structuralCheck walks both; the projection is lossless for its checks).
- [ ] **Step 4: Commit** `git add docs/superpowers/specs/2026-08-09-ai-demo-templates-design.md && git commit -m "docs: #364 spec amendments — no joint trace, vitest capture, normalized determinism"`

### Task 1: Extract `buildScheduleTrace` into a shared pure module

**Files:**
- Create: `apps/web/src/components/v2/board/ai-trace-compose.ts`
- Modify: `apps/web/src/components/v2/board/ai-console.tsx` (delete local fn ~:1368-1421, import instead)
- Test: `apps/web/src/components/v2/board/__tests__/ai-trace-compose.test.ts`

**Interfaces:**
- Produces: `export type TraceMsgFn = (key: MessageKey, vars?: Record<string, string | number>) => string`; `export function buildScheduleTrace(plan: TraceSource, courts: number, msg: TraceMsgFn): { events: TraceEvent[]; flaggedIds: string[] }` where `export type TraceSource = Pick<AiPlanResponse, "proposal" | "blocking" | "warnings" | "usage">` (type-only import from `@/server/api-v1/schemas` — erases at build, keeps the module client-safe). Task 6 consumes exactly this.

- [ ] **Step 1: Write the failing test.** Fake `msg = (k, vars) => vars ? `${k}:${JSON.stringify(vars)}` : String(k)`. Three cases pinning today's behavior (read the current fn at ai-console.tsx:1375-1421 and mirror its event order EXACTLY — this is the extraction's regression pin):
  1. clean run (`blocking: [], warnings: [], usage.repair_rounds: 0`, 3 proposal rows, 2 courts) → events sequence is exactly: step draft, log draft `{fixtures:3,courts:2}`, step plan, log plan `{count:3}`, step referee, log verify, clean line, step ready; `flaggedIds: []`.
  2. repaired-with-warnings (`warnings: [{fixtureId:"f1", reason:"rest", detail:"Alice 12m rest"}]`, `repair_rounds: 2`) → flag line carries the `detail`, repair node + rounds log present, ends clean + ready; `flaggedIds: ["f1"]`.
  3. blocking-remains (`blocking: [{fixtureId:"f2", reason:"court"}]`, no detail) → flag uses `c.detail || c.reason`, ends with `blockingRemain {count:1}` flag, NO clean, NO ready.
- [ ] **Step 2: Run it** — `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/ai-demo-templates-364/apps/web && npx vitest run src/components/v2/board/__tests__/ai-trace-compose.test.ts --reporter=json` (module missing → fails). NOTE (verified Task 1): vitest MUST run with cwd inside `apps/web` — the repo-root `--root` form exits 254 `Command "vitest" not found` and writes no JSON. Every later task's vitest step uses this cwd-inside-apps/web shape.
- [ ] **Step 3: Create the module** by MOVING the function body verbatim from ai-console.tsx (only change: `msg: ReturnType<typeof useMsg>` → `msg: TraceMsgFn`; add the `TraceSource` type). Re-point ai-console.tsx to `import { buildScheduleTrace } from "./ai-trace-compose"`. Do NOT touch `ai-officials-review.tsx`'s mirrored copy (out of scope — note it in the module's header comment).
- [ ] **Step 4: Tests pass + console suite still green:** the compose test AND `npx vitest run apps/web/src/components/v2/board --root apps/web --reporter=json` — judge from JSON counts only.
- [ ] **Step 5: Commit** `feat: extract buildScheduleTrace into shared pure module (#364)`

### Task 2: Deterministic seed builders for the three templates

**Files:**
- Create: `apps/web/src/demo/ai-templates/__capture__/seeds.ts`
- Test: `apps/web/src/demo/ai-templates/__capture__/__tests__/seeds.test.ts` (DB-gated: `describe.skipIf(!process.env.DATABASE_URL)`)

**Interfaces:**
- Consumes: `seedOrg`, `GENERIC_CONFIG` from `server/usecases/__tests__/_seed.ts`; usecases per reference shelf; `sql` from `@/lib/db`.
- Produces (Task 3 consumes): `export interface SeededTemplate { slug: string; competitionId: string; divisionIds: string[]; instruction: string; mode: "generate" | "repair"; joint: boolean }`; `export async function seedClubNight(auth): Promise<SeededTemplate>`; `export async function seedNorthsideOpen(auth): Promise<SeededTemplate>`; `export async function seedFinalsDay(auth): Promise<SeededTemplate>`; `export function normalizeIds(json: unknown): unknown` (first-seen UUID→`«u1»`,`«u2»`… walk, also normalizing UUIDs embedded in strings).

Datasets (issue comment, fictional, one biting constraint each). All timestamps literal ISO with `+01:00` (Europe/London anchor dates), all names from fixed arrays in the file:

1. **club-night** — "Tuesday Club Night", Riverside Badminton Club. 1 division (`sport_key: "generic"` unless a badminton key exists — check `select key from sports` at execution and prefer `badminton`), 8 entrants in 2 pools of 4 (`kind: "group"`, `config: {pools: {count: 2}}`), 12 fixtures via `generateStageFixtures`. `schedule_settings`: courts `["Court 1","Court 2"]`, `matchMinutes: 20`, `gapMinutes: 5`, `perEntrantMinRest: 20`, window Tue 2026-09-15 18:30→22:00, `constraints.restMin: 20`. Instruction: `"Schedule the club night. Nobody plays twice in a row — every player gets at least 20 minutes rest between matches."` Mode `generate`.
2. **northside-open** — 3 divisions, Sat 2026-09-19 + Sun 2026-09-20 09:00→21:00: Men's Singles `knockout` 32 entrants (31 fixtures, 45min, courts 1-4), Women's Singles `group` pools 6×4 (36 fixtures, 45min, courts 1-4), U15 Mixed `group` pools 8×4 (48 fixtures, 30min, courts 3-5, sessionWindows ending 18:00 both days). = 115 fixtures, divergent court sets, per-division match lengths. Instruction: `"Schedule all three divisions across the weekend. Courts 1-4 are shared by the adult draws; Court 5 is juniors only. All U15 matches must finish by 18:00 each day."` Mode `generate`, `joint: true`.
3. **finals-day** — "County League Finals Day", Eastvale Tennis Club. 1 division, 16 entrants, `league` stage trimmed to 40 fixtures (delete surplus via `delete from fixtures where id in (…)` after generation, keeping deterministic first-40 by `fixture_no`), 6 courts, Sat 2026-09-26 09:00→19:00, 60min/10min gap. Pre-schedule ALL 40 (raw `update fixtures set scheduled_at, court_label` — pattern _seed.ts:119-125, spread 09:00 onward across 6 courts), set the 11 with `scheduled_at < 13:00` to `status = 'decided'` (immovable: movable = `status === "scheduled"` only). Add `blackouts: [{from: "2026-09-26T13:00:00+01:00", to: "2026-09-26T15:30:00+01:00"}]` to `schedule_settings.config`. Instruction: `"Rain has closed all six courts from 13:00 to 15:30. Repair the schedule moving as few matches as possible; matches already played stay exactly where they are."` Mode `repair`.

- [ ] **Step 1: Failing test.** For each seed fn: seed via `seedOrg()`, assert fixture counts (12 / 31+36+48 / 40), T3 decided count = 11 and all decided have `scheduled_at < 2026-09-26T13:00+01:00`. Determinism: seed twice into the same schema (two orgs), `buildSchedulePack(auth, divisionId, {mode, now: ANCHOR_NOW})` each (T2: `buildCompetitionPack`), assert `JSON.stringify(normalizeIds(pack1)) === JSON.stringify(normalizeIds(pack2))`. `ANCHOR_NOW = new Date("2026-09-01T08:00:00.000Z")` literal.
- [ ] **Step 2: Run** (fails — module missing). Same vitest JSON invocation shape as Task 1 with the new path.
- [ ] **Step 3: Implement seeds.ts.** Mirror `seedFutureDivision` (_seed.ts:86) + `SCHEDULE_SETTINGS_CONFIG`/`setScheduleSettings` (wallet test :64-88). Entrant names: fixed arrays (e.g. T1 `["Priya N.","Marcus T.","Elena V.","Sam R.","Jordan K.","Aiko M.","Dev P.","Rosa L."]`; T2/T3 similar fixed lists, invented names only). One withdrawn entrant in T2 Women's (realism, "one retirement" per issue) — set AFTER generation so fixtures exist.
- [ ] **Step 4: Run to green** (JSON counts). Requires local test DB (`seazn-local-env`: :54329, fresh throwaway `DB_SCHEMA`, `db:apply` + `sync:sports`, `.env.local` present in worktree — copy from main checkout if missing, `readlink -f node_modules` first per worktree trap).
- [ ] **Step 5: Commit** `feat: deterministic seed builders for the three demo templates (#364)`

### Task 3: Capture harness + produce the three fixtures

**Files:**
- Create: `apps/web/src/demo/ai-templates/__capture__/capture.test.ts`, `apps/web/src/demo/ai-templates/{club-night,northside-open,finals-day}.json` (generated), `apps/web/src/demo/ai-templates/types.ts`
- Modify: root `package.json` (script `capture:ai-demo`)

**Interfaces:**
- Consumes: Task 2 seeds; `aiPlanForDivision`, `aiPlanForCompetition`, `buildSchedulePack`, `buildCompetitionPack`; `grantCredits` insert shape (wallet test :177-180).
- Produces (Tasks 4/6 consume): `types.ts` exporting `interface AiDemoFixture { meta: {slug; capturedAt; model: string; commit: string; mode: "generate"|"repair"; joint: boolean; instruction: string}; board: {fixtures: AiConsoleFixture[]; courts: string[]; entrants: {id: string; name: string}[]; window: {start: string; end: string} }; pack: unknown; movableIds: string[]; response: unknown }` (pack/response `unknown` — parsed by consumers with their own schemas; T2's `pack` is the CompetitionPack, `board.courts` the union with per-division sets recoverable from the pack).

- [ ] **Step 1: Harness first, gated OFF.** `capture.test.ts`: `describe.skipIf(process.env.CAPTURE_AI_DEMO !== "1")`. NO provider mock (real network is the point). Per template: `seedOrg()` → seed fn → `grantCredits(walletIdFor(orgId), 10)` → build pack (same `ANCHOR_NOW`) → call the real usecase (`aiPlanForDivision(auth, divisionId, {instruction, mode})` / `aiPlanForCompetition(auth, competitionId, {division_ids, instruction, mode: "generate"})`) → assemble `AiDemoFixture` (board.fixtures built from `divisionFixtures`-shape rows: query `fixtures` + entrant names, `code` = `F${fixture_no}`, `matchup` = "Home vs Away") → `writeFileSync` stable-stringified (sorted keys, 2-space indent, trailing newline) into `apps/web/src/demo/ai-templates/<slug>.json`. `meta.model` from response usage/served fields if present else `SCHEDULING_AI_MODEL` env; `meta.commit` from `git rev-parse HEAD` via `execSync`; `meta.capturedAt` `new Date().toISOString()` (capture-time stamp is correct here, not fixture data). Also an always-on `--check` companion test (no gate): if a committed fixture exists, reseed + rebuild pack and assert `normalizeIds(rebuilt) === normalizeIds(committed.pack)` — the issue's "re-runs and reproduces" acceptance, model excluded by design.
- [ ] **Step 2: npm script.** Root `package.json`: `"capture:ai-demo": "CAPTURE_AI_DEMO=1 npm test --workspace apps/web -- run src/demo/ai-templates/__capture__/capture.test.ts"`. Beware the positional-filter trap — pass the path EXACTLY; verify the JSON reporter's `.testResults[].name` resolves inside the worktree.
- [ ] **Step 3: RUN THE CAPTURE** with real keys (`apps/web/.env.local` — never print them; provider per env `AI_PROVIDER`/ladder). Fresh throwaway schema first (`DB_SCHEMA=demo_capture_<tag>` + `db:apply` + `sync:sports`). Expected cost: 3 model runs bounded by rung budgets (T1 rung1 ≤32K out; T2 joint ~rung Σ ≤196K; T3 ≤64K) — single-digit dollars. If T3 returns empty `unschedulable`, tighten the blackout (15:30→16:30) and reseed — the hero template MUST show honest unplaceable output; document the final blackout in seeds.ts.
- [ ] **Step 4: Eyeball the three JSONs** (sizes, `blocking: []` expected clean for T1/T2; T3 `unschedulable.length > 0`; T2 `divergent_courts` non-empty — the divergence warning firing on real data is a T2 acceptance criterion). Commit fixtures + harness: `feat: capture three real AI demo runs as fixtures (#364)`.

### Task 4: Drift guard

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai.ts` (add `export` to `structuralCheck` :1505, `toObstacleAssignments`, `packFeedDependencies` — no body changes)
- Test: `apps/web/src/demo/ai-templates/__tests__/drift.test.ts` (pure — no DB, no gate)

**Interfaces:**
- Consumes: fixture JSONs (static import), `AiSchedulePlan` (`schedule-ai-prompt.ts:239`), `AiPlanResponse`/`AiCompetitionPlanResponse` zod (schemas.ts), `structuralCheck`, `verifyConfig`, `toEngineAssignments`, `toObstacleAssignments`, `packFeedDependencies`, `validateAssignments` (`packages/engine/src/scheduling/calendar.ts:1257`), joint: `toJointEngineAssignments`, `verifyJoint`, `verifyConfigFor`, `jointStructuralCheck`, `toJointObstacleAssignments`, `jointFeedDependencies`.

- [ ] **Step 1: Write the suite** (fails on unexported helpers → then add the exports). Per fixture: (a) `response` parses with its wire zod schema; (b) plan projection `{assignments: response.proposal, unschedulable, explanations, summary}` — strip `division_id` per row for T2's per-division check — passes `structuralCheck(projection, new Set(movableIds), pack)` returning `null` (T2: `jointStructuralCheck` equivalent, read its exact signature at competition-schedule-ai.ts:~1417 first); (c) `validateAssignments(toEngineAssignments(projection, pack), verifyConfig(pack), toObstacleAssignments(pack), packFeedDependencies(pack))` → zero blocking conflicts (partition via `partitionConflicts` for joint; T2 uses `verifyJoint` per-division); (d) every `proposal[].fixture_id ∈ board.fixtures[].id`; (e) T3 only: no proposal row for any board fixture with `status: "decided"`, and `response.unschedulable.length > 0`; (f) T2 only: `response.divergent_courts.length > 0`.
- [ ] **Step 2: Run** — red on missing exports.
- [ ] **Step 3: Add the three `export` keywords.** Nothing else in the file changes.
- [ ] **Step 4: Green** (JSON counts). This suite is the museum tripwire: it fails when tomorrow's schema/verifier rejects today's committed run.
- [ ] **Step 5: Commit** `test: drift guard re-verifies every committed demo run (#364)`

### Task 5: Filtered dict subset for the public page

**Files:**
- Create: `apps/web/src/lib/i18n-subset.ts`
- Test: `apps/web/src/lib/__tests__/i18n-subset.test.ts`

**Interfaces:**
- Produces (Task 6 consumes): `export function pickDictPrefixes(dict: Dict, prefixes: readonly string[]): Dict` (flat-key filter, pure).

- [ ] **Step 1: Failing test:** given `{"board.ai.trace.node.draft":"a","board.conflict.court":"b","pricing.title":"c"}` and prefixes `["board.ai.","board.conflict."]` → exactly the first two keys. Plus a real-dict test: load `en/ui.json`, subset with those prefixes, assert `JSON.stringify(subset).length < 40_000` AND contains `board.ai.trace.node.draft` — the payload guard that keeps 196KB off the page.
- [ ] **Step 2-4:** red → implement (≤10 lines) → green → commit `feat: flat-key dict subset helper for public pages (#364)`.

### Task 6: `AiArchitectDemo` island + /scheduling section + locales

**Files:**
- Create: `apps/web/src/components/marketing/ai-architect-demo.tsx`
- Modify: `apps/web/src/app/[lang]/(marketing)/scheduling/page.tsx`, all 4 `dictionaries/*/marketing.json`
- Test: `apps/web/src/components/marketing/__tests__/ai-architect-demo.test.tsx`

**Interfaces:**
- Consumes: fixtures via `import("...club-night.json")` dynamic import on card select; `buildScheduleTrace`/`TraceSource` (Task 1), `AiTrace`, `AiDiffPanel`, `computeAiDiff`, `blockingConflictKey`, `predictRung`/`quoteRun`/`schedulingRungWeights`, `pickDictPrefixes` (Task 5), `DictProvider`/`useMsg`/`useT`.
- REQUIRED SUB-SKILL for this task: `frontend-design:frontend-design` — the section must sit inside the existing `mk-*` marketing design system (see page + `marketing-shell`), not read as a bolted-on widget.

- [ ] **Step 1: Failing RTL tests** (mock the dynamic import with the real committed T1 JSON): renders three cards, T3 first with hero emphasis; selecting T1 → after replay timer flush (fake timers; reduced-motion path = full dump) the trace events from `buildScheduleTrace` are on screen; "Recorded from a real run" label present with `meta.model` + capture date; price card shows `quoteRun([{key, input: {movableFixtures: movableIds.length, entrants, courts}}], schedulingRungWeights()).credits`; T2 (joint fixture) renders per-division ledger + Σ−1 discount line + divergent-courts note + flat conflict list, NO trace region; T3 renders unschedulable list non-empty + per-fixture explanations.
- [ ] **Step 2: red.**
- [ ] **Step 3: Implement.** `"use client"`. Replay: `useEffect` timer appending composed events one-by-one (~350ms cadence), `key={slug}` remount per selection, skip-to-end when `matchMedia("(prefers-reduced-motion: reduce)")` (AiTrace also handles its own reduced-motion). Diff panel: `excluded` local `useState<string[]>([])`. Price: computed, never hardcoded. Cards stack at 375px (`grid gap-4 sm:grid-cols-3`), panels `overflow-x-auto` in their own containers. Page side: `const ui = pickDictPrefixes(await getDictionary(lang, "ui"), ["board.ai.", "board.conflict."])`, merge `{...d, ...ui}` into the existing `DictProvider`. New marketing keys (EN authored, ES/FR/NL translated in the same commit — never English placeholders): `scheduling.aidemo.{title,subtitle,recordedLabel,recordedMeta,pick,replay,price.credits,price.joint,card.club-night.name,card.club-night.what,card.northside-open.name,card.northside-open.what,card.finals-day.name,card.finals-day.what,unschedulable.title}` (+ any the implementation needs — all 4 locales, flat keys).
- [ ] **Step 4: green** + `npm run i18n:gen-keys && npm run i18n:check && git status --porcelain` clean (commit the regenerated `i18n-keys.ts` if it changed).
- [ ] **Step 5: Commit** `feat: pick-a-template AI demo section on /scheduling (#364)`

### Task 7: E2E

**Files:**
- Create: `apps/web/e2e/marketing-ai-demo.spec.ts` (name must match the PARALLEL project regex — check `playwright.config.ts:31` and pick the non-serial bucket)

- [ ] **Step 1: Write the spec** (unauth `storageState` pattern from `marketing-scheduling.spec.ts:4-13`):
  1. **zero-model-network** (the issue's acceptance): before `goto`, collect every request; after selecting each of the three templates and letting the replay finish, assert NO request URL matches `/anthropic|openrouter|api\.openai|\/api\/v1\/.*ai/i`.
  2. T3 hero flow: cards visible, select finals-day → trace region appears and reaches its end state (`board.ai.trace.node.ready` text or blocking tail), diff panel + unschedulable list + price card visible.
  3. 375px (runs under `mobile-se`): `document.documentElement.scrollWidth <= window.innerWidth` after each template selection.
  4. Locale loop `for (const lang of ["en","es","fr","nl"])`: `/${lang}/scheduling` shows that locale's recorded-run label (assert against the actual dictionary value imported from the JSON, not hardcoded).
- [ ] **Step 2: Run locally** per `seazn-local-env`/`project_local_e2e_recipe` (:3100, prod build, `localhost` not 127.0.0.1, assert `lsof -t` PID is yours). All 4 tests green.
- [ ] **Step 3: Commit** `test(e2e): AI demo replay, zero model network, 375px, locales (#364)`

### Task 8: Smoke step

**Files:**
- Modify: `scripts/smoke.ts` (`marketingSuite()` :8948)

- [ ] **Step 1:** In `marketingSuite()`, on the existing `/scheduling` fetch add: `check("ai demo section", html.includes('data-ai-demo="ready"'))` — and add that literal `data-ai-demo="ready"` attribute on the section root in `ai-architect-demo.tsx`'s server-rendered wrapper (anchor includes `="` per the RSC trap). Assert all three slugs present as `data-ai-template="<slug>"` attributes.
- [ ] **Step 2:** Run the smoke marketing suite against a local prod server; paste the check lines. Commit `test(smoke): scheduling page renders the AI demo section (#364)`.

### Task 9: Final gates, screenshots, PR

- [ ] **Step 1: Full verify in the worktree** (each with `cd <abs worktree> && `): vitest full (`--reporter=json --outputFile` — judge from `numTotalTests`/`numPassedTests`/`numPendingTests`; confirm `.env.local` present so DB suites actually ran), `rtk proxy npm run lint` (read `✖ N problems`) + `@seazn/engine#lint` if engine touched (it isn't — skip with note), `typecheck`, e2e, smoke.
- [ ] **Step 2: Drift gates:** `npm run openapi:gen && npm run i18n:gen-keys && npm run schema:snapshot && git status --porcelain` → empty.
- [ ] **Step 3: Screenshots** desktop + 375px of the section (three cards, T3 mid-replay, diff+price) — attach to PR; no horizontal scroll visible.
- [ ] **Step 4: PR** to `main` (smoke CI runs on PRs only — never merge-local-push): body = issue #364 acceptance checklist ticked with evidence lines (counts, fixture sizes, zero-network assertion), the four test types named. `Closes #364`.

## Deviations from the issue text (all justified in Task 0 / spec)

- `scripts/capture-ai-demo.ts` → env-gated vitest harness + `capture:ai-demo` npm script (scripts/ cannot import usecases).
- Fixture stores verified `response`, not raw `AiSchedulePlan` (raw plan never crosses an exported boundary; projection is lossless for `structuralCheck`).
- "Identical bytes" holds after UUID normalization (server-minted ids), asserted by the always-on `--check` test.
- `lib/ai-diff.ts` in the issue is actually `components/v2/board/ai-diff.ts`.
- T2 shows no trace spine because the real joint console has none — the demo does not invent product behavior.
- Help pages: not updated — the demo is a marketing surface, not product usage; `content/help/**` documents the signed-in product. Noted here as a decision, not an omission.
