# C7 + C8 — z3 retirement, stages D and E: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `"z3"` / `"z3+lns"` / `"z3_unavailable"` from the public API contract (C7, one PR), then delete the z3 solver, its WASM plumbing and its dependency from the repo (C8, one PR).

**Architecture:** C7 is a pure **wire narrowing** — no migration (see Task C7-1, which proves this rather than assuming it) — plus a demo-fixture rewrite, a UI/i18n deletion, two regenerated openapi snapshots, and a shrunk drift ledger. C8 is a **deletion**: the z3 encoder, its WASM loader, the vestigial lock in `build.ts`, six benches, the npm dependency and both halves of the `next.config` WASM pair, gated by a dependency-graph proof and a prod-build smoke.

**Tech Stack:** TypeScript 7 / Node 26 / pnpm workspaces, Zod response schemas, Flyway (`db/migration/deltas`), Vitest, Playwright, Next.js standalone, `z3-solver@5.0.0`.

**Specs:**
- `docs/superpowers/specs/2026-08-12-z3-retirement-design.md` (stages D and E)
- `docs/superpowers/specs/2026-08-12-release2-prompts/C7-z3-public-contract.md`
- `docs/superpowers/specs/2026-08-12-release2-prompts/C8-z3-delete-solver.md`
- Standing rules: `docs/superpowers/specs/2026-08-12-release2-prompts/_RULES.md`

---

## Global Constraints

Every task's requirements implicitly include this section. Copied from `_RULES.md` and `AGENTS.md`; values are exact.

- **One PR per session.** C7 is one PR, C8 is one PR. Smoke CI runs on **PRs only** — merging locally and pushing to `main` skips it. Never run `gh workflow enable e2e.yml`; it is already live on pull requests (six Playwright jobs, including the seven-width mobile matrix).
- **New branch in a worktree**, never a checkout in the main repo dir. `pnpm install --frozen-lockfile` there, not `npm ci`. Then `readlink -f node_modules/@seazn/engine` — a symlink to MAIN's engine makes every engine edit invisible to your tests.
- **Don't raise new issues.** Fix defects and false premises in-session; if the blast radius exceeds the stated file set, ask first. Record under `Unplanned fixes` in the PR body.
- **Think past the literal brief.** Re-verify every `file:line` before trusting it. This plan already did so on 2026-08-17 against `252a073d`; re-pin anything that has moved by the time you run.
- **Every change ships a test that fails without it.** All four types (unit / e2e / smoke / regression) or the PR body names which are deferred and why.
- **i18n:** any new or changed user-facing string → all four locale dictionaries (`en`, `es`, `fr`, `nl`), flat dotted keys, never hardcoded English. Grep e2e for changed UI text before merging.
- **UI verified by screenshot** at 1280 / **320** / **768**, no horizontal page scroll at any width.
- **A BRAND-NEW DATABASE FOR EVERY FULL DB-BACKED RUN** — per run, not per session. `initdb` a fresh datadir, confirm `show data_directory` is yours (a `pg_ctl` that fails "Address already in use" is followed by a `createdb` that SUCCEEDS against someone else's server), then `db:apply` **and** `sync:sports`. `db:apply` alone is not a fresh schema.
- **Baseline before attributing.** Run the same command on `origin/main` with the same DB and the same services before calling any red yours. Measure your own base arm; do not trust an inherited number.
- **Verification traps.** vitest is green only from `--reporter=json --outputFile` (`numPassedTests`/`numTotalTests`); `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to collect. Lint via `rtk proxy` and read `✖ N problems`. `grep` reports source files here as "Binary file … matches" — always `-a`, or use `git grep`. Counts under `apps/` must exclude `.next/types`. A killed background command reports exit code 0 — have the command write `EXIT=$?` itself.
- **Shell cwd persists between Bash calls and can land you in another worktree.** This bit the planning session itself: a `cd` into `.claude/worktrees/rs001-registration` made two later greps read a pre-C6 tree and report a file under its old name. Prefix `cd <abs worktree> &&` in the *same* call, every call.
- **Drift gates are CI-only:** `npm run openapi:gen` and `npm run i18n:gen-keys`. Run locally and commit; `git status --porcelain` must be clean before the PR.
- Engine has its **own** lint task (`@seazn/engine#lint`); root lint skips it. `apps/web` typecheck peaks ~2.8 GB — `NODE_OPTIONS=--max-old-space-size=6144`.

### Skills — load, don't cite

| When | Skill |
|---|---|
| before code | `superpowers:test-driven-development` |
| before claiming done | `superpowers:verification-before-completion` |
| any unexpected red | `superpowers:systematic-debugging` |
| before the PR | `superpowers:requesting-code-review` + `/code-review` |
| worktree setup / red-suite triage | `seazn-local-env` |

---

## Gate status, verified 2026-08-17 at `252a073d`

C7's brief gates on "C4 + C5 **deployed**". Both halves have drifted and the drift is recorded here so the executor does not re-derive it:

- **C5 was superseded by C9** (`8b85ab39`, PR #583). PR #576 closed. The stage-B code that matters is `repair-decompose-cpsat.ts`.
- **C4 is `edd358af`** (PR #573), merged.
- **"Deployed" can only mean staging.** `prod.yml` fires on a version tag only, has **zero runs**, and its own header states the `seazn-club-prod` Fly app does not exist yet. There is no production environment for a narrowed enum to break.
- **Staging is at `252a073d`** (C6), stg deploy **success**. C9's own stg deploy at `8b85ab39` was also success. The gate is satisfied.
- **No production caller writes z3.** `build.ts` writes only `"greedy"` (`:1054`) and `"optimized"` (`:2256`); the AI repair path's `chosen.engine` traces only to `"optimized"` / `"llm"` / `"none"`. The one remaining `"z3"` assignment is `packages/engine/scripts/bench-ai-repair-cpsat.ts:142`, a bench, deleted or de-z3'd by C8.

## Findings that reshape the briefs

Four owner rulings were taken on 2026-08-17 and are baked into the tasks below. Do not re-open them.

1. **`z3_unavailable` is retired in C7, not left behind.** The brief's acceptance says openapi has "zero z3 occurrences (was 3)". The real count is **5**, in **both** `openapi/v1.public.json` and `openapi/v1.json`, and two of the five are the `status` member `z3_unavailable`. Nothing can produce it since C4/C9, and `solver_unavailable` (`schemas.ts:1284`) already renders through the identical copy. Retiring it is what makes the stated acceptance reachable.
2. **C8 deletes `z3-load.ts` outright, including its consumers.** `build.ts:116` imports `withZ3LockAndReset` and uses it at `:1210`; `build.ts:2404` already calls that wrapper vestigial. Eleven `build-*.test.ts` files import `resetZ3` as a hygiene guard. All are `ACCURATE_TODAY` ledger entries, i.e. outside C8's brief as written. C8's file set formally widens to cover them: after the deletion there is no z3 to reset, so those guards are inert by construction — the same vacuity C6 already recorded against `schedule-capacity-guard.test.ts`.
3. **The migration takes V365, not V363** — *if* a migration turns out to be needed at all (Task C7-1). The in-flight RS001 registration worktree holds unmerged `V363__registration_groups_players.sql` and `V364__registrations_regroup.sql`, and that session is live. V365 leaves it headroom; a two-number gap is harmless to Flyway.
4. **The status-check loop starts at execution kickoff**, not now. See "Status-check protocol" at the end of this plan.

Two further findings carry no ruling and are handled inside the tasks:

- **`schemas.ts:1016` and `:2190` are stale.** The real lines are **`:1229`** (`ScheduleSolverInfo.engine`) and **`:2592`** (`AiRepairReport.engine`).
- **Neither brief mentions three load-bearing sites:** `scripts/smoke.ts:8936-8937` (a live `check()` allow-list naming both z3 engines), `apps/web/src/lib/i18n-keys.ts:890-891`, and `scripts/__tests__/z3-retirement-drift.test.ts` itself.

---

## File Structure

### C7 (PR 1) — files touched

| File | Responsibility after this PR |
|---|---|
| `apps/web/src/server/api-v1/schemas.ts` | `:1229` engine enum → `["greedy","optimized"]`; `:2592` repair enum → `["none","optimized","llm"]`; `:1248-1285` status enum loses `"z3_unavailable"` |
| `packages/engine/src/scheduling/build.ts` | `:574` engine union → `"greedy" \| "optimized"`; `BuildStatus` (~`:368`) loses `"z3_unavailable"` |
| `apps/web/src/server/usecases/schedule-ai-solver.ts` | `:136` `RepairEngine` → `"none" \| "llm" \| "optimized"` |
| `apps/web/src/components/v2/board/result-strip.tsx` | `ENGINE_KEY` (`:33-40`) loses `z3` and `"z3+lns"`; `statusKey` loses the `z3_unavailable` case (`:68`) |
| `apps/web/src/lib/i18n-keys.ts` | `:890-891` key union loses both z3 keys |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` | lose `board.result.engine.z3` and `board.result.engine.z3lns` (`:3349-3350` in `en`) |
| `apps/web/src/demo/ai-templates/northside-open.json` | `:7027` `"engine": "z3"` → `"optimized"` |
| `openapi/v1.public.json`, `openapi/v1.json` | regenerated; zero `z3` occurrences |
| `scripts/smoke.ts` | `:8936-8937` allow-list loses both z3 engines |
| `scripts/__tests__/z3-retirement-drift.test.ts` | `OWNED_BY_C7` emptied; the ten files move out of the ledger |
| `docs/api-v1-breaking-changes.md` | **created** — the public breaking-change note C7's acceptance owes |
| `db/migration/deltas/V365__*.sql` | **conditional** — created only if Task C7-1 disproves the no-storage finding |

Test files: `apps/web/src/server/api-v1/__tests__/` (new schema-rejection test), `result-strip.test.tsx`, `result-strip-wiring.test.tsx`, `schedule-solver-telemetry.test.ts`, `schedule.test.ts`, `packages/engine/src/scheduling/build.test.ts`.

### C8 (PR 2) — files deleted / touched

**Deleted outright:** `packages/engine/src/scheduling/repair.ts`, `z3-load.ts`, `repair.test.ts`, `z3-load.test.ts`, `z3-handle-release.test.ts`, `z3-serialisation.test.ts`, `packages/engine/scripts/bench-repair.ts`, `packages/engine/scripts/bench-decompose.ts`, `apps/web/src/lib/__tests__/z3-tracing-config.test.ts`.

**Partially cut:** `repair-decompose.ts` (loses `repairDecomposed()` `:396-647` and its z3 imports `:72-78`; **keeps** `repairComponents()` `:280-357`, `dayCapGuard()` `:358-395`, and every shared type), `build.ts` (loses the `withZ3LockAndReset` import `:116` and call `:1210`), the eleven `build-*.test.ts` hygiene imports, `repair-decompose.test.ts` (loses `describe("repairDecomposed"…)` `:160` and `describe("two repairs at once"…)` `:634`), `packages/engine/src/scheduling/index.ts` (`:88`, `:96` re-exports), the four surviving benches (`bench-ai-repair-cpsat.ts`, `bench-reflow.ts`, `probe-lns-gate.ts`, `repair-cpsat-harness.ts`) lose their z3 imports.

**Config:** `apps/web/next.config.js` (`:73` `serverExternalPackages`, `:87-92` tracing includes), `apps/web/package.json:58`, `packages/engine/package.json:47`, `pnpm-lock.yaml`.

**Untouched, and asserted so:** `repairComponents()`, `dayCapGuard()`, `disjointConflictBound()` (`repair-minimality.ts`, in full), `repair-decompose-cpsat.ts`, the placement service, greedy.

---

# PHASE C7 — public contract retirement (PR 1)

## Task C7-0: Worktree and baseline

**Files:** none (environment).

**Interfaces:**
- Produces: an isolated worktree path `$WT` and a fresh database, used by every later task.

- [ ] **Step 1: Create the worktree off current main**

```bash
cd /Users/ashokhein/github/seazn.club
git fetch origin && git worktree add .claude/worktrees/c7-z3-contract -b feat/c7-z3-public-contract origin/main
export WT=/Users/ashokhein/github/seazn.club/.claude/worktrees/c7-z3-contract
cd "$WT" && pnpm install --frozen-lockfile
```

- [ ] **Step 2: Prove the engine symlink does not point at MAIN**

```bash
cd "$WT" && readlink -f node_modules/@seazn/engine; echo "EXIT=$?"
```

Expected: a path **under `$WT`**. If it resolves under `/Users/ashokhein/github/seazn.club/packages/engine`, stop — every engine edit will be invisible to your tests. Re-run `pnpm install --frozen-lockfile` from `$WT`.

- [ ] **Step 3: Stand up a brand-new database**

Follow the `seazn-local-env` skill. `initdb` a new datadir, start it on a port that is not 5432 and not 3000-adjacent, then:

```bash
psql "$DATABASE_URL" -c 'show data_directory'   # MUST be the datadir you just created
cd "$WT" && npm run db:apply && npm run sync:sports
```

`db:apply` alone is not a fresh schema — without `sync:sports`, `funnel.test.ts` fails `expected 'generic' to be 'badminton'`.

- [ ] **Step 4: Measure your own base arm, twice**

```bash
cd "$WT" && git checkout origin/main -- . 2>/dev/null; \
PLACEMENT_SERVICE_HOST=<host> npm test --workspace apps/web -- \
  --reporter=json --outputFile=/tmp/base-1.json src/server src/lib; echo "EXIT=$?"
```

Run it a second time into `/tmp/base-2.json`. Read `numPassedTests` / `numFailedTests` / `numTotalTests` from the JSON, not from the terminal summary. At least one known red here is intermittent at 1-in-3, which is why two runs are the minimum. Record both numbers in the PR body. Restore the branch working tree afterwards.

- [ ] **Step 5: Commit the empty branch marker**

```bash
cd "$WT" && git commit --allow-empty -m "chore(c7): branch base — record base arm numbers in PR body"
```

---

## Task C7-1: Settle whether a migration is owed

The brief's step 1 ("rewrite rows `engine z3|z3+lns → optimized`") and the design's premise ("`"z3"` is **stored** in board rows") could not be confirmed. Two independent searches on 2026-08-17 found **no** column, no CHECK constraint, no Postgres enum type and **zero `z3` hits anywhere under `db/`**. `ScheduleConfig` (`schemas.ts:843-894`) — the schema `_RULES.md` warns is the READ path — has no engine, solver or repair field at all. `ScheduleSolverInfo` (`:1223`) and `AiRepairReport` (`:2592`) are response schemas; the only imports outside tests are **type-only** client imports.

If that holds, the rewrite-then-narrow ordering constraint the brief calls "load-bearing" **does not apply**, and no migration is written. This task proves it or disproves it. Do not skip it and do not assume either answer.

**Files:**
- Create (conditionally): `db/migration/deltas/V365__z3_enum_rewrite.sql`
- Create: `docs/superpowers/specs/2026-08-12-release2-prompts/_INDEX.md` status-log entry (appended in Task C7-9)

**Interfaces:**
- Produces: a yes/no on the migration, recorded with its evidence. Every later task assumes **no migration** unless this one says otherwise.

- [ ] **Step 1: Sweep the DDL for any target**

```bash
cd "$WT" && git grep -a -i -l "z3" -- db/ ; echo "EXIT=$?"
git grep -a -n -i "engine\|repair_engine\|solver" -- 'db/migration/deltas/*.sql' \
  | grep -iv "officials engine\|v2-engine\|v1 engine\|engine-db\|engine boundary\|packages/engine" ; echo "EXIT=$?"
```

Expected: the first returns nothing. The second returns only prose comments about unrelated subsystems.

- [ ] **Step 2: Sweep the live database itself, not just the DDL**

Against the fresh DB from C7-0, seeded by `npm run seed:demo` in a **throwaway** schema:

```sql
-- any text column anywhere holding one of the retiring values
select table_schema, table_name, column_name
from information_schema.columns
where data_type in ('text','character varying','jsonb')
  and table_schema not in ('pg_catalog','information_schema');
```

Then, for every `jsonb` column that survives that list, one targeted probe:

```sql
select count(*) from <table> where <col>::text like '%"z3%';
```

Expected: every count is 0. `competition_events.payload` is the highest-risk candidate — probe it explicitly and paste the count.

- [ ] **Step 3: Prove the response schemas are never parsed on a read path**

```bash
cd "$WT" && git grep -a -n "ScheduleSolverInfo\.\(parse\|safeParse\)\|AiRepairReport\.\(parse\|safeParse\)" -- apps/web/src ; echo "EXIT=$?"
```

Expected: no hits. A hit means something reads a stored blob back through the narrowing enum and the migration IS owed.

- [ ] **Step 4: Record the verdict**

Write the three command outputs verbatim into the PR body under `Migration: owed / not owed`. If all three come back as expected, **no migration is written** and the brief's step 1 is recorded as a false premise (a finding, per the "think past the literal brief" rule) — not silently dropped.

- [ ] **Step 5 (ONLY if disproved): write V365**

```sql
-- db/migration/deltas/V365__z3_enum_rewrite.sql
-- Rewrite retired solver identifiers before the wire narrows them away.
-- Order is load-bearing: the read path parses these values, so narrowing
-- first would 500 every pre-cutover row. See C7 in
-- docs/superpowers/specs/2026-08-12-release2-prompts/_INDEX.md.
--
-- V365 rather than V363: the in-flight RS001 registration branch holds
-- unmerged V363 and V364. A gap is harmless; a collision is not.
update <table>
   set <col> = jsonb_set(<col>, '{engine}', '"optimized"')
 where <col> ->> 'engine' in ('z3', 'z3+lns');

update <table>
   set <col> = jsonb_set(<col>, '{status}', '"solver_unavailable"')
 where <col> ->> 'status' = 'z3_unavailable';
```

Fill `<table>`/`<col>` from what Step 2 actually found. Then add a migration test asserting a pre-migration row reads back `"optimized"`, and run `db:apply` against a **second** brand-new database to prove the migration applies from scratch.

- [ ] **Step 6: Commit**

```bash
cd "$WT" && git add -A && git commit -m "test(c7): prove whether any stored row carries a retired z3 value"
```

---

## Task C7-2: RED — the schema must reject `"z3"`

**Files:**
- Create: `apps/web/src/server/api-v1/__tests__/z3-contract-retired.test.ts`

**Interfaces:**
- Consumes: `ScheduleSolverInfo`, `AiRepairReport` from `@/server/api-v1/schemas`.
- Produces: the failing-without test C7's acceptance requires.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import northside from "@/demo/ai-templates/northside-open.json";
import { AiRepairReport, ScheduleSolverInfo } from "@/server/api-v1/schemas";

/** C7 (z3 retirement, stage D). `"z3"`, `"z3+lns"` and `"z3_unavailable"`
 *  leave the public contract. Nothing has produced any of them since C4
 *  (`edd358af`) and C9 (`8b85ab39`); `"optimized"` and `"solver_unavailable"`
 *  are the successors, and both already render through byte-identical copy,
 *  so this is a deletion rather than a rewording. */
describe("the public contract has no z3 values left", () => {
  const base = { status: "ok" as const, tiersCompleted: 0, budgetExpired: false, elapsedMs: 1 };

  it.each(["z3", "z3+lns"])("rejects engine %s", (engine) => {
    expect(ScheduleSolverInfo.safeParse({ ...base, engine }).success).toBe(false);
  });

  it("still accepts the two surviving engines", () => {
    for (const engine of ["greedy", "optimized"]) {
      expect(ScheduleSolverInfo.safeParse({ ...base, engine }).success).toBe(true);
    }
  });

  it("rejects the z3_unavailable status", () => {
    expect(
      ScheduleSolverInfo.safeParse({ ...base, engine: "greedy", status: "z3_unavailable" }).success,
    ).toBe(false);
  });

  it("still accepts solver_unavailable, which carries the same copy", () => {
    expect(
      ScheduleSolverInfo.safeParse({ ...base, engine: "greedy", status: "solver_unavailable" })
        .success,
    ).toBe(true);
  });

  it("rejects repair engine z3", () => {
    expect(AiRepairReport.safeParse({ engine: "z3" }).success).toBe(false);
  });

  /** The demo fixture is the stored-artifact analogue of the "pre-migration
   *  row" C7's acceptance asks about: it is the one committed blob that
   *  carries a retired value, and it is parsed by the marketing demo. */
  it("the shipped demo fixture parses under the narrowed contract", () => {
    const repair = (northside as { repair?: unknown }).repair;
    if (repair !== undefined) expect(AiRepairReport.safeParse(repair).success).toBe(true);
    expect(JSON.stringify(northside)).not.toContain('"z3"');
  });
});
```

Fill the `base` object out to whatever `ScheduleSolverInfo` actually requires — read `schemas.ts:1223-1399` and include every non-optional field, or every case fails for the wrong reason.

- [ ] **Step 2: Run it and confirm it fails for the RIGHT reason**

```bash
cd "$WT" && npm test --workspace apps/web -- --reporter=json \
  --outputFile=/tmp/c7-red.json src/server/api-v1/__tests__/z3-contract-retired.test.ts; echo "EXIT=$?"
```

Expected in the JSON: the four rejection cases and the fixture case FAIL; the two "still accepts" cases PASS. If a "still accepts" case fails, `base` is under-populated — fix that before touching `schemas.ts`. A `numTotalTests` of 0 means the path filter matched nothing: `npm test -- <path>` treats positionals as filename filters and a typo reports green.

- [ ] **Step 3: Commit the red**

```bash
cd "$WT" && git add apps/web/src/server/api-v1/__tests__/z3-contract-retired.test.ts
git commit -m "test(c7): RED — the public contract still accepts z3 values"
```

---

## Task C7-3: Narrow the five unions

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts:1229`, `:1248-1285`, `:2592`
- Modify: `packages/engine/src/scheduling/build.ts:~368`, `:574`
- Modify: `apps/web/src/server/usecases/schedule-ai-solver.ts:136`

**Interfaces:**
- Consumes: the red test from C7-2.
- Produces: `ScheduleSolverInfo.engine: "greedy" | "optimized"`, `ScheduleSolverInfo.status` without `"z3_unavailable"`, `AiRepairReport.engine: "none" | "optimized" | "llm"`, `BuildResult["engine"]: "greedy" | "optimized"`, `BuildStatus` without `"z3_unavailable"`, `RepairEngine = "none" | "llm" | "optimized"`.

Order matters *within* this task: the engine union (`build.ts:574`) is the source that `schedule.ts` assigns into `ScheduleSolverInfo` one-for-one, so narrow `build.ts` first and let `tsc` point at every consumer.

- [ ] **Step 1: Narrow the engine side**

```ts
// packages/engine/src/scheduling/build.ts:574
  /** Where the returned board came from. `"optimized"` is the placement
   *  service's board, `"greedy"` every fallback. z3 left this union in C7
   *  (stage D) — nothing had produced it since C4 routed REFLOW through the
   *  service and C9 moved decomposed repair onto CP-SAT. */
  engine: "greedy" | "optimized";
```

Delete `| "z3_unavailable"` from `BuildStatus` (around `:368`) together with its doc comment. Leave `"solver_unavailable"` and its comment; edit that comment where it says "the placement era's `z3_unavailable`" so it no longer names a member that has stopped existing.

- [ ] **Step 2: Narrow the web side**

```ts
// apps/web/src/server/api-v1/schemas.ts:1229
  engine: z.enum(["greedy", "optimized"]),
```

```ts
// apps/web/src/server/api-v1/schemas.ts:2592
  engine: z.enum(["none", "optimized", "llm"]),
```

Delete `"z3_unavailable",` from the `status` enum (`:1253`) and the comment block above `"solver_unavailable"` that defines it by reference to `z3_unavailable`. Delete the stale note at `:2576-2577` claiming `"z3"` stays a valid input value — this PR is what it was waiting for.

```ts
// apps/web/src/server/usecases/schedule-ai-solver.ts:136
export type RepairEngine = "none" | "llm" | "optimized";
```

- [ ] **Step 3: Let the compiler find the rest**

```bash
cd "$WT" && NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck > /tmp/c7-tsc.log 2>&1; echo "EXIT=$?" >> /tmp/c7-tsc.log
tail -40 /tmp/c7-tsc.log
```

Read the `EXIT=` line the command wrote, not the tail's own status. Every error is a consumer that still names a retired value; fix each at its site. Expect hits in `result-strip.tsx`, `schedule-solver-telemetry.test.ts`, `schedule.test.ts`, `build.test.ts`.

- [ ] **Step 4: Run the red test — it must now pass**

```bash
cd "$WT" && npm test --workspace apps/web -- --reporter=json \
  --outputFile=/tmp/c7-green.json src/server/api-v1/__tests__/z3-contract-retired.test.ts; echo "EXIT=$?"
```

Expected: `numFailedTests: 0`, `numPassedTests: 7`. The demo-fixture case will still fail — that is Task C7-4's job. Leave it red and say so in the commit.

- [ ] **Step 5: Commit**

```bash
cd "$WT" && git add -A && git commit -m "feat(c7)!: narrow the solver engine, repair engine and status enums off z3

BREAKING CHANGE: \"z3\", \"z3+lns\" and \"z3_unavailable\" are no longer
accepted or emitted by the v1 API. \"optimized\" and \"solver_unavailable\"
are the successors and render through identical copy in all four locales."
```

---

## Task C7-4: Rewrite the demo fixture

**Files:**
- Modify: `apps/web/src/demo/ai-templates/northside-open.json:7027`

**Interfaces:**
- Consumes: the narrowed `AiRepairReport` from C7-3.
- Produces: a fixture that parses under the narrowed contract.

**Assumption, stated because it departs from the brief.** The brief says "regenerate the demo fixture". Regeneration runs `npm run capture:ai-demo` (`package.json:24` → `apps/web/src/demo/ai-templates/__capture__/capture.test.ts`), which drives a live AI + placement path and re-baselines the *entire* 7000-line fixture nondeterministically. The change owed is **one field**. A full recapture would bury a one-token contract change inside an unreviewable diff — exactly the re-baseline trap this repo has hit before. So: targeted edit, with the capture harness run afterwards **only as a check** that it still produces a fixture that parses. If the reviewer wants a true regeneration, that is a scope call, not a silent one.

- [ ] **Step 1: Make the edit**

```bash
cd "$WT" && git grep -a -n '"engine": "z3"' -- apps/web/src/demo/ai-templates/northside-open.json
```

Change the single hit at `:7027` from `"engine": "z3"` to `"engine": "optimized"`.

- [ ] **Step 2: Prove the fixture is now clean and still parses**

```bash
cd "$WT" && git grep -a -c "z3" -- apps/web/src/demo/ai-templates/northside-open.json; echo "EXIT=$?"
npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/c7-fixture.json \
  src/server/api-v1/__tests__/z3-contract-retired.test.ts \
  src/components/marketing/__tests__/ai-architect-demo.test.tsx \
  src/components/marketing/__tests__/ai-architect-demo-conflicts.test.tsx; echo "EXIT=$?"
```

Expected: the grep exits 1 with no count (no matches), and `numFailedTests: 0` across all three files.

- [ ] **Step 3: Commit**

```bash
cd "$WT" && git add -A && git commit -m "fix(c7): the AI demo fixture records the engine that produced it"
```

---

## Task C7-5: Delete the z3 UI branches and their i18n keys

**Files:**
- Modify: `apps/web/src/components/v2/board/result-strip.tsx:33-40`, `:68`, `:222`, `:229`
- Modify: `apps/web/src/lib/i18n-keys.ts:890-891`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Modify: `apps/web/src/components/v2/board/__tests__/result-strip.test.tsx`, `result-strip-wiring.test.tsx`

**Interfaces:**
- Consumes: the narrowed `ScheduleSolverInfo` type from C7-3.
- Produces: an `ENGINE_KEY` map with exactly two members.

This is a deletion, not a wording change — `board.result.engine.z3` and `board.result.engine.optimized` already carry identical copy in every locale ("Solver" / "Solveur" / "Solucionador" / the NL equivalent), which is the whole reason the rewrite is user-invisible. No new string is introduced, so no translation work is owed; the i18n rule is satisfied by removing the key from **all four** dictionaries, not three.

- [ ] **Step 1: Write the failing assertion first**

Add to `result-strip.test.tsx`:

```tsx
it("has no engine label left for a retired solver value", () => {
  // C7: `z3` and `z3+lns` are not values this component can ever receive
  // again — the schema rejects them at the API boundary.
  expect(Object.keys(ENGINE_KEY)).toEqual(["greedy", "optimized"]);
});
```

Export `ENGINE_KEY` from `result-strip.tsx` if it is not already exported.

- [ ] **Step 2: Run it, confirm it fails**

```bash
cd "$WT" && npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/c7-ui-red.json \
  src/components/v2/board/__tests__/result-strip.test.tsx; echo "EXIT=$?"
```

Expected: FAIL, `Object.keys` returning four members.

- [ ] **Step 3: Delete the branches**

```ts
// apps/web/src/components/v2/board/result-strip.tsx
const ENGINE_KEY = {
  greedy: "board.result.engine.greedy",
  optimized: "board.result.engine.optimized",
} as const;
```

Delete the `case "z3_unavailable":` at `:68` (leaving the `solver_unavailable` case it falls through to, and rewriting the comment at `:69` so it stops explaining a deleted member). Update the comments at `:222` and `:229` that pair `solver_busy` with `z3_unavailable`.

Delete `| "board.result.engine.z3"` and `| "board.result.engine.z3lns"` from `i18n-keys.ts:890-891`, and delete both keys from all four `ui.json` files.

- [ ] **Step 4: Remove the retired-value cases from the sibling tests**

`result-strip.test.tsx:262-270` and `:396` and `result-strip-wiring.test.tsx` assert on `z3_unavailable` and the z3 engine labels. Delete those cases; do not rewrite them to use `solver_unavailable`, which already has its own coverage a few lines away — a duplicated case reads as coverage it is not.

- [ ] **Step 5: Regenerate i18n keys and prove porcelain-clean**

```bash
cd "$WT" && npm run i18n:gen-keys && git status --porcelain; echo "EXIT=$?"
```

Expected: no unstaged modifications beyond what you edited. The i18n drift gate is CI-only, so a dirty tree here is a red PR later.

- [ ] **Step 6: Run it green**

```bash
cd "$WT" && npm test --workspace apps/web -- --reporter=json --outputFile=/tmp/c7-ui-green.json \
  src/components/v2/board src/lib; echo "EXIT=$?"
```

Expected: `numFailedTests: 0`.

- [ ] **Step 7: Commit**

```bash
cd "$WT" && git add -A && git commit -m "feat(c7): drop the z3 engine labels from the board result strip and all four dictionaries"
```

---

## Task C7-6: Regenerate both openapi snapshots

**Files:**
- Modify: `openapi/v1.public.json`, `openapi/v1.json`

**Interfaces:**
- Consumes: the narrowed Zod schemas from C7-3.
- Produces: two snapshots with zero `z3` occurrences.

The brief names only `v1.public.json`. `v1.json` carries the same five occurrences and is generated by the same command; regenerating one and not the other leaves the internal snapshot drifted and the CI gate red.

- [ ] **Step 1: Regenerate**

```bash
cd "$WT" && npm run openapi:gen; echo "EXIT=$?"
```

- [ ] **Step 2: Prove both are clean**

```bash
cd "$WT" && git grep -a -c "z3" -- openapi/v1.public.json openapi/v1.json; echo "EXIT=$?"
```

Expected: no output, exit 1 (grep finds nothing). Anything else means a schema still names a retired value — go back to C7-3, do not hand-edit the snapshot.

- [ ] **Step 3: Prove the tree is porcelain-clean after the gen**

```bash
cd "$WT" && git add -A && git status --porcelain; echo "EXIT=$?"
npm run openapi:gen && git status --porcelain; echo "EXIT=$?"
```

Expected: the second `git status --porcelain` prints nothing — the generator is idempotent against its own output.

- [ ] **Step 4: Commit**

```bash
cd "$WT" && git commit -m "chore(c7): regenerate the v1 openapi snapshots without z3"
```

---

## Task C7-7: The three sites neither brief mentions

**Files:**
- Modify: `scripts/smoke.ts:8936-8937`
- Modify: `scripts/__tests__/z3-retirement-drift.test.ts` (`OWNED_BY_C7`, `:160-171`)

**Interfaces:**
- Consumes: everything narrowed in C7-3 through C7-6.
- Produces: an empty `OWNED_BY_C7` ledger; a smoke assertion that names only live values.

`scripts/smoke.ts:8936-8937` is a **live** `check()` allow-list (`build?.solver?.engine === "z3" || … === "z3+lns"`), not a comment. Left as-is it silently accepts a value the API can no longer emit — a passing assertion that has stopped testing anything.

- [ ] **Step 1: Narrow the smoke allow-list**

Read `scripts/smoke.ts:8930-8945` and remove both z3 disjuncts, leaving the `greedy` / `optimized` arms. If the resulting expression is a single comparison, say so in a comment rather than leaving a one-armed `||`.

- [ ] **Step 2: Empty the C7 ledger**

```ts
// scripts/__tests__/z3-retirement-drift.test.ts:160
/** Owned by stage D: a persisted or public enum VALUE, or something that
 *  renders one. Never a rename — these cross the wire and sit in the DB.
 *
 *  EMPTY as of C7 (2026-08-17): stage D shipped. Every file that was here
 *  now has zero z3 mentions, which the two-directional assertion below
 *  enforces — re-adding one without re-listing it fails, and listing a file
 *  that no longer mentions z3 fails too. */
const OWNED_BY_C7: string[] = [];
```

Then move nothing into `ACCURATE_TODAY` — the ten files should have **no** z3 mentions left. If any still does, that is a site C7 missed; find it rather than re-classifying it.

- [ ] **Step 3: Run the drift gate**

```bash
cd "$WT" && npm test -- --reporter=json --outputFile=/tmp/c7-drift.json \
  scripts/__tests__/z3-retirement-drift.test.ts; echo "EXIT=$?"
```

Expected: `numFailedTests: 0`. This test runs in CI at `ci.yml:429` (the repo-root scripts step), so a red here is a red PR. It fails in **both** directions: an unlisted file that gains a z3 mention, and a listed file that has lost its last one.

- [ ] **Step 4: Commit**

```bash
cd "$WT" && git add -A && git commit -m "chore(c7): shrink the z3 drift ledger and the smoke engine allow-list"
```

---

## Task C7-8: The breaking-change note

**Files:**
- Create: `docs/api-v1-breaking-changes.md`

**Interfaces:**
- Produces: the changelog artefact C7's acceptance requires.

The repo has no CHANGELOG and no API release-note convention — verified 2026-08-17. This creates the first entry rather than burying a breaking change in a PR body alone.

- [ ] **Step 1: Write it**

```markdown
# v1 public API — breaking changes

Newest first. Each entry names the values or shapes that changed, what
replaces them, and what a consumer sees if it sends the old value.

## 2026-08-17 — the `z3` solver leaves the contract

**Removed values.** Three enum members are no longer accepted as input or
emitted in responses:

| Field | Removed | Replacement |
|---|---|---|
| `solver.engine` (auto-schedule) | `"z3"`, `"z3+lns"` | `"optimized"` |
| `solver.status` (auto-schedule) | `"z3_unavailable"` | `"solver_unavailable"` |
| `repair.engine` (AI plan) | `"z3"` | `"optimized"` |

**What a consumer sees.** Sending a removed value now fails schema
validation at the API boundary rather than being accepted and ignored.
Reading is unaffected: nothing has emitted any of the three since the CP-SAT
cutover, so no live response shape changes.

**Why the replacements are drop-in.** `"optimized"` and `"solver_unavailable"`
already render through byte-identical user-facing copy in all four locales —
the labels were unified before this removal, so the change is invisible to
anyone reading the board rather than the JSON.

**Background.** `docs/superpowers/specs/2026-08-12-z3-retirement-design.md`,
stage D. The solver itself is removed in stage E.
```

- [ ] **Step 2: Commit**

```bash
cd "$WT" && git add docs/api-v1-breaking-changes.md
git commit -m "docs(api): record the v1 breaking change that retires the z3 enum values"
```

---

## Task C7-9: Full gates, index entry, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-release2-prompts/_INDEX.md` (status table row for C7, plus a status-log section)

- [ ] **Step 1: Lint, both workspaces**

```bash
cd "$WT" && rtk proxy npm run lint 2>&1 | tail -20; echo "EXIT=$?"
```

Read `✖ N problems`. `rtk` hides lint output entirely and "ESLint output (JSON parse failed)" is the wrapper losing the result, not a clean run. Root lint covers `apps/web` and `packages/engine` (`package.json:18`), but confirm the engine task actually ran.

- [ ] **Step 2: Typecheck**

```bash
cd "$WT" && NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck > /tmp/c7-tsc-final.log 2>&1; echo "EXIT=$?" >> /tmp/c7-tsc-final.log; tail -5 /tmp/c7-tsc-final.log
```

- [ ] **Step 3: Full DB-backed suites, against a brand-new database**

Rebuild the DB — new datadir, `show data_directory` confirmed, `db:apply` + `sync:sports` — then:

```bash
cd "$WT" && PLACEMENT_SERVICE_HOST=<host> npm test --workspace apps/web -- \
  --reporter=json --outputFile=/tmp/c7-full.json src/server src/lib; echo "EXIT=$?"
cd "$WT" && npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/c7-engine.json; echo "EXIT=$?"
cd "$WT" && npm test -- --reporter=json --outputFile=/tmp/c7-scripts.json scripts/__tests__; echo "EXIT=$?"
```

Compare `numPassedTests` / `numFailedTests` against the **base arm from C7-0**, not against a remembered figure. Any delta is yours until proven otherwise; re-run the base arm on the same DB before attributing.

- [ ] **Step 4: Prod-build e2e**

```bash
cd "$WT" && npm run build --workspace apps/web && E2E_PROD_TARGET=<url> npx playwright test; echo "EXIT=$?"
```

Bring the server up per the `seazn-local-env` skill — `standalone` output means `next start` serves the wrong server. Use `localhost`, not `127.0.0.1` (the secure cookie 401s on the latter). Confirm nothing else is squatting :3100 with `lsof -sTCP:LISTEN`.

- [ ] **Step 5: UI screenshots at three widths**

`result-strip.tsx` changed, so the board result strip is verified at **1280**, **320** and **768**, with no horizontal page scroll at any of them. Attach all three to the PR.

- [ ] **Step 6: Grep e2e for the changed text**

```bash
cd "$WT" && git grep -a -n "z3\|Solver, then refined" -- apps/web/e2e scripts/smoke.ts; echo "EXIT=$?"
```

Remaining hits must be comments or the `Z3 `-prefixed seeded test DATA (C8's, not C7's). Any hit that asserts on a label is a broken e2e.

- [ ] **Step 7: Code review before the PR**

Load `superpowers:requesting-code-review`, then run `/code-review`. Fix findings inline unless the blast radius exceeds this file set.

- [ ] **Step 8: Append the `_INDEX.md` entry**

Flip C7's status row to `**PR #NNN open**` and append a status-log section recording, at minimum: the migration verdict from C7-1 and its evidence, the `z3_unavailable` ruling, the `schemas.ts:1016/2190` → `:1229/:2592` drift, the openapi "was 3" → 5 correction, and the three sites neither brief named. This file is the compaction anchor — write it as it happens, not at the end.

- [ ] **Step 9: Open the PR**

Body must contain: base-arm numbers (both runs), final suite numbers raw, the migration verdict, `Unplanned fixes`, the breaking-change note, which of the four test types are deferred and why, and the three screenshots.

```bash
cd "$WT" && git push -u origin feat/c7-z3-public-contract && gh pr create --fill
```

- [ ] **Step 10: PR → green → merge**

See "Merge protocol" below. Do not merge on a partial green.

---

# PHASE C8 — delete the solver (PR 2)

**Gate: C7 merged and its stg deploy green.** Verify with `gh run list --workflow=stg.yml -L 3`, matching `headSha` to C7's merge commit — do not assume.

## Task C8-0: Worktree, baseline, and re-pin

**Files:** none (environment).

- [ ] **Step 1: Fresh worktree off post-C7 main, fresh DB, base arm**

Same procedure as C7-0, branch `feat/c8-z3-delete-solver`, worktree `.claude/worktrees/c8-z3-delete`. New database, `show data_directory` confirmed, base arm measured twice.

- [ ] **Step 2: Re-pin C8's file:line split against today's main**

The C8 brief's own instruction: "Re-verify this file:line split against `main` at the time C8 actually runs; C9 only guarantees it was true the day it landed." As of 2026-08-17 at `252a073d`:

```bash
cd "$WT" && git grep -a -n "repairComponents\|dayCapGuard\|repairDecomposed\b" \
  -- packages/engine/src/scheduling/repair-decompose.ts | head
```

Expected line ranges: `repairComponents()` 280-357, `dayCapGuard()` 358-395, `repairDecomposed()` 396-647, z3 imports 72-78. If they have moved, record the new ranges in the PR body before cutting.

- [ ] **Step 3: Record the pre-deletion z3 footprint**

```bash
cd "$WT" && git grep -a -l -i z3 | wc -l; echo "EXIT=$?"
```

Expected: 216 files as of 2026-08-17 (60 of them `design/**` PNGs where `git grep -a` matches compressed bytes — noise, not references). Paste the number; it is the before-half of C8's acceptance.

---

## Task C8-1: RED — a dependency-graph proof

**Files:**
- Create: `packages/engine/src/scheduling/__tests__/z3-dependency-retired.test.ts`

**Interfaces:**
- Produces: the failing-without proof C8's acceptance requires. It must fail while any import remains.

- [ ] **Step 1: Write the failing test**

```ts
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** C8 (z3 retirement, stage E). The proof that the dependency is gone is a
 *  graph fact, not a grep of prose: a file may legitimately DISCUSS z3
 *  (`repair-decompose-cpsat.ts` reasons about CP-SAT's encoding against
 *  z3's) while importing nothing from it. This asserts on imports and on
 *  the manifests, which is what "unreferenced" actually means. */
describe("the z3 dependency is unreferenced", () => {
  const grep = (args: string[]) => {
    try {
      return execFileSync("git", ["grep", "-a", "-n", ...args], { encoding: "utf8" }).trim();
    } catch {
      return ""; // git grep exits 1 on no matches
    }
  };

  it("no source file imports z3-solver", () => {
    expect(grep(["-E", "from \"z3-solver\"|require\\(\"z3-solver\"\\)"])).toBe("");
  });

  it("no source file imports the WASM loader module", () => {
    expect(grep(["-E", "from \"\\./z3-load\\.ts\"|z3-load"] )).toBe("");
  });

  it("neither manifest declares the dependency", () => {
    expect(grep(["z3-solver", "--", "apps/web/package.json", "packages/engine/package.json"])).toBe("");
  });

  it("next.config carries no z3 WASM plumbing", () => {
    expect(grep(["-i", "z3", "--", "apps/web/next.config.js"])).toBe("");
  });
});
```

- [ ] **Step 2: Run it, confirm all four fail**

```bash
cd "$WT" && npm test --workspace packages/engine -- --reporter=json \
  --outputFile=/tmp/c8-red.json src/scheduling/__tests__/z3-dependency-retired.test.ts; echo "EXIT=$?"
```

Expected: `numFailedTests: 4`. A `numTotalTests` of 0 means the filter matched nothing.

- [ ] **Step 3: Commit the red**

```bash
cd "$WT" && git add -A && git commit -m "test(c8): RED — z3-solver is still imported and still declared"
```

---

## Task C8-2: Cut `repairDecomposed` out of `repair-decompose.ts`

**Files:**
- Modify: `packages/engine/src/scheduling/repair-decompose.ts` (delete `:72-78` z3 imports and `:396-647` `repairDecomposed`)
- Modify: `packages/engine/src/scheduling/repair-decompose.test.ts` (delete `describe("repairDecomposed"…)` at `:160` and `describe("two repairs at once"…)` at `:634`)

**Interfaces:**
- Produces: a `repair-decompose.ts` that still exports `repairComponents`, `dayCapGuard`, `RepairComponent`, `RepairComponentReport`, `ComponentOutcome`, `ComponentSkipReason`, `DecomposedRepairResult`, `DecomposedRepairStatus`, `DecompositionMode`, `DecompositionModeReason`, `MinimalityCertificate`, `MinimalityVerdict`, `MinimalityCaveat` — every one of which `repair-decompose-cpsat.ts` imports at `:134-146`.

**This is the task most likely to over-delete.** The brief's file set, read literally, invites deleting the whole file — which would take C9's own production CP-SAT driver down with it. The file survives; only the z3 driver inside it goes.

- [ ] **Step 1: Write the guard assertion first**

Add to the new `z3-dependency-retired.test.ts`:

```ts
it("C9's CP-SAT driver still has the graph it reuses", async () => {
  const mod = await import("../repair-decompose.ts");
  expect(typeof mod.repairComponents).toBe("function");
  expect(typeof mod.dayCapGuard).toBe("function");
  expect("repairDecomposed" in mod).toBe(false);
});
```

- [ ] **Step 2: Delete the z3 half**

Remove the imports of `repairSchedule`, `RepairVerificationError`, `RepairInput`, `RepairResult` (from `./repair.ts`) and `resetZ3` (from `./z3-load.ts`) at `:72-78`. **Keep** the `:71` import of `disjointConflictBound` / `MinimalityWitness` from `./repair-minimality.ts` — that module never imported z3 and stays untouched in full. Delete `repairDecomposed()` (`:396-647`) and its JSDoc describing the z3 ascending-k mechanism.

- [ ] **Step 3: Delete only the two z3 describe blocks from the test file**

`repair-decompose.test.ts` has describes at `:71`, `:160`, `:278`, `:342`, `:414`, `:562`, `:634`. Only `:160` (`repairDecomposed`) and `:634` (`two repairs at once`) go. The other five exercise `repairComponents`, the gate, the pathological case, the day cap and `disjointConflictBound` — all solver-agnostic, all still live.

- [ ] **Step 4: Prove C9's driver is untouched**

```bash
cd "$WT" && git grep -a -n "repairDecomposedCpsat" | head
git diff --stat origin/main -- packages/engine/src/scheduling/repair-decompose-cpsat.ts; echo "EXIT=$?"
```

Expected: the second command prints **nothing** — this task's diff must not touch that file at all.

- [ ] **Step 5: Run the engine suite**

```bash
cd "$WT" && npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/c8-engine-1.json; echo "EXIT=$?"
```

The engine's coverage gate is part of its CI task and `core` sits at a 100% threshold — a deletion that drops coverage below a threshold reds the build even with every test passing. Read the coverage summary, not only the pass count.

- [ ] **Step 6: Commit**

```bash
cd "$WT" && git add -A && git commit -m "refactor(c8): remove the z3 decomposed-repair driver, keep the component graph"
```

---

## Task C8-3: Delete the solver, the loader, and the vestigial lock

**Files:**
- Delete: `packages/engine/src/scheduling/repair.ts`, `z3-load.ts`, `repair.test.ts`, `z3-load.test.ts`, `z3-handle-release.test.ts`, `z3-serialisation.test.ts`
- Modify: `packages/engine/src/scheduling/build.ts:116`, `:1210`, `:1114`, `:1177`, `:2404`, `build-encode.ts:66`, `index.ts:88`, `:96`
- Modify: the eleven `build-*.test.ts` files importing `resetZ3`

**Interfaces:**
- Produces: an engine with no z3 module and no z3 lock.

Ruling 2 applies here: the `withZ3LockAndReset` wrapper and the `resetZ3` hygiene guards go with the module. `build.ts:2404` already documents the wrapper as vestigial; after this deletion the guards cannot fail whatever happens, which is the same vacuity C6 recorded elsewhere.

- [ ] **Step 1: Delete the four solver files and their tests**

```bash
cd "$WT" && git rm packages/engine/src/scheduling/repair.ts \
  packages/engine/src/scheduling/z3-load.ts \
  packages/engine/src/scheduling/repair.test.ts \
  packages/engine/src/scheduling/z3-load.test.ts \
  packages/engine/src/scheduling/z3-handle-release.test.ts \
  packages/engine/src/scheduling/z3-serialisation.test.ts
```

- [ ] **Step 2: Unwrap the vestigial lock in `build.ts`**

Delete the `:116` import. At `:1210`, replace:

```ts
  return withZ3LockAndReset(() => solveBuild(input)).finally(() => {
```

with:

```ts
  // The z3 process-wide pthread lock went with the solver in C8. `solveBuild`
  // is the placement-service call; it has no process-global state to serialise.
  return solveBuild(input).finally(() => {
```

Then rewrite the comments at `:1114`, `:1177` and `:2404` that explain the lock — do not leave prose describing a mechanism that no longer exists, or C6's drift test will catch it and you will have shipped the same class of defect C6 spent a session removing. Remove `type Z3Context` from `build-encode.ts:66` and the `export *` lines for the deleted modules at `index.ts:88`, `:96`.

- [ ] **Step 3: Strip the eleven hygiene imports**

```bash
cd "$WT" && git grep -a -l "resetZ3" -- packages/engine/src/scheduling
```

For each file, remove the import and the `resetZ3()` call in its `beforeEach`/`afterEach`. Where the hook body becomes empty, delete the hook. Where a comment explains that the guard proves z3 is not called, delete the comment — the fact it asserted is now structural.

- [ ] **Step 4: Typecheck and run the engine suite**

```bash
cd "$WT" && NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck > /tmp/c8-tsc.log 2>&1; echo "EXIT=$?" >> /tmp/c8-tsc.log; tail -30 /tmp/c8-tsc.log
cd "$WT" && npm test --workspace packages/engine -- --reporter=json --outputFile=/tmp/c8-engine-2.json; echo "EXIT=$?"
```

An engine-only diff still breaks `apps/web` tests and `apps/web` typecheck — run both arms, not just the engine's.

- [ ] **Step 5: Commit**

```bash
cd "$WT" && git add -A && git commit -m "refactor(c8): delete the z3 encoder, its WASM loader, and the vestigial lock"
```

---

## Task C8-4: Delete the benches, de-z3 the survivors

**Files:**
- Delete: `packages/engine/scripts/bench-repair.ts`, `packages/engine/scripts/bench-decompose.ts`
- Modify: `packages/engine/scripts/bench-ai-repair-cpsat.ts` (`:142` assigns `"z3"`), `bench-reflow.ts:63`, `probe-lns-gate.ts`, `repair-cpsat-harness.ts:13`
- Modify: `scripts/repro-ai-bracket-frozen-feeder.ts` if it still imports a deleted module

- [ ] **Step 1: Delete the two z3-only benches**

```bash
cd "$WT" && git rm packages/engine/scripts/bench-repair.ts packages/engine/scripts/bench-decompose.ts
```

- [ ] **Step 2: Cut the z3 imports out of the four survivors**

These survive as files but lose their z3 imports with `z3-load.ts`. `bench-ai-repair-cpsat.ts:142` assigns the literal `"z3"` — that is the last such assignment anywhere in the repo, and C7 already narrowed the type it feeds, so this will be a typecheck error rather than a search.

- [ ] **Step 3: Prove each surviving script still parses and runs**

```bash
cd "$WT" && for f in packages/engine/scripts/bench-ai-repair-cpsat.ts \
  packages/engine/scripts/bench-reflow.ts packages/engine/scripts/probe-lns-gate.ts \
  packages/engine/scripts/repair-cpsat-harness.ts scripts/repro-ai-bracket-frozen-feeder.ts; do
  node --experimental-strip-types --check "$f" && echo "OK $f" || echo "BROKEN $f"; done
```

A bench that no longer compiles is a deletion you did not intend to make.

- [ ] **Step 4: Commit**

```bash
cd "$WT" && git add -A && git commit -m "chore(c8): delete the z3-only benches, unhook the four that survive"
```

---

## Task C8-5: The dependency and the WASM pair

**Files:**
- Modify: `apps/web/next.config.js:73`, `:87-92`
- Delete: `apps/web/src/lib/__tests__/z3-tracing-config.test.ts`
- Modify: `apps/web/package.json:58`, `packages/engine/package.json:47`, `pnpm-lock.yaml`
- Modify: `apps/web/src/lib/capacity-input.ts`, `health-input.ts`, `apps/web/src/server/logger.ts`, `packages/engine/src/scheduling/logger.ts`, `solver-test-bounds.ts`, `build-encode.ts`, `build-lns.ts`, `build-objectives.ts`, `apps/web/src/__tests__/toolchain.test.ts` and the remaining `OWNED_BY_C8` test files — whatever z3 prose or identifiers they still carry

**Interfaces:**
- Produces: a repo where `z3-solver` appears in no manifest and no lockfile entry.

**Both halves of the `next.config` pair go.** Removing only one leaves dead config, and this is exactly the change shape that ships a silent prod no-op — which is why Task C8-6's gate is a prod build, not a dev server.

- [ ] **Step 1: Remove the tracing includes and the external package**

```js
// apps/web/next.config.js:73 — before
  serverExternalPackages: ["pdfkit", "exceljs", "z3-solver"],
// after
  serverExternalPackages: ["pdfkit", "exceljs"],
```

Delete the `z3BuildDir` computation and the `outputFileTracingIncludes` entry at `:87-92` that references it. If `z3BuildDir` was the only reason `path` or `import.meta.dirname` was imported at the top of the file, remove those too.

- [ ] **Step 2: Delete the config test that pins the plumbing**

```bash
cd "$WT" && git rm apps/web/src/lib/__tests__/z3-tracing-config.test.ts
```

- [ ] **Step 3: Drop the dependency from both manifests**

```bash
cd "$WT" && pnpm remove z3-solver --filter @seazn/web && pnpm remove z3-solver --filter @seazn/engine
git diff --stat pnpm-lock.yaml; echo "EXIT=$?"
```

Lockfile churn is expected. It must be a **removal**, not a re-resolve of 300 unrelated packages — a fresh `pnpm install` here has upgraded hundreds of packages before. If the lockfile diff is large, inspect it before committing.

- [ ] **Step 4: Sweep the remaining prose and identifiers**

Work through what is left of `OWNED_BY_C8`, file by file. For each hit, decide whether it is a live reference (delete it), accurate history (leave it, and move the file to `ACCURATE_TODAY`), or prose describing a mechanism that no longer exists (rewrite it). Do not batch-rewrite: C6's own finding was that a repo-wide phrase match flags legitimate past-tense uses, and a gate that cannot tell "z3 did this" from "z3 does this" is a nuisance.

- [ ] **Step 5: Rename the two test-DATA prefixes**

`apps/web/e2e/auto-schedule.spec.ts:97` seeds `` name: `Z3 ${label} ${TAG}` `` and `scripts/smoke.ts:8805`/`:8821` seed `` `Z3 Solver ${tag}` `` / `` `Z3 ${n}${tag}` ``. C6 verified nothing asserts on the prefix. Rename to something that names the era rather than the solver (`CPSAT `), and re-run both suites — this is a data change, which is why C6 left it.

- [ ] **Step 6: Empty `OWNED_BY_C8` and reconcile the ledger**

```ts
// scripts/__tests__/z3-retirement-drift.test.ts:176
/** Owned by stage E: the solver, its WASM plumbing, its benches, and the
 *  tests that boot it.
 *
 *  EMPTY as of C8 (2026-08-17): stage E shipped. Files that were deleted are
 *  simply gone; files that survived with accurate past-tense prose moved to
 *  ACCURATE_TODAY below, individually and with a reason. */
const OWNED_BY_C8: string[] = [];
```

An untouched drift test at this point means you deleted less than you think — the brief says so explicitly, and the assertion fails in both directions.

- [ ] **Step 7: Commit**

```bash
cd "$WT" && git add -A && git commit -m "chore(c8)!: remove the z3-solver dependency and both halves of its WASM plumbing"
```

---

## Task C8-6: Prod-build gate and the grep proof

- [ ] **Step 1: The dependency-graph test must now be green**

```bash
cd "$WT" && npm test --workspace packages/engine -- --reporter=json \
  --outputFile=/tmp/c8-green.json src/scheduling/__tests__/z3-dependency-retired.test.ts; echo "EXIT=$?"
```

Expected: `numFailedTests: 0`, `numPassedTests: 5`.

- [ ] **Step 2: The grep proof, pasted not summarised**

```bash
cd "$WT" && git grep -a -i -l z3 | grep -v "^docs/\|^\.claude/\|^design/\|^db/migration/" ; echo "EXIT=$?"
```

Paste the full remaining list into the PR. Everything on it must be justifiable as history or accurate past-tense commentary — the placement service's Python comparative notes and `fly.toml`'s past-tense deploy comment are the expected survivors.

- [ ] **Step 3: Prod build, then the WASM-removal smoke**

```bash
cd "$WT" && npm run build --workspace apps/web; echo "EXIT=$?"
```

Then bring the **standalone** server up per `seazn-local-env` — `next start` serves the wrong server against a standalone build — and run the reflow and AI-loop e2e against it:

```bash
cd "$WT" && E2E_PROD_TARGET=<url> npx playwright test; echo "EXIT=$?"
```

The dev server proves nothing here: removing `serverExternalPackages` and tracing includes is exactly the change that passes in dev and 500s in standalone. If the build output shrinks, note by how much — it is the clearest evidence the WASM actually left the bundle.

- [ ] **Step 4: Full suites against a brand-new database**

Same as C7-9 step 3 — new datadir, `db:apply` + `sync:sports`, `apps/web` + `packages/engine` + `scripts/__tests__`, all numbers from the JSON reporter, compared against the C8-0 base arm.

- [ ] **Step 5: Lint and typecheck**

```bash
cd "$WT" && rtk proxy npm run lint 2>&1 | tail -20; echo "EXIT=$?"
cd "$WT" && NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck > /tmp/c8-tsc-final.log 2>&1; echo "EXIT=$?" >> /tmp/c8-tsc-final.log; tail -5 /tmp/c8-tsc-final.log
```

- [ ] **Step 6: Code review, `_INDEX.md`, PR**

Load `superpowers:requesting-code-review`, run `/code-review`, flip C8's `_INDEX.md` row and append its status-log section (the re-pinned line ranges, the `z3-load.ts` widening ruling and why, the before/after file counts, the build-size delta). Then:

```bash
cd "$WT" && git push -u origin feat/c8-z3-delete-solver && gh pr create --fill
```

PR body: base-arm numbers, final numbers raw, the pasted grep list, the prod-build evidence, `Unplanned fixes`, deferred test types with reasons.

- [ ] **Step 7: PR → green → merge**

See "Merge protocol" below.

---

# Merge protocol — PR → green → merge

Applies identically to both PRs. **No merge on a partial green.**

1. **Push opens the PR. Never merge locally and push to `main`** — smoke CI runs on PRs only, so a local merge skips the gate entirely.
2. **Confirm the runs were actually dispatched.** A PR can have zero runs, which reads as "nothing failing":
   ```bash
   gh pr checks <N> --watch
   gh run list --branch <branch> -L 15 --json name,status,conclusion,event
   ```
   Expected workflows: `ci.yml` (`test`, `security`, `container`, `smoke-db`, `smoke-e2e`), `e2e.yml` (three shards of `parallel`, `serial`, and the seven-width `mobile/tablet` job), `placement-ci.yml`, `build-guard.yml`. A `needs:` that points across differently-triggered runs is vacuous — check each job's own conclusion, not just the aggregate.
3. **Green means every job concluded `success`.** `skipped` on a job you expected to run is a red flag, not a pass. If the seven-width mobile job did not run, the parallel phase failed earlier and the mobile specs never executed at all.
4. **A red is triaged, not re-run.** Load `superpowers:systematic-debugging`. Before attributing it to your change, re-run the same command on `origin/main` with the same DB and services — several reds in this programme have turned out to be main's, and one is intermittent at 1-in-3.
5. **Squash-merge to `main`** once green:
   ```bash
   gh pr merge <N> --squash --delete-branch
   ```
6. **Watch the stg deploy.** Merging to `main` triggers `stg.yml`. Confirm it concluded `success` on the merge SHA before starting the next phase — C8's gate is "C7 merged **and deployed**":
   ```bash
   gh run list --workflow=stg.yml -L 3 --json displayTitle,conclusion,headSha
   ```
7. **Then, and only then, remove the worktree.**
   ```bash
   git worktree remove .claude/worktrees/<name>
   ```
   Never `git stash` inside a worktree — the stash stack is shared with the main checkout, and a no-op push/pop pops a foreign stash and leaves `package.json` unmerged.

---

# Status-check protocol — every 40 minutes

Starts at **execution kickoff** (the moment Task C7-0 Step 1 runs), not before. Runs until C8 merges.

Set up with `/loop 40m` and this prompt:

```
Status check. Do all four, in order:

1. RULES REMINDER — re-read
   docs/superpowers/specs/2026-08-12-release2-prompts/_RULES.md and restate,
   in three lines, the rules that bear on the step currently in progress.
   Not a citation — name the specific constraint you are under right now.
2. POSITION — which plan task and step, from
   docs/superpowers/plans/2026-08-17-c7-c8-z3-retirement-plan.md. Name the
   last verification command that actually ran and its raw numbers
   (numPassedTests/numTotalTests from JSON, never a terminal summary).
3. CI — if a PR is open: `gh pr checks <N>` and `gh run list --branch
   <branch> -L 15`. Name any job that is not `success`, and any expected job
   that was never dispatched.
4. BLOCKERS — anything waiting on a decision, plus any brief premise found
   false since the last check. If nothing changed, say so in one line.
```

Two standing checks to fold into every tick, because both have cost this repo hours:

- **Confirm the shell cwd is still the worktree.** `pwd` at the top of any verify command. A run launched from a worktree can silently execute on `main` and return a false green.
- **Confirm the database is still yours.** `show data_directory`. A `pg_ctl` that failed "Address already in use" is followed by a `createdb` that succeeds against someone else's server.

---

# Open risks

| Risk | Which task holds it | If it fires |
|---|---|---|
| C7-1 finds a JSONB path that *does* store `"z3"` | C7-1 | The migration is written as V365 and the rewrite-then-narrow order becomes mandatory again. Adds a fresh-DB migration test and a second brand-new database to C7-9. |
| RS001 merges first and takes V365 | C7-1 | Renumber before pushing. A renumber *after* a stg deploy has applied the file is not a rename — it re-runs. Check `db/migration/deltas` against `origin/main` immediately before opening the PR. |
| Deleting `resetZ3` guards drops engine coverage under a threshold | C8-3 | `core` sits at a 100% line threshold; deleting covered lines can move the global figure either way. Read the coverage summary, not the pass count, and re-baseline deliberately if it moves — never silently. |
| The prod build still works but the WASM never left | C8-6 | Compare `.next` output size before and after, and grep the standalone output for z3 artefacts. A green dev server proves nothing about standalone tracing. |
| `repair-decompose.ts` over-deleted | C8-2 | `git diff --stat origin/main -- repair-decompose-cpsat.ts` must be empty. If C9's driver appears in the diff, the cut went too deep — revert the file and redo the cut by line range. |
| A z3 mention reappears in an unlisted file | both | The drift test fails in both directions and runs in CI at `ci.yml:429`. Treat its red as correct until proven otherwise. |
