# B06a — Bench Suite Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it possible to add a second bench suite — a registry instead of an `if`, a shared pack-driven runner instead of a 3,900-line `_tiny` function, the two comparators the schema declares but nothing reads, a provenance writer, and the people-layer steps the playbook already claims exist.

**Architecture:** A lookup-table registry (`SUITE_REGISTRY`) maps a suite key to a `SuiteDefinition`; a single `runPackSuite` executes the fixed phase pipeline (seed → schedule → check → certificate → start → fold → advance → oracles → people → report) and calls suite-specific extras through optional probe hooks. `_tiny` becomes the first definition rather than the only code path. Phase LOGIC already lives in `lib/seed.ts`, `lib/schedule.ts`, `lib/checker.ts`, `lib/certificate.ts`, `lib/simulate.ts`, `lib/import.ts`, `lib/advance.ts`, `lib/oracle.ts` — this wave moves ORCHESTRATION, not algorithms.

**Tech Stack:** Node 26 with `--experimental-strip-types`, TypeScript 7 (`typescript-native`), zod 4, pino, vitest (run through `packages/engine`'s binary).

**Spec:** `docs/superpowers/specs/bench-product-value/designs/2026-09-09-b06-pack-pilot-design.md` (owner-approved 2026-09-09, decisions D1–D8). Programme rules: `docs/superpowers/specs/bench-product-value/bench-prompts/_RULES.md`.

## Global Constraints

- **Node 26 / TS7, no TypeScript `enum`** — the bench runs under `node --experimental-strip-types`, which crashes on a TS enum (a live B01 defect). Use `as const` objects or string unions.
- **Test command is not `npm test`.** The apps/web suite and `turbo run typecheck lint` never touch `scripts/bench`. Use exactly, from the worktree root:
  `./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/b06a-<task>.json --testTimeout=30000 scripts/bench`
  and read `numPassedTests`/`numTotalTests`/`numFailedTestSuites` out of the JSON. An rtk vitest summary prints `PASS(0) FAIL(0)` for a suite that failed to COLLECT and swallows the exit code — never judge from it.
- **`npm run typecheck:scripts` must print 0 errors** and **`npm run lint:scripts` must be clean** (`rtk` hides lint output; run it through `rtk proxy` and read `✖ N problems`).
- **Every change ships a test that fails without it.**
- **A comparator that compared nothing is NOT a pass.** `OracleResult` (`scripts/bench/lib/report.ts:115-165`) carries `verdict` and `subject`; `no_subject` is a third verdict, counted separately, never reading as PASS and never reddening the run. Set `subject` from the comparator's own count, never derived from the verdict.
- **Every oracle emits `oracle_checked`** through `oracleLogFields` (`lib/report.ts:166` import in `tiny.ts`) — B05 shipped two that did not.
- **Timings are recorded, never asserted** (`_RULES.md` §1, load-sensitive-timing rule).
- **No new GitHub issues.** Defect inside this file set → fix inline with a failing-first test and record it under `Unplanned fixes` in the PR body; outside it → stop and escalate.
- **No app-facing strings are added**, so no locale work is owed (`_RULES.md` §1, bench is a dev tool).
- **Do not dispatch a subagent to run a live bench loop** — the 600s tool watchdog kills it. The orchestrating session runs Task 9.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `scripts/bench/lib/suites/registry.ts` | The lookup table: `SuiteKey` → `SuiteDefinition`. Sole source of the CLI's known-suite list. |
| `scripts/bench/lib/suites/types.ts` | `SuiteDefinition`, `SuiteProbe`, `SuiteProbeContext`, `PackSuiteInput` — the contracts the registry and runner share. |
| `scripts/bench/lib/suites/run-suite.ts` | `runPackSuite` — the phase pipeline, accumulators, report assembly. |
| `scripts/bench/lib/people.ts` | T6: `acceptClaimInvites` and `runNewsStep`, the two people-layer steps every suite reuses. |
| `scripts/bench/lib/provenance.ts` | `computeProvenancePct` — pure, pack in, percentage out. |
| `scripts/bench/lib/suites/__tests__/registry.test.ts` | Registry behaviour and CLI-facing key list. |
| `scripts/bench/lib/suites/__tests__/run-suite.test.ts` | Pipeline order, probe invocation, accumulator merging, failure propagation. |
| `scripts/bench/lib/__tests__/people.test.ts` | Claim acceptance and news steps against fakes. |
| `scripts/bench/lib/__tests__/provenance.test.ts` | Percentage arithmetic incl. the empty case. |

**Modified:**

| File | Change |
|---|---|
| `scripts/bench/bench.ts:29`, `:105`, `:112`, `:161-207` | `KNOWN_SUITES` and the `if (key === "_tiny")` dispatch both derive from the registry. |
| `scripts/bench/lib/suites/tiny.ts:1317` | `runTinySuite` becomes a thin adapter over `runPackSuite` plus `_tiny`'s own probes. |
| `scripts/bench/lib/oracle.ts` | Adds `compareMatches` and `compareSpecials` beside the eight B05 comparators. |
| `scripts/bench/lib/report.ts:655` | `provenancePct` gets a writer and a rendered line. |
| `docs/superpowers/specs/bench-product-value/bench-prompts/_RULES.md` | §3 entitlement bullet. |
| `docs/superpowers/specs/bench-product-value/bench-prompts/_PACK-PLAYBOOK.md` | Entitlement + people-layer acceptance items, throughput-floor note. |
| `docs/superpowers/specs/bench-product-value/bench-prompts/_INDEX.md` | B06 row splits into B06a/B06b. |
| `docs/superpowers/specs/bench-product-value/designs/2026-08-12-scheduler-bench-design.md` | §17 gains the untyped stage-config finding. |

---

### Task 1: Suite registry

**Files:**
- Create: `scripts/bench/lib/suites/types.ts`
- Create: `scripts/bench/lib/suites/registry.ts`
- Modify: `scripts/bench/bench.ts:29` (`KNOWN_SUITES`), `:105`, `:112` (validation), `:161-207` (`runSuite` dispatch)
- Test: `scripts/bench/lib/suites/__tests__/registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SuiteKey = string;
  export interface SuiteDefinition {
    readonly key: SuiteKey;
    readonly title: string;
    /** Absolute path, resolved from the defining module — never process.cwd(). */
    readonly packPath: string;
    readonly run: (input: PackSuiteInput) => Promise<SuiteReport>;
  }
  export function suiteKeys(): readonly SuiteKey[];
  export function lookupSuite(key: string): SuiteDefinition | undefined;
  export const SUITE_REGISTRY: ReadonlyMap<SuiteKey, SuiteDefinition>;
  ```
- Consumes: `SuiteReport` (`lib/report.ts:641`), `TinySuiteInput` (`lib/suites/tiny.ts:453`) — `PackSuiteInput` starts as an alias of `TinySuiteInput` in this task and is narrowed in Task 2.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/bench/lib/suites/__tests__/registry.test.ts
import { describe, expect, it } from "vitest";
import { SUITE_REGISTRY, lookupSuite, suiteKeys } from "../registry.ts";

describe("suite registry", () => {
  it("lists _tiny and resolves it to a definition whose key matches its map entry", () => {
    expect(suiteKeys()).toContain("_tiny");
    for (const [key, def] of SUITE_REGISTRY) expect(def.key).toBe(key);
  });

  it("returns undefined for an unknown key rather than throwing", () => {
    expect(lookupSuite("does-not-exist")).toBeUndefined();
  });

  it("gives every suite an absolute pack path", () => {
    for (const def of SUITE_REGISTRY.values()) expect(def.packPath.startsWith("/")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/b06a-t1.json --testTimeout=30000 scripts/bench/lib/suites/__tests__/registry.test.ts`
Expected: FAIL — cannot resolve `../registry.ts`.

- [ ] **Step 3: Write `types.ts` and `registry.ts`**

`types.ts` holds the interfaces above. `registry.ts`:

```ts
import { runTinySuite, TINY_PACK_PATH } from "./tiny.ts";
import type { SuiteDefinition, SuiteKey } from "./types.ts";

const DEFINITIONS: readonly SuiteDefinition[] = [
  { key: "_tiny", title: "Tiny proof suite", packPath: TINY_PACK_PATH, run: runTinySuite },
];

export const SUITE_REGISTRY: ReadonlyMap<SuiteKey, SuiteDefinition> = new Map(
  DEFINITIONS.map((d) => [d.key, d] as const),
);

export function suiteKeys(): readonly SuiteKey[] {
  return [...SUITE_REGISTRY.keys()];
}

export function lookupSuite(key: string): SuiteDefinition | undefined {
  return SUITE_REGISTRY.get(key);
}
```

`tiny.ts` already resolves its pack from its own module (`:243`); export that resolved absolute path as `TINY_PACK_PATH` rather than recomputing it here.

- [ ] **Step 4: Run the test — it passes**

Same command as Step 2. Expected: 3 passed.

- [ ] **Step 5: Point the CLI at the registry**

In `bench.ts`, delete the `KNOWN_SUITES` literal at `:29` and derive it: `const KNOWN_SUITES = suiteKeys();`. Replace the `if (key === "_tiny")` branch and its trailing `throw` (`:176`, `:207`) with:

```ts
const def = lookupSuite(key);
if (!def) throw new Error(`unknown suite "${key}" — known: ${suiteKeys().join(", ")}`);
return await def.run(input);
```

- [ ] **Step 6: Add the CLI regression test**

```ts
it("rejects an unknown --suite naming the known keys", async () => {
  await expect(runSuite("nope", input)).rejects.toThrow(/unknown suite "nope".*_tiny/s);
});
```

Put it beside the existing `bench.ts` tests. Run the full bench suite:
`./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/b06a-t1-all.json --testTimeout=30000 scripts/bench`
Expected: every previously-passing test still passes; count from the JSON.

- [ ] **Step 7: Commit**

```bash
git add scripts/bench/lib/suites/types.ts scripts/bench/lib/suites/registry.ts scripts/bench/lib/suites/__tests__/registry.test.ts scripts/bench/bench.ts
git commit -m "feat(bench): a suite registry, so a pack is an entry and not a branch"
```

---

### Task 2: Extract the shared runner

**Files:**
- Create: `scripts/bench/lib/suites/run-suite.ts`
- Modify: `scripts/bench/lib/suites/tiny.ts:1317` (`runTinySuite`)
- Modify: `scripts/bench/lib/suites/types.ts` (add probe types)
- Test: `scripts/bench/lib/suites/__tests__/run-suite.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SuiteAccumulators {
    readonly errors: string[];
    readonly warnings: string[];
    readonly oracles: OracleResult[];
    readonly timings: { seedMs?: number; scheduleMs?: number; simMs?: number; importMs?: number };
  }
  export interface SuiteProbeContext extends SuiteAccumulators {
    readonly base: string;
    readonly pack: Pack;
    readonly session: Session;
    readonly sql: PlanSql;
    readonly log: pino.Logger;
  }
  export interface SuiteProbe {
    readonly name: string;
    run(ctx: SuiteProbeContext): Promise<void>;
  }
  export async function runPackSuite(
    input: PackSuiteInput,
    opts: { readonly definition: SuiteDefinition; readonly probes?: readonly SuiteProbe[] },
  ): Promise<SuiteReport>;
  ```
- Consumes: Task 1's `SuiteDefinition`; the existing phase modules (`seed.ts`, `schedule.ts`, `checker.ts`, `certificate.ts`, `simulate.ts`, `import.ts`, `advance.ts`, `oracle.ts`, `believability.ts`) unchanged.

**Boundary rule for this task:** move the ORCHESTRATION out of `runTinySuite` — the phase sequence, accumulator plumbing, timings and report assembly. Everything `_tiny`-specific stays behind as a probe: the DLS gate probe (`lib/dls-gate.ts` call site), the registration drivers (`buildRealRegistrationDrivers`, `tiny.ts:349`), the discipline subject, and the cross-division court probe (`tiny.ts:1035`). If a piece of code names `_tiny`, a `d-` division ref, or a specific entrant, it is a probe, not pipeline.

- [ ] **Step 1: Write the failing pipeline test**

```ts
// scripts/bench/lib/suites/__tests__/run-suite.test.ts
it("runs phases in order and calls each probe exactly once, after the oracles", async () => {
  const calls: string[] = [];
  const probe = { name: "p", run: async () => { calls.push("probe"); } };
  await runPackSuite(fakeInput({ onPhase: (p: string) => calls.push(p) }), {
    definition: fakeDefinition(),
    probes: [probe],
  });
  expect(calls).toEqual([
    "seed", "schedule", "check", "certificate", "start", "fold", "advance", "oracles", "probe", "report",
  ]);
});

it("a probe that throws reds the run instead of escaping", async () => {
  const report = await runPackSuite(fakeInput(), {
    definition: fakeDefinition(),
    probes: [{ name: "boom", run: async () => { throw new Error("probe failed"); } }],
  });
  expect(report.errors).toContainEqual(expect.stringContaining("boom"));
  expect(report.ok).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/b06a-t2.json --testTimeout=30000 scripts/bench/lib/suites/__tests__/run-suite.test.ts`
Expected: FAIL — cannot resolve `../run-suite.ts`.

- [ ] **Step 3: Create `run-suite.ts` by moving, not rewriting**

Cut the phase sequence out of `runTinySuite` into `runPackSuite`, keeping the existing calls to `seedSuite`, `applyScheduleConfig`, `checkBoard`, `certify`, the start step, `foldStream`/`importEvents`, `advanceStage`, and the comparator block byte-for-byte where possible. Wrap each probe:

```ts
for (const probe of opts.probes ?? []) {
  try {
    await probe.run(ctx);
  } catch (err) {
    ctx.errors.push(`probe ${probe.name} threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 4: Make `runTinySuite` a thin adapter**

```ts
export async function runTinySuite(input: TinySuiteInput): Promise<SuiteReport> {
  return await runPackSuite(input, { definition: TINY_DEFINITION, probes: TINY_PROBES });
}
```

`TINY_PROBES` holds the DLS gate, registration, discipline and cross-division-court probes named in the boundary rule.

- [ ] **Step 5: Run the WHOLE bench suite, not just the new file**

Run: `./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/b06a-t2-all.json --testTimeout=30000 scripts/bench`
Expected: `numFailedTests: 0`, and `numTotalTests` at or above the pre-task count. Paste both numbers into the task notes. A DROP in total is a collection failure wearing a green hat — investigate before continuing.

- [ ] **Step 6: `typecheck:scripts` and lint**

```bash
npm run typecheck:scripts
rtk proxy npm run lint:scripts
```
Expected: 0 errors, `✖ 0 problems`.

- [ ] **Step 7: Commit**

```bash
git add scripts/bench/lib/suites/run-suite.ts scripts/bench/lib/suites/types.ts scripts/bench/lib/suites/tiny.ts scripts/bench/lib/suites/__tests__/run-suite.test.ts
git commit -m "refactor(bench): the phase pipeline leaves tiny.ts and becomes the runner every suite shares"
```

---

### Task 3: `compareMatches` — the per-match result oracle

**Files:**
- Modify: `scripts/bench/lib/oracle.ts` (add beside `compareChampion`, `:640`)
- Modify: `scripts/bench/lib/suites/run-suite.ts` (wire into the oracles phase)
- Test: `scripts/bench/lib/__tests__/oracle-matches.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MatchComparison {
    readonly checked: number;
    readonly byRound: readonly { readonly roundNo: number | null; readonly checked: number; readonly mismatched: number }[];
    readonly mismatches: readonly {
      readonly fixtureExtKey: string;
      readonly field: "outcome" | "winner" | "method" | "line" | "status";
      readonly expected: string;
      readonly actual: string;
    }[];
  }
  export function compareMatches(
    expected: readonly PackExpectedMatch[],
    actual: readonly {
      readonly extKey: string;
      readonly status: string;
      readonly roundNo: number | null;
      readonly outcome: unknown;
      readonly perSide?: readonly { readonly entrant: string; readonly line: string }[];
    }[],
  ): MatchComparison;
  ```
- Consumes: `PackExpectedMatch` (`lib/pack-schema.ts:1061-1069`) = `{divisionRef, fixtureExtKey, outcome, perSide?}`, where `perSide[].line` is a rendered scoreline string and is OPTIONAL because a result-level sport has none.

**Two facts that shape this comparator — do not design around a scoreline scalar:**

- `GET /api/v1/divisions/{id}/fixtures` (`app/api/v1/divisions/[id]/fixtures/route.ts:14`, usecase `usecases/fixtures.ts:68`, **no query params**) returns per fixture: `ext_key`, `status` (`scheduled|in_play|decided|finalized|abandoned|forfeited|cancelled`), `outcome` (jsonb, typed `z.unknown().nullable()` on the wire at `server/api-v1/schemas.ts:1161`+36), `round_no`, `seq_in_round`, `home_entrant_id`/`away_entrant_id`, `court_id`, `scheduled_at`. **There is no score field.** The route also strips `venue` and `court_label` (`route.ts:19`).
- The engine's `MatchOutcome` (`packages/engine/src/core/types.ts`) is a discriminated union on `kind`: `win {winner, loser, method?}`, `draw`, `tie`, `no_result`, `award {winner, score?}`. So the outcome comparison is kind + winner + method, and `pack-schema.ts` already pins that the pack's kinds are the engine's (`OUTCOME_KINDS_ARE_ENGINE_KINDS`).
- Scorelines, where a pack declares `perSide`, come from `GET /api/v1/fixtures/{id}/state` (`app/api/v1/fixtures/[id]/state/route.ts:8` → `getFixtureState`), which returns summary + fold + status. Fetch it ONLY for fixtures whose expected entry declares `perSide`, or a 95-match suite pays 95 extra round trips for nothing.

- [ ] **Step 1: Write the failing tests — all four cases**

```ts
const won = (winner: string, loser: string, method?: string) => ({ kind: "win", winner, loser, ...(method ? { method } : {}) });

it("passes when the declared outcome matches the live one", () => {
  const r = compareMatches(
    [{ divisionRef: "d1", fixtureExtKey: "f1", outcome: won("e1", "e2") }],
    [{ extKey: "f1", status: "decided", roundNo: 1, outcome: won("e1", "e2") }],
  );
  expect(r.checked).toBe(1);
  expect(r.mismatches).toEqual([]);
});

it("catches the reversed winner and names the field", () => {
  const r = compareMatches(
    [{ divisionRef: "d1", fixtureExtKey: "f1", outcome: won("e1", "e2") }],
    [{ extKey: "f1", status: "decided", roundNo: 1, outcome: won("e2", "e1") }],
  );
  expect(r.mismatches).toEqual([
    { fixtureExtKey: "f1", field: "winner", expected: "e1", actual: "e2" },
  ]);
});

it("catches a draw served where a win was expected", () => {
  const r = compareMatches(
    [{ divisionRef: "d1", fixtureExtKey: "f1", outcome: won("e1", "e2") }],
    [{ extKey: "f1", status: "decided", roundNo: 1, outcome: { kind: "draw" } }],
  );
  expect(r.mismatches[0]).toMatchObject({ field: "outcome", expected: "win", actual: "draw" });
});

it("treats an undecided fixture as a status mismatch, never as absent", () => {
  const r = compareMatches(
    [{ divisionRef: "d1", fixtureExtKey: "f1", outcome: won("e1", "e2") }],
    [{ extKey: "f1", status: "scheduled", roundNo: 1, outcome: null }],
  );
  expect(r.checked).toBe(1);
  expect(r.mismatches[0]).toMatchObject({ field: "status", actual: "scheduled" });
});

it("compares perSide lines only where the pack declares them", () => {
  const r = compareMatches(
    [{ divisionRef: "d1", fixtureExtKey: "f1", outcome: won("e1", "e2"), perSide: [{ entrant: "e1", line: "7" }, { entrant: "e2", line: "3" }] }],
    [{ extKey: "f1", status: "decided", roundNo: 1, outcome: won("e1", "e2"), perSide: [{ entrant: "e1", line: "7" }, { entrant: "e2", line: "2" }] }],
  );
  expect(r.mismatches).toEqual([{ fixtureExtKey: "f1", field: "line", expected: "3", actual: "2" }]);
});

it("groups the count by round so a knockout reports per round", () => {
  const r = compareMatches(
    [
      { divisionRef: "d1", fixtureExtKey: "f1", outcome: won("e1", "e2") },
      { divisionRef: "d1", fixtureExtKey: "f2", outcome: won("e3", "e4") },
    ],
    [
      { extKey: "f1", status: "decided", roundNo: 1, outcome: won("e1", "e2") },
      { extKey: "f2", status: "decided", roundNo: 2, outcome: won("e4", "e3") },
    ],
  );
  expect(r.byRound).toEqual([
    { roundNo: 1, checked: 1, mismatched: 0 },
    { roundNo: 2, checked: 1, mismatched: 1 },
  ]);
});

it("reports zero checked when the pack declares no matches — never a silent pass", () => {
  expect(compareMatches([], []).checked).toBe(0);
});
```

- [ ] **Step 2: Run and watch all four fail**

Run: `./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/b06a-t3.json --testTimeout=30000 scripts/bench/lib/__tests__/oracle-matches.test.ts`
Expected: FAIL — `compareMatches is not a function`.

- [ ] **Step 3: Implement it**

Index `actual` by `extKey` and walk the DECLARED list — never the live list; a fixture the pack does not declare is not this oracle's business. Parse `outcome` with the engine's `MatchOutcome` zod union rather than reading fields off `unknown`: a jsonb column that was written as a JSON *string* parses to a scalar and every field read then yields `undefined`, which would compare as a silent match. Compare `kind` first, then `winner`, then `method` only when the pack declares one, then `perSide` lines by entrant ref. Report the FIRST differing field per fixture, so one wrong result is one row.

- [ ] **Step 4: Tests pass**

Same command. Expected: 7 passed.

- [ ] **Step 5: Wire it, with the no-subject verdict**

In the oracles phase of `run-suite.ts`:

```ts
const cmp = compareMatches(pack.expected.matches ?? [], fixtures);
oracles.push({
  name: "per-match results",
  passed: cmp.mismatches.length === 0,
  subject: cmp.checked > 0,
  verdict: cmp.checked === 0 ? "no_subject" : cmp.mismatches.length === 0 ? "pass" : "fail",
  detail: `${cmp.checked} checked, ${cmp.mismatches.length} mismatched`,
});
log.info(oracleLogFields("per-match results", cmp.checked), "oracle_checked");
```

- [ ] **Step 6: Prove it against `_tiny`'s eight declared matches**

Add a wiring regression asserting the oracle appears in `_tiny`'s report with `checked: 8`, using the existing `_oracle-routes` fake. Run the whole bench suite; paste counts.

- [ ] **Step 7: Mutation sweep — three mutants, each named**

Kill each by running the suite and recording which test fails:
1. `mismatches.length === 0` → `true` (the oracle can never fail).
2. Drop the undecided branch (null scores read as a match).
3. `checked === 0 ? "no_subject"` → `"pass"` (a vacuous pass returns).
Record the killer test per mutant in the PR body — a count alone is not evidence.

- [ ] **Step 8: Commit**

```bash
git add scripts/bench/lib/oracle.ts scripts/bench/lib/suites/run-suite.ts scripts/bench/lib/__tests__/oracle-matches.test.ts
git commit -m "feat(bench): expected.matches was declared and never compared"
```

---

### Task 4: `compareSpecials`

**Files:**
- Modify: `scripts/bench/lib/oracle.ts`
- Modify: `scripts/bench/lib/suites/run-suite.ts`
- Test: `scripts/bench/lib/__tests__/oracle-specials.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SpecialsComparison {
    readonly checked: number;
    readonly missing: readonly string[];
    readonly wrong: readonly { readonly key: string; readonly expected: string; readonly actual: string }[];
  }
  export function compareSpecials(
    expected: Pack["expected"]["specials"],
    actual: readonly { readonly key: string; readonly outcome: string }[],
  ): SpecialsComparison;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("passes when the declared special occurred with the declared outcome", () => {
  const r = compareSpecials([{ key: "super-over-1", outcome: "home" }], [{ key: "super-over-1", outcome: "home" }]);
  expect(r).toEqual({ checked: 1, missing: [], wrong: [] });
});

it("reports a declared special that never occurred as MISSING, not as wrong", () => {
  const r = compareSpecials([{ key: "shootout-final", outcome: "away" }], []);
  expect(r.missing).toEqual(["shootout-final"]);
  expect(r.wrong).toEqual([]);
});

it("reports a wrong outcome with both values", () => {
  const r = compareSpecials([{ key: "s1", outcome: "home" }], [{ key: "s1", outcome: "away" }]);
  expect(r.wrong).toEqual([{ key: "s1", expected: "home", actual: "away" }]);
});

it("checked is zero when the pack declares no specials", () => {
  expect(compareSpecials([], []).checked).toBe(0);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/b06a-t4.json --testTimeout=30000 scripts/bench/lib/__tests__/oracle-specials.test.ts`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement, distinguishing missing from wrong**

A declared special with no live counterpart is `missing`; one present with a different outcome is `wrong`. Both red; they are separate fields because they mean different defects (the mechanic never fired vs. it fired differently).

- [ ] **Step 4: Tests pass**

Same command. Expected: 4 passed.

- [ ] **Step 5: Wire it with the same verdict shape as Task 3**, `subject: checked > 0`, `no_subject` when the pack declares none. `_tiny` declares 1 special, so assert `checked: 1` in the wiring regression.

- [ ] **Step 6: Mutation sweep — two mutants**

1. Collapse `missing` into `wrong` (the two defects stop being distinguishable).
2. `checked === 0 ? "no_subject"` → `"pass"`.
Record killers.

- [ ] **Step 7: Commit**

```bash
git add scripts/bench/lib/oracle.ts scripts/bench/lib/suites/run-suite.ts scripts/bench/lib/__tests__/oracle-specials.test.ts
git commit -m "feat(bench): compare the specials the pack declares"
```

---

### Task 5: The provenance writer

**Files:**
- Create: `scripts/bench/lib/provenance.ts`
- Modify: `scripts/bench/lib/report.ts` (populate `provenancePct` at `:655`, render it)
- Modify: `scripts/bench/lib/suites/run-suite.ts` (compute once, pass into the report)
- Test: `scripts/bench/lib/__tests__/provenance.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProvenanceBreakdown {
    readonly total: number;
    readonly real: number;
    readonly reconstructed: number;
    readonly synthetic: number;
    /** Percentage of streams flagged "real", rounded to one decimal. 0 when total is 0. */
    readonly realPct: number;
  }
  export function computeProvenance(pack: Pack): ProvenanceBreakdown;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("counts each provenance value and reports the real percentage", () => {
  const p = computeProvenance(packWithStreams(["real", "real", "reconstructed", "synthetic"]));
  expect(p).toEqual({ total: 4, real: 2, reconstructed: 1, synthetic: 1, realPct: 50 });
});

it("rounds to one decimal rather than truncating", () => {
  expect(computeProvenance(packWithStreams(["real", "real", "reconstructed"])).realPct).toBe(66.7);
});

it("returns zero for a pack with no streams instead of dividing by zero", () => {
  expect(computeProvenance(packWithStreams([]))).toEqual({ total: 0, real: 0, reconstructed: 0, synthetic: 0, realPct: 0 });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/b06a-t5.json --testTimeout=30000 scripts/bench/lib/__tests__/provenance.test.ts`
Expected: FAIL — cannot resolve `../provenance.ts`.

- [ ] **Step 3: Implement and render**

Count `streams[].provenance`; render a report line under the suites section (`report.ts:915`) reading `provenance: 50.0% real (2/4 streams; 1 reconstructed, 1 synthetic)`.

- [ ] **Step 4: Tests pass, plus a report regression**

Assert the rendered markdown contains the provenance line for `_tiny`. Run the whole bench suite; paste counts.

- [ ] **Step 5: Commit**

```bash
git add scripts/bench/lib/provenance.ts scripts/bench/lib/report.ts scripts/bench/lib/suites/run-suite.ts scripts/bench/lib/__tests__/provenance.test.ts
git commit -m "feat(bench): provenancePct had a field and no writer"
```

---

### Task 6: Claim acceptance (§9 P2)

**Files:**
- Create: `scripts/bench/lib/people.ts`
- Modify: `scripts/bench/lib/suites/run-suite.ts` (people phase)
- Test: `scripts/bench/lib/__tests__/people.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ClaimAcceptanceResult {
    readonly attempted: number;
    readonly accepted: number;
    readonly rejected: readonly { readonly person: string; readonly status: number }[];
    /** The deliberate negative case: an expired or tampered token must be refused. */
    readonly invalidTokenRefused: boolean;
  }
  export async function acceptClaimInvites(args: {
    readonly base: string;
    readonly invites: readonly { readonly person: string; readonly email: string; readonly token: string }[];
    readonly limit: number;
    readonly transport: ProbeTransport;
  }): Promise<ClaimAcceptanceResult>;
  ```
- Consumes: invites seeded by `lib/seed-plan.ts:313-334`; `_tiny` currently asserts they stay UNCLAIMED at `lib/suites/tiny.ts:1669` — that assertion must be REPLACED, not weakened, and its replacement asserts the accepted count instead.

**Route facts (re-pinned 2026-09-09 against `8f3e3d655`).** Note that the accept flow is NOT under `/api/v1` — it is the public claim surface, and the token in the path is the authentication:

| step | call | notes |
|---|---|---|
| resolve | `GET /api/claims/{token}` | `resolveClaimToken` (`usecases/person-claims.ts:255`) → `{person_name, org_name, email}` |
| become a user | `POST /api/auth/magic-link` `{email, next}` → `POST /api/auth/magic-link/consume` `{token, next}` | the first CREATES the user (`resolveOrCreateUser`, route.ts:32); the second returns the session (`createSession`, :31) |
| accept | `POST /api/claims/{token}/accept` | no body, requires the session from the step above; `claimPerson` (`person-claims.ts:372`) → `acceptResolvedClaim` (`:316`) sets `persons.user_id` and `person_claims.claimed_at` |

Refusal codes, which are what the negative case asserts: `401 CLAIM_INVALID` (`:233`), `409 CLAIM_CLAIMED` (`:235`, and the race loser at `:324`/`:329`), `401 CLAIM_REVOKED` (`:238`), `401 CLAIM_EXPIRED` (`:240-241`, `expires_at <= now`). Invite TTL is `CLAIM_DAYS` (`:94`); the token prefix is `CLAIM_PREFIX` (`:14`).

Claimed-profile stats: `GET /api/v1/persons/{id}/stats` (`app/api/v1/persons/[id]/stats/route.ts:13`) → `{divisions: [{division_id, division_name, stats}]}` via `personStats` (`usecases/player-stats.ts:493`); `?group=sport` → `{sports: [CareerSportStats]}` via `personCareerStats` (`:627`). **This route does not mask names** — it is org-authed and returns the real `full_name`. `public_person_name(...)` masking lives only on the public reads (`player-stats.ts:721`), so do not assert masking here.

- [ ] **Step 1: Write the failing tests**

```ts
it("accepts exactly `limit` invites and reports the count", async () => {
  const r = await acceptClaimInvites({ base, invites: threeInvites, limit: 3, transport: fake });
  expect(r).toMatchObject({ attempted: 3, accepted: 3, rejected: [] });
});

it("records a refusal with its status rather than throwing", async () => {
  const r = await acceptClaimInvites({ base, invites: threeInvites, limit: 3, transport: refusing(409) });
  expect(r.accepted).toBe(0);
  expect(r.rejected[0]).toMatchObject({ status: 409 });
});

it("proves an invalid token is refused", async () => {
  const r = await acceptClaimInvites({ base, invites: threeInvites, limit: 3, transport: fake });
  expect(r.invalidTokenRefused).toBe(true);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/b06a-t6.json --testTimeout=30000 scripts/bench/lib/__tests__/people.test.ts`
Expected: FAIL — cannot resolve `../people.ts`.

- [ ] **Step 3: Implement against the pinned routes**

Accept `limit` invites; then deliberately attempt one tampered token and record that it was refused. A 2xx on the tampered token sets `invalidTokenRefused: false`, which reds the run — the negative case is an assertion, not decoration.

- [ ] **Step 4: Tests pass**

Same command. Expected: 3 passed.

- [ ] **Step 5: Wire it and add the claimed-profile oracle**

After acceptance, read the claimed person's stats and assert they equal the same numbers the leaderboard oracle already proved for that person. Push an `OracleResult` named `claimed profile stats`, with `subject: accepted > 0`.

- [ ] **Step 6: Replace `_tiny`'s stale unclaimed assertion**

`tiny.ts:1669` asserts invites stay unclaimed. Change it to assert the post-acceptance state — accepted count equals the limit, remaining invites still unclaimed. Do not delete the assertion.

- [ ] **Step 7: Mutation sweep — two mutants**

1. `invalidTokenRefused` hardcoded `true` (the negative case stops being tested).
2. `limit` ignored, accept all (the count assertion must catch it).

- [ ] **Step 8: Commit**

```bash
git add scripts/bench/lib/people.ts scripts/bench/lib/suites/run-suite.ts scripts/bench/lib/suites/tiny.ts scripts/bench/lib/__tests__/people.test.ts
git commit -m "feat(bench): claims are accepted, not just minted"
```

---

### Task 7: News drafts and publication (§9 P6)

**Files:**
- Modify: `scripts/bench/lib/people.ts`
- Modify: `scripts/bench/lib/suites/run-suite.ts`
- Modify: `scripts/bench/lib/report.ts:658` (`news: {drafted, published}` gets a writer)
- Test: `scripts/bench/lib/__tests__/people.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NewsStepResult {
    readonly drafted: number;
    readonly published: number;
    readonly stillDraft: number;
    /** The fire-once predicate, asserted by proxy: a second publish of an
     *  already-published post must not move `published_at`. */
    readonly republishWasInert: boolean;
  }
  export async function runNewsStep(args: {
    readonly base: string;
    readonly publishFixtureExtKeys: readonly string[];
    readonly transport: ProbeTransport;
  }): Promise<NewsStepResult>;
  ```

**Route facts (re-pinned 2026-09-09), and one that changes the assertion:**

| thing | fact |
|---|---|
| drafting | **automatic** — `draftPostsForDecidedFixture` (`usecases/org-posts.ts:448`) is called by `refreshNews` (`usecases/scoring.ts:336`, invoked at `scoring.ts:132` and `event-import.ts:435`). The bench does not trigger drafting; folding events does |
| its two preconditions | `divisions.auto_posts` must be on AND the org must hold `hasFeature("news.auto")`. **Seed both, or `drafted` is legitimately 0 and the step proves nothing** |
| rows | `insert into org_posts … 'draft'` (`org-posts.ts:689`); `PostStatus = "draft" \| "published" \| "archived"` (`:61`) |
| list | `GET /api/v1/orgs/{id}/posts?status=` (`app/api/v1/orgs/[id]/posts/route.ts:13` → `listPosts` `:156`). No competition filter — filter client-side on the `competition_id`/`division_id` fields of `toApiPost` (`server/api-v1/posts.ts:10`) |
| publish | `PATCH /api/v1/posts/{id}`, body `PatchPost` `{title?, body_md?, action: "publish" \| "archive"}` (`schemas.ts:4635`) |
| the effect | `shouldFirePostPublished` (`org-posts.ts:100`) is `action === "publish" && prevStatus !== "published"`, and its side effect is **a PostHog `captureServer` call** (`:318-325`) — **no table row, no outbox** |

**Consequence, and the design decision it forces:** "observed exactly once" is not observable over HTTP, because the observable is analytics. Do not assert PostHog. Assert the PREDICATE's behaviour instead — publish a post, then PATCH `action: "publish"` a second time and assert `published_at` is unchanged, which is the only thing `prevStatus !== "published"` protects that a client can see. Record in the PR body that the fire-once effect itself is analytics-only and therefore asserted by proxy.

**Caution for the live run:** a local server posts to LIVE PostHog. Three published posts per run means three real analytics events. That is acceptable for a handful of runs; it is a reason not to loop this step.

- [ ] **Step 1: Write the failing tests**

```ts
it("publishes exactly the named fixtures' posts and leaves the rest draft", async () => {
  const r = await runNewsStep({ base, publishFixtureExtKeys: ["semi-1", "semi-2", "final"], transport: fake });
  expect(r).toMatchObject({ published: 3 });
  expect(r.stillDraft).toBeGreaterThan(0);
});

it("a second publish of the same post does not move published_at", async () => {
  const r = await runNewsStep({ base, publishFixtureExtKeys: ["final"], transport: fake });
  expect(r.republishWasInert).toBe(true);
});

it("reds when a republish DOES move published_at", async () => {
  const r = await runNewsStep({ base, publishFixtureExtKeys: ["final"], transport: republishBumpsTimestamp });
  expect(r.republishWasInert).toBe(false);
});

it("reports zero drafted rather than throwing when no fixture is decided", async () => {
  const r = await runNewsStep({ base, publishFixtureExtKeys: [], transport: emptyFake });
  expect(r).toMatchObject({ drafted: 0, published: 0 });
});
```

- [ ] **Step 2: Run and watch them fail**

Same command as Task 6 Step 2. Expected: 3 new failures.

- [ ] **Step 3: Implement**

List posts, publish the named ones, count what stayed draft, then re-PATCH one published post and compare `published_at` before and after. `stillDraft` is asserted greater than zero on a suite with more decided fixtures than published posts — a run that published everything has not proven the draft state.

- [ ] **Step 4: Tests pass**

Same command. Expected: 4 passed.

- [ ] **Step 5: Wire into the people phase and the report**

Populate `report.news = { drafted, published }` and render it. Push an `OracleResult` named `news drafts` with `subject: drafted > 0`.

- [ ] **Step 6: Mutation sweep — two mutants**

1. `republishWasInert` hardcoded `true` (the fire-once proxy stops being tested).
2. Publish ALL posts (the `stillDraft > 0` assertion must catch it).
3. Skip the `auto_posts` / `news.auto` precondition in seeding — `drafted` falls to 0 and the `subject` flag must turn the oracle into NO SUBJECT rather than a pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/bench/lib/people.ts scripts/bench/lib/suites/run-suite.ts scripts/bench/lib/report.ts scripts/bench/lib/__tests__/people.test.ts
git commit -m "feat(bench): news is drafted, three posts published, the rest proven still draft"
```

---

### Task 8: The documents this wave falsifies

**Files:**
- Modify: `docs/superpowers/specs/bench-product-value/bench-prompts/_RULES.md` (§3 entitlement bullet)
- Modify: `docs/superpowers/specs/bench-product-value/bench-prompts/_PACK-PLAYBOOK.md` (per-pack acceptance list)
- Modify: `docs/superpowers/specs/bench-product-value/bench-prompts/_INDEX.md` (B06 row → B06a/B06b)
- Modify: `docs/superpowers/specs/bench-product-value/designs/2026-08-12-scheduler-bench-design.md` (§17)

- [ ] **Step 1: Rewrite the entitlement rule**

`_RULES.md` §3 currently says deep tiers 422 without the right plan, citing `requiredFeatureForEvent` and `cricket.ball` → `scoring.ball_by_ball`. Replace with: entitlements v18 W1 deleted the fidelity-band gate and its three keys (`apps/web/src/server/usecases/fidelity.ts:1-9`); the only remaining gate at the scoring door is DLS (`usecases/scoring.ts:277-289`, `requiresDlsEntitlement`). Suites with no paid gate satisfy the acceptance item by recording that, not by faking a 422.

- [ ] **Step 2: Fix the playbook's two false acceptance lines**

The people-layer line ("as wired in B03–B05") becomes true only for what this wave shipped — name officials, claims and news explicitly, and drop coach lanes to a named deferral if no step exists for them. Add: B06b's throughput figure is a FLOOR; B08 owns the real volume measurement.

- [ ] **Step 3: Split the index row**

B06 becomes B06a (this wave) and B06b (the pack), with the PackSchema freeze attached to B06b.

- [ ] **Step 4: Add the untyped-config finding to §17**

`CreateStage.config` is `z.record(z.string(), z.unknown())` (`api-v1/schemas.ts:980`) inside a `.strict()` envelope (`:983`), so a misspelled `byes`/`slotOrder` is dropped in silence and the product seeds its own draw. Note the separate PR that types it.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/bench-product-value
git commit -m "docs(bench): three standing documents said things this wave disproves"
```

---

### Task 9: The live run (orchestrator only — never a subagent)

**Files:** none modified; evidence committed under `docs/superpowers/specs/bench-product-value/bench-prompts/evidence/b06a-tiny-run/`.

- [ ] **Step 1: Stand up the environment**

Follow the `seazn-local-env` skill. Never :3000, never the dev DB; `db:apply` AND `sync:sports`; confirm `show data_directory` is yours.

- [ ] **Step 2: Leg A — placement live**

```bash
npm run bench:scheduler -- --suite _tiny --engine optimized --wipe
```
Expected: gate green, zero blocking conflicts, the new oracles present with real subjects (`per-match results` checked 8, `specials` checked 1, `claimed profile stats`, `news drafts`).

- [ ] **Step 3: Leg B — placement torn down**

Stop the placement container, then:
```bash
npm run bench:scheduler -- --suite _tiny --engine greedy --wipe
```
Expected: same verdicts, `solverStatus: solver_unavailable`. `_RULES.md` §2 requires both legs; CI smoke has no placement container by design.

- [ ] **Step 4: Confirm the run actually exercised the new code**

Read the written report and check the provenance line renders, `news.published` is 3, and the claim count is 3. A green run whose report lacks these means the phase did not execute.

- [ ] **Step 5: Commit the evidence and open the PR**

```bash
git add docs/superpowers/specs/bench-product-value/bench-prompts/evidence/b06a-tiny-run
git commit -m "docs(bench): B06a live evidence, both placement legs"
```

PR body carries: raw JSON counts for the full `scripts/bench` suite, `typecheck:scripts` and `lint:scripts` output, the mutant→killer table from Tasks 3, 4, 6 and 7, the route re-pin used by Tasks 6–7, and any `Unplanned fixes`.

---

## Self-Review

**Spec coverage.** D1 is B06b's, not this plan's. D2 → the plan is B06a only, and Task 8 Step 3 attaches the freeze to B06b. D3 → Tasks 3 and 4. D4 is B06b's (the draw read-back). D5 → Tasks 6 and 7. D6 → Task 7. D7 → Task 8 Step 1. D8 → the separate product PR, out of this plan by design; Task 8 Step 4 records the finding. Framework scope (§4 items 1–2) → Tasks 1 and 2; item 4 → Task 5; item 6 → Task 8. Gates (§7) → Task 9.

**Placeholders.** None. Every route Tasks 6 and 7 call is pinned in-task with its file:line, including the two that are NOT under `/api/v1` (the claim surface) and the one whose side effect is analytics rather than data. No "TBD", no "similar to Task N".

**One assertion downgraded on purpose.** §9 P6's "`shouldFirePostPublished` observed exactly once" is asserted by proxy — an inert republish — because the effect is a PostHog capture with no data trace. The PR body must say so rather than let a future reader believe the effect itself was witnessed.

**Type consistency.** `SuiteDefinition`, `SuiteProbe`, `SuiteProbeContext` and `PackSuiteInput` are defined in Task 1/2 and used unchanged afterwards. `OracleResult` fields (`name`, `passed`, `verdict`, `subject`, `detail`) match `report.ts:115-165`. `computeProvenance` is named consistently in Task 5's interface, steps and commit.

**Known gap, stated rather than hidden:** coach lanes (§9 P3) get no step in this wave. Task 8 Step 2 requires the playbook to name that deferral instead of continuing to claim it is wired.
