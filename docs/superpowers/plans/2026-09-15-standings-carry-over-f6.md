# F6 — Standings Carry-Over Reachability (#625) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sold Pro entitlement `standings.carry_over` reachable on the day-one (`timing: "setup"`) path by wiring carry at `confirmSeedProposal`, rejecting bad sources at propose time, relaxing the schema refine, and adding a picker control.

**Architecture:** Reuse engine `carryDeltas` and the existing `seedNextStage` carry block semantics. Extract a shared helper in `stages.ts` so setup-confirm and on_complete cannot drift. Schema + picker emit `progression.carry`; entitlement gate at `createStages` already charges Pro.

**Tech Stack:** TypeScript, Zod, postgres.js (`withTenant`), vitest (apps/web, `environment: "node"`), existing division-builder / format-templates picker, 4-locale `ui.json` + `pnpm i18n:gen-keys`.

**Spec:** `docs/superpowers/specs/2026-09-15-standings-carry-over-f6-design.md`  
**Issue:** #625 · Programme: `docs/superpowers/specs/2026-08-17-format-progression-prompts/_INDEX.md` F6 / ruling 12

## Global Constraints

- Work in a **new git worktree** off `main` (never check out in the main repo dir). Prefix every verify with `cd <abs worktree> &&`.
- Judge vitest only from `--reporter=json --outputFile=...` (`numPassedTests` / `numTotalTests`). Confirm `.testResults[].name` paths are under the worktree.
- New user-facing strings → all four `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then `pnpm i18n:gen-keys`; commit generated `i18n-keys.ts`.
- Do **not** change the engine `carryDeltas` implementation.
- Do **not** default templates to non-none carry.
- Do **not** touch scorer-role code (#707 is a separate plan).
- After rebase, re-read line numbers — citations below were pinned on main near V403 era.

---

## File map

| File | Responsibility |
|---|---|
| `apps/web/src/server/usecases/stages.ts` | Shared carry helper; call from `seedNextStage` + `confirmSeedProposal`; propose-time guard in `computeSeedProposal` |
| `apps/web/src/server/api-v1/schemas.ts` | Drop setup+carry refine |
| `apps/web/src/components/v2/format-templates.ts` | `StageDraft.progression.carry?` |
| `apps/web/src/components/v2/division-builder.tsx` | Carry control on progression-bearing templates |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` | Picker labels/help |
| `apps/web/src/server/usecases/__tests__/progression-schema.test.ts` | Accept setup+carry |
| `apps/web/src/server/usecases/__tests__/custom-points.test.ts` | Add confirm-path carry case (keep on_complete) |
| `apps/web/src/server/usecases/__tests__/progression-multi-source.test.ts` | Confirm or propose coverage as needed |
| New or extend: confirm/propose carry unit tests beside the above | Propose non-real 422; confirm writes deltas + event |

---

### Task 1: Schema — allow `setup` + carry

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts` (ProgressionSchema refine ~954–970)
- Test: `apps/web/src/server/usecases/__tests__/progression-schema.test.ts` (~222–250)

**Interfaces:**
- Consumes: `ProgressionSchema` fields `timing`, `carry`
- Produces: parse success for `{ timing: "setup", carry: "points" | "full", ... }`

- [ ] **Step 1: Write the failing test**

Flip the existing rejection cases to expect success:

```ts
it("accepts timing setup with carry points (F6)", () => {
  const r = ProgressionSchema.safeParse({
    sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
    placement: "rank_order",
    timing: "setup",
    carry: "points",
  });
  expect(r.success).toBe(true);
});

it("accepts timing setup with carry full (F6)", () => {
  const r = ProgressionSchema.safeParse({
    sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
    placement: "rank_order",
    timing: "setup",
    carry: "full",
  });
  expect(r.success).toBe(true);
});

it("still accepts setup with carry none / omitted", () => {
  // keep existing acceptance case
});
```

- [ ] **Step 2: Run test — expect FAIL** (still rejects carry path)

```bash
cd <worktree>/apps/web && pnpm exec vitest run src/server/usecases/__tests__/progression-schema.test.ts --reporter=json --outputFile=/tmp/f6-schema.json
node -e 'const j=require("/tmp/f6-schema.json"); console.log(j.numFailedTests,j.numPassedTests,j.numTotalTests)'
```

- [ ] **Step 3: Remove the refine** that encodes `timing === "on_complete" || carry === undefined || carry === "none"`. Replace the long F6 comment with a short note that F6 wired confirm-path carry. Keep other ProgressionSchema refines.

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/api-v1/schemas.ts apps/web/src/server/usecases/__tests__/progression-schema.test.ts
git commit -m "$(cat <<'EOF'
fix(f6): allow progression carry with timing setup

EOF
)"
```

---

### Task 2: Shared carry helper + propose-time rejection

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts` (`REAL_TABLE_KINDS`, `seedNextStage` carry block ~2735–2777, `computeSeedProposal` ~2948+)
- Test: extend `custom-points.test.ts` or add `carry-setup-path.test.ts` under `__tests__/`

**Interfaces:**
- Consumes: `carryDeltas` from `@seazn/engine/competition` (or existing import path in stages.ts); `SourceTables`; `resolved: { id, kind }[]`; entrant ids; `CarryMode`
- Produces: something like:

```ts
function assertCarrySourcesAreReal(
  resolved: { id: string; kind: string }[],
  carryMode: string,
): void; // throws HttpError 422 when non-real

function buildCarryDeltas(
  tables: SourceTables[],
  entrantIds: string[],
  carryMode: "points" | "full",
): unknown[];

// event write stays at call sites OR:
async function writeStandingsCarried(
  tx: Tx,
  args: { divisionId: string; stageId: string; from: string | string[]; mode: string; entrants: string[] },
): Promise<void>;
```

Exact names may match nearby style; keep one helper for deltas+validation used by both paths.

- [ ] **Step 1: Failing test — propose rejects bracket source + carry**

Arrange a setup-timing stage whose progression.sources point at a knockout/bracket kind, `carry: "points"`. Call `computeSeedProposal`. Expect `HttpError` 422 (or the project's seeding error helper) with message mentioning carry / table-stage.

- [ ] **Step 2: Run — FAIL** (propose currently ignores carry)

- [ ] **Step 3: Implement propose guard** after `sourcesToTables` in `computeSeedProposal`:

```ts
const carryMode = (progression as { carry?: string }).carry ?? "none";
if (carryMode !== "none") {
  const nonReal = resolved.find((s) => !REAL_TABLE_KINDS.has(s.kind));
  if (nonReal) {
    throw new HttpError(
      422,
      `carry-over needs a table-stage source (league/group/swiss) — a "${nonReal.kind}" completion has no real points to carry`,
      "SEEDING_CARRY_SOURCE_INVALID", // or existing code if one fits
      { stageId: nonReal.id, kind: nonReal.kind, carry: carryMode },
    );
  }
}
```

Export `REAL_TABLE_KINDS` if not already (scout: defined ~2249, may be module-private — export or share).

- [ ] **Step 4: Run propose test — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(f6): reject non-real carry sources at seed propose

EOF
)"
```

---

### Task 3: Wire carry at `confirmSeedProposal`

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts` (`confirmSeedProposal` ~3086–3220; refactor `seedNextStage` to use the same helper)
- Test: `apps/web/src/server/usecases/__tests__/custom-points.test.ts` (mirror on_complete assertions ~255–294 for setup+confirm)

**Interfaces:**
- Consumes: Task 2 helpers; `tables` + `resolved` from `sourcesToTables`; confirmed entrant ids from `expandedEntries`
- Produces: `stages.config.carry_deltas`; one `division_events` row `type = 'standings_carried'`

- [ ] **Step 1: Failing test — setup path carry on confirm**

Build the same league→knockout graph as the on_complete carry test, but with `timing: "setup"`, `carry: "points"`. Generate day-one fixtures, complete source, `computeSeedProposal` + `confirmSeedProposal`. Assert:

- target stage `config.carry_deltas` present and expected points (same A=9 style assertion as on_complete test)
- exactly one `standings_carried` event for that stage

- [ ] **Step 2: Run — FAIL** (confirm does not write carry today)

- [ ] **Step 3: Implement**

1. Change confirm's `sourcesToTables` destructure to `{ tables, resolved }`.
2. After Step 4 fills slots (or immediately before, once entrant set is final — prefer **after** validation, **with** `expandedEntries` entrant ids, still inside the same transaction):

```ts
const carryMode = (progression as { carry?: "none" | "points" | "full" }).carry ?? "none";
if (carryMode !== "none") {
  // assertCarrySourcesAreReal(resolved, carryMode) — belt; propose already checked
  const entrants = [...new Set(expandedEntries.map(([, id]) => id))];
  const carriedDeltas = buildCarryDeltas(tables, entrants, carryMode);
  await tx`update stages set config = ${tx.json({
    ...stage.config,
    ...(stage.config as object), // preserve qualified if any
    carry_deltas: carriedDeltas,
  } as never)} where id = ${stageId}`;
  // insert standings_carried + bump divisions.seq — mirror seedNextStage:2769-2777
}
```

3. Refactor `seedNextStage` carry block to call the same `buildCarryDeltas` / event writer so behaviour stays one source of truth.

- [ ] **Step 4: Run new test + existing `custom-points` on_complete carry + Community 402 — PASS**

```bash
cd <worktree>/apps/web && pnpm exec vitest run src/server/usecases/__tests__/custom-points.test.ts src/server/usecases/__tests__/progression-multi-source.test.ts --reporter=json --outputFile=/tmp/f6-carry.json
```

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(f6): apply standings carry on confirmSeedProposal

EOF
)"
```

---

### Task 4: Picker control + i18n

**Files:**
- Modify: `apps/web/src/components/v2/format-templates.ts` (`StageDraft.progression`)
- Modify: `apps/web/src/components/v2/division-builder.tsx`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Run: `pnpm i18n:gen-keys` → `apps/web/src/lib/i18n-keys.ts`
- Test: `format-templates.test.ts` / builder test if one exists for knobs; else add a small unit that `build()` can include `carry: "points"` when the control sets it

**Interfaces:**
- Consumes: template keys with non-null progression
- Produces: stages POST body including `progression.carry` when user selects Points/Full

- [ ] **Step 1: Add dictionary keys** (all 4 locales), e.g.:

```json
"format.carry.label": "Carry standings into next stage",
"format.carry.help": "Bring Phase-1 points (or full records) into Phase 2. Pro feature.",
"format.carry.none": "Do not carry",
"format.carry.points": "Points only",
"format.carry.full": "Full records"
```

(Adjust wording to match feature-copy tone; translate es/fr/nl.)

- [ ] **Step 2: Extend type**

```ts
progression: {
  sources: ...;
  placement: ...;
  map?: ...;
  timing: "setup" | "on_complete";
  carry?: "none" | "points" | "full";
} | null;
```

- [ ] **Step 3: UI** — when selected template's stages include any with `progression !== null`, show a `<select>` bound to carry mode; when building stages, set `progression: { ...p, carry }` on those stage drafts (omit or `"none"` when Do not carry).

- [ ] **Step 4: `pnpm i18n:gen-keys` && `pnpm i18n:check`**

- [ ] **Step 5: Unit** — builder/template test: with carry Points selected, `buildStages()` JSON includes `carry: "points"` on the finals stage.

- [ ] **Step 6: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(f6): add standings carry control to format picker

EOF
)"
```

---

### Task 5: Index + gates

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-format-progression-prompts/_INDEX.md` — mark F6 shipped / link this plan+spec
- Verify: typecheck/lint on touched packages

- [ ] **Step 1: Update F6 row status** to implemented with PR placeholder / commit SHAs when known.

- [ ] **Step 2: Run focused gates**

```bash
cd <worktree>/apps/web && pnpm exec vitest run \
  src/server/usecases/__tests__/progression-schema.test.ts \
  src/server/usecases/__tests__/custom-points.test.ts \
  src/server/usecases/__tests__/progression-multi-source.test.ts \
  --reporter=json --outputFile=/tmp/f6-gate.json
# confirm numFailedTests === 0 and names under worktree
```

- [ ] **Step 3: Commit docs**

---

## Self-review (author)

| Spec requirement | Task |
|---|---|
| Wire carry at confirmSeedProposal | Task 3 |
| Propose-time REAL_TABLE_KINDS rejection | Task 2 |
| Relax schemas refine | Task 1 |
| Picker control + 4 locales | Task 4 |
| Engine unchanged | Global constraint |
| Update schema/custom-points/multi-source tests | Tasks 1–3 |
| on_complete unchanged | Task 3 Step 4 |

No TBD placeholders. Types: `carry` union matches Zod enum and `CarryMode`.
