# B07a — match day played by hand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bench play a match the way a person does — a scorer tapping the real pad on a phone, an organiser finalizing in the console — and advance every division, not just the first.

**Architecture:** A sport-agnostic tap driver (`scripts/bench/lib/drivers/scorer.ts`) drives the shipped pad through `playwright`, one browser context per concurrent fixture, with a per-sport adapter turning each pack event into taps. The runner gains a per-division play mode (`tap | api | import`) declared on the suite registry entry, so `_tiny`'s generic division is tapped while suite 11 keeps both existing write paths. Everything else is the debt B06 left: the loser is compared, group tables are derived per pool, the qualifier order comes from the progression rule, and the report finally writes its `adaptations` field.

**Tech Stack:** TypeScript under `node --experimental-strip-types` (no `enum`, no `namespace`, every relative import carries `.ts`), zod 4.4.3, vitest, plain `playwright` (never `@playwright/test` — that package's `expect` is not available to the bench).

**Spec:** `docs/superpowers/specs/bench-product-value/designs/2026-09-11-b07-match-day-and-carrom-design.md` (owner-approved 2026-09-11, D1–D8). Programme rules: `bench-prompts/_RULES.md` → `_PACK-PLAYBOOK.md` → `bench-prompts/_INDEX.md`.

## Global Constraints

- **PackSchema is FROZEN** (froze at B06b's merge, #770). This wave changes it in no way. Group membership comes from the fixture ext key, the play mode from the suite registry, and the historical podium from the suite entry — each chosen because it needs no schema field.
- **The oracle direction is sacred** (`_RULES.md` §3): packs carry raw events, the engine derives outcomes. Nothing this wave adds may write an outcome, a verdict, or a score into the DB.
- **No hidden API fallback on a tapped division.** If a control cannot be tapped, that is a product finding recorded in the PR, never a reason to POST the event instead. A tap driver that quietly falls back reproduces exactly the trap `_INDEX.md` records as "API-driven e2e blind to pad payloads".
- **Gates vs measurements:** correctness reds the run; timings NEVER do. Tap counts and per-match wall times are reported, never asserted.
- **Every user-facing string is out of scope.** This wave adds `data-*` attributes only — no copy, no layout — so no locale work is owed. Bench CLI/report strings stay i18n-exempt (dev tool).
- Runtime: no TS `enum`, no `namespace`, no emit-dependent syntax. Engine imports are subpath-only; `scripts/bench` never imports from `apps/web`.
- Gate command (the `apps/web` suite and `turbo` never see `scripts/bench`):
  ```
  ./packages/engine/node_modules/.bin/vitest run --reporter=json \
    --outputFile=/tmp/b07a.json --testTimeout=30000 scripts/bench
  ```
  Then `npm run typecheck:scripts` (expect 0) and `rtk proxy npm run lint:scripts` (expect no `✖`). Judge green ONLY from the JSON reporter's `numPassedTests`/`numTotalTests` — rtk summaries print `PASS(0) FAIL(0)` for a suite that failed to COLLECT.
- `strip-types-loadable.test.ts` generates one case per bench MODULE, so each new `lib/**.ts` file adds one test. Counts rise by more than the tests written.
- **`apps/web` vitest is `environment: "node"`.** No unit test can see a tap, a class cascade, or a real hit area. Every claim about what a person can tap is settled by a live run, never by a green suite.

---

## What was pinned while writing this plan

Record these in the PR body; each was read in the tree, not assumed.

1. **There is no GET helper for a fixture's ledger anywhere in `scripts/bench`.** The only `/events` uses are POSTs (`lib/simulate.ts:254`, `lib/dls-gate.ts:530`) and the import route (`lib/import.ts:371`). State reads live in `lib/oracle.ts` (`fetchFixtureSideLines:1403`, `fetchFixtureModuleState:1572`), both hitting `GET /api/v1/fixtures/{id}/state`. Task 1 adds the ledger reader the tap driver needs.
2. **`SETTLED_STATUSES` already accepts `finalized`** (`lib/oracle.ts:1273`: decided, finalized, forfeited, abandoned). So `compareMatches` cannot express "this fixture must be finalized" — a tapped fixture that stops at `decided` passes it. Task 10 adds a separate check rather than narrowing that set, which the API paths still need.
3. **The expected qualifier list is built from the one table with no `poolKey`** (`lib/suites/run-suite.ts:3249-3258`), taking every row sorted by rank. A pooled stage declares one table PER POOL, so that lookup finds nothing and the advancement oracle silently compares an empty list. Task 5 replaces it.
4. **Stage 0 skips any pooled table outright** with `standings.pool_unbindable` (`lib/validate-pack.ts:1656-1665`), and `deriveStandings` returns only `pools[0]` (`:2161-2166`). Task 4 fixes both halves; they are one defect seen from two ends. **[Task 13 documentation-drift correction: Task 4 shipped this — `pool_unbindable` no longer appears anywhere in `validate-pack.ts`, and `deriveStandings` takes an optional `poolKey`. This bullet describes the PRE-Task-4 state, kept for the record of what was found; do not read it as current behaviour.]**
5. **Advancement is hard-wired to the first division.** The block is gated on `division0`/`stage0`/`stage1` (`run-suite.ts:3231-3234`), and every other division is batch-imported with no stage step (`:3116-3160`). Task 6 loops.
6. **News publishes every streamed fixture of the first division's last stage** (`run-suite.ts:4694-4723`), which B06's D6 defined as "the two semis and the final published, the rest asserted still draft". Task 12 narrows it.
7. **`adaptations` is declared in `SuiteReport` (`lib/report.ts:674`) and written by nothing.** `provenancePct` is written in the return literal at `:4833-4856`; the adaptations writer belongs beside it.
8. **The oracle verdict contract is enforced by a zod `superRefine`** (`lib/report.ts:113-172`): `verdict: "no_subject"` requires `subject !== true`, and `passed === (verdict !== "fail")`. Every oracle this wave adds obeys it, and logs through `oracleLogFields(kind, verdict)` with the `oracle_checked` message.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/bench/lib/ledger.ts` | **New.** Reads a fixture's ledger and status over HTTP: `fetchFixtureLedger`, `fetchFixtureStatus`. The one place the tap driver learns what the server recorded. |
| `scripts/bench/lib/__tests__/ledger.test.ts` | Unit + regression for the reader, including the `since_seq` boundary. |
| `scripts/bench/lib/oracle.ts` | `firstMismatch` also compares the loser and an award's method. |
| `scripts/bench/lib/qualifiers.ts` | **New.** Pure: per-pool tables + a progression rule → the expected qualifier order (A1, B1, C1, D1, A2 …). No HTTP, no product import. |
| `scripts/bench/lib/validate-pack.ts` | Stage 0 derives a table per pool (group read from the ext key) instead of skipping pooled tables. |
| `scripts/bench/lib/report.ts` | Writes and renders the adaptations count; renders the certificate row (already) under a test that reads the row text. |
| `scripts/bench/lib/suites/types.ts` | `SuiteDefinition` gains an optional per-division play-mode map. |
| `scripts/bench/lib/suites/registry.ts` | `_tiny` declares its generic division as `tap`. |
| `scripts/bench/lib/suites/run-suite.ts` | Play-mode dispatch, advancement for every division, the finalize requirement, the news subset, the adaptations writer. |
| `scripts/bench/lib/drivers/scorer.ts` | **New.** The tap driver: device link handed over by the organiser, scorer taps on a phone viewport, hold flushed like a person, ledger checked after every commit, organiser finalizes. |
| `scripts/bench/lib/drivers/adapters/generic.ts` | **New.** Generic skin adapter (scorebug halves, settle tile). |
| `apps/web/src/components/v2/**` | `data-testid` / `data-side` attributes only. |
| `apps/web/e2e/carrom-pad.spec.ts` | Switches to the new hooks — what proves they are live. |

---

### Task 1: The ledger reader the tap driver needs

**Files:**
- Create: `scripts/bench/lib/ledger.ts`
- Test: `scripts/bench/lib/__tests__/ledger.test.ts`

**Interfaces:**
- Consumes: `Session`, `raw` (`lib/http.ts:15`, `:36`), `ProbeTransport` (the `{ raw }` shape `lib/simulate.ts:70` uses).
- Produces:
  - `fetchFixtureLedger(base: string, session: Session, fixtureId: string, sinceSeq: number, transport?: LedgerTransport): Promise<readonly LedgerRow[]>` where `LedgerRow = { id: string; seq: number; type: string; payload: unknown }`
  - `fetchFixtureStatus(base: string, session: Session, fixtureId: string, transport?: LedgerTransport): Promise<{ status: string; lastSeq: number }>`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/bench/lib/__tests__/ledger.test.ts
import { describe, expect, it } from "vitest";
import { fetchFixtureLedger, fetchFixtureStatus } from "../ledger.ts";
import { newSession } from "../http.ts";

function transportReturning(byPath: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    raw: async (_base: string, _s: unknown, path: string) => {
      calls.push(path);
      const json = byPath[path];
      if (json === undefined) throw new Error(`unexpected path ${path}`);
      return { status: 200, json: { ok: true, data: json } };
    },
  };
}

describe("fetchFixtureLedger", () => {
  it("asks only for rows after the seq it was given, and returns them in seq order", async () => {
    const t = transportReturning({
      "/api/v1/fixtures/f1/events?since_seq=2": [
        { id: "e4", seq: 4, type: "carrom.board.summary", payload: { winner: "en1" } },
        { id: "e3", seq: 3, type: "carrom.board.summary", payload: { winner: "en2" } },
      ],
    });
    const rows = await fetchFixtureLedger("http://x", newSession(), "f1", 2, t);
    expect(rows.map((r) => r.seq)).toEqual([3, 4]);
    expect(t.calls).toEqual(["/api/v1/fixtures/f1/events?since_seq=2"]);
  });

  it("returns an empty list when nothing has been recorded yet", async () => {
    const t = transportReturning({ "/api/v1/fixtures/f1/events?since_seq=0": [] });
    expect(await fetchFixtureLedger("http://x", newSession(), "f1", 0, t)).toEqual([]);
  });
});

describe("fetchFixtureStatus", () => {
  it("reports the status and the server's own last_seq", async () => {
    const t = transportReturning({
      "/api/v1/fixtures/f1/state": { status: "in_play", last_seq: 7, outcome: null },
    });
    expect(await fetchFixtureStatus("http://x", newSession(), "f1", t)).toEqual({
      status: "in_play",
      lastSeq: 7,
    });
  });

  it("reads a fixture nobody has scored as scheduled at seq 0", async () => {
    const t = transportReturning({
      "/api/v1/fixtures/f1/state": { status: "scheduled", last_seq: 0, outcome: null },
    });
    expect(await fetchFixtureStatus("http://x", newSession(), "f1", t)).toEqual({
      status: "scheduled",
      lastSeq: 0,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a && \
./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/t1.json \
  scripts/bench/lib/__tests__/ledger.test.ts
```
Expected: the suite fails to collect — `Cannot find module '../ledger.ts'`.

- [ ] **Step 3: Write `scripts/bench/lib/ledger.ts`**

```ts
// The tap driver's eyes. Everything else in scripts/bench posts events and trusts
// the array index as the seq; a driver that taps a real pad cannot do that, because
// the pad decides when a held tap is sent and the server assigns the seq.
import { raw, type Session } from "./http.ts";

export interface LedgerTransport {
  raw: typeof raw;
}

const defaultLedgerTransport: LedgerTransport = { raw };

export interface LedgerRow {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

function rowsOf(data: unknown): readonly LedgerRow[] {
  if (!Array.isArray(data)) return [];
  const rows: LedgerRow[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.seq !== "number" || typeof r.type !== "string") continue;
    rows.push({ id: String(r.id ?? ""), seq: r.seq, type: r.type, payload: r.payload });
  }
  // The route's order is not part of its contract; the driver compares position by
  // position, so sort rather than trust it.
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function fetchFixtureLedger(
  base: string,
  session: Session,
  fixtureId: string,
  sinceSeq: number,
  transport: LedgerTransport = defaultLedgerTransport,
): Promise<readonly LedgerRow[]> {
  const path = `/api/v1/fixtures/${fixtureId}/events?since_seq=${sinceSeq}`;
  const { json } = await transport.raw(base, session, path, "GET");
  return rowsOf((json as { data?: unknown }).data);
}

export async function fetchFixtureStatus(
  base: string,
  session: Session,
  fixtureId: string,
  transport: LedgerTransport = defaultLedgerTransport,
): Promise<{ status: string; lastSeq: number }> {
  const path = `/api/v1/fixtures/${fixtureId}/state`;
  const { json } = await transport.raw(base, session, path, "GET");
  const data = (json as { data?: Record<string, unknown> }).data ?? {};
  return {
    status: typeof data.status === "string" ? data.status : "(absent)",
    lastSeq: typeof data.last_seq === "number" ? data.last_seq : 0,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Same command as Step 2. Expected: `numPassedTests: 4`, `numFailedTests: 0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a
/usr/bin/git add scripts/bench/lib/ledger.ts scripts/bench/lib/__tests__/ledger.test.ts
/usr/bin/git commit -m "feat(bench): read a fixture's ledger and status, the tap driver's eyes"
```

---

### Task 2: `compareMatches` compares the loser, and an award's method

**Files:**
- Modify: `scripts/bench/lib/oracle.ts:1318-1355` (`firstMismatch`)
- Test: `scripts/bench/lib/__tests__/oracle-matches.test.ts`

**Interfaces:**
- Consumes: `ExpectedMatchRow`, `ActualMatchRow`, `MatchMismatch`, `MatchMismatchField` (all in `lib/oracle.ts`).
- Produces: `MatchMismatchField` gains `"loser"`. `firstMismatch` compares, in order: status → outcome kind → winner → **loser** → method (**for `win` AND `award`**) → per-side lines.

**Why this task exists:** B06's D4 said the bench asserts its own draw; nothing was built, and nothing reads round-0 pairings back. The winner alone cannot see a wrong pairing: swap an opponent and the same player still wins. The loser is the cheapest true check on the draw, and B07b's carrom bracket depends on it.

- [ ] **Step 1: Write the failing tests**

```ts
// append to scripts/bench/lib/__tests__/oracle-matches.test.ts
describe("compareMatches — the losing side", () => {
  const expected = [
    {
      divisionRef: "d-a",
      fixtureExtKey: "se-r0-i0",
      outcome: { kind: "win" as const, winner: "en-more", loser: "en-lenus" },
    },
  ];

  it("reds when the right winner beat the wrong opponent", () => {
    const result = compareMatches(expected, [
      {
        fixtureExtKey: "se-r0-i0",
        status: "finalized",
        outcome: { kind: "win", winner: "en-more", loser: "en-azmeen" },
        perSide: undefined,
      },
    ]);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({
      field: "loser",
      expected: "en-lenus",
      actual: "en-azmeen",
    });
  });

  it("passes when both sides match — the positive pair", () => {
    const result = compareMatches(expected, [
      {
        fixtureExtKey: "se-r0-i0",
        status: "finalized",
        outcome: { kind: "win", winner: "en-more", loser: "en-lenus" },
        perSide: undefined,
      },
    ]);
    expect(result.mismatches).toEqual([]);
    expect(result.checked).toBe(1);
  });
});

describe("compareMatches — an award's method", () => {
  it("reds when a walkover is recorded with a different reason", () => {
    const result = compareMatches(
      [
        {
          divisionRef: "d-a",
          fixtureExtKey: "se-r1-i0",
          outcome: { kind: "award" as const, winner: "en-more", method: "walkover" },
        },
      ],
      [
        {
          fixtureExtKey: "se-r1-i0",
          status: "forfeited",
          outcome: { kind: "award", winner: "en-more", method: "disqualification" },
          perSide: undefined,
        },
      ],
    );
    expect(result.mismatches[0]).toMatchObject({
      field: "method",
      expected: "walkover",
      actual: "disqualification",
    });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a && \
./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/t2.json \
  scripts/bench/lib/__tests__/oracle-matches.test.ts
```
Expected: the loser test fails with `mismatches` empty (length 0, not 1) and the award-method test likewise — today `method` is compared only when `row.outcome.kind === "win"`.

- [ ] **Step 3: Extend `firstMismatch`**

Insert after the winner comparison, and widen the method branch. `outcomeLoserOf` is a new sibling of the existing `outcomeWinnerOf`.

```ts
  const expectedLoser = outcomeLoserOf(row.outcome);
  const actualLoser = outcomeLoserOf(got);
  if (expectedLoser !== undefined && expectedLoser !== actualLoser) {
    return at("loser", expectedLoser, actualLoser ?? "(none)");
  }

  const expectedMethod = outcomeMethodOf(row.outcome);
  if (expectedMethod !== undefined) {
    const actualMethod = outcomeMethodOf(got);
    if (expectedMethod !== actualMethod) {
      return at("method", expectedMethod, actualMethod ?? "(absent)");
    }
  }
```

`outcomeLoserOf` and `outcomeMethodOf` read the field when the outcome kind declares it and return `undefined` otherwise, so an outcome shape without a loser (an award, a draw, `no_result`) is skipped rather than reported as `(none)`. Add `"loser"` to `MatchMismatchField`.

- [ ] **Step 4: Run the whole bench suite**

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a && \
./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/t2.json \
  --testTimeout=30000 scripts/bench && \
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/t2.json
```
Expected: `failed: 0`. A suite-11 fixture that now reds here is a REAL finding — it means a declared match's loser never matched — and is recorded, not edited away.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a
/usr/bin/git add scripts/bench/lib/oracle.ts scripts/bench/lib/__tests__/oracle-matches.test.ts
/usr/bin/git commit -m "fix(bench): a match oracle that ignores the loser cannot see a wrong pairing"
```

---

### Task 3: The report writes its adaptations, and the certificate row is read

**Files:**
- Modify: `scripts/bench/lib/report.ts` (renderer beside the provenance line ~`:950`)
- Modify: `scripts/bench/lib/suites/run-suite.ts:4833-4856` (the return literal, beside `provenancePct`)
- Test: `scripts/bench/lib/__tests__/report.test.ts`

**Interfaces:**
- Consumes: `SuiteReport.adaptations` (`lib/report.ts:674`, `z.array(z.string()).optional()`), `PackAdaptation` (`lib/pack-schema.ts:1413`), `computeProvenance` (`lib/provenance.ts:25`).
- Produces: a report whose markdown states the adaptation count and lists them; a certificate-row test that reads the ROW, not the heading.

**Why this task exists:** suite 10's whole claim is honest accounting. `provenancePct` says how much was generated; the adaptation count says how much was reshaped. The field has existed since B01 with no writer. And the only existing test of a `SKIPPED_NO_HISTORY` render asserts the section heading (`lib/__tests__/tiny-suite-scheduling.test.ts:933-942`), so the row text has never been checked — suite 10 is the first pack whose certificate is absent by design.

- [ ] **Step 1: Write the failing tests**

```ts
// append to scripts/bench/lib/__tests__/report.test.ts
describe("adaptations in the markdown", () => {
  it("states the count and lists each adaptation", () => {
    const md = renderReport(
      reportWith({
        suite: "suite10",
        adaptations: [
          "team and doubles events dropped: the product models no team tie",
          "8 boards in every round: maxBoards cannot vary by stage",
        ],
      }),
    );
    expect(md).toContain("2 adaptations");
    expect(md).toContain("the product models no team tie");
    expect(md).toContain("maxBoards cannot vary by stage");
  });

  it("says so plainly when a pack reshaped nothing", () => {
    const md = renderReport(reportWith({ suite: "suite11", adaptations: [] }));
    expect(md).toContain("0 adaptations");
  });
});

describe("the certificate row itself", () => {
  it("renders a division with no history as SKIPPED_NO_HISTORY, not red", () => {
    const md = renderReport(
      reportWithCertificate({
        suite: "suite10",
        divisionRef: "d-mens",
        branch: "SKIPPED_NO_HISTORY",
        red: false,
        reason: "the division declares no historicalAssignment",
      }),
    );
    expect(md).toContain("| suite10 | d-mens | `SKIPPED_NO_HISTORY` | no |");
    expect(md).toContain("the division declares no historicalAssignment");
  });
});
```

`reportWith` / `reportWithCertificate` are the file's existing fixture builders; extend them with the new fields rather than writing new ones.

- [ ] **Step 2: Run and watch them fail**

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a && \
./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/t3.json \
  scripts/bench/lib/__tests__/report.test.ts
```
Expected: the two adaptation tests fail (`"2 adaptations"` absent — nothing renders the field). The certificate row test PASSES already: the renderer is correct and only the test was missing. Keep it — it is the regression guard for the branch suite 10 depends on.

- [ ] **Step 3: Render the adaptations, then write them**

In `report.ts`, beside the provenance line:

```ts
function renderAdaptations(report: SuiteReportT): string {
  const rows = report.adaptations ?? [];
  const lines = [`- Adaptations: ${rows.length} adaptations`];
  for (const row of rows) lines.push(`  - ${row}`);
  return lines.join("\n");
}
```

In `run-suite.ts`'s return literal, beside `provenancePct: provenance.realPct`:

```ts
  adaptations: pack.meta.adaptations.map((a) => `${a.kind}: ${a.detail}`),
```

Read the real field names off `PackAdaptation` (`lib/pack-schema.ts:1413`) before writing this line; if they differ, use the real ones — the point is that every declared adaptation reaches the report, not the exact wording.

- [ ] **Step 4: Run the whole bench suite**

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a && \
./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/t3.json \
  --testTimeout=30000 scripts/bench && \
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/t3.json
```
Expected: `failed: 0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a
/usr/bin/git add scripts/bench/lib/report.ts scripts/bench/lib/suites/run-suite.ts \
  scripts/bench/lib/__tests__/report.test.ts
/usr/bin/git commit -m "feat(bench): the report says how much of a pack was reshaped, not just generated"
```

---

### Task 4: Stage 0 derives a table per pool

**[Task 13 documentation-drift correction: DONE, this wave.** `pool_unbindable`
is gone from `validate-pack.ts` and `deriveStandings` takes the `poolKey?`
parameter this task specified. The brief below is left as written — it is
the task's own instructions, not a claim about current behaviour — but a
reader landing here after Task 4 merged should not take "today every one of
them is skipped" (below) as still true.]**

**Files:**
- Modify: `scripts/bench/lib/validate-pack.ts:1656-1665` (the `standings.pool_unbindable` skip) and `:2032-2166` (`deriveStandings`)
- Test: `scripts/bench/lib/__tests__/validate-pack-standings.test.ts`

**Interfaces:**
- Produces: `deriveStandings(division, stage, streams, seedByEntrant, folded, poolKey?)` — when `poolKey` is given, only that pool's fixtures fold into the table, and the pool's own rows are returned instead of `pools[0]`.

**Why this task exists:** a pooled stage declares one `expected.tables` row per pool. Today every one of them is skipped with a warning, and `deriveStandings` can only ever return the first pool, so a four-pool division has no offline standings check at all. Suite 10 is four pools per division.

**The group is readable without a schema change.** A pooled round robin emits ext keys prefixed `p{poolKey}-` (`apps/web/src/server/usecases/stages.ts:797`, `packages/engine/src/scheduling/roundrobin.ts:140`), so a stream's own `fixtureExtKey` says which pool it belongs to.

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/bench/lib/__tests__/validate-pack-standings.test.ts
import { describe, expect, it } from "vitest";
import { validatePack } from "../validate-pack.ts";
import { pooledFixturePack } from "./fixtures/pooled-pack.ts";

describe("pooled standings", () => {
  it("checks each pool's table instead of warning that it cannot", () => {
    const result = validatePack(pooledFixturePack(), { expectedSuite: "fixture" });
    const codes = result.findings.map((f) => f.code);
    expect(codes).not.toContain("standings.pool_unbindable");
    expect(result.ok).toBe(true);
  });

  it("reds when pool B's declared order disagrees with pool B's own results", () => {
    const pack = pooledFixturePack();
    const poolB = pack.expected.tables.find((t) => t.poolKey === "B");
    if (poolB === undefined) throw new Error("fixture must declare a pool B table");
    // Swap ranks 1 and 2 — the ORDERING-differential case. A comparator that only
    // checks membership passes this; one that checks order cannot.
    const [first, second, ...rest] = poolB.rows;
    poolB.rows = [
      { ...second, rank: 1 },
      { ...first, rank: 2 },
      ...rest,
    ];
    const result = validatePack(pack, { expectedSuite: "fixture" });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code.startsWith("standings."))).toBe(true);
  });

  it("does not silently pass a pool nobody declared results for", () => {
    const pack = pooledFixturePack();
    pack.streams = pack.streams.filter((s) => !s.fixtureExtKey.startsWith("pB-"));
    const result = validatePack(pack, { expectedSuite: "fixture" });
    expect(result.ok).toBe(false);
  });
});
```

The fixture `pooledFixturePack()` is new: two pools (A and B) of three entrants, ext keys `pA-rr-r1-c1` …, streams that fold, and one `expected.tables` row per pool. Build it from the existing `_tiny` fixture helpers in that directory rather than inventing a second style.

- [ ] **Step 2: Run and watch them fail**

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a && \
./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/t4.json \
  scripts/bench/lib/__tests__/validate-pack-standings.test.ts
```
Expected: test 1 fails — `standings.pool_unbindable` IS in the codes. Tests 2 and 3 fail because a skipped table can never disagree with anything.

- [ ] **Step 3: Bind the pool, then derive per pool**

Replace the skip at `:1656-1665` with a binding that selects the pool's own streams:

```ts
if (table.poolKey !== undefined) {
  const prefix = `p${table.poolKey}-`;
  const poolStreams = stageStreams.filter((s) => s.fixtureExtKey.startsWith(prefix));
  if (poolStreams.length === 0) {
    add("error", "standings.pool_has_no_streams", where,
      `the table is scoped to pool "${table.poolKey}" and no stream's fixtureExtKey starts with ` +
        `"${prefix}" — a pooled round robin keys its fixtures p{pool}-rr-r{round}-c{court}`);
    return;
  }
  rowsOrIssue = deriveStandings(division, stage, poolStreams, seedByEntrant, folded, table.poolKey);
} else {
  rowsOrIssue = deriveStandings(division, stage, stageStreams, seedByEntrant, folded);
}
```

And in `deriveStandings`, return the named pool rather than `pools[0]`:

```ts
  const completed = completeTableStage(tableStage, fixtures);
  const pool =
    poolKey === undefined
      ? completed.tables.pools[0]
      : completed.tables.pools.find((p) => p.key === poolKey) ?? completed.tables.pools[0];
  return pool === undefined ? `stage "${stage.ref}" produced no pool table` : pool.rows;
```

Read `completeTableStage`'s pool shape before writing the `.find` — if pools are keyed by a field other than `key`, use the real one.

- [ ] **Step 4: Run the whole bench suite**

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a && \
./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/t4.json \
  --testTimeout=30000 scripts/bench && \
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/t4.json
```
Expected: `failed: 0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a
/usr/bin/git add scripts/bench/lib/validate-pack.ts scripts/bench/lib/__tests__/
/usr/bin/git commit -m "feat(bench): stage 0 checks a pooled stage's tables, one per pool"
```

---

### Task 5: The expected qualifier order comes from the progression rule

**Files:**
- Create: `scripts/bench/lib/qualifiers.ts`
- Modify: `scripts/bench/lib/suites/run-suite.ts:3249-3258`
- Test: `scripts/bench/lib/__tests__/qualifiers.test.ts`

**Interfaces:**
- Produces: `expectedQualifierRefs(tables: readonly PackExpectedTable[], progression: { kind: "topNPerGroup"; n: number }): readonly string[]` — entrant REFS in seat order.

**The rule, read from the product:** `topNPerGroup` orders qualifiers rank-before-group — every pool's 1st, then every pool's 2nd (`packages/engine/src/competition/progression.ts:124-134`), and `rank_order` consumes that list as-is (`:239-298`). The bench re-implements it rather than importing the product's copy, so the two are independent and a disagreement is a finding either way (`_RULES.md` §3, checker independence).

- [ ] **Step 1: Write the failing test**

```ts
// scripts/bench/lib/__tests__/qualifiers.test.ts
import { describe, expect, it } from "vitest";
import { expectedQualifierRefs } from "../qualifiers.ts";

const tables = [
  { poolKey: "A", rows: [{ entrant: "e-a1", rank: 1 }, { entrant: "e-a2", rank: 2 }, { entrant: "e-a3", rank: 3 }] },
  { poolKey: "B", rows: [{ entrant: "e-b1", rank: 1 }, { entrant: "e-b2", rank: 2 }, { entrant: "e-b3", rank: 3 }] },
];

describe("expectedQualifierRefs", () => {
  it("orders rank before group: every pool's winner, then every pool's runner-up", () => {
    expect(expectedQualifierRefs(tables, { kind: "topNPerGroup", n: 2 })).toEqual([
      "e-a1", "e-b1", "e-a2", "e-b2",
    ]);
  });

  it("is not merely grouping by pool — the ORDERING-differential case", () => {
    // Group-before-rank would give a1,a2,b1,b2. Any test whose expectation is a SET
    // cannot tell the two apart, so assert the sequence.
    expect(expectedQualifierRefs(tables, { kind: "topNPerGroup", n: 2 })).not.toEqual([
      "e-a1", "e-a2", "e-b1", "e-b2",
    ]);
  });

  it("takes only the declared N per pool", () => {
    expect(expectedQualifierRefs(tables, { kind: "topNPerGroup", n: 1 })).toEqual(["e-a1", "e-b1"]);
  });

  it("returns nothing when no table declares a pool — the empty case, stated first", () => {
    expect(expectedQualifierRefs([{ poolKey: undefined, rows: tables[0].rows }], { kind: "topNPerGroup", n: 2 }))
      .toEqual([]);
  });

  it("orders pools by key so a pack's declaration order cannot change the seats", () => {
    expect(expectedQualifierRefs([tables[1], tables[0]], { kind: "topNPerGroup", n: 2 })).toEqual([
      "e-a1", "e-b1", "e-a2", "e-b2",
    ]);
  });
});
```

- [ ] **Step 2: Run and watch it fail** — `Cannot find module '../qualifiers.ts'`.

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a && \
./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/t5.json \
  scripts/bench/lib/__tests__/qualifiers.test.ts
```

- [ ] **Step 3: Write `scripts/bench/lib/qualifiers.ts`**

```ts
// The seat order a group stage feeds its knockout, recomputed independently of the
// product. `topNPerGroup` orders qualifiers RANK BEFORE GROUP — A1, B1, C1, D1, A2 …
// (packages/engine/src/competition/progression.ts:124-134), and `rank_order` then
// takes that list verbatim (:239-298). This file imports nothing from the product:
// two implementations that disagree is a finding, one shared implementation is a
// tautology.
export interface QualifierTable {
  readonly poolKey?: string | undefined;
  readonly rows: readonly { readonly entrant: string; readonly rank: number }[];
}

export interface TopNPerGroup {
  readonly kind: "topNPerGroup";
  readonly n: number;
}

export function expectedQualifierRefs(
  tables: readonly QualifierTable[],
  progression: TopNPerGroup,
): readonly string[] {
  const pooled = tables
    .filter((t): t is QualifierTable & { poolKey: string } => t.poolKey !== undefined)
    .sort((a, b) => a.poolKey.localeCompare(b.poolKey));
  if (pooled.length === 0) return [];

  const seats: string[] = [];
  for (let rank = 1; rank <= progression.n; rank += 1) {
    for (const table of pooled) {
      const row = table.rows.find((r) => r.rank === rank);
      if (row !== undefined) seats.push(row.entrant);
    }
  }
  return seats;
}
```

- [ ] **Step 4: Wire it into the runner**

At `run-suite.ts:3249-3258`, keep the flat-table path for an unpooled source stage and use the new function when the source stage declares pools:

```ts
  const stageTables = pack.expected.tables.filter(
    (t) => t.divisionRef === division.ref && t.stageRef === sourceStage.ref,
  );
  const pooled = stageTables.filter((t) => t.poolKey !== undefined);
  const orderedRefs =
    pooled.length > 0
      ? expectedQualifierRefs(pooled, progressionOf(targetStage))
      : [...(stageTables.find((t) => t.poolKey === undefined)?.rows ?? [])]
          .sort((a, b) => a.rank - b.rank)
          .map((r) => r.entrant);
```

`progressionOf` reads the target stage's declared progression (`PackStage.progression` is passed through untyped, `lib/pack-schema.ts:459`); parse it narrowly and, if it is not `topNPerGroup`, push a warning naming what it was rather than guessing.

- [ ] **Step 5: Run the suite and commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a && \
./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/t5.json \
  --testTimeout=30000 scripts/bench && \
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/t5.json
/usr/bin/git add scripts/bench/lib/qualifiers.ts scripts/bench/lib/suites/run-suite.ts \
  scripts/bench/lib/__tests__/qualifiers.test.ts
/usr/bin/git commit -m "feat(bench): the qualifier order a group stage actually feeds its knockout"
```

---

### Task 6: Advancement runs for every division

**Files:**
- Modify: `scripts/bench/lib/suites/run-suite.ts:3231-3365`
- Test: `scripts/bench/lib/__tests__/tiny-suite.test.ts` (the fake-transport suite)

**Interfaces:**
- Consumes: `completeStageCapture`, `advanceStageSeeding` (`lib/advance.ts:283`, `:280`).
- Produces: no new export; the block becomes a loop over `pack.divisions` whose stage list has more than one entry.

**Why this task exists:** today the block is gated on `division0` and its `stage1`, so a second division's knockout streams are imported into fixtures nobody ever seeded from a proposal. Suite 10 has two divisions, each with a group stage feeding a knockout.

- [ ] **Step 1: Write the failing test**

```ts
// append to scripts/bench/lib/__tests__/tiny-suite.test.ts
it("proposes, confirms and generates for EVERY division with a second stage", async () => {
  const calls: string[] = [];
  const report = await runPackSuite(
    inputWithFakes({
      advanceTransport: recordingTransport(calls),
      pack: twoDivisionsEachWithTwoStages(),
    }),
    { suiteKey: "fixture", packPath: FIXTURE_PACK_PATH },
  );
  const proposals = calls.filter((c) => c.includes("/seed-proposal"));
  expect(proposals).toHaveLength(2);
  expect(report.oracles?.filter((o) => o.name.includes("seed proposal"))).toHaveLength(2);
});
```

- [ ] **Step 2: Run and watch it fail** — one proposal, not two.

- [ ] **Step 3: Loop the block**

Lift the existing body into `async function advanceDivision(division, sourceStage, targetStage)` unchanged, then drive it:

```ts
for (const division of pack.divisions) {
  for (let i = 1; i < division.stages.length; i += 1) {
    const sourceStage = division.stages[i - 1];
    const targetStage = division.stages[i];
    if (targetStage?.progression === undefined || sourceStage === undefined) continue;
    await advanceDivision(division, sourceStage, targetStage);
  }
}
```

Two details that are easy to get wrong and cost a live run each: the oracle NAME must carry the division ref (two divisions otherwise emit two oracles with identical names, and the report's reader cannot tell which failed), and the stage-1 stream filter must be `st.divisionRef === division.ref && st.stageRef === targetStage.ref` — the existing filter hard-codes `division0`.

- [ ] **Step 4: Run the whole bench suite** (command as Task 4, `/tmp/t6.json`). Expected `failed: 0`.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git commit -m "feat(bench): advance every division, not only the first"
```

---

### Task 7: A suite declares how each division is played

**Files:**
- Modify: `scripts/bench/lib/suites/types.ts:8-31`, `scripts/bench/lib/suites/registry.ts:11-28`
- Modify: `scripts/bench/lib/suites/run-suite.ts:3030-3160`
- Test: `scripts/bench/lib/__tests__/suites-registry.test.ts`, `scripts/bench/lib/__tests__/tiny-suite.test.ts`

**Interfaces:**
- Produces: `SuiteDefinition.play?: Readonly<Record<string, PlayMode>>` where `PlayMode = "tap" | "api" | "import"`, keyed by division ref; and `playModeFor(definition, divisionRef, index): PlayMode` whose DEFAULT reproduces today's positional behaviour exactly — index 0 → `"api"`, every other division → `"import"`.

**Why the default matters:** suite 11 and `_tiny`'s badminton division must keep their current write paths, because `_RULES.md` §3 requires one suite to stay on the single-POST path and the import path needs a live exercise too. A play mode that silently changed them would remove coverage while adding some.

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/bench/lib/__tests__/suites-registry.test.ts
import { describe, expect, it } from "vitest";
import { playModeFor } from "../suites/types.ts";

describe("playModeFor", () => {
  it("defaults to today's behaviour: the first division single-POSTs, the rest import", () => {
    expect(playModeFor({ key: "s", title: "", packPath: "", run: async () => ({}) } as never, "d-any", 0)).toBe("api");
    expect(playModeFor({ key: "s", title: "", packPath: "", run: async () => ({}) } as never, "d-any", 1)).toBe("import");
  });

  it("uses the declared mode when the suite names that division", () => {
    const def = { key: "s", title: "", packPath: "", run: async () => ({}), play: { "d-tiny": "tap" } } as never;
    expect(playModeFor(def, "d-tiny", 0)).toBe("tap");
    expect(playModeFor(def, "d-badminton", 1)).toBe("import");
  });
});
```

- [ ] **Step 2: Run and watch it fail** — `playModeFor` does not exist.

- [ ] **Step 3: Add the type, the helper and the dispatch**

```ts
// scripts/bench/lib/suites/types.ts
export type PlayMode = "tap" | "api" | "import";

export function playModeFor(
  definition: SuiteDefinition,
  divisionRef: string,
  index: number,
): PlayMode {
  const declared = definition.play?.[divisionRef];
  if (declared !== undefined) return declared;
  // The pre-B07a behaviour, kept verbatim: division 0 single-POSTs (the path live
  // scoring uses), every other division imports.
  return index === 0 ? "api" : "import";
}
```

In `run-suite.ts`, replace the two hard-coded blocks (`:3030` single-POST for `division0`, `:3116` import for the rest) with one loop over `pack.divisions` that switches on `playModeFor(...)`. `"api"` calls `simulateDivisionStreams`, `"import"` calls `importDivisionStreams`, `"tap"` throws `new Error("tap mode requires the scorer driver (Task 10)")` for now — the driver arrives in Tasks 9 and 10 and this line is what proves the dispatch is reached.

- [ ] **Step 4: Run the whole bench suite** (`/tmp/t7.json`). Expected `failed: 0`, and the existing `_tiny` and suite-11 tests still green — that is the real assertion of this task.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git commit -m "feat(bench): a suite declares how each of its divisions is played"
```

---

### Task 8: App test hooks — attributes only

**Files:**
- Modify: `apps/web/src/components/v2/fixture-console.tsx:855` (Start match), `:1092` (Finalize)
- Modify: `apps/web/src/components/v2/device-score-pad.tsx:301` (Start match)
- Modify: `apps/web/src/components/v2/scorepad/v3/detail-dock.tsx:457` (Send now)
- Modify: `apps/web/src/components/v2/scorepad/v3/guided-sheet.tsx:521` (number field), `:548` (Confirm)
- Modify: `apps/web/src/components/v2/scorepad/v3/scorebug.tsx:319`, `:325` (both branches — `data-side`)
- Modify: `apps/web/src/components/v2/device-link-panel.tsx:162` (mint)
- Modify: `apps/web/src/components/v2/cookie-consent.tsx` (Accept)
- Modify: `apps/web/e2e/carrom-pad.spec.ts:93-117`, `apps/web/e2e/walkthrough/scorepad-v3-carrom-match.spec.ts:122`, `:194-199`
- Test: `apps/web/src/components/v2/scorepad/v3/__tests__/tap-hooks.test.tsx`

**Interfaces:**
- Produces, as a stable contract the bench driver depends on: `score-start-match`, `score-finalize`, `pad-send-now`, `pad-sheet-confirm`, `pad-sheet-number`, `device-link-mint`, `cookie-accept`, and `data-side="home|away"` on both scorebug-half branches.

**Why this task exists:** today Start match, Finalize, Send now, Confirm, the coins field and cookie Accept can be found only by their **translated** text, and the two e2e specs bind them by English accessible name. A driver built that way breaks the first time a translator touches a string, and cannot run against a non-English locale at all. The scorebug halves carry `data-role="v3-scorebug-half"` but nothing says which side is which, so the specs use `nth(0)`/`nth(1)` and a layout change silently flips them.

**Scope discipline:** attributes ONLY. No copy, no class, no element moves — `docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md` governs this tree, and a layout edit here would need its own visual sign-off.

- [ ] **Step 1: Write the failing markup test**

`apps/web` vitest is `environment: "node"`, so it renders to a string. Anchor every assertion on `="`, because React serialises an omitted prop as `"$undefined"` and a bare `data-side` probe would pass in both states (AGENTS.md).

```tsx
// apps/web/src/components/v2/scorepad/v3/__tests__/tap-hooks.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Scorebug } from "../scorebug.tsx";
import { GuidedSheet } from "../guided-sheet.tsx";

describe("the hooks a scorer driver taps", () => {
  it("marks each scorebug half with the side it belongs to", () => {
    const html = renderToStaticMarkup(<Scorebug {...scorebugProps()} />);
    expect(html).toContain('data-side="home"');
    expect(html).toContain('data-side="away"');
  });

  it("names the sheet's confirm button and its number field", () => {
    const html = renderToStaticMarkup(<GuidedSheet {...numberStepProps()} />);
    expect(html).toContain('data-testid="pad-sheet-confirm"');
    expect(html).toContain('data-testid="pad-sheet-number"');
  });
});
```

`scorebugProps()` / `numberStepProps()` follow the existing render tests in that directory (`phone-classes.test.tsx:6` shows the `renderToStaticMarkup` + `vi.mock("next/navigation")` pattern).

- [ ] **Step 2: Run and watch it fail**

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a/apps/web && \
npx vitest run --reporter=json --outputFile=/tmp/t8.json \
  src/components/v2/scorepad/v3/__tests__/tap-hooks.test.tsx
```
Expected: both fail — `data-side` and the two testids do not exist.

- [ ] **Step 3: Add the attributes**

Each edit adds exactly one attribute. For example, `guided-sheet.tsx:548`:

```tsx
      <button type="button" data-testid="pad-sheet-confirm" onClick={onConfirm} style={{ minHeight: 44 }} className={choiceButtonClass}>
```

and `scorebug.tsx:325` (and the non-tappable `<div>` branch above it, so both render the same contract):

```tsx
              <button
                key={i}
                type="button"
                data-role="v3-scorebug-half"
                data-side={i === 0 ? "home" : "away"}
```

- [ ] **Step 4: Switch the two e2e specs to the hooks**

In `walkthrough/scorepad-v3-carrom-match.spec.ts:194-199` and `carrom-pad.spec.ts:114-117`, replace `getByRole("button", { name: "Confirm", exact: true })` with `locator('[data-testid="pad-sheet-confirm"]')`, `getByLabel("Opponent's coins left")` with `locator('[data-testid="pad-sheet-number"]')`, and the "Send now" lookup at `:122` with `[data-testid="pad-send-now"]`. Do NOT weaken any assertion while doing it.

- [ ] **Step 5: Run the whole affected specs, never a `-g` slice**

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a/apps/web && \
npx playwright test e2e/carrom-pad.spec.ts e2e/walkthrough/scorepad-v3-carrom-match.spec.ts \
  --reporter=list 2>&1 | tail -20
```
Expected: the same passes as before the change. A red here means a hook landed on the wrong element — the specs are the proof the attributes are live, which no node-environment test can give.

- [ ] **Step 6: OpenAPI drift and commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a
npm run openapi:gen && /usr/bin/git status --porcelain   # must be empty
/usr/bin/git add apps/web/src/components/v2 apps/web/e2e
/usr/bin/git commit -m "test(pad): name the controls a scorer taps, instead of matching translated text"
```

---

### Task 9: The tap driver and the generic adapter

**Files:**
- Create: `scripts/bench/lib/drivers/scorer.ts`
- Create: `scripts/bench/lib/drivers/adapters/generic.ts`
- Test: `scripts/bench/lib/__tests__/scorer-driver.test.ts`

**Interfaces:**
- Consumes: `fetchFixtureLedger`, `fetchFixtureStatus` (Task 1); `resolvePayloadRefs` (`lib/simulate.ts:177`); `launchRegistrationBrowser`, `newAnonymousBrowserSession`, `newOrganiserBrowserSession`, `closeRegistrationBrowserSession` (`lib/drivers/browser.ts:59-108`).
- Produces:
  ```ts
  export type TapStep =
    | { kind: "tile"; tileId: string }
    | { kind: "choice"; optionId: string }
    | { kind: "number"; value: number }
    | { kind: "confirm" }
    | { kind: "testid"; testid: string };

  export interface TapAdapter {
    readonly sport: string;
    stepsFor(event: { type: string; payload: unknown }, ctx: TapAdapterContext): readonly TapStep[];
  }

  export interface PlayMatchResult {
    readonly fixtureId: string;
    readonly taps: number;
    readonly wallMs: number;
    readonly findings: readonly string[];
  }

  export function playMatchByTaps(input: PlayMatchInput): Promise<PlayMatchResult>;
  ```

**The loop, and why each part is there:**

1. **`core.start` is a button, not an event to post.** The adapter returns `{ kind: "testid", testid: "score-start-match" }` for it.
2. **The hold is used the way a person uses it.** A held tap is flushed by the NEXT tap (`apps/web/src/components/v2/scorepad/queue.ts:353`); only the last one needs `pad-send-now` (`:287`). The driver therefore verifies **one behind**, then flushes and verifies the last. This is what makes the run independent of the build-time `HOLD_MS` (`queue.ts:176-184`), which a bench process cannot read.
3. **Pacing comes from the product's own constant.** `HUMAN_FASTEST_REPEAT_MS` guards double-submits; the driver imports it rather than typing a number, so moving the constant moves the driver (AGENTS.md failure class 20).
4. **Every commit is checked against the pack.** `fetchFixtureLedger(since lastSeq)` must return exactly one new row whose `type` and `payload` equal the pack event with refs resolved. This is the assertion no API test can make: it proves the TAPS produced the payload, not that the payload was accepted.
5. **Status transitions are asserted, not observed.** `scheduled` before the first tap, `in_play` after `core.start`, `in_play` until the last event, `decided` exactly at it. Decided early is a red.

- [ ] **Step 1: Write the failing driver test**

The test drives a FAKE page and a FAKE ledger, so it runs in CI with no browser. It proves the ORDER of operations and the guards — not the DOM, which only a live run can prove.

```ts
// scripts/bench/lib/__tests__/scorer-driver.test.ts
import { describe, expect, it } from "vitest";
import { playMatchByTaps } from "../drivers/scorer.ts";
import { genericAdapter } from "../drivers/adapters/generic.ts";

function fakePage(record: string[]) {
  return {
    locator: (sel: string) => ({
      click: async () => { record.push(`click ${sel}`); },
      fill: async (v: string) => { record.push(`fill ${sel}=${v}`); },
      waitFor: async () => {},
      count: async () => 1,
    }),
    setViewportSize: async () => {},
    goto: async (url: string) => { record.push(`goto ${url}`); },
  };
}

describe("playMatchByTaps", () => {
  it("starts the match, taps each event, flushes the last and finalizes", async () => {
    const record: string[] = [];
    const ledger = fakeLedgerAdvancingOneRowPerFlush();
    const result = await playMatchByTaps({
      scorerPage: fakePage(record) as never,
      organiserPage: fakePage(record) as never,
      deviceUrl: "http://x/score/s3cret",
      fixtureId: "f1",
      stream: { events: [{ type: "core.start", payload: {} }, { type: "generic.score", payload: { by: "@e-home" } }] },
      adapter: genericAdapter,
      refIdByKey: new Map([["e-home", "en-home"]]),
      ledger,
      base: "http://x",
      session: { cookies: {} },
    });
    expect(result.findings).toEqual([]);
    expect(record).toContain('click [data-testid="score-start-match"]');
    expect(record).toContain('click [data-testid="pad-send-now"]');
    expect(record).toContain('click [data-testid="score-finalize"]');
    expect(record.indexOf('click [data-testid="score-finalize"]')).toBeGreaterThan(
      record.indexOf('click [data-testid="pad-send-now"]'),
    );
  });

  it("reds when the server recorded a different payload than the taps meant", async () => {
    const result = await playMatchByTaps(inputWhoseLedgerReturns({ type: "generic.score", payload: { by: "en-away" } }));
    expect(result.findings.join(" ")).toContain("ledger");
  });

  it("reds when the fixture is decided before the stream's last event", async () => {
    const result = await playMatchByTaps(inputWhoseStatusGoesDecidedEarly());
    expect(result.findings.join(" ")).toContain("decided");
  });

  it("never posts an event itself — no fallback", async () => {
    const posts: string[] = [];
    await playMatchByTaps(inputRecordingPosts(posts));
    expect(posts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail** — the module does not exist.

- [ ] **Step 3: Write the driver and the generic adapter**

Keep the driver sport-blind: it executes `TapStep`s and checks the ledger. All sport knowledge lives in the adapter. The generic adapter maps `generic.score` to a scorebug half by side (`[data-role="v3-scorebug-half"][data-side="home"]`, Task 8) and `generic.result` to the `settle` tile (`apps/web/src/components/v2/scorepad/v3/skins/generic.tsx:413-417`).

- [ ] **Step 4: Run the whole bench suite** (`/tmp/t9.json`). Expected `failed: 0`.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git commit -m "feat(bench): a scorer who taps the real pad, and checks what the server recorded"
```

---

### Task 10: Tap mode, wired — the organiser hands over, the scorer plays, the organiser signs off

**Files:**
- Modify: `scripts/bench/lib/suites/run-suite.ts` (the `"tap"` branch from Task 7)
- Modify: `scripts/bench/lib/suites/registry.ts` (`_tiny` declares `d-tiny: "tap"`)
- Modify: `scripts/bench/lib/report.ts` (tap stats section)
- Test: `scripts/bench/lib/__tests__/tiny-suite-tap.test.ts`

**Interfaces:**
- Produces: `SuiteReport.tapPlay?: { matches: number; taps: number; wallMs: number }` (report-only, never asserted), and a `finalized` requirement on every tapped fixture.

**The sequence per division, all through the UI:**
1. Organiser opens the fixture console, taps `[data-role="device-handover"]`, then `[data-testid="device-link-mint"]` in the panel, and reads the link off the screen.
2. A scorer context (phone viewport 390×844, consent pre-answered) opens it and plays the match (Task 9).
3. The organiser taps `[data-testid="score-finalize"]`.
4. The fixture's status must be `finalized` — checked separately from `compareMatches`, whose `SETTLED_STATUSES` already accepts `decided` and must keep doing so for the API paths.
5. Rounds run in order; matches within a round run in parallel, capped at the division's court count.

- [ ] **Step 1: Write the failing test**

```ts
it("requires a tapped fixture to reach finalized, not merely decided", async () => {
  const report = await runPackSuite(inputWhereFinalizeIsSkipped(), { suiteKey: "fixture", packPath: FIXTURE_PACK_PATH });
  expect(report.gate).toBe("red");
  expect(report.errors?.join(" ")).toContain("finalized");
});

it("counts taps and wall time without gating on them", async () => {
  const report = await runPackSuite(inputWithTappedDivision(), { suiteKey: "fixture", packPath: FIXTURE_PACK_PATH });
  expect(report.gate).toBe("green");
  expect(report.tapPlay?.taps).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run and watch both fail.**

- [ ] **Step 3: Implement the branch**, then declare `play: { "d-tiny": "tap" }` on `_tiny`'s registry row. Leave `d-badminton` alone: it keeps the import path's coverage.

- [ ] **Step 4: Run the whole bench suite** (`/tmp/t10.json`). Expected `failed: 0`.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git commit -m "feat(bench): play a division by tapping, and make the organiser sign it off"
```

---

### Task 11: The device link is a paid feature — prove the refusal, then provision

**Files:**
- Modify: `scripts/bench/lib/dls-gate.ts` (reuse `PROVOCABLE_GATED_FEATURES`), `scripts/bench/lib/plan.ts` (the capability the chooser asks for)
- Modify: `scripts/bench/lib/suites/run-suite.ts` (the probe, before provisioning)
- Test: `scripts/bench/lib/__tests__/device-link-gate.test.ts`

**Why this task exists:** minting a device link requires `scoring.device_links` (`apps/web/src/server/usecases/device-links.ts:128`, 402 for Community). Every tap suite therefore has a real entitlement to prove — the first outside cricket's DLS since v18 W1 deleted the fidelity gate. The playbook's entitlement item stops being a recorded "n/a".

- [ ] **Step 1: Write the failing test** — the probe returns 402 on a plan without the key, then 201 after provisioning; the key is DERIVED from the live catalog walk, never typed:

```ts
it("derives the device-link key from the live catalog rather than naming it", async () => {
  const keys = await provocableFeatureKeys(fakeCatalogSql());
  expect(keys).toContain("scoring.device_links");
});

it("proves the refusal before provisioning, and the mint after", async () => {
  const result = await proveDeviceLinkGate(fakeTransportRefusingThenAllowing());
  expect(result.refusedStatus).toBe(402);
  expect(result.mintedAfterProvision).toBe(true);
});
```

- [ ] **Step 2–4:** run it red, implement, run the whole bench suite green (`/tmp/t11.json`).

- [ ] **Step 5: Commit**

```bash
/usr/bin/git commit -m "feat(bench): a tap suite proves the device-link entitlement instead of recording it"
```

---

### Task 12: News publishes the semis and the final, as D6 said

**Files:**
- Modify: `scripts/bench/lib/suites/run-suite.ts:4694-4723`
- Test: `scripts/bench/lib/__tests__/news-step.test.ts`

**Interfaces:** no new export. `publishFixtureIds` becomes the last round's fixtures plus the round before it, instead of every streamed fixture of the last stage.

- [ ] **Step 1: Write the failing tests**

```ts
it("publishes the final and both semis, and leaves the quarters drafted", async () => {
  const published = publishTargets(knockoutStreams());   // se-r0-i0..3, se-r1-i0..1, se-r2-i0
  expect(published).toEqual(["se-r1-i0", "se-r1-i1", "se-r2-i0"]);
});

it("publishes nothing when the last stage has no streams — the empty case", () => {
  expect(publishTargets([])).toEqual([]);
});

it("publishes the single fixture of a one-round stage without inventing a semi", () => {
  expect(publishTargets(oneRoundStream())).toEqual(["se-r0-i0"]);
});
```

- [ ] **Step 2–4:** red, implement (parse the round from the `se-r{n}-i{i}` key, take the top two rounds present), whole suite green (`/tmp/t12.json`).

- [ ] **Step 5: Commit**

```bash
/usr/bin/git commit -m "fix(bench): publish the semis and the final, not the whole stage"
```

---

### Task 13: Live runs, evidence, and the programme record

**Files:**
- Modify: `docs/superpowers/specs/bench-product-value/bench-prompts/_INDEX.md` (B07 row → B07a/B07b; B06b row → MERGED plus the #771/#773 correction; B09's UI-setup ruling; B16's new dependency on B07a; the B08 note)
- Modify: `docs/superpowers/specs/bench-product-value/_MASTER.md` (bench row)
- Modify: `docs/superpowers/specs/bench-product-value/bench-prompts/_PACK-PLAYBOOK.md` (the people-layer and entitlement acceptance items, now that a tap suite proves the device-link gate)
- Create: `docs/superpowers/specs/bench-product-value/bench-prompts/evidence/b07a-tiny-tap/` (both legs' reports, plus screenshots)

**This task is the wave's real proof.** Everything before it is green unit tests, and `_RULES.md` §2's whole point is that green is not run.

- [ ] **Step 1: Bring up a clean environment** following the `seazn-local-env` skill: fresh DB with `db:apply` AND `sync:sports`, `show data_directory` confirmed as yours, the port's PID confirmed with `lsof -t -sTCP:LISTEN`, BASE on `localhost` (never `127.0.0.1` — a Secure cookie is not stored from an IP and auth fails later as a 401).

- [ ] **Step 2: Leg A — placement live**

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b07a && \
npm run bench:scheduler -- --suite _tiny --wipe --engine both > /tmp/b07a-legA.log 2>&1; echo "EXIT=$?"
```
Run it in the background and have it write its own `EXIT` — a killed background command reports exit 0. Expected: gate green, the tapped division reaching `finalized`, tap stats present.

- [ ] **Step 3: Leg B — placement absent**

```
PLACEMENT_SERVICE_HOST=127.0.0.1:1 npm run bench:scheduler -- --suite _tiny --wipe --engine both \
  > /tmp/b07a-legB.log 2>&1; echo "EXIT=$?"
```
Expected: the same oracle verdicts, `solver_unavailable`, greedy. If a refusal appears, read the placement service's own message first (#773 made both sides log it).

- [ ] **Step 4: Re-run suite 11 on both legs** under the stricter loser check. A mismatch here is a finding about suite 11's declared data, recorded in the PR — not something to edit away.

- [ ] **Step 5: Use the product.** With `--keep`, open the org in a browser: the tapped division's bracket, the standings, one finalized fixture's console. Look at the screenshots the run captured. Write down what you SAW, not what must be true.

- [ ] **Step 6: Mutation sweep**, one mutant per surface, recording the KILLER LIST:
  decided-early check · finalized requirement · ledger-equals-pack · loser comparison · per-pool derivation · qualifier order (A1,B1 vs A1,A2) · news selection (empty first) · play-mode default · the 402 probe.

- [ ] **Step 7: Commit the evidence and the index rows**

```bash
/usr/bin/git add docs/superpowers/specs/bench-product-value
/usr/bin/git commit -m "docs(bench): B07a's live legs, and the programme rows that moved"
```

---

## Self-review

**Spec coverage.** §4.1 → Task 8. §4.2 → Tasks 1, 9. §4.3 → Tasks 6, 7, 10, 12. §4.4 → Tasks 4, 5. §4.5 → Tasks 2, 3. §4.6 → Task 11. §4.7 → Task 13. §6 gates → every task's Step 4, and Task 13 for the live legs and the mutation sweep. B07b (§5) is a separate plan, written after this wave merges.

**Type consistency.** `LedgerRow`/`LedgerTransport` (Task 1) are consumed by name in Task 9. `PlayMode`/`playModeFor` (Task 7) are used in Task 10. `TapStep`/`TapAdapter` (Task 9) are used by the generic adapter in the same task and by carrom in B07b. `expectedQualifierRefs` (Task 5) is called only in `run-suite.ts`.

**Known gap, deliberately left to the executor:** three field names must be read in the tree before they are typed — `PackAdaptation`'s fields (Task 3), the pool key on `completeTableStage`'s pools (Task 4), and `PackStage.progression`'s untyped shape (Task 5). Each step says so at the point of use. Everything else is pinned.
