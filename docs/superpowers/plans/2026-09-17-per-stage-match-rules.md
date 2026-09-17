# Per-stage match-rules override — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each stage of a division override its match format (Best-of-1 in the Swiss stage, Best-of-3 in the playoff) instead of one setting for the whole division.

**Architecture:** A stage stores a partial override at `stages.config.rules`; the existing resolver `stageScopedCfg` overlays it on the division config, and the existing freeze-on-first-event keeps already-scored fixtures on the config they were scored under. One new endpoint writes it, one panel edits it, and the pad routes stop bypassing the resolver.

**Tech Stack:** Next.js App Router (see `node_modules/next/dist/docs/` — this is not the Next you know), TypeScript, zod, postgres.js tagged templates, vitest (`environment: "node"`, no DOM), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-17-per-stage-match-rules-override-design.md` — read it before Task 1. Every ruling (D1, D2, D2a, D3, D4, D5) is argued there; this plan only executes them.

**Worktree:** `/Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules`, branch `feat/stage-match-rules`, based on `main` `dc64cfcd6`. Never work in the main checkout.

## Global Constraints

- **Scope is four sports only:** `tennis`, `badminton`, `tabletennis`, `volleyball`. Any other `sport_key` is refused by the endpoint with 400.
- **Per stage, never per round.** A round is an integer column on `fixtures`; it carries no config.
- **Rule field labels stay canonical English** (owner ruling D4). No dictionary work for the nine field labels. The panel's OWN chrome (a "Same as division" control, a lock reason, an error string) is picker chrome and DOES owe all four dictionaries (`en`, `es`, `fr`, `nl`) plus a `gen-keys` regen with zero drift.
- **Every change ships a test that fails without it.** All four test types across the plan: unit, E2E, smoke, regression.
- **Judge vitest green only from the JSON reporter.** `cd apps/web && npx vitest run --reporter=json --outputFile=/tmp/r.json <paths>`, then read `numPassedTests`/`numTotalTests` and confirm `.testResults[].name` are the files you meant. A wrapper summary saying `PASS(0) FAIL(0)` means the suite failed to collect.
- **Non-DB suites need `DATABASE_URL= npx vitest run …`** (found in Task 1). With `DATABASE_URL` inherited from `.env.local` (the dev DB on 5432), `apps/web` vitest refuses to start and exits BEFORE writing `--outputFile` — so the symptom is `jq` reporting "Could not open file", which reads like a tooling glitch rather than a refusal. DB-backed suites (Tasks 3, 4, 5) need a real test database; bring it up via the `seazn-local-env` skill rather than pointing them at the dev DB.
- **Prefix every verify command with `cd <abs worktree> &&` in the same call** — the shell cwd resets to the main checkout between tool calls, and a run that silently executes on `main` returns a false green.
- **`git grep -n -a`**, not `rg` (returns empty in this shell) and not bare `grep` (reports source files as binary and hides lines).
- **Never `git stash` in this worktree** — the stash stack is shared with the main checkout. Use a WIP commit.
- **OpenAPI drift is a CI gate** (`ci.yml:92-96`): after any schema or route change run `npm run openapi:gen` and commit both `openapi/v1.json` and `openapi/v1.public.json`.
- **UI is verified by screenshot at 1280, 768 and 320**, no horizontal page scroll at any of them.

---

### Task 1: Extract the rules table out of the client module

Spec §T0. `match-rules.tsx:1` is `"use client"` and its only import is the dict provider (`:10`). A server module importing it receives client references, not values — and `schemas.ts` cannot hold the table either, because `scripts/openapi-gen.ts` runs that file under bare `node --experimental-strip-types`, which parses neither `@/` imports nor JSX. **A vitest test of the derivation passes either way** (node env, no RSC boundary), so getting this wrong ships green and inert; Task 3 is what proves it for real, from the server graph.

**Files:**
- Create: `apps/web/src/lib/match-rules.ts`
- Modify: `apps/web/src/components/v2/match-rules.tsx` (delete the moved code, re-export from the new module, keep `"use client"`, the dict import and the `MatchRuleFields` component)
- Create: `apps/web/src/lib/__tests__/match-rules-config-keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `RuleField` — moved verbatim, INCLUDING its existing optional `read?` member (football's two shoot-out fields already implement it). Task 6 adds implementations to that member; it does not add the member. `shootoutPointsPatch` moves too, staying module-private, because `SPORT_RULES.football` calls it.
  - `export const SPORT_RULES: Record<string, RuleField[]>`
  - `export function buildRuleOverride(sportKey: string, values: Record<string, string>): Record<string, unknown>`
  - `export function hydrateRuleValues(sportKey: string, config: unknown): Record<string, string>`
  - `export function configKeysFor(sportKey: string): ReadonlySet<string>`
  - `export const STAGE_RULES_SPORTS: ReadonlySet<string>` — the four in-scope sport keys.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/__tests__/match-rules-config-keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { configKeysFor, STAGE_RULES_SPORTS } from "@/lib/match-rules";

describe("configKeysFor", () => {
  // Tennis is the case that matters: three of its five FIELD keys differ from
  // the CONFIG keys their build() writes (setType -> set, noAd -> game,
  // tiebreakWinBy -> tiebreak). A list built from field.key would reject four
  // of five tennis overrides at the endpoint.
  it("returns the keys build() emits, not the field keys, for tennis", () => {
    const keys = configKeysFor("tennis");
    expect([...keys].sort()).toEqual(["bestOf", "finalSet", "game", "set", "tiebreak"]);
    expect(keys.has("setType")).toBe(false);
    expect(keys.has("noAd")).toBe(false);
    expect(keys.has("tiebreakWinBy")).toBe(false);
  });

  it("covers winBy for all three shared-const sports", () => {
    for (const sport of ["volleyball", "badminton", "tabletennis"])
      expect(configKeysFor(sport).has("winBy")).toBe(true);
  });

  it("never admits points or the decider keys for an in-scope sport", () => {
    for (const sport of STAGE_RULES_SPORTS) {
      const keys = configKeysFor(sport);
      expect(keys.has("points")).toBe(false);
      expect(keys.has("pointsMap")).toBe(false);
      expect(keys.has("shootout")).toBe(false);
      expect(keys.has("extraTime")).toBe(false);
    }
  });

  it("is empty for a sport with no rules table", () => {
    expect(configKeysFor("nosuchsport").size).toBe(0);
  });

  // Added after Task 1: cutting probeValuesFor down to the first option left
  // every other test green, because no IN-SCOPE field branches its emitted key
  // set on its value (carrom's gameTo is the only one in the whole table, and
  // it is out of scope). Without this case the multi-probe loop is an
  // unwitnessed guard — correct, but nothing reds if someone deletes it.
  it("probes every option, so a value-branching build cannot hide a key", () => {
    const branching: RuleField = {
      key: "probe",
      label: "Probe",
      kind: "select",
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      build: (v) => (v === "b" ? { onlyForB: 1 } : { always: 1 }),
    };
    expect(keysEmittedBy([branching])).toEqual(new Set(["always", "onlyForB"]));
  });
});
```

`keysEmittedBy(fields: RuleField[]): ReadonlySet<string>` is the inner half of
`configKeysFor`, exported from `lib/match-rules.ts` so a synthetic field can be
passed to it; `configKeysFor(sportKey)` becomes
`keysEmittedBy(SPORT_RULES[sportKey] ?? [])`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t1.json src/lib/__tests__/match-rules-config-keys.test.ts
```

Expected: collection error, `Cannot find module '@/lib/match-rules'`.

- [ ] **Step 3: Create the module by moving code**

Create `apps/web/src/lib/match-rules.ts`. **No `"use client"`, no JSX, no imports from `@/components/`.** Move verbatim out of `match-rules.tsx`: the `RuleField` interface (`:12`), `WIN_BY` (`:61`), `VOLLEYBALL_RULES` (`:71`), `BADMINTON_RULES` (`:107`), `TABLETENNIS_RULES` (`:143`), `SPORT_RULES` (`:206`), `buildRuleOverride` (`:677`) and `hydrateRuleValues` (`:701`). Keep the header comment explaining that field labels are canonical English. Then add:

```ts
/** The four sports whose stages may override match format (design D2a). */
export const STAGE_RULES_SPORTS: ReadonlySet<string> = new Set([
  "tennis",
  "badminton",
  "tabletennis",
  "volleyball",
]);

/** Every value a field can produce, so a build() that BRANCHES on its value
 *  cannot hide a config key behind an option we never probed. */
function probeValuesFor(field: RuleField): string[] {
  if (field.kind === "select") return (field.options ?? []).map((o) => o.value);
  if (field.kind === "bool") return ["on", "off"];
  return [String(field.min ?? 1)];
}

/** The CONFIG keys a sport's rule fields can write — NOT their field keys.
 *  `division-settings.tsx:273` maps `f.key`; copying that here would 400 four
 *  of tennis's five overrides, because `build` renames three of them. */
export function configKeysFor(sportKey: string): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const field of SPORT_RULES[sportKey] ?? []) {
    for (const probe of probeValuesFor(field))
      for (const k of Object.keys(field.build(probe, {}))) keys.add(k);
    if (field.buildOnBlank) for (const k of Object.keys(field.buildOnBlank({}))) keys.add(k);
  }
  return keys;
}
```

- [ ] **Step 4: Re-export from the client module**

In `match-rules.tsx`, delete the moved declarations and add below the dict import:

```ts
export type { RuleField } from "@/lib/match-rules";
export {
  SPORT_RULES,
  buildRuleOverride,
  hydrateRuleValues,
  configKeysFor,
  STAGE_RULES_SPORTS,
} from "@/lib/match-rules";
import { SPORT_RULES } from "@/lib/match-rules";
```

`MatchRuleFields` stays in the `.tsx` unchanged. Existing importers (`division-builder.tsx:9`, `division-settings.tsx:12`) keep working through the re-export.

- [ ] **Step 5: Run the new test and the existing suites that touch this file**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t1.json \
  src/lib/__tests__/match-rules-config-keys.test.ts src/components/v2/__tests__/
```

Expected: PASS, `numFailedTests: 0`. Confirm `.testResults[].name` lists both paths.

- [ ] **Step 6: Typecheck**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && npx tsc --noEmit; echo "EXIT=$?"
```

Expected: `EXIT=0`. (`rtk` prints "clean" while tsc exits 1 — read the exit code yourself.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/match-rules.ts apps/web/src/lib/__tests__/match-rules-config-keys.test.ts apps/web/src/components/v2/match-rules.tsx
git commit -m "refactor(match-rules): move the rules table into a server-importable module"
```

---

### Task 2: Overlay `stage.config.rules` in the resolver

Spec §T1. `stageScopedCfg` is the one place a stage's config reaches a fold.

**Files:**
- Modify: `apps/web/src/server/engine-db/stage-cfg.ts:11-22`
- Modify: `scripts/bench/lib/validate-pack.ts:394-406` (a deliberate field-for-field mirror with its own `STAGE_DECIDER_KEYS` at `:392`; its header at `:380-391` explains why it is mirrored rather than skipped — if it drifts, the bench folds stages under the wrong cfg)
- Modify: `apps/web/src/server/engine-db/competition.ts:249` (a comment reasoning about what `stageScopedCfg` can produce — this task widens it)
- Test: `apps/web/src/server/engine-db/__tests__/stage-cfg.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `stageScopedCfg(divisionCfg: unknown, stageCfg: Record<string, unknown> | null | undefined): unknown` — unchanged signature, new behavior.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/server/engine-db/__tests__/stage-cfg.test.ts`:

```ts
it("overlays stage.config.rules onto the division config, per key", () => {
  const division = { bestOf: 1, setTo: 21, cap: 30 };
  const out = stageScopedCfg(division, { rules: { bestOf: 3 } }) as Record<string, unknown>;
  expect(out).toEqual({ bestOf: 3, setTo: 21, cap: 30 });
});

it("lets a stage's own decider keys win over anything in rules", () => {
  // rules is applied FIRST, the decider loop second, so `shootout` has one
  // winner even if a future writer smuggles it into rules.
  const out = stageScopedCfg({ shootout: "none" }, {
    shootout: "best_of_five",
    rules: { shootout: "sudden_death" },
  }) as Record<string, unknown>;
  expect(out.shootout).toBe("best_of_five");
});

it("treats an explicit null in rules as no override, not as a value", () => {
  // "inherit" is key ABSENCE. Object.assign copies nulls, so a null that
  // reached the column would blank the division value.
  const out = stageScopedCfg({ bestOf: 3 }, { rules: { bestOf: null } }) as Record<string, unknown>;
  expect(out.bestOf).toBe(3);
});

it("is reference-identical when the stage carries no rules", () => {
  const division = { bestOf: 3 };
  expect(stageScopedCfg(division, { pairing: "fold" })).toBe(division);
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t2.json src/server/engine-db/__tests__/stage-cfg.test.ts
```

Expected: the three new overlay tests FAIL (`rules` ignored); the reference-identity test passes already.

- [ ] **Step 3: Implement**

Replace the body of `stageScopedCfg` in `apps/web/src/server/engine-db/stage-cfg.ts`:

```ts
export function stageScopedCfg(
  divisionCfg: unknown,
  stageCfg: Record<string, unknown> | null | undefined,
): unknown {
  if (stageCfg == null) return divisionCfg;
  const overlay: Record<string, unknown> = {};
  // Rules first, decider keys second: a stage's own `shootout`/`extraTime`
  // stay the single winner for those two keys (design T1).
  const rules = stageCfg.rules;
  if (rules != null && typeof rules === "object" && !Array.isArray(rules))
    for (const [k, v] of Object.entries(rules as Record<string, unknown>))
      if (v !== null && v !== undefined) overlay[k] = v;
  for (const key of STAGE_DECIDER_KEYS) {
    if (stageCfg[key] !== undefined) overlay[key] = stageCfg[key];
  }
  if (Object.keys(overlay).length === 0) return divisionCfg;
  return { ...(divisionCfg as Record<string, unknown>), ...overlay };
}
```

- [ ] **Step 4: Mirror it in the bench harness**

Apply the identical change to `stageScopedFoldCfg` in `scripts/bench/lib/validate-pack.ts:394-406`, and extend its header comment to name `rules` alongside the decider keys.

- [ ] **Step 5: Re-read and update the competition.ts comment**

`apps/web/src/server/engine-db/competition.ts:249` reasons about what `stageScopedCfg` can produce and concludes it "is safe today". Re-read it against the new behavior and update the wording so it describes what the overlay now admits.

- [ ] **Step 6: Run the tests**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t2.json src/server/engine-db/__tests__/
```

Expected: PASS, `numFailedTests: 0`.

- [ ] **Step 7: Mutation check — prove the tests bite**

Temporarily move the decider-key loop ABOVE the rules overlay. Re-run. Expected: the "decider keys win" test goes RED. Restore the order and re-run to green. If it stayed green, the test is decoration — fix the test before continuing.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/server/engine-db/stage-cfg.ts apps/web/src/server/engine-db/__tests__/stage-cfg.test.ts scripts/bench/lib/validate-pack.ts apps/web/src/server/engine-db/competition.ts
git commit -m "feat(engine-db): overlay stage.config.rules on the division config"
```

---

### Task 3: Make the six whole-config stage writers atomic

Spec §T2. Each of these reads a stage's config into JS, spreads it and writes the whole object back, with no row lock. A `rules` write landing inside that window is silently lost — no error, no conflict.

**Files:**
- Modify: `apps/web/src/server/usecases/stages.ts:3176`, `:3265`, `:3699`, `:3876`
- Modify: `apps/web/src/server/usecases/scoring.ts:555`, `:567`
- Test: `apps/web/src/server/usecases/__tests__/stage-config-atomic-write.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports. The invariant later tasks rely on: **a write that sets one stage-config key must not clobber another key written concurrently.**

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/usecases/__tests__/stage-config-atomic-write.test.ts`. Use the suite's existing DB harness (copy the setup from `apps/web/src/server/usecases/__tests__/add-fixture.test.ts`). The test: seed a stage whose config is `{rounds: 5}`; write `rules` directly with `config || jsonb_build_object('rules', …)`; then call the usecase that owns `stages.ts:3176`; finally re-read the row and assert **both** keys survive.

```ts
it("keeps a concurrently written rules key when another config key is set", async () => {
  // Reproduces the read-modify-write window: the usecase read its config
  // BEFORE the rules write landed, so a JS-side spread would write the old
  // object back and drop `rules` with no error.
  await tx`update stages set config = config || ${tx.json({ rules: { bestOf: 3 } })} where id = ${stageId}`;
  await theUsecaseUnderTest(auth, stageId, /* … */);
  const [row] = await tx<{ config: Record<string, unknown> }[]>`
    select config from stages where id = ${stageId}`;
  expect(row.config.rules).toEqual({ bestOf: 3 });
  expect(row.config.rounds).toBe(5);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t3.json src/server/usecases/__tests__/stage-config-atomic-write.test.ts
```

Expected: FAIL — `row.config.rules` is `undefined`.

- [ ] **Step 3: Convert the six writers**

Replace each `update stages set config = ${tx.json({ ...stage.config, key: value })}` with a server-side merge:

```ts
await tx`
  update stages
     set config = config || ${tx.json({ [key]: value })}
   where id = ${stageId}`;
```

**Do not copy `stages.ts:764` verbatim** — that one is guarded `and config->>'rounds' is null`, i.e. write-once, which is correct for `rounds` and wrong here. A `rules` write must be repeatable.

- [ ] **Step 4: Run the test plus the full usecases suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t3.json src/server/usecases/__tests__/
```

Expected: PASS, `numFailedTests: 0`. These six sites are on live paths (`scoring.ts:555,567` is the hot `recordResult` path) — a regression here is a scoring bug, so read the full count, not just your own file.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/stages.ts apps/web/src/server/usecases/scoring.ts apps/web/src/server/usecases/__tests__/stage-config-atomic-write.test.ts
git commit -m "fix(stages): merge stage config server-side instead of read-modify-write"
```

---

### Task 4: The endpoint — `PUT /stages/:id/rules`

Spec §T3, and the rulings D1 (lock), D2 (allowlist, validate the merge, store the fragment), D2a (sport gate, and close the `createStages` door). This is the task that proves Task 1's extraction really reaches the server.

**Files:**
- Create: `apps/web/src/server/usecases/stage-rules.ts`
- Create: `apps/web/src/app/api/v1/stages/[id]/rules/route.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts` (add `rules` to `StageConfig` after `extraTime:1033`; add `PutStageRules`)
- Modify: `apps/web/src/server/api-v1/openapi.ts` (register the route beside the court-tags entries at `:137-138`)
- Modify: `apps/web/src/server/usecases/stages.ts` (`createStages` rejects a `rules` key)
- Test: `apps/web/src/server/usecases/__tests__/stage-rules.test.ts` (create)

**Interfaces:**
- Consumes: `configKeysFor`, `STAGE_RULES_SPORTS` from Task 1; the atomic write shape from Task 3; the overlay from Task 2.
- Produces: `export async function putStageRules(auth: AuthCtx, stageId: string, input: { rules: Record<string, unknown> | null }): Promise<{ rules: Record<string, unknown> | null }>`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/server/usecases/__tests__/stage-rules.test.ts` (DB harness copied from `add-fixture.test.ts`):

```ts
it("stores an allowed override as a FRAGMENT, not a materialised config", async () => {
  await putStageRules(auth, stageId, { rules: { bestOf: 3 } });
  const [row] = await tx<{ config: Record<string, unknown> }[]>`
    select config from stages where id = ${stageId}`;
  // Storing parsed.data would write every defaulted key and pin the stage to
  // the whole division format forever.
  expect(row.config.rules).toEqual({ bestOf: 3 });
});

it("accepts a tennis CONFIG key and rejects the FORM key that writes it", async () => {
  await expect(putStageRules(auth, tennisStageId, { rules: { set: { to: 6 } } })).resolves.toBeTruthy();
  await expect(putStageRules(auth, tennisStageId, { rules: { setType: "standard" } }))
    .rejects.toMatchObject({ status: 400, code: "UNKNOWN_RULE_KEY" });
});

it("refuses points even though the sport's configSchema accepts it", async () => {
  // Tennis config genuinely carries a top-level `points`; the allowlist is
  // the only thing keeping a stage from setting it and bypassing the
  // standings.custom_points entitlement.
  await expect(putStageRules(auth, tennisStageId, { rules: { points: { win: 5, loss: 0 } } }))
    .rejects.toMatchObject({ status: 400, code: "UNKNOWN_RULE_KEY" });
});

it("refuses a sport outside the sets-based four", async () => {
  await expect(putStageRules(auth, footballStageId, { rules: { bestOf: 3 } }))
    .rejects.toMatchObject({ status: 400, code: "SPORT_NOT_SUPPORTED" });
});

it("422s when the MERGED config fails the module schema", async () => {
  await expect(putStageRules(auth, stageId, { rules: { bestOf: 0 } }))
    .rejects.toMatchObject({ status: 422, code: "CONFIG_INVALID" });
});

it("clears back to the division when rules is null", async () => {
  await putStageRules(auth, stageId, { rules: { bestOf: 3 } });
  await putStageRules(auth, stageId, { rules: null });
  const [row] = await tx<{ config: Record<string, unknown> }[]>`
    select config from stages where id = ${stageId}`;
  expect("rules" in row.config).toBe(false);
});

it("locks once a fixture in THAT stage has scored, and not before", async () => {
  await expect(putStageRules(auth, stageId, { rules: { bestOf: 3 } })).resolves.toBeTruthy();
  await appendFirstScoreEvent(fixtureInStage);       // freezes config_snapshot
  await expect(putStageRules(auth, stageId, { rules: { bestOf: 5 } }))
    .rejects.toMatchObject({ status: 409, code: "STAGE_FORMAT_LOCKED" });
  // A sibling stage that has not started stays editable.
  await expect(putStageRules(auth, otherStageId, { rules: { bestOf: 5 } })).resolves.toBeTruthy();
});

it("does not lock on a fixture whose start was voided back to scheduled", async () => {
  // fixtures.status is NON-MONOTONIC: voiding core.start returns the row to
  // 'scheduled' while the ledger and the frozen snapshot remain. A status
  // predicate would re-open a stage that has already been played.
  await appendFirstScoreEvent(fixtureInStage);
  await voidTheStart(fixtureInStage);
  await expect(putStageRules(auth, stageId, { rules: { bestOf: 5 } }))
    .rejects.toMatchObject({ status: 409, code: "STAGE_FORMAT_LOCKED" });
});

it("refuses a rules key through createStages", async () => {
  // createStages never parses stage config through any configSchema, and its
  // paywall check reads s.config.points, not s.config.rules.points — so a
  // football division could otherwise smuggle custom points in through it.
  await expect(
    createStages(auth, footballDivisionId, {
      stages: [{ seq: 1, kind: "league", name: "L", config: { rules: { points: { win: 5 } } } }],
    }),
  ).rejects.toMatchObject({ status: 400, code: "RULES_NOT_ACCEPTED_HERE" });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t4.json src/server/usecases/__tests__/stage-rules.test.ts
```

Expected: collection error — `stage-rules.ts` does not exist.

- [ ] **Step 3: Add the schemas**

In `apps/web/src/server/api-v1/schemas.ts`, inside the `StageConfig` `strictObject` after `extraTime` (`:1033`):

```ts
    /** Per-stage match-format override (design 2026-09-17). Deliberately
     *  loose HERE: this file runs under bare `node --experimental-strip-types`
     *  for openapi-gen and may not import `@/`, so it cannot see the rules
     *  table. The real allowlist + merged-config validation lives in
     *  `usecases/stage-rules.ts`, which can. */
    rules: z.record(z.string(), z.unknown()).nullish(),
```

And beside the other stage schemas:

```ts
export const PutStageRules = z.object({
  rules: z.record(z.string(), z.unknown()).nullable(),
});
export type PutStageRules = z.infer<typeof PutStageRules>;
export const StageRules = z.object({
  rules: z.record(z.string(), z.unknown()).nullable(),
});
```

- [ ] **Step 4: Write the usecase**

Create `apps/web/src/server/usecases/stage-rules.ts`:

```ts
import "server-only";
import { EngineError } from "@seazn/engine/core";
import { configKeysFor, STAGE_RULES_SPORTS } from "@/lib/match-rules";
import { resolveModule } from "@/server/engine-db";
import { HttpError } from "@/server/api-v1/http";
import type { AuthCtx } from "@/server/api-v1/auth";
import { withTenant } from "@/server/db";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";

export async function putStageRules(
  auth: AuthCtx,
  stageId: string,
  input: { rules: Record<string, unknown> | null },
): Promise<{ rules: Record<string, unknown> | null }> {
  // Resolved BEFORE the transaction: frozenCompetitionIds queries the pooled
  // `sql` proxy, and issuing that inside a withTenant callback that already
  // pins a connection is the self-deadlock documented on entitlement-freeze.ts.
  const frozen = await frozenCompetitionIds(auth.orgId);
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<
      {
        id: string;
        config: Record<string, unknown> | null;
        division_id: string;
        competition_id: string;
        sport_key: string;
        module_version: string;
        division_config: Record<string, unknown> | null;
      }[]
    >`
      select s.id, s.config, s.division_id, d.competition_id, d.sport_key,
             d.module_version, d.config as division_config
        from stages s join divisions d on d.id = s.division_id
       where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    assertNotFrozen(frozen, stage.competition_id);
    if (!STAGE_RULES_SPORTS.has(stage.sport_key))
      throw new HttpError(400, `${stage.sport_key} has no per-stage rules`, "SPORT_NOT_SUPPORTED");

    // D1: monotonic. fixtures.status moves BACKWARDS when a start is voided.
    const [locked] = await tx`
      select 1 from fixtures f
       where f.stage_id = ${stageId}
         and (f.config_snapshot is not null
              or exists(select 1 from score_events e where e.fixture_id = f.id))
       limit 1`;
    if (locked)
      throw new HttpError(409, "this stage has already started", "STAGE_FORMAT_LOCKED");

    if (input.rules === null) {
      await tx`update stages set config = config - 'rules' where id = ${stageId}`;
      await fireStageRevalidateAwaited(auth.orgId, stageId);
      return { rules: null };
    }

    // "Inherit" is key ABSENCE — a null that reached the column would blank
    // the division's value at the overlay.
    const fragment = Object.fromEntries(
      Object.entries(input.rules).filter(([, v]) => v !== null && v !== undefined),
    );
    const allowed = configKeysFor(stage.sport_key);
    for (const key of Object.keys(fragment))
      if (!allowed.has(key))
        throw new HttpError(400, `"${key}" is not a rule for ${stage.sport_key}`, "UNKNOWN_RULE_KEY");

    // Validate the MERGE, store the FRAGMENT: the fragment alone cannot be
    // parsed (defaults would fill it), and storing parsed.data would pin the
    // stage to a fully materialised copy of the division format.
    const module_ = resolveModule(stage.sport_key, stage.module_version);
    const parsed = module_.configSchema.safeParse({
      ...(stage.division_config ?? {}),
      ...fragment,
    });
    if (!parsed.success)
      throw new EngineError("CONFIG_INVALID", `invalid ${stage.sport_key} config`, {
        issues: parsed.error.issues,
      });

    await tx`
      update stages set config = config || ${tx.json({ rules: fragment })}
       where id = ${stageId}`;
    await fireStageRevalidateAwaited(auth.orgId, stageId);
    return { rules: fragment };
  });
}
```

For the revalidation: `fireStageRevalidate` (`stages.ts:1230`) is module-private and its four call sites are all `void`-prefixed — a recorded defect. **Await it here.** Export it from `stages.ts` (or lift it into a shared module) and call it with `(auth.orgId, stageId)`; do not add a fifth `void`.

- [ ] **Step 5: Close the `createStages` door**

In `createStages` (`apps/web/src/server/usecases/stages.ts:243`), before the insert, reject any stage whose config carries `rules`:

```ts
for (const s of inputs)
  if (s.config && "rules" in s.config)
    throw new HttpError(
      400,
      "per-stage rules are set through PUT /stages/{id}/rules",
      "RULES_NOT_ACCEPTED_HERE",
    );
```

Apply the same guard on the `replaceStages` path, which delegates to `createStages`.

- [ ] **Step 6: Add the route**

Create `apps/web/src/app/api/v1/stages/[id]/rules/route.ts`, mirroring the court-tags route:

```ts
import { requireResourceAuth } from "@/server/api-v1/auth";
import { parseBody, v1 } from "@/server/api-v1/http";
import { PutStageRules } from "@/server/api-v1/schemas";
import { putStageRules } from "@/server/usecases/stage-rules";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const body = await parseBody(req, PutStageRules);
    return putStageRules(auth, id, body);
  });
}
```

- [ ] **Step 7: Register it in OpenAPI and regenerate**

Add beside `openapi.ts:138`:

```ts
{ path: "/stages/{id}/rules", method: "put", summary: "Replace a stage's match-format override (sets-based sports only).", tag: "stages", request: S.PutStageRules, response: S.StageRules, errors: [400, 409, 422] },
```

Then:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules && npm run openapi:gen && git diff --stat openapi/
```

Expected: both `openapi/v1.json` and `openapi/v1.public.json` change. Commit them — CI fails on drift.

- [ ] **Step 8: Run the tests**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t4.json src/server/usecases/__tests__/
```

Expected: PASS, `numFailedTests: 0`.

- [ ] **Step 9: Mutation checks — three guards, one at a time**

Two guards covering for each other are each untested, so mutate them individually and re-run after each:

1. Delete the `STAGE_RULES_SPORTS` check → the football test must RED.
2. Replace the allowlist loop with `if (false)` → the `points` and `setType` tests must RED.
3. Change the lock predicate to `f.status = 'in_play'` → the voided-start test must RED.

Restore after each. Any mutant that stays green means that test is decoration — fix the test, not the mutant.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/server/usecases/stage-rules.ts apps/web/src/app/api/v1/stages/\[id\]/rules/route.ts apps/web/src/server/api-v1/schemas.ts apps/web/src/server/api-v1/openapi.ts apps/web/src/server/usecases/stages.ts apps/web/src/server/usecases/__tests__/stage-rules.test.ts openapi/v1.json openapi/v1.public.json
git commit -m "feat(stages): PUT /stages/:id/rules with a per-stage format lock"
```

---

### Task 5: Route the pad surfaces through the resolver

Spec §T4. Five surfaces read raw `division.config`, so a pad can render a different format than the fold used — today, before this feature exists. Both routes must add **two** columns: the stage's config AND `f.config_snapshot`. `hasFrozenCfg` treats `undefined` as absence (`fixture-cfg.ts:62-64`, trap documented at `:53-57`), so forgetting the snapshot renders live config for every scored fixture with no error at all.

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx:119`, `:171`
- Modify: `apps/web/src/app/score/[token]/page.tsx:84` (SQL), `:145`, `:168`, and the false comment at `:105-106`
- Modify: `apps/web/src/server/usecases/fixtures.ts:44-66` (`getFixture` selects neither column)
- Test: `apps/web/src/server/usecases/__tests__/pad-cfg-resolution.test.ts` (create)

**Interfaces:**
- Consumes: `stageScopedCfg` behavior from Task 2.
- Produces: no new exports.

- [ ] **Step 1: Write the failing regression tests**

Create `apps/web/src/server/usecases/__tests__/pad-cfg-resolution.test.ts`:

```ts
it("serves a scored fixture's FROZEN config, not the live division config", async () => {
  // The real regression risk of this task: these routes read live config
  // today, so a division edited after a match was scored already renders the
  // wrong format. Names the column deliberately — omitting config_snapshot
  // from the select fails silently, because undefined reads as "no snapshot".
  await appendFirstScoreEvent(fixtureId);                 // freezes bestOf: 1
  await patchDivisionConfig(divisionId, { bestOf: 5 });
  const loaded = await loadPadConfigFor(fixtureId);
  expect(loaded.bestOf).toBe(1);
});

it("serves the stage's override for an unstarted fixture", async () => {
  await putStageRules(auth, stageId, { rules: { bestOf: 3 } });
  const loaded = await loadPadConfigFor(unstartedFixtureInStage);
  expect(loaded.bestOf).toBe(3);
});

it("still applies a stage that carries only shootout", async () => {
  const loaded = await loadPadConfigFor(fixtureInDeciderStage);
  expect(loaded.shootout).toBe("best_of_five");
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t5.json src/server/usecases/__tests__/pad-cfg-resolution.test.ts
```

Expected: the first two FAIL.

- [ ] **Step 3: Widen the queries**

`getFixture` (`fixtures.ts:44-66`) must select `f.config_snapshot` and join the stage for its `config`. The device-link SQL at `score/[token]/page.tsx:82-92` currently aliases `d.config` as `fixture.config` — select `f.config_snapshot` and `s.config` as well.

- [ ] **Step 4: Resolve at all five call sites**

Replace each raw `division.config` read with:

```ts
const cfg = resolveFixtureCfg(fixture.config_snapshot, division.config, stage?.config);
```

matching the existing shape at `fold.ts:155` and `append-event.ts:245`. Sites: `f/[no]/page.tsx:119` (`rawConfig`) and `:171` (`sport.config`); `score/[token]/page.tsx:145` and `:168`.

- [ ] **Step 5: Correct the false comment**

`score/[token]/page.tsx:105-106` claims the device link's fixture carries its own resolved `config` column. It does not — the SQL aliases `d.config`. Rewrite it to describe what the code now does.

- [ ] **Step 6: Run the tests**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t5.json src/server/usecases/__tests__/
```

Expected: PASS, `numFailedTests: 0`.

- [ ] **Step 7: Mutation check**

Drop `f.config_snapshot` from the select (leave everything else). Expected: the frozen-config test goes RED. If it stays green, the test is not reading the path you think it is.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/o/\[orgSlug\]/c/\[compSlug\]/d/\[divSlug\]/f/\[no\]/page.tsx apps/web/src/app/score/\[token\]/page.tsx apps/web/src/server/usecases/fixtures.ts apps/web/src/server/usecases/__tests__/pad-cfg-resolution.test.ts
git commit -m "fix(pad): resolve fixture config through the resolver, not raw division config"
```

---

### Task 6: `read` for the in-scope fields, so an override round-trips

Spec §T5. Of 53 `RuleField` entries only two implement `read` (`match-rules.tsx:266,280`). None of the in-scope fields does, so a saved override reopens blank — a live defect in the division editor today, and the thing that would make Task 7's panel look broken.

**Files:**
- Modify: `apps/web/src/lib/match-rules.ts` (add `read` to the nine in-scope fields)
- Test: `apps/web/src/lib/__tests__/match-rules-hydrate.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's module.
- Produces: `hydrateRuleValues(sportKey, config)` returns a value for every in-scope field.

- [ ] **Step 1: Write the failing test**

```ts
it("round-trips every in-scope field through build and read", () => {
  for (const sport of STAGE_RULES_SPORTS) {
    for (const field of SPORT_RULES[sport]) {
      const probe = field.kind === "select" ? field.options![0].value : field.kind === "bool" ? "on" : "3";
      const built = field.build(probe, {});
      // Derived from the field's OWN build output, so a change to the source
      // of truth moves this test instead of leaving it on yesterday's values.
      expect(hydrateRuleValues(sport, built)[field.key]).toBe(probe);
    }
  }
});

it("hydrates from the stage FRAGMENT, returning nothing for an empty override", () => {
  // The panel must never hydrate from division or resolved config: those are
  // defaults-materialised, so every field would come back filled and the
  // first save would pin the whole division format onto the stage.
  expect(hydrateRuleValues("tennis", {})).toEqual({});
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t6.json src/lib/__tests__/match-rules-hydrate.test.ts
```

Expected: FAIL — `undefined` for `bestOf`.

- [ ] **Step 3: Implement `read` on the nine fields**

Each `read` is the inverse of that field's `build`. Tennis's three renamed fields read from their CONFIG keys (`set`, `game`, `tiebreak`), not their field keys. Example shape:

```ts
{ key: "bestOf", label: "Best of", kind: "select", options: [...],
  build: (v) => ({ bestOf: Number(v) }),
  read: (cfg) => (typeof cfg.bestOf === "number" ? String(cfg.bestOf) : undefined) },
```

- [ ] **Step 4: Run to green**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t6.json src/lib/__tests__/
```

Expected: PASS, `numFailedTests: 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/match-rules.ts apps/web/src/lib/__tests__/match-rules-hydrate.test.ts
git commit -m "fix(match-rules): hydrate saved rule values for the sets-based fields"
```

---

### Task 7: The Fixture Console stage panel

Spec §T6. The only editor. `stages-panel.tsx` is 1959 lines and maps stages at `:658-660`, rendering one `<StageRail>` per stage at `:1084`. Mutations go through `apiV1` from `@/lib/client-v1` with inline `error`/`notice` state — see the court-tags saver at `:1766-1783`. There is no toast library; follow the local pattern.

**Files:**
- Create: `apps/web/src/components/v2/stage-rules-panel.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (render it per stage)
- Modify: `apps/web/src/components/v2/division-settings.tsx:213-226` (`structureDraftsForApply`) and `:551-553` (`applyStructure`)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/components/v2/__tests__/stage-rules-panel.test.tsx` (create), `apps/web/src/components/v2/__tests__/division-settings-structure-preserves-rules.test.tsx` (create)

**Interfaces:**
- Consumes: `PUT /api/v1/stages/:id/rules` (Task 4); `hydrateRuleValues`, `buildRuleOverride`, `STAGE_RULES_SPORTS` (Tasks 1, 6).
- Produces: `<StageRulesPanel stageId sportKey rules locked />`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("submits only the fields the organiser changed", async () => {
  // buildRuleOverride skips blanks, so an untouched field must not be sent —
  // sending it would convert "inherit" into a pin at the division's value.
  render(<StageRulesPanel stageId="s1" sportKey="tennis" rules={{}} locked={false} />);
  // set Best of -> 3, save
  expect(lastRequestBody()).toEqual({ rules: { bestOf: 3 } });
});

it("hydrates from the stage's own fragment", () => {
  render(<StageRulesPanel stageId="s1" sportKey="tennis" rules={{ bestOf: 3 }} locked={false} />);
  expect(screen.getByLabelText("Best of")).toHaveValue("3");
});

it("disables the controls and states why when the stage has started", () => {
  render(<StageRulesPanel stageId="s1" sportKey="tennis" rules={{}} locked={true} />);
  expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
});
```

Plus, for `structureDraftsForApply`:

```ts
it("carries each surviving stage's rules through a Format-tab apply", () => {
  // applyStructure rebuilds stage drafts from the template; without this the
  // organiser loses every stage override by nudging an unrelated knob.
  const drafts = structureDraftsForApply("league_ko", knobs, "points", existingStages);
  expect(drafts[0].config.rules).toEqual({ bestOf: 1 });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t7.json src/components/v2/__tests__/
```

- [ ] **Step 3: Build the panel**

`<StageRulesPanel>` renders a "Same as division" state by default; expanding shows `MatchRuleFields` seeded from `hydrateRuleValues(sportKey, rules ?? {})`. Save calls:

```tsx
await apiV1(`/api/v1/stages/${stageId}/rules`, {
  method: "PUT",
  json: { rules: buildRuleOverride(sportKey, values) },
});
```

"Same as division" sends `{ rules: null }`. Render nothing at all when `!STAGE_RULES_SPORTS.has(sportKey)`.

- [ ] **Step 4: Mount it per stage**

In `stages-panel.tsx`, inside the stage map (`:658-660`), render `<StageRulesPanel>` within the stage's card. Pass `locked` from the stage's own started-state.

- [ ] **Step 5: Preserve rules through `applyStructure`**

`structureDraftsForApply` rebuilds drafts purely from `buildTemplateStages(templateKey, knobs)`. Thread the existing stages in and copy each surviving stage's `config.rules` onto the matching draft.

- [ ] **Step 6: Add the chrome copy to all four dictionaries**

The nine FIELD labels stay English (D4). The panel's own strings — "Same as division", the lock reason, the save/failure notices — are picker chrome and need `en`, `es`, `fr`, `nl`, then:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules && npm run gen-keys && git diff --stat apps/web/src/lib/i18n-keys.ts
```

`i18n-keys.ts` is GENERATED — rerun it and require zero drift afterwards.

- [ ] **Step 7: Run the tests**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t7.json src/components/v2/__tests__/
```

Expected: PASS, `numFailedTests: 0`.

- [ ] **Step 8: Screenshot the panel at three widths**

Bring up the local env via the `seazn-local-env` skill, open a division's `?tab=fixtures`, and capture 1280, 768 and 320 — collapsed, expanded, and locked. Confirm the images EXIST and DIFFER from one another (a capture harness that errors early collects a sign-off on zero pictures), and that no width has horizontal page scroll.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/v2/stage-rules-panel.tsx apps/web/src/components/v2/stages-panel.tsx apps/web/src/components/v2/division-settings.tsx apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts apps/web/src/components/v2/__tests__/
git commit -m "feat(fixture-console): per-stage match rules panel"
```

---

### Task 8: Stage-aware format line on the public hub

Spec §T7/D3. `formatLine` is built from raw division config at `competition-hub.ts:665` — `describeFormat`'s only production caller. `describeFormat` is pure and takes a bare cfg (`describe-format.ts:94-98`), so it is callable per stage.

**Files:**
- Modify: `apps/web/src/server/public-site/competition-hub-schema.ts:103-134`
- Modify: `apps/web/src/server/public-site/competition-hub.ts:665` (build), `:1042` (cache key)
- Modify: the hub division renderer under `apps/web/src/components/public-site/matches-hub/`
- Test: `apps/web/src/server/public-site/__tests__/competition-hub.test.ts:2489` (the cache-key assertion moves)

**Interfaces:**
- Consumes: `stageScopedCfg` (Task 2).
- Produces: `HubDivision.stageFormatLines?: { stageName: string; line: Msg }[]`.

- [ ] **Step 1: Write the failing test**

```ts
it("gives each stage its own format line when a stage overrides the format", async () => {
  const doc = await buildHubDocument(competitionId);
  expect(doc.divisions[0].stageFormatLines).toEqual([
    { stageName: "Swiss", line: expect.objectContaining({ params: { bestOf: 1 } }) },
    { stageName: "Playoff", line: expect.objectContaining({ params: { bestOf: 3 } }) },
  ]);
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t8.json src/server/public-site/__tests__/competition-hub.test.ts
```

- [ ] **Step 3: Extend the schema**

In `competition-hub-schema.ts`, on `HubDivision`:

```ts
  /** Per-stage format, when stages differ. OPTIONAL by the rule at :123-130:
   *  the hub API answers s-maxage=30 / stale-while-revalidate=300, so a new
   *  bundle polls documents built before this field existed. */
  stageFormatLines: z.array(z.object({ stageName: z.string(), line: Msg })).optional(),
```

- [ ] **Step 4: Build it**

The hub query must additionally select `s.config`. Then:

```ts
stageFormatLines: stages.map((s) => ({
  stageName: s.name,
  line: describeFormat(d.sport_key, module_, stageScopedCfg(d.config, s.config)),
})),
```

Leave `formatLine` (`:119`) as the division-level default.

- [ ] **Step 5: Bump the cache key**

`competition-hub.ts:1042`: `pub-hub-v3` → `pub-hub-v4`. `unstable_cache` otherwise serves an old-shaped document the page never re-parses. Update the assertion at `competition-hub.test.ts:2489`, which pins `["pub-hub-v3","comp-1"]`.

- [ ] **Step 6: Render it**, then regenerate OpenAPI (the hub document is public schema):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules && npm run openapi:gen && git diff --stat openapi/
```

- [ ] **Step 7: Run the public-site suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/t8.json src/server/public-site/__tests__/
```

Expected: PASS, `numFailedTests: 0`.

- [ ] **Step 8: Screenshot the hub division view** at 1280, 768 and 320. The spectator programme's visual gate applies here: per-screen verdicts, no horizontal scroll.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/server/public-site/ apps/web/src/components/public-site/matches-hub/ openapi/v1.json openapi/v1.public.json
git commit -m "feat(hub): per-stage format lines on the public competition hub"
```

---

### Task 9: End-to-end, smoke, and the gates

Spec §Testing. The e2e is what proves the seam is not inert: a builder test and a fold test can both pass while nothing joins them.

**Files:**
- Create: `apps/web/e2e/stage-rules.spec.ts`
- Modify: `scripts/smoke.ts`

- [ ] **Step 1: Write the e2e**

A sets-sport division with two stages. Set the first to one format and the second to another **through the panel, in the browser** — not by seeding the database, which would prove only that the fixture works. Then open the pad on a fixture in each stage and assert the format each one renders.

Two constraints, or the test cannot witness the bug it exists for:

- **Pick values that differ from the skins' fallbacks.** `cfg.bestOf ?? 3` for tennis and badminton, `?? 5` for volleyball and tabletennis — a Bo3 tennis override is indistinguishable from the default. Use, say, Bo1 and Bo5.
- **Derive both expectations from `configSchema.parse` output**, not from a constant typed into the test, so a change to the source of truth moves the test with it.

The only cfg-derived text the skins render is a translated context line taking `bestOf` as a param (`tennis.tsx:507`, `badminton.tsx:601`, `volleyball.tsx:657`, `tabletennis.tsx:529`). **Assert on a testid and a value, never on English text** — a text assertion is locale-coupled and proves reachability, not value. If no testid exposes it, add one.

Then: score a fixture, confirm its frozen config does not move, and confirm the stage is now locked in the panel.

- [ ] **Step 2: Prove the selector before trusting it**

Run just the first assertion and confirm it reads the value you expect. A selector that matches nothing makes the whole spec vacuous.

- [ ] **Step 3: Mutant — set both stages to the same format**

Re-run. The spec MUST go red. If it stays green, it is not reading per-stage config at all. Restore.

- [ ] **Step 4: Add the smoke leg**

In `scripts/smoke.ts`: set a stage override, reload the console, confirm it hydrates back into the panel. That is the round-trip Task 6 exists for. Note `smoke.ts` has no suite filter — isolate via a temporary entry-point copy while iterating.

- [ ] **Step 5: Run the full spec file, never a `-g` slice**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  PLAYWRIGHT_BASE=http://localhost:<port> npx playwright test e2e/stage-rules.spec.ts
```

Use `localhost`, never `127.0.0.1`. A `-g` filter is a filename sweep in disguise and has already missed the tests a change broke.

- [ ] **Step 6: Run every gate and paste the raw counts**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && npx tsc --noEmit; echo "EXIT=$?"
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules && rtk proxy npm run lint    # read "✖ N problems"; rtk hides this output
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/full.json
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules && npm run openapi:gen && git diff --exit-code openapi/; echo "DRIFT_EXIT=$?"
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stage-match-rules && npm run gen-keys && git diff --exit-code apps/web/src/lib/i18n-keys.ts; echo "I18N_EXIT=$?"
```

Report `numPassedTests`/`numTotalTests`/`numFailedTests` verbatim. A summary saying "tests pass" without counts is not acceptance.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/stage-rules.spec.ts scripts/smoke.ts
git commit -m "test(stage-rules): e2e and smoke coverage for per-stage formats"
```

- [ ] **Step 8: Reviewer pass before the PR**

Dispatch a reviewer over the whole branch diff. A green branch has twice been Needs Fixes here; run it anyway.

- [ ] **Step 9: Open the PR, then dispatch e2e by hand**

A PR gets **zero** automatic e2e signal — `e2e.yml` triggers on push to `main` plus `workflow_dispatch`. Read the workflow file rather than trusting this line; its trigger has changed three times in one day before.

```bash
gh workflow run e2e.yml -f pr=<N>
```

Smoke, by contrast, runs on PRs only. Both are needed; neither substitutes for the other.

---

## Self-Review

**Spec coverage:** T0→Task 1, T1→Task 2, T2→Task 3, T3→Task 4, T4→Task 5, T5→Task 6, T6→Task 7, T7→Task 8, Testing→Task 9. D1 in Task 4 steps 4/9; D2 and D2a in Task 4 steps 3-5 and 9; D3 in Task 8; D4 (labels stay English) in Global Constraints and Task 7 step 6; D5 needs no code, being the absence of a gate. Known gaps stay recorded, not built.

**Type consistency:** `configKeysFor` / `STAGE_RULES_SPORTS` / `buildRuleOverride` / `hydrateRuleValues` are produced in Task 1 and consumed under those exact names in Tasks 4, 6 and 7. `putStageRules(auth, stageId, {rules})` is produced in Task 4 and called under that name in Tasks 5 and 7. `stageScopedCfg`'s signature does not change.

**Known soft spot:** Task 3's test and Task 5's helpers (`loadPadConfigFor`, `appendFirstScoreEvent`, `voidTheStart`) name the DB harness generically; the implementer must copy the concrete setup from `add-fixture.test.ts` in that suite rather than invent one. Flagged rather than faked.
