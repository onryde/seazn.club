# Entitlements v18 — W1: Scoring Goes Free (R9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A free-plan organisation records every event type of every sport at every detail band, through the fixture-events route and the batch importer, and the recording chip becomes a plain detail picker with no lock and no upsell.

**Architecture:** Delete the legacy `fidelityTiers` paywall model end to end — the zod type and module field in the engine, the eight per-module arrays, the server predicate `requiredFeatureForEvent` and its call in `assertEntitledToScore`, and `PadSpec.fidelityEntitlements` with its two resolvers. `PadSpec.fidelity` (one band per event type) is the single remaining model and is purely a UX filter: the scorer picks the band in the chip, `pad-host` filters tiles by that choice, nothing reads an entitlement. The three `scoring.*` feature keys leave the matrix, the domains list, the copy, the dictionaries, the help tree, the smoke script and the pricing page. Engine test-kit readers (`golden.ts`, `conformance.ts`, `discipline.test.ts`) are re-pointed at `padSpec.fidelity` BEFORE the arrays are deleted, behind a parity test that proves the two enumerations agree, so golden coverage cannot silently shrink.

**Tech Stack:** TypeScript 7 (dual compiler, see `docs/superpowers/RULES.md`), Node 26, Next.js (read `node_modules/next/dist/docs/` before touching app code), vitest (`environment: "node"` in apps/web — no DOM), Playwright e2e, Flyway SQL deltas, four locale dictionaries + generated `lib/i18n-keys.ts`.

**Spec:** `docs/superpowers/specs/2026-09-02-entitlements-v18-three-tier-design.md` (§6 "R9 — scoring free", §8 "R9 acceptance", §9 W1). Wave prompt: `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/R9-scoring-free.md`. Read `_RULES.md` and the R9 block of `_INDEX.md` (lines 4200–4238) in that directory before starting.

## Global Constraints

- **Charge for leverage, never for correctness** (spec, R8). Scoring detail is never paywalled after this wave. `scoring.device_links`, `cricket.dls`, `stats.player`, `scoring.audit_export`, `scoring.swap_off_step_enforcement` are NOT in scope — do not touch their gates (spec §10; `cricket.dls` changes in W2).
- **Delete, do not stub.** `requiredFeatureForEvent` dies; an always-null function is an inert seam (R9 §Scope 1). Same for `fidelityEntitlements`, `resolveFidelityEntitlements`, `resolveFidelityBand`.
- **Every change ships a test that fails without it.** Every removed guard is mutation-proven: restore the guard, watch the new test go red, remove it again (R9 §Acceptance).
- **Sweep by behaviour, never by filename** (AGENTS.md #16): the identifiers to grep are `fidelityTiers`, `FidelityTier`, `requiredFeatureForEvent`, `assertEntitledToScore`, `fidelityEntitlements`, `entitledBands`, `RALLY_ENTITLEMENT`, `scoring.ball_by_ball`, `scoring.rally_by_rally`, `scoring.match_timeline`, `rallyEntitlement`, `timelineEntitlement`, `recording.locked`. Always `grep -a` (files here report as binary).
- **User-facing strings live in all four dictionaries** (`apps/web/src/dictionaries/{en,es,fr,nl}/`), never hardcoded; after any key change run the key generator so `lib/i18n-keys.ts` is regenerated (it is GENERATED — never hand-edit). `content/help/**` is English-only.
- **UI verification:** `frontend-design:frontend-design` BEFORE the chip's visual work; two layout options shown to the owner before building; screenshots at 1280 / 768 / 320 with no horizontal page scroll; a walkthrough after each task group (owner rule: per task, not per wave).
- **Verification traps** (AGENTS.md): judge vitest green ONLY from `--reporter=json --outputFile` counts; run vitest from `cd apps/web` or `cd packages/engine`, never repo root, never `--root`; read lint through `rtk proxy npm run lint`; confirm `.testResults[].name` paths resolve into THIS worktree; the shell cwd resets between calls — prefix every command with `cd <abs worktree> &&`.
- **Git:** work in the worktree `<repo>/.claude/worktrees/ent-w1` on branch `feat/entitlements-w1-scoring-free`; never `git stash` in a worktree (shared stash stack); commit after every task with the trailer below. Do not open a PR without the owner's word.
- **Commit trailer (every commit):**
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012XNVTB7kp4KG2zGBDm4RY1
  ```
- Scratch files go under `/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/f85cd91b-6548-4372-b7d6-807a5702d395/scratchpad` (call it `$SCRATCH`), never bare `/tmp` (paths collide across sessions).

## Corrections to the R9 prompt (verified 2026-09-02 — findings, not blockers)

1. R9 line ~50 says `icehockey.suspension.start` 402s for `scoring.match_timeline` in smoke. **False today**: `scripts/smoke.ts:5548-5567` already asserts `201` for it (moved out of the gated list by an R6 fix pass). The gated tuples at `5513-5535` are `football.sinbin.start → scoring.match_timeline`, `tabletennis.expedite.start → scoring.rally_by_rally`, `tennis.interruption → scoring.rally_by_rally`, asserted at `5542-5546`.
2. R9 line ~55 cites `entitlements-v2.test.ts:219-227, 365, 452` for `football.card`. **Wrong lines**: 219-227 is an entrant-cap test, 365 a `core.start` call, 452 a comment. The `football.card` 402 assertions are at **234 (asserted 333), 402 (asserted 405), 489 (asserted 492)**; the Pro-allowed case is 358-362.
3. `V288__v13_fidelity.sql` has nothing to do with scoring tiers ("fidelity" there means competition-data fidelity). The three keys were inserted by `V112__entitlements_v2.sql:48-56` and granted to `pro_plus` by `V290:19-32`.
4. `transport.ts` has no dedicated 402 / `feature_key` branch (402 is handled as generic permanent 4xx at `209-212`). Nothing to remove there.
5. `copy-truth.ts` has zero fidelity guards today. The guard that stops "free in product, paid on the page" is NEW in Task 6.
6. `en/marketing.json` has 447 keys; es/fr/nl have 446. Pre-existing one-key drift, not ours. Record it in the closeout, do not fix it in this wave.

## File Structure

**Engine (`packages/engine/src`)**
- `sport/module.ts` — delete `FidelityTier` (64-69) and `fidelityTiers` field (500); delete `fidelityEntitlements` from `PadSpec` (349); rewrite the 102-116 comment to describe the single model.
- `sports/football/football.ts` (arrays 2653-2689; `fidelityEntitlements` 2405), `sports/cricket/cricket.ts` (3458-3488; 3003), `sports/carrom/carrom.ts` (993-996; 709), `sports/boardgame/boardgame.ts` (738-742; 487), `sports/generic/generic.ts` (662-665; 393), `sports/setbased/kernel.ts` (2250-2255; 1824 + preset `rallyEntitlement`), `sports/period/kernel.ts` (1870-1875; 2191-2192 + preset `timelineEntitlement`), `sports/nested/kernel.ts` (2039-2052; 1712 + preset `rallyEntitlement`).
- `testkit/golden.ts` (`tierEventTypes` 278-281), `testkit/conformance.ts` (102-103), `testkit/conformance-pad.ts` (486, 488), `conformance/discipline.test.ts` (25-28), and the sport tests listed in Task 2.
- NEW temporary `sport/__tests__/fidelity-parity.test.ts` — dies in Task 2 with the arrays.

**Server (`apps/web/src/server/usecases`)**
- `fidelity.ts` — keep only `resolveScorePadBootstrap` (chassis key) and the `ScorePadBootstrap` shape without `band`.
- `scoring.ts` — `assertEntitledToScore` loses lines 266-268 (module resolve + feature + requireFeature for fidelity). DLS gate at 270-272 stays.
- `event-import.ts` — lines 246-247 go; DLS accumulation stays.
- `__tests__/fidelity.test.ts`, `__tests__/entitlements-v2.test.ts`, `__tests__/event-import-dryrun.test.ts`, `__tests__/_rig.ts:174`.

**Pad (`apps/web/src/components/v2/scorepad`)**
- `registry.tsx:136-146` — `ScorePadBootstrap` drops `band`.
- `v3/pad-host.tsx` — delete `entitledBandsFrom` (174-184) and the `entitledBands` memo (1367); add band state; `filterTilesByBand` (686-701) takes the chosen band; chip call (1907) passes `activeBand` + `onBandChange`.
- `v3/recording-chip.tsx` — becomes a four-option picker; no `entitledBands`, no `fidelityEntitlements`, no `locked`, no `upsell`, no `featurePlan`/`planLabel`.
- `v3/skins/badminton.tsx:134,846`, `tabletennis.tsx:124,679`, `volleyball.tsx:284,804` — `RALLY_ENTITLEMENT` and the `plan:` upsell interpolation go.
- Tests under `v2/scorepad/__tests__` and `v3/__tests__` listed in Task 4.

**Copy, matrix, help, smoke**
- `lib/entitlement-domains.ts:30`, `lib/feature-copy.ts:41-43`, `lib/pricing-cards.ts:67`, `lib/__tests__/_approved-dictionary-copy.ts:523`, `lib/__tests__/pricing-cards.test.ts:582-583`, `lib/__tests__/dictionary-copy-truth.test.ts:1428`.
- Dictionaries ×4: `ui.json` keys `pad.recording.locked`, `pad.badminton.context.recording.locked`, `pad.tabletennis.context.recording.locked`, `pad.volleyball.context.recording.locked`, `billing.pro.f4`; `marketing.json` keys `pricing.matrix.scoring.ball_by_ball`, `.rally_by_rally`, `.match_timeline`.
- `content/help/scoring/basics.md`, `scoring/cricket.md`, `scoring/device-links.md`, `scoring/batch-import.md`, `divisions/discipline.md`.
- `scripts/smoke.ts:5486-5567`, `scripts/smoke-sports.ts`, `scripts/seed-demo.ts`.
- NEW guard in `lib/copy-truth.ts`: `scoringFreeClaimFaults`.

**Data**
- NEW `db/migration/deltas/V390__scoring_free.sql`.

**Docs**
- `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/_INDEX.md` — R9 closeout block; D-7 closed.

---

### Task 0: Environment — worktree, database, server

**Files:** none in the repo.

- [ ] **Step 1: Invoke the environment skill and follow it exactly**

Run the Skill tool with `seazn-local-env`. Follow its §1–§4 in order for: a worktree at `/Users/ashokhein/github/seazn.club/.claude/worktrees/ent-w1` on branch `feat/entitlements-w1-scoring-free` cut from current `origin/main`; a FRESH database for this wave (its §2: `db:apply` AND `sync:sports`, then `show data_directory` to confirm the server is yours); a prod build + server on a free port only when a task says so (Tasks 5 and 7).

Expected: the worktree has its own `node_modules` (a fresh worktree has none — the skill's install step is not optional), `git -C <worktree> status -sb` shows `## feat/entitlements-w1-scoring-free...`, and `psql "$DATABASE_URL" -Atc "select max(version) from seazn_club.flyway_schema_history"` prints `389`.

- [ ] **Step 2: Baseline the three suites you will change, with JSON reporters**

```bash
W=/Users/ashokhein/github/seazn.club/.claude/worktrees/ent-w1
S=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/f85cd91b-6548-4372-b7d6-807a5702d395/scratchpad
cd $W/packages/engine && npx vitest run --reporter=json --outputFile=$S/w1-engine-baseline.json >/dev/null 2>&1; node -e "const r=require('$S/w1-engine-baseline.json');console.log('engine',r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests,'suitesFailed',r.numFailedTestSuites)"
cd $W/apps/web && npx vitest run src/server/usecases/__tests__/fidelity.test.ts src/server/usecases/__tests__/entitlements-v2.test.ts src/components/v2/scorepad --reporter=json --outputFile=$S/w1-web-baseline.json >/dev/null 2>&1; node -e "const r=require('$S/w1-web-baseline.json');console.log('web',r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests,'suitesFailed',r.numFailedTestSuites);console.log(r.testResults[0].name)"
```

Expected: `numFailedTestSuites` is `0` in both; the printed `testResults[0].name` starts with `$W/` (not the main checkout). Write the two count lines into `$S/w1-baseline.txt` — every later gate is compared against them.

---

### Task 1: Engine — re-point the test-kit readers at `padSpec.fidelity` behind a parity proof

The arrays cannot be deleted while `golden.ts`, `conformance.ts` and `discipline.test.ts` read them. First prove that `padSpec.fidelity`'s keys enumerate the same event types the arrays do, then move the readers.

**Files:**
- Create: `packages/engine/src/sport/__tests__/fidelity-parity.test.ts` (temporary; deleted in Task 2)
- Modify: `packages/engine/src/testkit/golden.ts:278-281`
- Modify: `packages/engine/src/testkit/conformance.ts:102-103`
- Modify: `packages/engine/src/conformance/discipline.test.ts:25-28`

**Interfaces:**
- Produces: `tierEventTypes(module: AnySportModule, cfg: unknown): string[]` (now derived from `module.padSpec(cfg).fidelity`), and a `padEventTypes` helper next to it. Task 2 relies on no reader of `fidelityTiers` surviving in `testkit/` or `conformance/`.

- [ ] **Step 1: Find how golden.ts obtains a module config and enumerates modules**

Run: `cd $W/packages/engine && grep -n -a -E "tierEventTypes|uncoveredTierTypes|defaultConfig|configSchema.parse|for \(const module|registry" src/testkit/golden.ts | head -30` and `grep -n -a -E "export (const|function) (ALL_MODULES|registry|modules)" -r src | head`.

Write down: (a) the identifier that yields every shipped module, (b) the config each golden fixture replays with (the fixture file carries it — quote the field name), (c) whether `padSpec` is optional on the module type (`grep -n -a "padSpec" src/sport/module.ts`). These three facts feed Steps 2–4; do not guess them.

- [ ] **Step 2: Write the parity test (must pass BEFORE any deletion)**

```ts
// packages/engine/src/sport/__tests__/fidelity-parity.test.ts
// TEMPORARY (W1 Task 1): proves PadSpec.fidelity enumerates every event type the
// legacy fidelityTiers arrays name, per shipped module, so the golden/conformance
// readers can move to padSpec.fidelity without shrinking coverage. Dies in Task 2.
import { describe, expect, it } from "vitest";
import { ALL_MODULES } from "<the identifier from Step 1a>";

describe("fidelityTiers → padSpec.fidelity parity (W1 Task 1 precondition)", () => {
  for (const module of ALL_MODULES) {
    it(`${module.key}: padSpec.fidelity ⊇ fidelityTiers event types`, () => {
      const cfg = module.configSchema.parse(<the default config source from Step 1b>);
      const spec = module.padSpec?.(cfg);
      expect(spec, `${module.key} has no padSpec`).toBeDefined();
      const tierTypes = new Set(module.fidelityTiers.flatMap((t) => t.eventTypes));
      const padTypes = new Set(Object.keys(spec!.fidelity));
      const missing = [...tierTypes].filter((t) => !padTypes.has(t));
      expect(missing, `${module.key}: in fidelityTiers but not in padSpec.fidelity`).toEqual([]);
    });
  }
});
```

If a module has no `padSpec`, STOP and record it as a finding in `_INDEX.md`'s R9 block — the spec's premise "PadSpec.fidelity becomes the single model" would be false for that module and the owner decides.

- [ ] **Step 3: Run the parity test**

Run: `cd $W/packages/engine && npx vitest run src/sport/__tests__/fidelity-parity.test.ts --reporter=json --outputFile=$S/w1-t1-parity.json >/dev/null 2>&1; node -e "const r=require('$S/w1-t1-parity.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests)"`

Expected: `failed 0`, total ≥ 8 (one per module incl. every preset the setbased/period/nested kernels build). A red here is a FINDING (the two models disagree on coverage, not only on band value); record it and stop.

- [ ] **Step 4: Move `tierEventTypes` to `padSpec.fidelity`**

In `packages/engine/src/testkit/golden.ts` replace lines 278-281 with:

```ts
/** Every event type the module bands in PadSpec.fidelity — the single fidelity
 *  model since W1 (scoring free). Replaces the legacy fidelityTiers enumeration;
 *  parity was proven by sport/__tests__/fidelity-parity.test.ts before the swap. */
export function tierEventTypes(module: AnySportModule, cfg: unknown): string[] {
  const spec = module.padSpec?.(module.configSchema.parse(cfg));
  if (!spec) throw new Error(`${module.key}: golden coverage needs a padSpec`);
  return [...new Set(Object.keys(spec.fidelity))].sort();
}
```

Then update every caller (`grep -n -a "tierEventTypes(" src`) to pass the fixture's config (Step 1b). `uncoveredTierTypes` and the `EXTEND_GOLDEN` gate keep their behaviour.

- [ ] **Step 5: Move the conformance identity check and `emitsCards`**

`packages/engine/src/testkit/conformance.ts:102-103` — replace the two `fidelityTiers` lines with:

```ts
      const spec = module.padSpec?.(module.configSchema.parse(sampleConfig));
      expect(spec, "every module declares a padSpec").toBeDefined();
      expect(Object.keys(spec!.fidelity).length).toBeGreaterThan(0);
```

(`sampleConfig` is whatever the identity test already parses two lines above — read it; if the block has no config in scope, reuse the module's golden fixture config from Step 1b.)

`packages/engine/src/conformance/discipline.test.ts:25-28` — replace the body of `emitsCards` with:

```ts
function emitsCards(module: AnySportModule): boolean {
  const spec = module.padSpec?.(module.configSchema.parse(<same config source>));
  return Object.keys(spec?.fidelity ?? {}).some((t) => CARD_EVENT.test(t));
}
```

- [ ] **Step 6: Run the engine suite; compare with baseline**

Run: `cd $W/packages/engine && npx vitest run --reporter=json --outputFile=$S/w1-t1-engine.json >/dev/null 2>&1; node -e "const r=require('$S/w1-t1-engine.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests,'suitesFailed',r.numFailedTestSuites)"`

Expected: `failed 0`, `suitesFailed 0`, total = baseline total + the parity tests. Then the coverage gate the engine CI runs (read `packages/engine/package.json` scripts for the coverage command; core stays at 100%).

- [ ] **Step 7: Commit**

```bash
cd $W && git add packages/engine && git commit -m "test(engine): read fidelity from padSpec.fidelity in golden/conformance readers, behind a parity proof

W1 (scoring free) precondition: tierEventTypes, the identity check and
emitsCards no longer read fidelityTiers. A temporary parity test proves
padSpec.fidelity covers every event type the arrays named, per module.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012XNVTB7kp4KG2zGBDm4RY1"
```

---

### Task 2: Engine — delete `fidelityTiers`, `FidelityTier` and `PadSpec.fidelityEntitlements`

**Files:**
- Modify: `packages/engine/src/sport/module.ts:64-69, 102-116, 349, 500`
- Modify: the eight module files at the line ranges in File Structure, plus each kernel's preset type (`rallyEntitlement` in setbased + nested, `timelineEntitlement` in period)
- Modify: `packages/engine/src/testkit/conformance-pad.ts:486,488`
- Modify: comments at `packages/engine/src/core/lineup.ts:193`, `core/events.ts:101`, `sports/period/kernel.ts:1852-1856`
- Modify (tests): `sports/setbased/expedite.test.ts:396-401`, `setbased/attribution.test.ts:356-364`, `football/football.domain.test.ts:400,478,556,757`, `cricket/cricket.domain.test.ts:658`, `period/period-audit.test.ts:728-771`, `nested/interruption.test.ts:590`, `nested/game-award.test.ts:285`, `nested/attribution.test.ts:271-272`, `testkit/conformance.test.ts:191-193`, `testkit/conformance-pad.test.ts:121`
- Delete: `packages/engine/src/sport/__tests__/fidelity-parity.test.ts`

**Interfaces:**
- Produces: `PadSpec = { panels; fidelity }` (no `fidelityEntitlements`); `SportModule` has no `fidelityTiers`. Tasks 3–4 compile against this.

- [ ] **Step 1: Write the tests that pin the new shape (they fail until the deletion)**

Add to `packages/engine/src/testkit/conformance.ts` inside the identity `it` (after the padSpec lines from Task 1):

```ts
      // W1: the legacy paywall model is gone. A module that still carries it is a
      // regression — this line does not compile once the field is deleted, which
      // is the point: the type system is the guard from Task 2 on.
      expect("fidelityTiers" in module).toBe(false);
      expect("fidelityEntitlements" in spec!).toBe(false);
```

Run the engine suite once: both expectations must be RED against the current tree (record the two failing counts). If either is already green, the sweep missed nothing and you can drop that line — say so in the commit body.

- [ ] **Step 2: Delete the declarations**

In `sport/module.ts`: remove `FidelityTier` (64-69) and its export; remove `fidelityTiers: FidelityTier[]; // doc 14 §2` (500); remove `fidelityEntitlements: Readonly<Partial<Record<FidelityBand, string>>>;` (349); replace the comment block 102-116 with:

```ts
/**
 * `fidelity` names ONE detail band (0–3) per event type. Since W1 of the
 * entitlements v18 programme (2026-09) it is a UX filter only — the scorer
 * picks how much detail to record, and the pad hides tiles above that band.
 * No band is paywalled and nothing in apps/web reads an entitlement from it.
 * The 0–3 scale is closed (v2 ruling); its semantics live in this file.
 */
```

Then in each of the eight module files delete the `fidelityTiers:` array at the cited range and the `fidelityEntitlements:` line; in the three kernels delete the preset fields `rallyEntitlement` / `timelineEntitlement` from the preset type AND from every preset literal (`grep -n -a "rallyEntitlement\|timelineEntitlement" src/sports`). In `testkit/conformance-pad.ts` remove the validator lines 486 and 488. Rewrite the three comments to no longer cite the removed model.

- [ ] **Step 3: Move each sport test off the arrays**

For every test line listed above, read the assertion and rewrite it against `padSpec.fidelity`. Two shapes cover all of them:

```ts
// was: expect(module.fidelityTiers.find(t => t.tier === 3)!.eventTypes).toContain("tabletennis.expedite.start")
const spec = module.padSpec!(module.configSchema.parse(cfg));
expect(spec.fidelity["tabletennis.expedite.start"]).toBe(3);
```

```ts
// was: a loop asserting every tier>1 type carries an entitlement
// now: assert the band exists and is in the closed scale
for (const [type, band] of Object.entries(spec.fidelity)) expect([0, 1, 2, 3]).toContain(band);
```

Each rewritten test keeps a one-line comment `// W1: formerly asserted the fidelityTiers declaration; the arrays are gone, the band is the same.`

- [ ] **Step 4: Delete the parity test, run tsc + suite + coverage**

```bash
cd $W && git rm -q packages/engine/src/sport/__tests__/fidelity-parity.test.ts
cd $W/packages/engine && npx tsc --noEmit -p . 2>&1 | tail -3
git -C $W grep -a -n -E "fidelityTiers|FidelityTier\b|fidelityEntitlements|rallyEntitlement|timelineEntitlement" -- packages/engine | wc -l
npx vitest run --reporter=json --outputFile=$S/w1-t2-engine.json >/dev/null 2>&1; node -e "const r=require('$S/w1-t2-engine.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests,'suitesFailed',r.numFailedTestSuites)"
```

Expected: tsc prints no errors; the grep count is `0`; `failed 0`, `suitesFailed 0`; total = Task 1 total − parity tests. Then the engine coverage command from Task 1 Step 6 (core 100%).

- [ ] **Step 5: Commit**

```bash
cd $W && git add -A packages/engine && git commit -m "refactor(engine): retire the fidelityTiers paywall model; PadSpec.fidelity is the single band model

Deletes FidelityTier, SportModule.fidelityTiers, PadSpec.fidelityEntitlements
and the per-module arrays/entitlement presets (football, cricket, carrom,
boardgame, generic, setbased/period/nested kernels). Sport tests now assert
bands on padSpec.fidelity. Scoring detail is no longer a price boundary
(owner ruling 2026-08-30, entitlements v18 W1).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012XNVTB7kp4KG2zGBDm4RY1"
```

---

### Task 3: Server — remove the scoring gate from both HTTP doors; migration V390

**Files:**
- Modify: `apps/web/src/server/usecases/fidelity.ts` (delete 22-34, 36-63, 65-90; keep `resolveScorePadBootstrap` minus band)
- Modify: `apps/web/src/server/usecases/scoring.ts:266-268` (+ the `requiredFeatureForEvent`/`resolveModule` imports if now unused)
- Modify: `apps/web/src/server/usecases/event-import.ts:246-247`
- Modify: `apps/web/src/components/v2/scorepad/registry.tsx:136-146` (`ScorePadBootstrap` loses `band`)
- Modify: `apps/web/src/server/usecases/__tests__/fidelity.test.ts` (blocks 20-172 die; 174-301 adapt)
- Modify: `apps/web/src/server/usecases/__tests__/entitlements-v2.test.ts:234/333, 402/405, 489/492`
- Modify: `apps/web/src/server/usecases/__tests__/event-import-dryrun.test.ts:172,183,188`, `__tests__/_rig.ts:174`
- Create: `apps/web/src/server/usecases/__tests__/scoring-free.test.ts`
- Create: `db/migration/deltas/V390__scoring_free.sql`

**Interfaces:**
- Consumes: `PadSpec` without `fidelityEntitlements` (Task 2).
- Produces: `resolveScorePadBootstrap(params): Promise<ScorePadBootstrap | null>` with `ScorePadBootstrap = { moduleVersion; resolvedConfig; initialEvents; entitlements: Record<string, boolean> /* chassis keys only */; identity }`. Task 4's pad reads no `band` from it.

- [ ] **Step 1: Write the failing test — a community org scores a band-3 event on every shipped sport, through `scoreEvent`, and the importer accepts the same events**

```ts
// apps/web/src/server/usecases/__tests__/scoring-free.test.ts
// W1 (entitlements v18): scoring detail is never paywalled. Formerly
// entitlements-v2.test.ts asserted 402 + feature_key "scoring.match_timeline"
// for football.card on a community org; that refusal no longer exists.
import { describe, expect, it } from "vitest";
import { scoreEvent } from "@/server/usecases/scoring";
import { makeCommunityRig } from "./_rig"; // use the rig helper entitlements-v2.test.ts uses for its community org + fixture

// One event per sport at its highest band. Read each module's padSpec.fidelity
// and pick a type banded 3 (2 where the sport has no 3) so the test moves with
// the engine, never with a table typed here.
import { ALL_MODULES } from "<same identifier as Task 1 Step 1a>";

describe("scoring is free on every plan (R9)", () => {
  for (const module of ALL_MODULES) {
    it(`${module.key}: a community org records a top-band event`, async () => {
      const rig = await makeCommunityRig(module.key); // starts the division + fixture, returns { auth, fixtureId, cfg }
      const spec = module.padSpec!(module.configSchema.parse(rig.cfg));
      const top = Math.max(...Object.values(spec.fidelity));
      const type = Object.entries(spec.fidelity).find(([, b]) => b === top)![0];
      const payload = rig.minimalPayloadFor(type); // the rig already builds valid payloads for entitlements-v2's cases
      const res = await scoreEvent(rig.auth, rig.fixtureId, { expected_seq: rig.seq, type, payload });
      expect(res.status ?? 201).not.toBe(402);
    });
  }
});
```

Where the rig lacks a helper the comment names, add it to `_rig.ts` in this task (the rig already seeds community orgs and starts fixtures for `entitlements-v2.test.ts`; extend, do not fork). If `scoreEvent` throws a typed `HttpError(402)` rather than returning a status, assert `await expect(...).resolves` and `rejects.not.toMatchObject({ status: 402 })` accordingly — read how `entitlements-v2.test.ts:333` asserts today and mirror the inverse.

- [ ] **Step 2: Run it — it must fail with 402 for at least football, cricket and one racquet sport**

Run: `cd $W/apps/web && npx vitest run src/server/usecases/__tests__/scoring-free.test.ts --reporter=json --outputFile=$S/w1-t3-red.json >/dev/null 2>&1; node -e "const r=require('$S/w1-t3-red.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests)"`

Expected: `failed ≥ 3`. Paste the failing names into the commit body later — they are the mutation proof's before-picture.

- [ ] **Step 3: Remove the gate**

`scoring.ts` — delete lines 266-268:
```ts
  const sportModule = resolveModule(ctx.sport_key, ctx.module_version);
  const feature = requiredFeatureForEvent(sportModule, input.type);
  if (feature) await requireFeature(auth.orgId, feature);
```
Keep 270-272 (DLS). Remove the now-unused imports. Add above the DLS block: `// W1: scoring detail is free on every plan; only the DLS rain-rule gate remains here until W2.`

`event-import.ts` — delete 246-247 (`const feature = requiredFeatureForEvent(...)`, `if (feature) requiredFeatures.add(feature)`); keep the DLS accumulation and the `requireFeature` loop (it still serves `cricket.dls`).

`fidelity.ts` — delete `requiredFeatureForEvent` (22-34), `resolveFidelityEntitlements` (36-63), `resolveFidelityBand` (65-90). Rewrite `resolveScorePadBootstrap` as:

```ts
export async function resolveScorePadBootstrap(params: {
  sportModule: AnySportModule;
  rawConfig: unknown;
  hasFeatureFn: (featureKey: string) => Promise<boolean>;
  initialEvents: readonly EventEnvelope[];
  identity: OwnIdentity;
}): Promise<ScorePadBootstrap | null> {
  try {
    const resolvedConfig: unknown = params.sportModule.configSchema.parse(params.rawConfig);
    // W1: fidelity bands are a UX choice, never an entitlement. The only key the
    // pad still needs resolved is the swap-sheet OFF-step chassis flag.
    const swapOffStepEnforcement = await params.hasFeatureFn(SWAP_OFF_STEP_ENFORCEMENT_KEY);
    return {
      moduleVersion: params.sportModule.version,
      resolvedConfig,
      initialEvents: params.initialEvents,
      entitlements: { [SWAP_OFF_STEP_ENFORCEMENT_KEY]: swapOffStepEnforcement },
      identity: params.identity,
    };
  } catch {
    return null;
  }
}
```

`registry.tsx:136-146` — delete `band: FidelityBand;` from `ScorePadBootstrap` (and the now-unused `FidelityBand` import if any). `EMPTY_SPEC` in fidelity.ts becomes `{ panels: [], fidelity: {} }` or is deleted if unused.

- [ ] **Step 4: Move the pinned tests deliberately**

`fidelity.test.ts`: delete describes at 20-97 and 98-172 (their subjects no longer exist). In 174-301: drop `band` expectations (178-193, 228-252), keep 194 (null on bad config), 206 (initialEvents verbatim), 253 (swap key resolved via `hasFeatureFn`, not hardcoded); rewrite 271 as "does not resolve any fidelity key — `hasFeatureFn` is called exactly once, with the swap key". Each surviving `it` that changed gets `// W1: formerly also asserted <x>; bands are no longer resolved from entitlements.`

`entitlements-v2.test.ts`: at 234/333, 402/405, 489/492 flip the assertion from `402 + featureKey "scoring.match_timeline"` to success, each with `// W1: formerly asserted 402 scoring.match_timeline — scoring detail is free on every plan since R9.` Keep 358-362 as is (it now proves the same thing for Pro).

`event-import-dryrun.test.ts:172,183,188` and `_rig.ts:174`: remove the fidelity feature expectation; the dry-run's `requiredFeatures` for a community org importing football cards is now `[]` (or `["cricket.dls"]` only where DLS applies).

- [ ] **Step 5: Migration**

```sql
-- db/migration/deltas/V390__scoring_free.sql
-- Entitlements v18 W1 (R9, owner ruling 2026-08-30): scoring detail is never a
-- price boundary. The three fidelity keys leave the matrix on every plan; their
-- server gate (requiredFeatureForEvent) is deleted in the same wave, so a
-- lingering row would be an inert seam. Overrides for these keys go too.
delete from org_entitlement_overrides
 where feature_key in ('scoring.ball_by_ball', 'scoring.rally_by_rally', 'scoring.match_timeline');
delete from plan_entitlements
 where feature_key in ('scoring.ball_by_ball', 'scoring.rally_by_rally', 'scoring.match_timeline');
```

Apply it to the wave DB per the environment skill (`db:apply` against THIS wave's `DATABASE_URL`, never without env — that migrates the dev DB). Confirm: `psql "$DATABASE_URL" -Atc "select count(*) from seazn_club.plan_entitlements where feature_key like 'scoring.%'"` prints the count of the remaining `scoring.*` keys (`scoring.device_links`, `scoring.audit_export`, `scoring.swap_off_step_enforcement` → `3` per plan that has them; anything mentioning the three deleted keys → `0`).

Check whether `org_entitlement_overrides` has a `feature_key` column before running (`\d seazn_club.org_entitlement_overrides`); if its column is named differently, use that name — do not drop the statement.

- [ ] **Step 6: Run the server suites; then the mutation proof**

```bash
cd $W/apps/web && npx vitest run src/server/usecases/__tests__/scoring-free.test.ts src/server/usecases/__tests__/fidelity.test.ts src/server/usecases/__tests__/entitlements-v2.test.ts src/server/usecases/__tests__/event-import-dryrun.test.ts src/server/usecases/__tests__/scoring-dls-gate.test.ts --reporter=json --outputFile=$S/w1-t3-green.json >/dev/null 2>&1; node -e "const r=require('$S/w1-t3-green.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests,'suitesFailed',r.numFailedTestSuites)"
```
Expected: `failed 0`, `suitesFailed 0`, `scoring-dls-gate` still green (DLS untouched).

Mutation: `git stash` is forbidden in a worktree — instead re-insert the three deleted lines in `scoring.ts` by hand with a temporary local `requiredFeatureForEvent` that returns `"scoring.match_timeline"` for any non-`core.` type, run `scoring-free.test.ts`, confirm ≥ 3 red, then delete the insertion. Record "mutation: N red" in the commit body.

- [ ] **Step 7: Commit**

```bash
cd $W && git add apps/web/src/server apps/web/src/components/v2/scorepad/registry.tsx db/migration/deltas/V390__scoring_free.sql && git commit -m "feat(scoring): scoring detail is free on every plan — gate removed from scoreEvent and the batch importer; V390 drops the three keys

Deletes requiredFeatureForEvent, resolveFidelityEntitlements and
resolveFidelityBand; the pad bootstrap resolves only the swap-sheet chassis
key and carries no band. entitlements-v2 and the dry-run tests now assert the
inverse of yesterday's 402s, each with a comment saying what they used to
assert. Mutation proof: <N> red with the gate restored.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012XNVTB7kp4KG2zGBDm4RY1"
```

---

### Task 4: Pad — band is the scorer's choice; the chip is a picker; skins lose the upsell

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/pad-host.tsx:167-184, 686-701, 1336, 1367, 1374-1377, 1409, 1907`
- Modify: `apps/web/src/components/v2/scorepad/v3/recording-chip.tsx` (whole file, 240 lines)
- Modify: `apps/web/src/components/v2/scorepad/v3/skins/badminton.tsx:134,846`, `tabletennis.tsx:124,679`, `volleyball.tsx:284,804,1333`
- Modify: `apps/web/src/components/v2/scorepad/refusal-copy.ts:12` (comment) and every comment listed under "comment-only" in the scout output (`timeline.tsx:78`, `v3/skins/generic.tsx:286`, `v3/activity.tsx:97`, `v3/types.ts:818`, `upgrade-gate.tsx:39`)
- Modify (tests): `v3/__tests__/recording.test.ts`, `v3/__tests__/pad-host.test.ts:186,444,809,821,825`, `v3/__tests__/recording-chip.test.tsx`, `v3/__tests__/refused-write.test.ts:6,69-71,268`, `v3/__tests__/band-filter.test.ts`, `v2/scorepad/__tests__/view-model.test.ts:166,195,199,217`, `__tests__/refusal-copy.test.ts:48,53`, `v3/__tests__/more-tile-suppression.test.ts`, skins tests for badminton/tabletennis/volleyball that import `RALLY_ENTITLEMENT`, `app/.../import/__tests__/import-client.test.tsx:166,210`
- Modify: dictionaries ×4 (`ui.json`): delete `pad.recording.locked`, `pad.badminton.context.recording.locked`, `pad.tabletennis.context.recording.locked`, `pad.volleyball.context.recording.locked`; add `pad.recording.pick` = "Recording detail" (en; es/fr/nl translations in the same commit); keep `pad.recording.band.0..3`.
- Regenerate: `apps/web/src/lib/i18n-keys.ts` via the repo's key generator (find it: `grep -n "gen-keys\|i18n-keys" apps/web/package.json package.json`).

**Interfaces:**
- Consumes: `ScorePadBootstrap` without `band` (Task 3).
- Produces: `RecordingChipProps = { activeBand: FidelityBand; onBandChange: (b: FidelityBand) => void; t: MsgFn }`; `pad-host` owns `band` state, persisted per fixture under `localStorage["seazn.pad.band.<fixtureId>"]`, default `3`.

- [ ] **Step 1 (design gate, BEFORE code): invoke `frontend-design:frontend-design`, then show the owner two chip layouts**

Produce two static mock renders of the picker (segmented control of four bands vs. a compact chip that opens a four-row sheet) as PNGs at 320 and 768 in `$SCRATCH/w1-chip-option-{a,b}-{320,768}.png`, send them with SendUserFile, and STOP for the owner's pick. Do not build until the owner answers. (Standing rule: ≥ 2 UI options first; restyles need sign-off.)

- [ ] **Step 2: Write the failing tests**

`v3/__tests__/recording-chip.test.tsx` — replace the lock/upsell cases with:

```tsx
it("renders four bands, marks the active one, and reports a pick", () => {
  const picks: FidelityBand[] = [];
  const el = renderChip({ activeBand: 3, onBandChange: (b) => picks.push(b), t });
  expect(el.querySelectorAll('[data-band]').length).toBe(4);
  expect(el.querySelector('[data-band="3"][aria-pressed="true"]')).not.toBeNull();
  click(el.querySelector('[data-band="1"]')!);
  expect(picks).toEqual([1]);
});
it("never renders a lock, an upsell, or a plan name", () => {
  const el = renderChip({ activeBand: 0, onBandChange: () => {}, t });
  expect(el.textContent).not.toMatch(/available on|Pro|🔒/);
});
```
(Use the same render harness the file already uses — it is a static render in a node environment; keep `data-band` and `aria-pressed` as the contract so the e2e in Step 6 can hit-test them.)

`v3/__tests__/band-filter.test.ts` — the filter takes a band, not a set:
```ts
it("hides tiles banded above the chosen band and never hides the More tile", () => {
  const tiles = filterTilesByBand(allTiles, {}, [], { "x.a": 0, "x.b": 2, "x.c": 3 }, 2);
  expect(tiles.map((t) => t.type)).toEqual(expect.arrayContaining(["x.a", "x.b"]));
  expect(tiles.map((t) => t.type)).not.toContain("x.c");
});
```

`v3/__tests__/pad-host.test.ts` — replace the `entitledBands` cases at 186/444/809/821/825 with: default band is 3 when nothing is stored; a stored `"1"` under `seazn.pad.band.<fixtureId>` is honoured; a pick writes the key (wrap the storage double in the same shim the suite already uses for `window`, since there is no jsdom).

- [ ] **Step 3: Run them — red**

Run: `cd $W/apps/web && npx vitest run src/components/v2/scorepad/v3/__tests__/recording-chip.test.tsx src/components/v2/scorepad/v3/__tests__/band-filter.test.ts src/components/v2/scorepad/v3/__tests__/pad-host.test.ts --reporter=json --outputFile=$S/w1-t4-red.json >/dev/null 2>&1; node -e "const r=require('$S/w1-t4-red.json');console.log('failed',r.numFailedTests,'suitesFailed',r.numFailedTestSuites)"`

Expected: `failed ≥ 4` (suites may fail to COLLECT on the changed prop types — that counts as red here, but note it: a collection failure is not a passing test).

- [ ] **Step 4: Implement**

`pad-host.tsx`:
- delete `ALL_BANDS` if unused after the change, delete `entitledBandsFrom` (174-184) and the `entitledBands` memo (1367);
- add near the other state hooks:
```tsx
const bandKey = `seazn.pad.band.${props.fixtureId}`;
const [band, setBand] = useState<FidelityBand>(() => {
  try { const v = window.localStorage.getItem(bandKey); if (v === "0" || v === "1" || v === "2" || v === "3") return Number(v) as FidelityBand; } catch {}
  return 3;
});
const onBandChange = useCallback((b: FidelityBand) => { setBand(b); try { window.localStorage.setItem(bandKey, String(b)); } catch {} }, [bandKey]);
```
- `filterTilesByBand(tiles, sheets, swaps, fidelity, band: FidelityBand)` — `const b = fidelity[type]; return b === undefined || b <= band;` (keep the More-tile exemption exactly as it is);
- every read of `props.band` / `view.band` / `padViewCtx.band` (1336, 1409) becomes the local `band`; remove `band` from the pad-host props and from whatever builds `padViewCtx`;
- chip call: `<RecordingChip activeBand={band} onBandChange={onBandChange} t={msg} />`.

`recording-chip.tsx`: rewrite to the owner's chosen layout. Contract: four controls with `data-band="0|1|2|3"`, `aria-pressed` on the active one, labels from `pad.recording.band.N`, group label `pad.recording.pick`; no `locked`, no `upsell`, no `featurePlan`/`planLabel` import. Min hit target 44×44 at 320px (hit-test with `elementFromPoint` in the e2e, not `boundingBox`).

Skins: delete `RALLY_ENTITLEMENT` (badminton 134, tabletennis 124, volleyball 284) and the `plan: planLabel(featurePlan(RALLY_ENTITLEMENT))` interpolations (846 / 679 / 804); the `context.recording.locked` strings they fed are deleted from all four dictionaries. Remove the volleyball 1333 comment.

Comments-only sites: update the prose so no file still says the pad "keeps reading `fidelityTiers`" or that a band "needs Pro".

Dictionaries: apply the key deletions/additions to en/es/fr/nl, then regenerate `lib/i18n-keys.ts`; `git diff --stat apps/web/src/lib/i18n-keys.ts` must show only the removed/added keys.

- [ ] **Step 5: Run the pad suites + tsc + lint**

```bash
cd $W/apps/web && npx vitest run src/components/v2/scorepad --reporter=json --outputFile=$S/w1-t4-green.json >/dev/null 2>&1; node -e "const r=require('$S/w1-t4-green.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests,'suitesFailed',r.numFailedTestSuites)"
cd $W/apps/web && npx tsc --noEmit 2>&1 | tail -3
cd $W && rtk proxy npm run lint --workspace apps/web 2>&1 | grep -E "✖|problems|error" | head -5
git -C $W grep -a -n -E "entitledBands|RALLY_ENTITLEMENT|recording\.locked|fidelityEntitlements" -- apps/web | wc -l
```
Expected: `failed 0`, `suitesFailed 0`; tsc clean; lint prints no `✖`; grep count `0`.

- [ ] **Step 6: E2E — the picker works on a real pad, at three widths, and a free org records a band-3 event through the browser**

Bring up the prod server per the environment skill (`E2E_PROD_TARGET`, port from the skill). Add `apps/web/e2e/scoring-free.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { seedCommunityOrgWithLiveFixture } from "./helpers"; // extend helpers.ts if the community+live-fixture seed lacks a sport parameter

for (const width of [320, 768, 1280]) {
  test(`free org, football, band 3 event recorded through the pad @ ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { padUrl } = await seedCommunityOrgWithLiveFixture(page, { sport: "football" });
    await page.goto(padUrl);
    // picker: four bands, default 3, hit-testable
    const b3 = page.locator('[data-band="3"]');
    await expect(b3).toHaveAttribute("aria-pressed", "true");
    const box = (await b3.boundingBox())!;
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-band]")?.getAttribute("data-band"), [box.x + box.width / 2, box.y + box.height / 2]);
    expect(hit).toBe("3");
    await expect(page.locator("text=/available on|🔒/")).toHaveCount(0);
    // record a band-3 event (football.card is banded 3 today — read it from the module if that changes)
    await page.getByRole("button", { name: /card/i }).first().click();
    // ...complete the card sheet the way scorepad-skins.spec.ts does for football...
    await expect.poll(async () => (await page.request.get(`/api/v1/fixtures/${fixtureId}/events`)).json().then((j) => j.events.some((e) => e.type === "football.card"))).toBe(true);
    // picking band 0 hides the card tile
    await page.locator('[data-band="0"]').click();
    await expect(page.getByRole("button", { name: /card/i })).toHaveCount(0);
    // no horizontal page scroll
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
```
Register it with the walkthrough/e2e projects the way `scorepad-v3-*` specs are (read `playwright.config.ts` — a new spec is covered at ZERO widths until a project lists it). Run: `cd $W/apps/web && npx playwright test e2e/scoring-free.spec.ts --reporter=line 2>&1 | tail -5`. Expected: 3 passed.

Then sweep the existing e2e hits by reading each (not by filename): `gallery.capture.ts` (7), `scorepad-skins.spec.ts` (3), `mobile.spec.ts` (3), `v6-sports.spec.ts` (2), `walkthrough/scorepad-v3-carrom-match.spec.ts` (2), `scoring.spec.ts` (1), `scorepad-v3-swap-off-step-enforcement.spec.ts` (1). A hit that asserts a lock/402/plan name flips to the free behaviour with a comment; a hit that uses "fidelity" as band vocabulary stays. Run every touched spec.

- [ ] **Step 7: Screenshots + walkthrough (owner gate)**

Capture the pad with the chip at 320 / 768 / 1280 into `$SCRATCH/w1-chip-{320,768,1280}.png`, confirm the three files exist and DIFFER (`cmp`), send them with SendUserFile, and run the walkthrough: a free org, a real football match, a band-3 card recorded and visible in the timeline, the picker set to "Result only" hiding the card tile. Write what you SAW (not what must be true) into `$SCRATCH/w1-t4-walkthrough.md`.

- [ ] **Step 8: Commit**

```bash
cd $W && git add apps/web && git commit -m "feat(scorepad): recording detail is the scorer's choice — chip becomes a four-band picker, no lock, no upsell (closes D-7)

pad-host owns the band (default 3, remembered per fixture); tiles filter by
the pick; RecordingChip drops entitledBands/fidelityEntitlements/featurePlan;
badminton/tabletennis/volleyball skins lose RALLY_ENTITLEMENT and the
'needs {plan}' copy in all four locales. e2e scoring-free.spec.ts proves a
free org records a band-3 event through the browser at 320/768/1280.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012XNVTB7kp4KG2zGBDm4RY1"
```

---

### Task 5: Pricing surfaces, copy, help, smoke — nothing advertises scoring detail as paid

**Files:**
- Modify: `apps/web/src/lib/entitlement-domains.ts:30`
- Modify: `apps/web/src/lib/feature-copy.ts:41-43`
- Modify: `apps/web/src/lib/pricing-cards.ts:67` ("Ball-by-ball & rally scoring, player stats" → "Player stats & scorecards")
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/marketing.json` — delete `pricing.matrix.scoring.ball_by_ball`, `.rally_by_rally`, `.match_timeline`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` — `billing.pro.f4` (read its consumer first: if it is a positional bullet list `f1..fN`, replace the text with the next real Pro bullet, e.g. "Hand-over scoring devices"; do not leave a gap)
- Modify: `apps/web/src/lib/__tests__/_approved-dictionary-copy.ts:523`, `lib/__tests__/pricing-cards.test.ts:582-583`, `lib/__tests__/dictionary-copy-truth.test.ts:1428`
- Modify: `apps/web/content/help/scoring/basics.md`, `scoring/cricket.md` (2 mentions), `scoring/device-links.md`, `scoring/batch-import.md`, `divisions/discipline.md`
- Modify: `scripts/smoke.ts:5486-5567`, `scripts/smoke-sports.ts` (4 hits), `scripts/seed-demo.ts` (1 hit)
- Regenerate: `apps/web/src/lib/i18n-keys.ts`

- [ ] **Step 1: Write the failing guard — no string may call scoring detail a paid feature**

Add to `apps/web/src/lib/copy-truth.ts` (next to `capClaimFaults`):

```ts
/** W1 (scoring free): scoring detail — ball-by-ball, rally-by-rally, match
 *  timeline, "recording detail" — is never a paid feature. Any dictionary or
 *  help string that pairs one of those phrases with a plan name or "upgrade"
 *  is a fault: free in the product and paid on the page is the worst state. */
const SCORING_DETAIL = /\b(ball[- ]by[- ]ball|rally[- ]by[- ]rally|match timelines?|recording detail)\b/i;
const PAID_WORDS = /\b(Pro|Pro Plus|Event Pass|upgrade|paid|plan)\b/;
export function scoringFreeClaimFaults(strings: ReadonlyArray<readonly [id: string, text: string]>): string[] {
  const faults: string[] = [];
  for (const [id, text] of strings) {
    if (SCORING_DETAIL.test(text) && PAID_WORDS.test(text)) faults.push(`${id}: presents scoring detail as paid: "${text.slice(0, 80)}"`);
  }
  return faults;
}
```

and a test in `lib/__tests__/dictionary-copy-truth.test.ts` (and the help suite `help-copy-truth.test.ts`) that feeds every dictionary value (all four locales) and every help article body through it and expects `[]`. Run: it must be RED on the current tree (at minimum `pad.recording.locked` — until Task 4's dictionary edit lands — and `feature-copy` strings, `billing.pro.f4`, the help articles).

- [ ] **Step 2: Apply the edits**

`entitlement-domains.ts:30` — delete the three keys from the `scoring` block (the pricing matrix rows vanish with them). `feature-copy.ts:41-43` — delete the three entries. `pricing-cards.ts:67` — reword. Marketing dictionaries ×4 — delete the three `pricing.matrix.scoring.*` keys. `billing.pro.f4` ×4 — per the consumer read. Help: rewrite each sentence so it describes the band as a recording choice ("record as much or as little detail as you like — every band is available on every plan") — English only. Approved-copy fixtures and the two lib tests follow the new strings. Regenerate `i18n-keys.ts`.

`scripts/smoke.ts:5513-5546` — the `gated` list becomes an `alwaysFree` list asserting `201` for the same three tuples, with the comment `// W1: these formerly 402'd with a feature_key; scoring detail is free on every plan.` Keep 5548-5567 (already 201). `smoke-sports.ts` and `seed-demo.ts` — read each hit; remove any Pro-plan seeding that existed only to unlock scoring detail; keep seeding that exercises other Pro features.

- [ ] **Step 3: Run the copy suites, the smoke script locally, and the sweep grep**

```bash
cd $W/apps/web && npx vitest run src/lib/__tests__/dictionary-copy-truth.test.ts src/lib/__tests__/help-copy-truth.test.ts src/lib/__tests__/pricing-cards.test.ts src/lib/__tests__/plan-copy-truth.test.ts --reporter=json --outputFile=$S/w1-t5.json >/dev/null 2>&1; node -e "const r=require('$S/w1-t5.json');console.log(r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests,'suitesFailed',r.numFailedTestSuites)"
git -C $W grep -a -n -E "scoring\.(ball_by_ball|rally_by_rally|match_timeline)" -- ':!docs' ':!db/migration' | wc -l
```
Expected: `failed 0`; grep count `0` (migrations and docs may still name the keys historically). Then run the smoke script the way the environment skill says (full local smoke against the prod server), paste its final pass/fail line into the commit body. If the local smoke skips its AI section, say so — that is environmental (memory: local smoke gates AI off).

- [ ] **Step 4: Commit**

```bash
cd $W && git add apps/web scripts && git commit -m "chore(copy): scoring detail is never advertised as paid — matrix rows, upsell reasons, pro bullet, help, smoke

Removes the three scoring keys from ENTITLEMENT_DOMAINS and feature-copy,
rewrites the Pro bullet and five help articles, flips smoke's gated 402
tuples to 201, and adds copy-truth scoringFreeClaimFaults so a future string
cannot pair scoring detail with a plan name again. Smoke: <line>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012XNVTB7kp4KG2zGBDm4RY1"
```

---

### Task 6: Device-link rights unchanged — prove the 403 still bites

R9 acceptance: the device link gains no rights it did not have.

**Files:**
- Modify: `apps/web/src/server/usecases/__tests__/scoring-free.test.ts` (append)

- [ ] **Step 1: Write the test**

```ts
it("a device link still cannot void an event it did not record (403), and still cannot finalize", async () => {
  const rig = await makeCommunityRig("football");
  const organiserEvent = await scoreEvent(rig.auth, rig.fixtureId, { expected_seq: rig.seq, type: "football.goal", payload: rig.minimalPayloadFor("football.goal") });
  const deviceAuth = await rig.mintDeviceLinkAuth(); // AuthCtx with via: "device_link" — the rig used by refused-write tests builds one
  await expect(scoreEvent(deviceAuth, rig.fixtureId, { expected_seq: rig.seq + 1, type: "core.void", payload: { event_id: organiserEvent.id } }))
    .rejects.toMatchObject({ status: 403 });
  await expect(scoreEvent(deviceAuth, rig.fixtureId, { expected_seq: rig.seq + 1, type: "core.finalize", payload: {} }))
    .rejects.toMatchObject({ status: 403 });
});
```

- [ ] **Step 2: Run — green on the first run is expected (the guard never moved); then mutate**

Comment out `scoring.ts:246-248` (`if (!target || target.device_link_id !== auth.deviceLinkId) throw new HttpError(403, ...)`), run the test, confirm RED, restore. Record "mutation: red" in the commit.

- [ ] **Step 3: Commit**

```bash
cd $W && git add apps/web/src/server/usecases/__tests__/scoring-free.test.ts && git commit -m "test(scoring): device link still cannot void others' events or finalize after the gate removal (mutation-proven)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012XNVTB7kp4KG2zGBDm4RY1"
```

---

### Task 7: Closeout — full gates, index, register, review

**Files:**
- Modify: `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/_INDEX.md` (R9 block 4200–4238 + D-7 register row)
- Create: `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/R9-review-findings.md`

- [ ] **Step 1: Full gates from THIS worktree, three suites, JSON**

```bash
cd $W/packages/engine && npx vitest run --reporter=json --outputFile=$S/w1-final-engine.json >/dev/null 2>&1; node -e "const r=require('$S/w1-final-engine.json');console.log('engine',r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests,'suitesFailed',r.numFailedTestSuites)"
cd $W/apps/web && npx vitest run --reporter=json --outputFile=$S/w1-final-web.json >/dev/null 2>&1; node -e "const r=require('$S/w1-final-web.json');console.log('web',r.numPassedTests,'/',r.numTotalTests,'failed',r.numFailedTests,'suitesFailed',r.numFailedTestSuites);console.log(r.testResults.filter(t=>!t.name.startsWith('$W')).length,'foreign paths')"
cd $W && npx tsc --noEmit -p apps/web 2>&1 | tail -2; npx tsc --noEmit -p packages/engine 2>&1 | tail -2
cd $W && rtk proxy npm run lint 2>&1 | grep -E "✖|problems" | head
cd $W && git grep -a -n -E "fidelityTiers|FidelityTier\b|requiredFeatureForEvent|fidelityEntitlements|entitledBands|RALLY_ENTITLEMENT|rallyEntitlement|timelineEntitlement" -- ':!docs' | wc -l
```
Expected: engine and web `failed 0`, `suitesFailed 0`, `0 foreign paths`; tsc clean twice; lint no `✖`; the identifier grep prints `0`. Compare totals with `$S/w1-baseline.txt` and explain every delta (deleted tests, added tests) in the closeout. A load-related collection failure (memory: machine load > 50 collapses suites) is rerun, not explained away. Also run the pre-commit OpenAPI drift check the repo mandates (RULES.md) — the events route documented no 402, so expect no drift, but run it.

- [ ] **Step 2: Reviewer pass, findings to disk**

Dispatch the `reviewer` agent on `git diff origin/main...HEAD` with the spec §6/§8 and this plan as the brief; it writes `R9-review-findings.md` (severity, file:line, customer impact per finding). Fix inline anything without blast radius; anything with blast radius goes to the owner as a recommendation. Never accept "no findings" without the file.

- [ ] **Step 3: Record the decisions in `_INDEX.md`**

Append under the R9 block:

```markdown
### R9 CLOSED — <date> (entitlements v18 W1, branch feat/entitlements-w1-scoring-free)
- `requiredFeatureForEvent` DIES (not null-returning); `fidelityTiers`, `FidelityTier`, `PadSpec.fidelityEntitlements`, `resolveFidelityEntitlements`, `resolveFidelityBand` deleted; `ScorePadBootstrap` carries no band.
- `PadSpec.fidelity` is the single model; the band is the scorer's choice in the chip (default 3, remembered per fixture). **D-7 closed.**
- Golden/conformance readers moved to `padSpec.fidelity` behind a parity proof (deleted with the arrays); coverage unchanged: <counts>.
- V390 drops the three keys from `plan_entitlements` and overrides.
- Instrumentation item DROPPED: no prod data, nothing to learn.
- Prompt premises found stale: ice-hockey `suspension.start` already 201 in smoke; `entitlements-v2.test.ts` football.card lines are 234/402/489, not 219-227/365/452.
- Pre-existing: `en/marketing.json` 447 keys vs 446 in es/fr/nl — not touched.
- Gates: engine <p>/<t>, web <p>/<t>, tsc clean, lint clean, e2e scoring-free 3/3 + touched specs <n>/<n>, smoke <line>.
```
Update the D-7 register row to "closed by R9 (W1)".

- [ ] **Step 4: Commit, then ask the owner before opening a PR**

```bash
cd $W && git add docs && git commit -m "docs(scoringpad): R9 closeout — scoring free, D-7 closed, stale premises recorded

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012XNVTB7kp4KG2zGBDm4RY1"
cd $W && git rebase origin/main   # never autoStash; resolve by hand if needed
```
Report to the owner: per-screen verdicts (chip at three widths, pad walkthrough), the gate counts, the review file path, and the branch. Open the PR only on their word; the PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and the session link, and states that e2e runs only after merge to `main` (smoke runs on the PR).

---

## Self-review against the spec

- Spec §6 "R9 — scoring free": gate removal (T3), `requiredFeatureForEvent` dies (T3), `fidelityTiers` retirement across engine + read sites (T1–T2), recording chip plain picker with frontend-design + widths + walkthrough (T4), three keys out of domains/copy/OpenAPI/matrix (T5; OpenAPI verified to carry none), four pinned tests moved with comments (T3, T5), instrumentation dropped and said so (T7). ✔
- Spec §8 "R9 acceptance": every event type/sport/band through the real HTTP door (T3 unit through `scoreEvent` + T4 e2e through the browser + T5 smoke through HTTP) and the importer (T3); device-link 403 still bites (T6); `git grep -a fidelityTiers` empty (T2, T7); mutation proofs (T3, T4 red-first, T6); walkthrough (T4). ✔
- Spec §9 W1: own PR, runs first, migration deletes the three keys (T3 V390). ✔
- Out of scope respected: `cricket.dls`, `stats.player`, `scoring.device_links`, `scoring.audit_export`, swap-off-step key untouched; no adjacent entitlement tidied.
- Type consistency: `tierEventTypes(module, cfg)` (T1) is what T2's callers use; `ScorePadBootstrap` without `band` (T3) is what T4's pad consumes; `RecordingChipProps { activeBand, onBandChange, t }` (T4) is what the e2e's `data-band`/`aria-pressed` contract hits; `filterTilesByBand(..., band)` (T4) matches its test.
