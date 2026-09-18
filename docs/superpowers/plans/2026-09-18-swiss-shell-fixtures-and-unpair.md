# Swiss Shell Fixtures + Unpair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mint all Swiss round fixture shells on first Generate so organisers can schedule ahead; Pair next seats one round at a time onto those shells; Unpair clears the latest seated Swiss round when it has no played results.

**Architecture:** Keep real `fixtures` rows (Approach 1). Split today’s insert-only `swissGen` into (1) shell mint for rounds `1…N` with null sides and (2) in-place UPDATE seating via `pairRound`. Readiness ignores unseated shells. New `POST /stages/{id}/unpair` is Swiss-only. Organiser-set `config.rounds` is required for every Swiss stage (plain / Playoff / Knockout Swiss half); stop auto-persisting derived rounds at generate time.

**Tech Stack:** TypeScript, postgres.js (`withTenant`), vitest (`apps/web`, `environment: "node"`), Playwright e2e, `scripts/smoke.ts`, 4-locale `ui.json` + `pnpm i18n:gen-keys`.

**Spec:** `docs/superpowers/specs/2026-09-18-swiss-shell-fixtures-and-unpair-design.md`

## Global Constraints

- Work in a **new git worktree** off `main` (never check out in the main repo dir). Prefix every verify with `cd <abs worktree> &&`.
- Judge vitest only from `--reporter=json --outputFile=...` (`numPassedTests` / `numTotalTests`). Confirm `.testResults[].name` paths are under the worktree.
- New user-facing strings → all four `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then `pnpm i18n:gen-keys`; commit generated `i18n-keys.ts`.
- Greenfield — no migration of mid-Swiss fixtures.
- Unpair is **Swiss-only**; never expose or succeed for knockout / page_playoff / finals.
- Pair writes onto existing shells via **UPDATE**, not insert (generate path is insert-by-`ext_key` only today — seating must not rely on that).
- Do not invent a separate schedule-slot table.
- After rebase, re-read line numbers — citations below were pinned on main near the Swiss Playoff/Knockout era.

---

## File map

| File | Responsibility |
|---|---|
| `apps/web/src/lib/swiss-shell.ts` (new) | Pure helpers: board count, shell plan, seated predicates, next-unseated / latest-seated round |
| `apps/web/src/lib/__tests__/swiss-shell.test.ts` (new) | Unit tests for those helpers |
| `apps/web/src/server/usecases/stages.ts` | Rewrite Swiss mint + pair; add `unpairSwissRound`; drop auto-persist of derived `rounds` |
| `apps/web/src/server/usecases/__tests__/swiss-shell-fixtures.test.ts` (new) | DB tests: mint, pair readiness, unpair gates |
| `apps/web/src/app/api/v1/stages/[id]/unpair/route.ts` (new) | `POST` → `unpairSwissRound` |
| `apps/web/src/server/api-v1/openapi.ts` | Register `/stages/{id}/unpair` |
| `apps/web/src/components/v2/format-templates.ts` | Put `rounds` on swiss_playoff / swiss_knockout drafts; knob always applies |
| `apps/web/src/components/v2/division-settings.tsx` | Show editable rounds for all Swiss templates (stop “derived only” branch as authority) |
| `apps/web/src/components/v2/desk/stage-rail.tsx` | Generate vs Pair vs Unpair labels/actions |
| `apps/web/src/components/v2/stages-panel.tsx` | Wire `unpair` action |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` | `schedule.unpair`, notices, errors |
| `apps/web/e2e/formats.spec.ts` | Update swiss_knockout flow for shell mint + explicit Pair |
| `apps/web/e2e/swiss-shell.spec.ts` (new) | E2E: schedule TBD → Pair → Unpair |
| `scripts/smoke.ts` | Swiss shell mint + Pair while future shells unseated |
| Existing: `swiss-playoff-pairing.test.ts`, `swiss-knockout-shape.test.ts`, `format-templates.test.ts` | Retarget assertions that assumed one-round mint / auto-derive |

---

### Task 1: Pure Swiss shell helpers

**Files:**
- Create: `apps/web/src/lib/swiss-shell.ts`
- Create: `apps/web/src/lib/__tests__/swiss-shell.test.ts`

**Interfaces:**
- Produces:

```ts
export type SwissShellFixtureRef = {
  extKey: string;
  roundNo: number;
  seqInRound: number;
  /** true ⇒ bye shell (one side will become award on Pair) */
  bye: boolean;
};

export function swissBoardsForField(entrants: number): { boards: number; bye: boolean };

export function planSwissShells(rounds: number, entrants: number): SwissShellFixtureRef[];

export function isSwissBoardSeated(f: {
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
}): boolean;

export function isSwissByeRow(f: { ext_key: string | null; outcome: unknown }): boolean;

/** Lowest round that still has an unseated board; null if all seated. */
export function nextUnseatedSwissRound(
  fixtures: readonly {
    round_no: number;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    outcome: unknown;
    ext_key: string | null;
  }[],
): number | null;

/** Highest fully seated round; null if none seated. */
export function latestSeatedSwissRound(
  fixtures: readonly {
    round_no: number;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    outcome: unknown;
    ext_key: string | null;
  }[],
): number | null;

/** True if a non-bye fixture in `roundNo` has a played result (blocks Unpair). */
export function swissRoundHasPlayedResult(
  fixtures: readonly {
    round_no: number;
    status: string;
    outcome: unknown;
    ext_key: string | null;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
  }[],
  roundNo: number,
): boolean;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  swissBoardsForField,
  planSwissShells,
  isSwissBoardSeated,
  nextUnseatedSwissRound,
  latestSeatedSwissRound,
  swissRoundHasPlayedResult,
} from "@/lib/swiss-shell";

describe("swissBoardsForField", () => {
  it("even field → N/2 boards, no bye", () => {
    expect(swissBoardsForField(8)).toEqual({ boards: 4, bye: false });
  });
  it("odd field → floor boards + bye", () => {
    expect(swissBoardsForField(5)).toEqual({ boards: 2, bye: true });
  });
});

describe("planSwissShells", () => {
  it("mints N rounds of empty boards with stable ext_keys", () => {
    const plan = planSwissShells(3, 4);
    expect(plan).toHaveLength(6); // 2 boards × 3
    expect(plan.map((p) => p.extKey)).toEqual([
      "sw-r1-b1", "sw-r1-b2",
      "sw-r2-b1", "sw-r2-b2",
      "sw-r3-b1", "sw-r3-b2",
    ]);
  });
  it("adds one bye shell per round when odd", () => {
    const plan = planSwissShells(2, 3);
    expect(plan.filter((p) => p.bye).map((p) => p.extKey)).toEqual([
      "sw-r1-bye",
      "sw-r2-bye",
    ]);
  });
});

describe("seating / readiness helpers", () => {
  it("treats null-null scheduled as unseated", () => {
    expect(
      isSwissBoardSeated({
        home_entrant_id: null,
        away_entrant_id: null,
        outcome: null,
      }),
    ).toBe(false);
  });
  it("treats award bye as seated", () => {
    expect(
      isSwissBoardSeated({
        home_entrant_id: "e1",
        away_entrant_id: null,
        outcome: { kind: "award", winner: "e1" },
      }),
    ).toBe(true);
  });
  it("nextUnseated skips seated R1 when R2 shells empty", () => {
    const fx = [
      {
        round_no: 1,
        home_entrant_id: "a",
        away_entrant_id: "b",
        outcome: null,
        ext_key: "sw-r1-b1",
      },
      {
        round_no: 2,
        home_entrant_id: null,
        away_entrant_id: null,
        outcome: null,
        ext_key: "sw-r2-b1",
      },
    ];
    expect(nextUnseatedSwissRound(fx)).toBe(2);
  });
  it("bye award does not count as played result for Unpair", () => {
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "forfeited",
            outcome: { kind: "award", winner: "e1" },
            ext_key: "sw-r1-bye",
            home_entrant_id: "e1",
            away_entrant_id: null,
          },
          {
            round_no: 1,
            status: "scheduled",
            outcome: null,
            ext_key: "sw-r1-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(false);
  });
  it("decided non-bye blocks Unpair", () => {
    expect(
      swissRoundHasPlayedResult(
        [
          {
            round_no: 1,
            status: "decided",
            outcome: { kind: "win", winner: "a" },
            ext_key: "sw-r1-b1",
            home_entrant_id: "a",
            away_entrant_id: "b",
          },
        ],
        1,
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing)

```bash
cd <worktree>/apps/web && pnpm exec vitest run src/lib/__tests__/swiss-shell.test.ts --reporter=json --outputFile=/tmp/swiss-shell-helpers.json
node -e 'const j=require("/tmp/swiss-shell-helpers.json"); console.log(j.numFailedTests,j.numPassedTests,j.numTotalTests)'
```

- [ ] **Step 3: Implement `swiss-shell.ts`** to satisfy the tests. Bye detection: `ext_key?.endsWith("-bye")` OR `outcome?.kind === "award"`. Played result for helpers: non-bye AND status in `decided|finalized`, OR non-bye forfeited with a non-award outcome. Pair-minted bye awards must return false from `swissRoundHasPlayedResult`.

- [ ] **Step 4: Run — expect PASS** with `numFailedTests === 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/swiss-shell.ts apps/web/src/lib/__tests__/swiss-shell.test.ts
git commit -m "$(cat <<'EOF'
feat(swiss): pure helpers for shell plans and seating predicates

EOF
)"
```

---

### Task 2: Mint all-round shells + require `config.rounds`

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts` (`swissGen` ~723–873 and the generate insert path that consumes it)
- Create: `apps/web/src/server/usecases/__tests__/swiss-shell-fixtures.test.ts`
- Modify as needed: `swiss-playoff-pairing.test.ts`, `swiss-knockout-shape.test.ts` (assertions that assumed one-round mint / auto-derive)

**Interfaces:**
- Consumes: `planSwissShells` from `@/lib/swiss-shell`
- Produces: on first Generate with zero fixtures, `swissGen` returns `GenFixture[]` with `home: null`, `away: null`, no `award`, for every planned shell (bye shells still null sides — Pair applies award)
- Throws `EngineError("CONFIG_INVALID", …)` when `typeof cfg.rounds !== "number" || rounds < 1`
- **Removes** the block that `update stages set config = config || jsonb_build_object('rounds', …)` derived from `swissRoundsForFieldSize`

- [ ] **Step 1: Write failing DB tests** (pattern from `swiss-knockout-shape.test.ts` — `describe.runIf(HAS_DB)`, seed division + swiss stage with explicit `rounds: 3`, 4 entrants)

```ts
it("Generate mints shells for all rounds without seating anyone", async () => {
  // POST generate once
  // expect fixture count === 3 rounds × 2 boards === 6
  // every row: home/away null, status scheduled
});

it("Generate without config.rounds returns CONFIG_INVALID", async () => {
  // stage config omits rounds
});

it("second Generate with all shells unseated does not duplicate rows", async () => {
  // generate twice; count stays 6 (Pair behaviour is Task 3)
});
```

- [ ] **Step 2: Run — expect FAIL** on mint-all / require-rounds

```bash
cd <worktree>/apps/web && pnpm exec vitest run src/server/usecases/__tests__/swiss-shell-fixtures.test.ts --reporter=json --outputFile=/tmp/swiss-shell-mint.json
```

- [ ] **Step 3: Rewrite mint path in `swissGen`**

When `existing.length === 0`:
1. Require `rounds`.
2. Return `planSwissShells(rounds, entrants.length)` mapped to `GenFixture` (`home/away` null; bye shells still null — do not set `award` at mint).
3. Do not call `pairRound`.

When shells already exist: return `[]` for this task; Task 3 replaces that branch with seating.

Delete auto-persist of derived rounds.

- [ ] **Step 4: Fix broken Playoff/Knockout tests** that expected one-round mint or `config.rounds` written by generate. Set `rounds` in stage config up front; expect full shell counts after first Generate.

- [ ] **Step 5: Run mint tests + playoff/knockout suites — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/stages.ts apps/web/src/server/usecases/__tests__/swiss-shell-fixtures.test.ts apps/web/src/server/usecases/__tests__/swiss-playoff-pairing.test.ts apps/web/src/server/usecases/__tests__/swiss-knockout-shape.test.ts
git commit -m "$(cat <<'EOF'
feat(swiss): mint empty fixture shells for all configured rounds

EOF
)"
```

---

### Task 3: Pair next seats one round via UPDATE

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts` (`swissGen` / generate write path)
- Modify: `apps/web/src/server/usecases/__tests__/swiss-shell-fixtures.test.ts`

**Interfaces:**
- Consumes: `nextUnseatedSwissRound`, `isSwissBoardSeated`, existing `pairRound` + standings fold already in `swissGen`
- Produces: after mint, a Generate call **updates** the target round’s shell rows with home/away (and bye → forfeited award + `BYE_SLOT_LABEL` on phantom side)
- Prefer reusing `GenerateOutcome.created` as “rows written this call” for UI notices; document with a one-line comment

**Critical:** Do **not** insert new `ext_key`s for seating. After mint, `byKey.has(extKey)` is true for every shell, so the insert filter would no-op. Implement an explicit UPDATE pass for Swiss pair results inside the same transaction as generate.

- [ ] **Step 1: Write failing tests**

```ts
it("Pair seats only the lowest unseated round", async () => {
  // generate (mint) → generate (pair R1)
  // R1 boards have sides; R2+ still null
});

it("Pair refuses while previous seated round has undecided matches", async () => {
  // mint + pair R1; leave R1 scheduled; second pair throws STAGE_NOT_READY
});

it("Pair ignores unseated future shells when checking readiness", async () => {
  // mint + pair R1 + decide all R1 → pair R2 succeeds even though R3 shells are scheduled/null
});

it("Pair R1 requires an explicit second Generate (no auto-seat on mint)", async () => {
  // after first generate every side null
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement seating branch**

Algorithm inside Swiss generate when `existing.length > 0`:
1. `target = nextUnseatedSwissRound(existing)`; if `null`, return no-op outcome (already fully seated).
2. If `target > 1`, assert every seated fixture in `target - 1` is in `DECIDED`, ignoring unseated rows in other rounds. Bye awards in the previous round count as decided.
3. Build standings only from seated decided fixtures (today’s `!home || !away continue` already skips shells — keep that).
4. `pairRound(...)` → map pairings onto shells for `target` ordered by `seq_in_round` / board index. Bye → update bye shell with award pattern identical to current insert bye bake.
5. `UPDATE fixtures SET home_entrant_id, away_entrant_id, status, outcome, home_slot_label, away_slot_label WHERE id = …` for each shell in that round only.
6. Preserve court / `scheduled_at` columns (do not touch them).

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/stages.ts apps/web/src/server/usecases/__tests__/swiss-shell-fixtures.test.ts
git commit -m "$(cat <<'EOF'
feat(swiss): Pair next seats the next empty round onto shells

EOF
)"
```

---

### Task 4: Unpair use-case + API + OpenAPI

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts` — add `unpairSwissRound`
- Create: `apps/web/src/app/api/v1/stages/[id]/unpair/route.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts` if needed for response shape
- Modify: `apps/web/src/server/usecases/__tests__/swiss-shell-fixtures.test.ts`

**Interfaces:**
- Produces:

```ts
export async function unpairSwissRound(
  auth: AuthCtx,
  stageId: string,
): Promise<{ cleared: number; round: number }>;
```

- Throws when `stage.kind !== "swiss"`
- Throws `STAGE_NOT_READY` when no seated round, or `swissRoundHasPlayedResult` is true for the latest seated round
- Also refuse if any non-bye fixture in that round has rows in `score_events`

- [ ] **Step 1: Write failing tests**

```ts
it("Unpair clears latest seated round and keeps schedule columns", async () => {
  // mint, set scheduled_at on a shell, pair R1, unpair
  // sides null again; scheduled_at still set
});

it("Unpair refuses when a match in that round is decided", async () => { /* … */ });

it("Unpair allows a round that only has a bye award + unplayed seated boards", async () => {
  // odd field; pair R1; no scores; unpair succeeds; bye shell empty again
});

it("Unpair on knockout stage fails", async () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `unpairSwissRound`**

Clear for each fixture in `latestSeatedSwissRound`:
- `home_entrant_id = null`, `away_entrant_id = null`
- `status = 'scheduled'`, `outcome = null`
- clear both slot labels (Pair re-stamps)
- do not modify `scheduled_at`, `venue_id`, `court_id`

Route (mirror generate):

```ts
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { unpairSwissRound } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return unpairSwissRound(auth, id);
  });
}
```

OpenAPI entry next to generate:

```ts
{
  path: "/stages/{id}/unpair",
  method: "post",
  summary: "Unpair latest Swiss round (shells kept)",
  tag: "stages",
  response: /* z.object({ cleared: z.number(), round: z.number() }) */,
  errors: [422],
},
```

- [ ] **Step 4: Run — expect PASS**; run the repo’s OpenAPI drift check (re-read `ci.yml` for the exact command).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/stages.ts \
  apps/web/src/app/api/v1/stages/\[id\]/unpair/route.ts \
  apps/web/src/server/api-v1/openapi.ts \
  apps/web/src/server/api-v1/schemas.ts \
  apps/web/src/server/usecases/__tests__/swiss-shell-fixtures.test.ts
git commit -m "$(cat <<'EOF'
feat(swiss): Unpair clears the latest seated round onto kept shells

EOF
)"
```

---

### Task 5: Templates + Settings — organiser-set rounds everywhere

**Files:**
- Modify: `apps/web/src/components/v2/format-templates.ts`
- Modify: `apps/web/src/components/v2/__tests__/format-templates.test.ts`
- Modify: `apps/web/src/components/v2/division-settings.tsx`
- Modify: `apps/web/src/components/v2/division-builder.tsx` if copy still says “derived”

**Interfaces:**
- `swiss_playoff` / `swiss_knockout` Swiss drafts include `rounds` from knobs (same as plain `swiss`)
- `buildTemplateStages` applies `knobs.swissRounds` whenever `d.kind === "swiss"`
- Settings UI: editable rounds input for Playoff/Knockout too; remove “swissGen writes rounds at first generation” as the product story (optional hint via `swissRoundsForFieldSize` is fine — must not auto-write at generate)

- [ ] **Step 1: Flip format-templates tests**

```ts
it("swiss_playoff stamps knobs.swissRounds onto the swiss stage", () => {
  const stages = buildTemplateStages("swiss_playoff", { ...KNOBS, swissRounds: 4 });
  expect(stages[0]!.config).toMatchObject({ pairing: "rank_adjacent", rounds: 4 });
});
// same for swiss_knockout
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement template + settings changes**; update comments that document auto-derive.

- [ ] **Step 4: Run format-templates + any division-settings tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/v2/format-templates.ts \
  apps/web/src/components/v2/__tests__/format-templates.test.ts \
  apps/web/src/components/v2/division-settings.tsx \
  apps/web/src/components/v2/division-builder.tsx
git commit -m "$(cat <<'EOF'
feat(formats): require explicit Swiss rounds on Playoff and Knockout too

EOF
)"
```

---

### Task 6: Stage rail UI + i18n

**Files:**
- Modify: `apps/web/src/components/v2/desk/stage-rail.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Run: `pnpm i18n:gen-keys` → commit `i18n-keys.ts`

**Interfaces:**
- Extend `onAct` action union: `"generate" | "complete" | "delete" | "unpair"`
- Swiss label rules:
  - `fixtureCount === 0` → `schedule.generate`
  - else if any unseated Swiss fixture on this stage → `schedule.pairNext`
- Unpair is a **separate** button (`data-testid="stage-unpair"`), shown when `stage.kind === "swiss"` and `canUnpairSwiss` is true (derive from fixture props already loaded in `stages-panel`)

- [ ] **Step 1: Add locale keys** (all four dictionaries)

```json
"schedule.unpair": "Unpair last round",
"schedule.notice.unpaired": "Cleared pairings for round {round}",
"schedule.error.unpairFailed": "Could not unpair that round"
```

- [ ] **Step 2: Wire UI** in stage-rail + stages-panel `act("unpair")` → `POST /api/v1/stages/${id}/unpair`

- [ ] **Step 3: `pnpm i18n:gen-keys`** from the repo’s documented cwd

- [ ] **Step 4: Typecheck / existing panel tests if present**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/v2/desk/stage-rail.tsx \
  apps/web/src/components/v2/stages-panel.tsx \
  apps/web/src/dictionaries \
  apps/web/src/lib/i18n-keys.ts
git commit -m "$(cat <<'EOF'
feat(desk): Swiss Generate / Pair next / Unpair controls

EOF
)"
```

---

### Task 7: E2E

**Files:**
- Modify: `apps/web/e2e/formats.spec.ts` (swiss_knockout test ~231+)
- Create: `apps/web/e2e/swiss-shell.spec.ts`

**Interfaces:**
- Knockout e2e must: ensure `rounds` on swiss stage → Generate once → expect full shell count → Pair per round while deciding fixtures → complete swiss → finals as before
- New e2e: Generate → schedule a TBD shell → Pair R1 → score → Pair R2 → Unpair R2 → Pair R2 again

- [ ] **Step 1: Write / adjust e2e**

- [ ] **Step 2: Run the specific files** (full file, no `-g` slice):

```bash
cd <worktree>/apps/web && pnpm exec playwright test e2e/swiss-shell.spec.ts e2e/formats.spec.ts
```

(Re-read `playwright.config` for project names.)

- [ ] **Step 3: Fix until green**

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/swiss-shell.spec.ts apps/web/e2e/formats.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): Swiss shell mint, schedule-ahead, Pair, and Unpair

EOF
)"
```

---

### Task 8: Smoke

**Files:**
- Modify: `scripts/smoke.ts` (`swissKnockoutSuite` and/or new `swissShellSuite`)

**Interfaces:**
- Assert first Generate creates `N * boards` fixtures with null sides
- Assert second Generate seats R1 only while later rounds remain unseated (no `STAGE_NOT_READY` from future shells)
- Keep Top-N knockout assertions after the swiss half is fully paired + completed

- [ ] **Step 1: Update checks** that currently expect length growth one round at a time without a full mint

- [ ] **Step 2: Run smoke** with local env per `seazn-local-env`

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.ts
git commit -m "$(cat <<'EOF'
test(smoke): Swiss shells mint up front; Pair ignores future TBD rounds

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Organiser-set `rounds` required | 2, 5 |
| Mint empty shells 1…N on Generate | 2 |
| No auto-pair R1 on Generate | 2, 3 |
| Pair seats lowest unseated; readiness ignores unseated | 3 |
| Shell count locked at Generate | 1, 2 |
| Unpair Swiss-only, latest seated, bye≠played result | 4 |
| Keep schedule on Unpair | 4 |
| Stage rail Generate / Pair / Unpair | 6 |
| i18n 4 locales | 6 |
| Drop auto-derive persist; templates stamp rounds | 2, 5 |
| Unit + regression | 1–4 |
| E2E | 7 |
| Smoke | 8 |
| No Unpair on KO/playoff/finals | 4, 6 |
| Greenfield / no migration | Global |

## Placeholder / consistency self-review

- No TBD steps left; Pair is explicitly UPDATE-based (matches insert-only generate reality).
- Helper names (`nextUnseatedSwissRound`, `unpairSwissRound`) are stable across tasks.
- Bye mint = empty shell; bye seat = award on Pair; Unpair clears award — consistent with the spec.
