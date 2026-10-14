# Engine split — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan batch by batch. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution note (2026-10-14, batch 1a):** the parity script lives at `scripts/lib/test-parity.mjs` (moved from `scripts/` because `tools-tests-typecheck` requires every `scripts` declaration twin under `scripts/lib`). Live scheduler tests are under `packages/scheduler/src/__tests__/`.

**Execution note (2026-10-14, batch 1b review m4):** collect parity ids with `vitest run --isolate -t __parity_collect_only__ --reporter=json --outputFile <f> <files>` on BOTH sides, every batch. The engine's vitest config has `isolate: false` and `src/import/plan.property.test.ts` imports `./plan.test.ts`, so without `--isolate` the attribution of 19 ids depends on worker scheduling and the script reports unaccounted ids that still exist (1b review: 19 unaccounted without it, 0 with). The `scripts/lib/test-parity.mjs` header says the same.

**Revision 2 (2026-10-14)** — rewritten after the Opus plan review (`docs/superpowers/specs/engine-split/reviews/plan-phase1.md`: 1 BLOCKER, 19 MAJOR, 24 MINOR). Each fix cites its finding as `[R#]`.

**Goal:** Inside the monorepo, make `@seazn/engine` a pure, publishable, phone-safe library: the placement client moves out behind a port, a compiled `dist/` is published as canaries, the tests that read across the package boundary are rehomed in both directions, fold epochs are pinned to the golden corpora, and the server refuses outdated engine epochs. After this, Phases 2a and 2b are pure relocations.

**Architecture:** Six batches, one PR each, landed in the order 1a → 1b → 1d → 1c → 1e → 1f. 1d comes before 1c because 1d moves `engine-boundary.ts`, which 1c then extends. The app consumes the engine from the workspace throughout; only the published tarball is compiled. Every batch carries its own parity proof.

**Tech Stack:** TypeScript 7 (`typescript-native` 7.0.2), Node 26 `--experimental-strip-types`, pnpm 10.34.5 workspaces, turbo 2.10.8, vitest 4, Playwright, Next 16, GitHub Actions + GitHub Packages, Metro + Hermes (React Native 0.86.3, `hermes-compiler`).

**Spec:** `docs/superpowers/specs/2026-10-13-engine-split-design.md` (owner-approved; ledger D1–D33 OWNER; D31–D33 ruled "approve" 2026-10-14, plan rev 2 approved for execution — D32 lists every plan-level deviation from the spec [R39]). Fact sheet: `.superpowers/handoff/2026-10-13-engine-split/phase1-plan-facts.md` (gitignored, main checkout). Plan review: `docs/superpowers/specs/engine-split/reviews/plan-phase1.md`. Line numbers are against `origin/main` `5871c748e`. **Re-pin every one before editing** (AGENTS.md class 5).

## Execution topology (D30, owner ruling)

- One batch is one PR in one worktree: `~/github/seazn.club-worktrees/engine-split-<batch>` on branch `feat/engine-split-<batch>`, created from fresh `origin/main` with `git fetch origin && git worktree add -b feat/engine-split-1a ~/github/seazn.club-worktrees/engine-split-1a origin/main`. Run `pnpm install` in the worktree first; a fresh worktree has no `node_modules`.
- **Every Bash call starts `cd <abs worktree> &&`.** Shell cwd resets to the main checkout between calls (AGENTS.md).
- **Each task:** `implementer-sonnet` implements it, then `reviewer-sonnet` reviews it. Loop until the review is clean and the task's scoped tests are green.
- **Each batch:** `reviewer` (Opus) reviews the batch whole. It answers TEST-STRATEGY's four questions in writing, writes its findings to `docs/superpowers/specs/engine-split/reviews/<batch>.md`, and the batch loops until that review is clean.
- **The Sonnet agent definitions** (`.claude/agents/implementer-sonnet.md`, `reviewer-sonnet.md`) are untracked files in the main checkout. Dispatch from the main-checkout session, which has them, and pass each agent the absolute worktree path. Never override `model:`. [R38]
- **The orchestrator reruns each batch's scoped gate itself** before opening the PR. It judges green only from `--reporter=json --outputFile "$(mktemp)"` counts, with `.testResults[].name` confirmed. Always `mktemp`, never a fixed `/tmp` name: a parallel session can clobber it, or a stale file can be read. [R31]
- **The orchestrator opens the PR; the owner merges.** Before merging any PR that touches `packages/engine`, message f-w2c, mutation and chess so they rebase once. Mutation-owned files (`mutation.yml`, `stryker-*`) are edited only after telling the mutation session (spec §15).

## Global Constraints

- **No engine behaviour change (D5).** The ports change the engine's API and dependencies, never what it computes. Task 1a-2 proves this on every arm of `solveBuild`.
- **Scoped tests only.** Never run the full vitest, e2e or gate locally. Parity ids are collected with a no-match filter that runs no test bodies (Task 1a-1). Run vitest from the package directory, never `--root`.
- **Every change ships a test that fails without it.** Every guard added is mutated once (TEST-STRATEGY rule 5). Every sweep reports its count, and zero checked fails (rule 2).
- **Four test types per task (RULES.md:64-82).** Every task has a `Four types:` line naming its unit, e2e, smoke and regression evidence. "Not applicable" is allowed only with the reason stated. [R14]
- **Prohibitions.** No `git stash`. A worktree for every branch. Synthetic data only. Never print a token. Never delete a remote repo, package, cache or tag.
- **Names.** Published as `@onryde/seazn-engine`, imported everywhere as `@seazn/engine` (D19). The new private workspace package is `@seazn/scheduler`.
- **Phone subpaths** (`phone-subpaths.json`) import no `node:*` or bare builtin, read no `process`, and import nothing from `scheduling` (D25).
- **`FOLD_EPOCH`** is 1 for all 11 sports at creation (D26).
- **No user-facing strings are expected.** If one appears, it goes in all 4 locale dictionaries.
- **Pre-flight before each batch:** `git fetch origin` and `git diff origin/main...origin/<branch> --stat` for every open W2c/W2d/W2e branch (`git branch -r | grep format-matrix-w2`). If a batch's files overlap, tell the owning session and sequence behind it (spec §14 R6). [R37]

## Review Focus

These failure modes are the ones most likely to bite a person that no task's happy-path tests would catch. Each is pinned in the named task.

1. **Placement down or secret wrong after the port.** An organiser pressing Auto-schedule must still get a greedy board with `status: "solver_unavailable"`, never a 500, and the real adapter must have been the thing that failed. Pinned in Task 1a-4 Step 1. [R21]
2. **The live placement test silently testing greedy.** After the move, `placement-integration.test.ts` must still reach the real service through the real adapter. A `solver_unavailable` while `PLACEMENT_SERVICE_HOST` is set fails. Pinned in Tasks 1a-2 Step 5 and 1a-3 Step 3. [R3]
3. **A `"use client"` file importing `@seazn/scheduler`** drags gRPC into the browser bundle, and `next build` dies with `Module not found: dns`. Pinned in Task 1a-4 Step 5, by rewriting the derivation. [R7]
4. **The fold-epoch guard failing open.** Streams that stop matching (config renamed, re-recorded) or a fold that changes only mid-match (`states`, which is what a phone shows) must demand a bump. Pinned in Task 1e-2. [R16, R17]
5. **The server refusing the wrong thing.** Only the sport whose epoch moved is refused. A refusal never burns the idempotency key. A retry of an already-accepted key answers the same whether the cache is warm or cold. Pinned in Task 1f-1. [R18, R35]

---

# Batch 1a — solver port, logger port, `packages/scheduler` (spec §5.1, D11, D25, D29)

Worktree `engine-split-1a`.

### Task 1a-0: Record D30 in the house rules [R38]

**Only if the owner approves editing RULES.md** (asked at plan handoff, 2026-10-14). If not approved, skip this task; D30 in the spec ledger remains the record.

**Files:** Modify `docs/superpowers/RULES.md` (Agent topology, :48-49).

- [ ] Add under "Agent topology": "**2026-10-13 (D30, engine-split spec):** the engine-split programme's plans run Sonnet `implementer-sonnet`/`reviewer-sonnet` per task and Opus `reviewer` per batch — an owner extension of the W2c-only Sonnet exception." Do not edit the untracked agent files; they belong to the session that created them.
- [ ] **Four types:** n/a, docs only.
- [ ] Commit: `docs(rules): record the engine-split execution topology (D30)`.

### Task 1a-1: Test-parity script

This is the script every later batch uses to prove "the same tests, nothing lost" (spec §5.4, D32a).

**Files:**
- Create: `scripts/lib/test-parity.mjs`, `scripts/lib/test-parity.d.mts`, `scripts/__tests__/test-parity.test.ts`

**Interfaces:**
- Produces: CLI `node scripts/lib/test-parity.mjs --before <report.json>=<root> [--before …] --after <report.json>=<root> [--after …] [--ledger <ledger.json>]`.
  - Exit codes: 0 when everything is accounted for, 1 when ids are unaccounted, 2 when the input is invalid or vacuous.
  - Exports `testIds(report, root): string[]` and `diffIds(before: string[], after: string[], ledger): { onlyBefore, onlyAfter, both, unaccounted }`.
- **Collection command** (runs no test bodies, but reports every collected test, skipped ones included) [R4]: `./node_modules/.bin/vitest run -t "__parity_collect_only__" --reporter=json --outputFile "$(mktemp)" <paths>`.
- **Ledger format:** `{ "entries": [{ "id", "fate", "to"?, "reason" }] }`, where `fate` is one of:
  - `moved` / `rehomed` / `split` / `rewritten`: `to` is required and must exist in the after set [R5];
  - `added`: `id` must be after-only;
  - `retired`: `id` must be before-only, `reason` required.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/__tests__/test-parity.test.ts
import { describe, expect, it } from "vitest";
import { diffIds, testIds } from "../test-parity.mjs";

type T = { path: string[]; status?: string };
const report = (root: string, files: Record<string, T[]>) => ({
  numTotalTests: Object.values(files).reduce((n, t) => n + t.length, 0),
  testResults: Object.entries(files).map(([name, tests]) => ({
    name: `${root}/${name}`,
    assertionResults: tests.map(({ path, status = "skipped" }) => ({ ancestorTitles: path.slice(0, -1), title: path.at(-1)!, status })),
  })),
});

describe("test-parity", () => {
  it("names a test by root-relative file, describe chain and title", () => {
    const r = report("/x/packages/engine", { "src/a.test.ts": [{ path: ["A", "b"] }] });
    expect(testIds(r, "/x/packages/engine")).toEqual(["src/a.test.ts › A › b"]);
  });

  it("keeps a test that is skipped in its own file (it.skip / skipIf), not only filter-skipped ones", () => {
    const r = report("/x", { "a.test.ts": [{ path: ["live"], status: "skipped" }, { path: ["todo"], status: "todo" }] });
    expect(testIds(r, "/x")).toEqual(["a.test.ts › live", "a.test.ts › todo"]);
  });

  it("reports nothing unaccounted when both sides hold the same ids under different roots", () => {
    const a = testIds(report("/mono/packages/engine", { "t.test.ts": [{ path: ["x"] }] }), "/mono/packages/engine");
    const b = testIds(report("/engine", { "t.test.ts": [{ path: ["x"] }] }), "/engine");
    expect(diffIds(a, b, { entries: [] }).unaccounted).toEqual([]);
  });

  it("flags an id that vanished without a ledger entry", () => {
    expect(diffIds(["f › a", "f › b"], ["f › a"], { entries: [] }).unaccounted).toEqual(["f › b"]);
  });

  it("accepts a rehome whose target exists after, and only that one", () => {
    const ledger = { entries: [{ id: "f › b", fate: "rehomed", to: "g › b", reason: "reads apps/web" }] };
    expect(diffIds(["f › a", "f › b", "f › c"], ["f › a", "g › b"], ledger).unaccounted).toEqual(["f › c"]);
  });

  it("refuses a rehome whose target does not exist after (a deleted test passing as moved)", () => {
    const ledger = { entries: [{ id: "f › b", fate: "rehomed", to: "g › b", reason: "x" }] };
    expect(diffIds(["f › b"], [], ledger).unaccounted).toEqual(["f › b", "LEDGER-TARGET-MISSING g › b"]);
  });

  it("flags an id that appeared from nowhere, and accepts it as `added`", () => {
    expect(diffIds(["f › a"], ["f › a", "f › new"], { entries: [] }).unaccounted).toEqual(["f › new"]);
    expect(diffIds(["f › a"], ["f › a", "f › new"], { entries: [{ id: "f › new", fate: "added", reason: "new guard" }] }).unaccounted).toEqual([]);
  });

  it("refuses an empty report rather than passing it", () => {
    expect(() => testIds({ numTotalTests: 0, testResults: [] }, "/x")).toThrow(/zero tests/);
  });
});
```

- [ ] **Step 2: Run it and expect FAIL** (module not found). `cd <wt> && OUT=$(mktemp) && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile "$OUT" scripts/__tests__/test-parity.test.ts; node -e 'const r=require(process.argv[1]);console.log(r.numPassedTests,r.numTotalTests,r.testResults.map(t=>t.name))' "$OUT"`.

- [ ] **Step 3: Implement**

```js
// scripts/lib/test-parity.mjs
// The same tests before and after a move, or every difference accounted for in a ledger (engine-split spec §5.4, D23, D32a).
// Collect ids with `vitest run -t "__parity_collect_only__" --reporter=json`: no test body runs, every collected test
// (it.skip / skipIf / todo included) is reported. `vitest list --json` drops skipped tests, so it is not used.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEP = " › ";
const NEEDS_TARGET = new Set(["moved", "rehomed", "split", "rewritten"]);

export function testIds(report, root) {
  const ids = [];
  for (const file of report?.testResults ?? []) {
    const rel = path.relative(root, file.name).split(path.sep).join("/");
    for (const a of file.assertionResults ?? []) ids.push([rel, ...(a.ancestorTitles ?? []), a.title].join(SEP));
  }
  if (ids.length === 0) throw new Error(`zero tests in report under ${root}: a parity check over nothing is vacuous`);
  return ids.sort();
}

export function diffIds(before, after, ledger) {
  const a = new Set(before);
  const b = new Set(after);
  const onlyBefore = before.filter((id) => !b.has(id));
  const onlyAfter = after.filter((id) => !a.has(id));
  const both = before.filter((id) => b.has(id));
  const accounted = new Set();
  const missingTargets = [];
  for (const e of ledger?.entries ?? []) {
    if (NEEDS_TARGET.has(e.fate)) {
      if (!e.to || !b.has(e.to)) { missingTargets.push(`LEDGER-TARGET-MISSING ${e.to ?? "(none)"}`); continue; }
      accounted.add(e.id);
      accounted.add(e.to);
    } else if (e.fate === "added" && onlyAfter.includes(e.id)) accounted.add(e.id);
    else if (e.fate === "retired" && onlyBefore.includes(e.id) && e.reason) accounted.add(e.id);
  }
  const unaccounted = [...[...onlyBefore, ...onlyAfter].filter((id) => !accounted.has(id)), ...missingTargets];
  return { onlyBefore, onlyAfter, both, unaccounted };
}

function pairs(flag) {
  const out = [];
  process.argv.forEach((v, i) => {
    if (v === flag) {
      const [file, root] = process.argv[i + 1].split("=");
      out.push({ file, root: path.resolve(root ?? ".") });
    }
  });
  if (out.length === 0) throw new Error(`missing ${flag} <report.json>=<root>`);
  return out;
}
const ids = (flag) => pairs(flag).flatMap(({ file, root }) => testIds(JSON.parse(readFileSync(file, "utf8")), root));

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const li = process.argv.indexOf("--ledger");
    const ledger = li === -1 ? { entries: [] } : JSON.parse(readFileSync(process.argv[li + 1], "utf8"));
    const d = diffIds(ids("--before"), ids("--after"), ledger);
    console.log(`before-only ${d.onlyBefore.length} · after-only ${d.onlyAfter.length} · both ${d.both.length} · unaccounted ${d.unaccounted.length}`);
    for (const id of d.unaccounted) console.log(`UNACCOUNTED ${id}`);
    process.exit(d.unaccounted.length === 0 ? 0 : 1);
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(2);
  }
}
```

```ts
// scripts/lib/test-parity.d.mts — declaration twin; scripts/__tests__ is type-checked by tsc -p tsconfig.tools-tests.json (ci.yml:123) [R6]
export interface ParityReport { numTotalTests?: number; testResults?: { name: string; assertionResults?: { ancestorTitles?: string[]; title: string; status?: string }[] }[] }
export interface LedgerEntry { id: string; fate: "moved" | "rehomed" | "split" | "rewritten" | "added" | "retired"; to?: string; reason: string }
export function testIds(report: ParityReport, root: string): string[];
export function diffIds(before: string[], after: string[], ledger: { entries: LedgerEntry[] }): { onlyBefore: string[]; onlyAfter: string[]; both: string[]; unaccounted: string[] };
```

- [ ] **Step 4: Run and expect 8/8 PASS.** Also run `node ../../node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json` from the repo root (the `ci.yml:123` check) and expect exit 0. Then **confirm the collection command on real files**: run it over `packages/engine/src/scheduling/build-determinism.test.ts` (`describe.skip`, :54) and `__tests__/placement-integration.test.ts` (`skipIf`, :214). The JSON must list their ids. If vitest omits them, stop and report.
- [ ] **Step 5: Mutate once.** Make `diffIds` skip the target check. The "refuses a rehome whose target does not exist" test must go red. Revert.
- [ ] **Four types:**
  - unit: this file;
  - e2e: n/a (a developer tool, no user flow);
  - smoke: n/a, same reason;
  - regression: the skipped-test and missing-target cases.
- [ ] Commit: `feat(engine-split): test-parity script — same ids before and after, or a checked ledger entry`.

### Task 1a-2: The port in the engine, with a before/after equivalence proof

**Files:**
- Create: `packages/engine/src/scheduling/solver-port.ts`, `packages/engine/src/scheduling/__tests__/solver-fakes.ts`, `packages/engine/src/scheduling/__tests__/equivalence-scenarios.ts`, `packages/engine/src/scheduling/build-port-equivalence.test.ts`
- Modify: `packages/engine/src/scheduling/build.ts` (:125-126, :503-562, :1157, :1438, :2095-2160, log sites :1158 :1915 :1953 :2150 :2193 :2252), `repair-decompose-cpsat.ts` (:178-212, :331, :338, :471-478), `index.ts`, and the tests in Step 5

**Interfaces** (exported from `@seazn/engine/scheduling`):

```ts
// packages/engine/src/scheduling/solver-port.ts
// The engine's side of the placement boundary (engine-split spec §5.1, D11, D25). The engine decides WHAT to ask a
// solver and what to do with the answer; the caller decides HOW the question reaches one. No transport, env or secret here.
import type { BuildInput } from "./build.ts";

export interface SolveBuildInput { /* moved VERBATIM from placement-client.ts:58-190 */ }
export interface SolveBuildOutcome {
  assignments: { fixtureId: string; court: string; startAtMs: number }[];
  status: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "UNKNOWN" | "ERROR";
  tiersCompleted: number;
  objectiveValues: { name: string; value: number }[];
  elapsedMs: number;
  wallExhausted: boolean;
  error?: { code: string; message: string };
}
export interface SolveContext {
  /** Correlation id for the solver's logs, built by the engine from `t0` (build.ts ~:2120). */
  readonly requestId: string;
}
/** Rejecting is how a solver says "no answer". A rejection MAY carry a string `failure`, which build.ts duck-types. */
export type PlacementSolver = (input: SolveBuildInput, ctx: SolveContext) => Promise<SolveBuildOutcome>;

type LogFn = (fields: Record<string, unknown>, message: string) => void;
/** The four levels the scheduler uses, in pino's (fields, message) order. */
export interface EngineLogger { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn }
export const silentLogger: EngineLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A build request without its ports — the shape tests and callers assemble before choosing a solver [R23]. */
export type BuildProblem = Omit<BuildInput, "solve" | "log">;
```

- `BuildInput` gains `solve: PlacementSolver; log: EngineLogger`. Both are **required** (D29). An optional `solve` defaulting to greedy would be an inert seam.
- `DecomposedCpsatRepairInput` gains the same two required fields.

- [ ] **Step 1: Pick the scenarios from tests that already pin real outcomes** [R2]. Create `__tests__/equivalence-scenarios.ts` exporting `EQUIVALENCE_SCENARIOS: { name: string; source: string; problem: () => BuildProblem; solver: (input: SolveBuildInput) => Promise<SolveBuildOutcome> }[]`.
  - Each entry's `source` names the test it was lifted from, and each lifts that test's input and solver behaviour verbatim. Required scenarios:
    - `optimized`: `build.test.ts` ~:265 "places a card greedy declared unplaceable" (`cornerFixtures`/`cornerConfig` + its `mockResolvedValue` outcome; asserts `engine: "optimized"` at ~:285);
    - `already_optimal`: `build-day-gate.test.ts` ~:156 "still claims already_optimal on our own ladder";
    - a POLISH case with `frozen`/`current` (from `build-polish.test.ts`);
    - an `INFEASIBLE` case with pinned `existing` (from `build.test.ts`; grep `"INFEASIBLE"`);
    - a `dependencies` case (from `build-rest-lattice.test.ts` or `round-order`);
    - one rejection (`failure: "unavailable"`);
    - `status: "ERROR"` and `status: "UNKNOWN"`;
    - an overlapping board → `verifier_rejected`;
    - **0 fixtures** (the empty input).
  - The six calls in `build-determinism.test.ts` are one input inside a `describe.skip`, so do not use them as six scenarios.
- [ ] **Step 2: Write the equivalence test against the CURRENT code** (before touching `build.ts`):

```ts
// packages/engine/src/scheduling/build-port-equivalence.test.ts
// Before/after proof for the solver port (engine-split plan Task 1a-2): the port changes HOW the solver is reached, never
// WHAT the engine asks or returns. The snapshot is recorded on the pre-port code and must not change when the port lands.
import { describe, expect, it, vi } from "vitest";
import { buildSchedule } from "./build.ts";
import { EQUIVALENCE_SCENARIOS } from "./__tests__/equivalence-scenarios.ts";

// elapsedMs / requestId vary per run; wallSeconds is derived from elapsed time (build.ts:2096) and can cross a rounding edge.
const VOLATILE = new Set(["elapsedMs", "requestId", "wallSeconds"]);
const stable = (r: object) => JSON.parse(JSON.stringify(r, (k, v) => (VOLATILE.has(k) ? 0 : v)));

describe("solver port equivalence", () => {
  it(`covers ${EQUIVALENCE_SCENARIOS.length} scenarios, including optimized and the empty input`, () => {
    expect(EQUIVALENCE_SCENARIOS.length).toBeGreaterThanOrEqual(10);
    expect(EQUIVALENCE_SCENARIOS.map((s) => s.name)).toEqual(expect.arrayContaining(["optimized", "already_optimal", "empty"]));
  });

  for (const s of EQUIVALENCE_SCENARIOS) {
    it(`asks the solver the same question and returns the same board: ${s.name} (from ${s.source})`, async () => {
      const calls: unknown[] = [];
      const client = await import("./placement-client.ts");
      const spy = vi.spyOn(client, "solveBuild").mockImplementation(async (input) => { calls.push(input); return s.solver(input); });
      const result = await buildSchedule(s.problem());
      spy.mockRestore();
      expect(result.status, "a leaked queue counter from another file would read solver_busy").not.toBe("solver_busy");
      expect(stable({ calls, result })).toMatchSnapshot();
    });
  }
});
```

  The engine runs with `isolate: false`. Steps 3 and 7 therefore run this file **alone**, and each case asserts "not `solver_busy`" first. [R44]
- [ ] **Step 3: Record the snapshot on the old code.** `cd <wt>/packages/engine && OUT=$(mktemp) && ./node_modules/.bin/vitest run -u --reporter=json --outputFile "$OUT" src/scheduling/build-port-equivalence.test.ts`. Confirm ≥ 11 tests pass and that the snapshot file exists. Read the snapshot and confirm the `optimized` case shows `engine: "optimized"`; otherwise the scenario is wrong. **Commit the test, the scenarios and the snapshot alone:** `test(scheduling): record solver requests and boards on every solveBuild arm before the port`.
- [ ] **Step 4: Create `solver-port.ts`.** Move `SolveBuildInput` (placement-client.ts:58-190) and `SolveBuildOutcome` (:192-200) verbatim. `placement-client.ts` imports them from `./solver-port.ts` and re-exports them, so nothing breaks yet. **Guard:** if the moved block references `./generated/` or `@grpc/grpc-js`, stop and report.
- [ ] **Step 5: Thread the ports through `build.ts` and `repair-decompose-cpsat.ts`, and convert the tests.**
  - `build.ts`:
    - Delete the `log` import (:126). :125 becomes `import type { EngineLogger, PlacementSolver, SolveBuildInput, SolveBuildOutcome } from "./solver-port.ts";`.
    - Add `solve` and `log` to `BuildInput` (:503-562), each with a one-line doc comment citing D11/D25.
    - Every logging site reads `input.log`; pass `log` into any helper that logs without `input`. Messages, levels and fields stay byte-identical.
    - :2120-2126 becomes `outcome = await input.solve(placementInput, { requestId });`.
    - Delete the dynamic-import comment (:2099-2108) and the `PLACEMENT_SERVICE_SECRET` read. The `catch` (:2128-2154) stays.
  - `repair-decompose-cpsat.ts`: add `solve` and `log` to `DecomposedCpsatRepairInput` (:178-212). Pass them in the `buildSchedule({...})` at :471-478. Fix the stale comment at :331, which cites `withZ3LockAndReset` at `build.ts:1196` (gone); describe the queue cap at `build.ts:1155-1209` instead.
  - `index.ts`: `export * from "./solver-port.ts";`.
  - **Fakes:**

```ts
// packages/engine/src/scheduling/__tests__/solver-fakes.ts
import { vi } from "vitest";
import type { EngineLogger, PlacementSolver, SolveBuildOutcome } from "../solver-port.ts";
export { silentLogger } from "../solver-port.ts";

/** What the old tests got when no spy was installed: the client could not reach a service. */
export const unavailableSolver: PlacementSolver = async () => {
  throw Object.assign(new Error("placement service unavailable (test fake)"), { failure: "unavailable" });
};
export const fakeSolver = (impl: PlacementSolver) => vi.fn<PlacementSolver>(impl);
export const resolvingSolver = (outcome: SolveBuildOutcome) => vi.fn<PlacementSolver>(async () => outcome);
export const recordingLogger = () => {
  const lines: { level: keyof EngineLogger; fields: Record<string, unknown>; message: string }[] = [];
  const at = (level: keyof EngineLogger) => (fields: Record<string, unknown>, message: string) => void lines.push({ level, fields, message });
  return { lines, log: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } satisfies EngineLogger };
};
```

  - **Conversion rule.** It applies to:
    - `build.test.ts` (55 spies + `vi.doMock` :771 + the `log` spies at :686 and :811 [R42]);
    - `build-polish` (8), `build-rest-lattice` (6), `build-day-gate` (2), `build-refusal-logged` (1);
    - every `buildSchedule(` / `repairDecomposedCpsat(` in `build-budget`, `build-determinism`, `build-pins`, `build-conflict-sources`, `repair-decompose-cpsat.test.ts` and `__tests__/repair-decompose-cpsat-integration.test.ts`;
    - **and `__tests__/placement-integration.test.ts`** (:245, :275, :323, :370) [R3].

```ts
// BEFORE
const spy = vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue(outcome);
const result = await buildSchedule(input);
expect(spy).toHaveBeenCalledTimes(1);
// AFTER
const solve = resolvingSolver(outcome);
const result = await buildSchedule({ ...input, solve, log: silentLogger });
expect(solve).toHaveBeenCalledTimes(1);
```

  - A call with no spy installed passes `solve: unavailableSolver`, which is the branch it was exercising.
  - `mockImplementation(fn)` becomes `fakeSolver(fn)`, and `mockRejectedValue(e)` becomes `fakeSolver(async () => { throw e; })`.
  - Pino `log` spies become `recordingLogger()` assertions on the same levels and messages.
  - `PlacementError` in these tests becomes `Object.assign(new Error(msg), { failure })`.
  - Helpers typed `BuildInput` (`build.test.ts:159-203, :1514`, `placement-integration.test.ts:121`) become `BuildProblem`.
  - **`placement-integration.test.ts`** passes a live solve while it still sits in the engine: `const liveSolve: PlacementSolver = (i, c) => solveBuild(i, { secret: process.env.PLACEMENT_SERVICE_SECRET ?? "", requestId: c.requestId })`, with `solveBuild` imported from `../placement-client.ts`, and `log: silentLogger`. Add a guard in an `afterEach`: when `PLACEMENT_SERVICE_HOST` is set, any result with `status === "solver_unavailable"` fails the test, **except** the :317 deliberate-localhost:1 case. This stops the live seam testing greedy silently. [R3]
  - **Titles do not change. No test is added or removed.**
- [ ] **Step 6: Point the equivalence test at the port.** Replace its `vi.spyOn` with `fakeSolver(async (i) => { calls.push(i); return s.solver(i); })`, pass `{ ...s.problem(), solve, log: silentLogger }`, and run the file ALONE, without `-u`. Expect all pass and `git diff --exit-code packages/engine/src/scheduling/__snapshots__/`. Any diff means the port changed behaviour: stop and report.
- [ ] **Step 7: Parity.** In a detached scratch worktree at the Step-3 commit (`git worktree add --detach <scratch> <sha> && cd <scratch> && pnpm install`), run the collection command over `packages/engine/src/scheduling` into `B=$(mktemp)`. On the branch, the same into `A=$(mktemp)`. Then `node scripts/lib/test-parity.mjs --before "$B=<scratch>/packages/engine" --after "$A=<wt>/packages/engine"` and expect `unaccounted 0`. Paste the counts into the commit body.
- [ ] **Step 8: Typecheck the engine:** `cd <wt>/packages/engine && pnpm typecheck` and expect exit 0. The apps/web callers are fixed in 1a-4.
- [ ] **Step 9: Mutate once.** Replace `await input.solve(...)` with `await Promise.reject(new Error("x"))`. The `optimized` equivalence case and `build.test.ts` ~:265 must go red. Revert.
- [ ] **Four types:**
  - unit: the converted suites;
  - e2e: deferred to 1a-4 Step 10 (`auto-schedule.spec.ts`, `placement-cutover.spec.ts`), which is the user flow this changes;
  - smoke: 1a-4 Step 10;
  - regression: the equivalence snapshot over every arm.
- [ ] Commit: `refactor(scheduling): the engine asks an injected solver and logger instead of opening gRPC (D11, D25)`.

### Task 1a-3: `packages/scheduler` — the client, the stubs and the adapter

**Files:**
- Move (`git mv`) from `packages/engine/src/scheduling/`: `placement-client.ts`, `placement-client.test.ts`, `generated/`, `logger.ts` and `__tests__/placement-integration.test.ts` go to `packages/scheduler/src/`; `packages/engine/scripts/gen-proto.ts` goes to `packages/scheduler/scripts/`.
- Create: `packages/scheduler/{package.json,tsconfig.json,eslint.config.mjs,vitest.config.ts,src/index.ts,src/solver.ts,src/solver.test.ts,test/runtime-deps.test.ts}`.
- Modify:
  - `packages/engine/package.json`: drop `@bufbuild/protobuf`, `@grpc/grpc-js`, `pino`, `protoc`, `ts-proto`, `gen:proto` and the `./scheduling/placement-client` export;
  - `packages/engine/test/runtime-deps.test.ts` (:76-88);
  - `packages/engine/stryker.groups.mjs` (:294, :296, :304);
  - `packages/engine/test/stryker-groups.test.ts` (:154, :155, :157) [R24];
  - `pnpm-lock.yaml`.

**Interfaces:**
- Consumes: `PlacementSolver`, `EngineLogger`, `SolveBuildInput`, `SolveBuildOutcome`, `BuildProblem` and `silentLogger` from `@seazn/engine/scheduling`.
- Produces from `@seazn/scheduler`: `placementSolver: PlacementSolver`, `schedulerLog: EngineLogger`, `PlacementError`, `PlacementFailure`. Subpath `@seazn/scheduler/placement-client` serves tests that spy on `solveBuild`.

- [ ] **Step 1: Write the failing adapter test**

```ts
// packages/scheduler/src/solver.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SolveBuildInput } from "@seazn/engine/scheduling";
import { placementSolver } from "./solver.ts";

const INPUT = { wallSeconds: 1 } as unknown as SolveBuildInput; // the adapter forwards it untouched; its shape is the client's concern
const OK = { assignments: [], status: "OPTIMAL", tiersCompleted: 0, objectiveValues: [], elapsedMs: 1, wallExhausted: false } as const;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("placementSolver (the adapter behind the engine's solver port)", () => {
  it("forwards the engine's question and requestId, and the secret from the environment", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_SECRET", "test-secret");
    const spy = vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockResolvedValue({ ...OK, assignments: [] });
    await placementSolver(INPUT, { requestId: "build-1f1c-7" });
    expect(spy).toHaveBeenCalledWith(INPUT, { secret: "test-secret", requestId: "build-1f1c-7" });
  });

  it("sends an empty secret when none is configured, and lets the client's rejection through unchanged", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_SECRET", undefined as unknown as string);
    const spy = vi.spyOn(await import("./placement-client.ts"), "solveBuild").mockRejectedValue(Object.assign(new Error("no"), { failure: "unauthenticated" }));
    await expect(placementSolver(INPUT, { requestId: "r" })).rejects.toMatchObject({ failure: "unauthenticated" });
    expect(spy.mock.calls[0]![1]).toEqual({ secret: "", requestId: "r" });
  });
});
```

- [ ] **Step 2: Create the package**

```json
// packages/scheduler/package.json
{
  "name": "@seazn/scheduler",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./placement-client": "./src/placement-client.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "node ../../node_modules/typescript-native/bin/tsc --noEmit",
    "lint": "eslint",
    "gen:proto": "node --experimental-strip-types scripts/gen-proto.ts"
  },
  "dependencies": { "@bufbuild/protobuf": "^2.13.0", "@grpc/grpc-js": "^1.14.4", "@seazn/engine": "workspace:*", "pino": "^10.3.1" },
  "devDependencies": { "@types/node": "^26", "protoc": "35.1.0", "ts-proto": "2.12.0", "typescript-native": "npm:typescript@7.0.2", "vitest": "^4.1.11" }
}
```

  Copy `tsconfig.json` and `eslint.config.mjs` from `packages/reference/`, with `include` set to `src`, `test` and `scripts`. Copy the `eslint`, `@eslint/js` and `typescript-eslint` devDependency versions exactly. `vitest.config.ts`: `test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"] }`.

```ts
// packages/scheduler/src/solver.ts
// The adapter behind @seazn/engine's solver port (engine-split spec §5.1, D11): env and secret live HERE, never in the engine.
// The client is imported at call time so tests can spy on `solveBuild` through the module namespace — the repo's recorded
// inert-mock trap (a static import would leave the spy seeing nothing).
import type { PlacementSolver } from "@seazn/engine/scheduling";

export const placementSolver: PlacementSolver = async (input, { requestId }) => {
  const client = await import("./placement-client.ts");
  return client.solveBuild(input, { secret: process.env.PLACEMENT_SERVICE_SECRET ?? "", requestId });
};
```

```ts
// packages/scheduler/src/index.ts
import type { EngineLogger } from "@seazn/engine/scheduling";
import { log } from "./logger.ts";

export { placementSolver } from "./solver.ts";
export { PlacementError, type PlacementFailure } from "./placement-client.ts";
/** The pino logger the engine's scheduler used to own (D25): same name and LOG_LEVEL. */
export const schedulerLog: EngineLogger = {
  debug: (f, m) => log.debug(f, m),
  info: (f, m) => log.info(f, m),
  warn: (f, m) => log.warn(f, m),
  error: (f, m) => log.error(f, m),
};
```

- [ ] **Step 3: Move the files** with `git mv`.
  - **`placement-client.ts` and `placement-client.test.ts`:** type imports come from `@seazn/engine/scheduling`, and `../core/clock.ts` becomes `@seazn/engine/core` (`Clock` and `systemClock` are exported at `core/index.ts:7`). Do this in both files: the test imports clock at :11 [R24]. Drop the temporary re-export from 1a-2 Step 4.
  - **`placement-integration.test.ts`:** imports become `@seazn/engine/scheduling`. It passes `solve: placementSolver, log: schedulerLog` from `./index.ts`, replacing the 1a-2 `liveSolve`, and keeps the `afterEach` guard. [R3]
  - **`gen-proto.ts`:** set `pkgRoot` to the scheduler, `repoRoot = path.resolve(pkgRoot, "../..")` and `outDir = path.join(pkgRoot, "src/generated")`. Run `pnpm --filter @seazn/scheduler gen:proto`; `git diff --stat packages/scheduler/src/generated` must be empty.
- [ ] **Step 4: Runtime-deps gate for the scheduler.** Copy `packages/engine/test/runtime-deps.test.ts` to `packages/scheduler/test/` and pin its set to `["@bufbuild/protobuf", "@grpc/grpc-js", "@seazn/engine", "pino"]`. This is dependency hygiene. The stg/prod `--prod` install runs Flyway and `sync-sports`, not the app. The app's real deploy pin is `workspace-wiring.test.ts:76-104` (1a-4 Step 7). [R25] In the engine's copy (:83-88) the set becomes `["zod"]`; rewrite the :76-82 comment to say the gRPC client and logger left with D11/D25.
- [ ] **Step 5: Engine manifest and Stryker exclusions.** Remove the deps, the devDeps, `gen:proto` and the export. In `stryker.groups.mjs`, delete the dangling keys :294, :296 and :304. In `stryker-groups.test.ts`, :154's list drops `logger` and `placement-client`, :155's `generated/**` containment check is deleted, and :157's expected count becomes the remaining number of keys. Read the assertion: the reviewer measured 6 → 3. Run `pnpm install`.
- [ ] **Step 6: Run the scoped suites with JSON.**
  - **Scheduler:** `solver.test.ts` 2 passed, `placement-client.test.ts` 24 passed, `runtime-deps` passed, `placement-integration` 4 skipped (no host).
  - **Engine:** `test/runtime-deps.test.ts`, `test/stryker-groups.test.ts` and `src/scheduling` all pass.
  - Confirm the result names.
- [ ] **Step 7: Parity ledger.**
  - Collect before (scratch at the 1a-2 commit, engine `src/scheduling`) and after (engine `src/scheduling` plus `packages/scheduler`). The collection command reports the 4 skipped integration ids. [R4]
  - Write `docs/superpowers/specs/engine-split/ledgers/1a.json`: 28 `rehomed` entries (`placement-client.test.ts` ×24, `placement-integration.test.ts` ×4), plus `added` entries for `solver.test.ts` ×2 and the runtime-deps test.
  - Run `node scripts/lib/test-parity.mjs --before "$B=<scratch>/packages/engine" --after "$A1=<wt>/packages/engine" --after "$A2=<wt>/packages/scheduler" --ledger …/1a.json`, using a different root per package, and expect `unaccounted 0`.
- [ ] **Step 8: Mutate once.** Delete `@grpc/grpc-js` from the scheduler's `dependencies`; its runtime-deps test names it. Restore.
- [ ] **Four types:**
  - unit: `solver.test.ts`, runtime-deps;
  - e2e and smoke: 1a-4 Step 10;
  - regression: the integration test's no-silent-greedy guard.
- [ ] Commit: `feat(scheduler): packages/scheduler owns the placement client, stubs, logger and the port adapter`.

### Task 1a-4: Wire the app, CI and the image; prove the seam end to end

**Files:**
- Modify:
  - apps/web wiring: `apps/web/package.json` (dependencies + `"@seazn/scheduler": "workspace:*"`), `apps/web/vitest.config.ts:165` (`server.deps.inline` + `/@seazn\/scheduler/`), `apps/web/src/server/usecases/schedule.ts` (:1925, :2487), `schedule-ai-solver.ts` (:348);
  - apps/web tests:
    - the five spying tests (`schedule-court-hours`, `schedule-capacity-guard`, `schedule-court-candidates`, `stage-round-court-tags`, `schedule-auto-solver-busy-latency`);
    - `schedule-solver-telemetry.test.ts:229` [R23];
    - `apps/web/src/lib/__tests__/client-graph-no-server-barrel.test.ts`;
  - `Dockerfile` (:13-16);
  - workflows: `.github/workflows/{ci.yml,placement-ci.yml,placement-stg.yml,build-guard.yml}`;
  - root tests: `scripts/__tests__/z3-retirement-drift.test.ts`, `packages/engine/src/scheduling/z3-dependency-retired.test.ts`;
  - comment sweep (Step 8).
- Create: `apps/web/src/server/usecases/__tests__/schedule-solver-port-wiring.test.ts`, `packages/scheduler/src/seam.test.ts`, `packages/scheduler/test/integration-runs-elsewhere.test.ts`.

- [ ] **Step 1: Failing wiring test** (Review Focus 1). This runs through the REAL `autoSchedule` and the REAL adapter, with the host pointed at a closed port. Base it on `schedule-auto-cooldown.test.ts`, whose setup is `describe.skipIf(!HAS_DB)` (:161).
  - **Run with `DATABASE_URL` set** (use `seazn-local-env`) and treat any skipped count as a failure.
  - `vi.stubEnv("PLACEMENT_SERVICE_HOST", "127.0.0.1:1")`, then install a **call-through** spy: `vi.spyOn(await import("@seazn/scheduler/placement-client"), "solveBuild")` with no mock implementation.
  - **Assert:** the spy was called once (the real adapter reached the real client); `result.status === "solver_unavailable"` (a status; build.ts:2154); `result.engine === "greedy"`; every fixture has an assignment. [R21]
  - A second test does the same through `reflowExisting`.
- [ ] **Step 2: Run it and expect FAIL.**
- [ ] **Step 3: Pass the ports.**
  - `schedule.ts:1925, :2487` and `schedule-solver-telemetry.test.ts:229` pass `solve: placementSolver, log: schedulerLog`. `schedule-ai-solver.ts:348` passes the same in the `repairDecomposedCpsat` input.
  - Re-run Step 1 and expect PASS.
  - **Mutate once:** pass `solve: async () => { throw new Error("x"); }` in `schedule.ts:1925`. The call-count assertion must go red. Revert.
- [ ] **Step 4: Repoint the five spying tests** to `@seazn/scheduler/placement-client`, and their `PlacementError` imports to `@seazn/scheduler`. In `schedule-auto-solver-busy-latency.test.ts`, read the `vi.mock("@seazn/engine/scheduling")` at :62 before changing it. Titles stay unchanged.
- [ ] **Step 5: Client-bundle guard, rewritten** (Review Focus 3) [R7]. `client-graph-no-server-barrel.test.ts` derives its forbidden specifiers from "exports whose graph reaches `@grpc/grpc-js`" (:103-110) and asserts on the engine barrel (:117-126). After 1a:
  - extend the derivation to iterate the `exports` of BOTH `packages/engine/package.json` and `packages/scheduler/package.json`;
  - assert that `@seazn/scheduler` and `@seazn/scheduler/placement-client` are derived as forbidden;
  - assert that `@seazn/engine/scheduling` is NOT derived as forbidden. D32h: it is now client-importable, which is a recorded decision. Rename the affected test title to say so, and add a ledger entry `rewritten` with reason D32h.
  - **Mutate once:** add `import "@seazn/scheduler";` to a `"use client"` component; the test goes red. Revert.
- [ ] **Step 6: In-process seam test** [R1]. Write `packages/scheduler/src/seam.test.ts`.
  - Start a `@grpc/grpc-js` `Server` on `127.0.0.1:0` implementing `SolveBuild` from `src/generated/scheduler.ts`, and stub `PLACEMENT_SERVICE_HOST` and `PLACEMENT_SERVICE_SECRET` to match it.
  - **Case 1, accepted:** copy the `cornerFixtures`/`cornerConfig` input and its known-good assignments from `build.test.ts` ~:265 into the test (no cross-package relative import).
    - The fake server translates those assignments to wire indices **through the request's own court and fixture order** (look up each id's index in `request.courts` / `request.fixtures`) and answers `OPTIMAL`.
    - Call the REAL `buildSchedule` with `solve: placementSolver, log: silentLogger`.
    - Assert `engine === "optimized"` and that the board equals the known-good assignments by id.
  - **Case 2, rejected:** the fake answers an overlapping board (two fixtures, same court, same slot). Assert `status === "verifier_rejected"`; the decode path does not invent placements.
- [ ] **Step 7: CI, Docker and every pin of the old paths.**
  - **Dockerfile** :13-16: add `COPY packages/scheduler/package.json packages/scheduler/`. The pin is `tools/matrix/__tests__/workspace-wiring.test.ts:76-104` (derived over every workspace). Run it. [R22]
  - **`ci.yml`:** add a **step in the `gates` job** beside the `packages/reference` step (:274-295), not a new job, copying its strict JSON judge. Its vitest run **excludes** `src/placement-integration.test.ts` (`--exclude`), because skips count as failures. `packages/scheduler/test/integration-runs-elsewhere.test.ts` asserts, by reading the workflow text, that `placement-ci.yml` runs that file. [R10]
  - **`placement-ci.yml`:** **keep** `packages/engine/src/scheduling/**` in the path filter (:36), because `build.ts` still owns the request and the fallback. Replace only :37 (gen-proto) with `packages/scheduler/**`, and amend the header comment (:8-26). The drift step (:297-305) runs `pnpm --filter @seazn/scheduler gen:proto` and diffs `packages/scheduler/src/generated`. The integration step (:405) runs `packages/scheduler/src/placement-integration.test.ts` with the scheduler's vitest. `placement-stg.yml:45-46` gets the same change. [R9]
  - **z3 tests** [R8]:
    - `scripts/__tests__/z3-retirement-drift.test.ts`: add `packages/scheduler` to `LIVE_TREES` (:48-60); repoint the ledger entry for `placement-client.ts` (:282) and the claim row for `generated/scheduler.ts` (:176) to their `packages/scheduler/src/` paths; re-read the ">20 files" floor (:323-327) and its comment.
    - `packages/engine/src/scheduling/z3-dependency-retired.test.ts`: add `packages/scheduler` to `LIVE_TREES` (:41-51).
  - **Grep for the old strings** (`scheduling/placement-client`, `scheduling/generated`, `scripts/gen-proto`, `scheduling/logger`) over `.github`, `scripts/__tests__`, `tools/**/__tests__`, `apps/web/src/**/__tests__` and `packages/*/test`, and update every hit.
- [ ] **Step 8: Comment sweep** [R41]. Update or retire stale comments in:
  - `scheduling/index.ts:1-20, :83` (server-only because of gRPC; now false, D32h);
  - `build-guard.yml:17-18`;
  - `apps/web/src/lib/__tests__/swiss-pairing.test.ts:69`;
  - `tools/bench/lib/log.ts:4` and `env.ts:519-527`;
  - `candidate-courts.ts:61` and `court-id-lattice-equivalence.test.ts:47` (both cite `IndexSpace` in `placement-client.ts`; name `@seazn/scheduler`).
- [ ] **Step 9: Scoped gate.**
  - apps/web vitest (with DB): the new wiring test, the five repointed tests, `schedule-solver-telemetry`, `client-graph-no-server-barrel`, every `schedule-*` test from the fact sheet that calls `buildSchedule`/`repairDecomposedCpsat`, and `schedule-ai-repair-cpsat-wiring`.
  - Root: `scripts/__tests__/z3-retirement-drift.test.ts`. tools/matrix: `workspace-wiring.test.ts`.
  - Engine `src/scheduling`. Scheduler, all.
  - Typecheck engine, scheduler and `apps/web`.
  - All JSON; paste the counts.
- [ ] **Step 10: E2E and smoke.**
  - Bring up DB + prod build + placement container with `seazn-local-env`.
  - Run **whole spec files**, never `-g` (class 21): `apps/web/e2e/auto-schedule.spec.ts` and `apps/web/e2e/placement-cutover.spec.ts`. The latter asserts the OPTIMISER is reached; it is the strongest proof the adapter works.
  - Then `scripts/smoke.ts` against the same server. If it has no auto-schedule call (grep), add one in its step style: `POST /api/v1/stages/:id/schedule/auto`, assert 200 and a non-empty board.
- [ ] **Four types:**
  - unit: the wiring and seam tests;
  - e2e: the two whole specs;
  - smoke: Step 10;
  - regression: the client-graph derivation and the call-through spy.
- [ ] Commit: `feat(schedule): the app hands the engine its solver and logger; scheduler CI, image and placement workflows follow`.

### Batch 1a close

- [ ] The orchestrator reruns 1a-4 Step 9 and the parity command from 1a-3 Step 7.
- [ ] Opus batch review → `reviews/1a.md`. It must answer:
  - Can any caller omit `solve`/`log`?
  - Does `build.ts` read `process.env` anywhere?
  - Is the equivalence snapshot byte-unchanged since its recording commit?
  - Can the live integration test reach greedy unnoticed?
- [ ] Open the PR with the parity counts and the ledger path. The owner merges.

---

# Batch 1b — publishable engine (spec §5.2, D14, D16, D18, D19, D25)

Worktree `engine-split-1b`, from `origin/main` after 1a merges.

### Task 1b-1: Rename behind a workspace alias

**Files:**
- Modify:
  - `packages/engine/package.json` (`name`);
  - the consumer manifests: `apps/web/package.json:24`, `tools/matrix/package.json:7`, `tools/bench/package.json:8`, root `package.json:76`, `packages/reference/package.json:14` (dev), `packages/scheduler/package.json`;
  - name pins: `apps/web/src/__tests__/toolchain.test.ts` (:359, :428, :453), `tools/matrix/__tests__/workspace-wiring.test.ts` (:138-139), `tools/matrix/__tests__/ci-wiring.test.ts:500`, `tools/matrix/__tests__/matrix-workflow.test.ts:1712` [R11], `scripts/reference-boundary.ts:206`;
  - every `--filter @seazn/engine` (grep `.github`, `package.json`, `turbo.json`, `scripts/`, `tools/`);
  - `pnpm-lock.yaml`.
- Create: `scripts/__tests__/engine-package-identity.test.ts`. It lives in `scripts/__tests__` because it reads monorepo manifests, so it is born outside the engine. [R29]

**Interfaces:** the package name is `@onryde/seazn-engine`. Every consumer declares `"@seazn/engine": "workspace:@onryde/seazn-engine@*"`. Import specifiers do not change.

- [ ] **Step 1: Failing test**

```ts
// scripts/__tests__/engine-package-identity.test.ts
// D19: published as @onryde/seazn-engine, consumed as @seazn/engine. Pins both halves so nobody "fixes" one.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));
// Derived, never typed: every workspace manifest (pnpm-workspace.yaml globs apps/*, packages/*, tools/*) plus the root.
const manifests = ["package.json", ...["apps", "packages", "tools"].flatMap((d) =>
  readdirSync(path.join(ROOT, d)).map((n) => `${d}/${n}/package.json`).filter((p) => existsSync(path.join(ROOT, p))))];

describe("engine package identity", () => {
  it("is published under the GitHub owner's scope", () => {
    expect(read("packages/engine/package.json").name).toBe("@onryde/seazn-engine");
  });

  it("every workspace that depends on the engine imports it as @seazn/engine through the alias", () => {
    const consumers = manifests.filter((p) => p !== "packages/engine/package.json").filter((p) => {
      const m = read(p);
      return Object.keys({ ...m.dependencies, ...m.devDependencies }).some((k) => k === "@seazn/engine" || k === "@onryde/seazn-engine");
    });
    expect(consumers.length, "found no engine consumers — the scan is vacuous").toBeGreaterThanOrEqual(6);
    for (const p of consumers) {
      const m = read(p);
      expect(m.dependencies?.["@onryde/seazn-engine"] ?? m.devDependencies?.["@onryde/seazn-engine"], `${p} must not import the scoped name`).toBeUndefined();
      expect(m.dependencies?.["@seazn/engine"] ?? m.devDependencies?.["@seazn/engine"], p).toBe("workspace:@onryde/seazn-engine@*");
    }
  });
});
```

  Read `pnpm-workspace.yaml` first and match the globs it actually declares.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Rename.** Set the specs, run `pnpm install`, and update the filters and pins. Read each pinned assertion first (class 4): a pin of the *package name* takes the new name, and a pin of a *dependency spec* takes the alias. Before editing `mutation.yml`'s `--filter`, tell the mutation session.
- [ ] **Step 4: Verify resolution in each consumer kind:**
  - the identity test;
  - apps/web typecheck;
  - apps/web `src/__tests__/toolchain.test.ts`;
  - tools/matrix `workspace-wiring.test.ts`, `ci-wiring.test.ts` and `matrix-workflow.test.ts`;
  - `node --experimental-strip-types scripts/sync-sports.ts` in its dry-run/help mode (read the script);
  - `pnpm turbo run typecheck --filter=./packages/engine...`.
- [ ] **Step 5: Mutate once.** Set one consumer back to `workspace:*`; the identity test names it. Revert.
- [ ] **Four types:**
  - unit: the identity test;
  - e2e: n/a until 1b-3 (no runtime change: same files, new name);
  - smoke: a local prod build plus `scripts/smoke.ts` at the batch close (the name reaches Next's resolution) [R14];
  - regression: the pins.
- [ ] Commit: `feat(engine): publish name @onryde/seazn-engine behind a workspace alias (D19)`.

### Task 1b-2: Compiled `dist/` and the publish manifest

**Files:**
- Create: `packages/engine/tsconfig.build.json`, `packages/engine/test/publish-manifest.test.ts`.
- Modify:
  - `packages/engine/package.json`: `build:dist`, `publishConfig`, `files`, drop `private`, `zod` peer-only, `peerDependenciesMeta`, `repository`, `sideEffects`;
  - `packages/engine/test/runtime-deps.test.ts` (deps ∪ peerDeps);
  - `.gitignore`;
  - `turbo.json` (:25-31 comment);
  - `apps/web/src/__tests__/toolchain.test.ts` (the "--prod install" list) and `stg.yml` (:56-66 comment) [R34].

- [ ] **Step 0: Read one real Stryker incremental file** (spec §14 R5, 10 minutes) [R40]. Download the latest `mutation.yml` artifact (`gh run download` on the newest successful run) or open a cached `reports/stryker-incremental-*.json`. Record in the PR body whether its file paths are engine-relative. This informs 2b only; it changes nothing here.
- [ ] **Step 1: Failing manifest test**

```ts
// packages/engine/test/publish-manifest.test.ts
// D14/D16/D25: what a registry consumer receives. The workspace keeps TS source exports until 2b (spec §5.2);
// publishConfig.exports must mirror every one of them into dist/.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const toDist = (src: string) => src.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "");

describe("publish manifest", () => {
  const keys = Object.keys(pkg.exports);

  it(`mirrors all ${keys.length} workspace exports into dist (never zero)`, () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(pkg.publishConfig.exports[k], k).toEqual({ types: `${toDist(pkg.exports[k])}.d.ts`, default: `${toDist(pkg.exports[k])}.js` });
    expect(Object.keys(pkg.publishConfig.exports).sort()).toEqual([...keys].sort());
  });

  it("ships dist and rules/ (the testkit's rules parser reads it at runtime), nothing private, to GitHub Packages", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.files).toEqual(["dist", "rules"]);
    expect(pkg.publishConfig.registry).toBe("https://npm.pkg.github.com");
  });

  it("takes zod as a peer only, and declares the testkit's test-runner imports as optional peers", () => {
    expect(pkg.peerDependencies.zod).toBeDefined();
    expect(pkg.dependencies?.zod).toBeUndefined();
    expect(pkg.devDependencies.zod).toBeDefined();
    for (const p of ["fast-check", "vitest"]) {
      expect(pkg.peerDependencies[p], p).toBeDefined();
      expect(pkg.peerDependenciesMeta[p]).toEqual({ optional: true });
    }
  });
});
```

  - **`files` is `["dist", "rules"]` and golden corpora do not ship** [R12, R26, D32f]. `rules/` sits beside `src/`. A reader at `src/testkit/x` or at `dist/testkit/x` reaches it with the same `new URL("../../rules/", import.meta.url)`, because both resolve to `<pkg>/rules/`. The golden corpora are read only by modules that `exports` does not expose (`testkit/index.ts:7-19`), so they stay out.
  - **`fast-check` and `vitest` become optional peers** because the testkit barrel's `conformance.ts` imports them (`:4-5`). [R27]
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Build config.**

```json
// packages/engine/tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rewriteRelativeImportExtensions": true, "declaration": true, "declarationMap": true, "sourceMap": true, "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/**/__tests__/**"]
}
```

  The script is named `"build:dist": "node ../../node_modules/typescript-native/bin/tsc -p tsconfig.build.json"`, **not `build`**. A `build` script would put the emit into every turbo `typecheck` and `build` in CI, because `typecheck` `dependsOn ^build`, and the app reads `src` so that work is wasted. [R28]
- [ ] **Step 4: Manifest.**
  - Add `publishConfig` (`registry`, `exports`), `files: ["dist", "rules"]` and `repository: { "type": "git", "url": "https://github.com/onryde/seazn.club", "directory": "packages/engine" }`. Delete `private`.
  - **Peers:** `zod` moves to peer + dev. `fast-check` and `vitest` become optional peers via `peerDependenciesMeta` (they stay in devDeps).
  - **`sideEffects: false`.** Justification: after 1a the only import-time effects are module-local state (`build.ts:1155`) and the empty registry singleton (`registry.ts:91`, filled by `registerBuiltins`). First grep `apps/web/src`, `tools/` and `scripts/` for bare `import "@seazn/engine` with no binding. If any exist, drop `sideEffects` and record why.
  - **`runtime-deps.test.ts`:** the declared set is deps ∪ peers.
  - **`.gitignore`:** `packages/engine/dist/`.
  - **`turbo.json` :25-31:** "workspace consumers read src; the published tarball is dist, built by build:dist (engine-split §5.2)".
  - **zod under `--prod`** [R34]: with zod peer-only, the stg/prod `--prod` install resolves it only through the root's own prod `zod` (root `package.json:95`). Pin that: add `zod` to `toolchain.test.ts`'s deploy-install list, and update the `stg.yml:56-66` comment.
- [ ] **Step 5: Build and inspect.**
  - `pnpm --filter @onryde/seazn-engine build:dist` exits 0.
  - `dist/core/index.js` and `.d.ts` exist.
  - `grep -c 'from "\./' dist/core/index.js` shows `.js` specifiers and no `.ts` ones.
  - The manifest test passes.
- [ ] **Step 6: Mutate once.** Delete one `publishConfig.exports` key; the test names it. Revert.
- [ ] **Four types:**
  - unit: the manifest test and runtime-deps;
  - e2e: 1b-3's fixtures are the consumer-side runs;
  - smoke: batch close;
  - regression: the zod `--prod` pin.
- [ ] Commit: `feat(engine): tsc emit to dist with a publish manifest (D14)`.

### Task 1b-3: Packed-tarball proof (`engine-pack`)

**Files:**
- Create: `packages/engine/pack-proof/run.mjs` and fixtures: `node/{package.json,strip.ts,rules.mjs}`, `next/{package.json,next.config.js,app/layout.tsx,app/page.tsx,app/api/probe/route.ts}`, `rn/{package.json,metro.config.js,babel.config.js}` (the entry is generated), `types/{package.json,consumer.ts,tsconfig.bundler.json,tsconfig.nodenext.json}`.
- Modify: `.github/workflows/ci.yml` (new `engine-pack` job), `packages/engine/package.json` (`"pack:proof": "node pack-proof/run.mjs"`).

**Interfaces:** `node packages/engine/pack-proof/run.mjs [--only node|next|rn|types]`.
- **Set-up:** runs `build:dist` and `pnpm pack`. For each fixture it copies the fixture to a `mkdtemp` dir **outside the repo** (asserted), installs the tarball as `"@seazn/engine": "file:<tarball>"` plus `zod` (and, for `types`, `fast-check` and `vitest`), then runs the check.
- **Output:** prints `<fixture>: <N> checked`. Exits non-zero on any failure or when N = 0.

- [ ] **Step 1: The fixtures.** Every fixture `package.json` has `"type": "module"`. [R27]
  - **`node/strip.ts`:** `import { builtinModules } from "@seazn/engine/sports";`. Print the count and exit 1 if it is 0. Run it with `node --experimental-strip-types` (the `sync-sports.ts` shape).
  - **`node/rules.mjs`** [R12]: import the testkit's rules parser (added in Batch 1d; until then this check is skipped with a printed reason, and 1d-5 turns it on) and parse at least 1 rule row from the INSTALLED tarball.
  - **`next/`:** a minimal app. A server component imports `@seazn/engine/core` and `/sport`, and a route handler imports `/sports`. There is no `transpilePackages`. `next build` exits 0; N is the number of routes built.
  - **`rn/`** [R13]:
    - Dependencies: `react-native@0.86.3`, `@react-native/metro-config@0.86.3`, `@react-native/babel-preset@0.86.3`, `@react-native-community/cli` (the version range `@react-native/community-cli-plugin@0.86.3` accepts; it is an optional peer there, and `react-native/cli.js` exits without it), and `hermes-compiler`. Use the version that `react-native@0.86.3` resolves, which is `250829098.0.17` in the capture checkout.
    - `run.mjs` generates `index.js`: one `import * as m<i> from "@seazn/engine/<sub>"` per phone subpath (`core`, `sport`, `sports` and every `sports/<dir>`), plus a `foldMatch` call over an empty event list for `badminton` with its schema-default config. Batch 1c switches the list to `phone-subpaths.json`.
    - Bundle twice:
      - `--dev true`: count the `__d(` module definitions and record their paths;
      - `--dev false` into `out.js`, then compile with `hermesc -emit-binary -out out.hbc out.js`.
    - Resolve `hermesc` as `path.join(path.dirname(require.resolve("hermes-compiler/package.json")), "hermesc", process.platform === "darwin" ? "osx-bin" : "linux64-bin", "hermesc")`.
    - **Count rule:** the dev bundle must contain at least 40 engine modules (`dist/` paths). The 2026-10-14 static closure was 46; 1c makes this exact.
    - A failure here is a real finding only after confirming the toolchain ran: for example, a missing CLI is NOT a zod/R4 finding.
  - **`types/consumer.ts`:**
    - Import types and values from `core`, `sport`, `scheduling` and `testkit`.
    - One `// @ts-expect-error` assigns an engine value to a wrong type, which proves the types are real rather than `any`.
    - Two tsconfigs: `moduleResolution: "bundler"` and `"nodenext"`, both with `skipLibCheck: false`, both exiting 0.
- [ ] **Step 2: `run.mjs`.** It uses `execFileSync` and `mkdtempSync(os.tmpdir())`, and refuses to run if the scratch dir is inside the repo.
- [ ] **Step 3: Run each fixture locally** with `--only` and record the four counts.
- [ ] **Step 4: Mutate once.** Add `import "node:fs";` to `src/core/index.ts` and rebuild; `--only rn` goes red at Metro resolution. Revert.
- [ ] **Step 5: CI job `engine-pack`** in `ci.yml`: `ubuntu-latest`, Node 26, path filter `packages/engine/**` and `pnpm-lock.yaml`. It runs `pnpm install --frozen-lockfile` then `node packages/engine/pack-proof/run.mjs`, with the repo's pnpm store cache step.
- [ ] **Four types:**
  - unit: n/a (the fixtures are consumers);
  - e2e: the four consumer runs are the end-to-end path a registry consumer takes;
  - smoke: the `node` leg is the deploy's `sync-sports` shape;
  - regression: the `node:fs` mutation.
- [ ] Commit: `ci(engine): prove the packed tarball in Node strip-types, Next, Metro+Hermes and tsc (D14)`.

### Task 1b-4: Canary publishing

**Files:** Create `.github/workflows/engine-canary.yml` and `scripts/__tests__/engine-canary-workflow.test.ts`. The test lives in `scripts/__tests__` because it reads `.github`. [R29]

- [ ] **Step 1: Failing workflow test.** Parse the workflow **as text**, the way `tools/matrix/__tests__/matrix-workflow.test.ts`'s `jobsOf` does; no YAML library is in the repo. [R29] Assert:
  - the only trigger is `push` to `main` with paths `packages/engine/**`;
  - `permissions` is `contents: read` and `packages: write`;
  - a `pack-proof/run.mjs` step comes before publish;
  - the version is set to `0.0.0-canary.<sha>`;
  - publish uses `--tag canary`;
  - no run block contains both `echo` and `TOKEN`.
- [ ] **Step 2: The workflow**

```yaml
# .github/workflows/engine-canary.yml
# Phase 1 canaries of @onryde/seazn-engine from the monorepo (engine-split spec §5.2, D16). No stable releases from here;
# the first stable 1.0.0 is cut by Changesets in the engine repo at 2b.
name: engine-canary
on:
  push:
    branches: [main]
    paths: ["packages/engine/**"]
permissions:
  contents: read
  packages: write
concurrency: { group: engine-canary, cancel-in-progress: false }
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 26, registry-url: https://npm.pkg.github.com, scope: "@onryde" }
      - run: pnpm install --frozen-lockfile
      - run: node packages/engine/pack-proof/run.mjs
      - name: Set canary version
        working-directory: packages/engine
        run: npm pkg set version="0.0.0-canary.${GITHUB_SHA::9}"
      - name: Publish
        working-directory: packages/engine
        run: pnpm publish --tag canary --no-git-checks --access public
        env: { NODE_AUTH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
```

  Copy the exact `pnpm/action-setup` and `setup-node` versions and options from `ci.yml`'s first job if they differ from the ones above.
- [ ] **Step 3: PASS. Mutate once:** `--tag latest` turns the test red. Revert.
- [ ] **Step 4: PR-body owner note.** Merging this publishes the first canary to GitHub Packages under `onryde`, which is outward-facing. After it runs, the owner checks the package page: visibility public, linked to `onryde/seazn.club`. If capture's R4 spike will install it, the owner grants `onryde/seazn.club.capture` read access.
- [ ] **Four types:**
  - unit: the workflow test;
  - e2e: the first real publish after merge, which the owner checks;
  - smoke: n/a, no runtime;
  - regression: the tag mutation.
- [ ] Commit: `ci(engine): publish 0.0.0-canary.<sha> to GitHub Packages on engine changes (D16)`.

### Batch 1b close

- [ ] **Gate:**
  - `scripts/__tests__/engine-package-identity` and `engine-canary-workflow`;
  - engine `publish-manifest` and `runtime-deps`;
  - apps/web `toolchain.test.ts`;
  - tools/matrix `workspace-wiring`, `ci-wiring` and `matrix-workflow`;
  - all four `pack:proof` fixtures;
  - typecheck engine, web and scheduler;
  - **local prod build + `scripts/smoke.ts`** [R14].
- [ ] **Parity:** collect the engine package before and after; the new files' ids go in `ledgers/1b.json` as `added`.
- [ ] Opus review → `reviews/1b.md`. Open the PR. The owner merges.

---

# Batch 1d — rehome tests across the boundary, in both directions (spec §5.4, D23, D32i)

Worktree `engine-split-1d`, after 1b merges.

**Rule:** a test that reads anything outside `packages/engine` either becomes layout-agnostic (it works with the engine at the repo root OR at `packages/engine`) or moves out. A test that reads only `packages/engine` stays. Moved tests keep their titles. Everything goes in `docs/superpowers/specs/engine-split/ledgers/1d.json`.

**Shared helper** for Tasks 1d-1 and 1d-5:

```ts
// packages/engine/test/layout.ts
// Where the engine sits inside its git checkout: "packages/engine/" in the monorepo, "" in its own repo (2b).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
export const ENGINE_DIR = fileURLToPath(new URL("..", import.meta.url));
const git = (...a: string[]) => execFileSync("git", a, { cwd: ENGINE_DIR, encoding: "utf8" }).trim();
export const GIT_TOPLEVEL = git("rev-parse", "--show-toplevel");
export const ENGINE_PREFIX = git("rev-parse", "--show-prefix"); // "packages/engine/" or ""
```

**The simulated engine repo** used by Tasks 1d-1 and 1d-6:

1. `rsync -a --exclude node_modules --exclude dist packages/engine/ "$SIM/"` with `SIM=$(mktemp -d)`.
2. `mkdir -p "$SIM/.github/workflows" && cp .github/workflows/mutation.yml "$SIM/.github/workflows/"`.
3. `cd "$SIM" && git init -q && git add -A && git commit -qm sim && pnpm install`.
4. Record the resolved `vitest` and `typescript` versions next to every run: there is no lockfile, so versions float. [R31]

### Task 1d-1: Stryker tests and `stryker-changed.mjs`, layout-agnostic

**Files:** `packages/engine/test/layout.ts` (create), `test/stryker-outputs-ignored.test.ts` (:12-13, :32, :40-54), `test/stryker-sizing.test.ts` (:884-961), `test/stryker-changed-lines.test.ts` (:142, :162, :325-330), `scripts/stryker-changed.mjs` (:67) + its `.d.mts`, `test/stryker-matrix.test.ts` (:18, :30), `tools/matrix/__tests__/matrix-workflow.test.ts` (the Stryker-figure assertions). Tell the mutation session before starting.

- [ ] **Step 1:** In `stryker-changed.mjs:67`, build the diff matcher from the checkout prefix: `` new RegExp(`^\\+\\+\\+ b/${escapeRegExp(prefix)}(src/.+)$`) ``, where `prefix` comes from `git rev-parse --show-prefix` run in the engine dir. Export `enginePrefix()` and declare it in the `.d.mts`. Add no tests: parametrise the existing synthetic-diff tests (:142, :162) over `ENGINE_PREFIX`, keeping their titles.
- [ ] **Step 2:** In `stryker-outputs-ignored.test.ts`, `REPO` becomes `GIT_TOPLEVEL`, the workflow path becomes `path.join(GIT_TOPLEVEL, ".github/workflows/mutation.yml")`, and `packages/engine/...` literals become `` `${ENGINE_PREFIX}...` ``.
- [ ] **Step 3:** In `stryker-matrix.test.ts:18,30`, the spawn cwd becomes `GIT_TOPLEVEL`, and literals become `ENGINE_PREFIX`.
- [ ] **Step 4: `stryker-sizing.test.ts:922` cross-quote: split, not delete** [R20, spec §5.4].
  - The figures it reads in `matrix-workflow.test.ts` sit in a comment justifying `max-parallel: 12` for `mutation.yml` (`matrix-workflow.test.ts:1065-1071`). They are about the org's shared hosted slots, not about runner sharing.
  - The engine test keeps the `mutation.yml` half, with a retitled scope ("…the workflow quotes…") and a ledger entry `split`.
  - The `matrix-workflow.test.ts` half becomes a new test in `matrix-workflow.test.ts` that reads `packages/engine/stryker-measured.json` (a reverse read, inventoried in 1d-6), with a ledger entry `split`, its `to` pointing at the new id.
  - The NOTES list (:884) drops the matrix-workflow path, and `:952` reads `mutation.yml` via `GIT_TOPLEVEL`.
  - The `MATRIX_RUNNER` → `STRYKER_RUNNER` rename is NOT done in Phase 1 (D32g).
- [ ] **Step 5:** Run the five engine files and `matrix-workflow.test.ts` with JSON. Then run the same five in the simulated engine repo. The same ids must pass. A test needing `HEAD^1` history must SKIP with a named reason, never fail.
- [ ] **Step 6: Mutate once.** Hardcode `ENGINE_PREFIX = "packages/engine/"`; the simulated run goes red. Revert.
- [ ] **Four types:**
  - unit: these files;
  - e2e and smoke: n/a, test-infrastructure only, no product path;
  - regression: the simulated-repo run.
- [ ] Commit: `test(engine): stryker tests find the workflow and paths from the checkout, not the monorepo layout`.

### Task 1d-2: `engine-boundary` moves into the engine

**Files:**
- `git mv scripts/engine-boundary.ts packages/engine/scripts/engine-boundary.ts`.
- Copy `scripts/lib/main-module.ts` to `packages/engine/scripts/lib/`. The root copy stays, for other root scripts.
- Modify: `packages/engine/test/boundary-gate.test.ts:7`, root `package.json:54` (`engine:boundary` → `node --experimental-strip-types packages/engine/scripts/engine-boundary.ts`), `scripts/__tests__/main-module.test.ts:59-65`, and the engine `package.json` (`"boundary": "node --experimental-strip-types scripts/engine-boundary.ts"`).

- [ ] Move the script and fix the CLI scan dir (:88-89) to `new URL("../src", import.meta.url)`. Fix the import at `boundary-gate.test.ts:7`. Repoint the symlinked spawn in `main-module.test.ts`.
- [ ] Run `boundary-gate.test.ts` (14 cases), `main-module.test.ts` and `pnpm engine:boundary` (the `ci.yml:105` check). The ids are unchanged.
- [ ] `packages/engine/eslint.config.mjs:19`'s `tools-import-guard` import stays until 2b (D32d). Record that in the ledger `notes`.
- [ ] **Four types:**
  - unit: `boundary-gate`;
  - e2e and smoke: n/a, CI tooling;
  - regression: the existing 14 cases.
- [ ] Commit: `refactor(engine): engine-boundary lives with the engine`.

### Task 1d-3: `window-single-source` — the app halves move to the app

- [ ] Move the tests at :34 and :52 verbatim (same titles) to `apps/web/src/server/usecases/__tests__/court-window-single-source.test.ts`, re-rooting their paths. :90, :98, :108 and :115 stay.
- [ ] Run both files and add two `rehomed` ledger entries.
- [ ] **Mutate once:** change the moved test's expected token `usableWindows`; it goes red. Revert.
- [ ] **Four types:** unit + regression (these are guard tests); e2e and smoke n/a (no product change).
- [ ] Commit: `test(scheduling): the app's single-source window checks live with the app`.

### Task 1d-4: `z3-dependency-retired` — the repo-wide scans move to the root

- [ ] Move the eight repo-wide tests (:84, :100, :107, :116, :122, :126, :130, :136) and their setup (:29, :41-51, the collect-time `readdirSync(tools)` at :98) to `scripts/__tests__/z3-dependency-retired.test.ts`, with the same titles. The `LIVE_TREES` there includes `packages/scheduler` (1a). The engine file keeps :151.
- [ ] Run both and add eight `rehomed` ledger entries.
- [ ] **Four types:** unit + regression (guard tests); e2e and smoke n/a (no product change).
- [ ] Commit: `test(scheduling): repo-wide z3 retirement scans live at the repo root`.

### Task 1d-5: `rules-reference` — split by where the proof lives

**Files:**
- Create: `packages/engine/src/testkit/rules-reference.ts` (the parser, exported via `@seazn/engine/testkit`) and `scripts/__tests__/rules-reference.test.ts`.
- Modify: `packages/engine/test/rules-reference.ts`, `packages/engine/test/rules-reference.test.ts`, `packages/engine/pack-proof/node/rules.mjs` (enable), and `.github/workflows/ci.yml` (gates).

- [ ] **Step 1:** Move the pure parts of `test/rules-reference.ts` into `src/testkit/rules-reference.ts`: reading `rules/*.md`, row parsing, and `proved-by`/`enforced-at` extraction. It reads `new URL("../../rules/", import.meta.url)`, which is correct from both `src/testkit/` and `dist/testkit/` because `rules/` ships at the package root (1b-2). Export it from the testkit barrel. The repo-reading helpers (`fileExists`, `readRepoFile`, `proofProblems`) stay test-side.
- [ ] **Step 2:** Classify the 33 tests using the scout table:
  - the 22 engine-local tests stay;
  - `:319` and `:512` split. The engine half checks only paths under `ENGINE_PREFIX`, title suffix " (engine paths)", ledger `split`. The root half checks the rest by importing the parser from `@seazn/engine/testkit`, title suffix " (app, tools and reference paths)";
  - `:341`, `:520`, `:556`, `:574` and the whole `:652` describe (:667, :674, :685, :745, :761) move to the root file.
- [ ] **Step 3: CI** [R30]. Add a **second, separate step** in `gates` that runs the root file with its own JSON judge. Leave the existing step (`ci.yml:304-311`) running only the engine file, so `:685` ("runs only this file") and the judges exercised by `:745`/`:761` stay true. The moved `:685` keeps asserting the ENGINE step's exact run line.
  - **Mutate once:** delete the new step; a new assertion in the root file ("the gates job runs scripts/__tests__/rules-reference.test.ts") goes red. Ledger that new test as `added`. Revert.
- [ ] **Step 4:** Enable the `node/rules.mjs` pack-proof check (1b-3) and run `pack:proof --only node`; it must parse at least 1 row from the installed tarball. [R12]
- [ ] **Step 5:** Run both test files with JSON, confirm the result names, and fill the ledger.
- [ ] **Four types:**
  - unit: the two files;
  - e2e: n/a (no product path);
  - smoke: the `pack:proof` node leg;
  - regression: the step mutation.
- [ ] Commit: `test(rules): proofs outside the engine are checked outside the engine`.

### Task 1d-6: Both-direction inventory and the ledger check [R19, D32i]

- [ ] **Engine → monorepo.** Collect the engine package at the batch base and head, plus the new root and app files, then run `node scripts/lib/test-parity.mjs` with several `--before`/`--after` pairs and the ledger. Expect `unaccounted 0`.
- [ ] **Monorepo → engine (reverse)** [R19]. Find every non-engine test file that reads an engine-owned path: `grep -rlaE "packages/engine|mutation\.yml|stryker-" apps/web/src scripts/__tests__ tools/*/__tests__ packages/reference packages/scheduler --include=*.ts`, then open each hit. Write `docs/superpowers/specs/engine-split/reverse-inventory.md`: one row per file, giving what it reads (path and line), how many tests depend on it, and its **planned 2b fate**. The fates are:
  - moves to the engine repo, e.g. `matrix-workflow.test.ts`'s ~28 `mutation.yml` tests;
  - reads from the installed package;
  - deleted with a reason;
  - unchanged (reads a path that stays).

  Include `client-graph-no-server-barrel.test.ts:20` (reads `packages/engine/package.json`), both z3 tests, `lock-isolation.test.ts`, and the 1b-x `scripts/__tests__` files. This file is an input to the 2b plan.
- [ ] **Simulated engine repo.** Collecting the whole engine package in the simulated repo must succeed for every file. A collect-time read of a monorepo path fails collection, as four files did before this batch. Then run only the files this batch touched, AND the three files 1b added whose tests read the monorepo by design: `test/pack-proof.test.ts`, `test/publish-manifest.test.ts` and `test/canary.test.ts`, plus `pack:proof --only types`. **There must be zero failures that name a monorepo path** except the reads in the next item, each of which is expected to fail here and owes a recorded 2b fate.
- [ ] **1b engine → monorepo reads (batch 1b review M2).** 1b added reads the collect-only run cannot see, because they happen at run time. Record a 2b fate for each in `reverse-inventory.md` (the 2b plan consumes it) and name the engine-repo replacement:
  - (a) the **Next, React and TypeScript versions** `pack-proof/run.mjs` reads from `apps/web/package.json` for the Next and RN fixtures (`REPO` = `engine/../..`); at 2b they come from the engine repo's own devDependencies;
  - (b) the root **`packageManager`** field `run.mjs` reads to pick the pnpm version (`pickPnpm`); at 2b it is the engine repo's own `packageManager`;
  - (c) the **`../../node_modules/typescript-native/bin/tsc`** path in `build:dist` (pinned verbatim at `publish-manifest.test.ts`); and the types fixture's TS 7 and TS 6 binaries read from the root `node_modules` (`run.mjs`); at 2b the compilers are the engine repo's own devDependencies, so the script path, `run.mjs` and the pin change together;
  - (d) the root **`pnpm-workspace.yaml` `@babel/core` override** (`pack-proof.test.ts` reads it): spec §7 step 6 deletes the root file at 2b, so the override moves into the engine repo's `pnpm-workspace.yaml` or `package.json` `pnpm.overrides`, and the test reads it there;
  - (e) the root **`.gitignore` `dist/` entry**: the engine repo gets its own `.gitignore` with `dist/`.
  - The engine ESLint tests (`pack-proof.test.ts`) load `eslint.config.mjs`, which imports `../../scripts/lib/tools-import-guard.mjs`: the guard is copied into the engine repo or the import is dropped, decided with the rest of the 2b lint config.
- [ ] **Four types:** unit: the parity run; e2e and smoke n/a (inventory and ledger); regression: the simulated-repo collection.
- [ ] Commit the ledger and the inventory: `docs(engine-split): 1d parity ledger and the reverse inventory for 2b`.

### Batch 1d close

- [ ] **Gate:** every file touched in 1d-1…1d-5 with JSON; the simulated-repo collection; `pnpm engine:boundary`; `pack:proof --only node`.
- [ ] Opus review → `reviews/1d.md`. It checks each ledger reason against the diff: a "rehomed" or "split" test must assert what it asserted before. Open the PR. The owner merges.

---

# Batch 1c — RN-safe gate (spec §5.3, D25)

Worktree `engine-split-1c`, after 1d merges.

### Task 1c-1: `phone-subpaths.json` and the static rule

**Files:** Create `packages/engine/phone-subpaths.json`. Modify `packages/engine/scripts/engine-boundary.ts`, `packages/engine/test/boundary-gate.test.ts` and `packages/engine/pack-proof/run.mjs`.

**Interfaces:**
- `phone-subpaths.json`: `{ "subpaths": ["./core", "./sport", "./sports", "./sports/*"], "closure": { "modules": 46, "measured": "2026-10-14", "why": "value-import closure of the phone subpaths; re-pin deliberately when the engine grows" } }`. Re-measure `modules` on the tree at batch start (1e has not landed yet; record the measured number and date).
- `checkPhoneSafety(engineDir): { walked: string[]; entries: string[]; violations: { kind: string; file: string; detail: string }[] }`, exported from `engine-boundary.ts`.

- [ ] **Step 1: Failing tests.** These are new; ledger them in `1c.json` as `added`. [R15, R43]

```ts
describe("phone-safe subpaths", () => {
  const cfg = JSON.parse(readFileSync(new URL("../phone-subpaths.json", import.meta.url), "utf8"));

  it("walks exactly the recorded closure, every phone entry module included, and finds it clean", () => {
    const r = checkPhoneSafety(ENGINE_DIR);
    expect(r.violations).toEqual([]);
    expect(r.walked.length, `closure changed: re-pin phone-subpaths.json closure.modules deliberately (${cfg.closure.why})`).toBe(cfg.closure.modules);
    expect(r.entries.length).toBeGreaterThanOrEqual(cfg.subpaths.length);
    for (const e of r.entries) expect(r.walked).toContain(e);
  });

  it.each([
    ["a node: builtin", 'import { readFileSync } from "node:fs";'],
    ["a bare builtin", 'import path from "path";'],
    ["process", "export const lvl = process.env.LOG_LEVEL;"],
    ["optional-chained process", "export const lvl = process?.env?.LOG_LEVEL;"],
    ["globalThis.process", "export const lvl = globalThis.process;"],
    ["scheduling", 'import { buildSchedule } from "../scheduling/build.ts";'],
  ])("refuses %s reached from a phone subpath", (_label, line) => {
    const dir = seedEngine({ "src/core/index.ts": `export * from "./leak.ts";`, "src/core/leak.ts": line, "src/scheduling/build.ts": "export const buildSchedule = 1;" });
    expect(checkPhoneSafety(dir).violations).toHaveLength(1);
  });

  it("does not follow `import type` (erased at compile time)", () => {
    const dir = seedEngine({ "src/core/index.ts": 'import type { X } from "../scheduling/build.ts"; export const a = 1;', "src/scheduling/build.ts": "export type X = 1;" });
    expect(checkPhoneSafety(dir).violations).toEqual([]);
  });

  it("treats an exports target that does not exist as a violation, not a smaller walk", () => {
    const dir = seedEngine({ "src/core/index.ts": "export const a = 1;" }, { sportMissing: true });
    expect(checkPhoneSafety(dir).violations.map((v) => v.kind)).toContain("missing-entry");
  });

  it("does not flag the same code outside the phone closure", () => {
    const dir = seedEngine({ "src/core/index.ts": "export const a = 1;", "src/history/x.ts": 'import "node:fs";' });
    expect(checkPhoneSafety(dir).violations).toEqual([]);
  });
});
```

  `seedEngine(files, opts?)` writes a tmpdir with a `package.json` exporting the four phone subpaths (pointing `./sport` at a missing file when `sportMissing`; otherwise seeding minimal `src/sport/index.ts`, `src/sports/index.ts` and one `src/sports/x/index.ts` unless `files` supplies them), a `phone-subpaths.json`, and the files. Reuse the file's tmpdir seeding pattern (:42-46).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement `checkPhoneSafety`.**
  - **Entries:** resolve each subpath through `exports` (`./sports/*` expands over `src/sports/*/index.ts`). A missing target is a `missing-entry` violation.
  - **Walk:** BFS over relative **value** imports (`import … from`, `export … from`, dynamic `import()`), skipping `import type` and `export type`.
  - **Checks, on comment-stripped code:** a `node:` specifier or a Node builtin name (from `node:module`'s `builtinModules`); `\bprocess\s*(\?\.|\.)` or `globalThis\.process`; any resolved path under `src/scheduling/`.
  - **CLI:** `pnpm engine:boundary` prints `phone-safe: N modules walked`.
- [ ] **Step 4:** `pack-proof/run.mjs` generates the rn entry from `phone-subpaths.json`, and asserts that the dev bundle contains **every** path in `checkPhoneSafety().walked` (as its `dist/` twin). This replaces 1b-3's interim "≥ 40".
- [ ] **Step 5: Mutate, three times.** Each must go red; revert after each.
  1. `import "node:fs"` in `src/core/clock.ts`: both the static rule and the rn proof go red.
  2. Remove `"./sport"` from `subpaths`: the entries assertion goes red.
  3. Set `closure.modules` to one less than measured: the exact-count assertion goes red.
- [ ] **Four types:**
  - unit: the new cases;
  - e2e: the Metro/Hermes leg, which is the phone's build path;
  - smoke: `pnpm engine:boundary` in CI;
  - regression: the mutations.
- [ ] Commit: `feat(engine): phone subpaths are Node-free by CI, not by convention (D25)`.

### Batch 1c close

- [ ] Gate, Opus review → `reviews/1c.md`, PR. The owner merges.
- [ ] Afterwards, send mobile-s1 the subpath list and the first canary version, as a **recommendation to put to their owner** (AGENTS.md class 17). Include the undelivered reply at `.superpowers/handoff/2026-10-13-engine-split/reply-to-mobile-s1.md`.

---

# Batch 1e — fold epochs over the existing golden corpora (spec §5.5, D15, D26, D32b)

Worktree `engine-split-1e`.

The golden corpora already exist: `packages/engine/src/sports/<dir>/<key>.golden.json` for all 11 sports, replayed by `src/testkit/golden.test.ts:387`. Real types live at `golden.ts:111-140`:

- `GoldenStream{config: string (a config NAME), seed, lineups?, events, states, outcome: string, summary: string, deltas: string}`;
- `GoldenCorpus{key, version: string, configs: Record<…>, streams, recordedBy, params}`.

**Known limit (recorded):** the corpora pin `module.outcome`/`module.summary` (`golden.ts:208/:221`), not the kernel's overlays. The guard also watches `states` and `deltas`, which covers mid-match folds.

**Phone-closure note:** `fold-epoch.ts` joins the `./sport` closure, so 1c's recorded `closure.modules` goes up by one. Re-pin it in this batch with the reason, in the same commit as Task 1e-1.

### Task 1e-1: `FOLD_EPOCH`

**Files:** Create `packages/engine/src/sport/fold-epoch.ts` and `fold-epoch.test.ts`. Modify `packages/engine/src/sport/index.ts` (export; `./sport` is a phone subpath) and `packages/engine/phone-subpaths.json` (`closure.modules` +1, new `measured` date).

```ts
// packages/engine/src/sport/fold-epoch.ts
// Per-sport fold epoch (engine-split D26). Bump a sport's number in the SAME change that makes an existing event sequence
// fold differently for that sport (any state, outcome, summary or delta). scripts/fold-epoch-guard.ts enforces it against
// HEAD^1. Native clients send their epoch; the server refuses one lower than this for the fixture's sport (D31).
export const FOLD_EPOCH = {
  football: 1, cricket: 1, boardgame: 1, carrom: 1, generic: 1, volleyball: 1,
  badminton: 1, tabletennis: 1, tennis: 1, icehockey: 1, hockey: 1,
} as const satisfies Readonly<Record<string, number>>;
export type FoldEpochSport = keyof typeof FOLD_EPOCH;
export function foldEpochOf(sport: string): number {
  const e = (FOLD_EPOCH as Readonly<Record<string, number>>)[sport];
  if (e === undefined) throw new Error(`no FOLD_EPOCH for sport "${sport}" — every registered sport must have one`);
  return e;
}
```

- [ ] **Test first.** The sport list is derived from `builtinModules`:

```ts
// packages/engine/src/sport/fold-epoch.test.ts
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { FOLD_EPOCH, foldEpochOf } from "./fold-epoch.ts";

describe("FOLD_EPOCH", () => {
  it(`has exactly one positive integer epoch per registered sport (${builtinModules.length}, never zero)`, () => {
    expect(builtinModules.length).toBeGreaterThan(0);
    expect(Object.keys(FOLD_EPOCH).sort()).toEqual(builtinModules.map((m) => m.key).sort());
    for (const v of Object.values(FOLD_EPOCH)) expect(Number.isInteger(v) && v >= 1).toBe(true);
  });
  it("refuses a sport it does not know instead of answering a default", () => {
    expect(() => foldEpochOf("quidditch")).toThrow(/no FOLD_EPOCH/);
  });
});
```

- [ ] **Mutate once:** delete `hockey`; the test goes red.
- [ ] **Four types:**
  - unit: this file;
  - e2e: Batch 1f's e2e consumes it;
  - smoke: n/a, a constant;
  - regression: the registry-derived key check.
- [ ] Commit: `feat(engine): per-sport FOLD_EPOCH (D26)`.

### Task 1e-2: The epoch guard against `HEAD^1`

**Files:** Create `packages/engine/scripts/fold-epoch-guard.ts` and `packages/engine/test/fold-epoch-guard.test.ts`. Modify `packages/engine/package.json` (`"fold-epoch:check": "node --experimental-strip-types scripts/fold-epoch-guard.ts"`) and `.github/workflows/ci.yml` (gates, beside :126).

**Interfaces:**
- `type Side = { epochs: Record<string, number>; corpora: Record<string, GoldenCorpus> }`. The type is imported from `../src/testkit/golden.ts`.
- `epochViolations(before: Side | null, after: Side): { sport: string; matched: number; changed: number; removed: number; added: number; before: number; after: number; reason: string }[]`, which is pure.
- The CLI has a main-module guard (`import.meta.url === pathToFileURL(process.argv[1]).href`), so importing it from the test does not run it. [R32]

**The rule, per sport** (Review Focus 4) [R16, R17]:

- **Matching.** A stream's identity is `config + "#" + seed`, which is unique in every corpus today (12–76 streams each, no collisions).
- **Changed.** A matched stream **changed** if its `events` are identical and any of `states`, `outcome`, `summary` or `deltas` differs.
- **Re-recorded.** A matched stream whose `events` differ was re-recorded: it counts as **removed + added**.
- **Bump required** (`after > before`) when `changed > 0` or `removed > 0`.
- **Zero matches.** If the baseline had streams and `matched === 0`, that is a violation (`reason: "no baseline stream matched"`) unless the epoch was bumped.
- **Down.** An epoch that went down is always a violation.
- **Added only.** Streams only added need no bump.
- **Output.** Print `matched/changed/removed/added` per sport.

- [ ] **Step 1: Failing tests.** Fixtures are built on the real interfaces.

```ts
// packages/engine/test/fold-epoch-guard.test.ts
import { describe, expect, it } from "vitest";
import type { GoldenCorpus, GoldenStream } from "../src/testkit/golden.ts";
import { epochViolations } from "../scripts/fold-epoch-guard.ts";

const stream = (config: string, seed: number, over: Partial<GoldenStream> = {}): GoldenStream =>
  ({ config, seed, events: [{ seq: 1 }], states: ["s1"], outcome: "A", summary: "{}", deltas: "[]", ...over }) as unknown as GoldenStream;
const corpus = (streams: GoldenStream[]): GoldenCorpus =>
  ({ key: "badminton", version: "1.0.0", configs: {}, streams, recordedBy: "test", params: {} }) as unknown as GoldenCorpus;
const side = (epoch: number, streams: GoldenStream[]) => ({ epochs: { badminton: epoch }, corpora: { badminton: corpus(streams) } });
const sports = (v: ReturnType<typeof epochViolations>) => v.map((x) => x.sport);

describe("fold-epoch guard", () => {
  it("demands a bump when an existing stream's outcome changes", () => {
    expect(sports(epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1, { outcome: "B" })])))).toEqual(["badminton"]);
  });
  it("demands a bump when only a mid-match state changes (what a phone renders)", () => {
    expect(sports(epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1, { states: ["s1-new"] })])))).toEqual(["badminton"]);
  });
  it("is satisfied by the bump", () => {
    expect(epochViolations(side(1, [stream("std", 1)]), side(2, [stream("std", 1, { outcome: "B" })]))).toEqual([]);
  });
  it("does not demand a bump for an added stream (EXTEND_GOLDEN)", () => {
    expect(epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1), stream("std", 2)]))).toEqual([]);
  });
  it("does not demand a bump when streams are only reordered", () => {
    expect(epochViolations(side(1, [stream("std", 1), stream("std", 2)]), side(1, [stream("std", 2), stream("std", 1)]))).toEqual([]);
  });
  it("treats a re-recorded stream (events differ) as removed, which demands a bump", () => {
    expect(sports(epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1, { events: [{ seq: 9 }] as never })])))).toEqual(["badminton"]);
  });
  it("fails closed when a config is renamed and nothing matches", () => {
    const v = epochViolations(side(1, [stream("std", 1)]), side(1, [stream("standard", 1)]));
    expect(sports(v)).toEqual(["badminton"]);
    expect(v[0]!.reason).toMatch(/no baseline stream matched|removed/);
  });
  it("fails closed when every stream is removed", () => {
    expect(sports(epochViolations(side(1, [stream("std", 1)]), side(1, [])))).toEqual(["badminton"]);
  });
  it("treats a missing baseline as nothing to compare, not as a pass by crash", () => {
    expect(epochViolations(null, side(1, [stream("std", 1)]))).toEqual([]);
  });
  it("refuses an epoch that went down", () => {
    expect(sports(epochViolations(side(2, [stream("std", 1)]), side(1, [stream("std", 1)])))).toEqual(["badminton"]);
  });
});
```

- [ ] **Step 2: Implement the rule above.**
  - **HEAD side:** read the corpora with `readCorpus` for every `builtinModules` key.
  - **Ref side:** `git rev-parse --verify --quiet <ref>^{commit}`; if that fails, refuse with exit 2 (like `stryker-floor.ts:549`). Then `git show <ref>:<ENGINE_PREFIX>src/sports/<dir>/<key>.golden.json` for each sport (a missing file means no baseline for that sport). The ref's `fold-epoch.ts` comes via `git show` into a temp `.ts` file that is `import()`ed under strip-types; if it is missing, the baseline is null (first introduction). `ENGINE_PREFIX` comes from `test/layout.ts`'s logic (1d), copied into the script.
  - **Output:** print `fold-epoch: N sports checked, M streams compared`. N = 0 exits 2.
- [ ] **Step 3: CI.** In `gates` after :126: `pnpm --filter @onryde/seazn-engine fold-epoch:check --against HEAD^1`. That job has full history (:68).
- [ ] **Step 4: Real-path mutation, once** [R33]. Do this on a scratch branch:
  1. Change one scoring constant in one sport. Pick the smallest, e.g. a points-to-win default in badminton's config schema, and read the module first.
  2. Run `REBASELINE_GOLDEN=1` for that sport only. Read `golden.ts:252-265` for the exact invocation; the tree must be clean first (`:1272`).
  3. Commit, then run `fold-epoch:check --against HEAD^1`. Expect exit 1 naming **only** that sport.
  4. Bump its epoch, run it again, and expect exit 0.
  5. Discard the branch.
- [ ] **Four types:**
  - unit: the guard tests;
  - e2e [R14]: re-run the scoring walkthrough or spec that drives one sport end to end. Grep `apps/web/e2e/walkthrough/` for a badminton scoring walkthrough, and run the whole file against a local prod build: FOLD_EPOCH is now in the bundle the pad loads;
  - smoke: the CI step;
  - regression: the real-path mutation.
- [ ] Commit: `feat(engine): a changed golden fold must bump that sport's FOLD_EPOCH (D15, D26)`.

### Batch 1e close

- [ ] **Gate:** the two new test files; `golden.test.ts` unchanged; `boundary-gate.test.ts` (re-pinned closure); `fold-epoch:check --against HEAD^1` on the branch; the walkthrough.
- [ ] Opus review → `reviews/1e.md`. Open the PR. The owner merges.

---

# Batch 1f — server minimum-epoch gate (spec §5.6, D15, D26, D31)

Worktree `engine-split-1f`.

**D31 (OWNER, "approve" 2026-10-14).** `engine_epoch` is optional, and there is no `engine_epoch_missing` refusal, because the server cannot tell a capture phone from the web pad. The error code is `ENGINE_OUTDATED`. Only the `events` route is gated:

- **lineups** (`lineups/[entrantId]/route.ts:28`) are inputs to the fold, not a fold;
- **finalize** (`finalize/route.ts:15`) asks the server to fold with its own engine;
- **a `core.void` (undo)** goes through `events`, so an outdated phone's undo is refused too. That is correct: it would void against a ledger it folds differently. [R36]

### Task 1f-1: `engine_epoch` on `AppendEventRequest`

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts:1839-1844`, `apps/web/src/server/usecases/scoring.ts` (`assertEntitledToScore` :468-500 returns the sport; `scoreEvent` :143-197), and `openapi/v1.json` + `openapi/v1.public.json` (via `npm run openapi:gen`).
- Create: `apps/web/src/server/usecases/__tests__/scoring-engine-epoch.test.ts` and `apps/web/e2e/score-engine-epoch.spec.ts`.

**Interfaces:**
- Consumes `foldEpochOf` from `@seazn/engine/sport`.
- Produces:
  - the request field `engine_epoch?: number` (an integer ≥ 1);
  - the refusal `new HttpError(426, "This app's scoring rules for <sport> are out of date — update the app to keep scoring", "ENGINE_OUTDATED", { sport, required, got })`, whose body is `{ ok:false, error:{ code:"ENGINE_OUTDATED", message, sport, required, got }, requestId }`.

**Ordering** [R35]:

- `sport_key` is loaded inside `assertEntitledToScore` (:478-499). Extend its return value to carry `sportKey` alongside the replay it returns.
- **The epoch check runs after both replays.** The cache replay is at :173-182. Add an explicit durable-replay lookup before the check: if `idempotency_key` is present and an event with that key already exists for the fixture, return it the way the 23505 catch does. Reuse that catch's query. Only then compare epochs.
- So a retry of an **already-accepted** key answers 201 whether the cache is warm or cold, and a **new** write from an outdated engine is refused before anything is written.

- [ ] **Step 1: Failing usecase tests.** Build on the setup of the nearest existing `scoreEvent` test (grep `__tests__` for `scoreEvent(`), and run with `DATABASE_URL` set.
  - **Mocking for "lower" cases.** Every epoch is 1 today and the schema's minimum is 1, so "lower" cases mock `@seazn/engine/sport`'s `foldEpochOf` with a partial `vi.mock` (`importOriginal`) and say why in a comment.
  - **Cases:**
    1. Absent → 201, written (the web pad path).
    2. Equal to `foldEpochOf(sport)` → 201.
    3. Higher → 201.
    4. Lower → 426 `ENGINE_OUTDATED` with `{ sport, required: foldEpochOf(sport), got }`, and **no row written** (count `score_events` before and after).
    5. **Only the moved sport is refused** [R18]. Mock `foldEpochOf` so cricket returns `real + 1` and every other sport its real value:
       - a badminton write at its real epoch → 201;
       - a cricket write at the real epoch → 426, with `sport: "cricket"` in the body.
    6. **The key is not burned:** lower with `idempotency_key: K` → 426; then the same `K` with the current epoch → 201 and exactly one row.
    7. **Accepted key, epoch bumped since** [R35]: write with `K` at the current epoch → 201; mock the epoch up; retry `K` → 201 with the original event, both with the cache warm and after clearing the cache (cold). Pin both.
    8. **Second call:** two lower calls → two 426s, zero rows.
    9. **Another sport:** case 4 swept with `forEachSportAsync` over every builtin sport the setup can score. Expectations come from `foldEpochOf(m.key)`, and the sweep asserts its count is greater than 0.
    10. **Withdrawal cascade:** the cascade's internal `scoreEvent` call (`withdrawal.ts:125-232`) passes no epoch and still writes. Assert one such write succeeds.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
  - **Schema:** `engine_epoch: z.number().int().min(1).optional()` with `.describe("Fold epoch of the client's engine for this fixture's sport (engine-split D26/D31). Native clients send it; the web pad does not.")`.
  - **`scoreEvent`:** apply the Ordering above.
- [ ] **Step 4:** Run `npm run openapi:gen` and commit the specs (the `ci.yml:130` drift gate).
- [ ] **Step 5: E2E.** Write `apps/web/e2e/score-engine-epoch.spec.ts` as an API-level Playwright test, reusing a scoring API spec's setup (grep `apps/web/e2e/` for `/events`).
  - **(a)** `engine_epoch` equal to the current `foldEpochOf(sport)` → 201, and the public match page shows the point.
  - **(b)** `engine_epoch: 0` → 400 (`VALIDATION`, http.ts:169-170), and the event count is unchanged.
  - The 426 branch is covered by the usecase tests, since a prod build cannot hold a higher epoch.
  - Run the whole file against a local prod build.
- [ ] **Step 6: Smoke.** If `scripts/smoke.ts` posts a score event, add `engine_epoch` at the current value to one post and assert 201.
- [ ] **Step 7: Mutate once each, reverting after each.** Each must go red:
  - `<` → `<=`: case 2;
  - delete the check: case 4;
  - compare against `Math.max(...Object.values(FOLD_EPOCH))`: case 5;
  - move the check above the durable lookup: case 7 cold.
- [ ] **Four types:**
  - unit: cases 1–10;
  - e2e: Step 5;
  - smoke: Step 6;
  - regression: cases 5–7.
- [ ] Commit: `feat(scoring): refuse writes from an engine whose fold epoch for the sport is behind (D15, D26, D31)`.

### Task 1f-2: Capture handoff

- [ ] No scoring-events contract exists in `docs/contracts/` today (D32c). Write `docs/superpowers/specs/engine-split/capture-s2-handoff.md` with the field, the refusal body, the status, the ordering guarantees (cases 6–7) and the phone subpaths. Send its path to mobile-s1 as a **recommendation to their owner**.
- [ ] **Four types:** n/a, docs only.
- [ ] Commit: `docs(engine-split): capture S2 handoff for engine_epoch`.

### Batch 1f close

- [ ] **Gate:** the usecase file; route and schema tests touching `AppendEventRequest` (grep); `npm run openapi:gen && git diff --exit-code openapi/`; the e2e file; smoke.
- [ ] Opus review → `reviews/1f.md`, with the four questions answered for the write path. Open the PR. The owner merges.

---

## After Phase 1

- The Phase 2a plan is written after Batch 1a merges, against the tree as it is then.
- The Phase 2b plan is written at W2e close. It takes `ledgers/*.json` and `reverse-inventory.md` as inputs, and also does the D32g `STRYKER_RUNNER` rename and the D32d `tools-import-guard` drop.
- After each batch merges, update the spec status line and the `project_engine_split_sequencing` memory.
