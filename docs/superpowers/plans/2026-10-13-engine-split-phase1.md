# Engine split — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan batch by batch. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inside the monorepo, make `@seazn/engine` a pure, publishable, phone-safe library — placement client out behind a port, compiled `dist/` published as canaries, the monorepo-reading tests rehomed, fold epochs pinned, and the server refusing outdated engine epochs — so that Phase 2a/2b are pure relocations.

**Architecture:** Six batches, one PR each, landed in order 1a → 1b → 1d → 1c → 1e → 1f (1d before 1c because 1d moves `engine-boundary.ts`, which 1c extends). The app keeps consuming the engine from the workspace throughout; only the published tarball is compiled. Every batch carries its own parity proof.

**Tech Stack:** TypeScript 7 (`typescript-native` 7.0.2), Node 26 with `--experimental-strip-types`, pnpm 10.34.5 workspaces, vitest 4, Playwright, Next 16, GitHub Actions, GitHub Packages, Metro + Hermes (React Native 0.86.3) for the phone proof.

**Spec:** `docs/superpowers/specs/2026-10-13-engine-split-design.md` (owner-approved, ledger D1–D30). Fact sheet behind this plan: `.superpowers/handoff/2026-10-13-engine-split/phase1-plan-facts.md` (gitignored, in the main checkout). Line numbers below are against `origin/main` `5871c748e`; **re-pin every one before editing** (AGENTS.md class 5).

## Execution topology (D30 — owner ruling)

- One batch = one PR = one worktree: `~/github/seazn.club-worktrees/engine-split-<batch>` on branch `feat/engine-split-<batch>`, created from fresh `origin/main` (`git fetch origin && git worktree add -b feat/engine-split-1a ~/github/seazn.club-worktrees/engine-split-1a origin/main`). Run `pnpm install` in it first (a fresh worktree has no `node_modules`).
- Each task: implemented by `implementer-sonnet`, then reviewed by `reviewer-sonnet`; loop until the review is clean and the task's scoped tests are green.
- Each batch: reviewed as a whole by `reviewer` (Opus), answering TEST-STRATEGY's four questions in writing; findings written to `docs/superpowers/specs/engine-split/reviews/<batch>.md`; loop to clean.
- Never override `model:` on a dispatch. The orchestrator re-runs each batch's scoped gate itself before opening the PR, judging green only from `--reporter=json --outputFile` counts with `.testResults[].name` confirmed.
- The orchestrator opens the PR; **the owner merges**. Before merging any PR that touches `packages/engine`, message the live engine sessions (f-w2c, mutation, chess) that it is coming, so they rebase once.

## Global Constraints

- No engine behaviour change (D5). The ports change the engine's API and dependencies, never what it computes; Task 1a-2 proves this with a before/after snapshot.
- Scoped tests only — never the full vitest, e2e or gate locally (AGENTS.md, RULES.md). Run from `apps/web` or the package dir, never `--root`.
- Every change ships a test that fails without it; every guard added is mutated once (TEST-STRATEGY rule 5). Every sweep reports its count; zero checked fails (rule 2).
- Each task's acceptance names the four test types (unit / e2e / smoke / regression). A task with no UI traces forward to the user flow that exercises it.
- `git stash` is forbidden. Worktrees for every branch. Synthetic data only. Never print a token.
- Never delete a remote repo, package, cache or tag.
- Package names: published `@onryde/seazn-engine`; imported everywhere as `@seazn/engine` (D19). New workspace package `@seazn/scheduler` (private).
- Phone subpaths may import no `node:*`, read no `process`, import nothing from `scheduling` (D25).
- Semver/epochs: `FOLD_EPOCH` starts at 1 for all 11 sports (D26).
- New user-facing strings: none are expected in Phase 1. If one appears, all 4 locale dictionaries (AGENTS.md).

## Review Focus

Failure modes the spec implies that no task's happy-path tests would catch, most likely first. Each has its pinning test in the named task.

1. **Placement down or secret wrong after the port** — an organiser pressing Auto-schedule must still get the greedy board flagged `solver_unavailable`, never a 500. Pinned in Task 1a-4 (adapter against an unreachable host, through `autoSchedule`).
2. **A `"use client"` file importing `@seazn/scheduler`** drags gRPC into the browser bundle and `next build` dies with `Module not found: dns`. Pinned in Task 1a-4 (extend `client-graph-no-server-barrel.test.ts` to `@seazn/scheduler`).
3. **`pnpm install --prod` on stg/prod missing a scheduler runtime dep** (grpc left in devDependencies) — deploy boots, first schedule build crashes. Pinned in Task 1a-3 (scheduler `runtime-deps.test.ts`).
4. **A golden corpus extended or reordered** must not demand an epoch bump, while a changed result of an existing stream must. Pinned in Task 1e-2 (match streams by config + seed; three cases).
5. **An outdated-epoch refusal burns the idempotency key**, so the same write fails again after the scorer updates. Pinned in Task 1f-1 (refuse, then the same `idempotency_key` succeeds with a current epoch).

---

# Batch 1a — solver port, logger port, `packages/scheduler` (spec §5.1, D11, D25, D29)

Worktree `engine-split-1a`. Files touched across the batch:

- Create: `scripts/test-parity.mjs`, `scripts/__tests__/test-parity.test.ts`
- Create: `packages/engine/src/scheduling/solver-port.ts`, `packages/engine/src/scheduling/__tests__/solver-fakes.ts`, `packages/engine/src/scheduling/build-port-equivalence.test.ts`
- Modify: `packages/engine/src/scheduling/build.ts`, `repair-decompose-cpsat.ts`, `index.ts`, every `build*.test.ts`, `repair-decompose-cpsat*.test.ts`, `packages/engine/package.json`, `packages/engine/test/runtime-deps.test.ts`, `packages/engine/stryker.groups.mjs`, `packages/engine/test/stryker-groups.test.ts`
- Move (git mv): `packages/engine/src/scheduling/{placement-client.ts,placement-client.test.ts,generated/,logger.ts,__tests__/placement-integration.test.ts}`, `packages/engine/scripts/gen-proto.ts` → `packages/scheduler/...`
- Create: `packages/scheduler/{package.json,tsconfig.json,eslint.config.mjs,vitest.config.ts,src/index.ts,src/solver.ts,test/runtime-deps.test.ts,src/solver.test.ts}`
- Modify: `apps/web/src/server/usecases/schedule.ts`, `schedule-ai-solver.ts`, `apps/web/package.json`, `apps/web/vitest.config.ts`, the 5 apps/web tests that spy on the placement client, `apps/web/src/lib/__tests__/client-graph-no-server-barrel.test.ts`, `Dockerfile`, `.github/workflows/{ci.yml,placement-ci.yml,placement-stg.yml}`, `pnpm-lock.yaml`

### Task 1a-1: Test-parity script

The script every later batch uses to prove "same tests, nothing lost" (spec §5.4).

**Files:**
- Create: `scripts/test-parity.mjs`
- Test: `scripts/__tests__/test-parity.test.ts`

**Interfaces:**
- Produces: CLI `node scripts/test-parity.mjs --before <a.json> --after <b.json> [--ledger <ledger.json>] [--root-before <dir>] [--root-after <dir>]`; exit 0 = accounted, 1 = unaccounted ids, 2 = vacuous/invalid input. Exports `testIds(report, root): string[]` and `diffIds(before, after, ledger): { onlyBefore, onlyAfter, both, unaccounted }`.
- Input formats: a vitest JSON-reporter file (`testResults[].assertionResults[]`) OR a `vitest list --json=<file>` file (an array of `{ name: "A > b", file: "/abs/path" }`). **Parity steps use `vitest list`**: it collects ids without running tests, so measuring a whole package does not break the owner's "never run the full suite locally" rule; passing is proven separately by the scoped runs and by CI.
- Ledger format: `{ "entries": [{ "id": "<file › describe › it>", "fate": "moved"|"rehomed"|"rewritten"|"split"|"added", "to": "<id or file>", "reason": "<text>" }] }`. The script does not police `fate`; the batch reviewer does.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/__tests__/test-parity.test.ts
import { describe, expect, it } from "vitest";
import { diffIds, testIds } from "../test-parity.mjs";

const report = (root: string, files: Record<string, string[][]>) => ({
  numTotalTests: Object.values(files).reduce((n, t) => n + t.length, 0),
  testResults: Object.entries(files).map(([name, tests]) => ({
    name: `${root}/${name}`,
    assertionResults: tests.map((path) => ({ ancestorTitles: path.slice(0, -1), title: path.at(-1)! })),
  })),
});

describe("test-parity", () => {
  it("names a test by root-relative file, describe chain and title", () => {
    const r = report("/x/packages/engine", { "src/a.test.ts": [["A", "b"]] });
    expect(testIds(r, "/x/packages/engine")).toEqual(["src/a.test.ts › A › b"]);
  });

  it("reports nothing unaccounted when both sides hold the same ids under different roots", () => {
    const a = testIds(report("/mono/packages/engine", { "t.test.ts": [["x"]] }), "/mono/packages/engine");
    const b = testIds(report("/engine", { "t.test.ts": [["x"]] }), "/engine");
    expect(diffIds(a, b, { entries: [] }).unaccounted).toEqual([]);
  });

  it("flags an id that vanished without a ledger entry", () => {
    expect(diffIds(["f › a", "f › b"], ["f › a"], { entries: [] }).unaccounted).toEqual(["f › b"]);
  });

  it("accepts a vanished id the ledger accounts for, and only that one", () => {
    const ledger = { entries: [{ id: "f › b", fate: "rehomed", to: "g › b", reason: "reads apps/web" }] };
    expect(diffIds(["f › a", "f › b", "f › c"], ["f › a"], ledger).unaccounted).toEqual(["f › c"]);
  });

  it("flags an id that appeared from nowhere", () => {
    expect(diffIds(["f › a"], ["f › a", "f › new"], { entries: [] }).unaccounted).toEqual(["f › new"]);
  });

  it("reads `vitest list --json` output as well as reporter output", () => {
    const listed = [{ name: "A > b", file: "/x/packages/engine/src/a.test.ts" }];
    expect(testIds(listed, "/x/packages/engine")).toEqual(["src/a.test.ts › A › b"]);
  });

  it("refuses an empty report rather than passing it", () => {
    expect(() => testIds({ numTotalTests: 0, testResults: [] }, "/x")).toThrow(/zero tests/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/parity.json scripts/__tests__/test-parity.test.ts; node -e 'const r=require("/tmp/parity.json");console.log(r.numPassedTests,r.numTotalTests,r.testResults.map(t=>t.name))'`
Expected: suite fails to collect (`Cannot find module '../test-parity.mjs'`).

- [ ] **Step 3: Implement**

```js
// scripts/test-parity.mjs
// Same tests before and after a move, or every difference accounted for (engine-split spec §5.4, D23).
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEP = " › ";

export function testIds(report, root) {
  const ids = [];
  const rel = (f) => path.relative(root, f).split(path.sep).join("/");
  if (Array.isArray(report)) {
    // `vitest list --json`: [{ name: "describe > it", file }]
    for (const t of report) ids.push([rel(t.file), ...t.name.split(" > ")].join(SEP));
  }
  for (const file of Array.isArray(report) ? [] : (report?.testResults ?? [])) {
    for (const a of file.assertionResults ?? []) ids.push([rel(file.name), ...(a.ancestorTitles ?? []), a.title].join(SEP));
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
  for (const e of ledger?.entries ?? []) {
    accounted.add(e.id);
    if (e.to) accounted.add(e.to);
  }
  const unaccounted = [...onlyBefore, ...onlyAfter].filter((id) => !accounted.has(id));
  return { onlyBefore, onlyAfter, both, unaccounted };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const before = JSON.parse(readFileSync(arg("--before"), "utf8"));
    const after = JSON.parse(readFileSync(arg("--after"), "utf8"));
    const ledger = arg("--ledger") ? JSON.parse(readFileSync(arg("--ledger"), "utf8")) : { entries: [] };
    const d = diffIds(
      testIds(before, path.resolve(arg("--root-before") ?? ".")),
      testIds(after, path.resolve(arg("--root-after") ?? ".")),
      ledger,
    );
    console.log(`before-only ${d.onlyBefore.length} · after-only ${d.onlyAfter.length} · both ${d.both.length} · unaccounted ${d.unaccounted.length}`);
    for (const id of d.unaccounted) console.log(`UNACCOUNTED ${id}`);
    process.exit(d.unaccounted.length === 0 ? 0 : 1);
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(2);
  }
}
```

A rehomed test that keeps its title still changes id (its file changes); the ledger's `to` names the new id, which accounts for the after-only side.

- [ ] **Step 4: Run — expect 7/7 PASS** (same command as Step 2; confirm `numPassedTests == numTotalTests == 7` and the one result name is `scripts/__tests__/test-parity.test.ts`). Then confirm the real `vitest list` shape matches the fixture: `cd packages/engine && ./node_modules/.bin/vitest list --json=/tmp/l.json src/core/rng.test.ts && head -c 300 /tmp/l.json` — if vitest 4 emits a different shape, adapt `testIds` and the fixture to the real one before committing.
- [ ] **Step 5: Mutate once.** Change `diffIds` to `return { …, unaccounted: [] }`; rerun; the three "flags"/"accepts" tests must go red. Revert.
- [ ] **Step 6: Commit** — `git add scripts/test-parity.mjs scripts/__tests__/test-parity.test.ts && git commit -m "feat(engine-split): test-parity script — same ids before and after, or a ledger entry"`

### Task 1a-2: The port in the engine, with a before/after equivalence proof

**Files:**
- Create: `packages/engine/src/scheduling/solver-port.ts`, `packages/engine/src/scheduling/__tests__/solver-fakes.ts`, `packages/engine/src/scheduling/build-port-equivalence.test.ts`
- Modify: `packages/engine/src/scheduling/build.ts` (:125-126, :503-562, :1157, :1438, :2095-2160, the six `log.` sites :1158 :1915 :1953 :2150 :2193 :2252), `repair-decompose-cpsat.ts` (:178-212, :338, :471-478), `index.ts`, and the tests listed in Step 5

**Interfaces:**
- Produces (exported from `@seazn/engine/scheduling`):

```ts
// packages/engine/src/scheduling/solver-port.ts
// The engine's side of the placement boundary (engine-split spec §5.1, D11, D25).
// The engine decides WHAT to ask the solver and what to do with the answer; the caller
// decides HOW the question reaches a solver. No transport, env or secret lives here.

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
  /** Correlation id for the solver's logs; built by the engine from `t0` (build.ts ~:2120). */
  readonly requestId: string;
}
/** Rejecting is how a solver says "no answer"; a rejection MAY carry a string `failure`. */
export type PlacementSolver = (input: SolveBuildInput, ctx: SolveContext) => Promise<SolveBuildOutcome>;

type LogFn = (fields: Record<string, unknown>, message: string) => void;
/** The four levels the scheduler uses, in pino's (fields, message) order. */
export interface EngineLogger { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn }
export const silentLogger: EngineLogger = { debug() {}, info() {}, warn() {}, error() {} };
```

- `BuildInput` gains `solve: PlacementSolver; log: EngineLogger` (both **required**, D29 — an optional `solve` defaulting to greedy is an inert seam).
- `DecomposedCpsatRepairInput` gains the same two required fields and passes them to every `buildSchedule` call.
- Consumes: nothing from earlier tasks except Task 1a-1's script (Step 7).

- [ ] **Step 1: Write the equivalence test against the CURRENT code** (before touching `build.ts`). It records, for every scenario, the exact `SolveBuildInput` the engine sends and the `BuildResult` it returns.

```ts
// packages/engine/src/scheduling/build-port-equivalence.test.ts
// Before/after proof for the solver port (engine-split plan Task 1a-2): the port changes HOW the solver is
// reached, never WHAT the engine asks or returns. The snapshot below is recorded on the pre-port code and
// must not change when the port lands.
import { describe, expect, it, vi } from "vitest";
import { buildSchedule } from "./build.ts";
import { EQUIVALENCE_SCENARIOS } from "./__tests__/equivalence-scenarios.ts";

const stable = (r: object) => JSON.parse(JSON.stringify(r, (k, v) => (k === "elapsedMs" || k === "requestId" ? 0 : v)));

describe("solver port equivalence", () => {
  it(`covers ${EQUIVALENCE_SCENARIOS.length} scenarios (never zero)`, () => {
    expect(EQUIVALENCE_SCENARIOS.length).toBeGreaterThanOrEqual(6);
  });

  for (const s of EQUIVALENCE_SCENARIOS) {
    it(`asks the solver the same question and returns the same board: ${s.name}`, async () => {
      const calls: unknown[] = [];
      const client = await import("./placement-client.ts");
      const spy = vi.spyOn(client, "solveBuild").mockImplementation(async (input) => {
        calls.push(input);
        if (s.solver === "reject") throw Object.assign(new Error("down"), { failure: "unavailable" });
        return s.outcome(input);
      });
      const result = await buildSchedule(s.input());
      spy.mockRestore();
      expect(stable({ calls, result })).toMatchSnapshot();
    });
  }
});
```

Create `packages/engine/src/scheduling/__tests__/equivalence-scenarios.ts` exporting `EQUIVALENCE_SCENARIOS: { name: string; input: () => BuildInput-without-ports; solver: "resolve" | "reject"; outcome: (input) => SolveBuildOutcome }[]`. Populate it by lifting **six existing inputs verbatim** from `build-determinism.test.ts` (its 6 `buildSchedule(` calls) and adding: one scenario whose solver rejects (`failure: "unavailable"` → greedy `solver_unavailable`), one `status: "ERROR"`, one `"UNKNOWN"`, one `"INFEASIBLE"`. For the resolving scenarios, `outcome` returns `status: "OPTIMAL"` with each fixture placed at the first court and the earliest `startAtMs` the input's grid allows (read the grid off `input` — never a hand-typed table).

- [ ] **Step 2: Record the snapshot on the old code.** Run: `cd packages/engine && ./node_modules/.bin/vitest run -u --reporter=json --outputFile=/tmp/eq.json src/scheduling/build-port-equivalence.test.ts`. Confirm ≥ 10 tests passed and `src/scheduling/__snapshots__/build-port-equivalence.test.ts.snap` exists. **Commit the test and the snapshot alone:** `git commit -m "test(scheduling): record solver requests and boards before the port"`.

- [ ] **Step 3: Create `solver-port.ts`** exactly as in Interfaces. Move `SolveBuildInput` (placement-client.ts:58-190) and `SolveBuildOutcome` (:192-200) into it verbatim, and make `placement-client.ts` import them from `./solver-port.ts` and re-export them (`export type { SolveBuildInput, SolveBuildOutcome } from "./solver-port.ts";`) so nothing else breaks yet. **Guard:** if the moved block references anything from `./generated/` or `@grpc/grpc-js`, stop and report — the premise "plain structural types" is then false.

- [ ] **Step 4: Thread the ports through `build.ts`.**
  - Delete `import { log } from "./logger.ts";` (:126). Change :125 to `import type { EngineLogger, PlacementSolver, SolveBuildInput, SolveBuildOutcome } from "./solver-port.ts";`.
  - Add to `BuildInput` (:503-562):

    ```ts
      /** Who answers the placement question (engine-split D11). Required: an optional solver that
       *  silently fell back to greedy would be an inert seam (AGENTS.md class 1). */
      solve: PlacementSolver;
      /** Where scheduling logs go (D25). Pass `silentLogger` to drop them deliberately. */
      log: EngineLogger;
    ```
  - In every function that used the module-level `log`, read `input.log` instead (`solveBuild` has `input`; thread `log` as a parameter into any helper that logged and does not receive `input` — keep messages, levels and fields byte-identical).
  - Replace :2120-2126's dynamic import and call with:

    ```ts
    outcome = await input.solve(placementInput, { requestId });
    ```
    and delete the comment block that explains the dynamic import (:2099-2108) and the `process.env.PLACEMENT_SERVICE_SECRET` read — the secret now belongs to the caller. Keep the `catch` (:2128-2154) unchanged: it already duck-types `failure`.
  - `repair-decompose-cpsat.ts`: add `solve` and `log` to `DecomposedCpsatRepairInput` (:178-212) with the same doc comments, and pass `solve: input.solve, log: input.log` in the `buildSchedule({...})` call (:471-478). Fix the stale comment at :331 (it cites `withZ3LockAndReset` at `build.ts:1196`, which no longer exists) — describe the queue cap at `build.ts:1155-1209` instead.
  - `scheduling/index.ts`: add `export * from "./solver-port.ts";`.

- [ ] **Step 5: Convert the engine tests from module spying to injection.** Create the fakes:

```ts
// packages/engine/src/scheduling/__tests__/solver-fakes.ts
import { vi } from "vitest";
import type { EngineLogger, PlacementSolver, SolveBuildOutcome } from "../solver-port.ts";
import { silentLogger } from "../solver-port.ts";

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
export { silentLogger };
```

Conversion rule, applied to `build.test.ts` (55 spy sites + the `vi.doMock` at :771), `build-polish` (8), `build-rest-lattice` (6), `build-day-gate` (2), `build-refusal-logged` (1), and every other `buildSchedule(` / `repairDecomposedCpsat(` call in `build-budget`, `build-determinism`, `build-pins`, `build-conflict-sources`, `repair-decompose-cpsat.test.ts`, `__tests__/repair-decompose-cpsat-integration.test.ts`:

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

- A call that had **no** spy installed passes `solve: unavailableSolver` (that is the branch it was exercising — the client failing to connect).
- `mockImplementation(fn)` becomes `fakeSolver(fn)`; `mockRejectedValue(e)` becomes `fakeSolver(async () => { throw e; })`.
- `build-refusal-logged.test.ts` and `build.test.ts:56/:811` replace the imported pino `log` with `recordingLogger()` and assert on `lines` — same levels and messages they asserted before.
- `PlacementError` used in these tests: replace with `Object.assign(new Error(msg), { failure })` — the engine never imports the class.
- **Titles do not change.** No test is added or removed in this step.

- [ ] **Step 6: Point the equivalence test at the port.** Replace its `vi.spyOn(client, "solveBuild")` block with a `fakeSolver` that records `calls` the same way, and pass `{ ...s.input(), solve, log: silentLogger }`. Run WITHOUT `-u`:

Run: `cd packages/engine && ./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/eq2.json src/scheduling/build-port-equivalence.test.ts`
Expected: all pass against the snapshot committed in Step 2. **The snapshot file must be unchanged** — `git diff --exit-code src/scheduling/__snapshots__/` returns 0. If it differs, the port changed behaviour: stop and report.

- [ ] **Step 7: Parity over the converted suites.** Baseline: check out the Step-2 commit in a detached scratch worktree (`git worktree add --detach <scratch> <sha>`, then `pnpm install` there) and run `cd <scratch>/packages/engine && ./node_modules/.bin/vitest list --json=/tmp/before-1a2.json src/scheduling`; on the branch the same into `/tmp/after-1a2.json`; then:

Run: `node scripts/test-parity.mjs --before /tmp/before-1a2.json --after /tmp/after-1a2.json --root-before <scratch>/packages/engine --root-after packages/engine`
Expected: `unaccounted 0`, `both` equal to the before count. Paste the counts into the commit body.

- [ ] **Step 8: Typecheck the engine:** `cd packages/engine && pnpm typecheck` → exit 0 (the compiler now lists every `buildSchedule` caller that lacks `solve`/`log`; apps/web callers are fixed in Task 1a-4, so run the engine package only).
- [ ] **Step 9: Mutate once.** In `build.ts` replace `await input.solve(placementInput, { requestId })` with `await unavailableSolver(...)`-equivalent `Promise.reject(new Error("x"))`; the equivalence test and the converted `build.test.ts` must go red. Revert.
- [ ] **Step 10: Commit** — `git commit -m "refactor(scheduling): the engine asks an injected solver and logger instead of opening gRPC (D11, D25)"`.

### Task 1a-3: `packages/scheduler` — the client, the stubs, the adapter

**Files:**
- Move (`git mv`): `packages/engine/src/scheduling/placement-client.ts` → `packages/scheduler/src/placement-client.ts`; `…/placement-client.test.ts` → `packages/scheduler/src/placement-client.test.ts`; `…/generated/` → `packages/scheduler/src/generated/`; `…/logger.ts` → `packages/scheduler/src/logger.ts`; `…/__tests__/placement-integration.test.ts` → `packages/scheduler/src/placement-integration.test.ts`; `packages/engine/scripts/gen-proto.ts` → `packages/scheduler/scripts/gen-proto.ts`
- Create: `packages/scheduler/package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `src/index.ts`, `src/solver.ts`, `src/solver.test.ts`, `test/runtime-deps.test.ts`
- Modify: `packages/engine/package.json` (drop `@bufbuild/protobuf`, `@grpc/grpc-js`, `pino`, devDeps `protoc`, `ts-proto`, the `gen:proto` script, the `./scheduling/placement-client` export), `packages/engine/test/runtime-deps.test.ts` (:83-88), `packages/engine/stryker.groups.mjs` (:294, :296, :304), `packages/engine/test/stryker-groups.test.ts` (:154, :157), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `PlacementSolver`, `EngineLogger`, `SolveBuildInput`, `SolveBuildOutcome` from `@seazn/engine/scheduling` (Task 1a-2).
- Produces (from `@seazn/scheduler`): `placementSolver: PlacementSolver`, `schedulerLog: EngineLogger`, and re-exports `PlacementError`, `PlacementFailure`. Subpath `@seazn/scheduler/placement-client` exposes the client module for tests that spy on `solveBuild`.

- [ ] **Step 1: Write the failing adapter test**

```ts
// packages/scheduler/src/solver.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SolveBuildInput } from "@seazn/engine/scheduling";
import { placementSolver } from "./solver.ts";

const INPUT = { courts: [], fixtures: [], grid: { stepMinutes: 5, slots: [] }, existing: [], dependencies: [], constraints: {}, wallSeconds: 1 } as unknown as SolveBuildInput;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("placementSolver (the adapter behind the engine's solver port)", () => {
  it("forwards the engine's question and requestId, and the secret from the environment", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_SECRET", "test-secret");
    const client = await import("./placement-client.ts");
    const spy = vi.spyOn(client, "solveBuild").mockResolvedValue({ assignments: [], status: "OPTIMAL", tiersCompleted: 0, objectiveValues: [], elapsedMs: 1, wallExhausted: false });
    await placementSolver(INPUT, { requestId: "build-1f1c-7" });
    expect(spy).toHaveBeenCalledWith(INPUT, { secret: "test-secret", requestId: "build-1f1c-7" });
  });

  it("sends an empty secret when none is configured, rather than throwing before the call", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_SECRET", undefined as unknown as string);
    const client = await import("./placement-client.ts");
    const spy = vi.spyOn(client, "solveBuild").mockRejectedValue(Object.assign(new Error("no"), { failure: "unauthenticated" }));
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
  "exports": {
    ".": "./src/index.ts",
    "./placement-client": "./src/placement-client.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "node ../../node_modules/typescript-native/bin/tsc --noEmit",
    "lint": "eslint",
    "gen:proto": "node --experimental-strip-types scripts/gen-proto.ts"
  },
  "dependencies": {
    "@bufbuild/protobuf": "^2.13.0",
    "@grpc/grpc-js": "^1.14.4",
    "@seazn/engine": "workspace:*",
    "pino": "^10.3.1"
  },
  "devDependencies": {
    "@types/node": "^26",
    "protoc": "35.1.0",
    "ts-proto": "2.12.0",
    "typescript-native": "npm:typescript@7.0.2",
    "vitest": "^4.1.11"
  }
}
```

Copy `tsconfig.json` and `eslint.config.mjs` from `packages/reference/` (the nearest private workspace package) and adjust `include` to `src`, `test`, `scripts`. Add `packages/scheduler/vitest.config.ts` with `test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"] }`. Copy the devDependency versions that `packages/reference/package.json` uses for `eslint`, `@eslint/js`, `typescript-eslint` exactly.

```ts
// packages/scheduler/src/solver.ts
// The adapter behind @seazn/engine's solver port (engine-split spec §5.1, D11): env and secret live HERE,
// never in the engine. The client is imported at call time so tests can spy on `solveBuild` through the
// module namespace — the repo's recorded inert-mock trap (a static import would make the spy see nothing).
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
/** The pino logger the engine's scheduler used to own (D25); same name and level env. */
export const schedulerLog: EngineLogger = {
  debug: (f, m) => log.debug(f, m),
  info: (f, m) => log.info(f, m),
  warn: (f, m) => log.warn(f, m),
  error: (f, m) => log.error(f, m),
};
```

- [ ] **Step 3: Move the files** with `git mv` (list above). In the moved `placement-client.ts`, change the type imports to `import type { SolveBuildInput, SolveBuildOutcome } from "@seazn/engine/scheduling";`, drop the re-export added in Task 1a-2 Step 3, change `../core/clock.ts` to `@seazn/engine/core` (confirm `Clock`/`systemClock` are exported there; if not, add them to the `./core` barrel — additive). In `gen-proto.ts` change `engineRoot`/`repoRoot` to the scheduler package (`repoRoot = path.resolve(pkgRoot, "../..")`, `outDir = path.join(pkgRoot, "src/generated")`). Regenerate once — `pnpm --filter @seazn/scheduler gen:proto` — and confirm `git diff --stat packages/scheduler/src/generated` is empty (byte-identical stubs).

- [ ] **Step 4: Runtime-deps gate for the scheduler** (Review Focus 3). Copy `packages/engine/test/runtime-deps.test.ts` to `packages/scheduler/test/runtime-deps.test.ts`, point `MANIFEST` and the scanned dir at the scheduler, and pin the found set to `["@bufbuild/protobuf", "@grpc/grpc-js", "@seazn/engine", "pino"]`. In the engine's copy (:83-88) the set becomes `["zod"]`, and the explanatory comment (:76-82) is rewritten to say the gRPC client and logger left with D11/D25.

- [ ] **Step 5: Engine manifest and Stryker exclusions.** Remove the three deps, the two devDeps, `gen:proto`, and the `./scheduling/placement-client` export from `packages/engine/package.json`. In `stryker.groups.mjs` delete the three now-dangling keys (:294, :296, :304) — `test/stryker-groups.test.ts` rejects stale keys (:127) — and update `:154`'s list and `:157`'s expectation to the files that still exist. Run `pnpm install` to update the lockfile.

- [ ] **Step 6: Run the scoped suites**

Run: `cd packages/scheduler && ./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/sched.json` then `cd ../engine && ./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/eng-1a3.json test/runtime-deps.test.ts test/stryker-groups.test.ts src/scheduling`
Expected: scheduler: `solver.test.ts` 2, `placement-client.test.ts` 24, `runtime-deps.test.ts` all pass, `placement-integration.test.ts` 4 **skipped** (no `PLACEMENT_SERVICE_HOST`); engine: all pass. Confirm `.testResults[].name` lists the scheduler files under `packages/scheduler/`.

- [ ] **Step 7: Parity ledger.** `vitest list --json` the engine's `src/scheduling` before (scratch worktree at Task 1a-2's commit) and after, plus the scheduler package after; write `docs/superpowers/specs/engine-split/ledgers/1a.json` with one `"rehomed"` entry per test of `placement-client.test.ts` (24) and `placement-integration.test.ts` (4), `to` = the new id under `packages/scheduler`. `node scripts/test-parity.mjs … --ledger …/1a.json` → `unaccounted 0`. (Generate the entries with a one-off `node -e` over the two reports; commit only the ledger.)

- [ ] **Step 8: Mutate once.** Delete `@grpc/grpc-js` from the scheduler's `dependencies`; its runtime-deps test must fail naming it. Restore.
- [ ] **Step 9: Commit** — `git commit -m "feat(scheduler): packages/scheduler owns the placement client, stubs, logger and the port adapter"`.

### Task 1a-4: Wire the app, CI and the image build; prove the seam end to end

**Files:**
- Modify: `apps/web/package.json` (add `"@seazn/scheduler": "workspace:*"` to `dependencies`), `apps/web/vitest.config.ts:165` (`server.deps.inline` gains `/@seazn\/scheduler/`), `apps/web/src/server/usecases/schedule.ts` (:1925, :2487), `apps/web/src/server/usecases/schedule-ai-solver.ts` (:348), the 5 apps/web tests (`schedule-court-hours`, `schedule-capacity-guard`, `schedule-court-candidates`, `stage-round-court-tags`, `schedule-auto-solver-busy-latency`), `apps/web/src/lib/__tests__/client-graph-no-server-barrel.test.ts`, `Dockerfile` (:13-16 manifest COPY list), `.github/workflows/placement-ci.yml` (:36-37 paths, :297-305 drift, :405 integration), `.github/workflows/placement-stg.yml` (:45-46), `.github/workflows/ci.yml` (add a scheduler test job)
- Create: `apps/web/src/server/usecases/__tests__/schedule-solver-port-wiring.test.ts`, `packages/scheduler/src/seam.test.ts`

**Interfaces:**
- Consumes: `placementSolver`, `schedulerLog`, `PlacementError` from `@seazn/scheduler` (Task 1a-3).

- [ ] **Step 1: Failing wiring test** (Review Focus 1). Through the REAL `autoSchedule` and the REAL adapter, with the placement host pointed at a closed port, the organiser still gets a greedy board:

```ts
// apps/web/src/server/usecases/__tests__/schedule-solver-port-wiring.test.ts
// Seam proof (AGENTS.md class 1): autoSchedule → buildSchedule → placementSolver → placement-client, all real.
// The service is unreachable, so the board must be greedy and flagged, never a 500.
```

Build it on the fixture setup of `schedule-auto-cooldown.test.ts` (copy its DB/fixture arrangement; that file already calls `autoSchedule` once). `vi.stubEnv("PLACEMENT_SERVICE_HOST", "127.0.0.1:1")`. Assert the result's `engine === "greedy"` and `notSearchedReason === "solver_unavailable"` (re-read `BuildResult` for the exact field names before writing the assertion), and that every fixture got an assignment. A second test does the same through `reflowExisting`.

- [ ] **Step 2: Run it — FAIL** (`autoSchedule` does not pass `solve`; tsc and the run both complain).
- [ ] **Step 3: Pass the ports.** `schedule.ts:1925` and `:2487`: add `solve: placementSolver, log: schedulerLog` to the `buildSchedule({...})` object; `schedule-ai-solver.ts:348`: add the same two to the `repairDecomposedCpsat({...})` input. Import both from `@seazn/scheduler`.
- [ ] **Step 4: Repoint the 5 spying tests.** Replace `await import("@seazn/engine/scheduling/placement-client")` with `await import("@seazn/scheduler/placement-client")`, and `PlacementError` imports with `@seazn/scheduler`. In `schedule-auto-solver-busy-latency.test.ts`, keep the `vi.mock("@seazn/engine/scheduling")` (:62) as it is unless it stubbed the client — re-read it first. Titles unchanged.
- [ ] **Step 5: Client-bundle guard** (Review Focus 2). In `client-graph-no-server-barrel.test.ts`, add `@seazn/scheduler` (and `@seazn/scheduler/placement-client`) to the set of server-only specifiers no `"use client"` module graph may reach; follow the file's existing pattern for `@seazn/engine/scheduling`. Mutate once: add `import "@seazn/scheduler";` to any `"use client"` component, see it red, revert.
- [ ] **Step 6: The in-process seam test.** `packages/scheduler/src/seam.test.ts`: start a `@grpc/grpc-js` `Server` on `127.0.0.1:0` implementing `SolveBuild` from `src/generated/scheduler.ts` (answer `OPTIMAL`, placing each requested fixture index on court index 0 at the request's first grid slot); stub `PLACEMENT_SERVICE_HOST` to its port and the secret to match what the fake checks; call the REAL `buildSchedule` (from `@seazn/engine/scheduling`) with `solve: placementSolver, log: silentLogger` on one of the `EQUIVALENCE_SCENARIOS` inputs (import from the engine's `src/scheduling/__tests__/equivalence-scenarios.ts` via a relative path is NOT allowed across packages — copy the one input into the test). Assert `engine === "optimized"` and that the returned assignments match what the fake placed, mapped back through court/fixture ids. This drives producer and consumer for real.
- [ ] **Step 7: CI and Docker.**
  - `Dockerfile:13-16`: add `COPY packages/scheduler/package.json packages/scheduler/` beside the other workspace manifests; then grep `scripts/__tests__/dockerignore.test.ts` and `apps/web/src/__tests__/toolchain.test.ts` for the manifest list they pin and update them in the same commit.
  - `ci.yml`: add a `scheduler` job copied from the `packages/reference` job (~:283), running `cd packages/scheduler && ./node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile=vitest-results-scheduler.json` plus the repo's existing JSON judge step pattern, path filter `packages/scheduler/**`, `packages/engine/src/scheduling/**`, `proto/**`, `pnpm-lock.yaml`.
  - `placement-ci.yml`: paths `:36-37` → `packages/scheduler/**`; the proto drift step (:297-305) runs `pnpm --filter @seazn/scheduler gen:proto` and diffs `packages/scheduler/src/generated`; the integration step (:405) runs `packages/scheduler/src/placement-integration.test.ts` with the scheduler's vitest.
  - `placement-stg.yml:45-46`: the engine path triggers become `packages/scheduler/**`.
  - Grep `.github/workflows` and `tools/matrix/__tests__` for `scheduling/placement-client`, `scheduling/generated`, `gen-proto`, `packages/engine/scripts/gen-proto` and update every hit (some workflow tests pin these strings).
- [ ] **Step 8: Scoped gate.** Vitest (from `apps/web`): the new wiring test, the 5 repointed tests, `client-graph-no-server-barrel.test.ts`, every `schedule-*` test listed in the fact sheet that calls `buildSchedule` or `repairDecomposedCpsat`. Typecheck: `pnpm --filter @seazn/scheduler typecheck`, engine typecheck, `cd apps/web && pnpm typecheck`. All via JSON reports; paste counts.
- [ ] **Step 9: E2E — the real flow.** Bring up a local env with the placement service using the `seazn-local-env` skill (DB + prod build + placement container), then run **whole spec files**, never `-g` (class 21): `apps/web/e2e/auto-schedule.spec.ts` and `apps/web/e2e/placement-cutover.spec.ts` (the latter asserts the OPTIMISER is reached, not greedy — the strongest proof the adapter works). Record pass counts.
- [ ] **Step 10: Smoke.** `scripts/smoke.ts` against the same local prod server; confirm it covers an auto-schedule call (grep it); if it does not, add one call to `POST /api/v1/stages/:id/schedule/auto` asserting 200 and a non-empty board, in the smoke script's existing step style.
- [ ] **Step 11: Commit** — `git commit -m "feat(schedule): the app hands the engine its solver and logger; scheduler CI, image and placement workflows follow"`.

### Batch 1a close

- [ ] Orchestrator reruns the batch gate (Task 1a-4 Step 8 list + engine `src/scheduling` + `packages/scheduler`), confirms names and counts.
- [ ] Opus batch review (`reviewer`), written to `docs/superpowers/specs/engine-split/reviews/1a.md`, covering: the four TEST-STRATEGY questions; that no engine caller can omit `solve`/`log`; that `build.ts` no longer reads `process.env`; that the equivalence snapshot is byte-unchanged since its recording commit.
- [ ] Open PR `feat/engine-split-1a` → main with the parity counts and the ledger path. Owner merges.

---

# Batch 1b — publishable engine (spec §5.2, D14, D16, D18, D19, D25)

Worktree `engine-split-1b`, from `origin/main` after 1a merges.

### Task 1b-1: Rename behind a workspace alias

**Files:**
- Modify: `packages/engine/package.json` (`name`), every consumer manifest (`apps/web/package.json:24`, `tools/matrix/package.json:7`, `tools/bench/package.json:8`, root `package.json:76`, `packages/reference/package.json:14`, `packages/scheduler/package.json`), `apps/web/src/__tests__/toolchain.test.ts` (:359, :428, :453), `tools/matrix/__tests__/workspace-wiring.test.ts` (:138-139), `scripts/reference-boundary.ts` (:206), every `--filter @seazn/engine` in `.github/workflows/*.yml` and root `package.json` scripts, `pnpm-lock.yaml`
- Test: `packages/engine/test/package-identity.test.ts`

**Interfaces:**
- Produces: package name `@onryde/seazn-engine`; every consumer declares `"@seazn/engine": "workspace:@onryde/seazn-engine@*"` (pnpm 10.34.5 supports this alias, fact sheet R3). Import specifiers everywhere stay `@seazn/engine/...`.

- [ ] **Step 1: Failing test**

```ts
// packages/engine/test/package-identity.test.ts
// D19: published as @onryde/seazn-engine, consumed as @seazn/engine. Pins both halves so nobody "fixes" one.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url);
const manifest = (p: string) => JSON.parse(readFileSync(new URL(p, ROOT), "utf8"));
const CONSUMERS = ["apps/web/package.json", "tools/matrix/package.json", "tools/bench/package.json", "package.json", "packages/reference/package.json", "packages/scheduler/package.json"];

describe("engine package identity", () => {
  it("is published under the GitHub owner's scope", () => {
    expect(manifest("packages/engine/package.json").name).toBe("@onryde/seazn-engine");
  });

  it(`every one of ${CONSUMERS.length} consumers imports it as @seazn/engine through the alias`, () => {
    let checked = 0;
    for (const c of CONSUMERS) {
      const m = manifest(c);
      const spec = m.dependencies?.["@seazn/engine"] ?? m.devDependencies?.["@seazn/engine"];
      expect(spec, c).toBe("workspace:@onryde/seazn-engine@*");
      checked++;
    }
    expect(checked).toBe(CONSUMERS.length);
  });
});
```

(This test reads outside the package on purpose and will be rehomed at 2b; Batch 1d's ledger lists it.)

- [ ] **Step 2: FAIL.** Run it with the engine's vitest, JSON reporter.
- [ ] **Step 3: Rename.** Set `name`; set every consumer spec; `pnpm install`; update `--filter @seazn/engine` → `--filter @onryde/seazn-engine` (grep `.github`, `package.json`, `turbo.json`, `scripts/`); update the three pinned tests/scripts to the new name **where they pin the package name** and to the alias **where they pin the dependency spec** — read each assertion first (class 4).
- [ ] **Step 4: Verify resolution in every consumer type:** engine vitest (the new test), `apps/web` typecheck, `cd apps/web && ./node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/w.json src/__tests__/toolchain.test.ts`, tools/matrix `workspace-wiring.test.ts`, one strip-types root script: `node --experimental-strip-types scripts/sync-sports.ts --help` (or its dry-run flag — read the script) exits 0, and `pnpm turbo run typecheck --filter=./packages/engine...`.
- [ ] **Step 5: Mutate once:** set one consumer back to `workspace:*` → the identity test names that file. Revert.
- [ ] **Step 6: Commit** — `feat(engine): publish name @onryde/seazn-engine behind a workspace alias (D19)`.

### Task 1b-2: Compiled `dist/` and the publish manifest

**Files:**
- Create: `packages/engine/tsconfig.build.json`, `packages/engine/scripts/copy-assets.mjs`, `packages/engine/test/publish-manifest.test.ts`
- Modify: `packages/engine/package.json` (`build` script, `publishConfig`, `files`, drop `private`, `zod` peer-only, `repository`), `packages/engine/test/runtime-deps.test.ts` (read deps ∪ peerDeps), `.gitignore` (`packages/engine/dist/`), `turbo.json` (:25-31 comment + `build.outputs`)

**Interfaces:**
- Produces: `pnpm --filter @onryde/seazn-engine build` → `packages/engine/dist/**/*.{js,d.ts,js.map,d.ts.map}` plus copied `**/*.golden.json` and `rules/**`; `publishConfig.exports` mirroring `exports` into `dist/`.

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
    for (const k of keys) {
      const base = toDist(pkg.exports[k]);
      expect(pkg.publishConfig.exports[k], k).toEqual({ types: `${base}.d.ts`, default: `${base}.js` });
    }
    expect(Object.keys(pkg.publishConfig.exports).sort()).toEqual([...keys].sort());
  });

  it("ships dist plus the testkit's runtime assets, and nothing private", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.files).toEqual(["dist"]);
    expect(pkg.publishConfig.registry).toBe("https://npm.pkg.github.com");
  });

  it("takes zod as a peer only, so the app and the engine share one zod", () => {
    expect(pkg.peerDependencies.zod).toBeDefined();
    expect(pkg.dependencies?.zod).toBeUndefined();
    expect(pkg.devDependencies.zod).toBeDefined();
  });
});
```

(`./sports/*` maps `./src/sports/*/index.ts` → `./dist/sports/*/index` — the wildcard survives `toDist`.)

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Build config.**

```json
// packages/engine/tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rewriteRelativeImportExtensions": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/**/__tests__/**", "src/**/*.mutation.test.ts"]
}
```

```js
// packages/engine/scripts/copy-assets.mjs
// tsc emits only .ts; the testkit reads *.golden.json at runtime (testkit/golden.ts, conformance-pad.ts) and
// rules/*.md (testkit rules-reference after Batch 1d). Copy them beside the emitted JS, same relative paths.
import { cpSync, globSync, mkdirSync } from "node:fs";
import path from "node:path";
const pkg = path.resolve(import.meta.dirname, "..");
let n = 0;
for (const rel of globSync("src/**/*.golden.json", { cwd: pkg })) {
  const to = path.join(pkg, "dist", path.relative("src", rel));
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(path.join(pkg, rel), to);
  n++;
}
cpSync(path.join(pkg, "rules"), path.join(pkg, "dist", "rules"), { recursive: true });
if (n === 0) throw new Error("copy-assets: zero golden corpora copied — the testkit would break in dist");
console.log(`copy-assets: ${n} golden corpora + rules/`);
```

`package.json` script: `"build": "node ../../node_modules/typescript-native/bin/tsc -p tsconfig.build.json && node scripts/copy-assets.mjs"`. Then grep `src/testkit/` for how each runtime read resolves its file (`new URL(..., import.meta.url)` vs a path from the package root) and fix any that would point outside `dist/` when run from `dist/testkit/` — the relative layout under `dist/` mirrors `src/`, so `import.meta.url`-relative reads work unchanged; package-root-relative reads (`../../rules`) must become `import.meta.url`-relative. Fact sheet lists them: `golden.ts:24,94,1254`, `dossiers.ts:14,73,150`, `schema-snapshot.ts:19,292`, `conformance-pad.ts:16,70`.

- [ ] **Step 4: Manifest.** Add `publishConfig` (`registry`, `exports` per the test), `files: ["dist"]`, `repository: { "type": "git", "url": "https://github.com/onryde/seazn.club", "directory": "packages/engine" }`; delete `private`; move `zod` to peer + dev only; set `"sideEffects": false` — justified because after Batch 1a the only import-time effects left are module-local state (`build.ts:1155` `let queued`) and the empty registry singleton (`sport/registry.ts:91`, filled explicitly by `registerBuiltins`), neither of which a consumer relies on through a bare `import "…"`; grep `apps/web/src`, `tools/` and `scripts/` for bare side-effect imports of `@seazn/engine` (`import "@seazn/engine` with no binding) and if any exist, drop `sideEffects` and note why. `runtime-deps.test.ts`: declared set = `dependencies ∪ peerDependencies`. `.gitignore`: `packages/engine/dist/`. `turbo.json`: engine `build.outputs: ["dist/**"]`, and rewrite the :25-31 "ships raw TS" comment to "workspace consumers read src; the published tarball is dist (engine-split §5.2)".
- [ ] **Step 5: Build and inspect.** `pnpm --filter @onryde/seazn-engine build` exits 0; `ls packages/engine/dist/core/index.js packages/engine/dist/core/index.d.ts`; `grep -c "from \"\./" packages/engine/dist/core/index.js` shows `.js` specifiers, zero `.ts`. Run the manifest test → PASS.
- [ ] **Step 6: Mutate once:** delete one `publishConfig.exports` key → the mirror test names it. Revert.
- [ ] **Step 7: Commit** — `feat(engine): tsc emit to dist with a publish manifest (D14)`.

### Task 1b-3: Packed-tarball proof (`engine-pack`)

**Files:**
- Create: `packages/engine/pack-proof/run.mjs`, `packages/engine/pack-proof/node/strip.ts`, `packages/engine/pack-proof/next/{package.json,next.config.js,app/page.tsx,app/api/probe/route.ts,app/layout.tsx}`, `packages/engine/pack-proof/rn/{package.json,index.js,metro.config.js,babel.config.js}`, `packages/engine/pack-proof/types/{consumer.ts,tsconfig.bundler.json,tsconfig.nodenext.json}`
- Modify: `.github/workflows/ci.yml` (new `engine-pack` job), `packages/engine/package.json` (`"pack:proof": "node pack-proof/run.mjs"`)

**Interfaces:**
- Produces: `node packages/engine/pack-proof/run.mjs [--only node|next|rn|types]` — builds, `pnpm pack`s, and for each fixture copies it to a scratch dir **outside the workspace**, installs the tarball (as `"@seazn/engine": "file:<tarball>"` — an alias install, same shape as the registry alias) plus `zod`, runs the check, and prints `<fixture>: <N> modules/files checked`. Exit non-zero on any failure or on N = 0.

- [ ] **Step 1: The four fixtures.**
  - `node/strip.ts`: `import { builtinModules } from "@seazn/engine/sports"; console.log(\`node: \${builtinModules.length} sports loaded\`); if (builtinModules.length === 0) process.exit(1);` — run with `node --experimental-strip-types strip.ts` (the `sync-sports.ts` shape that runs in the stg/prod deploy, fact S1).
  - `next/`: a minimal Next app with `app/page.tsx` (server component) importing `@seazn/engine/core` and `@seazn/engine/sport` and rendering one value, and `app/api/probe/route.ts` importing `@seazn/engine/sports`. `next.config.js` has **no** `transpilePackages`. Check: `next build` exits 0; count = routes built.
  - `rn/`: `react-native@0.86.3` + `@react-native/metro-config` + `@react-native/babel-preset`; `index.js` imports every phone subpath (for now `core`, `sport`, `sports`; Batch 1c switches this to read `phone-subpaths.json`) and calls `foldMatch` over an empty event list for `badminton` with its schema-default config. Check: `npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output out.js`, then compile with `hermesc -emit-binary -out out.hbc out.js`, where `hermesc` is `node_modules/react-native/sdks/hermesc/<linux64-bin|osx-bin>/hermesc` if present, else the binary found by `find node_modules -type f -name hermesc` (RN 0.86 may ship it in a separate compiler package) — `run.mjs` resolves it and fails loudly if none is found. Count = modules in the bundle (`grep -c "__d(function" out.js`). Hermes accepting the bytecode is the proof that no syntax Hermes lacks ships (fact: zod probes `new Function` — if bundling or hermesc fails on it, stop and report; that is capture's R4 concern surfacing early).
  - `types/consumer.ts`: imports types and values from `core`, `sport`, `scheduling`, `testkit`, assigns one to a deliberately wrong type under a `// @ts-expect-error` to prove types are real (not `any`). Two tsconfigs: `moduleResolution: "bundler"` and `"nodenext"`. Check: `tsc -p` both exit 0. (The scout found `.d.ts` keeps `./x.ts` specifiers; this step is where that would bite.)
- [ ] **Step 2: `run.mjs`** orchestrates the above with `node:child_process` `execFileSync`, `mkdtempSync(os.tmpdir())` scratch dirs, and prints counts. It must refuse to run from inside the workspace scratch (assert the scratch path is not under the repo root).
- [ ] **Step 3: Run each locally:** `node packages/engine/pack-proof/run.mjs --only node`, then `types`, `next`, `rn` (rn needs the Android toolchain only for `hermesc`, which ships inside `react-native` — no SDK). Record the four counts.
- [ ] **Step 4: Mutate once:** add `import "node:fs";` to `src/core/index.ts`, rebuild, run `--only rn` → Metro fails resolving `node:fs`. Revert. (Batch 1c adds the static half of this guard.)
- [ ] **Step 5: CI job** `engine-pack` in `ci.yml` on `ubuntu-latest`, Node 26, path filter `packages/engine/**`, `pnpm-lock.yaml`; runs `pnpm install --frozen-lockfile`, then `node packages/engine/pack-proof/run.mjs`; uses the linux `hermesc`. Cache the scratch installs' pnpm store with the repo's existing cache step pattern.
- [ ] **Step 6: Commit** — `ci(engine): prove the packed tarball in Node strip-types, Next, Metro+Hermes and tsc (D14)`.

### Task 1b-4: Canary publishing

**Files:**
- Create: `.github/workflows/engine-canary.yml`, `packages/engine/test/canary-workflow.test.ts`

- [ ] **Step 1: Failing workflow test** — parses `.github/workflows/engine-canary.yml` (use the `yaml` package already in the repo — grep `from "yaml"` to confirm) and asserts: triggers only `push` to `main` with paths `packages/engine/**`; `permissions` = `{ contents: read, packages: write }`; a step runs `pack-proof/run.mjs` before the publish step; the version step produces `0.0.0-canary.${{ github.sha }}`-shaped versions (`0.0.0-canary.` prefix + sha); publish uses `--tag canary`; no step echoes `NODE_AUTH_TOKEN` (grep the run blocks for `echo` + `TOKEN`).
- [ ] **Step 2: The workflow.**

```yaml
# .github/workflows/engine-canary.yml
# Phase 1 canaries of @onryde/seazn-engine from the monorepo (engine-split spec §5.2, D16).
# No stable releases from here; the first stable 1.0.0 is cut by Changesets in the engine repo at 2b.
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

(Copy the exact `pnpm/action-setup` / `setup-node` versions and options from `ci.yml`'s first job, not the ones above, if they differ.)
- [ ] **Step 3: PASS** the workflow test. **Mutate once:** change `--tag canary` to `--tag latest` → red. Revert.
- [ ] **Step 4: Owner note in the PR body:** merging this PR publishes the first canary to GitHub Packages under `onryde` (outward-facing). After it runs, the owner checks the package page: visibility public, linked to `onryde/seazn.club`, and grants `onryde/seazn.club.capture` read access if capture's R4 spike will install it.
- [ ] **Step 5: Commit** — `ci(engine): publish 0.0.0-canary.<sha> to GitHub Packages on engine changes (D16)`.

### Batch 1b close

- [ ] Gate: engine `test/package-identity`, `test/publish-manifest`, `test/runtime-deps`, `test/canary-workflow`; apps/web `toolchain.test.ts`; tools/matrix `workspace-wiring.test.ts`; `pack:proof` all four; typecheck engine + web + scheduler. JSON counts.
- [ ] Parity: `vitest list --json` of the engine package before/after this batch — the only after-only ids are the new test files' (ledger `1b.json`, fate `"added"`, reason "new guard, Batch 1b").
- [ ] Opus batch review → `reviews/1b.md`. Open PR; owner merges.

---

# Batch 1d — rehome the monorepo-reading tests (spec §5.4, D23)

Worktree `engine-split-1d`, after 1b merges. Rule for every task: **a test that reads anything outside `packages/engine` either becomes layout-agnostic (works with the engine at the repo root OR at `packages/engine`) or moves out; a test that reads only `packages/engine` stays.** Every moved test keeps its title. Every task appends to `docs/superpowers/specs/engine-split/ledgers/1d.json`.

Shared helper used by Tasks 1d-1 and 1d-5:

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

### Task 1d-1: Stryker tests and `stryker-changed.mjs`, layout-agnostic

**Files:** `packages/engine/test/layout.ts` (create), `test/stryker-outputs-ignored.test.ts` (:12-13, :32, :40-54), `test/stryker-sizing.test.ts` (:884-961), `test/stryker-changed-lines.test.ts` (:142, :162, :325-330), `scripts/stryker-changed.mjs` (:67), `test/stryker-matrix.test.ts` (:18, :30), `.github/workflows/mutation.yml` (:182, :231, :366), `tools/matrix/__tests__/matrix-workflow.test.ts`

- [ ] **Step 1:** `stryker-changed.mjs:67`: build the diff matcher from the prefix — `new RegExp(\`^\\+\\+\\+ b/\${escape(prefix)}(src/.+)$\`)` where `prefix` comes from `git rev-parse --show-prefix` run in the engine dir (export an `enginePrefix()` helper from the script). Add no new tests in this task (parity): parametrise the existing synthetic-diff tests (:142, :162) over `ENGINE_PREFIX` so they pass in both layouts with the same titles.
- [ ] **Step 2:** `stryker-outputs-ignored.test.ts`: `REPO` = `GIT_TOPLEVEL`; workflow path `path.join(GIT_TOPLEVEL, ".github/workflows/mutation.yml")`; the `packages/engine/...` literals become `${ENGINE_PREFIX}...`. Same titles.
- [ ] **Step 3:** `stryker-matrix.test.ts:18,30`: spawn cwd `GIT_TOPLEVEL`; any `packages/engine/` literal → `ENGINE_PREFIX`.
- [ ] **Step 4:** Runner variable (D20.6, spec §11.6): `mutation.yml` `vars.MATRIX_RUNNER` → `vars.STRYKER_RUNNER` at :182, :231, :366 (both unset ⇒ `ubuntu-latest`, so no behaviour change today). The weekly gate stays on `MATRIX_WEEKLY_ENABLED` until 2b (changing it now would silently stop the weekly run until the owner sets a new variable).
- [ ] **Step 5:** `stryker-sizing.test.ts:922` ("the fan-out figures the workflow and its test quote…"): it asserts that BOTH `mutation.yml` and `tools/matrix/__tests__/matrix-workflow.test.ts` quote Stryker leg/hour figures — a cross-quote that existed because the two workflows shared `MATRIX_RUNNER`. With Step 4 they no longer share it. Rewrite the test to assert the figures in `mutation.yml` only (same title is now false — retitle to "the fan-out figures the workflow quotes match stryker-measured.json"; ledger `rewritten`, reason "runner no longer shared, D20.6"). Delete the Stryker-figure assertions from `matrix-workflow.test.ts` (read it first; ledger every removed/retitled id there too). The NOTES list (:884) drops the matrix-workflow path. `:952` reads `mutation.yml` via `GIT_TOPLEVEL`.
- [ ] **Step 6:** Run the five engine files + `matrix-workflow.test.ts`, JSON. Then **prove layout-agnosticism** with a simulated engine repo: `rsync -a --exclude node_modules --exclude dist packages/engine/ /tmp/engine-alone/`, `mkdir -p /tmp/engine-alone/.github/workflows && cp .github/workflows/mutation.yml /tmp/engine-alone/.github/workflows/`, `cd /tmp/engine-alone && git init -q && git add -A && git commit -qm sim && pnpm install`, then run the same five files there. The same ids must pass; a test that legitimately needs `HEAD^1` history must SKIP with a named reason, never fail.
- [ ] **Step 7: Mutate once:** hardcode `ENGINE_PREFIX = "packages/engine/"` → the `/tmp/engine-alone` run goes red. Revert.
- [ ] **Step 8: Commit** — `test(engine): stryker tests find the workflow and paths from the checkout, not the monorepo layout`.

### Task 1d-2: `engine-boundary` moves into the engine

**Files:** `git mv scripts/engine-boundary.ts packages/engine/scripts/engine-boundary.ts`; copy `scripts/lib/main-module.ts` → `packages/engine/scripts/lib/main-module.ts` (the root copy stays — other root scripts use it); `packages/engine/test/boundary-gate.test.ts:7`; root `package.json:54` (`engine:boundary` → `node --experimental-strip-types packages/engine/scripts/engine-boundary.ts`); `scripts/__tests__/main-module.test.ts:59-65`; engine `package.json` (`"boundary": "node --experimental-strip-types scripts/engine-boundary.ts"`).

- [ ] **Step 1:** Move; fix the CLI's scan dir (:88-89) to `new URL("../src", import.meta.url)`; fix `boundary-gate.test.ts:7` to `../scripts/engine-boundary.ts`.
- [ ] **Step 2:** `main-module.test.ts:59-65` spawns `engine-boundary` through a symlink to test main-module detection — point it at the new path.
- [ ] **Step 3:** Run `boundary-gate.test.ts` (14 cases), `scripts/__tests__/main-module.test.ts`, and `pnpm engine:boundary` (ci.yml:105's command) → exit 0. Ids unchanged (same file, same titles).
- [ ] **Step 4:** `packages/engine/eslint.config.mjs:19` imports `scripts/lib/tools-import-guard.mjs` — leave it until 2b (lint is not in the parity count; the 2b plan drops the rule, since the engine repo has no `tools/`). Note it in the ledger file's `notes`.
- [ ] **Step 5: Commit** — `refactor(engine): engine-boundary lives with the engine`.

### Task 1d-3: `window-single-source` — app halves move to the app

**Files:** `packages/engine/src/scheduling/window-single-source.test.ts` (tests at :34 and :52 move), create `apps/web/src/server/usecases/__tests__/court-window-single-source.test.ts`.

- [ ] Move the two app-reading tests verbatim (same `describe`/`it` titles), re-rooting their paths to `apps/web/src` from the new file's location. The four engine-local tests (:90, :98, :108, :115) stay. Run both files; ledger two `rehomed` entries. Mutate once: rename `usableWindows` in the moved test's expected token → red. Commit `test: the app's single-source window checks live with the app`.

### Task 1d-4: `z3-dependency-retired` — repo-wide scans move to root

**Files:** `packages/engine/src/scheduling/z3-dependency-retired.test.ts`, create `scripts/__tests__/z3-dependency-retired.test.ts`.

- [ ] The eight repo-wide tests (:84, :100, :107, :116, :122, :126, :130, :136) and the `LIVE_TREES`/`REPO_ROOT` setup (:29, :41-51, the collect-time `readdirSync(tools)` at :98) move to the root file, same titles. The engine file keeps :151 only, plus whatever setup it needs. Run both (root file with the engine's vitest, as `ci.yml:811` does today). Ledger eight `rehomed`. Commit.

### Task 1d-5: `rules-reference` — split by where the proof lives

**Files:** `packages/engine/test/rules-reference.ts` (helper; `REPO` at :10), `packages/engine/test/rules-reference.test.ts`, create `packages/engine/src/testkit/rules-reference.ts` (the parser and table types, exported via `@seazn/engine/testkit`), create `scripts/__tests__/rules-reference.test.ts`, modify `.github/workflows/ci.yml:304-311`.

- [ ] **Step 1:** Move the pure parts of `test/rules-reference.ts` (reading `rules/*.md`, parsing rows, `proved-by`/`enforced-at` extraction) into `src/testkit/rules-reference.ts`, reading `rules/` via `new URL("../../rules/", import.meta.url)` from `src/testkit/` (and `dist/testkit/` → `dist/rules/` after Batch 1b's copy — the relative layout is the same; verify by running the pack-proof `types` fixture importing it). Export from the testkit barrel. The repo-reading helpers (`fileExists`, `readRepoFile`, `proofProblems` with `REPO`) stay test-side.
- [ ] **Step 2:** In `rules-reference.test.ts`, classify each of the 33 tests with the scout table (fact sheet): engine-local (22) stay; `:319`, `:512` split — the engine half checks proof/enforced-at paths under `ENGINE_PREFIX` (same title, now scoped — retitle with suffix " (engine paths)", ledger `split`), the root half (new file, title suffix " (app, tools and reference paths)") checks the rest by importing the parser from `@seazn/engine/testkit`; `:341` (repo layout), `:520`, `:556`, `:574` (read `docs/…w2b-design.md`), and the `:652` describe (reads `ci.yml`; :667, :674, :685, :745, :761) move to the root file whole.
- [ ] **Step 3:** `ci.yml:304-311`: the gates step runs BOTH files; its JSON judge checks both result names appear. The moved `:685` test asserts that exact run line — update its expected string to the new line in the same commit, then mutate once (drop the root file from the step) → `:685` red. Revert.
- [ ] **Step 4:** Run both files, JSON, confirm names; ledger every moved/split id. Commit `test(rules): proofs outside the engine are checked outside the engine`.

### Task 1d-6: Ledger completeness and the layout run

- [ ] `vitest list --json` the engine package at the batch base and at the batch head (collection only — no full-suite run), plus the new/changed root and app files. `node scripts/test-parity.mjs --before … --after … --ledger docs/superpowers/specs/engine-split/ledgers/1d.json` → `unaccounted 0`. Then, inside `/tmp/engine-alone` (Task 1d-1 Step 6 recipe, refreshed), `vitest list --json` must collect every file (a collect-time read of a monorepo path fails collection — the four files the scout found did exactly that), and run only the files this batch touched: **zero failures that name a monorepo path**; anything that still needs the monorepo is a missed rehome — fix it here. Include Batch 1b's `package-identity.test.ts` in the ledger as `rehomed at 2b` (it stays for now; 2b moves it).
- [ ] Commit the ledger.

### Batch 1d close

- [ ] Gate = every file touched in 1d-1…1d-5, JSON counts; the `/tmp/engine-alone` run; `pnpm engine:boundary`.
- [ ] Opus batch review → `reviews/1d.md`, checking every ledger reason against the actual diff (a "rehomed" test must assert the same thing it did). Open PR; owner merges.

---

# Batch 1c — RN-safe gate (spec §5.3, D25)

Worktree `engine-split-1c`, after 1d merges (it edits the moved `packages/engine/scripts/engine-boundary.ts`).

### Task 1c-1: `phone-subpaths.json` and the static rule

**Files:** create `packages/engine/phone-subpaths.json`; modify `packages/engine/scripts/engine-boundary.ts`, `packages/engine/test/boundary-gate.test.ts`, `packages/engine/pack-proof/rn/index.js` + `run.mjs`.

**Interfaces:**
- Produces: `phone-subpaths.json` = `{ "subpaths": ["./core", "./sport", "./sports", "./sports/*"] }` (the one authority, D25; capture imports only these). `checkPhoneSafety(engineDir): { walked: number; violations: Violation[] }` exported from `engine-boundary.ts`.

- [ ] **Step 1: Failing tests** in `boundary-gate.test.ts` (new tests are allowed here — this batch adds a guard; ledger them as new in `1c.json`):

```ts
describe("phone-safe subpaths", () => {
  it("walks the real phone closure and finds it clean (never an empty walk)", () => {
    const r = checkPhoneSafety(ENGINE_DIR);
    expect(r.walked).toBeGreaterThanOrEqual(40); // the 2026-10-13 scan found a 46-file closure
    expect(r.violations).toEqual([]);
  });

  it.each([
    ["a node: builtin", 'import { readFileSync } from "node:fs";'],
    ["a bare builtin", 'import path from "path";'],
    ["process", "export const lvl = process.env.LOG_LEVEL;"],
    ["scheduling", 'import { buildSchedule } from "../scheduling/build.ts";'],
  ])("refuses %s reached from a phone subpath", (_label, line) => {
    const dir = seedEngine({ "src/core/index.ts": `export * from "./leak.ts";`, "src/core/leak.ts": line, "src/scheduling/build.ts": "export const buildSchedule = 1;" });
    expect(checkPhoneSafety(dir).violations.length).toBe(1);
  });

  it("does not flag the same code outside the phone closure", () => {
    const dir = seedEngine({ "src/core/index.ts": "export const a = 1;", "src/history/x.ts": 'import "node:fs";' });
    expect(checkPhoneSafety(dir).violations).toEqual([]);
  });
});
```

`seedEngine(files)` writes a tmpdir with `package.json` (exports for the four phone subpaths), `phone-subpaths.json`, and the files — reuse the file's existing tmpdir seeding helper pattern (:42-46 seed tmpdirs already).

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** `checkPhoneSafety`: resolve each phone subpath through `package.json` `exports` (expand `./sports/*` by listing `src/sports/*/index.ts`); BFS over relative imports (`from "./…"`, `import("./…")`, `export … from "./…"`), resolving `.ts`; for each module, strip comments, then flag: specifier starting `node:` or equal to a Node builtin (`import { builtinModules } from "node:module"` gives the list), `\bprocess\.` in code, any resolved path under `src/scheduling/`. Return `walked` = modules visited. Wire into the CLI so `pnpm engine:boundary` runs both checks and prints `phone-safe: N modules walked`.
- [ ] **Step 4:** `pack-proof/rn/index.js` is generated by `run.mjs` from `phone-subpaths.json` (one `import * as m<i> from "@seazn/engine/<sub>"` per subpath; `./sports/*` expands to every sport dir) — one authority for both halves.
- [ ] **Step 5:** Run `boundary-gate.test.ts`, `pnpm engine:boundary`, `pack:proof --only rn`. **Mutate once each:** add `import "node:fs"` to `src/core/clock.ts` → both the static rule and the rn proof go red; remove `"./sport"` from `phone-subpaths.json` → the walked count drops (the `>= 40` guard holds the floor). Revert.
- [ ] **Step 6: Commit** — `feat(engine): phone subpaths are Node-free by CI, not by convention (D25)`.

### Batch 1c close

- [ ] Gate, Opus review → `reviews/1c.md`, PR. Owner merges. **After merge, send capture (mobile-s1) the subpath list and the first canary version** — as a recommendation to put to their owner, not a ruling (AGENTS.md class 17).

---

# Batch 1e — fold epochs over the existing golden corpora (spec §5.5, D15, D26)

Worktree `engine-split-1e`. **Premise correction (record in the PR):** spec §5.5 planned new golden ledgers; they already exist — `packages/engine/src/sports/<dir>/<key>.golden.json` for all 11 sports, replayed by `src/testkit/golden.test.ts:387`, rebaselined via `REBASELINE_GOLDEN`. This batch adds the epoch and the guard on top of them; no new corpora. Known limit (recorded, not fixed): the corpora pin `module.outcome`/`module.summary` (`golden.ts:208/:221`), not the kernel's `outcomeOf`/`summaryOf` overlays (settlement, expunge, withdrawal).

### Task 1e-1: `FOLD_EPOCH`

**Files:** create `packages/engine/src/sport/fold-epoch.ts`, `packages/engine/src/sport/fold-epoch.test.ts`; modify `packages/engine/src/sport/index.ts` (export).

```ts
// packages/engine/src/sport/fold-epoch.ts
// Per-sport fold epoch (engine-split D26). Bump a sport's number in the SAME change that makes an existing
// event sequence fold to a different result for that sport; the fold-epoch guard (scripts/fold-epoch-guard.ts)
// enforces it against HEAD^1. Phones send {sport, epoch}; the server refuses a lower epoch for that sport.
export const FOLD_EPOCH = {
  football: 1,
  cricket: 1,
  boardgame: 1,
  carrom: 1,
  generic: 1,
  volleyball: 1,
  badminton: 1,
  tabletennis: 1,
  tennis: 1,
  icehockey: 1,
  hockey: 1,
} as const satisfies Readonly<Record<string, number>>;
export type FoldEpochSport = keyof typeof FOLD_EPOCH;
export function foldEpochOf(sport: string): number {
  const e = (FOLD_EPOCH as Readonly<Record<string, number>>)[sport];
  if (e === undefined) throw new Error(`no FOLD_EPOCH for sport "${sport}" — every registered sport must have one`);
  return e;
}
```

- [ ] **Test first:**

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

The test derives the sport list from the registry, never a typed table (TEST-STRATEGY rule 3). Mutate once: delete `hockey` → red. Commit `feat(engine): per-sport FOLD_EPOCH (D26)`.

### Task 1e-2: The epoch guard against `HEAD^1`

**Files:** create `packages/engine/scripts/fold-epoch-guard.ts`, `packages/engine/test/fold-epoch-guard.test.ts`; modify `packages/engine/package.json` (`"fold-epoch:check": "node --experimental-strip-types scripts/fold-epoch-guard.ts"`), `.github/workflows/ci.yml` (gates job, beside `:126`).

**Interfaces:**
- Produces: `epochViolations(before: { epochs: Record<string, number>; corpora: Record<string, GoldenCorpus> } | null, after: same): { sport: string; changedStreams: number; before: number; after: number }[]` — pure; and the CLI `fold-epoch:check --against <ref>` (exit 0 clean / 1 violations / 2 refusal).

- [ ] **Step 1: Failing tests** (Review Focus 4 — the three cases plus empty and missing baseline):

```ts
// packages/engine/test/fold-epoch-guard.test.ts
import { describe, expect, it } from "vitest";
import { epochViolations } from "../scripts/fold-epoch-guard.ts";

const stream = (seed: number, outcome: string) => ({ config: { variant: "x" }, seed, events: [], states: [], outcome, summary: "{}", deltas: "[]" });
const corpus = (streams: ReturnType<typeof stream>[]) => ({ key: "badminton", version: 1, configs: [], streams });
const side = (epoch: number, streams: ReturnType<typeof stream>[]) => ({ epochs: { badminton: epoch }, corpora: { badminton: corpus(streams) } });

describe("fold-epoch guard", () => {
  it("demands a bump when an existing stream's result changes", () => {
    expect(epochViolations(side(1, [stream(1, "A")]), side(1, [stream(1, "B")]))).toEqual([{ sport: "badminton", changedStreams: 1, before: 1, after: 1 }]);
  });
  it("is satisfied by the bump", () => {
    expect(epochViolations(side(1, [stream(1, "A")]), side(2, [stream(1, "B")]))).toEqual([]);
  });
  it("does not demand a bump for an added stream (EXTEND_GOLDEN)", () => {
    expect(epochViolations(side(1, [stream(1, "A")]), side(1, [stream(1, "A"), stream(2, "C")]))).toEqual([]);
  });
  it("does not demand a bump when streams are only reordered", () => {
    expect(epochViolations(side(1, [stream(1, "A"), stream(2, "C")]), side(1, [stream(2, "C"), stream(1, "A")]))).toEqual([]);
  });
  it("treats a missing baseline as nothing to compare, not as a pass by crash", () => {
    expect(epochViolations(null, side(1, [stream(1, "A")]))).toEqual([]);
  });
  it("refuses an epoch that went DOWN", () => {
    expect(epochViolations(side(2, [stream(1, "A")]), side(1, [stream(1, "A")]))).toEqual([{ sport: "badminton", changedStreams: 0, before: 2, after: 1 }]);
  });
});
```

- [ ] **Step 2: Implement.** Streams match on `JSON.stringify(config) + "#" + seed`; a matched stream "changed" if `outcome` or `summary` differs. Violation if `changed > 0 && after <= before`, or `after < before`. CLI: read HEAD corpora with `readCorpus` for every key in `builtinModules`; read the ref side with `git rev-parse --verify --quiet <ref>^{commit}` (missing ⇒ refusal exit 2, like `stryker-floor.ts:549`), then `git show <ref>:<ENGINE_PREFIX>src/sports/<dir>/<key>.golden.json` per sport (missing file at ref ⇒ that sport has no baseline), and the ref's `fold-epoch.ts` via `git show` written to a temp `.ts` file and `import()`ed under strip-types (missing ⇒ `null` baseline: first introduction). Print `fold-epoch: N sports checked, M streams compared`; N = 0 ⇒ exit 2.
- [ ] **Step 3: CI:** in the gates job after `:126`, `pnpm --filter @onryde/seazn-engine fold-epoch:check --against HEAD^1` (that job already fetches full history, `:68`).
- [ ] **Step 4: Real-corpus mutation (once):** edit one stream's `outcome` string in `src/sports/setbased/badminton.golden.json` (or wherever `SPORT_DIRS` puts it), commit on a scratch branch, run `fold-epoch:check --against HEAD^1` → exit 1 naming `badminton` and only `badminton`; then bump `FOLD_EPOCH.badminton` → exit 0. Discard the scratch branch.
- [ ] **Step 5: Commit** — `feat(engine): a changed golden result must bump that sport's FOLD_EPOCH (D15, D26)`.

### Batch 1e close

- [ ] Gate (two new test files + `golden.test.ts` unchanged + `fold-epoch:check --against HEAD^1` on the branch), Opus review → `reviews/1e.md`, PR. Owner merges.

---

# Batch 1f — server minimum-epoch gate (spec §5.6, D15, D26)

Worktree `engine-split-1f`. **Premise correction (record in the PR and in the spec ledger as D31 for the owner):** the server cannot tell a capture phone from the web pad — both authenticate with the same `dl_` device link (`auth.ts:245-278`), `device_links` has no source column (`V222__device_links.sql:6-15`), and capture-minted links are also shown as QR codes for browsers to open. So D29's "a capture request without an epoch is refused `engine_epoch_missing`" would break the web pad on capture-minted links. This batch builds the optional field and the refusal; capture S2 sends the field on every write from its first release, so no capture build exists that omits it. Error code follows the API's UPPER_SNAKE convention: `ENGINE_OUTDATED` (spec text said `engine_outdated`).

### Task 1f-1: `engine_epoch` on `AppendEventRequest`, refused below the server's epoch

**Files:** modify `apps/web/src/server/api-v1/schemas.ts:1839-1844`, `apps/web/src/server/usecases/scoring.ts` (:143 `scoreEvent`, before `appendEvent` at :197), `openapi/v1.json` (+ `openapi/v1.public.json`) via `npm run openapi:gen`; create `apps/web/src/server/usecases/__tests__/scoring-engine-epoch.test.ts`, `apps/web/e2e/score-engine-epoch.spec.ts`.

**Interfaces:**
- Consumes: `foldEpochOf` from `@seazn/engine/sport` (Batch 1e).
- Produces: request field `engine_epoch?: number` (int ≥ 1); refusal `HttpError(426, "This app's scoring rules for <sport> are out of date — update the app to keep scoring", "ENGINE_OUTDATED", { sport, required, got })` → body `{ ok:false, error:{ code:"ENGINE_OUTDATED", message, sport, required, got }, requestId }`.

- [ ] **Step 1: Failing usecase tests** — build on the fixture arrangement of the nearest existing `scoreEvent` usecase test (grep `__tests__` for `scoreEvent(`; copy its setup). Cases:
  1. `engine_epoch` absent → 201, event written (web pad path unchanged).
  2. equal to `foldEpochOf(sport)` → 201.
  3. higher → 201 (a newer app against an older server must not be locked out — the server's own fold is authoritative).
  4. lower → `HttpError` 426 `ENGINE_OUTDATED` with `{ sport, required: foldEpochOf(sport), got }`, and **no row written** (read `score_events` count before/after).
  5. **Sequence (Review Focus 5):** lower with `idempotency_key: K` → 426; then the same `K` with a current epoch → 201 and exactly one row. The refusal must not burn the key.
  6. **Second call:** two lower calls in a row → two 426s, zero rows.
  7. **Another sport:** case 4 swept with `forEachSportAsync` over every builtin sport that can be scored through the fixture setup (expected values from `foldEpochOf(m.key)`, never typed); the sweep asserts its count > 0.
  `required` is derived from `foldEpochOf`, so when an epoch is bumped the test moves with it (TEST-STRATEGY rule 3). Every epoch is 1 today and the schema's minimum is 1, so no real request can be "lower" yet: the "lower" cases mock `@seazn/engine/sport`'s `foldEpochOf` (partial `vi.mock` with `importOriginal`) to return `real + 1`, and send `engine_epoch: real`. Say so in a comment in the test.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.** Schema: `engine_epoch: z.number().int().min(1).optional()` with a `.describe("Fold epoch of the client's engine for this fixture's sport (engine-split D26). Native clients send it; the web pad does not.")`. In `scoreEvent`, after the fixture's sport/module key is known and **before** any write or idempotency bookkeeping: `if (input.engine_epoch !== undefined && input.engine_epoch < foldEpochOf(key)) throw new HttpError(426, …, "ENGINE_OUTDATED", { sport: key, required, got: input.engine_epoch });`. Confirm by reading `scoring.ts:103` (the 23505 idempotency path) that the key is only recorded by the insert — so throwing before `appendEvent` cannot burn it; case 5 proves it.
- [ ] **Step 4:** `npm run openapi:gen` and commit the regenerated specs (the OpenAPI drift gate at `ci.yml:130` checks this).
- [ ] **Step 5: E2E** `apps/web/e2e/score-engine-epoch.spec.ts` (API-level Playwright with the `request` fixture, reusing the auth and fixture setup of an existing scoring API spec — grep `apps/web/e2e/` for `/events`). A prod build cannot be made to hold a higher epoch, so the e2e covers what a real client can reach: (a) `engine_epoch` equal to the current `foldEpochOf(sport)` → 201, and the public match page shows the point; (b) `engine_epoch: 0` → 400 schema refusal, and the event count is unchanged. The 426 branch is covered by the usecase sweep (Step 1). Run the whole spec file against a local prod build (`seazn-local-env`).
- [ ] **Step 6: Smoke:** if `scripts/smoke.ts` posts a score event, add `engine_epoch` equal to the current epoch to one of its posts and assert 201.
- [ ] **Step 7: Mutate once:** change `<` to `<=` → case 2 goes red; delete the check → case 4 goes red. Revert each.
- [ ] **Step 8: Commit** — `feat(scoring): refuse writes from an engine whose fold epoch for the sport is behind (D15, D26)`.

### Task 1f-2: Record the deviation and hand capture its contract inputs

- [ ] Append to the spec ledger: `D31 | engine_epoch is optional; no engine_epoch_missing refusal (server cannot distinguish capture from web pad; facts: auth.ts:245-278, V222, capture QR use). Code ENGINE_OUTDATED per API convention. | REC → owner | Batch 1f`. Do not mark it OWNER.
- [ ] Capture has no scoring-events contract in `docs/contracts/` today (only qr/descriptor/beat/start/scoring-link/record). Creating one is S2's work; write the inputs S2 needs (request field, refusal body, status) into `docs/superpowers/specs/engine-split/capture-s2-handoff.md` and send its path to mobile-s1 as a recommendation to their owner.
- [ ] Commit.

### Batch 1f close

- [ ] Gate: the usecase test file, route/schema tests touching `AppendEventRequest` (grep), OpenAPI drift locally (`npm run openapi:gen && git diff --exit-code openapi/`), the e2e spec file, smoke. Opus review → `reviews/1f.md` with the four questions answered for the write path. PR; owner merges.

---

## After Phase 1

- Phase 2a plan (`docs/superpowers/plans/<date>-engine-split-phase2a.md`) is written after Batch 1a merges, against the tree as it is then.
- Phase 2b plan is written at W2e close, re-pinned against that tree.
- Update `project_engine_split_sequencing` memory and the spec status line after each batch merges.
