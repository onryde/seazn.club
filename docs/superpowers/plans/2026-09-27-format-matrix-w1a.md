# Format × Sport Matrix — W1a (L3 core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lean L3 harness under `scripts/matrix/`. It drives the real product over HTTP as an organiser, scores every fixture with engine-verified event streams for all 11 sports, checks pure anti-vacuous invariants, writes one JSON result per case, and renders `MATRIX.md` from that JSON alone. It is proven live on a 24-case vertical slice: {league, knockout, swiss} × {generic, badminton} × {LIFECYCLE, M1 walkover, R4 withdrawal, F1 odd field}.

**Architecture:** The pieces are:
- **Catalogue.** A frozen catalogue (21 rows × 11 sports) builds stage bodies through the product's own `buildTemplateStages`.
- **Driver.** An `OrganiserDriver` interface with one implementation, `HttpDriver`. It sits over the bench's `raw` HTTP helper and handles expected-seq, one SEQ_CONFLICT retry, org pinning and a never-repeat-complete guard.
- **Streams.** A generator per sport kernel produces the events that reach a requested outcome. Each stream is folded in-process through the real `@seazn/engine` module before it is posted, and again in a DB-free sweep over every variant × stage kind × outcome.
- **Scenarios.** Scenarios turn driver calls into an `ObservedRun`.
- **Invariants.** Pure `import type`-only invariants turn an `ObservedRun` into `{verdict, checked, evidence}`, and zero checked is a failure (R25).
- **State and output.** `decideState` folds checks into one of seven states. A zod-checked `results.json` is written, and `render-matrix.ts` renders `MATRIX.md` from it.
- **Org and plan.** Orgs and plans are seeded by SQL in the harness's own DB, guarded by a mandatory data-directory check. There is one magic-link sign-in per run.

**Tech Stack:** Node 26 `--experimental-strip-types` (no enums, namespaces or parameter properties; `.ts` import suffixes; no tsx), TypeScript 7 via `tsconfig.scripts.json`, vitest 4 via `packages/engine`'s binary, zod, postgres.js, the bench helpers `scripts/bench/lib/{http,plan,env}.ts`, and `@seazn/engine` subpaths.

**Spec:** `docs/superpowers/specs/2026-09-27-format-matrix-design.md` (§2 states, §3 matrix, §6 drivers/isolation, §7.3 invariants, §7.3a anti-vacuity, §8 W1a row, §9 bench reuse) plus `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_RULES.md` R1–R29 and `_INDEX.md` rulings 1–21. Where the spec and this plan disagree, the "False premises found while planning" section says which one the tree supports.

---

## Step 0 — anchors (re-pinned 2026-09-27 against `c427e972d` on `docs/format-matrix-programme`)

| Fact | Where |
|---|---|
| `buildTemplateStages` falls back SILENTLY to `STAGE_TEMPLATES[0]` (league) on an unknown key | `apps/web/src/lib/format-templates.ts:333-341` |
| format-templates.ts's only import is `import type { TakeRule }`, so it is strip-types loadable | `format-templates.ts:40` |
| Builder knob defaults are 4 / 5 / 2 / 1, carry defaults to `"none"`, and the template defaults to `"league"` | `apps/web/src/components/v2/division-builder.tsx:288-293` |
| `PREFERRED_VARIANT` + `pickVariant` (otherwise the first listed) | `division-builder.tsx:56-67` |
| Variant list order is `order by is_system desc, name` | `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/new/page.tsx:50-54` |
| Builder POST = `buildTemplateStages(...clampKnob...)` → `applyStandingsCarry` → `{...s, seq:i+1}` | `division-builder.tsx:383-392, 441-446` |
| `foldMatchWithStoppage(module,cfg,lineups,events,opts)` | `packages/engine/src/core/events.ts:518` |
| `builtinModules` (the column order of the offered matrix) | `packages/engine/src/sports/index.ts:23-35` |
| `SportModule.variants / configSchema / supportsDraws / standingsDelta / eventSchemas?` | `packages/engine/src/sport/module.ts:693-850` |
| Bench `raw`, `newSession`, `signIn` | `scripts/bench/lib/http.ts:15-79` |
| `provisionPlan`, `createRealPlanSql().{sql,dispose}`, `planCandidateInfo` | `scripts/bench/lib/plan.ts:151, 506-539, 601-640` |
| `runPreflight`, `createRealPreflightProbes().{probes,dispose}`. The data-dir check runs ONLY when `BENCH_EXPECTED_DATA_DIR` is set | `scripts/bench/lib/env.ts:195, 370-452` |
| Pattern: fold with `{strictFromSeq:1}` and empty-slot lineups | `scripts/bench/lib/validate-pack.ts:451-525` (mirror it; never import it) |
| `createOrgForUser` does 3 inserts in one tx | `apps/web/src/lib/auth.ts` |
| `getUserOrgs` cache-aside; `cacheGet` returns null without a Redis client | `apps/web/src/lib/auth.ts:161-175`, `apps/web/src/lib/cache.ts:40-49` |
| Division `config`/`variant_key` PATCH → 409 `FORMAT_LOCKED` once any fixture exists; the entrants-only save is the one exception | `apps/web/src/server/usecases/divisions.ts:792-833` |
| `finalRanks` = ordered entrant-id array, from `events[0].type==="stage_completed"` | `apps/web/src/server/engine-db/competition.ts:606-618`; `scripts/bench/lib/advance.ts:284-300` |
| CI precedent: "Bench lib unit tests (DB-free)" | `.github/workflows/ci.yml:193-195` |

The executor re-pins every line above before building on it (AGENTS class 5). A moved line is a note in the task report, not a blocker.

---

## Global Constraints

- **Worktree.** Everything happens in `/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a` on branch `feat/format-matrix-w1a`, created in Task 1 Step 0 from `docs/format-matrix-programme`. **Every shell command starts `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && …`**, because cwd resets to the main checkout between calls. Never edit the main checkout. Never `git stash`. No heredocs: write commit messages with the editor tool into `$TMPDIR/fm-msg.txt` and run `git commit -F "$TMPDIR/fm-msg.txt" -- <paths>`. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit only your own paths. Do not push until Task 10.
- **pnpm, never npm.** The fresh worktree has no `node_modules`, so run `pnpm install --frozen-lockfile` first (Task 1 Step 0). Never symlink main's `node_modules`.
- **Local verification = ONLY the exact changed/added test files** (owner rule, restated nine times, latest 2026-09-24). **No `tsc`, no `eslint`, no directory runs, no `seazn-env gate`.** CI's `typecheck` (which includes `tsconfig.scripts.json`) and lint cover the rest once Task 10 pushes. The strip-types loadable test (Task 1) is the local stand-in for "does it even load".
- **Vitest is judged only by JSON** (R19; AGENTS verification traps). The template, with `<N>` = task number and `<files>` = the exact test paths:
  ```bash
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && rm -f "$TMPDIR/fm-t<N>.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/fm-t<N>.json" --testTimeout=30000 <files>; echo EXIT=$?
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && node -e 'const r=JSON.parse(require("fs").readFileSync(process.env.TMPDIR+"/fm-t<N>.json","utf8"));console.log(JSON.stringify({total:r.numTotalTests,passed:r.numPassedTests,failed:r.numFailedTests,failedSuites:r.numFailedTestSuites,files:r.testResults.map(t=>t.name)}))'
  ```
  Green means `failed == 0`, `failedSuites == 0`, `passed == total > 0`, and every `files[]` entry begins with `/Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a/scripts/matrix/`. Positionals are literal substring filters, so a typo runs a subset and reports green; always read `files[]`. Paste the JSON line into the task report.
- **Strip-types rules** (`scripts/bench/lib/__tests__/strip-types-loadable.test.ts` explains why):
  - No `enum`, `namespace` or constructor parameter properties. Error subclasses assign fields in the constructor body.
  - Every relative import carries `.ts`. Engine imports use subpaths (`@seazn/engine/core|sport|sports`).
- **Boundary** (R3, ruling 17). Direct imports from `scripts/bench/lib/` are limited to `http.ts`, `plan.ts` and `env.ts`. From `apps/web` the only import is `apps/web/src/lib/format-templates.ts`. Never `run-suite.ts`, `pack-schema.ts`, `seed.ts`, `seed-plan.ts`, `validate-pack.ts` or `scripts/smoke.ts`. `lib/invariants.ts` and `lib/observed.ts` use `import type` only. This is enforced by `__tests__/boundary.test.ts` (Task 1).
- **Anti-vacuity** (R13, R25; design §7.3a). Every invariant and every scenario assertion returns `checked`. Zero checked with a would-be pass is a **failure**. A case whose every check abstained is ❌, never ✅. Every rule set's tests state the empty case FIRST.
- **Expected values are derived, never typed** (R9, AGENTS class 19):
  - Draw reachability comes from `module.supportsDraws`.
  - Points come from `module.standingsDelta` over the folded stream.
  - Variants come from `module.variants`.
  - Builder defaults come from text-pinned constants.
  - Include at least one case where the right answer differs from the wrong answer's constant (the three canaries; F1's floor vs ceil).
- **Seams are proven through the real producer and consumer** (R15, class 1). Streams fold through the real engine module. The builder's own `buildTemplateStages` output is POSTed. Product outcomes are compared with the in-process fold (`life-fold-parity`). Public standings are compared with org standings.
- **Mutation** (R17, class 3). Each task's final test step lists `mutant → killing test`. Apply each mutant by hand, run the named test file, see it red, then revert. Report the list with each kill, not a count.
- **Public repo** (R14a). Only synthetic orgs, people and emails (`delivered+matrix-<runId>@resend.dev`, "Matrix Player N"). Every error message and all evidence pass through `redact()`. `writeResults` refuses to write if `findSecrets()` matches. Never print `DATABASE_URL`, cookies or magic links.
- **Live runs** (Task 11 only) follow the `seazn-local-env` skill. The run needs a fresh DB with `sync:sports` (R14). `SMOKE_BASE` must be `http://localhost:<port>`, never 127.0.0.1. `BENCH_EXPECTED_DATA_DIR` must be set and equal to `show data_directory`.
- **Do NOT touch:** `packages/engine/**`, `apps/web/**` (read-only: a product red is a FINDING recorded in `_INDEX.md`, never fixed in W1a), `scripts/bench/**` (R3), `.github/workflows/e2e.yml`, any scheduled workflow. Do not add fast-check, Stryker, `forEachSport` or shadow invariants; those belong to W1b, W1d and W10 (ruling 21, design §7.5).

### The four test types, as they apply to a harness

| Type | Meaning here |
|---|---|
| **Unit** | vitest on the task's exact test files, DB-free, judged by JSON. |
| **E2E** | The harness driving the REAL product over HTTP through `HttpDriver` (a real server, DB and engine), which happens only in Task 11. A DB-free task names the Task 11 check that exercises its code live. |
| **Smoke** | Task 1's strip-types loadable test (every shipped module actually loads under `node --experimental-strip-types`), Task 4/9's CLI spawn tests, and Task 11's one-case live smoke (`--only 'league|generic' --scenario LIFECYCLE`). |
| **Regression** | The task's mutation list, plus the committed-MATRIX drift test (Task 11) and the CI step (Task 10) that re-runs every `scripts/matrix` test on each PR. |

## Review Focus

These are the inputs the spec implies but does not test, and the ones most likely to bite first. Each one's test lives in the owning task.

1. **A vacuous ✅.** A case where every check abstained, or where an invariant saw zero pairs/rows/fixtures, renders green. Expected: ❌ with the reason "vacuous". → Task 4 (`decideState` all-abstain and zero-checked tests) and Task 5 (a zero-count test per invariant, killed by mutating the central guard).
2. **A misspelled template key silently builds a league.** `buildTemplateStages("swis", …)` returns the league template, so the whole row reads ✅ while testing the wrong format. Expected: `UnknownRow`. → Task 1 (`stagesForRow("swis")` throws, and every `TEMPLATE_ROW_KEYS` entry exists in `STAGE_TEMPLATES` and builds its own kind).
3. **The DB guard is skipped when `BENCH_EXPECTED_DATA_DIR` is unset.** The bench preflight then accepts any DB on a non-5432 port, including another session's. Expected: refusal before any SQL. → Task 7 (`requireOwnDataDir` unset/empty tests; run.ts calls it before preflight, Task 9 order test).
4. **Cross-case org contamination.** A failed `POST /api/orgs/active` (or a stale user-orgs cache) leaves case N's competition in case N-1's org, so entitlements and public slugs belong to the wrong case. Expected: the case fails loudly. → Task 7 (`switchToCaseOrg` verifies the listing) and Task 6 (`createCompetition` refuses an `org_id` ≠ `expectedOrgId`).
5. **A stale `expected_seq` after a server-side cascade.** A withdrawal walkover or a swiss bye appends events the harness did not post. Expected: `postStream` reads `last_seq` from `/state` first and retries a SEQ_CONFLICT exactly once from `current_seq` with a fresh idempotency key. → Task 6 (a fake transport whose state says `last_seq: 2`; a conflict-then-success case; a double conflict surfaces `RefusedCall`).

## File Structure

| Path | Create/Modify | Task | Responsibility |
|---|---|---|---|
| `scripts/matrix/lib/catalogue.ts` | Create | 1 | 21 frozen rows, `SPORT_KEYS`, builder defaults, `stagesForRow`, `UnknownRow`, `RowBuildDeferred` |
| `scripts/matrix/__tests__/catalogue.test.ts` | Create | 1 | row list, unknown key, builder-parity text pins |
| `scripts/matrix/__tests__/boundary.test.ts` | Create | 1 | import boundary (bench/apps-web allow-list, type-only invariants) |
| `scripts/matrix/__tests__/strip-types-loadable.test.ts` | Create | 1 | every shipped module loads under strip-types |
| `scripts/matrix/lib/sport-cfg.ts` | Create | 2 | `sportModule`, `resolveSportCfg`, `drawsAllowed`, `entrantKindFor` |
| `scripts/matrix/lib/fold.ts` | Create | 2 | `envelopes`, `lineupsFor`, `foldStream`, `declaredPoints` |
| `scripts/matrix/lib/streams/types.ts` | Create | 2 | request/outcome types, errors, `ALL_OUTCOMES`, `START` |
| `scripts/matrix/lib/streams/generic.ts` | Create | 2 | generic generator |
| `scripts/matrix/lib/streams/index.ts` | Create | 2 (3 extends) | `STREAM_GENERATORS`, `generateStream`, `matchesRequest` |
| `scripts/matrix/__tests__/fold.test.ts` | Create | 2 | cfg resolution, fold, declared points, generic streams |
| `scripts/matrix/lib/streams/{setbased,tennis,period,football,cricket,boardgame,carrom}.ts` | Create | 3 | the other ten sports |
| `scripts/matrix/lib/streams/known-unsupported.ts` | Create | 3 | committed list of generator gaps (R11) |
| `scripts/matrix/__tests__/streams.test.ts` | Create | 3 | sweep: every sport × variant × stage kind × outcome |
| `scripts/matrix/lib/redact.ts` | Create | 4 | `redact`, `findSecrets` |
| `scripts/matrix/lib/results.ts` | Create | 4 | states, glyphs, zod schema, `decideState`, `writeResults`, `parseResults` |
| `scripts/matrix/lib/render-matrix.ts` | Create | 4 | `renderMatrix`, `worstState` |
| `scripts/matrix/render.ts` | Create | 4 | CLI: JSON → MATRIX.md |
| `scripts/matrix/__tests__/results.test.ts`, `render-matrix.test.ts`, `render-cli.test.ts` | Create | 4 | |
| `scripts/matrix/lib/observed.ts` | Create | 5 | `ObservedRun` & friends, `toObservedOutcome`, `winnerOf`, `sameResult` |
| `scripts/matrix/lib/invariants.ts` | Create | 5 | I1–I6, `evaluateInvariant(s)` |
| `scripts/matrix/__tests__/invariants.test.ts` | Create | 5 | positive/negative/abstain/zero ×6 |
| `scripts/matrix/lib/driver/types.ts` | Create | 6 | `OrganiserDriver`, wire types, `RefusedCall`, `DriverMisuse`, `OrgMismatch` |
| `scripts/matrix/lib/driver/http-driver.ts` | Create | 6 | `HttpDriver` |
| `scripts/matrix/__tests__/http-driver.test.ts` | Create | 6 | fake-transport tests |
| `scripts/matrix/lib/seed-org.ts` | Create | 7 | `MatrixSql`, `requireOwnDataDir`, `chooseTopPublicPlan`, `switchToCaseOrg`, `prepareCaseOrg`, `createRealMatrixSql` |
| `scripts/matrix/__tests__/seed-org.test.ts` | Create | 7 | |
| `scripts/matrix/lib/scenarios/{types,common,assertions,lifecycle,m1-walkover,r4-withdrawal,f1-odd-field,index}.ts` | Create | 8 | scenarios |
| `scripts/matrix/__tests__/fake-driver.ts` | Create | 8 | in-memory league driver (test helper) |
| `scripts/matrix/__tests__/scenarios.test.ts` | Create | 8 | |
| `scripts/matrix/lib/slice.ts` | Create | 9 | `planSliceCases`, `CANARY_CHECK` |
| `scripts/matrix/run.ts` | Create | 9 | CLI runner |
| `scripts/matrix/__tests__/slice.test.ts`, `run-cli.test.ts` | Create | 9 | |
| `.github/workflows/ci.yml` | Modify (after :195) | 10 | DB-free matrix step |
| `package.json` | Modify | 10 | `matrix:l3`, `matrix:render` |
| `.gitignore` | Modify | 10 | `matrix-report/` |
| `scripts/matrix/__tests__/ci-wiring.test.ts` | Create | 10 | pins the CI step and scripts |
| `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1a-slice/{results.json,MATRIX.md}` | Create | 11 | committed evidence |
| `scripts/matrix/__tests__/committed-matrix.test.ts` | Create | 11 | drift: committed MATRIX.md == render(committed JSON) |
| `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md` | Modify | 11 | session status, findings |

---

### Task 1: Worktree, frozen catalogue, boundary and loadable guards

**Files:**
- Create: `scripts/matrix/lib/catalogue.ts`
- Create: `scripts/matrix/__tests__/catalogue.test.ts`
- Create: `scripts/matrix/__tests__/boundary.test.ts`
- Create: `scripts/matrix/__tests__/strip-types-loadable.test.ts`

**Interfaces:**
- Consumes: `STAGE_TEMPLATES`, `buildTemplateStages`, `clampKnob`, `applyStandingsCarry`, `StageDraft`, `TemplateKnobs` from `apps/web/src/lib/format-templates.ts`; `builtinModules` from `@seazn/engine/sports`.
- Produces (every later task uses these names exactly):
  ```ts
  export const TEMPLATE_ROW_KEYS: readonly ["league","triple_rr","league_ko","groups_ko","group_stepladder","group_playoffs","swiss","swiss_playoff","swiss_knockout","knockout","ko_plate","qualifying_main","double_elim","americano","mexicano","ladder"];
  export const API_ONLY_ROWS: readonly ["group_only","group_group_ko","knockout_third_place","page_playoff_only","stepladder_only"];
  export type TemplateRowKey; export type ApiOnlyRowKey; export type RowKey = TemplateRowKey | ApiOnlyRowKey;
  export const ROW_KEYS: readonly RowKey[];            // 21, offered-matrix order
  export const SPORT_KEYS: readonly string[];           // builtinModules order (11)
  export function cellId(row: RowKey, sport: string): string;   // "row|sport"
  export const BUILDER_DEFAULT_KNOBS: Readonly<TemplateKnobs>;  // {qualified:4, swissRounds:5, poolCount:2, legs:1}
  export const BUILDER_PREFERRED_VARIANT: Readonly<Record<string,string>>;
  export function builderDefaultVariant(sport: string, variantsInBuilderOrder: readonly string[]): string;
  export interface StagePostBody extends StageDraft { seq: number }
  export function stagesForRow(row: string, knobs?: TemplateKnobs): StagePostBody[];
  export class UnknownRow extends Error { readonly row: string }
  export class RowBuildDeferred extends Error { readonly row: string; readonly wave: string }
  ```

- [ ] **Step 0: Create the worktree and install**

```bash
cd /Users/ashokhein/github/seazn.club && git worktree add .claude/worktrees/format-matrix-w1a -b feat/format-matrix-w1a docs/format-matrix-programme
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git log --oneline -1 && pnpm install --frozen-lockfile
```
Expected: HEAD is the tip of `docs/format-matrix-programme`, and the install completes. Re-pin the Step 0 anchor table by opening each file. A moved line goes in the task report.

- [ ] **Step 1: Write the failing catalogue test** at `scripts/matrix/__tests__/catalogue.test.ts`

```ts
// The frozen row list (design §3, R11). Empty case first (R13): the catalogue
// must never be empty, and a key the product does not know must never quietly
// become a league (buildTemplateStages' silent fallback, format-templates.ts:334).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAGE_TEMPLATES } from "../../../apps/web/src/lib/format-templates.ts";
import { builtinModules } from "@seazn/engine/sports";
import {
  API_ONLY_ROWS, BUILDER_DEFAULT_KNOBS, BUILDER_PREFERRED_VARIANT, ROW_KEYS, RowBuildDeferred,
  SPORT_KEYS, TEMPLATE_ROW_KEYS, UnknownRow, builderDefaultVariant, cellId, stagesForRow,
} from "../lib/catalogue.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUILDER = readFileSync(resolve(REPO, "apps/web/src/components/v2/division-builder.tsx"), "utf8");

describe("catalogue — empty case first", () => {
  it("is never empty: 16 template rows + 5 API-only rows, 11 sports", () => {
    expect(TEMPLATE_ROW_KEYS.length).toBe(16);
    expect(API_ONLY_ROWS.length).toBe(5);
    expect(ROW_KEYS.length).toBe(21);
    expect(new Set(ROW_KEYS).size).toBe(21);
    expect(SPORT_KEYS.length).toBe(11);
  });
});

describe("catalogue — rows", () => {
  it("every template row exists in the product's STAGE_TEMPLATES, and nothing there is missing from the catalogue", () => {
    const product = STAGE_TEMPLATES.map((t) => t.key).sort();
    expect([...TEMPLATE_ROW_KEYS].sort()).toEqual(product);
  });

  it("a misspelled key throws UnknownRow instead of building a league (Review Focus 2)", () => {
    expect(() => stagesForRow("swis")).toThrow(UnknownRow);
    expect(() => stagesForRow("")).toThrow(UnknownRow);
  });

  it("API-only rows are a named refusal routed to W1b, not a build", () => {
    for (const row of API_ONLY_ROWS) {
      let caught: unknown;
      try { stagesForRow(row); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(RowBuildDeferred);
      expect((caught as RowBuildDeferred).wave).toBe("W1b");
    }
  });

  it("each single-kind row builds its OWN kind — the answer differs from the league fallback", () => {
    expect(stagesForRow("swiss").map((s) => s.kind)).toEqual(["swiss"]);
    expect(stagesForRow("knockout").map((s) => s.kind)).toEqual(["knockout"]);
    expect(stagesForRow("league").map((s) => s.kind)).toEqual(["league"]);
  });

  it("stamps seq 1..n and the builder's knob defaults (swiss rounds, legs)", () => {
    const ko = stagesForRow("league_ko");
    expect(ko.map((s) => s.seq)).toEqual([1, 2]);
    expect(stagesForRow("swiss")[0]!.config.rounds).toBe(BUILDER_DEFAULT_KNOBS.swissRounds);
    // buildTemplateStages overwrites legs with the knob (format-templates.ts:340):
    // triple_rr through the builder defaults is legs 1, not 3 — recorded as a
    // false premise, pinned here so a product change is seen.
    expect(stagesForRow("triple_rr")[0]!.config.legs).toBe(BUILDER_DEFAULT_KNOBS.legs);
  });

  it("clamps qualified and poolCount exactly like the builder", () => {
    const low = stagesForRow("groups_ko", { ...BUILDER_DEFAULT_KNOBS, qualified: 0, poolCount: 0 });
    expect(low[0]!.config.pools).toEqual({ count: 2 });
  });

  it("cellId is row|sport", () => { expect(cellId("league", "generic")).toBe("league|generic"); });
});

describe("catalogue — builder parity (text pins; a builder change reds here)", () => {
  it("knob defaults match division-builder.tsx's useState literals", () => {
    const pick = (name: string) => Number(new RegExp(`const \\[${name}, set\\w+\\] = useState\\((\\d+)\\)`).exec(BUILDER)?.[1]);
    expect({ qualified: pick("qualified"), swissRounds: pick("swissRounds"), poolCount: pick("poolCount"), legs: pick("legs") })
      .toEqual(BUILDER_DEFAULT_KNOBS);
  });

  it("the standings carry defaults to 'none' (what stagesForRow applies)", () => {
    expect(BUILDER).toMatch(/useState<StandingsCarry>\("none"\)/);
  });

  it("PREFERRED_VARIANT matches the builder's literal", () => {
    const block = /const PREFERRED_VARIANT: Record<string, string> = \{([^}]*)\}/.exec(BUILDER)?.[1] ?? "";
    const parsed = Object.fromEntries([...block.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
    expect(parsed).toEqual(BUILDER_PREFERRED_VARIANT);
  });

  it("builderDefaultVariant: preferred when offered, else the first in builder order; empty refuses", () => {
    expect(() => builderDefaultVariant("generic", [])).toThrow(/no system variants/);
    expect(builderDefaultVariant("cricket", ["hundred", "odi", "t20", "test"])).toBe("t20");
    expect(builderDefaultVariant("generic", ["score", "win_loss"])).toBe("score");
    expect(builderDefaultVariant("cricket", ["hundred", "odi"])).toBe("hundred");
  });

  it("every preferred variant is a declared engine variant", () => {
    for (const [sport, variant] of Object.entries(BUILDER_PREFERRED_VARIANT)) {
      const m = builtinModules.find((x) => x.key === sport);
      expect(m, sport).toBeDefined();
      expect(Object.keys(m!.variants)).toContain(variant);
    }
  });
});
```

- [ ] **Step 2: Run it and see it RED** (the module is missing, so the suite fails to collect).

Use the Global Constraints template with `<N>`=1a and `<files>`=`scripts/matrix/__tests__/catalogue.test.ts`. Expected: `failedSuites: 1`.

- [ ] **Step 3: Implement `scripts/matrix/lib/catalogue.ts`**

```ts
// The frozen row list of the format × sport matrix (design §3; R11 — changing
// it is a reviewed diff, never a runtime draw). Rows are the 16 builder
// templates in offered-matrix order, then the 5 API-only shapes. Columns are
// the engine's own registry order (builtinModules), which is the order the
// offered matrix was written in.
//
// Stage bodies are built by the PRODUCT's buildTemplateStages (R15: the
// builder's own output goes through the real API), with the builder's clamp,
// carry and seq steps restated (division-builder.tsx:383-392, 441-446).
import { builtinModules } from "@seazn/engine/sports";
import {
  STAGE_TEMPLATES,
  applyStandingsCarry,
  buildTemplateStages,
  clampKnob,
  type StageDraft,
  type TemplateKnobs,
} from "../../../apps/web/src/lib/format-templates.ts";

export const TEMPLATE_ROW_KEYS = [
  "league", "triple_rr", "league_ko", "groups_ko", "group_stepladder", "group_playoffs",
  "swiss", "swiss_playoff", "swiss_knockout", "knockout", "ko_plate", "qualifying_main",
  "double_elim", "americano", "mexicano", "ladder",
] as const;

export const API_ONLY_ROWS = [
  "group_only", "group_group_ko", "knockout_third_place", "page_playoff_only", "stepladder_only",
] as const;

export type TemplateRowKey = (typeof TEMPLATE_ROW_KEYS)[number];
export type ApiOnlyRowKey = (typeof API_ONLY_ROWS)[number];
export type RowKey = TemplateRowKey | ApiOnlyRowKey;

export const ROW_KEYS: readonly RowKey[] = [...TEMPLATE_ROW_KEYS, ...API_ONLY_ROWS];

export const SPORT_KEYS: readonly string[] = builtinModules.map((m) => m.key);

export function cellId(row: RowKey, sport: string): string {
  return `${row}|${sport}`;
}

/** division-builder.tsx:289-292 — pinned by catalogue.test.ts. */
export const BUILDER_DEFAULT_KNOBS: Readonly<TemplateKnobs> = Object.freeze({
  qualified: 4,
  swissRounds: 5,
  poolCount: 2,
  legs: 1,
});

/** division-builder.tsx:56-61 — pinned by catalogue.test.ts. */
export const BUILDER_PREFERRED_VARIANT: Readonly<Record<string, string>> = Object.freeze({
  cricket: "t20",
  tennis: "tour",
  icehockey: "iihf",
  hockey: "fih-outdoor",
});

/** pickVariant (division-builder.tsx:63-67): the preferred key when the DB offers
 *  it, else the first listed. The list order is a DB fact
 *  (`order by is_system desc, name`, d/new/page.tsx:50-54), so the caller passes it. */
export function builderDefaultVariant(sport: string, variantsInBuilderOrder: readonly string[]): string {
  const first = variantsInBuilderOrder[0];
  if (first === undefined) throw new Error(`catalogue: sport '${sport}' has no system variants`);
  const preferred = BUILDER_PREFERRED_VARIANT[sport.toLowerCase()];
  if (preferred !== undefined && variantsInBuilderOrder.includes(preferred)) return preferred;
  return first;
}

export class UnknownRow extends Error {
  readonly row: string;
  constructor(row: string) {
    super(`catalogue: unknown row '${row}' — refusing to let buildTemplateStages fall back to league`);
    this.name = "UnknownRow";
    this.row = row;
  }
}

export class RowBuildDeferred extends Error {
  readonly row: string;
  readonly wave: string;
  constructor(row: string, wave: string) {
    super(`catalogue: row '${row}' is API-only; its stage bodies are built in ${wave}`);
    this.name = "RowBuildDeferred";
    this.row = row;
    this.wave = wave;
  }
}

export interface StagePostBody extends StageDraft {
  seq: number;
}

export function stagesForRow(row: string, knobs: TemplateKnobs = BUILDER_DEFAULT_KNOBS): StagePostBody[] {
  if ((API_ONLY_ROWS as readonly string[]).includes(row)) throw new RowBuildDeferred(row, "W1b");
  if (!(TEMPLATE_ROW_KEYS as readonly string[]).includes(row)) throw new UnknownRow(row);
  // The catalogue could name a key the product has since dropped; the product
  // would then silently build a league. Refuse instead.
  if (!STAGE_TEMPLATES.some((t) => t.key === row)) throw new UnknownRow(row);
  const clamped: TemplateKnobs = {
    ...knobs,
    qualified: clampKnob(knobs.qualified, 2, 32),
    poolCount: clampKnob(knobs.poolCount, 2, 8),
  };
  return applyStandingsCarry(buildTemplateStages(row, clamped), "none").map((s, i) => ({ ...s, seq: i + 1 }));
}
```

- [ ] **Step 4: Write the boundary test** at `scripts/matrix/__tests__/boundary.test.ts`

```ts
// R3 / ruling 17 as a gate, not a convention: the harness imports only the
// bench's small helpers, only one apps/web file, and the invariant layer is
// type-only so W1b's fast-check model and W10's shadow checks can reuse it.
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(MATRIX, "..", "..");
const ALLOWED_BENCH = new Set(["http.ts", "plan.ts", "env.ts"]);
const ALLOWED_WEB = new Set(["apps/web/src/lib/format-templates.ts"]);
const FORBIDDEN = ["run-suite", "pack-schema", "seed.ts", "seed-plan", "validate-pack", "scripts/smoke"];
const TYPE_ONLY = new Set(["lib/invariants.ts", "lib/observed.ts"]);

function shipped(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__") shipped(full, out); continue; }
    if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const SPEC = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file: string): { spec: string; typeOnly: boolean }[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(SPEC)].map((m) => ({ spec: (m[3] ?? m[4])!, typeOnly: m[2] !== undefined }));
}

const MODULES = shipped(MATRIX).sort();

describe("scripts/matrix import boundary", () => {
  it("discovery guard: the walker finds the shipped modules (an empty set would pass vacuously)", () => {
    expect(MODULES.length).toBeGreaterThan(0);
    expect(MODULES.some((f) => f.endsWith("lib/catalogue.ts"))).toBe(true);
  });

  it.each(MODULES.map((f) => [relative(MATRIX, f), f]))("%s imports only allowed modules", (_rel, file) => {
    for (const { spec } of importsOf(file)) {
      expect(FORBIDDEN.some((bad) => spec.includes(bad)), `${spec}`).toBe(false);
      if (!spec.startsWith(".")) continue;
      const target = relative(REPO, resolve(dirname(file), spec));
      if (target.startsWith("scripts/bench/")) expect(ALLOWED_BENCH.has(basename(target)), target).toBe(true);
      if (target.startsWith("apps/web/")) expect(ALLOWED_WEB.has(target), target).toBe(true);
    }
  });

  it("invariants.ts and observed.ts import types only (reusable by W1b fast-check and W10 shadow checks)", () => {
    for (const rel of TYPE_ONLY) {
      const file = join(MATRIX, rel);
      if (!MODULES.includes(file)) continue; // lands in Task 5; this test then bites
      for (const imp of importsOf(file)) expect(imp.typeOnly, `${rel}: ${imp.spec}`).toBe(true);
    }
  });
});
```

- [ ] **Step 5: Write the loadable test** at `scripts/matrix/__tests__/strip-types-loadable.test.ts`. It copies the bench's pattern (`scripts/bench/lib/__tests__/strip-types-loadable.test.ts`), including its header comment explaining why a spawned import is the only honest check.

```ts
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function shipped(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") shipped(full, out); continue; }
    if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const MODULES = shipped(MATRIX).sort();

describe("every shipped scripts/matrix module loads under --experimental-strip-types", () => {
  it("discovery guard: at least the catalogue is found", () => {
    expect(MODULES.some((f) => f.endsWith("lib/catalogue.ts"))).toBe(true);
  });

  it.each(MODULES)("%s", (file) => {
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(file).href)});`],
      { cwd: resolve(MATRIX, "..", ".."), encoding: "utf8", timeout: 25_000 },
    );
    expect(r.stderr, file).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|ERR_MODULE_NOT_FOUND/);
    expect(r.status, `${file}\n${r.stderr}`).toBe(0);
  });
});
```
Note: `run.ts` and `render.ts` (Tasks 4/9) guard their `main()` behind an entry check, so importing them runs nothing.

- [ ] **Step 6: Run all three files and see GREEN.** Use the template with `<N>`=1 and `<files>`=`scripts/matrix/__tests__/catalogue.test.ts scripts/matrix/__tests__/boundary.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts`. Expected: `failed 0`, and three files in `files[]`, all under the w1a worktree.

- [ ] **Step 7: Mutation (apply each by hand, run the named file, see RED, revert)**
  - Delete the `TEMPLATE_ROW_KEYS.includes` guard in `stagesForRow` → catalogue.test "misspelled key throws UnknownRow" goes red: it returns a league instead.
  - Change `BUILDER_DEFAULT_KNOBS.swissRounds` to 3 → "knob defaults match division-builder.tsx".
  - Pass `"points"` instead of `"none"` to `applyStandingsCarry` → not killed by an assertion on single-stage rows. Add `expect(stagesForRow("league_ko")[1]!.progression!.carry).toBeUndefined()` to the "stamps seq" test, then re-run and see it red.
  - Add `import "../../bench/lib/seed.ts";` to catalogue.ts → the boundary test goes red.
  - Add `enum X { A }` to catalogue.ts → the loadable test goes red (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).

- [ ] **Step 8: Commit**

Write `$TMPDIR/fm-msg.txt`:
```
feat(matrix): W1a catalogue — 21 frozen rows built through the product's own template builder

Adds scripts/matrix/lib/catalogue.ts. It refuses an unknown row instead of
letting buildTemplateStages fall back to league, and routes the five API-only
rows to W1b with a named refusal. It also adds boundary and strip-types load
gates for scripts/matrix.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git add scripts/matrix/lib/catalogue.ts scripts/matrix/__tests__/catalogue.test.ts scripts/matrix/__tests__/boundary.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts && git commit -F "$TMPDIR/fm-msg.txt" -- scripts/matrix
```

**Test types:**
- Unit: the three files above.
- E2E: Task 11. Every case POSTs `stagesForRow`'s output to `POST /divisions/:id/stages`, and a 400 there is a ❌ with the refusal code.
- Smoke: the loadable test.
- Regression: the Step 7 mutants, plus the CI step in Task 10.

---

### Task 2: Sport config, in-process fold, stream contract, and the generic generator

**Files:**
- Create: `scripts/matrix/lib/sport-cfg.ts`, `scripts/matrix/lib/fold.ts`
- Create: `scripts/matrix/lib/streams/types.ts`, `scripts/matrix/lib/streams/generic.ts`, `scripts/matrix/lib/streams/index.ts`
- Create: `scripts/matrix/__tests__/fold.test.ts`

**Interfaces:**
- Consumes: `builtinModules` (`@seazn/engine/sports`); `AnySportModule`, `effectiveEntrantModel` (`@seazn/engine/sport`); `foldMatchWithStoppage`, `EventEnvelope`, `LineupPair`, `MatchOutcome`, `StageCtx`, `StageKind` (`@seazn/engine/core`).
- Produces:
  ```ts
  // sport-cfg.ts
  export class UnknownSport extends Error { readonly sportKey: string }
  export class UnknownVariant extends Error { readonly sportKey: string; readonly variantKey: string; readonly declared: string[] }
  export class CfgInvalid extends Error { readonly detail: string }
  export function sportModule(sportKey: string): AnySportModule;
  export function variantKeys(sportKey: string): string[];                       // Object.keys(module.variants), declaration order
  export function resolveSportCfg(sportKey: string, variantKey: string, overrides?: Record<string, unknown>): unknown;
  export function drawsAllowed(sportKey: string, cfg: unknown, stageKind: StageKind): boolean;
  export function entrantKindFor(sportKey: string, cfg: unknown): "individual" | "pair" | "team";
  // fold.ts
  export const FOLD_OPTIONS: { readonly strictFromSeq: 1 };
  export const OFFLINE_RECORDED_AT: string;
  export function envelopes(fixtureId: string, events: readonly StreamEvent[]): EventEnvelope[];
  export function lineupsFor(home: string, away: string): LineupPair;
  export interface FoldedStream { readonly outcome: MatchOutcome | null; readonly state: unknown }
  export function foldStream(module: AnySportModule, cfg: unknown, home: string, away: string, events: readonly StreamEvent[]): FoldedStream;
  export interface DeclaredPoints { readonly home: number; readonly away: number; readonly forOutcome: MatchOutcome }
  export function declaredPoints(module: AnySportModule, cfg: unknown, ctx: StageCtx, home: string, away: string, events: readonly StreamEvent[]): DeclaredPoints | null;
  // streams/types.ts
  export type Side = "home" | "away";
  export type RequestedOutcome =
    | { readonly kind: "win"; readonly winner: Side }
    | { readonly kind: "draw" }
    | { readonly kind: "forfeit"; readonly by: Side; readonly reason: "walkover" | "retired hurt" }
    | { readonly kind: "abandon" };
  export type DecidedOutcome = Extract<RequestedOutcome, { kind: "win" | "draw" }>;
  export const ALL_OUTCOMES: readonly RequestedOutcome[];   // 6: win-home, win-away, draw, forfeit-away-walkover, forfeit-home-retired, abandon
  export function outcomeLabel(o: RequestedOutcome): string;
  export interface StreamEvent { readonly type: string; readonly payload: unknown }
  export interface StreamRequest { readonly sportKey: string; readonly cfg: unknown; readonly stageKind: StageKind; readonly home: string; readonly away: string; readonly outcome: RequestedOutcome }
  export interface DecidedRequest extends StreamRequest { readonly outcome: DecidedOutcome }
  export interface SportStreamGenerator { readonly sportKeys: readonly string[]; decided(req: DecidedRequest): StreamEvent[] }
  export const START: StreamEvent;                          // core.start {}
  export function idOf(req: StreamRequest, side: Side): string;
  export class OutcomeUnreachable extends Error { readonly sportKey: string; readonly label: string }
  export class GeneratorUnsupported extends Error { readonly sportKey: string; readonly label: string }
  // streams/index.ts
  export const STREAM_GENERATORS: Readonly<Record<string, SportStreamGenerator>>;
  export function generateStream(req: StreamRequest): StreamEvent[];
  export type RequestMatch = "match" | "mismatch" | "unasserted";
  export function matchesRequest(req: StreamRequest, outcome: MatchOutcome | null): RequestMatch;
  ```

- [ ] **Step 1: Write the failing test** at `scripts/matrix/__tests__/fold.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import {
  CfgInvalid, UnknownSport, UnknownVariant, drawsAllowed, entrantKindFor, resolveSportCfg, sportModule, variantKeys,
} from "../lib/sport-cfg.ts";
import { FOLD_OPTIONS, declaredPoints, envelopes, foldStream, lineupsFor } from "../lib/fold.ts";
import { ALL_OUTCOMES, OutcomeUnreachable, START, outcomeLabel, type StreamRequest } from "../lib/streams/types.ts";
import { generateStream, matchesRequest } from "../lib/streams/index.ts";

const H = "H";
const A = "A";
const req = (variant: string, outcome: StreamRequest["outcome"], stageKind: StreamRequest["stageKind"] = "league"): StreamRequest => ({
  sportKey: "generic", cfg: resolveSportCfg("generic", variant), stageKind, home: H, away: A, outcome,
});

describe("sport-cfg — empty/unknown first", () => {
  it("refuses an unknown sport and an unknown variant with the declared list", () => {
    expect(() => sportModule("")).toThrow(UnknownSport);
    expect(() => resolveSportCfg("generic", "nope")).toThrow(UnknownVariant);
    try { resolveSportCfg("generic", "nope"); } catch (e) { expect((e as UnknownVariant).declared).toEqual(variantKeys("generic")); }
  });

  it("refuses a cfg the module's schema rejects (mirrors createDivision's 422 CONFIG_INVALID)", () => {
    expect(() => resolveSportCfg("badminton", "bwf", { bestOf: 2 })).toThrow(CfgInvalid);
  });

  it("variant keys come from the module in declaration order, never an empty list", () => {
    for (const m of builtinModules) expect(variantKeys(m.key).length, m.key).toBeGreaterThan(0);
  });
});

describe("sport-cfg — derived from declarations", () => {
  it("drawsAllowed is the module's supportsDraws, and differs across generic variants and stage kinds", () => {
    const score = resolveSportCfg("generic", "score");
    const winLoss = resolveSportCfg("generic", "win_loss");
    expect(drawsAllowed("generic", score, "league")).toBe(sportModule("generic").supportsDraws(score as never, "league"));
    expect(drawsAllowed("generic", score, "league")).toBe(true);
    expect(drawsAllowed("generic", winLoss, "league")).toBe(false);
    expect(drawsAllowed("generic", score, "knockout")).toBe(false);
  });

  it("entrantKindFor reads the effective entrant model", () => {
    expect(["individual", "pair"]).toContain(entrantKindFor("badminton", resolveSportCfg("badminton", "bwf")));
  });
});

describe("fold", () => {
  it("envelopes number seq from 1 and fold strict from seq 1", () => {
    const env = envelopes("f1", [START, { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } }]);
    expect(env.map((e) => e.seq)).toEqual([1, 2]);
    expect(FOLD_OPTIONS.strictFromSeq).toBe(1);
    expect(lineupsFor(H, A)).toEqual({ home: { entrantId: H, slots: [] }, away: { entrantId: A, slots: [] } });
  });

  it("an empty stream folds to no outcome (empty case) and declares no points", () => {
    const m = sportModule("generic");
    const cfg = resolveSportCfg("generic", "score");
    expect(foldStream(m, cfg, H, A, []).outcome).toBeNull();
    expect(declaredPoints(m, cfg, { kind: "league" }, H, A, [])).toBeNull();
  });

  it("a strict fold throws on an invalid event instead of returning a plausible state", () => {
    const m = sportModule("generic");
    const winLoss = resolveSportCfg("generic", "win_loss");
    // The draw the score variant would accept: refused where supportsDraws says false.
    expect(() => foldStream(m, winLoss, H, A, [START, { type: "generic.result", payload: { isDraw: true } }])).toThrow();
  });

  it("declaredPoints delegates to standingsDelta: a win gives the winner more, a draw gives equal points", () => {
    const m = sportModule("generic");
    const cfg = resolveSportCfg("generic", "score");
    const win = declaredPoints(m, cfg, { kind: "league" }, H, A, generateStream(req("score", { kind: "win", winner: "away" })))!;
    expect(win.away).toBeGreaterThan(win.home);
    expect(win.forOutcome).toMatchObject({ kind: "win", winner: A });
    const draw = declaredPoints(m, cfg, { kind: "league" }, H, A, generateStream(req("score", { kind: "draw" })))!;
    expect(draw.home).toBe(draw.away);
  });
});

describe("generic streams + matchesRequest", () => {
  it.each(ALL_OUTCOMES.map((o) => [outcomeLabel(o), o] as const))("score variant, league: %s folds to what was asked", (_l, o) => {
    const r = req("score", o);
    const folded = foldStream(sportModule("generic"), r.cfg, H, A, generateStream(r));
    expect(matchesRequest(r, folded.outcome)).toBe(o.kind === "abandon" ? "unasserted" : "match");
  });

  it("a draw where supportsDraws is false is OutcomeUnreachable, not a stream", () => {
    expect(() => generateStream(req("score", { kind: "draw" }, "knockout"))).toThrow(OutcomeUnreachable);
    expect(() => generateStream(req("win_loss", { kind: "draw" }))).toThrow(OutcomeUnreachable);
  });

  it("matchesRequest says mismatch when the wrong side won (the right answer differs from the wrong one)", () => {
    const r = req("score", { kind: "win", winner: "home" });
    expect(matchesRequest(r, { kind: "win", winner: A, loser: H })).toBe("mismatch");
    expect(matchesRequest(r, null)).toBe("mismatch");
    const f = req("score", { kind: "forfeit", by: "away", reason: "walkover" });
    expect(matchesRequest(f, { kind: "award", winner: H })).toBe("match");
    expect(matchesRequest(f, { kind: "award", winner: A })).toBe("mismatch");
    expect(matchesRequest(req("score", { kind: "draw" }), { kind: "tie" })).toBe("mismatch");
  });

  it("an unregistered sport is GeneratorUnsupported, never an empty stream", () => {
    expect(() => generateStream({ ...req("score", { kind: "win", winner: "home" }), sportKey: "curling" })).toThrow(/no generator/);
  });
});
```

- [ ] **Step 2: Run it and see RED** (template, `<N>`=2a, `<files>`=`scripts/matrix/__tests__/fold.test.ts`). Expected: the suite fails to collect.

- [ ] **Step 3: Implement `scripts/matrix/lib/sport-cfg.ts`**

```ts
// Sport configuration resolved exactly as createDivision does it: the variant
// preset merged under the overrides, parsed by the module's own configSchema
// (divisions.ts createDivision; mirrors validate-pack.ts resolveDivisionCfg,
// which this harness may not import — ruling 17).
import type { StageKind } from "@seazn/engine/core";
import { effectiveEntrantModel, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";

export class UnknownSport extends Error {
  readonly sportKey: string;
  constructor(sportKey: string) {
    super(`sport-cfg: unknown sport '${sportKey}'`);
    this.name = "UnknownSport";
    this.sportKey = sportKey;
  }
}

export class UnknownVariant extends Error {
  readonly sportKey: string;
  readonly variantKey: string;
  readonly declared: string[];
  constructor(sportKey: string, variantKey: string, declared: string[]) {
    super(`sport-cfg: unknown variant '${variantKey}' for ${sportKey} (declared: ${declared.join(", ")})`);
    this.name = "UnknownVariant";
    this.sportKey = sportKey;
    this.variantKey = variantKey;
    this.declared = declared;
  }
}

export class CfgInvalid extends Error {
  readonly detail: string;
  constructor(sportKey: string, variantKey: string, detail: string) {
    super(`sport-cfg: ${sportKey}/${variantKey} config invalid — ${detail}`);
    this.name = "CfgInvalid";
    this.detail = detail;
  }
}

export function sportModule(sportKey: string): AnySportModule {
  const m = builtinModules.find((x) => x.key === sportKey);
  if (m === undefined) throw new UnknownSport(sportKey);
  return m;
}

export function variantKeys(sportKey: string): string[] {
  return Object.keys(sportModule(sportKey).variants as Record<string, unknown>);
}

export function resolveSportCfg(sportKey: string, variantKey: string, overrides: Record<string, unknown> = {}): unknown {
  const m = sportModule(sportKey);
  const variants = m.variants as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(variants, variantKey)) {
    throw new UnknownVariant(sportKey, variantKey, Object.keys(variants));
  }
  const parsed = m.configSchema.safeParse({ ...(variants[variantKey] as object), ...overrides });
  if (!parsed.success) {
    throw new CfgInvalid(
      sportKey,
      variantKey,
      parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

/** The ONLY source of "may this fixture end level" (R9): the module's declaration. */
export function drawsAllowed(sportKey: string, cfg: unknown, stageKind: StageKind): boolean {
  return sportModule(sportKey).supportsDraws(cfg as never, stageKind);
}

export function entrantKindFor(sportKey: string, cfg: unknown): "individual" | "pair" | "team" {
  return effectiveEntrantModel(sportModule(sportKey).entrantModel ?? null, cfg).defaultKind;
}
```

- [ ] **Step 4: Implement `scripts/matrix/lib/fold.ts`**

```ts
// The in-process fold every generated stream goes through before it is posted
// (R15: the real engine module is the consumer). Mirrors the three parity facts
// of validate-pack.ts:451-525 — seq from 1, strict from seq 1, empty-slot
// lineups (loadLineupPair returns slots:[] for a fixture with no lineup rows).
import {
  foldMatchWithStoppage,
  type EventEnvelope,
  type LineupPair,
  type MatchOutcome,
  type StageCtx,
} from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import type { StreamEvent } from "./streams/types.ts";

export const FOLD_OPTIONS = { strictFromSeq: 1 } as const;
export const OFFLINE_RECORDED_AT = "2030-01-01T00:00:00.000Z";

export function envelopes(fixtureId: string, events: readonly StreamEvent[]): EventEnvelope[] {
  return events.map((ev, i) => ({
    id: String(i + 1),
    fixtureId,
    seq: i + 1,
    type: ev.type,
    payload: ev.payload,
    recordedAt: OFFLINE_RECORDED_AT,
    recordedBy: null,
  }));
}

export function lineupsFor(home: string, away: string): LineupPair {
  return { home: { entrantId: home, slots: [] }, away: { entrantId: away, slots: [] } };
}

export interface FoldedStream {
  readonly outcome: MatchOutcome | null;
  readonly state: unknown;
}

export function foldStream(
  module: AnySportModule,
  cfg: unknown,
  home: string,
  away: string,
  events: readonly StreamEvent[],
): FoldedStream {
  const { state } = foldMatchWithStoppage(module, cfg as never, lineupsFor(home, away), envelopes("matrix", events), FOLD_OPTIONS);
  return { outcome: module.outcome(state as never), state };
}

export interface DeclaredPoints {
  readonly home: number;
  readonly away: number;
  readonly forOutcome: MatchOutcome;
}

/** What the sport DECLARES this stream is worth in the table: standingsDelta
 *  over the folded state. Null while undecided. Invariant I3 compares the
 *  product's table with Σ of these (R9: derived, never typed). */
export function declaredPoints(
  module: AnySportModule,
  cfg: unknown,
  ctx: StageCtx,
  home: string,
  away: string,
  events: readonly StreamEvent[],
): DeclaredPoints | null {
  const folded = foldStream(module, cfg, home, away, events);
  if (folded.outcome === null) return null;
  const [h, a] = module.standingsDelta(folded.outcome, cfg as never, ctx, folded.state as never);
  return { home: h.points, away: a.points, forOutcome: folded.outcome };
}
```

- [ ] **Step 5: Implement `scripts/matrix/lib/streams/types.ts`**

```ts
import type { StageKind } from "@seazn/engine/core";

export type Side = "home" | "away";

export type RequestedOutcome =
  | { readonly kind: "win"; readonly winner: Side }
  | { readonly kind: "draw" }
  | { readonly kind: "forfeit"; readonly by: Side; readonly reason: "walkover" | "retired hurt" }
  | { readonly kind: "abandon" };

export type DecidedOutcome = Extract<RequestedOutcome, { kind: "win" | "draw" }>;

export const ALL_OUTCOMES: readonly RequestedOutcome[] = Object.freeze([
  { kind: "win", winner: "home" },
  { kind: "win", winner: "away" },
  { kind: "draw" },
  { kind: "forfeit", by: "away", reason: "walkover" },
  { kind: "forfeit", by: "home", reason: "retired hurt" },
  { kind: "abandon" },
]);

export function outcomeLabel(o: RequestedOutcome): string {
  switch (o.kind) {
    case "win": return `win-${o.winner}`;
    case "draw": return "draw";
    case "forfeit": return `forfeit-${o.by}-${o.reason === "walkover" ? "walkover" : "retired"}`;
    case "abandon": return "abandon";
  }
}

export interface StreamEvent {
  readonly type: string;
  readonly payload: unknown;
}

export interface StreamRequest {
  readonly sportKey: string;
  readonly cfg: unknown;
  readonly stageKind: StageKind;
  readonly home: string;
  readonly away: string;
  readonly outcome: RequestedOutcome;
}

export interface DecidedRequest extends StreamRequest {
  readonly outcome: DecidedOutcome;
}

export interface SportStreamGenerator {
  readonly sportKeys: readonly string[];
  decided(req: DecidedRequest): StreamEvent[];
}

/** Always first: boardgame refuses a forfeit outside `live`, and every kernel but
 *  generic needs it (plan-facts-sports.md "Harness cautions"). */
export const START: StreamEvent = Object.freeze({ type: "core.start", payload: {} });

export function idOf(req: StreamRequest, side: Side): string {
  return side === "home" ? req.home : req.away;
}

/** The module declares this outcome impossible here (supportsDraws false). */
export class OutcomeUnreachable extends Error {
  readonly sportKey: string;
  readonly label: string;
  constructor(sportKey: string, label: string, why: string) {
    super(`streams: ${sportKey} cannot reach '${label}' — ${why}`);
    this.name = "OutcomeUnreachable";
    this.sportKey = sportKey;
    this.label = label;
  }
}

/** Reachable per the module, but this generator does not build it yet. Every
 *  instance is listed in known-unsupported.ts (Task 3) with the wave that owns it. */
export class GeneratorUnsupported extends Error {
  readonly sportKey: string;
  readonly label: string;
  constructor(sportKey: string, label: string, why: string) {
    super(`streams: ${sportKey} generator does not build '${label}' — ${why}`);
    this.name = "GeneratorUnsupported";
    this.sportKey = sportKey;
    this.label = label;
  }
}
```

- [ ] **Step 6: Implement `scripts/matrix/lib/streams/generic.ts`**

```ts
// generic: generic.result, accepted in `pre` or `live` (generic.ts:540-548).
// p1Score = HOME, p2Score = AWAY (generic.ts:107-160).
import { GeneratorUnsupported, START, idOf, outcomeLabel, type SportStreamGenerator } from "./types.ts";

export const genericGenerator: SportStreamGenerator = {
  sportKeys: ["generic"],
  decided(req) {
    const mode = (req.cfg as { resultMode?: unknown }).resultMode;
    if (mode !== "score" && mode !== "win_loss") {
      throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), `resultMode '${String(mode)}'`);
    }
    if (req.outcome.kind === "draw") {
      return [START, { type: "generic.result", payload: mode === "score" ? { p1Score: 2, p2Score: 2 } : { isDraw: true } }];
    }
    const homeWins = req.outcome.winner === "home";
    return [
      START,
      {
        type: "generic.result",
        payload: mode === "score"
          ? { p1Score: homeWins ? 3 : 1, p2Score: homeWins ? 1 : 3 }
          : { winnerId: idOf(req, req.outcome.winner) },
      },
    ];
  },
};
```

- [ ] **Step 7: Implement `scripts/matrix/lib/streams/index.ts`.** Task 3 adds the other generators to `STREAM_GENERATORS`.

```ts
// One registry, one entry point. Forfeit and abandon are UNIVERSAL core events
// (core/forfeit-reason.test.ts pins forfeit for all 11 modules), so they are
// composed here; a sport generator only builds a win or a draw.
import type { MatchOutcome } from "@seazn/engine/core";
import { drawsAllowed } from "../sport-cfg.ts";
import { genericGenerator } from "./generic.ts";
import {
  GeneratorUnsupported,
  OutcomeUnreachable,
  START,
  idOf,
  outcomeLabel,
  type DecidedRequest,
  type SportStreamGenerator,
  type StreamEvent,
  type StreamRequest,
} from "./types.ts";

function register(...gens: SportStreamGenerator[]): Readonly<Record<string, SportStreamGenerator>> {
  const out: Record<string, SportStreamGenerator> = {};
  for (const g of gens) for (const k of g.sportKeys) out[k] = g;
  return Object.freeze(out);
}

export const STREAM_GENERATORS = register(genericGenerator);

export function generateStream(req: StreamRequest): StreamEvent[] {
  const label = outcomeLabel(req.outcome);
  const gen = STREAM_GENERATORS[req.sportKey];
  if (gen === undefined) throw new GeneratorUnsupported(req.sportKey, label, "no generator registered");
  const o = req.outcome;
  if (o.kind === "forfeit") {
    return [START, { type: "core.forfeit", payload: { by: idOf(req, o.by), reason: o.reason } }];
  }
  if (o.kind === "abandon") return [START, { type: "core.abandon", payload: { reason: "matrix: abandoned" } }];
  if (o.kind === "draw" && !drawsAllowed(req.sportKey, req.cfg, req.stageKind)) {
    throw new OutcomeUnreachable(req.sportKey, label, `supportsDraws(cfg, '${req.stageKind}') is false`);
  }
  return gen.decided(req as DecidedRequest);
}

export type RequestMatch = "match" | "mismatch" | "unasserted";

/** Did the folded outcome equal the requested one? Abandon is RECORDED, not
 *  asserted (its per-sport meaning is W2's rulebook, design §8). */
export function matchesRequest(req: StreamRequest, outcome: MatchOutcome | null): RequestMatch {
  const o = req.outcome;
  if (o.kind === "abandon") return "unasserted";
  if (outcome === null) return "mismatch";
  if (o.kind === "draw") return outcome.kind === "draw" ? "match" : "mismatch";
  if (o.kind === "win") return outcome.kind === "win" && outcome.winner === idOf(req, o.winner) ? "match" : "mismatch";
  const beneficiary = idOf(req, o.by === "home" ? "away" : "home");
  return (outcome.kind === "award" || outcome.kind === "win") && outcome.winner === beneficiary ? "match" : "mismatch";
}
```

- [ ] **Step 8: Run and see GREEN** (template, `<N>`=2, `<files>`=`scripts/matrix/__tests__/fold.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts scripts/matrix/__tests__/boundary.test.ts`). Expected: `failed 0`. The loadable test now spawns six more modules.

- [ ] **Step 9: Mutation**
  - Remove the `drawsAllowed` guard in `generateStream` → fold.test "a draw where supportsDraws is false is OutcomeUnreachable" goes red.
  - `matchesRequest`: return `"match"` for any `win` kind (drop the winner comparison) → "mismatch when the wrong side won".
  - `declaredPoints`: swap `h`/`a` → "a win gives the winner more".
  - `FOLD_OPTIONS = {}` (tolerant fold) → "a strict fold throws on an invalid event". **If it stays green**, the strict/tolerant distinction does not govern that refusal. Record that in the report and keep the test, which still guards the draw refusal.
  - `resolveSportCfg`: skip `safeParse` and return the merge → "refuses a cfg the module's schema rejects".

- [ ] **Step 10: Commit** (the message names the files and says "in-process fold + generic generator"; trailer as in Global Constraints)

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git add scripts/matrix/lib/sport-cfg.ts scripts/matrix/lib/fold.ts scripts/matrix/lib/streams scripts/matrix/__tests__/fold.test.ts && git commit -F "$TMPDIR/fm-msg.txt" -- scripts/matrix
```

**Test types:**
- Unit: `fold.test.ts`.
- E2E: Task 11's `life-fold-parity` compares this fold with the product's outcome for every posted fixture.
- Smoke: loadable.
- Regression: the Step 9 mutants.

---

### Task 3: Stream generators for the other ten sports, and the full fold sweep

**Files:**
- Create: `scripts/matrix/lib/streams/{setbased,tennis,period,football,cricket,boardgame,carrom}.ts`
- Create: `scripts/matrix/lib/streams/known-unsupported.ts`
- Modify: `scripts/matrix/lib/streams/index.ts` (register the seven new generators)
- Create: `scripts/matrix/__tests__/streams.test.ts`

**Interfaces:**
- Consumes: Task 2's `types.ts`, `fold.ts`, `sport-cfg.ts`.
- Produces: `setbasedGenerator` (badminton, tabletennis, volleyball), `tennisGenerator`, `periodGenerator` (hockey, icehockey), `footballGenerator`, `cricketGenerator`, `boardgameGenerator`, `carromGenerator`; `export function periodLabels(count: number): string[]`; `export function footballPhases(halves: number): string[] | null`; `export const KNOWN_UNSUPPORTED: readonly string[]` with keys `${sport}:${variant}:${stageKind}:${outcomeLabel}`. `STREAM_GENERATORS` now has 11 keys.

Facts every generator relies on: `plan-facts-sports.md` §1–11 (payloads verbatim, file:line). Sides are ENTRANT ids. Set and game summaries must be reachable scores.

- [ ] **Step 1: Write the failing sweep** at `scripts/matrix/__tests__/streams.test.ts`

```ts
// Every sport × declared variant × {league, knockout, swiss} × 6 outcomes:
// generate, FOLD through the real module (strict), and demand the folded
// outcome equals the request. Draw reachability comes from supportsDraws, not
// a table (R9). Gaps the generators knowingly leave are a COMMITTED list whose
// staleness is checked in both directions.
import type { StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { describe, expect, it } from "vitest";
import { drawsAllowed, resolveSportCfg, sportModule, variantKeys } from "../lib/sport-cfg.ts";
import { foldStream } from "../lib/fold.ts";
import { STREAM_GENERATORS, generateStream, matchesRequest } from "../lib/streams/index.ts";
import { KNOWN_UNSUPPORTED } from "../lib/streams/known-unsupported.ts";
import { footballPhases, } from "../lib/streams/football.ts";
import { periodLabels } from "../lib/streams/period.ts";
import { ALL_OUTCOMES, GeneratorUnsupported, OutcomeUnreachable, outcomeLabel, type StreamRequest } from "../lib/streams/types.ts";

const STAGES: readonly StageKind[] = ["league", "knockout", "swiss"];
const CASES = builtinModules.flatMap((m) =>
  variantKeys(m.key).flatMap((variant) =>
    STAGES.flatMap((stageKind) =>
      ALL_OUTCOMES.map((outcome) => ({
        key: `${m.key}:${variant}:${stageKind}:${outcomeLabel(outcome)}`,
        req: { sportKey: m.key, cfg: resolveSportCfg(m.key, variant), stageKind, home: "H", away: "A", outcome } as StreamRequest,
      })),
    ),
  ),
);
const thrownUnsupported = new Set<string>();

describe("stream sweep — discovery first (an empty sweep passes vacuously, R13/R25)", () => {
  it("covers all 11 sports, every declared variant, 3 stage kinds, 6 outcomes", () => {
    expect(new Set(CASES.map((c) => c.req.sportKey)).size).toBe(11);
    const variants = builtinModules.reduce((n, m) => n + variantKeys(m.key).length, 0);
    expect(CASES.length).toBe(variants * STAGES.length * ALL_OUTCOMES.length);
    expect(Object.keys(STREAM_GENERATORS).sort()).toEqual(builtinModules.map((m) => m.key).sort());
  });
});

describe("stream sweep", () => {
  it.each(CASES.map((c) => [c.key, c] as const))("%s", (key, { req }) => {
    let events;
    try {
      events = generateStream(req);
    } catch (e) {
      if (e instanceof OutcomeUnreachable) {
        expect(req.outcome.kind).toBe("draw");
        expect(drawsAllowed(req.sportKey, req.cfg, req.stageKind)).toBe(false);
        return;
      }
      if (e instanceof GeneratorUnsupported) {
        thrownUnsupported.add(key);
        expect(KNOWN_UNSUPPORTED, `unlisted generator gap ${key}`).toContain(key);
        return;
      }
      throw e;
    }
    expect(KNOWN_UNSUPPORTED, `stale KNOWN_UNSUPPORTED entry ${key}`).not.toContain(key);
    const m = sportModule(req.sportKey);
    const declared = (m as { eventSchemas?: Record<string, unknown> }).eventSchemas;
    for (const ev of events) {
      if (ev.type.startsWith("core.") || declared === undefined) continue;
      expect(Object.keys(declared), `${key}: ${ev.type}`).toContain(ev.type);
    }
    const folded = foldStream(m, req.cfg, "H", "A", events); // strict: throws on an unreachable score
    expect(matchesRequest(req, folded.outcome), key).toBe(req.outcome.kind === "abandon" ? "unasserted" : "match");
  });

  it("every KNOWN_UNSUPPORTED entry was actually thrown (the list cannot outlive its gap)", () => {
    expect([...KNOWN_UNSUPPORTED].filter((k) => !thrownUnsupported.has(k))).toEqual([]);
  });
});

describe("label derivations — empty/degenerate first", () => {
  it("periodLabels: 0 → none; 4 → quarters; 2 → halves; 3 → periods", () => {
    expect(periodLabels(0)).toEqual([]);
    expect(periodLabels(4)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(periodLabels(2)).toEqual(["H1", "H2"]);
    expect(periodLabels(3)).toEqual(["P1", "P2", "P3"]);
  });
  it("footballPhases: 2 → HT FT; 4 → QT HT 3QT FT; anything else is not generated", () => {
    expect(footballPhases(2)).toEqual(["HT", "FT"]);
    expect(footballPhases(4)).toEqual(["QT", "HT", "3QT", "FT"]);
    expect(footballPhases(3)).toBeNull();
  });
});
```
The sweep's `it.each` rows run before the staleness `it`, because vitest runs tests in declaration order within a file.

- [ ] **Step 2: Run and see RED** (template, `<N>`=3a, `<files>`=`scripts/matrix/__tests__/streams.test.ts`). The modules are missing.

- [ ] **Step 3: Implement the generators**

`scripts/matrix/lib/streams/setbased.ts`:
```ts
// volleyball / badminton / tabletennis — the set-based kernel. Event type is
// `${key}.${coarse}` (kernel.ts:1651-1656); summaries are positional
// {home, away} and must be REACHABLE under the cfg (testkit/scenarios.ts:150-175).
import { GeneratorUnsupported, START, outcomeLabel, type SportStreamGenerator, type StreamEvent } from "./types.ts";

// setbased/badminton.ts:58, tabletennis.ts:59, volleyball.ts:99.
const COARSE: Readonly<Record<string, string>> = { badminton: "game.summary", tabletennis: "game.summary", volleyball: "set.summary" };

interface SetCfg { bestOf: number; setTo: number; finalSetTo: number; winBy: number }

/** A set the winner takes at exactly `target`, the loser far enough behind that
 *  no deuce/cap rule applies. */
export function winningSetScore(target: number, winBy: number): { w: number; l: number } {
  return { w: target, l: Math.max(0, target - winBy - 3) };
}

export const setbasedGenerator: SportStreamGenerator = {
  sportKeys: ["badminton", "tabletennis", "volleyball"],
  decided(req) {
    if (req.outcome.kind === "draw") {
      throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "odd best-of: no draw exists");
    }
    const cfg = req.cfg as SetCfg;
    const homeWins = req.outcome.winner === "home";
    const events: StreamEvent[] = [START];
    for (let i = 0; i < Math.ceil(cfg.bestOf / 2); i++) {
      const target = i === cfg.bestOf - 1 ? cfg.finalSetTo : cfg.setTo;
      const { w, l } = winningSetScore(target, cfg.winBy);
      events.push({ type: `${req.sportKey}.${COARSE[req.sportKey]}`, payload: { home: homeWins ? w : l, away: homeWins ? l : w } });
    }
    return events;
  },
};
```

`scripts/matrix/lib/streams/tennis.ts`:
```ts
// tennis — nested kernel; `tennis.set_summary {home, away}` (nested/kernel.ts:240).
import { GeneratorUnsupported, START, outcomeLabel, type SportStreamGenerator, type StreamEvent } from "./types.ts";

interface TennisCfg { bestOf: number; set: { gamesTo: number; winBy: number } }

export const tennisGenerator: SportStreamGenerator = {
  sportKeys: ["tennis"],
  decided(req) {
    if (req.outcome.kind === "draw") throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "tennis has no draw");
    const cfg = req.cfg as TennisCfg;
    const w = cfg.set.gamesTo;
    const l = Math.max(0, cfg.set.gamesTo - cfg.set.winBy - 1); // 6-3, fast4 4-1: never a tie-break set
    const homeWins = req.outcome.winner === "home";
    const events: StreamEvent[] = [START];
    for (let i = 0; i < Math.ceil(cfg.bestOf / 2); i++) {
      events.push({ type: "tennis.set_summary", payload: { home: homeWins ? w : l, away: homeWins ? l : w } });
    }
    return events;
  },
};
```

`scripts/matrix/lib/streams/period.ts`:
```ts
// hockey / icehockey — period kernel. `to` must be the exact next label
// (kernel.ts:1140-1152; labels :650-665): 4 → Q, 2 → H, otherwise P; then FT.
import { START, idOf, type SportStreamGenerator, type StreamEvent } from "./types.ts";

export function periodLabels(count: number): string[] {
  const prefix = count === 4 ? "Q" : count === 2 ? "H" : "P";
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
}

interface PeriodCfg { periods: { count: number } }

export const periodGenerator: SportStreamGenerator = {
  sportKeys: ["hockey", "icehockey"],
  decided(req) {
    const labels = periodLabels((req.cfg as PeriodCfg).periods.count);
    const advances: StreamEvent[] = [...labels.slice(1), "FT"].map((to) => ({ type: `${req.sportKey}.period.advance`, payload: { to } }));
    // A draw is only requested where supportsDraws is true (overtime and
    // shootout null), so a level FT is terminal there.
    const goals: StreamEvent[] = req.outcome.kind === "draw" ? [] : [{ type: `${req.sportKey}.goal`, payload: { by: idOf(req, req.outcome.winner) } }];
    return [START, ...goals, ...advances];
  },
};
```

`scripts/matrix/lib/streams/football.ts`:
```ts
// football — goals + period markers only (no coarse result event).
// resolveFullTime (football.ts:1000-1024): level at FT → ET if enabled, else
// SHOOTOUT if enabled, else draw.
import { GeneratorUnsupported, START, idOf, outcomeLabel, type SportStreamGenerator, type StreamEvent } from "./types.ts";

export function footballPhases(halves: number): string[] | null {
  if (halves === 2) return ["HT", "FT"];
  if (halves === 4) return ["QT", "HT", "3QT", "FT"];
  return null;
}

interface FootballCfg { halves: number; extraTime?: { enabled?: boolean } | null; shootout?: unknown }

export const footballGenerator: SportStreamGenerator = {
  sportKeys: ["football"],
  decided(req) {
    const cfg = req.cfg as FootballCfg;
    const phases = footballPhases(cfg.halves);
    if (phases === null) throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), `halves ${cfg.halves}`);
    if (req.outcome.kind === "draw" && (cfg.extraTime?.enabled === true || Boolean(cfg.shootout))) {
      throw new GeneratorUnsupported(req.sportKey, "draw", "level FT continues to ET/shootout under this cfg");
    }
    const markers: StreamEvent[] = phases.map((phase) => ({ type: "football.period", payload: { phase } }));
    if (req.outcome.kind === "draw") return [START, ...markers];
    return [START, { type: "football.goal", payload: { by: idOf(req, req.outcome.winner), minute: 10 } }, ...markers];
  },
};
```

`scripts/matrix/lib/streams/cricket.ts`:
```ts
// cricket — one coarse summary per innings (cricket.ts:231-238); HOME bats
// first without a toss (:3626). An innings closes on balls exhausted or target
// passed. Two-innings cricket is W2's rulebook (the draw lives there).
import { GeneratorUnsupported, START, outcomeLabel, type SportStreamGenerator } from "./types.ts";

interface CricketCfg { inningsPerSide: number; ballsPerInnings: number }

export const cricketGenerator: SportStreamGenerator = {
  sportKeys: ["cricket"],
  decided(req) {
    const cfg = req.cfg as CricketCfg;
    if (cfg.inningsPerSide !== 1) {
      throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "two-innings streams land with W2's cricket rulebook");
    }
    if (req.outcome.kind === "draw") throw new GeneratorUnsupported(req.sportKey, "draw", "limited-overs cricket has no draw");
    const B = cfg.ballsPerInnings;
    const summary = (runs: number, wickets: number, legalBalls: number) => ({ type: "cricket.innings.summary", payload: { runs, wickets, legalBalls } });
    return req.outcome.winner === "home"
      ? [START, summary(180, 4, B), summary(150, 5, B)]
      : [START, summary(150, 5, B), summary(151, 3, Math.min(B, 60))];
  },
};
```

`scripts/matrix/lib/streams/boardgame.ts`:
```ts
// boardgame.result {winner|null, method} requires phase live (boardgame.ts:243-280).
import { START, idOf, type SportStreamGenerator } from "./types.ts";

export const boardgameGenerator: SportStreamGenerator = {
  sportKeys: ["boardgame"],
  decided(req) {
    if (req.outcome.kind === "draw") return [START, { type: "boardgame.result", payload: { winner: null, method: "agreement" } }];
    return [START, { type: "boardgame.result", payload: { winner: idOf(req, req.outcome.winner), method: "checkmate" } }];
  },
};
```

`scripts/matrix/lib/streams/carrom.ts`:
```ts
// carrom — board summaries (carrom.ts:88-125). Board points = opponentCoinsLeft
// × pointsPerCoin; a game ends at gameTo or on the leader after maxBoards; the
// match is a majority of bestOf. DO NOT copy seed-demo.ts (no carrom case).
import { GeneratorUnsupported, START, idOf, outcomeLabel, type SportStreamGenerator, type StreamEvent } from "./types.ts";

interface CarromCfg { gameTo: number; maxBoards: number; bestOf: number; pointsPerCoin: number }

export const carromGenerator: SportStreamGenerator = {
  sportKeys: ["carrom"],
  decided(req) {
    if (req.outcome.kind === "draw") {
      throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), "the tieBoard:'draw' shape lands with W2's carrom rulebook");
    }
    const cfg = req.cfg as CarromCfg;
    const boardsPerGame = Math.min(cfg.maxBoards, Math.ceil(cfg.gameTo / (9 * cfg.pointsPerCoin)));
    const board: StreamEvent = { type: "carrom.board.summary", payload: { winner: idOf(req, req.outcome.winner), opponentCoinsLeft: 9, queenTo: null } };
    return [START, ...Array.from({ length: Math.ceil(cfg.bestOf / 2) * boardsPerGame }, () => board)];
  },
};
```

Register all of them in `index.ts`:
```ts
import { boardgameGenerator } from "./boardgame.ts";
import { carromGenerator } from "./carrom.ts";
import { cricketGenerator } from "./cricket.ts";
import { footballGenerator } from "./football.ts";
import { periodGenerator } from "./period.ts";
import { setbasedGenerator } from "./setbased.ts";
import { tennisGenerator } from "./tennis.ts";
export const STREAM_GENERATORS = register(
  genericGenerator, setbasedGenerator, tennisGenerator, periodGenerator,
  footballGenerator, cricketGenerator, boardgameGenerator, carromGenerator,
);
```

`scripts/matrix/lib/streams/known-unsupported.ts`:
```ts
// Committed list of generator gaps (R11): `${sport}:${variant}:${stageKind}:${outcome}`.
// streams.test.ts fails on an unlisted gap AND on a listed entry that no longer
// throws. A difference found on the first run is a FINDING: record it in
// _INDEX.md "False premises found" before editing this list; never widen it
// to make the sweep green.
export const KNOWN_UNSUPPORTED: readonly string[] = Object.freeze([
  // cricket `test` is two-innings (cricket.ts:3549+): W2's cricket rulebook.
  "cricket:test:league:win-home", "cricket:test:league:win-away",
  "cricket:test:knockout:win-home", "cricket:test:knockout:win-away",
  "cricket:test:swiss:win-home", "cricket:test:swiss:win-away",
  // supportsDraws is true for 2-innings cricket on league-ish stages only.
  "cricket:test:league:draw", "cricket:test:swiss:draw",
]);
```

- [ ] **Step 4: Run and see GREEN** (template, `<N>`=3, `<files>`=`scripts/matrix/__tests__/streams.test.ts scripts/matrix/__tests__/fold.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts`). Expected: `failed 0` and `total` ≈ variants×18+4.
  - **If a row fails, work out which kind of failure it is.** It is either a generator bug (fix the generator) or an engine fact that differs from `plan-facts-sports.md`.
  - An engine-fact difference goes in the report and in `_INDEX.md` "False premises found" as a finding. Only then do you adjust the generator or `KNOWN_UNSUPPORTED`.
  - Never skip a row.

- [ ] **Step 5: Mutation**
  - setbased: swap `home`/`away` in the payload → every set-based `win-home` row is red.
  - tennis: `l = gamesTo - 1` (6-5, not terminal) → the tennis `win-*` rows go red (strict fold, or outcome null).
  - period: drop `"FT"` from `advances` → hockey/icehockey rows go red (outcome null).
  - carrom: `boardsPerGame - 1` → carrom rows go red.
  - Delete one entry from `KNOWN_UNSUPPORTED` → "unlisted generator gap".
  - Add a bogus entry → "every KNOWN_UNSUPPORTED entry was actually thrown".
  - football: remove the ET/shootout draw guard → no effect on default variants. **Note it as a surviving mutant if it survives**: no declared football variant has ET or a shootout. The guard stays as an R28 assertion, and W2 owns the knockout-football decider.

- [ ] **Step 6: Commit** (message: "feat(matrix): engine-verified stream generators for all 11 sports + fold sweep")

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git add scripts/matrix/lib/streams scripts/matrix/__tests__/streams.test.ts && git commit -F "$TMPDIR/fm-msg.txt" -- scripts/matrix
```

**Test types:**
- Unit: the sweep.
- E2E: Task 11 posts generic and badminton streams to the real events endpoint, and `life-fold-parity` compares the outcomes.
- Smoke: loadable.
- Regression: the sweep, run in CI on every PR (Task 10). This is the parity sweep AGENTS class 7 asks for.

---

### Task 4: Result schema, `decideState`, redaction, and the MATRIX.md renderer

**Files:**
- Create: `scripts/matrix/lib/redact.ts`, `scripts/matrix/lib/results.ts`, `scripts/matrix/lib/render-matrix.ts`, `scripts/matrix/render.ts`
- Create: `scripts/matrix/__tests__/results.test.ts`, `scripts/matrix/__tests__/render-matrix.test.ts`, `scripts/matrix/__tests__/render-cli.test.ts`

**Interfaces:**
- Consumes: `ROW_KEYS`, `SPORT_KEYS`, `cellId` (Task 1).
- Produces:
  ```ts
  // redact.ts
  export function redact(text: string): string;
  export function findSecrets(text: string): string[];
  // results.ts
  export const CASE_STATES: readonly ["works","refused","red","later","needs_ruling","no_path","not_run"];
  export type CaseState = (typeof CASE_STATES)[number];
  export const GLYPH: Readonly<Record<CaseState, string>>;   // ✅ ⛔ ❌ ⏳ ⬜ 🚫 ░
  export type Verdict = "pass" | "fail" | "abstain";
  export interface CheckResult { id: string; kind: "invariant" | "assertion"; verdict: Verdict; checked: number; reason: string; evidence: string[] }
  export interface CaseResult { caseId: string; row: string; sport: string; variant: string; scenario: string; canary: boolean; state: CaseState; reason: string; checks: CheckResult[]; counts: { calls: number; fixtures: number; events: number }; durationMs: number }
  export interface RunResults { schemaVersion: 1; runId: string; harnessCommit: string; startedAt: string; finishedAt: string; cases: CaseResult[] }
  export const RunResultsSchema: z.ZodType<RunResults>;
  export function parseResults(json: unknown): RunResults;
  export interface DecideInput { checks: readonly CheckResult[]; deferred: { wave: string; reason: string } | null; error: string | null }
  export function decideState(input: DecideInput): { state: CaseState; reason: string };
  export class SecretInResults extends Error {}
  export function writeResults(dir: string, results: RunResults): string;   // returns the written path
  // render-matrix.ts
  export const SEVERITY: readonly CaseState[];   // red > later > needs_ruling > no_path > not_run > refused > works
  export function worstState(states: readonly CaseState[]): CaseState | null;
  export function renderMatrix(results: RunResults): string;
  // render.ts
  export async function main(argv: string[]): Promise<number>;
  ```
  `Verdict` and `CheckResult` are defined HERE and re-exported as types by `observed.ts` (Task 5), so there is one authority for each.

- [ ] **Step 1: Write the failing tests.**

`scripts/matrix/__tests__/results.test.ts`:
```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findSecrets, redact } from "../lib/redact.ts";
import { CASE_STATES, GLYPH, SecretInResults, decideState, parseResults, writeResults, type CheckResult, type RunResults } from "../lib/results.ts";

const chk = (p: Partial<CheckResult>): CheckResult => ({ id: "c", kind: "invariant", verdict: "pass", checked: 1, reason: "", evidence: [], ...p });

describe("decideState — empty case first (R13, R25)", () => {
  it("no checks at all is red, not works", () => {
    expect(decideState({ checks: [], deferred: null, error: null }).state).toBe("red");
  });
  it("every check abstained is red: vacuous (Review Focus 1)", () => {
    const r = decideState({ checks: [chk({ verdict: "abstain", checked: 0 }), chk({ verdict: "abstain", checked: 0 })], deferred: null, error: null });
    expect(r).toEqual({ state: "red", reason: expect.stringMatching(/vacuous/) });
  });
  it("a passing check that checked zero items is red", () => {
    expect(decideState({ checks: [chk({ checked: 0 })], deferred: null, error: null }).state).toBe("red");
  });
});

describe("decideState", () => {
  it("one applied pass with items → works", () => {
    expect(decideState({ checks: [chk({}), chk({ verdict: "abstain", checked: 0 })], deferred: null, error: null }).state).toBe("works");
  });
  it("any fail → red, naming the check", () => {
    const r = decideState({ checks: [chk({}), chk({ id: "i1", verdict: "fail", reason: "pair a-b met twice" })], deferred: null, error: null });
    expect(r.state).toBe("red");
    expect(r.reason).toContain("i1");
  });
  it("an error outranks everything; deferred → later with the wave", () => {
    expect(decideState({ checks: [chk({})], deferred: null, error: "boom" }).state).toBe("red");
    expect(decideState({ checks: [], deferred: { wave: "W1b", reason: "multi-stage" }, error: null })).toEqual({ state: "later", reason: "W1b: multi-stage" });
  });
});

describe("glyphs and schema", () => {
  it("every state has a distinct glyph", () => {
    expect(new Set(CASE_STATES.map((s) => GLYPH[s])).size).toBe(CASE_STATES.length);
    expect(GLYPH.works).toBe("✅");
    expect(GLYPH.not_run).toBe("░");
  });
  it("parseResults refuses a wrong schemaVersion and an unknown state", () => {
    const ok: RunResults = { schemaVersion: 1, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", cases: [] };
    expect(parseResults(ok)).toEqual(ok);
    expect(() => parseResults({ ...ok, schemaVersion: 2 })).toThrow();
    expect(() => parseResults({ ...ok, cases: [{ state: "green" }] })).toThrow();
  });
});

describe("redaction (R14a)", () => {
  it("scrubs tokens, JWTs, device-link secrets, DB URLs, stripe keys", () => {
    const dirty = 'token=abc123def cookie: sb-access=xyz eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl dl_ABCDEFGH12345 postgres://u:p@h/db sk_test_ABCDEFGHIJ';
    const clean = redact(dirty);
    expect(findSecrets(clean)).toEqual([]);
    expect(findSecrets(dirty).length).toBeGreaterThanOrEqual(5);
    expect(redact("plain words stay")).toBe("plain words stay");
  });
  it("writeResults refuses to write a secret and writes a clean file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const base: RunResults = { schemaVersion: 1, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", cases: [] };
    const bad = { ...base, runId: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl" };
    expect(() => writeResults(dir, bad)).toThrow(SecretInResults);
    const path = writeResults(dir, base);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(base);
  });
});
```

`scripts/matrix/__tests__/render-matrix.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { renderMatrix, worstState } from "../lib/render-matrix.ts";
import type { CaseResult, RunResults } from "../lib/results.ts";

const run = (cases: CaseResult[]): RunResults => ({ schemaVersion: 1, runId: "r1", harnessCommit: "abc1234", startedAt: "s", finishedAt: "f", cases });
const kase = (p: Partial<CaseResult>): CaseResult => ({
  caseId: "league|generic|score|LIFECYCLE", row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false,
  state: "works", reason: "", checks: [], counts: { calls: 1, fixtures: 1, events: 1 }, durationMs: 5, ...p,
});

describe("renderMatrix — empty first", () => {
  it("an empty run renders the explicit banner and no table (R13)", () => {
    const md = renderMatrix(run([]));
    expect(md).toContain("**No cases run.**");
    expect(md).not.toContain("| row |");
  });
});

describe("renderMatrix", () => {
  it("renders all 21 rows × 11 sports; cells without cases are ░", () => {
    const md = renderMatrix(run([kase({})]));
    for (const row of ROW_KEYS) expect(md).toContain(`| ${row} |`);
    const header = md.split("\n").find((l) => l.startsWith("| row |"))!;
    for (const s of SPORT_KEYS) expect(header).toContain(s);
    const league = md.split("\n").find((l) => l.startsWith("| league |"))!;
    expect(league.split("|").filter((c) => c.trim() === "░").length).toBe(10);
    expect(league).toContain("✅");
  });
  it("a cell shows its WORST case: one red among works is red", () => {
    const md = renderMatrix(run([kase({}), kase({ caseId: "x", scenario: "M1", state: "red", reason: "m1-walkover-recorded" })]));
    expect(md.split("\n").find((l) => l.startsWith("| league |"))).toContain("❌");
  });
  it("worstState: empty → null; severity order", () => {
    expect(worstState([])).toBeNull();
    expect(worstState(["works", "later"])).toBe("later");
    expect(worstState(["refused", "red", "later"])).toBe("red");
  });
  it("is deterministic and carries no durations or timestamps from the run", () => {
    const a = renderMatrix(run([kase({ durationMs: 1 })]));
    const b = renderMatrix(run([kase({ durationMs: 999 })]));
    expect(a).toBe(b);
    expect(a).toContain("Do not edit by hand");
  });
});
```

`scripts/matrix/__tests__/render-cli.test.ts`:
```ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = join(REPO, "scripts/matrix/render.ts");
const cli = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { cwd: REPO, encoding: "utf8", timeout: 25_000 });
const results = (cases: unknown[]) => ({ schemaVersion: 1, runId: "r", harnessCommit: "abc", startedAt: "s", finishedAt: "f", cases });

describe("render CLI", () => {
  it("zero cases: writes the 'No cases run' banner and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    writeFileSync(join(dir, "results.json"), JSON.stringify(results([])));
    const r = cli(join(dir, "results.json"));
    expect(r.status).toBe(1);
    expect(readFileSync(join(dir, "MATRIX.md"), "utf8")).toContain("No cases run");
  });
  it("canary results are never rendered", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const c = { caseId: "c", row: "league", sport: "generic", variant: "score", scenario: "M1", canary: true, state: "red", reason: "", checks: [], counts: { calls: 0, fixtures: 0, events: 0 }, durationMs: 0 };
    writeFileSync(join(dir, "results.json"), JSON.stringify(results([c])));
    const r = cli(join(dir, "results.json"));
    expect(r.status).toBe(1);
    expect(existsSync(join(dir, "MATRIX.md"))).toBe(false);
  });
  it("no argument: usage, exit 2", () => { expect(cli().status).toBe(2); });
});
```

- [ ] **Step 2: Run and see RED** (template, `<N>`=4a, the three files).

- [ ] **Step 3: Implement `scripts/matrix/lib/redact.ts`**

```ts
// R14a — the repo is public. Every error message and evidence string passes
// through redact(); writeResults refuses a file findSecrets() still matches.
const PATTERNS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,            // JWT
  /\bdl_[A-Za-z0-9_-]{8,}/g,                                                     // device-link secret
  /\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{8,}/g,                        // stripe keys
  /\bpostgres(?:ql)?:\/\/[^\s"']+/gi,                                            // DB URL
  /\b(?:token|secret|password|apikey|api_key|authorization|cookie|sb-[a-z-]+)["']?\s*[:=]\s*["']?[^"'\s&,;}]{3,}/gi,
];

export function findSecrets(text: string): string[] {
  return PATTERNS.flatMap((p) => [...text.matchAll(new RegExp(p.source, p.flags))].map((m) => m[0]));
}

export function redact(text: string): string {
  return PATTERNS.reduce((t, p) => t.replace(new RegExp(p.source, p.flags), "[redacted]"), text);
}
```

- [ ] **Step 4: Implement `scripts/matrix/lib/results.ts`**

```ts
// One JSON result per case (R10: MATRIX.md is rendered from this and nothing
// else). decideState is the ONLY place a case becomes green, and it refuses
// every vacuous shape (R13, R25).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { findSecrets } from "./redact.ts";

export const CASE_STATES = ["works", "refused", "red", "later", "needs_ruling", "no_path", "not_run"] as const;
export type CaseState = (typeof CASE_STATES)[number];

export const GLYPH: Readonly<Record<CaseState, string>> = Object.freeze({
  works: "✅", refused: "⛔", red: "❌", later: "⏳", needs_ruling: "⬜", no_path: "🚫", not_run: "░",
});

export type Verdict = "pass" | "fail" | "abstain";

export interface CheckResult {
  id: string;
  kind: "invariant" | "assertion";
  verdict: Verdict;
  checked: number;
  reason: string;
  evidence: string[];
}

export interface CaseResult {
  caseId: string;
  row: string;
  sport: string;
  variant: string;
  scenario: string;
  canary: boolean;
  state: CaseState;
  reason: string;
  checks: CheckResult[];
  counts: { calls: number; fixtures: number; events: number };
  durationMs: number;
}

export interface RunResults {
  schemaVersion: 1;
  runId: string;
  harnessCommit: string;
  startedAt: string;
  finishedAt: string;
  cases: CaseResult[];
}

const CheckSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["invariant", "assertion"]),
  verdict: z.enum(["pass", "fail", "abstain"]),
  checked: z.number().int().nonnegative(),
  reason: z.string(),
  evidence: z.array(z.string()),
});

const CaseSchema = z.strictObject({
  caseId: z.string().min(1),
  row: z.string().min(1),
  sport: z.string().min(1),
  variant: z.string().min(1),
  scenario: z.string().min(1),
  canary: z.boolean(),
  state: z.enum(CASE_STATES),
  reason: z.string(),
  checks: z.array(CheckSchema),
  counts: z.strictObject({ calls: z.number().int().nonnegative(), fixtures: z.number().int().nonnegative(), events: z.number().int().nonnegative() }),
  durationMs: z.number().nonnegative(),
});

export const RunResultsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  harnessCommit: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  cases: z.array(CaseSchema),
});

export function parseResults(json: unknown): RunResults {
  return RunResultsSchema.parse(json) as RunResults;
}

export interface DecideInput {
  checks: readonly CheckResult[];
  deferred: { wave: string; reason: string } | null;
  error: string | null;
}

export function decideState(input: DecideInput): { state: CaseState; reason: string } {
  if (input.error !== null) return { state: "red", reason: `error: ${input.error}` };
  if (input.deferred !== null) return { state: "later", reason: `${input.deferred.wave}: ${input.deferred.reason}` };
  if (input.checks.length === 0) return { state: "red", reason: "no checks ran (vacuous)" };
  const failed = input.checks.filter((c) => c.verdict === "fail");
  if (failed.length > 0) return { state: "red", reason: failed.map((c) => `${c.id}: ${c.reason}`).join("; ") };
  const applied = input.checks.filter((c) => c.verdict !== "abstain");
  if (applied.length === 0) return { state: "red", reason: "every check abstained (vacuous)" };
  const empty = applied.filter((c) => c.checked === 0);
  if (empty.length > 0) return { state: "red", reason: `checked zero items (vacuous): ${empty.map((c) => c.id).join(", ")}` };
  return { state: "works", reason: `${applied.length} checks, ${applied.reduce((n, c) => n + c.checked, 0)} items` };
}

export class SecretInResults extends Error {
  constructor(count: number) {
    super(`results: refusing to write — ${count} secret-shaped string(s) survived redaction (R14a)`);
    this.name = "SecretInResults";
  }
}

export function writeResults(dir: string, results: RunResults): string {
  const body = `${JSON.stringify(RunResultsSchema.parse(results), null, 2)}\n`;
  const hits = findSecrets(body);
  if (hits.length > 0) throw new SecretInResults(hits.length);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "results.json");
  writeFileSync(path, body);
  return path;
}
```

- [ ] **Step 5: Implement `scripts/matrix/lib/render-matrix.ts`**

```ts
// MATRIX.md, rendered ONLY from results JSON (R10). Deterministic: no clock,
// no durations. A cell shows the worst state among its cases; a cell with no
// case is ░. An empty run is a banner, never an empty table (R13).
import { ROW_KEYS, SPORT_KEYS, cellId } from "./catalogue.ts";
import { CASE_STATES, GLYPH, type CaseState, type RunResults } from "./results.ts";

export const SEVERITY: readonly CaseState[] = ["red", "later", "needs_ruling", "no_path", "not_run", "refused", "works"];

export function worstState(states: readonly CaseState[]): CaseState | null {
  for (const s of SEVERITY) if (states.includes(s)) return s;
  return null;
}

const HEAD = (r: RunResults) => [
  "# Format × sport matrix",
  "",
  `> Generated by \`pnpm matrix:render\` from \`results.json\` (run \`${r.runId}\`, harness \`${r.harnessCommit}\`, schema v${r.schemaVersion}). Do not edit by hand (R10).`,
  "",
];

export function renderMatrix(results: RunResults): string {
  if (results.cases.length === 0) {
    return [...HEAD(results), `> **No cases run.** \`results.json\` for run \`${results.runId}\` holds zero cases. An empty run is a failure (R13), not a clean matrix.`, ""].join("\n");
  }
  const byCell = new Map<string, CaseState[]>();
  for (const c of results.cases) {
    const k = cellId(c.row as never, c.sport);
    byCell.set(k, [...(byCell.get(k) ?? []), c.state]);
  }
  const legend = CASE_STATES.map((s) => `${GLYPH[s]} ${s}`).join(" · ");
  const table = [
    `| row | ${SPORT_KEYS.join(" | ")} |`,
    `|---|${SPORT_KEYS.map(() => "---").join("|")}|`,
    ...ROW_KEYS.map((row) => `| ${row} | ${SPORT_KEYS.map((s) => GLYPH[worstState(byCell.get(cellId(row, s)) ?? []) ?? "not_run"]).join(" | ")} |`),
  ];
  const totals = CASE_STATES.map((s) => `| ${GLYPH[s]} ${s} | ${results.cases.filter((c) => c.state === s).length} |`);
  const cases = [...results.cases]
    .sort((a, b) => a.caseId.localeCompare(b.caseId))
    .map((c) => {
      const applied = c.checks.filter((k) => k.verdict !== "abstain");
      const items = applied.reduce((n, k) => n + k.checked, 0);
      return `| \`${c.caseId}\` | ${GLYPH[c.state]} | ${c.reason.replace(/\|/g, "\\|")} | ${applied.length}/${c.checks.length} | ${items} |`;
    });
  return [
    ...HEAD(results),
    legend,
    "",
    ...table,
    "",
    "## Totals",
    "",
    "| state | cases |",
    "|---|---|",
    ...totals,
    `| total | ${results.cases.length} |`,
    "",
    "## Cases",
    "",
    "| case | state | reason | checks applied | items checked |",
    "|---|---|---|---|---|",
    ...cases,
    "",
  ].join("\n");
}
```

- [ ] **Step 6: Implement `scripts/matrix/render.ts`**

```ts
// CLI: node --experimental-strip-types scripts/matrix/render.ts <results.json> [--out MATRIX.md]
// Exit 0 rendered; 1 zero cases (file still written, with the banner) or
// canary results (nothing written); 2 usage.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { renderMatrix } from "./lib/render-matrix.ts";
import { parseResults } from "./lib/results.ts";

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" } } });
  const file = positionals[0];
  if (file === undefined) {
    process.stderr.write("usage: render.ts <results.json> [--out MATRIX.md]\n");
    return 2;
  }
  const results = parseResults(JSON.parse(readFileSync(file, "utf8")));
  if (results.cases.some((c) => c.canary)) {
    process.stderr.write("render: refusing to render canary results — a canary run proves the harness can go red, it is not a matrix\n");
    return 1;
  }
  const out = values.out ?? join(dirname(file), "MATRIX.md");
  writeFileSync(out, renderMatrix(results));
  process.stdout.write(`render: ${results.cases.length} cases → ${out}\n`);
  return results.cases.length === 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
```

- [ ] **Step 7: Run and see GREEN** (template, `<N>`=4, the three new files plus `strip-types-loadable.test.ts`).

- [ ] **Step 8: Mutation**
  - `decideState`: delete the `applied.length === 0` branch → results.test "every check abstained is red".
  - Delete the `empty.length > 0` branch → "a passing check that checked zero items is red".
  - Change `checks.length === 0` to return works → "no checks at all is red".
  - `renderMatrix`: drop the empty-run banner branch → render-matrix "an empty run renders the explicit banner".
  - Reverse `SEVERITY` → "a cell shows its WORST case".
  - `writeResults`: skip the `findSecrets` check → "writeResults refuses to write a secret".
  - Remove the JWT pattern → the "scrubs tokens" count assertion.

- [ ] **Step 9: Commit** (message: "feat(matrix): per-case JSON results, anti-vacuous decideState, MATRIX.md renderer")

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git add scripts/matrix/lib/redact.ts scripts/matrix/lib/results.ts scripts/matrix/lib/render-matrix.ts scripts/matrix/render.ts scripts/matrix/__tests__/results.test.ts scripts/matrix/__tests__/render-matrix.test.ts scripts/matrix/__tests__/render-cli.test.ts && git commit -F "$TMPDIR/fm-msg.txt" -- scripts/matrix
```

**Test types:**
- Unit: the three files.
- E2E: Task 11 writes and renders a real run.
- Smoke: `render-cli.test.ts` spawns the real CLI.
- Regression: the Step 8 mutants, plus Task 11's committed-MATRIX drift test.

---

### Task 5: The observed-run model and the invariants I1–I6

**Files:**
- Create: `scripts/matrix/lib/observed.ts`, `scripts/matrix/lib/invariants.ts`
- Create: `scripts/matrix/__tests__/invariants.test.ts`

**Interfaces:**
- Consumes: `Verdict`, `CheckResult` (types only, from `results.ts`).
- Produces:
  ```ts
  // observed.ts — pure data + pure helpers; `import type` only.
  export type ObservedOutcome = { kind: "win" | "award"; winner: string; method?: string } | { kind: "draw" | "tie" | "no_result" };
  export interface ObservedDeclared { home: number; away: number; forOutcome: ObservedOutcome }
  export interface ObservedFixture { id: string; stageId: string; poolId: string | null; roundNo: number | null; home: string | null; away: string | null; status: string; outcome: ObservedOutcome | null; declared: ObservedDeclared | null }
  export interface StandingsRowObs { entrantId: string; rank: number; points: number | null }
  export interface GenerateObs { status: number; code: string | null; total: number; created: number }
  export interface PairRoundObs { roundNo: number; seated: number }
  export interface CompleteObs { status: number; code: string | null; completed: boolean; finalRanks: string[] | null }
  export interface ObservedStage { id: string; seq: number; kind: string; config: Record<string, unknown>; field: string[]; fixtures: ObservedFixture[]; standings: { poolId: string | null; rows: StandingsRowObs[] }[]; generates: GenerateObs[]; pairRounds: PairRoundObs[]; complete: CompleteObs | null }
  export interface FixtureSnap { id: string; status: string; outcome: ObservedOutcome | null }
  export interface WithdrawalObs { entrantId: string; afterRound: number; policy: "none" | "walkover" | "expunge"; walkovers: number; voided: number; skippedFinalized: number; before: FixtureSnap[] }
  export interface ConfigEditObs { attempts: { kind: "format" | "entrants_only"; status: number; code: string | null }[]; before: FixtureSnap[]; after: FixtureSnap[] }
  export type CaseFact = "withdrawn" | "expunged" | "voided" | "cut_short" | "late_entry" | "shared_place_declared";
  export interface ObservedRun { caseId: string; facts: CaseFact[]; stages: ObservedStage[]; withdrawal: WithdrawalObs | null; configEdit: ConfigEditObs | null }
  export interface InvariantResult { verdict: Verdict; checked: number; evidence: string[] }
  export const TERMINAL_STATUSES: readonly string[];   // decided finalized forfeited abandoned cancelled
  export function isTerminal(status: string): boolean;
  export function twoSided(f: ObservedFixture): boolean;
  export function toObservedOutcome(raw: unknown): ObservedOutcome | null;
  export function winnerOf(o: ObservedOutcome | null): string | null;
  export function sameResult(a: { status: string; outcome: ObservedOutcome | null }, b: { status: string; outcome: ObservedOutcome | null }): boolean;
  export function snap(f: ObservedFixture): FixtureSnap;
  // invariants.ts — `import type` only.
  export interface InvariantSpec {
    readonly id: string;
    readonly description: string;
    readonly stageKinds: readonly string[] | "any";    // precondition (data)
    readonly abstainOn: readonly CaseFact[];            // precondition (data)
    readonly abstainOnStageConfig: readonly string[];   // precondition (data): a stage whose config has any of these keys is skipped
    readonly requiresCompletedStage: boolean;           // precondition (data)
    check(stages: readonly ObservedStage[], run: ObservedRun): InvariantResult;
  }
  export const INVARIANTS: readonly InvariantSpec[];    // I1..I6 in order
  export function evaluateInvariant(spec: InvariantSpec, run: ObservedRun): InvariantResult;
  export function evaluateInvariants(run: ObservedRun): CheckResult[];
  ```
  **Reuse contract (ruling 21, design §7.5):** `evaluateInvariant(spec, run)` is a pure function from observed data to `{verdict, checked, evidence}`. It has no I/O, no clock, no engine or HTTP import (enforced by the boundary test), and no state between calls. **W1b's fast-check model** generates `ObservedRun`s and calls it unchanged. **W10's production shadow checks** build an `ObservedRun` from production rows and call it unchanged. Neither may fork these files. They extend `INVARIANTS` by adding specs. The anti-vacuity guard lives in `evaluateInvariant`, so every present and future spec inherits it: a would-be pass over zero items is a `fail` (R25).

- [ ] **Step 1: Write the failing test** at `scripts/matrix/__tests__/invariants.test.ts`. Every invariant gets four tests, empty-first: **zero-count fails**, **positive**, **negative**, **abstain**.

```ts
import { describe, expect, it } from "vitest";
import { INVARIANTS, evaluateInvariant, evaluateInvariants, type InvariantSpec } from "../lib/invariants.ts";
import type { CaseFact, ObservedFixture, ObservedOutcome, ObservedRun, ObservedStage } from "../lib/observed.ts";
import { toObservedOutcome } from "../lib/observed.ts";

const spec = (id: string): InvariantSpec => INVARIANTS.find((s) => s.id === id)!;
const win = (w: string): ObservedOutcome => ({ kind: "win", winner: w });
let n = 0;
const fx = (p: Partial<ObservedFixture>): ObservedFixture => ({
  id: `f${++n}`, stageId: "s1", poolId: null, roundNo: 1, home: null, away: null, status: "decided", outcome: null, declared: null, ...p,
});
const stage = (p: Partial<ObservedStage>): ObservedStage => ({
  id: "s1", seq: 1, kind: "league", config: {}, field: [], fixtures: [], standings: [], generates: [], pairRounds: [], complete: null, ...p,
});
const run = (stages: ObservedStage[], p: Partial<ObservedRun> = {}): ObservedRun => ({ caseId: "t", facts: [], stages, withdrawal: null, configEdit: null, ...p });
/** Full single round robin; home always wins. */
function rr(ids: string[]): ObservedFixture[] {
  const out: ObservedFixture[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push(fx({ home: ids[i]!, away: ids[j]!, outcome: win(ids[i]!) }));
  return out;
}
const facts = (...f: CaseFact[]) => f;

it("registry: six invariants, unique ids, I1..I6 in order", () => {
  expect(INVARIANTS.map((s) => s.id)).toEqual([
    "I1-rr-pair-once-per-leg", "I2-bracket-one-champion-ranks-permutation", "I3-table-points-equal-declared",
    "I4-nothing-ends-stuck", "I5-config-edit-never-rescores", "I6-swiss-no-rematch",
  ]);
});

describe("I1 rr-pair-once-per-leg", () => {
  const I1 = spec("I1-rr-pair-once-per-leg");
  it("zero-count: a league stage with an empty field fails (R25)", () => {
    expect(evaluateInvariant(I1, run([stage({})]))).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("positive: 4 entrants, 6 pairs, each once", () => {
    expect(evaluateInvariant(I1, run([stage({ field: ["a", "b", "c", "d"], fixtures: rr(["a", "b", "c", "d"]) })]))).toMatchObject({ verdict: "pass", checked: 6 });
  });
  it("negative: a missing pair and a repeated pair (sides reversed) both fail, named", () => {
    const fixtures = rr(["a", "b", "c", "d"]).filter((f) => !(f.home === "a" && f.away === "d"));
    fixtures.push(fx({ home: "c", away: "b", outcome: win("c") }));
    const r = evaluateInvariant(I1, run([stage({ field: ["a", "b", "c", "d"], fixtures })]));
    expect(r.verdict).toBe("fail");
    expect(r.evidence.join(" ")).toMatch(/a~d met 0/);
    expect(r.evidence.join(" ")).toMatch(/b~c met 2/);
  });
  it("legs: 2 legs expects every pair twice", () => {
    const f = [...rr(["a", "b"]), ...rr(["a", "b"])];
    expect(evaluateInvariant(I1, run([stage({ config: { legs: 2 }, field: ["a", "b"], fixtures: f })])).verdict).toBe("pass");
    expect(evaluateInvariant(I1, run([stage({ config: { legs: 2 }, field: ["a", "b"], fixtures: rr(["a", "b"]) })])).verdict).toBe("fail");
  });
  it("abstain: a withdrawal case, and a run with no league/group stage", () => {
    expect(evaluateInvariant(I1, run([stage({ field: ["a", "b"], fixtures: rr(["a", "b"]) })], { facts: facts("withdrawn") })).verdict).toBe("abstain");
    expect(evaluateInvariant(I1, run([stage({ kind: "knockout" })])).verdict).toBe("abstain");
  });
});

describe("I2 bracket-one-champion-ranks-permutation", () => {
  const I2 = spec("I2-bracket-one-champion-ranks-permutation");
  const bracket = (finalRanks: string[] | null, completed = true) => stage({
    kind: "knockout", field: ["a", "b", "c", "d"],
    fixtures: [fx({ roundNo: 1, home: "a", away: "d", outcome: win("a") }), fx({ roundNo: 1, home: "b", away: "c", outcome: win("b") }), fx({ roundNo: 2, home: "a", away: "b", outcome: win("a") })],
    complete: { status: 200, code: null, completed, finalRanks },
  });
  it("zero-count: a completed bracket with no field and no ranks fails (R25)", () => {
    expect(evaluateInvariant(I2, run([stage({ kind: "knockout", complete: { status: 200, code: null, completed: true, finalRanks: [] } })]))).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("positive: ranks cover the field once and rank 1 is the only unbeaten entrant", () => {
    expect(evaluateInvariant(I2, run([bracket(["a", "b", "c", "d"])]))).toMatchObject({ verdict: "pass", checked: 5 });
  });
  it("negative: champion mismatch, and a missing entrant", () => {
    expect(evaluateInvariant(I2, run([bracket(["b", "a", "c", "d"])])).verdict).toBe("fail");
    expect(evaluateInvariant(I2, run([bracket(["a", "b", "c"])])).evidence.join(" ")).toMatch(/d .*not ranked/);
  });
  it("abstain: stage not completed; shared place declared", () => {
    expect(evaluateInvariant(I2, run([bracket(null, false)])).verdict).toBe("abstain");
    expect(evaluateInvariant(I2, run([bracket(["a", "b", "c", "d"])], { facts: facts("shared_place_declared") })).verdict).toBe("abstain");
  });
});

describe("I3 table-points-equal-declared", () => {
  const I3 = spec("I3-table-points-equal-declared");
  const decided = fx({ home: "a", away: "b", outcome: win("a"), declared: { home: 3, away: 0, forOutcome: win("a") } });
  const withRows = (a: number | null, b: number | null) => stage({
    field: ["a", "b"], fixtures: [decided],
    standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: a }, { entrantId: "b", rank: 2, points: b }] }],
  });
  it("zero-count: a league stage with no rows and no fixtures fails (R25)", () => {
    expect(evaluateInvariant(I3, run([stage({})]))).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("positive: rows equal Σ declared", () => {
    expect(evaluateInvariant(I3, run([withRows(3, 0)]))).toMatchObject({ verdict: "pass", checked: 2 });
  });
  it("negative: a row off by one; a row without points; an entrant with results but no row", () => {
    expect(evaluateInvariant(I3, run([withRows(2, 0)])).verdict).toBe("fail");
    expect(evaluateInvariant(I3, run([withRows(null, 0)])).verdict).toBe("fail");
    const noRow = stage({ field: ["a", "b"], fixtures: [decided], standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 3 }] }] });
    expect(evaluateInvariant(I3, run([noRow])).evidence.join(" ")).toMatch(/b has results but no row/);
  });
  it("skips an entrant whose result changed after the harness declared it (a server cascade), counting the skip", () => {
    const changed = fx({ home: "a", away: "b", status: "forfeited", outcome: { kind: "award", winner: "b" }, declared: { home: 3, away: 0, forOutcome: win("a") } });
    const s = stage({ field: ["a", "b", "c"], fixtures: [changed, fx({ home: "c", away: "a", outcome: win("c"), declared: { home: 3, away: 0, forOutcome: win("c") } })],
      standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 2, points: 0 }, { entrantId: "b", rank: 3, points: 3 }, { entrantId: "c", rank: 1, points: 3 }] }] });
    const r = evaluateInvariant(I3, run([s]));
    expect(r).toMatchObject({ verdict: "pass", checked: 1 });
    expect(r.evidence.join(" ")).toMatch(/skipped 2/);
  });
  it("a voided fixture (no outcome) contributes 0 — expunged results are checked, not skipped", () => {
    const voided = fx({ home: "a", away: "b", status: "abandoned", outcome: null, declared: { home: 3, away: 0, forOutcome: win("a") } });
    const s = stage({ field: ["a", "b", "c"], fixtures: [voided, fx({ home: "c", away: "a", outcome: win("c"), declared: { home: 3, away: 0, forOutcome: win("c") } })],
      standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 2, points: 0 }, { entrantId: "b", rank: 3, points: 0 }, { entrantId: "c", rank: 1, points: 3 }] }] });
    expect(evaluateInvariant(I3, run([s]))).toMatchObject({ verdict: "pass", checked: 3 });
    const stale = stage({ ...s, standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 3 }, { entrantId: "b", rank: 3, points: 0 }, { entrantId: "c", rank: 2, points: 3 }] }] });
    expect(evaluateInvariant(I3, run([stale])).evidence.join(" ")).toMatch(/a: table 3, declared Σ 0/);
  });
  it("abstain: a stage with its own points rule", () => {
    expect(evaluateInvariant(I3, run([stage({ ...withRows(3, 0), config: { points: { base: { win: 2, draw: 1, loss: 0 } } } })])).verdict).toBe("abstain");
  });
});

describe("I4 nothing-ends-stuck", () => {
  const I4 = spec("I4-nothing-ends-stuck");
  const done = { status: 200, code: null, completed: true, finalRanks: null };
  it("zero-count: a stage nobody generated, paired or completed fails", () => {
    expect(evaluateInvariant(I4, run([stage({})])).verdict).toBe("fail");
  });
  it("positive: generate returned fixtures, pair rounds seated, stage completed, all terminal", () => {
    const s = stage({ generates: [{ status: 201, code: null, total: 1, created: 1 }], pairRounds: [{ roundNo: 1, seated: 1 }], fixtures: [fx({ home: "a", away: "b", outcome: win("a") })], complete: done });
    expect(evaluateInvariant(I4, run([s]))).toMatchObject({ verdict: "pass", checked: 4 });
  });
  it("negative: an empty 2xx generate; an empty pair round; completed:false; a live fixture in a completed stage", () => {
    const base = { generates: [{ status: 201, code: null, total: 1, created: 1 }], complete: done };
    expect(evaluateInvariant(I4, run([stage({ ...base, generates: [{ status: 200, code: null, total: 0, created: 0 }] })])).evidence.join(" ")).toMatch(/empty generate/);
    expect(evaluateInvariant(I4, run([stage({ ...base, pairRounds: [{ roundNo: 2, seated: 0 }] })])).verdict).toBe("fail");
    expect(evaluateInvariant(I4, run([stage({ ...base, complete: { ...done, completed: false } })])).verdict).toBe("fail");
    expect(evaluateInvariant(I4, run([stage({ ...base, fixtures: [fx({ home: "a", away: "b", status: "scheduled" })] })])).verdict).toBe("fail");
  });
  it("a refused generate or complete with a NAMED code passes; an unnamed refusal fails", () => {
    const named = stage({ generates: [{ status: 422, code: "STAGE_NOT_READY", total: 0, created: 0 }], complete: { status: 409, code: "STAGE_COMPLETED_SEEDING_FAILED", completed: false, finalRanks: null } });
    expect(evaluateInvariant(I4, run([named])).verdict).toBe("pass");
    const unnamed = stage({ generates: [{ status: 500, code: null, total: 0, created: 0 }], complete: done });
    expect(evaluateInvariant(I4, run([unnamed])).verdict).toBe("fail");
  });
  it("abstain: a case deliberately cut short", () => {
    expect(evaluateInvariant(I4, run([stage({})], { facts: facts("cut_short") })).verdict).toBe("abstain");
  });
});

describe("I5 config-edit-never-rescores", () => {
  const I5 = spec("I5-config-edit-never-rescores");
  const before = [{ id: "f1", status: "decided", outcome: win("a") }];
  const edit = (after: typeof before) => ({ attempts: [{ kind: "format" as const, status: 409, code: "FORMAT_LOCKED" }], before, after });
  it("zero-count: an edit attempted with no finished fixture before it fails (R25)", () => {
    expect(evaluateInvariant(I5, run([stage({})], { configEdit: { attempts: [{ kind: "format", status: 409, code: "FORMAT_LOCKED" }], before: [], after: [] } }))).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("positive: the finished fixture is unchanged after the edit", () => {
    expect(evaluateInvariant(I5, run([stage({})], { configEdit: edit(before) }))).toMatchObject({ verdict: "pass", checked: 1 });
  });
  it("negative: the winner changed; the fixture vanished; only the status changed", () => {
    expect(evaluateInvariant(I5, run([stage({})], { configEdit: edit([{ id: "f1", status: "decided", outcome: win("b") }]) })).verdict).toBe("fail");
    expect(evaluateInvariant(I5, run([stage({})], { configEdit: edit([]) })).verdict).toBe("fail");
    expect(evaluateInvariant(I5, run([stage({})], { configEdit: edit([{ id: "f1", status: "abandoned", outcome: win("a") }]) })).verdict).toBe("fail");
  });
  it("abstain: no config edit was attempted", () => {
    expect(evaluateInvariant(I5, run([stage({})])).verdict).toBe("abstain");
  });
});

describe("I6 swiss-no-rematch", () => {
  const I6 = spec("I6-swiss-no-rematch");
  const sw = (fixtures: ObservedFixture[]) => stage({ kind: "swiss", field: ["a", "b", "c", "d"], fixtures });
  it("zero-count: a swiss stage with no seated pair fails (R25)", () => {
    expect(evaluateInvariant(I6, run([sw([fx({ home: "a", away: null, roundNo: 1 })])]))).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("positive: four distinct pairings", () => {
    const f = [fx({ home: "a", away: "b" }), fx({ home: "c", away: "d" }), fx({ roundNo: 2, home: "a", away: "c" }), fx({ roundNo: 2, home: "b", away: "d" })];
    expect(evaluateInvariant(I6, run([sw(f)]))).toMatchObject({ verdict: "pass", checked: 4 });
  });
  it("negative: a rematch with sides reversed is still a rematch", () => {
    const f = [fx({ home: "a", away: "b" }), fx({ roundNo: 2, home: "b", away: "a" })];
    expect(evaluateInvariant(I6, run([sw(f)])).evidence.join(" ")).toMatch(/a~b/);
  });
  it("abstain: no swiss stage", () => {
    expect(evaluateInvariant(I6, run([stage({})])).verdict).toBe("abstain");
  });
});

describe("evaluateInvariants + toObservedOutcome", () => {
  it("emits one invariant CheckResult per spec, carrying checked", () => {
    const out = evaluateInvariants(run([stage({ field: ["a", "b"], fixtures: rr(["a", "b"]) })]));
    expect(out.map((c) => c.id)).toEqual(INVARIANTS.map((s) => s.id));
    expect(out.every((c) => c.kind === "invariant" && Number.isInteger(c.checked))).toBe(true);
  });
  it("toObservedOutcome: junk → null; win/award keep winner; draw/tie/no_result keep kind", () => {
    expect(toObservedOutcome(null)).toBeNull();
    expect(toObservedOutcome({ kind: "win" })).toBeNull();
    expect(toObservedOutcome({ kind: "win", winner: "a", loser: "b" })).toEqual({ kind: "win", winner: "a" });
    expect(toObservedOutcome({ kind: "award", winner: "a", method: "walkover" })).toEqual({ kind: "award", winner: "a", method: "walkover" });
    expect(toObservedOutcome({ kind: "tie" })).toEqual({ kind: "tie" });
  });
});
```

- [ ] **Step 2: Run and see RED** (template, `<N>`=5a, `<files>`=`scripts/matrix/__tests__/invariants.test.ts`).

- [ ] **Step 3: Implement `scripts/matrix/lib/observed.ts`**

```ts
// What a case OBSERVED, as plain data. `import type` only (boundary test): W1b's
// fast-check model and W10's production shadow checks build these from their
// own sources and reuse invariants.ts unchanged.
import type { Verdict } from "./results.ts";

export type { CheckResult, Verdict } from "./results.ts";

export type ObservedOutcome =
  | { kind: "win" | "award"; winner: string; method?: string }
  | { kind: "draw" | "tie" | "no_result" };

export interface ObservedDeclared { home: number; away: number; forOutcome: ObservedOutcome }

export interface ObservedFixture {
  id: string;
  stageId: string;
  poolId: string | null;
  roundNo: number | null;
  home: string | null;
  away: string | null;
  status: string;
  outcome: ObservedOutcome | null;
  /** Σ-points the sport declares for the stream the HARNESS posted; null when the harness did not post it. */
  declared: ObservedDeclared | null;
}

export interface StandingsRowObs { entrantId: string; rank: number; points: number | null }
export interface GenerateObs { status: number; code: string | null; total: number; created: number }
export interface PairRoundObs { roundNo: number; seated: number }
export interface CompleteObs { status: number; code: string | null; completed: boolean; finalRanks: string[] | null }

export interface ObservedStage {
  id: string;
  seq: number;
  kind: string;
  config: Record<string, unknown>;
  /** Every entrant added to the division (withdrawn ones included). */
  field: string[];
  fixtures: ObservedFixture[];
  standings: { poolId: string | null; rows: StandingsRowObs[] }[];
  generates: GenerateObs[];
  pairRounds: PairRoundObs[];
  complete: CompleteObs | null;
}

export interface FixtureSnap { id: string; status: string; outcome: ObservedOutcome | null }

export interface WithdrawalObs {
  entrantId: string;
  afterRound: number;
  policy: "none" | "walkover" | "expunge";
  walkovers: number;
  voided: number;
  skippedFinalized: number;
  /** The withdrawn entrant's fixtures as they stood immediately before the call. */
  before: FixtureSnap[];
}

export interface ConfigEditObs {
  attempts: { kind: "format" | "entrants_only"; status: number; code: string | null }[];
  before: FixtureSnap[];
  after: FixtureSnap[];
}

export type CaseFact = "withdrawn" | "expunged" | "voided" | "cut_short" | "late_entry" | "shared_place_declared";

export interface ObservedRun {
  caseId: string;
  facts: CaseFact[];
  stages: ObservedStage[];
  withdrawal: WithdrawalObs | null;
  configEdit: ConfigEditObs | null;
}

export interface InvariantResult { verdict: Verdict; checked: number; evidence: string[] }

export const TERMINAL_STATUSES: readonly string[] = Object.freeze(["decided", "finalized", "forfeited", "abandoned", "cancelled"]);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function twoSided(f: ObservedFixture): boolean {
  return f.home !== null && f.away !== null;
}

export function toObservedOutcome(raw: unknown): ObservedOutcome | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as { kind?: unknown; winner?: unknown; method?: unknown };
  if ((o.kind === "win" || o.kind === "award") && typeof o.winner === "string") {
    return typeof o.method === "string" ? { kind: o.kind, winner: o.winner, method: o.method } : { kind: o.kind, winner: o.winner };
  }
  if (o.kind === "draw" || o.kind === "tie" || o.kind === "no_result") return { kind: o.kind };
  return null;
}

export function winnerOf(o: ObservedOutcome | null): string | null {
  return o !== null && (o.kind === "win" || o.kind === "award") ? o.winner : null;
}

export function sameResult(
  a: { status: string; outcome: ObservedOutcome | null },
  b: { status: string; outcome: ObservedOutcome | null },
): boolean {
  return a.status === b.status && (a.outcome?.kind ?? null) === (b.outcome?.kind ?? null) && winnerOf(a.outcome) === winnerOf(b.outcome);
}

export function snap(f: ObservedFixture): FixtureSnap {
  return { id: f.id, status: f.status, outcome: f.outcome };
}
```

- [ ] **Step 4: Implement `scripts/matrix/lib/invariants.ts`**

```ts
// Design §7.3 invariants as PURE functions with their preconditions as DATA.
// Each returns {verdict, checked, evidence}; evaluateInvariant applies the
// preconditions and the anti-vacuity guard (R25: zero checked is a failure),
// so every spec — including W1b's and W10's additions — inherits both.
// `import type` only (boundary test).
import type { CheckResult } from "./results.ts";
import type { CaseFact, InvariantResult, ObservedFixture, ObservedRun, ObservedStage } from "./observed.ts";

export interface InvariantSpec {
  readonly id: string;
  readonly description: string;
  readonly stageKinds: readonly string[] | "any";
  readonly abstainOn: readonly CaseFact[];
  readonly abstainOnStageConfig: readonly string[];
  readonly requiresCompletedStage: boolean;
  check(stages: readonly ObservedStage[], run: ObservedRun): InvariantResult;
}

// ---- pure helpers (duplicated from observed.ts ON PURPOSE: that module's
// runtime helpers are a value import, and this file is type-only) ----
const TERMINAL = new Set(["decided", "finalized", "forfeited", "abandoned", "cancelled"]);
const pairKey = (a: string, b: string) => (a < b ? `${a}~${b}` : `${b}~${a}`);
const seated = (f: ObservedFixture) => f.home !== null && f.away !== null;
const winner = (f: { outcome: ObservedFixture["outcome"] }) =>
  f.outcome !== null && (f.outcome.kind === "win" || f.outcome.kind === "award") ? f.outcome.winner : null;
const sameOutcome = (a: ObservedFixture["outcome"], b: ObservedFixture["outcome"]) =>
  (a?.kind ?? null) === (b?.kind ?? null) && winner({ outcome: a }) === winner({ outcome: b });
const result = (fails: string[], checked: number, notes: string[] = []): InvariantResult =>
  ({ verdict: fails.length > 0 ? "fail" : "pass", checked, evidence: [...fails, ...notes].slice(0, 12) });
const ABSTAIN = (why: string): InvariantResult => ({ verdict: "abstain", checked: 0, evidence: [`abstain: ${why}`] });

const I1: InvariantSpec = {
  id: "I1-rr-pair-once-per-leg",
  description: "every round-robin pair meets exactly once per leg",
  stageKinds: ["league", "group"],
  abstainOn: ["withdrawn", "expunged", "voided", "cut_short", "late_entry"],
  abstainOnStageConfig: [],
  requiresCompletedStage: false,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    for (const s of stages) {
      const legs = typeof s.config.legs === "number" ? s.config.legs : 1;
      const pools = new Map<string, Set<string>>();
      const met = new Map<string, number>();
      for (const f of s.fixtures.filter(seated)) {
        if (f.home === f.away) fails.push(`${f.id}: self-play ${f.home}`);
        const pool = pools.get(f.poolId ?? "") ?? new Set<string>();
        pool.add(f.home!).add(f.away!);
        pools.set(f.poolId ?? "", pool);
        met.set(pairKey(f.home!, f.away!), (met.get(pairKey(f.home!, f.away!)) ?? 0) + 1);
      }
      // A league has one pool: its members are the whole field, so an entrant
      // with NO fixture is still counted (it would otherwise escape).
      if (s.kind === "league") pools.set("", new Set(s.field));
      const pooled = new Set([...pools.values()].flatMap((p) => [...p]));
      for (const e of s.field) if (!pooled.has(e)) fails.push(`${e} in no pool`);
      for (const members of pools.values()) {
        const m = [...members].sort();
        for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) {
          checked++;
          const k = pairKey(m[i]!, m[j]!);
          const times = met.get(k) ?? 0;
          if (times !== legs) fails.push(`${k} met ${times}, expected ${legs}`);
        }
      }
    }
    return result(fails, checked);
  },
};

const I2: InvariantSpec = {
  id: "I2-bracket-one-champion-ranks-permutation",
  description: "a completed bracket ranks every entrant once and its rank 1 is the one unbeaten entrant",
  stageKinds: ["knockout", "double_elim", "stepladder", "page_playoff"],
  abstainOn: ["shared_place_declared", "cut_short"],
  abstainOnStageConfig: [],
  requiresCompletedStage: true,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    for (const s of stages) {
      const ranks = s.complete?.finalRanks ?? [];
      const counts = new Map<string, number>();
      for (const id of ranks) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const e of s.field) {
        checked++;
        const c = counts.get(e) ?? 0;
        if (c !== 1) fails.push(`${e} ${c === 0 ? "not ranked" : `ranked ${c}×`}`);
      }
      for (const id of counts.keys()) if (!s.field.includes(id)) fails.push(`${id} ranked but not in the field`);
      if (s.kind === "knockout" && s.field.length > 0) {
        checked++;
        const lost = new Set<string>();
        for (const f of s.fixtures.filter(seated)) {
          const w = winner(f);
          if (w === null) { if (TERMINAL.has(f.status) && f.outcome !== null) fails.push(`${f.id}: bracket fixture ended ${f.outcome.kind}`); continue; }
          lost.add(w === f.home ? f.away! : f.home!);
        }
        const unbeaten = s.field.filter((e) => !lost.has(e));
        if (unbeaten.length !== 1) fails.push(`${unbeaten.length} unbeaten entrants: ${unbeaten.join(",")}`);
        else if (ranks[0] !== unbeaten[0]) fails.push(`rank 1 is ${ranks[0] ?? "nobody"}, unbeaten is ${unbeaten[0]}`);
      }
    }
    return result(fails, checked);
  },
};

const I3: InvariantSpec = {
  id: "I3-table-points-equal-declared",
  description: "each table row's points equal Σ the sport's declared points over its results",
  stageKinds: ["league", "group", "swiss"],
  abstainOn: [],
  abstainOnStageConfig: ["points", "carry_deltas", "rank_overrides"],
  requiresCompletedStage: false,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    let skipped = 0;
    for (const s of stages) {
      const rows = new Map(s.standings.flatMap((p) => p.rows).map((r) => [r.entrantId, r]));
      const byEntrant = new Map<string, ObservedFixture[]>();
      for (const f of s.fixtures.filter((x) => seated(x) && TERMINAL.has(x.status))) {
        for (const e of [f.home!, f.away!]) byEntrant.set(e, [...(byEntrant.get(e) ?? []), f]);
      }
      for (const [e, fx] of byEntrant) if (!rows.has(e) && fx.some((f) => f.outcome !== null)) fails.push(`${e} has results but no row`);
      for (const [e, row] of rows) {
        // A fixture with NO outcome (voided/expunged) contributes 0. One WITH an
        // outcome counts only if the harness declared exactly that result; a
        // result the server wrote on its own (cascade walkover, bye) makes the
        // entrant unjudgeable here → skipped and counted.
        const fx = (byEntrant.get(e) ?? []).filter((f) => f.outcome !== null);
        if (fx.some((f) => f.declared === null || !sameOutcome(f.outcome, f.declared.forOutcome))) { skipped++; continue; }
        checked++;
        const expected = fx.reduce((sum, f) => sum + (f.home === e ? f.declared!.home : f.declared!.away), 0);
        if (row.points === null) fails.push(`${e}: row has no points`);
        else if (Math.abs(row.points - expected) > 1e-9) fails.push(`${e}: table ${row.points}, declared Σ ${expected}`);
      }
    }
    return result(fails, checked, skipped > 0 ? [`skipped ${skipped} entrant(s) with undeclared or changed results`] : []);
  },
};

const I4: InvariantSpec = {
  id: "I4-nothing-ends-stuck",
  description: "every generate/pair returns fixtures or a named refusal; every stage completes or refuses with a named reason",
  stageKinds: "any",
  abstainOn: ["cut_short"],
  abstainOnStageConfig: [],
  requiresCompletedStage: false,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    for (const s of stages) {
      for (const g of s.generates) {
        checked++;
        const ok2xx = g.status >= 200 && g.status < 300;
        if (ok2xx && g.total === 0) fails.push(`stage ${s.seq}: empty generate (R13)`);
        if (!ok2xx && g.code === null) fails.push(`stage ${s.seq}: generate refused ${g.status} with no code`);
      }
      for (const p of s.pairRounds) {
        checked++;
        if (p.seated === 0) fails.push(`stage ${s.seq}: round ${p.roundNo} paired nobody (SW-H1)`);
      }
      if (s.complete === null) { fails.push(`stage ${s.seq}: never asked to complete`); continue; }
      checked++;
      const refusedNamed = s.complete.status >= 400 && s.complete.code !== null;
      if (!s.complete.completed && !refusedNamed) fails.push(`stage ${s.seq}: did not complete and named no reason`);
      if (s.complete.completed) {
        for (const f of s.fixtures.filter(seated)) {
          checked++;
          if (!TERMINAL.has(f.status)) fails.push(`${f.id}: ${f.status} inside a completed stage`);
        }
      }
    }
    return result(fails, checked);
  },
};

const I5: InvariantSpec = {
  id: "I5-config-edit-never-rescores",
  description: "a config edit (accepted or refused) never changes a finished fixture's result",
  stageKinds: "any",
  abstainOn: [],
  abstainOnStageConfig: [],
  requiresCompletedStage: false,
  check(_stages, run) {
    const edit = run.configEdit;
    if (edit === null || edit.attempts.length === 0) return ABSTAIN("no config edit attempted");
    const fails: string[] = [];
    for (const b of edit.before) {
      const a = edit.after.find((x) => x.id === b.id);
      if (a === undefined) fails.push(`${b.id}: vanished after the edit`);
      else if (a.status !== b.status || !sameOutcome(a.outcome, b.outcome)) {
        fails.push(`${b.id}: ${b.status}/${winner(b) ?? b.outcome?.kind} → ${a.status}/${winner(a) ?? a.outcome?.kind}`);
      }
    }
    return result(fails, edit.before.length, edit.attempts.map((x) => `${x.kind}: ${x.status} ${x.code ?? ""}`.trim()));
  },
};

const I6: InvariantSpec = {
  id: "I6-swiss-no-rematch",
  description: "no two entrants meet twice in a swiss stage",
  stageKinds: ["swiss"],
  abstainOn: [],
  abstainOnStageConfig: [],
  requiresCompletedStage: false,
  check(stages) {
    const fails: string[] = [];
    let checked = 0;
    for (const s of stages) {
      const seen = new Map<string, number>();
      for (const f of s.fixtures.filter(seated)) {
        checked++;
        const k = pairKey(f.home!, f.away!);
        if (seen.has(k)) fails.push(`${k} rematched in rounds ${seen.get(k)} and ${f.roundNo}`);
        else seen.set(k, f.roundNo ?? 0);
      }
    }
    return result(fails, checked);
  },
};

export const INVARIANTS: readonly InvariantSpec[] = Object.freeze([I1, I2, I3, I4, I5, I6]);

export function evaluateInvariant(spec: InvariantSpec, run: ObservedRun): InvariantResult {
  const blocking = spec.abstainOn.filter((f) => run.facts.includes(f));
  if (blocking.length > 0) return ABSTAIN(`case fact ${blocking.join(", ")}`);
  let stages = spec.stageKinds === "any" ? run.stages : run.stages.filter((s) => (spec.stageKinds as readonly string[]).includes(s.kind));
  stages = stages.filter((s) => !spec.abstainOnStageConfig.some((k) => k in s.config));
  if (spec.requiresCompletedStage) stages = stages.filter((s) => s.complete?.completed === true);
  if (stages.length === 0) return ABSTAIN(`no applicable stage (${spec.stageKinds === "any" ? "any" : spec.stageKinds.join("/")})`);
  const r = spec.check(stages, run);
  // R25 — the guard every spec inherits.
  if (r.verdict === "pass" && r.checked === 0) return { verdict: "fail", checked: 0, evidence: ["checked 0 items (vacuous, R25)", ...r.evidence] };
  return r;
}

export function evaluateInvariants(run: ObservedRun): CheckResult[] {
  return INVARIANTS.map((spec) => {
    const r = evaluateInvariant(spec, run);
    return { id: spec.id, kind: "invariant", verdict: r.verdict, checked: r.checked, reason: r.verdict === "pass" ? spec.description : (r.evidence[0] ?? ""), evidence: r.evidence };
  });
}
```

- [ ] **Step 5: Run and see GREEN** (template, `<N>`=5, `<files>`=`scripts/matrix/__tests__/invariants.test.ts scripts/matrix/__tests__/boundary.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts`). The boundary test's type-only check now bites on the two new files.

- [ ] **Step 6: Mutation**
  - Delete the R25 guard in `evaluateInvariant` → the zero-count tests of I1, I2, I3, I5 and I6 go red. (I4's zero test fails on "never asked to complete", independently.)
  - I1: `times !== legs` → `times < 1` → "legs: 2 legs expects every pair twice" (the one-leg fixture set) and "a repeated pair".
  - I1: delete the `s.kind === "league"` field override → a league entrant with no fixtures escapes. Add a test `field ["a","b","c"], fixtures rr(["a","b"])` expecting `fail` if none of the existing tests kills it.
  - I2: delete the champion block → "negative: champion mismatch".
  - I3: tolerance `1e-9` → `1` → "negative: a row off by one".
  - I3: drop the `sameOutcome` skip → "skips an entrant whose result changed".
  - I3: remove the `outcome !== null` filter → "a voided fixture (no outcome) contributes 0". Without the filter the voided fixture's declared null/stale result skips `a` and `b`, so checked becomes 1 instead of 3.
  - I4: `ok2xx && g.total === 0` → `false` → "an empty 2xx generate".
  - I5: compare status only → "negative: the winner changed".
  - I6: `pairKey` → an ordered `${a}~${b}` → "a rematch with sides reversed".
  - Change `import type { CheckResult }` in invariants.ts to a value import → boundary test.

- [ ] **Step 7: Commit** (message: "feat(matrix): pure anti-vacuous invariants I1–I6 over an observed-run model")

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git add scripts/matrix/lib/observed.ts scripts/matrix/lib/invariants.ts scripts/matrix/__tests__/invariants.test.ts && git commit -F "$TMPDIR/fm-msg.txt" -- scripts/matrix
```

**Test types:**
- Unit: `invariants.test.ts` (24+ tests).
- E2E: Task 11 evaluates I1–I6 on 24 live observed runs.
- Smoke: loadable.
- Regression: the Step 6 mutants. The pure shape is the regression seam W1b and W10 attach to.

---

### Task 6: `OrganiserDriver` and `HttpDriver`

**Files:**
- Create: `scripts/matrix/lib/driver/types.ts`, `scripts/matrix/lib/driver/http-driver.ts`
- Create: `scripts/matrix/__tests__/http-driver.test.ts`

**Interfaces:**
- Consumes: `raw`, `newSession`, `Session`, `RawResult` from `scripts/bench/lib/http.ts`; `redact` (Task 4); `StagePostBody` (Task 1); `StreamEvent`, `START` (Task 2).
- Produces:
  ```ts
  // driver/types.ts
  export type EntrantKind = "individual" | "pair" | "team";
  export interface CompetitionRef { id: string; slug: string; orgId: string }
  export interface DivisionRef { id: string; slug: string; sportKey: string; variantKey: string; config: Record<string, unknown> }
  export interface StageRef { id: string; seq: number; kind: string; config: Record<string, unknown>; status: string }
  export interface EntrantRow { id: string; display_name: string; seed: number | null; status: string }
  export interface FixtureRow { id: string; stage_id: string; pool_id: string | null; round_no: number | null; fixture_no: number | null; home_entrant_id: string | null; away_entrant_id: string | null; status: string; outcome: unknown }
  export interface GenerateOut { created: number; existing: number; fixtures: FixtureRow[] }
  export interface StartOut { division_id: string; status: string; started: boolean; generated: number }
  export interface CompleteOut { completed: boolean; events: { type: string; finalRanks?: string[] }[]; division_completed?: boolean }
  export interface WithdrawOut { entrant_id: string; status: string; policy: "none" | "walkover" | "expunge"; walkovers: number; voided: number; skipped_finalized: number }
  export interface StandingsRowWire { entrantId: string; rank: number; points?: number; played?: number }
  export interface StandingsOut { stage_id: string; pool_id: string | null; rows: StandingsRowWire[] }
  export interface PublicStandingsOut { division_id: string; standings: { stage_id: string; pool_id: string | null; rows: StandingsRowWire[] }[] }
  export interface FixtureStateOut { status: string; last_seq: number; outcome: unknown }
  export interface PostedEvent { seq: number; status: string; outcome: unknown; event_id: string }
  export interface ProbeOutcome { status: number; code: string | null }
  export interface OrganiserDriver {
    createCompetition(input: { name: string; slug: string }): Promise<CompetitionRef>;
    createDivision(competitionId: string, input: { name: string; slug: string; sportKey: string; variantKey: string; config?: Record<string, unknown> }): Promise<DivisionRef>;
    getDivision(divisionId: string): Promise<DivisionRef>;
    postStages(divisionId: string, stages: readonly StagePostBody[]): Promise<StageRef[]>;
    listStages(divisionId: string): Promise<StageRef[]>;
    addEntrants(divisionId: string, entrants: readonly { displayName: string; seed: number; kind: EntrantKind }[]): Promise<EntrantRow[]>;
    start(divisionId: string): Promise<StartOut>;
    generate(stageId: string): Promise<GenerateOut>;
    listFixtures(divisionId: string): Promise<FixtureRow[]>;
    fixtureState(fixtureId: string): Promise<FixtureStateOut>;
    postStream(fixtureId: string, events: readonly StreamEvent[], idempotencyPrefix: string): Promise<PostedEvent[]>;
    forfeit(fixtureId: string, byEntrantId: string, reason: "walkover" | "retired hurt", idempotencyPrefix: string): Promise<PostedEvent[]>;
    withdraw(entrantId: string): Promise<WithdrawOut>;
    completeStage(stageId: string): Promise<CompleteOut>;
    standings(stageId: string, poolId: string | null): Promise<StandingsOut>;
    publicStandings(ref: { orgSlug: string; competitionSlug: string; divisionSlug: string }): Promise<PublicStandingsOut>;
    patchDivisionConfig(divisionId: string, config: Record<string, unknown>): Promise<ProbeOutcome>;  // a probe: returns the refusal, never throws on 4xx
    readonly callCount: number;
  }
  export class RefusedCall extends Error { readonly status: number; readonly code: string | null; readonly path: string }
  export class DriverMisuse extends Error {}
  export class OrgMismatch extends Error {}
  export class VisibilityDegraded extends Error {}
  // driver/http-driver.ts
  export interface Transport { raw(base: string, s: Session, path: string, method?: string, body?: unknown): Promise<RawResult> }
  export interface HttpDriverOptions { base: string; session: Session; expectedOrgId: string; transport?: Transport }
  export class HttpDriver implements OrganiserDriver { constructor(opts: HttpDriverOptions) }
  ```

Wire facts: see `plan-facts-api.md` §A–E. The envelope is `{ok:true, data}` or `{ok:false, error:{code, message, current_seq?}}`. `expected_seq` = `last_seq` from `GET /fixtures/:id/state`. The complete call returns `{completed:false}` with 200 when not ready. Public standings need visibility `unlisted`/`public`.

- [ ] **Step 1: Write the failing test** at `scripts/matrix/__tests__/http-driver.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { RawResult, Session } from "../../bench/lib/http.ts";
import { HttpDriver, type Transport } from "../lib/driver/http-driver.ts";
import { DriverMisuse, OrgMismatch, RefusedCall, VisibilityDegraded } from "../lib/driver/types.ts";
import { START } from "../lib/streams/types.ts";

interface Call { path: string; method: string; body: unknown; cookies: number }
function fake(replies: ((c: Call) => RawResult | undefined)[]): { t: Transport; calls: Call[] } {
  const calls: Call[] = [];
  const t: Transport = {
    async raw(_b: string, s: Session, path: string, method = "GET", body?: unknown) {
      const c = { path, method, body, cookies: Object.keys(s.cookies).length };
      calls.push(c);
      for (const r of replies) { const out = r(c); if (out) return out; }
      throw new Error(`fake: no reply for ${method} ${path}`);
    },
  };
  return { t, calls };
}
const ok = (data: unknown, status = 200): RawResult => ({ status, json: { ok: true, data } as never });
const err = (status: number, code: string, extra: Record<string, unknown> = {}): RawResult => ({ status, json: { ok: false, error: { code, message: `${code} token=abc123secret`, ...extra } } as never });
const session: Session = { cookies: { sid: "x" } };
const drv = (t: Transport) => new HttpDriver({ base: "http://localhost:3999", session, expectedOrgId: "org-1", transport: t });

describe("HttpDriver — org pinning (Review Focus 4)", () => {
  it("createCompetition sends unlisted + ends_on and refuses a competition in another org", async () => {
    const { t, calls } = fake([(c) => (c.path === "/api/v1/competitions" ? ok({ id: "c1", slug: "m-1", org_id: "org-2" }, 201) : undefined)]);
    await expect(drv(t).createCompetition({ name: "M", slug: "m-1" })).rejects.toBeInstanceOf(OrgMismatch);
    expect(calls[0]!.body).toMatchObject({ visibility: "unlisted", ends_on: "2030-12-31", slug: "m-1" });
  });
  it("a silently degraded visibility is an error, not a later public-read 404", async () => {
    const { t } = fake([() => ok({ id: "c1", slug: "m-1", org_id: "org-1", public_quota_degraded: true }, 201)]);
    await expect(drv(t).createCompetition({ name: "M", slug: "m-1" })).rejects.toBeInstanceOf(VisibilityDegraded);
  });
  it("the happy path returns the ref", async () => {
    const { t } = fake([() => ok({ id: "c1", slug: "m-1", org_id: "org-1" }, 201)]);
    expect(await drv(t).createCompetition({ name: "M", slug: "m-1" })).toEqual({ id: "c1", slug: "m-1", orgId: "org-1" });
  });
});

describe("HttpDriver — postStream (Review Focus 5)", () => {
  it("empty stream posts nothing and reads nothing", async () => {
    const { t, calls } = fake([]);
    expect(await drv(t).postStream("f1", [], "k")).toEqual([]);
    expect(calls).toEqual([]);
  });
  it("reads last_seq first (a server cascade left it at 2) and chains the returned seq", async () => {
    let seq = 2;
    const { t, calls } = fake([
      (c) => (c.path === "/api/v1/fixtures/f1/state" ? ok({ status: "in_play", last_seq: 2, outcome: null }) : undefined),
      (c) => (c.path === "/api/v1/fixtures/f1/events" ? ok({ seq: ++seq, status: "in_play", outcome: null, event_id: `e${seq}` }, 201) : undefined),
    ]);
    const out = await drv(t).postStream("f1", [START, { type: "generic.result", payload: { p1Score: 1, p2Score: 0 } }], "run:f1");
    expect(out.map((e) => e.seq)).toEqual([3, 4]);
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.body as { expected_seq: number; idempotency_key: string });
    expect(posts.map((p) => p.expected_seq)).toEqual([2, 3]);
    expect(posts.map((p) => p.idempotency_key)).toEqual(["run:f1:0", "run:f1:1"]);
  });
  it("retries a SEQ_CONFLICT exactly once from current_seq with a fresh key", async () => {
    let n = 0;
    const { t, calls } = fake([
      (c) => (c.path.endsWith("/state") ? ok({ status: "scheduled", last_seq: 0, outcome: null }) : undefined),
      () => (n++ === 0 ? err(409, "SEQ_CONFLICT", { current_seq: 1 }) : ok({ seq: 2, status: "in_play", outcome: null, event_id: "e2" }, 201)),
    ]);
    const out = await drv(t).postStream("f1", [START], "k");
    expect(out[0]!.seq).toBe(2);
    const bodies = calls.filter((c) => c.method === "POST").map((c) => c.body as { expected_seq: number; idempotency_key: string });
    expect(bodies).toEqual([expect.objectContaining({ expected_seq: 0, idempotency_key: "k:0" }), expect.objectContaining({ expected_seq: 1, idempotency_key: "k:0:retry" })]);
  });
  it("a second conflict surfaces as RefusedCall with its code, redacted", async () => {
    const { t } = fake([(c) => (c.path.endsWith("/state") ? ok({ status: "scheduled", last_seq: 0, outcome: null }) : undefined), () => err(409, "SEQ_CONFLICT", { current_seq: 1 })]);
    const e = await drv(t).postStream("f1", [START], "k").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RefusedCall);
    expect((e as RefusedCall).code).toBe("SEQ_CONFLICT");
    expect((e as RefusedCall).message).not.toContain("abc123secret");
  });
  it("forfeit on a scheduled fixture posts exactly the composed [core.start, core.forfeit]", async () => {
    let seq = 0;
    const { t, calls } = fake([
      (c) => (c.path.endsWith("/state") ? ok({ status: "scheduled", last_seq: 0, outcome: null }) : undefined),
      () => ok({ seq: ++seq, status: seq === 2 ? "forfeited" : "in_play", outcome: null, event_id: `e${seq}` }, 201),
    ]);
    await drv(t).forfeit("f1", "ent-b", "walkover", "k");
    const types = calls.filter((c) => c.method === "POST").map((c) => c.body as { type: string; payload: unknown });
    expect(types).toEqual([
      expect.objectContaining({ type: "core.start", payload: {} }),
      expect.objectContaining({ type: "core.forfeit", payload: { by: "ent-b", reason: "walkover" } }),
    ]);
  });
});

describe("HttpDriver — completeStage is never repeated after completion (design §6.4)", () => {
  it("completed:false may be retried; after completed:true a second call is DriverMisuse with no HTTP", async () => {
    let done = false;
    const { t, calls } = fake([() => { const r = ok({ completed: done, events: done ? [{ type: "stage_completed", finalRanks: ["a"] }] : [] }); done = true; return r; }]);
    const d = drv(t);
    expect((await d.completeStage("s1")).completed).toBe(false);
    expect((await d.completeStage("s1")).completed).toBe(true);
    await expect(d.completeStage("s1")).rejects.toBeInstanceOf(DriverMisuse);
    expect(calls.length).toBe(2);
  });
});

describe("HttpDriver — reads and probes", () => {
  it("public standings go out with NO cookies (anonymous) and the public path", async () => {
    const { t, calls } = fake([() => ok({ division_id: "d1", standings: [] })]);
    await drv(t).publicStandings({ orgSlug: "o", competitionSlug: "c", divisionSlug: "d" });
    expect(calls[0]).toMatchObject({ path: "/api/v1/public/orgs/o/competitions/c/divisions/d/standings", cookies: 0 });
  });
  it("patchDivisionConfig returns a refusal instead of throwing", async () => {
    const { t } = fake([() => err(409, "FORMAT_LOCKED")]);
    expect(await drv(t).patchDivisionConfig("d1", { setTo: 15 })).toEqual({ status: 409, code: "FORMAT_LOCKED" });
  });
  it("start always acknowledges warnings; standings pass pool_id only when set", async () => {
    const { t, calls } = fake([
      (c) => (c.path.includes("/start") ? ok({ division_id: "d1", status: "active", started: true, generated: 6 }) : undefined),
      () => ok({ stage_id: "s1", pool_id: null, rows: [] }),
    ]);
    const d = drv(t);
    await d.start("d1");
    await d.standings("s1", null);
    await d.standings("s1", "p1");
    expect(calls[0]!.body).toEqual({ acknowledge_warnings: true });
    expect(calls.slice(1).map((c) => c.path)).toEqual(["/api/v1/stages/s1/standings", "/api/v1/stages/s1/standings?pool_id=p1"]);
  });
  it("any other non-2xx is RefusedCall carrying status, code and path", async () => {
    const { t } = fake([() => err(422, "STAGE_NOT_READY")]);
    const e = (await drv(t).generate("s1").catch((x: unknown) => x)) as RefusedCall;
    expect([e.status, e.code, e.path]).toEqual([422, "STAGE_NOT_READY", "/api/v1/stages/s1/generate"]);
  });
  it("counts every HTTP call", async () => {
    const { t } = fake([() => ok({ created: 0, existing: 1, fixtures: [] })]);
    const d = drv(t);
    await d.generate("s1");
    await d.generate("s1");
    expect(d.callCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run and see RED** (template, `<N>`=6a, `<files>`=`scripts/matrix/__tests__/http-driver.test.ts`).

- [ ] **Step 3: Implement `scripts/matrix/lib/driver/types.ts`** with the interfaces exactly as in the Interfaces block, plus:

```ts
import { redact } from "../redact.ts";

export class RefusedCall extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly path: string;
  constructor(path: string, status: number, code: string | null, message: string | null) {
    super(redact(`${path} → HTTP ${status} ${code ?? "(no code)"}: ${message ?? "(no message)"}`));
    this.name = "RefusedCall";
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

export class DriverMisuse extends Error {
  constructor(message: string) { super(message); this.name = "DriverMisuse"; }
}

export class OrgMismatch extends Error {
  constructor(expected: string, got: string) {
    super(`driver: competition landed in org ${got}, expected ${expected} — the active-org switch did not hold`);
    this.name = "OrgMismatch";
  }
}

export class VisibilityDegraded extends Error {
  constructor(slug: string) {
    super(`driver: competition ${slug} was degraded to private (public_quota_degraded) — public reads would 404`);
    this.name = "VisibilityDegraded";
  }
}
```

- [ ] **Step 4: Implement `scripts/matrix/lib/driver/http-driver.ts`**

```ts
// The organiser, over the real v1 API (design §6.1). Every write that can race
// a server-side cascade reads its sequence first; /complete is never repeated
// once it has completed (design §6.4, stages.ts:4140).
import { newSession, raw as benchRaw, type RawResult, type Session } from "../../../bench/lib/http.ts";
import type { StagePostBody } from "../catalogue.ts";
import { START, type StreamEvent } from "../streams/types.ts";
import {
  DriverMisuse, OrgMismatch, RefusedCall, VisibilityDegraded,
  type CompetitionRef, type CompleteOut, type DivisionRef, type EntrantKind, type EntrantRow, type FixtureRow,
  type FixtureStateOut, type GenerateOut, type OrganiserDriver, type PostedEvent, type ProbeOutcome,
  type PublicStandingsOut, type StageRef, type StandingsOut, type StartOut, type WithdrawOut,
} from "./types.ts";

export interface Transport {
  raw(base: string, s: Session, path: string, method?: string, body?: unknown): Promise<RawResult>;
}

export interface HttpDriverOptions {
  base: string;
  session: Session;
  expectedOrgId: string;
  transport?: Transport;
}

interface Envelope { ok?: boolean; data?: unknown; error?: { code?: string; message?: string; current_seq?: number } }

const errorOf = (r: RawResult) => ((r.json as unknown as Envelope)?.error ?? {});
const toDivisionRef = (d: { id: string; slug: string; sport_key: string; variant_key: string; config: Record<string, unknown> | null }): DivisionRef =>
  ({ id: d.id, slug: d.slug, sportKey: d.sport_key, variantKey: d.variant_key, config: d.config ?? {} });

export class HttpDriver implements OrganiserDriver {
  readonly #base: string;
  readonly #session: Session;
  readonly #anon: Session;
  readonly #expectedOrgId: string;
  readonly #t: Transport;
  readonly #completed = new Set<string>();
  #calls = 0;

  constructor(opts: HttpDriverOptions) {
    this.#base = opts.base;
    this.#session = opts.session;
    this.#anon = newSession();
    this.#expectedOrgId = opts.expectedOrgId;
    this.#t = opts.transport ?? { raw: benchRaw };
  }

  get callCount(): number { return this.#calls; }

  async #send(path: string, method = "GET", body?: unknown, anonymous = false): Promise<RawResult> {
    this.#calls++;
    return this.#t.raw(this.#base, anonymous ? this.#anon : this.#session, path, method, body);
  }

  async #call<T>(path: string, method = "GET", body?: unknown, anonymous = false): Promise<T> {
    const r = await this.#send(path, method, body, anonymous);
    if (r.status < 200 || r.status >= 300) {
      const e = errorOf(r);
      throw new RefusedCall(path, r.status, e.code ?? null, e.message ?? null);
    }
    const data = (r.json as unknown as Envelope)?.data;
    if (data === undefined) throw new RefusedCall(path, r.status, "NO_DATA", "response carried no data");
    return data as T;
  }

  async createCompetition(input: { name: string; slug: string }): Promise<CompetitionRef> {
    const c = await this.#call<{ id: string; slug: string; org_id: string; public_quota_degraded?: boolean }>(
      "/api/v1/competitions", "POST", { name: input.name, slug: input.slug, ends_on: "2030-12-31", visibility: "unlisted" });
    if (c.org_id !== this.#expectedOrgId) throw new OrgMismatch(this.#expectedOrgId, c.org_id);
    if (c.public_quota_degraded === true) throw new VisibilityDegraded(c.slug);
    return { id: c.id, slug: c.slug, orgId: c.org_id };
  }

  async createDivision(competitionId: string, input: { name: string; slug: string; sportKey: string; variantKey: string; config?: Record<string, unknown> }): Promise<DivisionRef> {
    return toDivisionRef(await this.#call(`/api/v1/competitions/${competitionId}/divisions`, "POST", {
      name: input.name, slug: input.slug, sport_key: input.sportKey, variant_key: input.variantKey, config: input.config ?? {},
    }));
  }

  async getDivision(divisionId: string): Promise<DivisionRef> {
    return toDivisionRef(await this.#call(`/api/v1/divisions/${divisionId}`));
  }

  async postStages(divisionId: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
    const out = await this.#call<StageRef | StageRef[]>(`/api/v1/divisions/${divisionId}/stages`, "POST", stages);
    return Array.isArray(out) ? out : [out];
  }

  async listStages(divisionId: string): Promise<StageRef[]> {
    return this.#call(`/api/v1/divisions/${divisionId}/stages`);
  }

  async addEntrants(divisionId: string, entrants: readonly { displayName: string; seed: number; kind: EntrantKind }[]): Promise<EntrantRow[]> {
    const out = await this.#call<EntrantRow | EntrantRow[]>(`/api/v1/divisions/${divisionId}/entrants`, "POST",
      entrants.map((e) => ({ kind: e.kind, display_name: e.displayName, seed: e.seed })));
    return Array.isArray(out) ? out : [out];
  }

  async start(divisionId: string): Promise<StartOut> {
    return this.#call(`/api/v1/divisions/${divisionId}/start`, "POST", { acknowledge_warnings: true });
  }

  async generate(stageId: string): Promise<GenerateOut> {
    return this.#call(`/api/v1/stages/${stageId}/generate`, "POST", {});
  }

  async listFixtures(divisionId: string): Promise<FixtureRow[]> {
    return this.#call(`/api/v1/divisions/${divisionId}/fixtures`);
  }

  async fixtureState(fixtureId: string): Promise<FixtureStateOut> {
    return this.#call(`/api/v1/fixtures/${fixtureId}/state`);
  }

  async postStream(fixtureId: string, events: readonly StreamEvent[], idempotencyPrefix: string): Promise<PostedEvent[]> {
    if (events.length === 0) return [];
    const path = `/api/v1/fixtures/${fixtureId}/events`;
    let seq = (await this.fixtureState(fixtureId)).last_seq;
    const out: PostedEvent[] = [];
    for (const [i, ev] of events.entries()) {
      const body = { expected_seq: seq, type: ev.type, payload: ev.payload, idempotency_key: `${idempotencyPrefix}:${i}` };
      let r = await this.#send(path, "POST", body);
      if (r.status === 409 && errorOf(r).code === "SEQ_CONFLICT" && typeof errorOf(r).current_seq === "number") {
        // A server-side cascade (withdrawal walkover, swiss bye) appended since
        // we read. Retry ONCE from the server's seq, under a fresh key: the
        // refused attempt must not be replayed from the idempotency store.
        r = await this.#send(path, "POST", { ...body, expected_seq: errorOf(r).current_seq, idempotency_key: `${body.idempotency_key}:retry` });
      }
      if (r.status < 200 || r.status >= 300) {
        const e = errorOf(r);
        throw new RefusedCall(path, r.status, e.code ?? null, e.message ?? null);
      }
      const posted = (r.json as unknown as Envelope).data as PostedEvent;
      seq = posted.seq;
      out.push(posted);
    }
    return out;
  }

  async forfeit(fixtureId: string, byEntrantId: string, reason: "walkover" | "retired hurt", idempotencyPrefix: string): Promise<PostedEvent[]> {
    const state = await this.fixtureState(fixtureId);
    const forfeitEv: StreamEvent = { type: "core.forfeit", payload: { by: byEntrantId, reason } };
    // Identical to generateStream's forfeit composition on a scheduled fixture
    // (streams/index.ts), so the declared points the scenario folds locally are
    // for exactly the events posted here.
    return this.postStream(fixtureId, state.status === "scheduled" ? [START, forfeitEv] : [forfeitEv], idempotencyPrefix);
  }

  async withdraw(entrantId: string): Promise<WithdrawOut> {
    return this.#call(`/api/v1/entrants/${entrantId}/withdraw`, "POST", {});
  }

  async completeStage(stageId: string): Promise<CompleteOut> {
    if (this.#completed.has(stageId)) {
      throw new DriverMisuse(`driver: stage ${stageId} already completed — /complete is never repeated (design §6.4)`);
    }
    const out = await this.#call<CompleteOut>(`/api/v1/stages/${stageId}/complete`, "POST", {});
    if (out.completed) this.#completed.add(stageId);
    return out;
  }

  async standings(stageId: string, poolId: string | null): Promise<StandingsOut> {
    return this.#call(`/api/v1/stages/${stageId}/standings${poolId === null ? "" : `?pool_id=${encodeURIComponent(poolId)}`}`);
  }

  async publicStandings(ref: { orgSlug: string; competitionSlug: string; divisionSlug: string }): Promise<PublicStandingsOut> {
    return this.#call(`/api/v1/public/orgs/${ref.orgSlug}/competitions/${ref.competitionSlug}/divisions/${ref.divisionSlug}/standings`, "GET", undefined, true);
  }

  async patchDivisionConfig(divisionId: string, config: Record<string, unknown>): Promise<ProbeOutcome> {
    const r = await this.#send(`/api/v1/divisions/${divisionId}`, "PATCH", { config });
    return { status: r.status, code: r.status >= 200 && r.status < 300 ? null : (errorOf(r).code ?? null) };
  }
}
```
`#private` fields are standard JS, so they are strip-types safe. Parameter properties are not used.

- [ ] **Step 5: Run and see GREEN** (template, `<N>`=6, `<files>`=`scripts/matrix/__tests__/http-driver.test.ts scripts/matrix/__tests__/boundary.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts`).

- [ ] **Step 6: Mutation**
  - Delete the `org_id` check → "refuses a competition in another org".
  - Start `seq` at 0 instead of reading state → "reads last_seq first".
  - Delete the SEQ_CONFLICT retry → "retries a SEQ_CONFLICT exactly once".
  - Reuse the same idempotency key on retry → same test (the key assertion).
  - Remove the `#completed` guard → "after completed:true a second call is DriverMisuse".
  - Add to `#completed` even when `completed:false` → "completed:false may be retried".
  - Public standings with `anonymous=false` → "go out with NO cookies".
  - Drop `redact` in `RefusedCall` → "redacted".

- [ ] **Step 7: Commit** (message: "feat(matrix): OrganiserDriver + HttpDriver over the bench http helper")

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git add scripts/matrix/lib/driver scripts/matrix/__tests__/http-driver.test.ts && git commit -F "$TMPDIR/fm-msg.txt" -- scripts/matrix
```

**Test types:**
- Unit: `http-driver.test.ts` (fake transport).
- E2E: Task 11. Every method is exercised against the real server by the 24 cases. `getDivision`, `listStages` and `patchDivisionConfig` are exercised by `configProbe`/`setUpDivision`. No method is inert (class 1): Task 8's fake driver implements the same interface, and Task 8's order test lists the calls.
- Smoke: loadable.
- Regression: the Step 6 mutants.

---

### Task 7: Org and plan seeding in the harness's own DB, and the DB guard

**Files:**
- Create: `scripts/matrix/lib/seed-org.ts`
- Create: `scripts/matrix/__tests__/seed-org.test.ts`

**Interfaces:**
- Consumes: `provisionPlan`, `PlanCandidateInfo`, `PlanSql` from `scripts/bench/lib/plan.ts`; `Session` from `scripts/bench/lib/http.ts`; `Transport` (Task 6).
- Produces:
  ```ts
  export interface MatrixSql {
    userIdForEmail(email: string): Promise<string>;
    insertCaseOrg(input: { userId: string; name: string; slug: string }): Promise<{ orgId: string; orgSlug: string }>;
    listPlanKeys(): Promise<string[]>;
    variantKeysInBuilderOrder(sportKey: string): Promise<string[]>;
  }
  export class DataDirUnset extends Error {}
  export function requireOwnDataDir(env: Readonly<Record<string, string | undefined>>): string;
  export class NoPublicPlan extends Error {}
  export function chooseTopPublicPlan(candidates: readonly PlanCandidateInfo[]): string;
  export class OrgSwitchFailed extends Error {}
  export function orgIdsFromListing(json: unknown): string[];
  export async function switchToCaseOrg(t: Transport, base: string, session: Session, orgId: string): Promise<void>;
  export interface PrepareCaseOrgDeps { sql: MatrixSql; transport: Transport; base: string; session: Session; userId: string; plan: string; provision: (orgId: string, plan: string) => Promise<void> }
  export async function prepareCaseOrg(deps: PrepareCaseOrgDeps, input: { name: string; slug: string }): Promise<{ orgId: string; orgSlug: string }>;
  export function ownerEmail(runId: string): string;          // delivered+matrix-<runId>@resend.dev
  export function createRealMatrixSql(): { sql: MatrixSql; dispose: () => Promise<void> };
  ```

Why SQL rather than `POST /api/orgs`: that route exists, but it is capped by `orgs.max_owned` per user. One run needs one org per case (24 in the slice), so the harness mirrors `createOrgForUser`'s three inserts. It follows the bench's `setPlan` SQL precedent (design §9). A text pin reds when the product's inserts change.

- [ ] **Step 1: Write the failing test** at `scripts/matrix/__tests__/seed-org.test.ts`

```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RawResult, Session } from "../../bench/lib/http.ts";
import type { Transport } from "../lib/driver/http-driver.ts";
import {
  DataDirUnset, NoPublicPlan, OrgSwitchFailed, chooseTopPublicPlan, orgIdsFromListing, ownerEmail, prepareCaseOrg,
  requireOwnDataDir, switchToCaseOrg, type MatrixSql,
} from "../lib/seed-org.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const session: Session = { cookies: {} };
const ok = (json: unknown): RawResult => ({ status: 200, json: json as never });

describe("requireOwnDataDir (Review Focus 3) — empty first", () => {
  it("unset or blank refuses before any SQL", () => {
    expect(() => requireOwnDataDir({})).toThrow(DataDirUnset);
    expect(() => requireOwnDataDir({ BENCH_EXPECTED_DATA_DIR: "  " })).toThrow(DataDirUnset);
  });
  it("set returns the dir (runPreflight then compares it with show data_directory)", () => {
    expect(requireOwnDataDir({ BENCH_EXPECTED_DATA_DIR: "/tmp/pg-fm" })).toBe("/tmp/pg-fm");
  });
});

describe("chooseTopPublicPlan — empty first", () => {
  it("no candidates, or none public, refuses", () => {
    expect(() => chooseTopPublicPlan([])).toThrow(NoPublicPlan);
    expect(() => chooseTopPublicPlan([{ plan_key: "staff", is_public: false, privilege: 99 }])).toThrow(NoPublicPlan);
  });
  it("highest privilege among PUBLIC plans; ties by codepoint key", () => {
    expect(chooseTopPublicPlan([
      { plan_key: "community", is_public: true, privilege: 3 },
      { plan_key: "secret", is_public: false, privilege: 50 },
      { plan_key: "pro", is_public: true, privilege: 9 },
      { plan_key: "org", is_public: true, privilege: 9 },
    ])).toBe("org");
  });
});

describe("switchToCaseOrg (Review Focus 4)", () => {
  const transport = (listing: unknown, switchStatus = 200): { t: Transport; paths: string[] } => {
    const paths: string[] = [];
    return { paths, t: { async raw(_b, _s, path, method = "GET") { paths.push(`${method} ${path}`); return path === "/api/orgs/active" ? { status: switchStatus, json: {} as never } : ok(listing); } } };
  };
  it("switches, then proves the org is listed", async () => {
    const { t, paths } = transport([{ id: "o1" }, { id: "o2" }]);
    await switchToCaseOrg(t, "http://localhost:1", session, "o2");
    expect(paths).toEqual(["POST /api/orgs/active", "GET /api/orgs"]);
  });
  it("a listing without the org is OrgSwitchFailed naming the user-orgs cache", async () => {
    const { t } = transport({ orgs: [{ id: "o1" }] });
    await expect(switchToCaseOrg(t, "http://localhost:1", session, "o2")).rejects.toThrow(/orgs:<uid>/);
  });
  it("a refused switch is OrgSwitchFailed", async () => {
    const { t } = transport([{ id: "o2" }], 403);
    await expect(switchToCaseOrg(t, "http://localhost:1", session, "o2")).rejects.toBeInstanceOf(OrgSwitchFailed);
  });
  it("orgIdsFromListing accepts array, {orgs}, {data}; refuses anything else", () => {
    expect(orgIdsFromListing([{ id: "a" }])).toEqual(["a"]);
    expect(orgIdsFromListing({ orgs: [{ id: "b" }] })).toEqual(["b"]);
    expect(orgIdsFromListing({ data: [{ id: "c" }] })).toEqual(["c"]);
    expect(() => orgIdsFromListing({ nope: 1 })).toThrow();
  });
});

describe("prepareCaseOrg", () => {
  it("inserts, switches, then provisions — in that order", async () => {
    const order: string[] = [];
    const sql: MatrixSql = {
      async userIdForEmail() { return "u1"; },
      async insertCaseOrg(i) { order.push(`insert ${i.slug}`); return { orgId: "o9", orgSlug: i.slug }; },
      async listPlanKeys() { return []; },
      async variantKeysInBuilderOrder() { return []; },
    };
    const t: Transport = { async raw(_b, _s, path, method = "GET") { order.push(`${method} ${path}`); return path === "/api/orgs" ? ok([{ id: "o9" }]) : ok({}); } };
    const out = await prepareCaseOrg({ sql, transport: t, base: "http://localhost:1", session, userId: "u1", plan: "pro", provision: async (o, p) => { order.push(`provision ${o} ${p}`); } }, { name: "Matrix 1", slug: "m-r-1" });
    expect(out).toEqual({ orgId: "o9", orgSlug: "m-r-1" });
    expect(order).toEqual(["insert m-r-1", "POST /api/orgs/active", "GET /api/orgs", "provision o9 pro"]);
  });
  it("ownerEmail is synthetic and slug-safe (R14a)", () => {
    expect(ownerEmail("fm-w1a-a")).toBe("delivered+matrix-fm-w1a-a@resend.dev");
  });
});

describe("mirror pin: createOrgForUser's inserts (a product change reds here)", () => {
  it("still inserts subscriptions, organizations, org_members with the columns seed-org mirrors", () => {
    const auth = readFileSync(resolve(REPO, "apps/web/src/lib/auth.ts"), "utf8");
    const body = auth.slice(auth.indexOf("export async function createOrgForUser"));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/insert into subscriptions\s*\(\s*owner_user_id,\s*plan_key,\s*status,\s*quantity_paid/);
    expect(body).toMatch(/insert into organizations\s*\(\s*name,\s*slug,\s*created_by,\s*subscription_id/);
    expect(body).toMatch(/insert into org_members\s*\(\s*org_id,\s*user_id,\s*role\s*\)/);
  });
});
```
The executor opens `createOrgForUser` first and adjusts these three regexes to its **actual** whitespace and column order (a read, not a guess, class 5). The columns mirrored in Step 3 must equal what the regexes pin.

- [ ] **Step 2: Run and see RED** (template, `<N>`=7a, `<files>`=`scripts/matrix/__tests__/seed-org.test.ts`).

- [ ] **Step 3: Implement `scripts/matrix/lib/seed-org.ts`**

```ts
// One org per case, seeded by SQL in the harness's OWN DB (design §6.4, §9;
// bench setPlan precedent). Mirrors createOrgForUser (apps/web/src/lib/auth.ts)
// — pinned by seed-org.test.ts. Refuses to run on a DB it cannot prove is its
// own: BENCH_EXPECTED_DATA_DIR is MANDATORY here, because the bench preflight
// only compares data_directory when it is set (env.ts:442-452).
import postgres from "postgres";
import type { Session } from "../../bench/lib/http.ts";
import type { PlanCandidateInfo } from "../../bench/lib/plan.ts";
import type { Transport } from "./driver/http-driver.ts";

export interface MatrixSql {
  userIdForEmail(email: string): Promise<string>;
  insertCaseOrg(input: { userId: string; name: string; slug: string }): Promise<{ orgId: string; orgSlug: string }>;
  listPlanKeys(): Promise<string[]>;
  variantKeysInBuilderOrder(sportKey: string): Promise<string[]>;
}

export class DataDirUnset extends Error {
  constructor() {
    super("seed-org: BENCH_EXPECTED_DATA_DIR is unset — the matrix refuses to write to a database it cannot prove is its own (R14; seazn-local-env `env`)");
    this.name = "DataDirUnset";
  }
}

export function requireOwnDataDir(env: Readonly<Record<string, string | undefined>>): string {
  const dir = env.BENCH_EXPECTED_DATA_DIR?.trim();
  if (dir === undefined || dir === "") throw new DataDirUnset();
  return dir;
}

export class NoPublicPlan extends Error {
  constructor() { super("seed-org: no public plan in the catalogue — is this a fresh DB with sync run?"); this.name = "NoPublicPlan"; }
}

/** The most-privileged plan a real customer can buy, so no format is refused
 *  for want of a feature (the ⛔ state is W1b's, with an explicit deny). */
export function chooseTopPublicPlan(candidates: readonly PlanCandidateInfo[]): string {
  const pub = candidates.filter((c) => c.is_public);
  if (pub.length === 0) throw new NoPublicPlan();
  return [...pub].sort((a, b) => b.privilege - a.privilege || (a.plan_key < b.plan_key ? -1 : a.plan_key > b.plan_key ? 1 : 0))[0]!.plan_key;
}

export class OrgSwitchFailed extends Error {
  constructor(orgId: string, why: string) {
    super(`seed-org: could not make ${orgId} the active org — ${why}. If Redis is configured, the user-orgs cache (orgs:<uid>, 120s) may be stale`);
    this.name = "OrgSwitchFailed";
  }
}

export function orgIdsFromListing(json: unknown): string[] {
  const list = Array.isArray(json) ? json
    : Array.isArray((json as { orgs?: unknown })?.orgs) ? (json as { orgs: unknown[] }).orgs
    : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data
    : null;
  if (list === null) throw new Error("seed-org: unrecognised GET /api/orgs shape");
  return list.map((o) => String((o as { id?: unknown }).id));
}

export async function switchToCaseOrg(t: Transport, base: string, session: Session, orgId: string): Promise<void> {
  const sw = await t.raw(base, session, "/api/orgs/active", "POST", { org_id: orgId });
  if (sw.status < 200 || sw.status >= 300) throw new OrgSwitchFailed(orgId, `POST /api/orgs/active → ${sw.status}`);
  const listed = await t.raw(base, session, "/api/orgs", "GET");
  if (!orgIdsFromListing(listed.json).includes(orgId)) throw new OrgSwitchFailed(orgId, "the org is not in GET /api/orgs");
}

export interface PrepareCaseOrgDeps {
  sql: MatrixSql;
  transport: Transport;
  base: string;
  session: Session;
  userId: string;
  plan: string;
  provision: (orgId: string, plan: string) => Promise<void>;
}

export async function prepareCaseOrg(deps: PrepareCaseOrgDeps, input: { name: string; slug: string }): Promise<{ orgId: string; orgSlug: string }> {
  const org = await deps.sql.insertCaseOrg({ userId: deps.userId, name: input.name, slug: input.slug });
  await switchToCaseOrg(deps.transport, deps.base, deps.session, org.orgId);
  await deps.provision(org.orgId, deps.plan);
  return org;
}

export function ownerEmail(runId: string): string {
  return `delivered+matrix-${runId}@resend.dev`;
}

export function createRealMatrixSql(): { sql: MatrixSql; dispose: () => Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("seed-org: DATABASE_URL is not set (seazn-local-env `env`)");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const db = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  const sql: MatrixSql = {
    async userIdForEmail(email) {
      const [row] = await db<{ id: string }[]>`select id from users where lower(email) = lower(${email})`;
      if (!row) throw new Error("seed-org: the signed-in owner has no users row");
      return row.id;
    },
    async insertCaseOrg({ userId, name, slug }) {
      return db.begin(async (tx) => {
        const [sub] = await tx<{ id: string }[]>`
          insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
          values (${userId}, 'community', 'active', 1) returning id`;
        const [org] = await tx<{ id: string; slug: string }[]>`
          insert into organizations (name, slug, created_by, subscription_id)
          values (${name}, ${slug}, ${userId}, ${sub!.id}) returning id, slug`;
        await tx`insert into org_members (org_id, user_id, role) values (${org!.id}, ${userId}, 'owner')`;
        return { orgId: org!.id, orgSlug: org!.slug };
      });
    },
    async listPlanKeys() {
      return (await db<{ key: string }[]>`select key from plans order by key`).map((r) => r.key);
    },
    async variantKeysInBuilderOrder(sportKey) {
      // d/new/page.tsx:50-54 — the SYSTEM rows the builder lists, in its order.
      return (await db<{ key: string }[]>`
        select key from sport_variants where sport_key = ${sportKey} and org_id is null
        order by is_system desc, name`).map((r) => r.key);
    },
  };
  return { sql, dispose: async () => { await db.end({ timeout: 5 }); } };
}
```
The executor re-reads `d/new/page.tsx:50-54` and matches its `where` clause exactly: whether it filters `org_id is null` or `is_system`, and whether it scopes to the org. Record the actual query in the task report.

- [ ] **Step 4: Run and see GREEN** (template, `<N>`=7, `<files>`=`scripts/matrix/__tests__/seed-org.test.ts scripts/matrix/__tests__/boundary.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts`).

- [ ] **Step 5: Mutation**
  - `requireOwnDataDir`: drop the `trim() === ""` check → "unset or blank refuses".
  - `chooseTopPublicPlan`: remove the `is_public` filter → "none public refuses" and the `secret` case.
  - `switchToCaseOrg`: skip the listing check → "a listing without the org is OrgSwitchFailed".
  - `prepareCaseOrg`: provision before switch → the order test.
  - Change `'owner'` to `'admin'` in `insertCaseOrg` → **not killable DB-free.** Record it as covered by Task 11 (the owner's switch/provision would 403).

- [ ] **Step 6: Commit** (message: "feat(matrix): SQL org seeding with a mandatory own-DB guard and verified org switch")

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git add scripts/matrix/lib/seed-org.ts scripts/matrix/__tests__/seed-org.test.ts && git commit -F "$TMPDIR/fm-msg.txt" -- scripts/matrix
```

**Test types:**
- Unit: `seed-org.test.ts`.
- E2E: Task 11 seeds 24 orgs live and switches each.
- Smoke: loadable. `createRealMatrixSql` is imported but opens no connection until called.
- Regression: the Step 5 mutants, plus the mirror pin.

---

### Task 8: Scenarios — LIFECYCLE and the pilots M1, R4, F1

**Files:**
- Create: `scripts/matrix/lib/scenarios/types.ts`, `common.ts`, `assertions.ts`, `lifecycle.ts`, `m1-walkover.ts`, `r4-withdrawal.ts`, `f1-odd-field.ts`, `index.ts`
- Create: `scripts/matrix/__tests__/fake-driver.ts` (test helper; excluded from the loadable/boundary walk because it lives in `__tests__`)
- Create: `scripts/matrix/__tests__/scenarios.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  ```ts
  // scenarios/types.ts
  export type ScenarioKey = "LIFECYCLE" | "M1" | "R4" | "F1";
  export interface CaseSpec { caseId: string; row: TemplateRowKey; sport: string; variant: string; scenario: ScenarioKey; canary: boolean }
  export interface ScenarioContext { driver: OrganiserDriver; spec: CaseSpec; orgSlug: string; cfg: unknown; tag: string }
  export interface ScenarioOutput { observed: ObservedRun; assertions: CheckResult[] }
  export interface Scenario { key: ScenarioKey; entrantCount: number; canaryCheck: string | null; run(ctx: ScenarioContext): Promise<ScenarioOutput> }
  export class ScenarioUnsupported extends Error { readonly wave: string }
  // scenarios/common.ts
  export interface DivisionSetup { competition: CompetitionRef; division: DivisionRef; stage: StageRef; entrants: EntrantRow[]; seedOf: (id: string) => number; idOfSeed: (seed: number) => string }
  export class Recorder { /* see code */ }
  export async function setUpDivision(ctx: ScenarioContext, rec: Recorder, entrantCount: number): Promise<DivisionSetup>;
  export type RoundHook = (round: number, batch: FixtureRow[]) => Promise<void>;
  export async function playStage(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, hooks?: { beforeRound?: RoundHook; afterRound?: RoundHook }): Promise<void>;
  export async function decideFixture(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, f: FixtureRow, outcome: RequestedOutcome): Promise<void>;
  export async function configProbe(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup): Promise<ConfigEditObs>;
  export async function finishStage(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup): Promise<CompleteObs>;
  export async function snapshot(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, extra: { complete: CompleteObs; configEdit: ConfigEditObs | null; withdrawal: WithdrawalObs | null }): Promise<ObservedRun>;
  export function defaultPolicy(setup: DivisionSetup, f: FixtureRow, drawOk: boolean, ordinal: number): RequestedOutcome;
  // scenarios/assertions.ts
  export function assertion(id: string, items: readonly { ok: boolean; note: string }[], abstainReason?: string | null): CheckResult;
  export function foldParity(rec: Recorder): CheckResult;
  export function publicStandingsMatch(observed: ObservedRun, pub: PublicStandingsOut): CheckResult;
  export function drawPathExercised(rec: Recorder, observed: ObservedRun, drawOk: boolean): CheckResult;
  export function formatEditRefusedNamed(edit: ConfigEditObs): CheckResult;
  // scenarios/index.ts
  export const SCENARIOS: Readonly<Record<ScenarioKey, Scenario>>;
  ```

**Scope and deferrals (all stated, none silent).**
- A row that builds more than one stage throws `ScenarioUnsupported("W1b", "multi-stage rows need seed-proposal handling")`. The slice rows are all single-stage.
- A sport whose default entrant kind is `team` throws `ScenarioUnsupported("W1b", "team rosters")`. Generic and badminton are individual/pair.
- `ladder`, `americano` and `mexicano` rows throw `ScenarioUnsupported("W1b", …)`. Ladder has no generate (false premise 5).

**Per-round generation.**
- **swiss:** for `r = 1..config.rounds`, call `generate` (it pairs round r), record `PairRoundObs{roundNo:r, seated}`, then decide round r.
- **league and knockout:** loop `generate` → take the open two-sided fixtures of the lowest round → decide them. Stop when nothing is open. There is a hard cap of 64 iterations; hitting it records the fact `cut_short`, and I4 then abstains while the case records the cap in `rec.notes`, which turns red through the `life-loop-bounded` assertion.

- [ ] **Step 1: Write the fake driver** at `scripts/matrix/__tests__/fake-driver.ts`. It is an in-memory single-stage **league**: a circle-method round robin on `start`, outcomes produced by folding the posted stream through the real module, and standings computed from `declaredPoints`. It implements `OrganiserDriver` in full. Methods a league never needs (`withdraw` on anything but a league) follow the product's documented policy for leagues: expunge below 50% played (withdrawal.ts:130-200). It records `calls: string[]` as `"<method>"` names.

```ts
import type { StageKind } from "@seazn/engine/core";
import type { StagePostBody } from "../lib/catalogue.ts";
import { declaredPoints, foldStream } from "../lib/fold.ts";
import { resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import type {
  CompetitionRef, CompleteOut, DivisionRef, EntrantKind, EntrantRow, FixtureRow, FixtureStateOut, GenerateOut,
  OrganiserDriver, PostedEvent, ProbeOutcome, PublicStandingsOut, StageRef, StandingsOut, StartOut, WithdrawOut,
} from "../lib/driver/types.ts";

interface FakeFixture extends FixtureRow { events: StreamEvent[] }

export class FakeLeagueDriver implements OrganiserDriver {
  readonly calls: string[] = [];
  readonly orgId: string;
  sport = "";
  variant = "";
  cfg: unknown = null;
  stage: StageRef | null = null;
  entrants: EntrantRow[] = [];
  fixtures: FakeFixture[] = [];
  completed = false;
  constructor(orgId = "org-fake") { this.orgId = orgId; }
  get callCount(): number { return this.calls.length; }
  #log(m: string): void { this.calls.push(m); }

  async createCompetition(i: { name: string; slug: string }): Promise<CompetitionRef> { this.#log("createCompetition"); return { id: "c1", slug: i.slug, orgId: this.orgId }; }
  async createDivision(_c: string, i: { name: string; slug: string; sportKey: string; variantKey: string }): Promise<DivisionRef> {
    this.#log("createDivision");
    this.sport = i.sportKey; this.variant = i.variantKey; this.cfg = resolveSportCfg(i.sportKey, i.variantKey);
    return { id: "d1", slug: i.slug, sportKey: i.sportKey, variantKey: i.variantKey, config: {} };
  }
  async getDivision(): Promise<DivisionRef> { this.#log("getDivision"); return { id: "d1", slug: "d", sportKey: this.sport, variantKey: this.variant, config: {} }; }
  async postStages(_d: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
    this.#log("postStages");
    if (stages.length !== 1 || stages[0]!.kind !== "league") throw new Error("fake: league only");
    this.stage = { id: "s1", seq: 1, kind: "league", config: stages[0]!.config, status: "pending" };
    return [this.stage];
  }
  async listStages(): Promise<StageRef[]> { this.#log("listStages"); return this.stage ? [this.stage] : []; }
  async addEntrants(_d: string, es: readonly { displayName: string; seed: number; kind: EntrantKind }[]): Promise<EntrantRow[]> {
    this.#log("addEntrants");
    this.entrants = es.map((e, i) => ({ id: `e${i + 1}`, display_name: e.displayName, seed: e.seed, status: "registered" }));
    return this.entrants;
  }
  async start(): Promise<StartOut> {
    this.#log("start");
    const ids = this.entrants.map((e) => e.id);
    const ring = ids.length % 2 === 0 ? [...ids] : [...ids, "BYE"];
    let no = 0;
    for (let r = 0; r < ring.length - 1; r++) {
      for (let i = 0; i < ring.length / 2; i++) {
        const h = ring[i]!, a = ring[ring.length - 1 - i]!;
        if (h !== "BYE" && a !== "BYE") this.fixtures.push({ id: `f${++no}`, stage_id: "s1", pool_id: null, round_no: r + 1, fixture_no: no, home_entrant_id: h, away_entrant_id: a, status: "scheduled", outcome: null, events: [] });
      }
      ring.splice(1, 0, ring.pop()!);
    }
    this.stage!.status = "active";
    return { division_id: "d1", status: "active", started: true, generated: this.fixtures.length };
  }
  async generate(): Promise<GenerateOut> { this.#log("generate"); return { created: 0, existing: this.fixtures.length, fixtures: this.fixtures.map(({ events: _e, ...f }) => f) }; }
  async listFixtures(): Promise<FixtureRow[]> { this.#log("listFixtures"); return this.fixtures.map(({ events: _e, ...f }) => f); }
  async fixtureState(id: string): Promise<FixtureStateOut> { this.#log("fixtureState"); const f = this.#f(id); return { status: f.status, last_seq: f.events.length, outcome: f.outcome }; }
  async postStream(id: string, events: readonly StreamEvent[]): Promise<PostedEvent[]> {
    this.#log("postStream");
    const f = this.#f(id);
    f.events.push(...events);
    const folded = foldStream(sportModule(this.sport), this.cfg, f.home_entrant_id!, f.away_entrant_id!, f.events);
    f.outcome = folded.outcome;
    f.status = folded.outcome === null ? "in_play" : f.events.some((e) => e.type === "core.forfeit") ? "forfeited" : "decided";
    return events.map((_, i) => ({ seq: f.events.length - events.length + i + 1, status: f.status, outcome: f.outcome, event_id: `${id}-${i}` }));
  }
  async forfeit(id: string, by: string, reason: "walkover" | "retired hurt"): Promise<PostedEvent[]> {
    this.#log("forfeit");
    const s = this.#f(id).status;
    const ev: StreamEvent = { type: "core.forfeit", payload: { by, reason } };
    return this.postStream(id, s === "scheduled" ? [{ type: "core.start", payload: {} }, ev] : [ev]);
  }
  async withdraw(entrantId: string): Promise<WithdrawOut> {
    this.#log("withdraw");
    const mine = this.fixtures.filter((f) => f.home_entrant_id === entrantId || f.away_entrant_id === entrantId);
    const played = mine.filter((f) => f.status === "decided" || f.status === "forfeited").length;
    const policy = played / mine.length < 0.5 ? "expunge" : "walkover";
    let walkovers = 0;
    for (const f of mine) {
      if (policy === "expunge") { f.status = "abandoned"; f.outcome = null; }
      else if (f.status === "scheduled") { await this.forfeit(f.id, entrantId, "walkover"); walkovers++; }
    }
    this.entrants.find((e) => e.id === entrantId)!.status = "withdrawn";
    return { entrant_id: entrantId, status: "withdrawn", policy, walkovers, voided: policy === "expunge" ? mine.length : 0, skipped_finalized: 0 };
  }
  async completeStage(): Promise<CompleteOut> { this.#log("completeStage"); this.completed = this.fixtures.every((f) => f.status !== "scheduled" && f.status !== "in_play"); return { completed: this.completed, events: [] }; }
  async standings(stageId: string, poolId: string | null): Promise<StandingsOut> {
    this.#log("standings");
    const pts = new Map(this.entrants.map((e) => [e.id, 0]));
    const m = sportModule(this.sport);
    for (const f of this.fixtures) {
      if (f.outcome === null) continue;
      const d = declaredPoints(m, this.cfg, { kind: "league" as StageKind }, f.home_entrant_id!, f.away_entrant_id!, f.events)!;
      pts.set(f.home_entrant_id!, pts.get(f.home_entrant_id!)! + d.home);
      pts.set(f.away_entrant_id!, pts.get(f.away_entrant_id!)! + d.away);
    }
    const rows = [...pts].sort((a, b) => b[1] - a[1]).map(([entrantId, points], i) => ({ entrantId, rank: i + 1, points }));
    return { stage_id: stageId, pool_id: poolId, rows };
  }
  async publicStandings(): Promise<PublicStandingsOut> {
    this.#log("publicStandings");
    return { division_id: "d1", standings: [{ stage_id: "s1", pool_id: null, rows: (await this.standings("s1", null)).rows }] };
  }
  async patchDivisionConfig(_d: string, config: Record<string, unknown>): Promise<ProbeOutcome> {
    this.#log("patchDivisionConfig");
    return "entrants" in config && Object.keys(config).every((k) => k === "entrants") ? { status: 200, code: null } : { status: 409, code: "FORMAT_LOCKED" };
  }
  #f(id: string): FakeFixture { const f = this.fixtures.find((x) => x.id === id); if (!f) throw new Error(`fake: no fixture ${id}`); return f; }
}
```

- [ ] **Step 2: Write the failing scenario test** at `scripts/matrix/__tests__/scenarios.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { evaluateInvariants } from "../lib/invariants.ts";
import { decideState } from "../lib/results.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { assertion } from "../lib/scenarios/assertions.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { ScenarioUnsupported, type CaseSpec, type ScenarioKey } from "../lib/scenarios/types.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

async function runFake(scenario: ScenarioKey, opts: { canary?: boolean; row?: CaseSpec["row"] } = {}) {
  const driver = new FakeLeagueDriver();
  const spec: CaseSpec = { caseId: `league|generic|score|${scenario}`, row: opts.row ?? "league", sport: "generic", variant: "score", scenario, canary: opts.canary ?? false };
  const out = await SCENARIOS[scenario].run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg("generic", "score"), tag: "t" });
  const checks = [...evaluateInvariants(out.observed), ...out.assertions];
  return { driver, out, checks, state: decideState({ checks, deferred: null, error: null }) };
}

describe("assertion helper — empty first (R25)", () => {
  it("zero items is a fail, abstain carries a reason, one bad item fails", () => {
    expect(assertion("x", [])).toMatchObject({ verdict: "fail", checked: 0 });
    expect(assertion("x", [], "not a bracket")).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(assertion("x", [{ ok: true, note: "a" }, { ok: false, note: "b" }])).toMatchObject({ verdict: "fail", checked: 2, evidence: ["b"] });
  });
});

describe("LIFECYCLE on the fake league (wiring, not product truth)", () => {
  it("drives the driver in lifecycle order and ends works", async () => {
    const { driver, state, out, checks } = await runFake("LIFECYCLE");
    const firsts = ["createCompetition", "createDivision", "postStages", "addEntrants", "start", "listStages", "generate"];
    expect(driver.calls.slice(0, firsts.length)).toEqual(firsts);
    const i = (m: string) => driver.calls.lastIndexOf(m);
    expect(i("patchDivisionConfig")).toBeLessThan(i("completeStage"));
    expect(driver.calls.filter((c) => c === "completeStage")).toHaveLength(1);
    expect(i("publicStandings")).toBeGreaterThan(i("completeStage"));
    expect(out.observed.stages[0]!.fixtures).toHaveLength(28); // 8 entrants, single RR
    expect(state, JSON.stringify(checks.filter((c) => c.verdict === "fail"))).toMatchObject({ state: "works" });
    expect(checks.find((c) => c.id === "life-draw-path-exercised")).toMatchObject({ verdict: "pass" });
    expect(checks.find((c) => c.id === "life-fold-parity")!.checked).toBe(28);
  });
});

describe("pilots on the fake league", () => {
  it("M1: walkover recorded for seed 1; the canary expects the absent side and goes red on that check", async () => {
    expect((await runFake("M1")).state.state).toBe("works");
    const canary = await runFake("M1", { canary: true });
    expect(canary.state.state).toBe("red");
    expect(canary.checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual(["m1-walkover-recorded"]);
  });
  it("R4: policy reported and cascade consistent; the canary evaluates the opposite policy", async () => {
    const r = await runFake("R4");
    expect(r.out.observed.facts).toContain("withdrawn");
    expect(r.checks.find((c) => c.id === "r4-cascade-consistent")).toMatchObject({ verdict: "pass" });
    const canary = await runFake("R4", { canary: true });
    expect(canary.checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual(["r4-cascade-consistent"]);
  });
  it("F1: 7 entrants, every round seats floor(7/2)=3; the canary's ceil goes red", async () => {
    const r = await runFake("F1");
    expect(r.checks.find((c) => c.id === "f1-round-size")).toMatchObject({ verdict: "pass", checked: 7 });
    const canary = await runFake("F1", { canary: true });
    expect(canary.checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual(["f1-round-size"]);
  });
});

describe("deferrals are named", () => {
  it("a multi-stage row is ScenarioUnsupported(W1b), not a crash", async () => {
    await expect(runFake("LIFECYCLE", { row: "league_ko" })).rejects.toBeInstanceOf(ScenarioUnsupported);
  });
});
```

- [ ] **Step 3: Run and see RED** (template, `<N>`=8a, `<files>`=`scripts/matrix/__tests__/scenarios.test.ts`).

- [ ] **Step 4: Implement `scenarios/types.ts`** (the Interfaces block, verbatim), plus:

```ts
export class ScenarioUnsupported extends Error {
  readonly wave: string;
  constructor(wave: string, reason: string) {
    super(reason);
    this.name = "ScenarioUnsupported";
    this.wave = wave;
  }
}
```

- [ ] **Step 5: Implement `scenarios/assertions.ts`**

```ts
import type { CheckResult } from "../results.ts";
import type { ConfigEditObs, ObservedRun } from "../observed.ts";
import type { PublicStandingsOut } from "../driver/types.ts";
import type { Recorder } from "./common.ts";

/** Every scenario check goes through here, so R25 holds for assertions too. */
export function assertion(id: string, items: readonly { ok: boolean; note: string }[], abstainReason: string | null = null): CheckResult {
  if (abstainReason !== null) return { id, kind: "assertion", verdict: "abstain", checked: 0, reason: abstainReason, evidence: [] };
  if (items.length === 0) return { id, kind: "assertion", verdict: "fail", checked: 0, reason: "checked 0 items (vacuous, R25)", evidence: [] };
  const bad = items.filter((i) => !i.ok).map((i) => i.note);
  return { id, kind: "assertion", verdict: bad.length > 0 ? "fail" : "pass", checked: items.length, reason: bad[0] ?? `${items.length} ok`, evidence: bad.slice(0, 12) };
}

/** R15: the product's outcome for every posted stream equals the engine's
 *  in-process fold of the same stream. */
export function foldParity(rec: Recorder): CheckResult {
  return assertion("life-fold-parity", rec.parity.map((p) => ({
    ok: JSON.stringify(p.local) === JSON.stringify(p.product),
    note: `${p.fixtureId}: engine ${JSON.stringify(p.local)} vs product ${JSON.stringify(p.product)}`,
  })));
}

export function publicStandingsMatch(observed: ObservedRun, pub: PublicStandingsOut): CheckResult {
  const items: { ok: boolean; note: string }[] = [];
  for (const s of observed.stages) for (const pool of s.standings) {
    const p = pub.standings.find((x) => x.stage_id === s.id && x.pool_id === pool.poolId);
    if (p === undefined) { items.push({ ok: false, note: `stage ${s.seq} pool ${pool.poolId}: missing from public standings` }); continue; }
    for (const row of pool.rows) {
      const pr = p.rows.find((r) => r.entrantId === row.entrantId);
      items.push({ ok: pr !== undefined && pr.rank === row.rank && (pr.points ?? null) === row.points, note: `${row.entrantId}: org ${row.rank}/${row.points} vs public ${pr?.rank}/${pr?.points}` });
    }
  }
  return assertion("life-public-standings-match", items);
}

export function drawPathExercised(rec: Recorder, observed: ObservedRun, drawOk: boolean): CheckResult {
  if (!drawOk) return assertion("life-draw-path-exercised", [], "supportsDraws is false for this stage");
  const draws = observed.stages.flatMap((s) => s.fixtures).filter((f) => f.outcome?.kind === "draw");
  return assertion("life-draw-path-exercised", [{ ok: rec.drawsPosted > 0 && draws.length === rec.drawsPosted, note: `posted ${rec.drawsPosted} draws, product shows ${draws.length}` }]);
}

/** R28: a locked format is a NAMED refusal, never a silent accept or a 500. */
export function formatEditRefusedNamed(edit: ConfigEditObs): CheckResult {
  const fmt = edit.attempts.filter((a) => a.kind === "format");
  if (fmt.length === 0) return assertion("life-format-edit-refused-named", [], "no format field to edit for this sport");
  return assertion("life-format-edit-refused-named", fmt.map((a) => ({ ok: a.status >= 400 && a.status < 500 && a.code !== null, note: `format edit → ${a.status} ${a.code ?? "(no code)"}` })));
}
```

- [ ] **Step 6: Implement `scenarios/common.ts`**

```ts
import type { StageKind } from "@seazn/engine/core";
import { stagesForRow } from "../catalogue.ts";
import { declaredPoints, foldStream } from "../fold.ts";
import { drawsAllowed, entrantKindFor, sportModule } from "../sport-cfg.ts";
import { generateStream } from "../streams/index.ts";
import type { RequestedOutcome, StreamEvent } from "../streams/types.ts";
import { RefusedCall, type CompetitionRef, type DivisionRef, type EntrantRow, type FixtureRow, type StageRef } from "../driver/types.ts";
import {
  isTerminal, snap, toObservedOutcome,
  type CaseFact, type CompleteObs, type ConfigEditObs, type GenerateObs, type ObservedDeclared, type ObservedOutcome,
  type ObservedRun, type PairRoundObs, type WithdrawalObs,
} from "../observed.ts";
import { ScenarioUnsupported, type ScenarioContext } from "./types.ts";

export interface DivisionSetup {
  competition: CompetitionRef;
  division: DivisionRef;
  stage: StageRef;
  entrants: EntrantRow[];
  seedOf: (id: string) => number;
  idOfSeed: (seed: number) => string;
}

export class Recorder {
  readonly generates: GenerateObs[] = [];
  readonly pairRounds: PairRoundObs[] = [];
  readonly declared = new Map<string, ObservedDeclared>();
  readonly parity: { fixtureId: string; local: ObservedOutcome | null; product: ObservedOutcome | null }[] = [];
  readonly facts = new Set<CaseFact>();
  readonly notes: string[] = [];
  drawsPosted = 0;
  decided = 0;
  events = 0;
}

const FORMAT_LATER = new Set(["ladder", "americano", "mexicano"]);
const MAX_ITERATIONS = 64;

export async function setUpDivision(ctx: ScenarioContext, rec: Recorder, entrantCount: number): Promise<DivisionSetup> {
  if (FORMAT_LATER.has(ctx.spec.row)) throw new ScenarioUnsupported("W1b", `${ctx.spec.row}: challenge/rotation driving lands in W1b`);
  const bodies = stagesForRow(ctx.spec.row);
  if (bodies.length > 1) throw new ScenarioUnsupported("W1b", "multi-stage rows need seed-proposal handling");
  const kind = entrantKindFor(ctx.spec.sport, ctx.cfg);
  if (kind === "team") throw new ScenarioUnsupported("W1b", "team rosters");
  const slug = `m-${ctx.tag.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.slice(0, 60).replace(/-+$/, "");
  const competition = await ctx.driver.createCompetition({ name: `Matrix ${ctx.spec.caseId}`, slug });
  const division = await ctx.driver.createDivision(competition.id, { name: `Matrix ${ctx.spec.sport}`, slug: "d", sportKey: ctx.spec.sport, variantKey: ctx.spec.variant });
  await ctx.driver.postStages(division.id, bodies);
  const entrants = await ctx.driver.addEntrants(division.id, Array.from({ length: entrantCount }, (_, i) => ({ displayName: `Matrix Player ${i + 1}`, seed: i + 1, kind })));
  await ctx.driver.start(division.id);
  const stage = (await ctx.driver.listStages(division.id))[0]!;
  const seeds = new Map(entrants.map((e) => [e.id, e.seed ?? Number.MAX_SAFE_INTEGER]));
  rec.notes.push(`stage ${stage.kind} status after start: ${stage.status}`);
  return {
    competition, division, stage, entrants,
    seedOf: (id) => seeds.get(id) ?? Number.MAX_SAFE_INTEGER,
    idOfSeed: (seed) => entrants.find((e) => e.seed === seed)!.id,
  };
}

async function recordGenerate(ctx: ScenarioContext, rec: Recorder, stageId: string): Promise<FixtureRow[] | null> {
  try {
    const g = await ctx.driver.generate(stageId);
    rec.generates.push({ status: 200, code: null, total: g.fixtures.length, created: g.created });
    return g.fixtures;
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    rec.generates.push({ status: e.status, code: e.code, total: 0, created: 0 });
    return null;
  }
}

const seatedOpen = (f: FixtureRow) => f.home_entrant_id !== null && f.away_entrant_id !== null && !isTerminal(f.status);

export function defaultPolicy(setup: DivisionSetup, f: FixtureRow, drawOk: boolean, ordinal: number): RequestedOutcome {
  if (drawOk && ordinal % 3 === 2) return { kind: "draw" };
  return { kind: "win", winner: setup.seedOf(f.home_entrant_id!) <= setup.seedOf(f.away_entrant_id!) ? "home" : "away" };
}

export async function decideFixture(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, f: FixtureRow, outcome: RequestedOutcome): Promise<void> {
  const state = await ctx.driver.fixtureState(f.id);
  if (isTerminal(state.status)) return; // a server cascade got here first
  const home = f.home_entrant_id!;
  const away = f.away_entrant_id!;
  const kind = setup.stage.kind as StageKind;
  const events: StreamEvent[] = generateStream({ sportKey: ctx.spec.sport, cfg: ctx.cfg, stageKind: kind, home, away, outcome });
  const posted = outcome.kind === "forfeit"
    ? await ctx.driver.forfeit(f.id, outcome.by === "home" ? home : away, outcome.reason, `${ctx.tag}:${f.id}`)
    : await ctx.driver.postStream(f.id, events, `${ctx.tag}:${f.id}`);
  record(ctx, rec, setup, f, events, posted.at(-1)?.outcome ?? null, outcome);
}

function record(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, f: FixtureRow, events: StreamEvent[], productOutcome: unknown, outcome: RequestedOutcome): void {
  const m = sportModule(ctx.spec.sport);
  const local = foldStream(m, ctx.cfg, f.home_entrant_id!, f.away_entrant_id!, events).outcome;
  const dp = declaredPoints(m, ctx.cfg, { kind: setup.stage.kind as StageKind, ...(f.pool_id ? { poolId: f.pool_id } : {}), ...(f.round_no ? { roundNo: f.round_no } : {}) }, f.home_entrant_id!, f.away_entrant_id!, events);
  rec.parity.push({ fixtureId: f.id, local: toObservedOutcome(local), product: toObservedOutcome(productOutcome) });
  if (dp !== null) rec.declared.set(f.id, { home: dp.home, away: dp.away, forOutcome: toObservedOutcome(dp.forOutcome)! });
  rec.events += events.length;
  rec.decided++;
  if (outcome.kind === "draw") rec.drawsPosted++;
}

export type RoundHook = (round: number, batch: FixtureRow[]) => Promise<void>;

export async function playStage(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, hooks: { beforeRound?: RoundHook; afterRound?: RoundHook } = {}): Promise<void> {
  const stage = setup.stage;
  const drawOk = drawsAllowed(ctx.spec.sport, ctx.cfg, stage.kind as StageKind);
  const decideBatch = async (round: number, batch: FixtureRow[]) => {
    await hooks.beforeRound?.(round, batch);
    for (const f of [...batch].sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0))) {
      await decideFixture(ctx, rec, setup, f, defaultPolicy(setup, f, drawOk, rec.decided));
    }
    await hooks.afterRound?.(round, batch);
  };
  if (stage.kind === "swiss") {
    const rounds = Number(stage.config.rounds);
    for (let r = 1; r <= rounds; r++) {
      const fixtures = await recordGenerate(ctx, rec, stage.id);
      const batch = (fixtures ?? []).filter((f) => f.round_no === r && seatedOpen(f));
      rec.pairRounds.push({ roundNo: r, seated: batch.length });
      if (batch.length === 0) return; // I4 fails on the empty pair round
      await decideBatch(r, batch);
    }
    return;
  }
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const fixtures = await recordGenerate(ctx, rec, stage.id);
    const open = (fixtures ?? []).filter(seatedOpen);
    if (open.length === 0) return;
    const round = Math.min(...open.map((f) => f.round_no ?? 0));
    await decideBatch(round, open.filter((f) => (f.round_no ?? 0) === round));
  }
  rec.facts.add("cut_short");
  rec.notes.push(`loop cap ${MAX_ITERATIONS} reached`);
}

export async function configProbe(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup): Promise<ConfigEditObs> {
  const read = async () => (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === setup.stage.id && isTerminal(f.status)).map((f) => snap({ ...toFixture(f), declared: null }));
  const before = await read();
  const division = await ctx.driver.getDivision(setup.division.id);
  const attempts: ConfigEditObs["attempts"] = [];
  const cfg = ctx.cfg as Record<string, unknown>;
  // A format field this sport declares; divisions.ts:814-833 locks it once fixtures exist.
  const formatDelta = typeof cfg.allowDraws === "boolean" ? { allowDraws: !cfg.allowDraws }
    : typeof cfg.setTo === "number" ? { setTo: cfg.setTo === 15 ? 11 : 15, finalSetTo: cfg.setTo === 15 ? 11 : 15 }
    : null;
  if (formatDelta !== null) attempts.push({ kind: "format", ...(await ctx.driver.patchDivisionConfig(division.id, { ...division.config, ...formatDelta })) });
  // The one save the lock lets through (entrants-only).
  attempts.push({ kind: "entrants_only", ...(await ctx.driver.patchDivisionConfig(division.id, { ...division.config, entrants: { kinds: [entrantKindFor(ctx.spec.sport, ctx.cfg)] } })) });
  rec.notes.push(...attempts.map((a) => `config ${a.kind}: ${a.status} ${a.code ?? ""}`));
  return { attempts, before, after: await read() };
}

export async function finishStage(ctx: ScenarioContext, _rec: Recorder, setup: DivisionSetup): Promise<CompleteObs> {
  try {
    const c = await ctx.driver.completeStage(setup.stage.id);
    const done = c.events.find((e) => e.type === "stage_completed");
    return { status: 200, code: null, completed: c.completed, finalRanks: done?.finalRanks ?? null };
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    return { status: e.status, code: e.code, completed: false, finalRanks: null };
  }
}

function toFixture(f: FixtureRow) {
  return { id: f.id, stageId: f.stage_id, poolId: f.pool_id, roundNo: f.round_no, home: f.home_entrant_id, away: f.away_entrant_id, status: f.status, outcome: toObservedOutcome(f.outcome) };
}

export async function snapshot(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, extra: { complete: CompleteObs; configEdit: ConfigEditObs | null; withdrawal: WithdrawalObs | null }): Promise<ObservedRun> {
  const rows = (await ctx.driver.listFixtures(setup.division.id)).filter((f) => f.stage_id === setup.stage.id);
  const fixtures = rows.map((f) => ({ ...toFixture(f), declared: rec.declared.get(f.id) ?? null }));
  const poolIds = [...new Set(rows.map((f) => f.pool_id))];
  const standings = [];
  for (const poolId of poolIds.length > 0 ? poolIds : [null]) {
    const s = await ctx.driver.standings(setup.stage.id, poolId);
    standings.push({ poolId, rows: s.rows.map((r) => ({ entrantId: r.entrantId, rank: r.rank, points: typeof r.points === "number" ? r.points : null })) });
  }
  return {
    caseId: ctx.spec.caseId,
    facts: [...rec.facts],
    stages: [{
      id: setup.stage.id, seq: setup.stage.seq, kind: setup.stage.kind, config: setup.stage.config,
      field: setup.entrants.map((e) => e.id), fixtures, standings,
      generates: rec.generates, pairRounds: rec.pairRounds, complete: extra.complete,
    }],
    withdrawal: extra.withdrawal,
    configEdit: extra.configEdit,
  };
}
```
**Notes the executor must verify rather than trust.**
- The entrants-only probe body `{entrants:{kinds:[...]}}` has to be checked against `divisions.ts`'s entrants-only door. If the product reads it as a non-entrants change, the attempt records 409, and that is evidence, not a harness bug. I5 holds either way, because it is about results.
- Fixture `outcome` on `GET /divisions/:id/fixtures` is assumed to be the engine `MatchOutcome` JSON. If it is not, `life-fold-parity` goes red on every case in Task 11. That is a finding to investigate (read the fixtures route), not a reason to weaken the parity check.

- [ ] **Step 7: Implement the scenarios.**

`scenarios/lifecycle.ts`:
```ts
import type { StageKind } from "@seazn/engine/core";
import { drawsAllowed } from "../sport-cfg.ts";
import { assertion, drawPathExercised, foldParity, formatEditRefusedNamed, publicStandingsMatch } from "./assertions.ts";
import { Recorder, configProbe, finishStage, playStage, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

export const lifecycle: Scenario = {
  key: "LIFECYCLE",
  entrantCount: 8,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, this.entrantCount);
    await playStage(ctx, rec, setup);
    const configEdit = await configProbe(ctx, rec, setup);
    const complete = await finishStage(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, { complete, configEdit, withdrawal: null });
    const pub = await ctx.driver.publicStandings({ orgSlug: ctx.orgSlug, competitionSlug: setup.competition.slug, divisionSlug: setup.division.slug });
    const drawOk = drawsAllowed(ctx.spec.sport, ctx.cfg, setup.stage.kind as StageKind);
    return {
      observed,
      assertions: [
        foldParity(rec),
        publicStandingsMatch(observed, pub),
        drawPathExercised(rec, observed, drawOk),
        formatEditRefusedNamed(configEdit),
        assertion("life-loop-bounded", [{ ok: !rec.facts.has("cut_short"), note: rec.notes.join("; ") }]),
      ],
    };
  },
};
```

`scenarios/m1-walkover.ts`:
```ts
import { winnerOf } from "../observed.ts";
import { assertion, foldParity } from "./assertions.ts";
import { Recorder, decideFixture, finishStage, playStage, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

const BRACKETS = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);

export const m1Walkover: Scenario = {
  key: "M1",
  entrantCount: 8,
  canaryCheck: "m1-walkover-recorded",
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, this.entrantCount);
    const seed1 = setup.idOfSeed(1);
    let target: { id: string; absent: string; round: number } | null = null;
    await playStage(ctx, rec, setup, {
      beforeRound: async (round, batch) => {
        if (target !== null) return;
        const f = batch.find((x) => x.home_entrant_id === seed1 || x.away_entrant_id === seed1);
        if (f === undefined) return;
        const absentSide = f.home_entrant_id === seed1 ? "away" : "home";
        target = { id: f.id, absent: absentSide === "home" ? f.home_entrant_id! : f.away_entrant_id!, round };
        await decideFixture(ctx, rec, setup, f, { kind: "forfeit", by: absentSide, reason: "walkover" });
      },
    });
    const complete = await finishStage(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, { complete, configEdit: null, withdrawal: null });
    const t = target as { id: string; absent: string; round: number } | null;
    const fx = t === null ? undefined : observed.stages[0]!.fixtures.find((f) => f.id === t.id);
    // The canary asserts the deliberately WRONG winner (the absent side).
    const expected = ctx.spec.canary && t !== null ? t.absent : seed1;
    return {
      observed,
      assertions: [
        foldParity(rec),
        assertion("m1-walkover-recorded", fx === undefined ? [{ ok: false, note: "no round fixture seated seed 1" }] : [
          { ok: fx.status === "forfeited", note: `status ${fx.status}, expected forfeited` },
          { ok: winnerOf(fx.outcome) === expected, note: `winner ${winnerOf(fx.outcome)}, expected ${expected}` },
        ]),
        assertion("m1-winner-progresses",
          [{ ok: t !== null && observed.stages[0]!.fixtures.some((f) => (f.roundNo ?? 0) > t.round && (f.home === seed1 || f.away === seed1)), note: "seed 1 absent from every later round" }],
          BRACKETS.has(setup.stage.kind) ? null : "not a bracket stage"),
      ],
    };
  },
};
```

`scenarios/r4-withdrawal.ts`:
```ts
import { isTerminal, sameResult, snap, toObservedOutcome, winnerOf, type FixtureSnap, type ObservedFixture, type WithdrawalObs } from "../observed.ts";
import { assertion, foldParity } from "./assertions.ts";
import { Recorder, finishStage, playStage, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

/** What each policy the ENGINE CHOSE implies for the withdrawn entrant's
 *  fixtures (withdrawal.ts:1-17, 130-200). Which policy SHOULD apply is the
 *  rulebook's call (W2+) — W1a asserts only internal consistency. */
export function cascadeItems(policy: WithdrawalObs["policy"], w: string, before: readonly FixtureSnap[], after: readonly ObservedFixture[], walkoversReported: number) {
  const items: { ok: boolean; note: string }[] = [];
  let forfeitedByCascade = 0;
  for (const b of before) {
    const a = after.find((x) => x.id === b.id);
    if (a === undefined) { items.push({ ok: false, note: `${b.id}: vanished` }); continue; }
    if (policy === "walkover" && !isTerminal(b.status)) {
      const ok = a.status === "forfeited" && winnerOf(a.outcome) !== null && winnerOf(a.outcome) !== w;
      if (ok) forfeitedByCascade++;
      items.push({ ok, note: `${b.id}: ${a.status}/${winnerOf(a.outcome)} after walkover` });
    } else if (policy === "expunge" && b.status !== "finalized") {
      items.push({ ok: a.status === "abandoned", note: `${b.id}: ${a.status} after expunge` });
    } else {
      items.push({ ok: sameResult(a, b), note: `${b.id}: changed ${b.status}→${a.status}` });
    }
  }
  if (policy === "walkover") items.push({ ok: forfeitedByCascade === walkoversReported, note: `reported ${walkoversReported} walkovers, observed ${forfeitedByCascade}` });
  return items;
}

export const r4Withdrawal: Scenario = {
  key: "R4",
  entrantCount: 8,
  canaryCheck: "r4-cascade-consistent",
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, this.entrantCount);
    const seed3 = setup.idOfSeed(3);
    let withdrawal: WithdrawalObs | null = null;
    await playStage(ctx, rec, setup, {
      afterRound: async (round) => {
        if (round !== 1 || withdrawal !== null) return;
        const before = (await ctx.driver.listFixtures(setup.division.id))
          .filter((f) => f.stage_id === setup.stage.id && (f.home_entrant_id === seed3 || f.away_entrant_id === seed3))
          .map((f) => snap({ id: f.id, stageId: f.stage_id, poolId: f.pool_id, roundNo: f.round_no, home: f.home_entrant_id, away: f.away_entrant_id, status: f.status, outcome: toObservedOutcome(f.outcome), declared: null }));
        const out = await ctx.driver.withdraw(seed3);
        rec.facts.add("withdrawn");
        if (out.policy === "expunge") rec.facts.add("expunged");
        withdrawal = { entrantId: seed3, afterRound: 1, policy: out.policy, walkovers: out.walkovers, voided: out.voided, skippedFinalized: out.skipped_finalized, before };
      },
    });
    const complete = await finishStage(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, { complete, configEdit: null, withdrawal });
    const w = withdrawal as WithdrawalObs | null;
    if (w === null) {
      return { observed, assertions: [foldParity(rec), assertion("r4-policy-reported", [{ ok: false, note: "round 1 never finished; nobody withdrew" }])] };
    }
    const mine = observed.stages[0]!.fixtures.filter((f) => f.home === w.entrantId || f.away === w.entrantId);
    // Canary: judge the cascade against the OPPOSITE policy.
    const judged = ctx.spec.canary ? (w.policy === "walkover" ? "expunge" : "walkover") : w.policy;
    const later = observed.stages[0]!.fixtures.filter((f) => (f.roundNo ?? 0) > w.afterRound && f.home !== null && f.away !== null);
    return {
      observed,
      assertions: [
        foldParity(rec),
        assertion("r4-policy-reported", [{ ok: w.policy !== "none", note: `policy ${w.policy} on a started division` }]),
        assertion("r4-cascade-consistent", cascadeItems(judged, w.entrantId, w.before, mine, w.walkovers)),
        assertion("r4-not-paired-later",
          later.map((f) => ({ ok: f.home !== w.entrantId && f.away !== w.entrantId, note: `${f.id} (round ${f.roundNo}) seats the withdrawn entrant` })),
          setup.stage.kind === "swiss" ? null : "not a swiss stage"),
      ],
    };
  },
};
```

`scenarios/f1-odd-field.ts`:
```ts
import { assertion, foldParity } from "./assertions.ts";
import { Recorder, finishStage, playStage, setUpDivision, snapshot } from "./common.ts";
import type { Scenario } from "./types.ts";

export const f1OddField: Scenario = {
  key: "F1",
  entrantCount: 7,
  canaryCheck: "f1-round-size",
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, this.entrantCount);
    await playStage(ctx, rec, setup);
    const complete = await finishStage(ctx, rec, setup);
    const observed = await snapshot(ctx, rec, setup, { complete, configEdit: null, withdrawal: null });
    const s = observed.stages[0]!;
    const n = s.field.length;
    // floor(n/2) seated pairs per round, one bye; the canary expects ceil.
    const expectedPerRound = ctx.spec.canary ? Math.ceil(n / 2) : Math.floor(n / 2);
    const rounds = [...new Set(s.fixtures.map((f) => f.roundNo ?? 0))].sort((a, b) => a - b);
    const inspected = setup.stage.kind === "knockout" ? rounds.slice(0, 1) : rounds;
    const seatedIn = (r: number) => s.fixtures.filter((f) => (f.roundNo ?? 0) === r && f.home !== null && f.away !== null).length;
    return {
      observed,
      assertions: [
        foldParity(rec),
        assertion("f1-everyone-drawn", s.field.map((e) => ({ ok: s.fixtures.some((f) => f.home === e || f.away === e), note: `${e} appears in no fixture` }))),
        assertion("f1-round-size", inspected.map((r) => ({ ok: seatedIn(r) === expectedPerRound, note: `round ${r}: ${seatedIn(r)} seated, expected ${expectedPerRound}` }))),
      ],
    };
  },
};
```

`scenarios/index.ts`:
```ts
import { f1OddField } from "./f1-odd-field.ts";
import { lifecycle } from "./lifecycle.ts";
import { m1Walkover } from "./m1-walkover.ts";
import { r4Withdrawal } from "./r4-withdrawal.ts";
import type { Scenario, ScenarioKey } from "./types.ts";

export const SCENARIOS: Readonly<Record<ScenarioKey, Scenario>> = Object.freeze({ LIFECYCLE: lifecycle, M1: m1Walkover, R4: r4Withdrawal, F1: f1OddField });
```

- [ ] **Step 8: Run and see GREEN** (template, `<N>`=8, `<files>`=`scripts/matrix/__tests__/scenarios.test.ts scripts/matrix/__tests__/boundary.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts`).
  - F1's `checked: 7` holds for a 7-entrant league: 8 slots means 7 rounds.
  - M1 on the fake: seed 1's round-1 opponent forfeits; the league's I3 still applies, because the harness declared the forfeit stream.
  - R4 on the fake: 1 of 7 played means expunge. `r4-cascade-consistent` passes (all non-finalized fixtures abandoned), and the canary judges them as a walkover, which goes red.

- [ ] **Step 9: Mutation**
  - `assertion`: return pass on empty items → "zero items is a fail".
  - M1: drop the canary swap → "the canary expects the absent side and goes red" goes green, so the test fails.
  - R4: the canary judges with `w.policy` → the R4 canary test.
  - F1: `Math.ceil` in the non-canary branch → the F1 test.
  - `playStage` swiss: remove the `pairRounds.push` → **not killable on the league fake.** Record it as covered by Task 11 (I4 `checked` on swiss cases). Add a unit test only if the executor builds a swiss fake; do not widen the fake otherwise.
  - `configProbe` moved after `finishStage` → the lifecycle order test.
  - `decideFixture`: skip the `isTerminal` early return → the fake throws on a second stream into an expunged fixture (the R4 test).

- [ ] **Step 10: Commit** (message: "feat(matrix): LIFECYCLE + pilot scenarios M1 walkover, R4 withdrawal, F1 odd field, each with a canary")

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git add scripts/matrix/lib/scenarios scripts/matrix/__tests__/fake-driver.ts scripts/matrix/__tests__/scenarios.test.ts && git commit -F "$TMPDIR/fm-msg.txt" -- scripts/matrix
```

**Test types:**
- Unit: `scenarios.test.ts` on the fake. This proves wiring and canary mechanics, NOT product truth.
- E2E: Task 11 runs all four scenarios × 6 cells live, plus the three canaries.
- Smoke: loadable.
- Regression: the Step 9 mutants.

---

### Task 9: The slice planner and the `run.ts` CLI

**Files:**
- Create: `scripts/matrix/lib/slice.ts`, `scripts/matrix/run.ts`
- Create: `scripts/matrix/__tests__/slice.test.ts`, `scripts/matrix/__tests__/run-cli.test.ts`

**Interfaces:**
- Consumes: everything above; `signIn`, `newSession`, `raw` (`http.ts`); `provisionPlan`, `createRealPlanSql` (`plan.ts`); `runPreflight`, `createRealPreflightProbes` (`env.ts`).
- Produces:
  ```ts
  // slice.ts
  export const SLICE_ROWS: readonly ["league", "knockout", "swiss"];
  export const SLICE_SPORTS: readonly ["generic", "badminton"];
  export const SCENARIO_KEYS: readonly ScenarioKey[];            // LIFECYCLE, M1, R4, F1
  export class UnknownFilter extends Error {}
  export interface SliceFilter { only?: string; scenario?: string }
  export function planSliceCases(variantFor: (sport: string) => string, filter?: SliceFilter): CaseSpec[];
  export function planCanaryCase(variantFor: (sport: string) => string, scenario: string): CaseSpec;   // league|generic, canary:true
  // run.ts
  export interface RunDeps { /* injectable seams, see code */ }
  export async function runSlice(deps: RunDeps, argv: string[]): Promise<number>;
  export async function main(argv: string[]): Promise<number>;
  ```

- [ ] **Step 1: Write the failing tests.**

`scripts/matrix/__tests__/slice.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { SCENARIO_KEYS, UnknownFilter, planCanaryCase, planSliceCases } from "../lib/slice.ts";

const v = (s: string) => (s === "generic" ? "score" : "bwf");

describe("planSliceCases — empty/unknown first", () => {
  it("an unknown --only or --scenario throws instead of running zero cases", () => {
    expect(() => planSliceCases(v, { only: "league|genric" })).toThrow(UnknownFilter);
    expect(() => planSliceCases(v, { scenario: "M9" })).toThrow(UnknownFilter);
    expect(() => planCanaryCase(v, "LIFECYCLE")).toThrow(UnknownFilter); // LIFECYCLE has no canary
  });
});

describe("planSliceCases", () => {
  it("the full slice is 3 rows × 2 sports × 4 scenarios = 24 unique cases", () => {
    const cases = planSliceCases(v);
    expect(cases).toHaveLength(24);
    expect(new Set(cases.map((c) => c.caseId)).size).toBe(24);
    expect(cases.every((c) => !c.canary)).toBe(true);
    expect(cases[0]).toMatchObject({ caseId: "league|generic|score|LIFECYCLE", row: "league", sport: "generic", variant: "score" });
  });
  it("filters narrow to exactly one case", () => {
    expect(planSliceCases(v, { only: "swiss|badminton", scenario: "F1" }).map((c) => c.caseId)).toEqual(["swiss|badminton|bwf|F1"]);
  });
  it("every scenario key is registered, and each pilot names its canary check", () => {
    expect([...SCENARIO_KEYS].sort()).toEqual(Object.keys(SCENARIOS).sort());
    for (const k of ["M1", "R4", "F1"] as const) {
      expect(SCENARIOS[k].canaryCheck).not.toBeNull();
      expect(planCanaryCase(v, k)).toMatchObject({ canary: true, row: "league", sport: "generic", scenario: k });
    }
  });
});
```

`scripts/matrix/__tests__/run-cli.test.ts` drives `runSlice` with injected fakes (no DB, no server):
```ts
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSlice, type RunDeps } from "../run.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

function deps(over: Partial<RunDeps> = {}): RunDeps & { order: string[] } {
  const order: string[] = [];
  const d: RunDeps & { order: string[] } = {
    order,
    env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999" },
    harnessCommit: async () => "abc1234",
    preflight: async () => { order.push("preflight"); return { ok: true, refusals: [] }; },
    openDb: async () => { order.push("openDb"); return {
      userIdForEmail: async () => "u1",
      variantKeysInBuilderOrder: async (s: string) => (s === "generic" ? ["score", "win_loss"] : ["bwf", "short"]),
      chooseTopPublicPlan: async () => "pro",
      dispose: async () => { order.push("dispose"); },
    }; },
    signIn: async () => { order.push("signIn"); return { cookies: {} }; },
    prepareCaseOrg: async (_ctx, i) => ({ orgId: "org-fake", orgSlug: i.slug }),
    driverFor: () => new FakeLeagueDriver("org-fake"),
    ...over,
  };
  return d;
}

describe("runSlice — refusals first", () => {
  it("BENCH_EXPECTED_DATA_DIR unset: exit 2 before preflight, DB or sign-in (Review Focus 3)", async () => {
    const d = deps({ env: { SMOKE_BASE: "http://localhost:3999" } });
    expect(await runSlice(d, ["--report-dir", mkdtempSync(join(tmpdir(), "fm-"))])).toBe(2);
    expect(d.order).toEqual([]);
  });
  it("a failed preflight: exit 2, no DB, no sign-in", async () => {
    const d = deps({ preflight: async () => ({ ok: false, refusals: [{ reason: "db", detail: "foreign data_directory" }] }) });
    expect(await runSlice(d, ["--report-dir", mkdtempSync(join(tmpdir(), "fm-"))])).toBe(2);
    expect(d.order).toEqual([]);
  });
  it("no base URL: exit 2", async () => {
    expect(await runSlice(deps({ env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg" } }), [])).toBe(2);
  });
});

describe("runSlice — a run", () => {
  it("one league case: guard → preflight → db → sign-in once; writes results.json + MATRIX.md; exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const d = deps();
    expect(await runSlice(d, ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t1", "--report-dir", dir])).toBe(0);
    expect(d.order).toEqual(["preflight", "openDb", "signIn", "dispose"]);
    const results = JSON.parse(readFileSync(join(dir, "t1", "results.json"), "utf8"));
    expect(results.cases).toHaveLength(1);
    expect(results.cases[0].state).toBe("works");
    expect(readFileSync(join(dir, "t1", "MATRIX.md"), "utf8")).toContain("| league |");
  });
  it("a knockout case on the league-only fake is red with a redacted error, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    expect(await runSlice(deps(), ["--only", "knockout|generic", "--scenario", "LIFECYCLE", "--run-id", "t2", "--report-dir", dir])).toBe(0);
    const c = JSON.parse(readFileSync(join(dir, "t2", "results.json"), "utf8")).cases[0];
    expect(c.state).toBe("red");
    expect(c.reason).toMatch(/error: .*league only/);
  });
  it("--canary M1: exit 0 only when the canary check itself is what went red; no MATRIX.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    expect(await runSlice(deps(), ["--canary", "M1", "--run-id", "c1", "--report-dir", dir])).toBe(0);
    expect(existsSync(join(dir, "c1", "MATRIX.md"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run and see RED** (template, `<N>`=9a, both files).

- [ ] **Step 3: Implement `scripts/matrix/lib/slice.ts`**

```ts
import type { TemplateRowKey } from "./catalogue.ts";
import { SCENARIOS } from "./scenarios/index.ts";
import type { CaseSpec, ScenarioKey } from "./scenarios/types.ts";

export const SLICE_ROWS = ["league", "knockout", "swiss"] as const satisfies readonly TemplateRowKey[];
export const SLICE_SPORTS = ["generic", "badminton"] as const;
export const SCENARIO_KEYS: readonly ScenarioKey[] = ["LIFECYCLE", "M1", "R4", "F1"];

export class UnknownFilter extends Error {
  constructor(what: string, value: string, allowed: readonly string[]) {
    super(`slice: unknown ${what} '${value}' (allowed: ${allowed.join(", ")})`);
    this.name = "UnknownFilter";
  }
}

export interface SliceFilter { only?: string; scenario?: string }

const caseId = (row: string, sport: string, variant: string, scenario: string) => `${row}|${sport}|${variant}|${scenario}`;

export function planSliceCases(variantFor: (sport: string) => string, filter: SliceFilter = {}): CaseSpec[] {
  const cells = SLICE_ROWS.flatMap((row) => SLICE_SPORTS.map((sport) => `${row}|${sport}`));
  if (filter.only !== undefined && !cells.includes(filter.only)) throw new UnknownFilter("--only cell", filter.only, cells);
  if (filter.scenario !== undefined && !SCENARIO_KEYS.includes(filter.scenario as ScenarioKey)) throw new UnknownFilter("--scenario", filter.scenario, SCENARIO_KEYS);
  const out: CaseSpec[] = [];
  for (const row of SLICE_ROWS) for (const sport of SLICE_SPORTS) {
    if (filter.only !== undefined && filter.only !== `${row}|${sport}`) continue;
    const variant = variantFor(sport);
    for (const scenario of SCENARIO_KEYS) {
      if (filter.scenario !== undefined && filter.scenario !== scenario) continue;
      out.push({ caseId: caseId(row, sport, variant, scenario), row, sport, variant, scenario, canary: false });
    }
  }
  return out;
}

export function planCanaryCase(variantFor: (sport: string) => string, scenario: string): CaseSpec {
  const withCanary = SCENARIO_KEYS.filter((k) => SCENARIOS[k].canaryCheck !== null);
  if (!withCanary.includes(scenario as ScenarioKey)) throw new UnknownFilter("--canary", scenario, withCanary);
  const variant = variantFor("generic");
  return { caseId: `${caseId("league", "generic", variant, scenario)}|canary`, row: "league", sport: "generic", variant, scenario: scenario as ScenarioKey, canary: true };
}
```

- [ ] **Step 4: Implement `scripts/matrix/run.ts`**

```ts
// L3 runner. node --experimental-strip-types scripts/matrix/run.ts
//   [--base URL] [--run-id ID] [--report-dir DIR] [--only row|sport] [--scenario KEY] [--canary KEY]
// Exit: 0 results written (reds are DATA, not a crash) / canary went red on its
// own check; 1 zero cases, or a canary that did NOT go red as designed; 2 refused
// to start (no own-DB proof, preflight, no base).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { newSession, raw, signIn, type Session } from "../bench/lib/http.ts";
import { createRealPlanSql, provisionPlan } from "../bench/lib/plan.ts";
import { createRealPreflightProbes, runPreflight } from "../bench/lib/env.ts";
import { RowBuildDeferred, builderDefaultVariant } from "./lib/catalogue.ts";
import { HttpDriver } from "./lib/driver/http-driver.ts";
import type { OrganiserDriver } from "./lib/driver/types.ts";
import { evaluateInvariants } from "./lib/invariants.ts";
import { redact } from "./lib/redact.ts";
import { renderMatrix } from "./lib/render-matrix.ts";
import { decideState, writeResults, type CaseResult, type CheckResult, type RunResults } from "./lib/results.ts";
import { SCENARIOS } from "./lib/scenarios/index.ts";
import { ScenarioUnsupported, type CaseSpec } from "./lib/scenarios/types.ts";
import { chooseTopPublicPlan, createRealMatrixSql, ownerEmail, prepareCaseOrg, requireOwnDataDir } from "./lib/seed-org.ts";
import { resolveSportCfg } from "./lib/sport-cfg.ts";
import { planCanaryCase, planSliceCases } from "./lib/slice.ts";

export interface RunDb {
  userIdForEmail(email: string): Promise<string>;
  variantKeysInBuilderOrder(sport: string): Promise<string[]>;
  chooseTopPublicPlan(): Promise<string>;
  dispose(): Promise<void>;
}

export interface RunDeps {
  env: Readonly<Record<string, string | undefined>>;
  harnessCommit(): Promise<string>;
  preflight(base: string): Promise<{ ok: boolean; refusals: { reason: string; detail: string }[] }>;
  openDb(): Promise<RunDb>;
  signIn(base: string, email: string): Promise<Session>;
  prepareCaseOrg(ctx: { base: string; session: Session; userId: string; plan: string }, input: { name: string; slug: string }): Promise<{ orgId: string; orgSlug: string }>;
  driverFor(base: string, session: Session, orgId: string): OrganiserDriver;
}

const say = (s: string) => process.stdout.write(`${redact(s)}\n`);

export async function runSlice(deps: RunDeps, argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    base: { type: "string" }, "run-id": { type: "string" }, "report-dir": { type: "string" },
    only: { type: "string" }, scenario: { type: "string" }, canary: { type: "string" },
  } });
  const base = values.base ?? deps.env.SMOKE_BASE;
  if (!base) { say("matrix: no --base and no SMOKE_BASE (seazn-local-env `env`)"); return 2; }
  try { requireOwnDataDir(deps.env); } catch (e) { say((e as Error).message); return 2; }
  const pf = await deps.preflight(base);
  if (!pf.ok) { for (const r of pf.refusals) say(`preflight refused: ${r.reason} — ${r.detail}`); return 2; }

  const runId = (values["run-id"] ?? `w1a-${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const dir = join(values["report-dir"] ?? "matrix-report", runId);
  const startedAt = new Date().toISOString();
  const db = await deps.openDb();
  const cases: CaseResult[] = [];
  let specs: CaseSpec[] = [];
  try {
    const session = await deps.signIn(base, ownerEmail(runId)); // ONE sign-in per run (single worker)
    const userId = await db.userIdForEmail(ownerEmail(runId));
    const plan = await db.chooseTopPublicPlan();
    const order = new Map<string, string[]>();
    for (const s of ["generic", "badminton"]) order.set(s, await db.variantKeysInBuilderOrder(s));
    const variantFor = (s: string) => builderDefaultVariant(s, order.get(s) ?? []);
    specs = values.canary !== undefined ? [planCanaryCase(variantFor, values.canary)] : planSliceCases(variantFor, { only: values.only, scenario: values.scenario });
    for (const [i, spec] of specs.entries()) {
      const t0 = Date.now();
      let checks: CheckResult[] = [];
      let deferred: { wave: string; reason: string } | null = null;
      let error: string | null = null;
      let driver: OrganiserDriver | null = null;
      let counts = { calls: 0, fixtures: 0, events: 0 };
      try {
        const org = await deps.prepareCaseOrg({ base, session, userId, plan }, { name: `Matrix ${runId} ${i + 1}`, slug: `m-${runId}-${i + 1}`.slice(0, 60) });
        driver = deps.driverFor(base, session, org.orgId);
        const out = await SCENARIOS[spec.scenario].run({ driver, spec, orgSlug: org.orgSlug, cfg: resolveSportCfg(spec.sport, spec.variant), tag: `${runId}-${i + 1}` });
        checks = [...evaluateInvariants(out.observed), ...out.assertions];
        counts = { calls: driver.callCount, fixtures: out.observed.stages.reduce((n, s) => n + s.fixtures.length, 0), events: 0 };
      } catch (e) {
        if (e instanceof ScenarioUnsupported || e instanceof RowBuildDeferred) deferred = { wave: e.wave, reason: e.message };
        else error = redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        if (driver !== null) counts = { ...counts, calls: driver.callCount };
      }
      const { state, reason } = decideState({ checks, deferred, error });
      cases.push({ caseId: spec.caseId, row: spec.row, sport: spec.sport, variant: spec.variant, scenario: spec.scenario, canary: spec.canary, state, reason: redact(reason), checks, counts, durationMs: Date.now() - t0 });
      say(`[${i + 1}/${specs.length}] ${spec.caseId} → ${state} ${reason}`);
    }
  } finally {
    await db.dispose();
  }

  const results: RunResults = { schemaVersion: 1, runId, harnessCommit: await deps.harnessCommit(), startedAt, finishedAt: new Date().toISOString(), cases };
  say(`results → ${writeResults(dir, results)}`);
  if (values.canary !== undefined) {
    const c = cases[0];
    const want = SCENARIOS[specs[0]!.scenario].canaryCheck;
    const failedIds = (c?.checks ?? []).filter((k) => k.verdict === "fail").map((k) => k.id);
    const ok = c?.state === "red" && want !== null && failedIds.includes(want);
    say(ok ? `canary ${values.canary}: red on ${want}, as designed` : `canary ${values.canary}: did NOT go red on ${want} (failed: ${failedIds.join(", ") || "none"}; state ${c?.state})`);
    return ok ? 0 : 1;
  }
  writeFileSync(join(dir, "MATRIX.md"), renderMatrix(results));
  return cases.length === 0 ? 1 : 0;
}

export function realDeps(): RunDeps {
  return {
    env: process.env,
    harnessCommit: async () => execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
    preflight: async (base) => {
      const { probes, dispose } = createRealPreflightProbes();
      try { return await runPreflight(base, probes); } finally { await dispose(); }
    },
    openDb: async () => {
      const m = createRealMatrixSql();
      const p = createRealPlanSql();
      const db: RunDb = {
        userIdForEmail: (e) => m.sql.userIdForEmail(e),
        variantKeysInBuilderOrder: (s) => m.sql.variantKeysInBuilderOrder(s),
        chooseTopPublicPlan: async () => chooseTopPublicPlan(await p.sql.planCandidateInfo(await m.sql.listPlanKeys())),
        dispose: async () => { await m.dispose(); await p.dispose(); },
      };
      return db;
    },
    signIn: async (base, email) => { const s = newSession(); await signIn(base, s, email); return s; },
    prepareCaseOrg: async (ctx, input) => {
      const m = createRealMatrixSql();
      const p = createRealPlanSql();
      try {
        return await prepareCaseOrg({
          sql: m.sql, transport: { raw }, base: ctx.base, session: ctx.session, userId: ctx.userId, plan: ctx.plan,
          provision: (orgId, plan) => provisionPlan({ base: ctx.base, orgId, plan, ownerSession: ctx.session, sql: p.sql }),
        }, input);
      } finally { await m.dispose(); await p.dispose(); }
    },
    driverFor: (base, session, orgId) => new HttpDriver({ base, session, expectedOrgId: orgId }),
  };
}

export async function main(argv: string[]): Promise<number> {
  return runSlice(realDeps(), argv);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
```
Per-case connections open and close inside `prepareCaseOrg`. This keeps each case's SQL on a fresh `max:1` client and needs no shared-handle plumbing. At 24 cases the cost is negligible. If the executor measures otherwise, hoist the handles into `openDb` and note it in the report.

- [ ] **Step 5: Run and see GREEN** (template, `<N>`=9, `<files>`=`scripts/matrix/__tests__/slice.test.ts scripts/matrix/__tests__/run-cli.test.ts scripts/matrix/__tests__/boundary.test.ts scripts/matrix/__tests__/strip-types-loadable.test.ts`). The loadable test now imports `run.ts`: its entry guard must keep `main()` from running, and `env.ts`'s playwright/grpc imports must resolve.

- [ ] **Step 6: Mutation**
  - Move `requireOwnDataDir` after `preflight` → "BENCH_EXPECTED_DATA_DIR unset: exit 2 before preflight" (the order array is non-empty).
  - Canary exit: `ok = c?.state === "red"` (drop the check-id match) → **write the killing test first.** Add a run where the canary case is red for an unrelated reason (a `driverFor` whose `createCompetition` throws) and expect exit 1. Then mutate and see it return 0.
  - Render MATRIX.md in canary mode → "no MATRIX.md".
  - `planSliceCases`: drop the `UnknownFilter` on `only` → "an unknown --only … throws".
  - Catch-all converts errors to `works` → "a knockout case on the league-only fake is red".

- [ ] **Step 7: Commit** (message: "feat(matrix): slice planner + run.ts CLI with own-DB guard, one sign-in, canary mode")

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git add scripts/matrix/lib/slice.ts scripts/matrix/run.ts scripts/matrix/__tests__/slice.test.ts scripts/matrix/__tests__/run-cli.test.ts && git commit -F "$TMPDIR/fm-msg.txt" -- scripts/matrix
```

**Test types:**
- Unit: `slice.test.ts` and `run-cli.test.ts` (injected fakes).
- E2E: Task 11 (`realDeps`).
- Smoke: loadable (imports `run.ts`).
- Regression: the Step 6 mutants.

---

### Task 10: CI step, package scripts, gitignore

**Files:**
- Modify: `.github/workflows/ci.yml` (insert after line 195, in the same job as "Bench lib unit tests (DB-free)")
- Modify: `package.json` (`scripts`)
- Modify: `.gitignore`
- Create: `scripts/matrix/__tests__/ci-wiring.test.ts`

**Interfaces:**
- Produces: the CI step "Matrix harness unit tests (DB-free)"; `pnpm matrix:l3` and `pnpm matrix:render`; the ignored `matrix-report/`.

There is **no scheduled workflow** in W1a (design §8; the weekly cadence is later).

- [ ] **Step 1: Write the failing wiring test** at `scripts/matrix/__tests__/ci-wiring.test.ts`

```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ci = readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };

describe("matrix CI wiring", () => {
  it("a DB-free step runs scripts/matrix with the JSON reporter, right after the bench step", () => {
    const bench = ci.indexOf("scripts/bench\n");
    const matrix = ci.indexOf("--outputFile=vitest-results-matrix.json --testTimeout=30000 scripts/matrix");
    expect(bench).toBeGreaterThan(0);
    expect(matrix).toBeGreaterThan(bench);
    expect(ci.slice(bench, matrix)).not.toMatch(/\n  [a-z][\w-]*:\n/); // same job: no new job key in between
  });
  it("no scheduled matrix workflow exists in W1a", () => {
    expect(ci).not.toMatch(/matrix:l3/);
  });
  it("package scripts run the CLIs under strip-types", () => {
    expect(pkg.scripts["matrix:l3"]).toBe("node --experimental-strip-types scripts/matrix/run.ts");
    expect(pkg.scripts["matrix:render"]).toBe("node --experimental-strip-types scripts/matrix/render.ts");
  });
  it("matrix-report/ is ignored", () => {
    expect(readFileSync(resolve(REPO, ".gitignore"), "utf8")).toMatch(/^matrix-report\/$/m);
  });
});
```

- [ ] **Step 2: Run and see RED** (template, `<N>`=10a, the file).

- [ ] **Step 3: Edit `.github/workflows/ci.yml`.** Insert immediately after line 195 (`run: … scripts/bench`) with the same indentation:

```yaml
      # Format × sport matrix harness (W1a, scripts/matrix/**) — catalogue,
      # stream generators folded through the real engine for all 11 sports,
      # invariants, results/renderer, driver on a fake transport. DB-free by
      # design (every DB/HTTP seam is injected), so it runs here beside the
      # bench step with the same explicit-binary + explicit-path convention.
      # The live L3 run is local-only in W1a (no scheduled workflow).
      - name: Matrix harness unit tests (DB-free)
        run: ./packages/engine/node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile=vitest-results-matrix.json --testTimeout=30000 scripts/matrix
```
Add `"matrix:l3": "node --experimental-strip-types scripts/matrix/run.ts"` and `"matrix:render": "node --experimental-strip-types scripts/matrix/render.ts"` to `package.json` `scripts`, next to `bench:*`. Add a line `matrix-report/` to `.gitignore` under `bench-report/`.

- [ ] **Step 4: Run and see GREEN** (template, `<N>`=10, the wiring file).

- [ ] **Step 5: Mutation**
  - Rename the outputFile to `vitest-results-bench.json` → the first wiring test.
  - Remove the `.gitignore` line → the last wiring test.

- [ ] **Step 6: Commit, push, open the PR, and read CI.** This is the first point where tsc and lint run; they are CI's job.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git add .github/workflows/ci.yml package.json .gitignore scripts/matrix/__tests__/ci-wiring.test.ts && git commit -F "$TMPDIR/fm-msg.txt" -- .github/workflows/ci.yml package.json .gitignore scripts/matrix
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git push -u origin feat/format-matrix-w1a
```
Open a PR titled "feat(matrix): W1a L3 core" with the body ending in the attribution line from the session's system reminder. The body declares its matrix rows (R27): "none — harness only; no engine or stages.ts change". Then confirm CI actually ran on the head SHA: `gh api "repos/{owner}/{repo}/actions/runs?head_sha=$(git rev-parse HEAD)" --jq '.workflow_runs[].name'`. A green `gh pr checks` with zero `ci.yml` runs is not a pass. Read the "Matrix harness unit tests (DB-free)" step log for its test count, and read the typecheck and lint jobs. A typecheck or lint red is fixed in the owning task's files and re-pushed.

**Test types:**
- Unit: `ci-wiring.test.ts`.
- E2E: N/A. CI runs no live L3 in W1a by design (design §8).
- Smoke: CI's own run of the step on the PR.
- Regression: that step on every future PR.

---

### Task 11: Live verification — the 24-case truth run, the canaries, the committed evidence

**Files:**
- Create: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1a-slice/results.json`
- Create: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1a-slice/MATRIX.md`
- Create: `scripts/matrix/__tests__/committed-matrix.test.ts`
- Modify: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md` (session status, findings, false premises)

**Interfaces:**
- Consumes: `pnpm matrix:l3`, `pnpm matrix:render`, `renderMatrix`, `parseResults`.
- Produces: the committed W1a slice evidence, and a drift test that keeps it honest (R10).

This task runs the product. It follows the `seazn-local-env` skill (`~/.claude/skills/seazn-local-env/SKILL.md`); read §0–3 and §5 first. §5's environmental red signatures separate an environment fault from a finding (AGENTS class 14).

- [ ] **Step 1: Stand up a fresh, owned environment**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label fm-w1a --server; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fm-w1a)" && psql "$DATABASE_URL" -Atc 'show data_directory' && echo "expected: $BENCH_EXPECTED_DATA_DIR" && echo "base: $SMOKE_BASE"
```
Expected:
- `up` runs `db:apply` and `sync:sports` (R14) and starts a prod server with `AUTH_DEV_LINKS=1`.
- The two data directories are identical.
- `SMOKE_BASE` is `http://localhost:<port>`.
- **Never print `DATABASE_URL` itself.**

If `.env.local` symlinks are missing in the worktree, the skill's §1 recipe creates them. If `pg_ctl` said "Address already in use", stop: the `createdb` that followed hit another session's server (AGENTS "Environment setup").

- [ ] **Step 2: Confirm the builder variant order against the DB** (the false-premise check for open question 3)

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fm-w1a)" && psql "$DATABASE_URL" -Atc "set search_path=${DB_SCHEMA:-seazn_club}; select sport_key, string_agg(key, ',' order by is_system desc, name) from sport_variants where sport_key in ('generic','badminton') and org_id is null group by sport_key"
```
Expected, as read from code but not yet run: generic → `score,win_loss`, badminton → `bwf,short`. Record the actual output. A different first key changes the slice's variant, so record it in `_INDEX.md` before continuing.

- [ ] **Step 3: One-case live smoke**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fm-w1a)" && pnpm matrix:l3 --only 'league|generic' --scenario LIFECYCLE --run-id fm-w1a-smoke; echo EXIT=$?
```
Expected: `EXIT=0` and one line `league|generic|score|LIFECYCLE → <state>`. Open `matrix-report/fm-w1a-smoke/results.json` and read every check's `verdict` and `checked`.
- The state being **works** is the expectation, but not the gate. The gate is that the file holds 1 case with ≥1 applied check whose `checked > 0`.
- A ❌ here is either a harness bug (wrong route or body shape) or a product finding.
- Tell them apart by reading the `RefusedCall` code and path. A harness bug is fixed in the owning task's file, with its unit test updated, then this step is re-run. A product finding goes to Step 7.

- [ ] **Step 4: The full slice, twice**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fm-w1a)" && pnpm matrix:l3 --run-id fm-w1a-a; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fm-w1a)" && pnpm matrix:l3 --run-id fm-w1a-b; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && node -e 'const r=(id)=>JSON.parse(require("fs").readFileSync(`matrix-report/${id}/results.json`,"utf8"));const a=r("fm-w1a-a"),b=r("fm-w1a-b");const s=(x)=>Object.fromEntries(x.cases.map(c=>[c.caseId,c.state]));const sa=s(a),sb=s(b);const counts={};for(const c of a.cases)counts[c.state]=(counts[c.state]||0)+1;console.log(JSON.stringify({cases:a.cases.length,counts,notRun:a.cases.filter(c=>c.state==="not_run").length,vacuous:a.cases.filter(c=>!c.checks.some(k=>k.verdict!=="abstain"&&k.checked>0)).map(c=>c.caseId),differ:Object.keys(sa).filter(k=>sa[k]!==sb[k])}))'
```
Acceptance (paste the JSON line into the report):
- `cases == 24`
- the `counts` sum to 24
- `notRun == 0`
- `vacuous == []`, meaning every case has at least one applied check with `checked > 0`
- `differ == []`: the two runs agree case for case. A difference is a flake to investigate (AGENTS class 8, re-run three times), never averaged away.

Reds are allowed and expected. W1's truth run is a floor (design §7.3). Each red must name its check and evidence.

- [ ] **Step 5: The three canaries** (each must exit 0 = "went red on its own check, as designed")

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fm-w1a)" && pnpm matrix:l3 --canary M1 --run-id fm-w1a-canary-m1; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fm-w1a)" && pnpm matrix:l3 --canary R4 --run-id fm-w1a-canary-r4; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label fm-w1a)" && pnpm matrix:l3 --canary F1 --run-id fm-w1a-canary-f1; echo EXIT=$?
```
Expected: `EXIT=0` three times, each printing `canary <K>: red on <check>, as designed`. `EXIT=1` means the harness could not see the deliberate break. That is a harness defect and blocks sign-off (R17). The non-canary twin of each case (`league|generic|score|M1` etc. in `fm-w1a-a`) must NOT fail that same check. If it does, the pilot is red for real; record it in Step 7.

- [ ] **Step 6: Commit the evidence and add the drift test.**

Copy `matrix-report/fm-w1a-a/results.json` to `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1a-slice/results.json`, then render MATRIX.md from the committed copy:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && mkdir -p docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1a-slice && cp matrix-report/fm-w1a-a/results.json docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1a-slice/results.json && pnpm matrix:render docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1a-slice/results.json; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && grep -a -c -E 'eyJ|dl_|postgres://|token=' docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1a-slice/results.json
```
Expected: `EXIT=0` and a count of `0` (R14a; `writeResults` already refused secrets, and this is the belt to its braces).

`scripts/matrix/__tests__/committed-matrix.test.ts`:
```ts
// R10: the committed MATRIX.md is exactly render(committed results.json).
// Hand-editing either one reds here.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderMatrix } from "../lib/render-matrix.ts";
import { parseResults } from "../lib/results.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIR = resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1a-slice");

describe("committed W1a slice evidence", () => {
  const results = parseResults(JSON.parse(readFileSync(resolve(DIR, "results.json"), "utf8")));
  it("is the full slice, not an empty or partial run", () => {
    expect(results.cases.length).toBe(24);
    expect(results.cases.some((c) => c.canary)).toBe(false);
  });
  it("MATRIX.md is exactly the render of results.json", () => {
    expect(readFileSync(resolve(DIR, "MATRIX.md"), "utf8")).toBe(renderMatrix(results));
  });
});
```
Run it (template, `<N>`=11, `<files>`=`scripts/matrix/__tests__/committed-matrix.test.ts`). Mutation: add a space to the committed MATRIX.md, see it red, revert.

- [ ] **Step 7: Record the findings in `_INDEX.md` as they are found** (R22). Add a "W1a session status" entry with:
  - The run ids, the harness commit, and the Step 4 JSON line.
  - One line per ❌: the case, the failing check, its first evidence line, and a classification:
    - **product finding**: enters the owning wave's backlog per R5, and is never fixed here.
    - **harness defect**: fixed, with its test, before sign-off.
    - **environment**: reproduced on a clean env first (class 14).
  - Every false premise from this plan's list that the live run confirmed or refuted, including the Step 2 variant order.
  - The three canary exit lines.

  Do not label any recommendation as an owner ruling (R4, class 17).

- [ ] **Step 8: Tear down, commit and push**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh down --label fm-w1a; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/format-matrix-w1a && git add docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1a-slice scripts/matrix/__tests__/committed-matrix.test.ts docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md && git commit -F "$TMPDIR/fm-msg.txt" -- docs/superpowers/specs/2026-09-27-format-matrix-prompts scripts/matrix && git push
```
Then run the reviewer loop on the whole branch (R21, class 12). The reviewer answers R27's four questions for the harness itself: a **second call** (re-running a run id), an **empty** input (zero cases), **after a withdrawal or void** (R4), and **another sport** (the sweep). Findings are written to disk (memory: findings go to a file, not chat).

**Test types:**
- Unit: `committed-matrix.test.ts`.
- E2E: this task, 24 live cases through the real server, DB and engine.
- Smoke: Step 3.
- Regression: the drift test plus the three canaries. Re-run the canaries whenever a scenario changes.

---

## False premises found while planning

Recorded per R5 and class 5. Each was checked by reading the cited code. The ones marked (run) are re-checked live in Task 11.

1. **"There is no org-create route, so orgs must be seeded by SQL."** `POST /api/orgs` exists (`apps/web/src/app/api/orgs/route.ts`, `createOrgForUser`). It is capped per user by `orgs.max_owned`, and the slice needs 24 orgs, so SQL seeding stays. The reason is the quota, not a missing route.
2. **"`formats.double_elim` is a Pro feature."** V393 made it true on `community`. No public plan produces the "denied" state for double_elim, so W1b needs an explicit override deny, or the case must be dropped (open question 2).
3. **"The bench preflight refuses a DB that is not the harness's own."** `checkOwnDatabase` compares `show data_directory` only when `BENCH_EXPECTED_DATA_DIR` is set (`scripts/bench/lib/env.ts:442-452`). Otherwise it accepts any DB not on 5432. W1a makes the variable mandatory (`requireOwnDataDir`, Review Focus 3).
4. **"`plan.ts` is a small helper that is safe to import in isolation."** It imports `./seed.ts` at runtime (`plan.ts:80`), and `seed.ts:132` imports `./pack-schema.ts`. So importing `provisionPlan` transitively **loads** the PackSchema module. Ruling 17 forbids importing or depending on it; W1a never calls it, and the boundary test checks direct imports only. See open question 1.
5. **"W1a needs per-round generation for ladder."** Ladder `generate` creates nothing (`gen = []`, stages.ts ~2200-2440). Its fixtures come only from `POST /stages/:id/challenges` (needs `formats.advanced`). There is nothing per-round to drive. Ladder driving moves to W1b as challenge issuance.
6. **"`format-templates.ts` cannot be imported by a script."** (the `scripts/__tests__/seed-demo-templates.test.ts` comment). Its only import is `import type { TakeRule }` (`format-templates.ts:40`), which strip-types erases. Task 1's loadable test proves it by actually loading it.
7. **"Editing config never changes a finished fixture's result" presumes a post-result config edit exists.**
   - Division `variant_key` and any non-entrants `config` change return 409 `FORMAT_LOCKED` once any fixture exists (`divisions.ts:792-833`).
   - Per-stage rules return `STAGE_FORMAT_LOCKED` once the stage starts.
   - Only the entrants-only save passes.
   - W1a probes both. I5 checks that results are unchanged across the attempts, and `life-format-edit-refused-named` checks that the lock is a named refusal (R28). The meaningful "an accepted edit after results" case is W2+ rulebook territory.
8. **"`triple_rr` built by the builder is legs 3."** `buildTemplateStages` overwrites `legs` with the knob (`format-templates.ts:340`), and the builder shows the legs picker only for some templates. So at builder defaults `triple_rr` is **legs 1**. Task 1 pins what the code does; whether that is a product defect is recorded for the owner, not decided here.

## Deviations from the design and brief (stated, not silent)

- **Anti-vacuity counts ship in W1a.** The design §8 W1b row lists "anti-vacuity counts on every invariant"; the coordinator's ruling-21 update moved them here.
- **Ladder, americano and mexicano are driven in W1b.** They are deferred with `ScenarioUnsupported`, so they render ⏳, never ░ or ✅. The driver's `generate` is kind-agnostic already. What W1b adds is challenge issuance (ladder, `formats.advanced`) and the person-linked entrants americano needs (plan-facts-api.md B1).
- **Multi-stage rows and team sports are deferred to W1b.** Multi-stage rows need seed-proposal confirm; team sports need rosters.
- **Single worker.** One sign-in per run and cases in sequence. Parallel workers (one sign-in each) are a W1b speed concern.
- **Abandon is recorded, not asserted.** Its per-sport meaning (no_result vs undecided vs draw) is W2's rulebook.
- **Generator gaps are committed in `KNOWN_UNSUPPORTED`.** The list holds cricket two-innings only (`test`: win on every stage kind, draw on league and swiss), owned by W2's cricket rulebook. Carrom is NOT on it (corrected in the W1a final fix batch): no declared carrom variant can draw. `tieBoard` defaults to `"extra"` (engine `carrom.ts:69`), neither `icf` nor `club-29` sets `"draw"` (`carrom.ts:817-823`), and `supportsDraws` needs `tieBoard: "draw"` (`carrom.ts:983`). So a carrom draw is `OutcomeUnreachable` before the generator runs, not a gap. The `tieBoard:"draw"` house rule is still W2's carrom rulebook.
- **R4 asserts consistency with the policy the engine chose, not which policy should apply.** The latter is the rulebook's call (R6).
- **I2's "permutation" means each entrant exactly once in `finalRanks`.** Only knockout's champion check (one unbeaten entrant) is asserted. Double-elim, stepladder and page-playoff champion rules arrive with their rows in W1b.
- **Not planned (ruling 21):** fast-check (W1b), Stryker (W1d), `forEachSport` (W1b+), shadow invariants (W10). The invariant interface is shaped for them (Task 5 Interfaces).

## Open questions for the owner (recommendations, not rulings)

1. **Accept the transitive PackSchema load through `plan.ts`?** Recommendation: accept. W1a imports `provisionPlan` (bench-owned, R3) and never calls anything PackSchema-shaped. The alternative is copying `provisionPlan`'s cache-bust dance, which creates a second authority for it. Owner value: one plan-provisioning path to trust.
2. **The `double_elim` denied state (W1b).** Test it via an explicit entitlement-override deny, or drop it now that community grants it? Recommendation: override deny. The ⛔ path is still product code that someone on a future plan can hit. Owner value: the refusal copy stays tested.
3. **Is "default config" the builder's default** (first system variant by name: generic `score`, badminton `bwf`, volleyball `beach`, boardgame `blitz`, carrom `club-29`)? Recommendation: yes, because that is what an organiser gets by clicking through. `beach` and `blitz` being the default for volleyball and chess is itself worth a product look. Owner value: the matrix tests what customers actually create.

## Self-Review

- **Brief coverage:**
  - Lean runner importing only http/plan/env: Task 1 boundary, Task 9.
  - `OrganiserDriver` + `HttpDriver`, every listed action (create, stages via `buildTemplateStages`, entrants, start + acknowledge, generate incl. swiss per-round, events with correct `expected_seq`, forfeit/walkover, withdraw, complete never repeated, standings, final ranks, public standings): Task 6, Task 8.
  - Org/plan SQL seeding, one sign-in, own-DB refusal: Task 7, Task 9.
  - Generators for 11 sports folded in-process, draw reachability from `supportsDraws`, mutation step: Tasks 2–3.
  - Invariants I1–I5 (+ I6) pure with data preconditions, positive/negative/abstain + zero-count each: Task 5.
  - JSON schema + renderer + "No cases run": Task 4.
  - Slice of 6 cells + M1/R4/F1 each with a red-on-purpose canary: Tasks 8, 9, 11.
  - Live task per `seazn-local-env`: Task 11.
  - DB-free CI step after `ci.yml:195`, no scheduled workflow: Task 10.
  - JSON-reporter judging with `.testResults[].name`: Global Constraints.
- **Ruling 21:** `{verdict, checked, evidence}` on every invariant and assertion; central R25 guard; zero-count test per invariant; type-only modules; reuse contract stated in Task 5 Interfaces; no fast-check/Stryker/forEachSport/shadow.
- **Empty case first:** catalogue, sport-cfg, fold, streams sweep (discovery guard), decideState, renderMatrix, invariants (each), assertion helper, slice filters, run refusals, postStream empty stream, requireOwnDataDir, chooseTopPublicPlan.
- **Right answer ≠ wrong constant:** the swiss/knockout row builds not-league (T1), win_loss vs score draws (T2), the wrong side winning (T2), floor vs ceil (F1 canary), absent-side winner (M1 canary), opposite policy (R4 canary), `last_seq` 2 not 0 (T6).
- **Type consistency:**
  - `CheckResult` and `Verdict` have one authority (`results.ts`); `observed.ts` re-exports the types.
  - `StreamEvent`, `RequestedOutcome` and `StreamRequest` come only from `streams/types.ts`.
  - `StagePostBody` is used by `catalogue.ts`, the driver and the fake.
  - `DeclaredPoints` (fold) maps to `ObservedDeclared` (observed) through `toObservedOutcome`.
  - `CaseSpec` and `ScenarioKey` come from `scenarios/types.ts`, used by slice and run.
- **Known survivors (recorded):**
  - Football's ET/shootout draw guard: no declared variant reaches it.
  - Carrom's draw guard in `streams/carrom.ts` (the `GeneratorUnsupported` throw on a draw): no declared variant reaches it, because `supportsDraws` needs `tieBoard: "draw"` and no variant sets it, so `generateStream` throws `OutcomeUnreachable` first.
  - The `'owner'` role in `insertCaseOrg`: covered live only.
  - The swiss `pairRounds.push`: covered live only.
- **Where the plan trusts a read over a run** (the executor verifies each one, class 5):
  - GET `/api/orgs` shape (the parser accepts three).
  - `outcome` JSON on the fixtures list.
  - The entrants-only probe body.
  - The builder variant query's `where` clause.
  - The whitespace in the `createOrgForUser` text pin.
  - `PlanCandidateInfo` being exported from `plan.ts`. If it is not, re-declare the three-field type locally and note it.

## Execution handoff

Execute task by task with superpowers:subagent-driven-development: implementer → reviewer per task, in order 1→11. The file sets overlap through `streams/index.ts`, the loadable/boundary tests and `scenarios/*`, so tasks run **sequentially**, never in parallel.

Every dispatch brief restates:
- the Global Constraints, especially "local verify = the exact test files named in the step; no tsc, no eslint, no directory runs";
- the verify command with its `<N>` and `<files>` filled in;
- what not to touch;
- the output cap: "final message under 15 lines — the vitest JSON line, the mutation kill list, deviations, blockers; no file contents".

The controller re-runs each task's named test files itself before accepting "done".
