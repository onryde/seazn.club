# B04 — bench scheduling layer: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the scheduler bench its core claim — schedules verified
independently of the solver, with `INFEASIBLE` attributed to the pack or the
product rather than guessed at.

**Architecture:** Five new pure/DI-seamed modules under `scripts/bench/lib/`.
`board.ts` holds transport-free types plus the pure pack→constraints encoder,
and is the ONLY input the checker and certificate take — which is what makes
both testable on hand-built boards and keeps the checker unable to call back
into the product. `schedule.ts` is the sole HTTP driver. `checker.ts` and
`certificate.ts` recompute; `believability.ts` measures and never gates.

**Tech Stack:** TypeScript 7 / Node 26, run via
`node --experimental-strip-types`; vitest (node environment, no DOM); zod 4;
pino. pnpm@10.34.5 — `npm install` fails, `npm run` works.

**Spec:** `docs/superpowers/specs/bench-product-value/designs/2026-09-05-b04-scheduling-layer-design.md`
(owner-approved 2026-09-04). Parent spec: `../bench-product-value/designs/2026-08-12-scheduler-bench-design.md` §5/§6.
Session prompt: `../bench-product-value/bench-prompts/B04-scheduling-layer.md`.
Standing rules: `../bench-product-value/bench-prompts/_RULES.md` then
`docs/superpowers/RULES.md`.

---

## Global Constraints

Every task's requirements implicitly include all of these.

- **Worktree:** `/Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b04`,
  branch `feat/bench-b04-scheduling`. **Prefix `cd <that absolute path> &&` in
  the SAME call as every command you judge** — the shell cwd resets to the main
  checkout between tool calls, and a verify run launched from a worktree then
  silently executes on `main` and returns a false green.
- **Never `git stash` in this worktree.** The stash stack is shared with the
  main checkout; a no-op push+pop pops a foreign stash and leaves
  `package.json` unmerged, blocking every commit in the tree.
- **No product code.** Nothing under `apps/web/`, `packages/`, or
  `services/placement/` is edited. A checker finding that disagrees with
  `/validate` is a FINDING (parent spec §7B) — report it, never "fix" the
  checker to match.
- **No TS `enum` anywhere in `scripts/bench/`.** The runner is
  `node --experimental-strip-types`, which crashes on a TS enum. Use string
  union types plus `const` objects.
- **No value import from `@seazn/engine` in `checker.ts`.** `import type` is
  allowed and wanted (`ConflictDetailKind`, `CourtHoursRow`,
  `CourtExceptionRow`) so vocabularies cannot drift. `usableWindows` and
  `assessCapacity` are not imported at all — design §2.3.
- **Correctness gates; timings never do.** Do not add a wall-time assertion.
- **i18n:** the bench is a dev tool, its report/CLI strings are exempt. This
  work adds no app-facing string.
- **`tsconfig.scripts.json` excludes `scripts/**/*.test.ts`** — a test fixture
  missing a newly-required field is invisible to `tsc` and only shows when the
  suite runs. Run the suite, not just typecheck.
- **Judge vitest only from the JSON reporter**, and compare `numTotalTests`,
  not the failure count: a suite that fails to COLLECT contributes zero tests
  and zero failures, so `numFailedTests: 0` is not green on its own.
- **Never write logs or report output to bare `/tmp`** — paths collide across
  sessions. Use
  `/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/70216b38-6a7f-4c13-a0f7-69a8009b3d3a/scratchpad/`.
- **Commit after every task.** Frequent, small, with the task number in the
  subject.

### The verify commands (verbatim, per the session prompt)

```bash
W=/Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b04
S=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/70216b38-6a7f-4c13-a0f7-69a8009b3d3a/scratchpad

cd $W && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=$S/b4.json scripts/bench
cd $W && jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' $S/b4.json
cd $W && rtk proxy npm run lint          # judge on the "✖ N problems" line only
cd $W && npm run bench:scheduler -- --suite _tiny --wipe --engine both
```

`rtk` hides `npm run lint` output entirely — "ESLint output (JSON parse
failed)" is the wrapper losing the result, not a clean run. `rtk` also
fabricates a clean Prettier verdict. Use `rtk proxy` and read the real line.

### Live environment — TORN DOWN, bring it up only for T7

There is deliberately NO standing env. Owner policy 2026-09-04: no idle
environments; bring one up only when a task actually needs it. T1-T6 need
none — the bench's DI seams mean its unit suite never touches live Postgres.

T7's live legs need one:

```bash
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh
$S up --label b04 --all          # ~13s DB; placement venv is per-repo and survives
eval "$($S env --label b04)"     # DATABASE_URL / SMOKE_BASE / PLACEMENT_SERVICE_*
$S down --label b04              # the moment T7's legs are done
```

**The server build OOMs under machine load.** It died once at exit 137
(SIGKILL) after `✓ Compiled successfully`, killed during `Running TypeScript`,
28m56s wasted — seven resident env labels, load avg ~396, 2.5GB of 4GB swap
used; `apps/web` typecheck alone wants ~2.8GB. Check `uptime` and `vm_stat`
before starting the build, and note the harness reported that failed command
as "exit code 0" — only its own `EXIT=$?` said otherwise.

---

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `scripts/bench/lib/board.ts` | Transport-free types (`Board`, `BoardFixture`, `BoardCourt`, `EncodedConstraints`, `CheckerFinding`) + the pure `encodeConstraints` mapper. No I/O, no imports from elsewhere in the bench. |
| `scripts/bench/lib/schedule.ts` | The only HTTP driver. Per division: settings → lock → snapshot → auto → apply → validate → fetch. Produces `Board` + `ScheduleOutcome`. Owns the engine assertion and the engine artifact. |
| `scripts/bench/lib/checker.ts` | `checkBoard` — seven rules recomputed from a `Board`. Pure. |
| `scripts/bench/lib/certificate.ts` | `certify` — parent spec §6.3 protocol, history first. Pure. |
| `scripts/bench/lib/believability.ts` | `assessHealth` wrapper, engine delta, similarity-to-historical. Report-only. |
| `scripts/bench/lib/__tests__/board.test.ts` | |
| `scripts/bench/lib/__tests__/schedule.test.ts` | |
| `scripts/bench/lib/__tests__/checker.test.ts` | |
| `scripts/bench/lib/__tests__/certificate.test.ts` | |
| `scripts/bench/lib/__tests__/believability.test.ts` | |
| `scripts/bench/lib/__tests__/checker-independence.test.ts` | The bypass-and-restore regression. |

**Modify**

| File | Change |
|---|---|
| `scripts/bench/lib/suites/tiny.ts` | Replace the scheduling half (`:1065-1200`) with a call into `schedule.ts`; walk N divisions, not `divisions[0]`; delete the ad-hoc venue/court creation at `:974-993`; widen `AutoScheduleOut` (`:717-726`); fix the stale `schemas.ts:1496-1542` pin at `:1108-1118`. |
| `scripts/bench/bench.ts` | `--engine` semantics (`:66,78-81`); pass the resolved report dir into the suite. |
| `scripts/bench/lib/report.ts` | New render sections: scheduling, checker, certificate, believability, engine delta. Hook is the `sections` array in `renderMarkdown` (`:363-369`). |
| `scripts/bench/packs/build-packs/_tiny.ts` + `packs/_tiny.json` | Add `venues[]` (one venue, two courts) and a `scheduleConfig` on BOTH divisions. |

**Task order.** T1 → T2 → T3 → T4 → T5 → T6 → T7, **strictly sequential**
(Ruling R5). The original `T2 ∥ T4` / `T3 ∥ T5` pairing is overridden: both
halves of each pair write into `scripts/bench/lib/__tests__/`, the SDD skill
forbids parallel implementers outright, and AGENTS.md requires sequential
execution on any file-set overlap. Commit commands name explicit files, never
a directory.

---

### Task 1: `board.ts` — the seam

**Files:**
- Create: `scripts/bench/lib/board.ts`
- Test: `scripts/bench/lib/__tests__/board.test.ts`

**Interfaces:**
- Consumes: `PackDivision`, `PackVenue` from `lib/pack-schema.ts`; `CourtHoursRow`, `CourtExceptionRow` as `import type` from `@seazn/engine/scheduling`.
- Produces — every later task depends on these exact names:

```ts
export interface BoardFixture {
  fixtureId: string;
  extKey?: string;
  divisionId: string;
  divisionRef: string;
  roundNo?: number;
  poolId?: string;
  start?: number;          // epoch ms; undefined = UNPLACED
  end?: number;            // epoch ms; derived — see Task 4 step 6
  courtId?: string;
  courtName?: string;
  venueId?: string;
  entrantIds: readonly string[];
  personIds: readonly string[];
  officialIds: readonly string[];
  locked: boolean;
}
export interface BoardCourt {
  courtId: string; name: string; venueId: string;
  hours: readonly CourtHoursRow[];
  exceptions: readonly CourtExceptionRow[];
}
export interface Board {
  divisionId: string; divisionRef: string; tz: string;
  fixtures: readonly BoardFixture[];
  courts: readonly BoardCourt[];
}
export type EncodedHardRule =
  | { type: "min_rest_minutes"; minutes: number; restScope: "per_person" | "feeder_to_dependent" | "both" }
  | { type: "max_fixtures_per_day"; count: number }
  | { type: "not_before"; minutesIntoDay: number }
  | { type: "not_after"; minutesIntoDay: number };
export interface EncodedConstraints {
  divisionRef: string;
  matchMinutes: number;
  gapMinutes: number;
  startAt?: number; endAt?: number;
  courtIds: readonly string[];
  perEntrantMinRest: number;
  blackouts: readonly { courtId?: string; from: number; to: number }[];
  sessionWindows: readonly { from: number; to: number }[];
  hard: readonly EncodedHardRule[];
  pins: readonly { fixtureId: string; start: number; courtId: string }[];
  isRoundRobin: boolean;
  unmodelled: readonly { type: string; reason: string }[];
}
export type CheckerFindingKind =
  | "court_double_booking" | "inside_blackout" | "outside_session_windows"
  | "outside_court_hours" | "entrant_below_rest" | "day_cap_exceeded"
  | "pin_moved" | "official_double_booking"
  | "round_order_day" | "round_order_same_day"
  | "officials_unreadable" | "duration_disagreement";
export interface CheckerFinding {
  kind: CheckerFindingKind;
  divisionRef: string;
  fixtureIds: readonly string[];
  detail: string;
  measured?: number;
  required?: number;
}
export function encodeConstraints(input: {
  divisionRef: string;
  scheduleConfig: Record<string, unknown> | undefined;
  courtIdByRef: ReadonlyMap<string, string>;
  isRoundRobin: boolean;
  pins: readonly { fixtureId: string; start: number; courtId: string }[];
}): EncodedConstraints;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { encodeConstraints } from "../board.ts";

const courts = new Map([["c-one", "11111111-1111-4111-8111-111111111111"]]);

describe("encodeConstraints", () => {
  it("resolves an @-sigil court ref to the seeded court id", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: { courts: ["@c-one"], matchMinutes: 45 },
      courtIdByRef: courts, isRoundRobin: true, pins: [],
    });
    expect(out.courtIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(out.matchMinutes).toBe(45);
  });

  it("REPORTS a hard constraint it cannot model rather than dropping it", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: {
        constraints: { hard: [{ type: "fixture_on_weekday", weekday: "FR", selector: {}, scope: {} }] },
      },
      courtIdByRef: courts, isRoundRobin: true, pins: [],
    });
    expect(out.hard).toHaveLength(0);
    expect(out.unmodelled).toEqual([
      { type: "fixture_on_weekday", reason: expect.stringContaining("not modelled") },
    ]);
  });

  // The value, not just the key: a mapper that read `count` off the wrong
  // member would still produce a one-entry array.
  it("carries max_fixtures_per_day's own count, not a default", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny",
      scheduleConfig: { constraints: { hard: [{ type: "max_fixtures_per_day", count: 3, scope: {} }] } },
      courtIdByRef: courts, isRoundRobin: true, pins: [],
    });
    expect(out.hard).toEqual([{ type: "max_fixtures_per_day", count: 3 }]);
  });

  it("refuses an unresolvable court ref instead of silently emitting the sigil", () => {
    expect(() =>
      encodeConstraints({
        divisionRef: "d-tiny", scheduleConfig: { courts: ["@c-missing"] },
        courtIdByRef: courts, isRoundRobin: true, pins: [],
      }),
    ).toThrow(/c-missing/);
  });

  it("defaults matchMinutes to the product's own default when the pack omits it", () => {
    const out = encodeConstraints({
      divisionRef: "d-tiny", scheduleConfig: {}, courtIdByRef: courts,
      isRoundRobin: true, pins: [],
    });
    expect(out.matchMinutes).toBe(30); // ScheduleConfig.matchMinutes default
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd $W && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=$S/t1.json scripts/bench/lib/__tests__/board.test.ts`
Expected: FAIL — `Failed to load .../board.ts`.

- [ ] **Step 3: Implement `board.ts`**

Types exactly as in the Interfaces block. `encodeConstraints`:
resolves `courts[]` and `blackouts[].court` `@`-sigils through `courtIdByRef`
(throwing with the ref name on a miss); converts every ISO time to epoch ms
and `not_before`/`not_after` `HHMM` to minutes-into-day; maps the four
modellable `HardConstraint` members and pushes every other `type` onto
`unmodelled` with a reason string. Defaults mirror `ScheduleConfig`'s own
(`matchMinutes: 30`, `gapMinutes: 0`, `perEntrantMinRest: 0`, empty arrays).

- [ ] **Step 4: Run to verify it passes**

Run: the Step 2 command.
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd $W && git add scripts/bench/lib/board.ts scripts/bench/lib/__tests__/board.test.ts
cd $W && git commit -m "feat(bench): T1 board.ts — the checker's transport-free seam"
```

---

### Task 2: `checker.ts` — the independent verifier

**Files:**
- Create: `scripts/bench/lib/checker.ts`
- Test: `scripts/bench/lib/__tests__/checker.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:

```ts
export interface CheckerReport {
  findings: readonly CheckerFinding[];
  unchecked: readonly { type: string; reason: string }[];  // === constraints.unmodelled
  clean: boolean;   // findings.length === 0
}
export function checkBoard(board: Board, constraints: EncodedConstraints): CheckerReport;
```

**Do NOT:** import any VALUE from `@seazn/engine`. Do not call `usableWindows`
— recompute containment from `BoardCourt.hours` / `.exceptions` directly.

- [ ] **Step 1: Write the failing tests — one violating board per rule**

Build a `clean` board helper first, then have each test perturb exactly one
thing. Sizes are asymmetric on purpose (3 fixtures, 2 courts, 4 entrants) so a
transposed index cannot pass.

```ts
import { describe, expect, it } from "vitest";
import { checkBoard } from "../checker.ts";
import { cleanBoard, cleanConstraints } from "./_board-fixtures.ts";

describe("checkBoard", () => {
  it("passes a clean board", () => {
    expect(checkBoard(cleanBoard(), cleanConstraints()).clean).toBe(true);
  });

  it("names BOTH fixtures of a court double-booking", () => {
    const b = cleanBoard();
    const f = [...b.fixtures];
    f[1] = { ...f[1], courtId: f[0].courtId, start: f[0].start, end: f[0].end };
    const r = checkBoard({ ...b, fixtures: f }, cleanConstraints());
    expect(r.findings.map((x) => x.kind)).toEqual(["court_double_booking"]);
    expect([...r.findings[0].fixtureIds].sort()).toEqual([f[0].fixtureId, f[1].fixtureId].sort());
  });

  it("flags a fixture inside a blackout", () => { /* move f[0] into constraints.blackouts[0] */ });
  it("flags a fixture outside every session window", () => { /* … */ });
  it("flags a fixture outside its own court's hours", () => { /* … */ });

  it("flags an entrant below rest, and reports measured vs required", () => {
    // two fixtures sharing entrant "e-a", 20 minutes apart, perEntrantMinRest 60
    const r = checkBoard(/* … */);
    expect(r.findings[0].kind).toBe("entrant_below_rest");
    expect(r.findings[0].measured).toBe(20);
    expect(r.findings[0].required).toBe(60);
  });

  it("flags a day cap breach at count+1, and passes at exactly count", () => {
    // BOTH directions: a rule that reds on >= would pass the first half alone
  });

  it("flags a pin that moved, and passes a pin that held", () => { /* … */ });
  it("flags one official on two overlapping fixtures", () => { /* … */ });

  it("REDS when a division that declared officials fetches none", () => {
    const b = cleanBoard();
    const f = b.fixtures.map((x) => ({ ...x, officialIds: [] }));
    const r = checkBoard({ ...b, fixtures: f }, { ...cleanConstraints(), /* declares officials */ });
    expect(r.findings.map((x) => x.kind)).toContain("officials_unreadable");
  });

  // ORDER-DIFFERENTIAL: every fixture is individually legal. Only the
  // sequence is wrong, so a rule that checked each row in isolation passes
  // this board and the test still fails.
  it("flags round 2 scheduled on a day before round 1", () => {
    const r = checkBoard(/* r1 on day 2, r2 on day 1, both in-window */, cleanConstraints());
    expect(r.findings[0].kind).toBe("round_order_day");
    expect(r.findings[0].fixtureIds).toHaveLength(2);
  });

  it("flags round 2 starting before round 1 on the SAME day", () => { /* round_order_same_day */ });

  it("does NOT apply round order to a non-round-robin stage", () => {
    const r = checkBoard(/* the disordered board */, { ...cleanConstraints(), isRoundRobin: false });
    expect(r.findings).toHaveLength(0);
  });

  it("forwards unmodelled constraints into unchecked, and stays clean", () => {
    const c = { ...cleanConstraints(), unmodelled: [{ type: "fixture_on_weekday", reason: "x" }] };
    const r = checkBoard(cleanBoard(), c);
    expect(r.clean).toBe(true);
    expect(r.unchecked).toEqual(c.unmodelled);
  });

  it("ignores unplaced fixtures rather than treating start=undefined as 0", () => {
    // epoch 0 is 1970 — a rule that coerced undefined would red every rule at once
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd $W && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=$S/t2.json scripts/bench/lib/__tests__/checker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `checker.ts`**

One small pure function per rule, each returning `CheckerFinding[]`;
`checkBoard` concatenates them and forwards `constraints.unmodelled` into
`unchecked`. Skip every fixture with `start === undefined` in every rule
(unplaced is Task 4's gate, not the checker's). Round order applies only when
`constraints.isRoundRobin`.

- [ ] **Step 4: Run to verify it passes**

Expected: PASS, ~15 tests.

- [ ] **Step 5: Prove no rule is decoration — mutate one at a time**

For each of the seven rules: delete its predicate body (`return []`), re-run,
confirm the suite REDS and that `numTotalTests` is unchanged, restore.
A collection-breaking mutant reports zero failures against a REDUCED total —
compare the total, not the failure count. Record the seven results in the
commit body.

- [ ] **Step 6: Commit**

```bash
cd $W && git add scripts/bench/lib/checker.ts scripts/bench/lib/__tests__/
cd $W && git commit -m "feat(bench): T2 checker.ts — seven rules recomputed, seven mutants killed"
```

---

### Task 3: `certificate.ts` — parent spec §6.3

**Files:**
- Create: `scripts/bench/lib/certificate.ts`
- Test: `scripts/bench/lib/__tests__/certificate.test.ts`

**Interfaces:**
- Consumes: Task 1's types, Task 2's `checkBoard`.
- Produces:

```ts
export type CertificateBranch =
  | "SKIPPED_NO_HISTORY" | "PACK_AUTHORING_BUG" | "PRODUCT_DEFECT"
  | "UNPLACED" | "FEASIBLE";
export interface CertificateVerdict {
  branch: CertificateBranch;
  reason: string;
  violations: readonly CheckerFinding[];
  red: boolean;
}
export function certify(input: {
  historical: readonly PackHistoricalAssignment[] | undefined;
  historyBoard: Board | undefined;      // history rendered into a Board
  constraints: EncodedConstraints;
  solverStatus: string | undefined;     // ScheduleSolverInfo.status
  placed: number; total: number;
}): CertificateVerdict;
```

- [ ] **Step 1: Write the failing tests**

```ts
it("SKIPPED_NO_HISTORY when the pack declares none, and never reds", () => {
  const v = certify({ historical: undefined, historyBoard: undefined, constraints, solverStatus: "ok", placed: 3, total: 3 });
  expect(v.branch).toBe("SKIPPED_NO_HISTORY");
  expect(v.red).toBe(false);
  expect(v.reason).toMatch(/no historicalAssignment/i);
});

it("PACK_AUTHORING_BUG when the REAL timetable violates our own encoding", () => {
  // history double-books a court -> our encoding is stricter than reality
  expect(certify({ … , solverStatus: "infeasible" }).branch).toBe("PACK_AUTHORING_BUG");
});

// ORDER IS THE PROTOCOL: identical inputs except history's legality flip
// the branch, so a certify() that read solverStatus first fails here.
it("reads history BEFORE the solver verdict", () => {
  const bad = certify({ historyBoard: violatingHistory, solverStatus: "infeasible", … });
  const good = certify({ historyBoard: cleanHistory,    solverStatus: "infeasible", … });
  expect(bad.branch).toBe("PACK_AUTHORING_BUG");
  expect(good.branch).toBe("PRODUCT_DEFECT");
});

it("PRODUCT_DEFECT reds", () => { expect(certify({ … }).red).toBe(true); });

it("UNPLACED when placed < total, even with a clean history and status ok", () => {
  expect(certify({ …, solverStatus: "ok", placed: 2, total: 3 }).branch).toBe("UNPLACED");
  expect(certify({ …, solverStatus: "ok", placed: 2, total: 3 }).red).toBe(true);
});

it("FEASIBLE when history is clean and a full board was produced", () => {
  expect(certify({ …, solverStatus: "ok", placed: 3, total: 3 }).red).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails.** Expected: module not found.
- [ ] **Step 3: Implement.** Branch order, top to bottom: no history →
  `SKIPPED_NO_HISTORY`; `checkBoard(historyBoard, constraints)` not clean →
  `PACK_AUTHORING_BUG`; `placed < total` → `UNPLACED`; `solverStatus ===
  "infeasible"` → `PRODUCT_DEFECT`; else `FEASIBLE`. Reuse `checkBoard`
  verbatim — a second implementation would break the claim the certificate
  makes.
- [ ] **Step 4: Run to verify it passes.** Expected: PASS, 6 tests.
- [ ] **Step 5: Commit** — `feat(bench): T3 certificate.ts — §6.3, history before verdict`

---

### Task 4: `schedule.ts` — the driver and the engine assertion

**Files:**
- Create: `scripts/bench/lib/schedule.ts`
- Test: `scripts/bench/lib/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: Task 1's types; `SeedTransport`-style DI from `lib/seed.ts`;
  `resolveRunId` from `lib/report.ts` (already exported, `:180`).
- Produces:

```ts
export interface ScheduleOutcome {
  divisionRef: string; divisionId: string; stageId: string;
  requestedEngine: "optimized" | "greedy" | "both";
  actualEngine?: "greedy" | "optimized";
  solverStatus?: string; notSearchedReason?: string;
  mode?: "build" | "reflow" | "polish";
  budgetExpired?: boolean; tiersCompleted?: number; tiersTotal?: number;
  metrics?: { makespanMinutes: number; worstIdleGapMinutes: number;
              courtImbalanceMinutes: number; placed: number; total: number };
  blockingCount: number;
  warnKindTally: Readonly<Record<string, number>>;
  unplacedCount: number;
  wallMs: number;
  errors: readonly string[];
}
export interface ScheduleLayerResult {
  outcomes: readonly ScheduleOutcome[];
  boards: readonly Board[];
  constraints: readonly EncodedConstraints[];
}
export async function runScheduleLayer(input: ScheduleLayerInput): Promise<ScheduleLayerResult>;
export async function writeEngineArtifact(reportDir: string, runId: string, engine: string, payload: unknown): Promise<string>;
export async function readEngineArtifacts(reportDir: string, runId: string): Promise<Record<string, unknown>>;
```

- [ ] **Step 1: Write the failing tests** — all against a fake transport, no live server.

```ts
it("asserts the engine that actually ran and reds on a silent greedy fallback", async () => {
  const t = fakeTransport({ auto: { solver: { engine: "greedy", status: "solver_unavailable" } } });
  const r = await runScheduleLayer({ …, engine: "optimized", transport: t });
  expect(r.outcomes[0].errors.join(" ")).toMatch(/expected optimized.*got greedy.*solver_unavailable/i);
});

it("passes when the engine matches, and records it either way", async () => { /* both directions */ });

it("--engine both asserts nothing about the engine", async () => {
  const r = await runScheduleLayer({ …, engine: "both", transport: greedyTransport });
  expect(r.outcomes[0].errors).toEqual([]);
  expect(r.outcomes[0].actualEngine).toBe("greedy");
});

// The board must be FETCHED. A driver that echoed its own POST body passes a
// naive test; this one fails it, because the fetch returns a DIFFERENT court.
it("builds the Board from GET /fixtures, not from the assignments it posted", async () => {
  const t = fakeTransport({
    auto: { assignments: [{ fixture_id: "f1", scheduled_at: "…T09:00Z", court_id: "court-POSTED" }] },
    fixtures: [{ id: "f1", scheduled_at: "…T09:00Z", court_id: "court-FETCHED", … }],
  });
  const r = await runScheduleLayer({ …, transport: t });
  expect(r.boards[0].fixtures[0].courtId).toBe("court-FETCHED");
});

it("records a duration_disagreement when auto's ends_at contradicts matchMinutes", async () => { /* … */ });
it("snapshots locks BEFORE auto and carries them as pins", async () => { /* … */ });
it("schedules EVERY division it is given, not just the first", async () => {
  const r = await runScheduleLayer({ divisions: [dA, dB], … });
  expect(r.outcomes.map((o) => o.divisionRef)).toEqual(["d-a", "d-b"]);
});
it("tallies warn rows by details.kind, never by code", async () => { /* … */ });
it("writes engine-<engine>.json and reads a sibling leg back", async () => { /* … */ });
```

- [ ] **Step 2: Run to verify it fails.** Expected: module not found.
- [ ] **Step 3: Implement `schedule.ts`** — the seven-step walk in design §3.2.
- [ ] **Step 4: Run to verify it passes.** Expected: PASS, ~10 tests.
- [ ] **Step 5: Commit** — `feat(bench): T4 schedule.ts — N divisions, engine asserted, board fetched`

---

### Task 5: `believability.ts` — report-only

**Files:** Create `scripts/bench/lib/believability.ts`; test `…/__tests__/believability.test.ts`.

**Interfaces:** Consumes Task 1 + Task 4's `ScheduleOutcome`; imports
`assessHealth` from `@seazn/engine/scheduling` (a VALUE import, allowed here —
the ban is on `checker.ts`).

```ts
export interface BelievabilityReport {
  metrics: readonly { key: string; score: number }[];
  engineDelta?: { greedy: EngineSnapshot; optimized: EngineSnapshot; makespanDeltaMinutes: number; courtImbalanceDeltaMinutes: number };
  similarityToHistoricalPct?: number;
}
export function assessBelievability(input: …): BelievabilityReport;
```

- [ ] **Step 1: Failing tests** — metrics mapped from `assessHealth`;
  `homeAwayAlternation` ABSENT (not zero) for a non-round-robin stage; delta
  `undefined` when only one leg's artifact exists, and present with the right
  sign when both do; similarity `undefined` without history.
- [ ] **Step 2: Verify fails.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Verify passes.**
- [ ] **Step 5: Commit** — `feat(bench): T5 believability.ts — metrics, engine delta, similarity`

---

### Task 6: Wiring — `_tiny`, the suite, the CLI, the report

**Files:**
- Modify: `scripts/bench/lib/suites/tiny.ts`, `scripts/bench/bench.ts`,
  `scripts/bench/lib/report.ts`, `scripts/bench/packs/build-packs/_tiny.ts`,
  `scripts/bench/packs/_tiny.json`
- Test: extend `…/__tests__/tiny-suite.test.ts`, `…/__tests__/bench-cli.test.ts`, `…/__tests__/report.test.ts`

- [ ] **Step 1: `_tiny` gains venues and per-division schedule config.**
  One venue, **two** courts (court double-booking needs somewhere to happen).
  Both `d-tiny` and `d-badminton` get a `scheduleConfig` with `courts` naming
  the venue's courts by `@`-sigil. Regenerate `_tiny.json` from
  `build-packs/_tiny.ts`; do not hand-edit the JSON.
- [ ] **Step 2: Delete `tiny.ts`'s ad-hoc venue/court creation** (`:974-993`)
  and let `seedSuite` seed `pack.venues` (`seed.ts:332-378`) — the pack becomes
  the one source. Check the `--keep` short-circuit path (`:99-108`) still
  resolves court ids.
- [ ] **Step 3: Replace the scheduling half** (`:1065-1200`) with
  `runScheduleLayer` → `checkBoard` → `certify` → `assessBelievability`, over
  EVERY division. Widen `AutoScheduleOut` (`:717-726`). Fix the stale
  `schemas.ts:1496-1542` pin (F5).
- [ ] **Step 4: `suite_scheduled` pino event**, one per division, carrying
  `engine`, `status`, `wallMs`, `conflicts`, `checkerVerdict`,
  `certificateBranch` — the prompt's acceptance line, verbatim fields.
- [ ] **Step 5: `bench.ts` `--engine`** — thread the resolved report dir in;
  keep the three values; delete the "not honoured" log.
- [ ] **Step 6: `report.ts` sections** — scheduling, checker (with
  `unchecked` rendered beside the verdict), certificate branch,
  believability, engine delta. Append to the `sections` array at `:363-369`.
- [ ] **Step 7: Run the full bench unit suite.** Expected: previous total (721)
  plus this plan's new tests, zero failures. Compare the TOTAL.
- [ ] **Step 8: Commit** — `feat(bench): T6 wire the scheduling layer through _tiny, the CLI and the report`

---

### Task 7: The independence regression, and the live gates

**Files:** Create `scripts/bench/lib/__tests__/checker-independence.test.ts`.

- [ ] **Step 1: The bypass-and-restore regression, literally.**

A board that satisfies `/validate` — trivial, since a blackout violation is
not `blocking` (design §1.2) — and violates a checker rule. Assert BOTH
halves: with the checker on, the suite verdict is red; with it bypassed, the
same board goes green. A test that asserted only the red half cannot tell a
working checker from a gate that reds on everything.

```ts
it("reds on a board /validate calls clean", () => {
  const verdict = judge({ validateConflicts: [], checker: checkBoard(blackoutViolatingBoard, c) });
  expect(verdict.red).toBe(true);
});
it("goes green with the checker bypassed — proving the checker is what reds it", () => {
  const verdict = judge({ validateConflicts: [], checker: { findings: [], unchecked: [], clean: true } });
  expect(verdict.red).toBe(false);
});
```

- [ ] **Step 2: Full unit gate.** `./packages/engine/node_modules/.bin/vitest run --reporter=json
  --outputFile=$S/b4.json scripts/bench`, then the `jq` line. Paste raw counts.
- [ ] **Step 3: Lint.** `rtk proxy npm run lint`; judge on `✖ N problems`.
- [ ] **Step 4: Live leg A — placement UP.**
  `seazn-env rebuild --label b04`, then
  `npm run bench:scheduler -- --suite _tiny --wipe --engine optimized`.
  Resolve the report path from THIS run's own log (it is SHA-keyed; a commit
  moves it). Expect: layer-1 zero blocking, checker clean, certificate
  `SKIPPED_NO_HISTORY`, `engine-optimized.json` written.
- [ ] **Step 5: Live leg B — placement DOWN.**
  `lsof -t -i :50536 | xargs kill`; confirm `lsof -t -i :50536` prints nothing.
  `npm run bench:scheduler -- --suite _tiny --wipe --engine greedy`.
  Expect greedy asserted, `engine-greedy.json` written. Note:
  `schedule-build-honours-locks` in `apps/web` reds 4 tests with placement
  down — environmental, not a regression.
- [ ] **Step 6: The delta.** `npm run bench:scheduler -- --suite _tiny --keep
  --engine both` — the report's engine-delta section must now be populated
  from both artifacts. Restart placement afterwards.
- [ ] **Step 7: Review loop.** `reviewer` agent over the full diff, then
  `/code-review`. Loop until clean AND green. Never skip this because the
  suite is green — reviews after a green push have found live defects twice.
- [ ] **Step 8: PR.** One PR, body naming: the six findings (design §5), the
  nondeterminism deferral and its reason, any unmodelled constraints the
  checker reported, and the raw counts from Steps 2–6.

---

## Self-review

**Spec coverage.** Design §2.1 → T4 + T6/5. §2.2 → T4 (`blockingCount`,
`warnKindTally`). §2.3 → T2 constraint + T5. §3.1 → T1. §3.2 → T4. §3.3 → T2.
§3.4 → T3. §3.5 → T5. §4.1 → T4 step 1's fetched-vs-posted test. §4.2 → T4
`duration_disagreement`. §4.3 → T2 `officials_unreadable`. §4.4 → T4 pins +
T6 step 1. §4.5 → deferral recorded, T7 step 8. §5 F1–F3, F6 → T7 step 8
(report only). F4, F5 → T6 step 3. §6 → T2 step 5, T7 step 1. §7 → T6 steps 1–3.

**Type consistency.** `CheckerFinding` / `CheckerFindingKind` /
`EncodedConstraints` / `Board` are declared once in T1 and referenced by
name only thereafter. `checkBoard` has one signature, used identically by T3
and T6. `unmodelled` (on `EncodedConstraints`) is forwarded to `unchecked`
(on `CheckerReport`) — two names, one list, stated in T2's Interfaces block.
