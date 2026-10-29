# Engine split: pad wave (O-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every sport rule fact the ScoringPad v3 skins use is declared once, in the engine, and read by the skins through `@seazn/engine/pad`. The fold does not move.

**Architecture:** A new phone-safe subpath `./pad` (`packages/engine/src/pad/`) is a facade. It re-exports or derives from declarations that live in each sport's module, and the fold reads the same declarations. The skins delete their literal copies and import from `./pad`. Facts the engine never declared get declared in the sport module first. Two guards stop a copy coming back: a per-sport drift test that drives the skin's offered set, and a literal-name scan.

**Tech Stack:** TypeScript 7 (`typescript-native`), zod v4, vitest (engine and `apps/web`, `environment: "node"`), Playwright e2e by CI dispatch.

**Spec:** `docs/superpowers/specs/engine-split/2026-10-29-pad-wave-and-2b-design.md` §1–§5. Parent spec: `docs/superpowers/specs/2026-10-13-engine-split-design.md`.

## Global Constraints

- **No fold moves.** Every `packages/engine/src/sports/**/*.golden.json` and `packages/engine/src/sport/fold-epoch.ts` stays byte-identical. The only exception is an owner ruling on Q1/Q1b (P2 Task 1). If a declaration would change a golden, STOP and raise it as an owner question; never bump `FOLD_EPOCH` or `FOLD_MINOR` unasked (spec §3.3, Q2).
- **The facade is not a second source.** No rule value is typed twice in the engine. A `./pad` field is either the same object the fold reads (`toBe`), or a pure derivation of it (spec §3.1).
- **`./pad` is phone-safe:** no `node:*`, no React, no display strings. It is listed in `packages/engine/phone-subpaths.json` `subpaths`, and `closure.modules` is re-pinned in the same commit that changes it. `npm run engine:boundary` must pass.
- **Out of scope:** presentation (labels, tones, colours, icons, order, dock button presets), web i18n, and `generic.tsx` `DOCK_AMOUNTS`. Per this plan's premise correction PC-1, that also covers cricket's dock presets.
- **Tests:** expected values are derived from the engine declaration, never from a typed table and never from the skin constant under test (AGENTS.md class 19; TEST-STRATEGY). Every sweep reports how many facts it compared, and zero compared fails. Every guard is mutated once.
- **Scoped runs only.** Never the full vitest suite, never the seazn-env gate. Judge results only from `--reporter=json --outputFile`, require `EXIT=0`, and confirm `.testResults[].name` resolves inside your worktree.
- **E2E by CI dispatch only:** `gh workflow run e2e.yml --ref <branch>`, which runs whole spec files. Never run a `-g` slice locally.
- **PR body line:** `Matrix rows: none — fold unchanged (golden ledgers and fold-epoch.ts byte-identical)`.
- **Topology (D30):** each task gets an `implementer-sonnet` and a `reviewer-sonnet`; each batch gets one Opus `reviewer`. Never override `model:`.
- **Worktrees, never `git stash`.** Prefix every Bash call with `cd <abs worktree> &&`. One branch per batch: `feat/pad-wave-p0` … `feat/pad-wave-p4`, each off `origin/main` after the previous batch it depends on has merged.
- **Line counts.** Engine edits shift Stryker row keys. That is accepted: the 2b baseline Stryker run is taken after P4 (spec §6.1). No per-batch re-measure; record the moved files in each PR body for the mutation session.

## Premise checks (re-pinned at `origin/main` 17948f93a8)

- **FP-1. The engine already has a pad description.** `SportModule.padSpec?(cfg): PadSpec` (`packages/engine/src/sport/module.ts:858`, types at `:210-:500`) and `SportModule.fidelity` (`:495`) are pure data, already on the phone subpaths `./sport` and `./sports/*`. `PadFieldEnum.values` and `PadFieldNumber.min`/`max` already carry many of the (b) facts, and several skins mirror them by hand (`period-shared.ts:1166-1176` says so). Consequence: `./pad` derives from `padSpec(cfg)` and `fidelity` wherever they hold the fact, and adds static declarations only where they don't. **Flag for the owner (not blocking):** a native pad could render from `padSpec` alone. `./pad` still earns its place as the one import for the static rule sets that `padSpec` does not carry (sanction levels, credit sets, phase tokens).
- **FP-2. Q1 is answered by the house rulebook in the engine's favour.** `packages/engine/src/sports/cricket/DOMAIN.md:99` says obstructing the field "credits the fielder a run out". The engine matches it (`cricket.ts:1253-1258`, `obstructed: "runOuts"`). The skin's `FIELDER_ELIGIBLE_KINDS` (`cricket.tsx:132`) is the copy that drifted. P2 Task 1 still asks the owner, because the rulebook row may itself differ from the Laws.
- **FP-3. Most engine "declarations" are not exported.** Examples: `PLAY_PHASES` (`football.ts:691`), `BOWLER_CREDITED_KINDS` (`cricket.ts:1232`), `ADJUST_REASONS` (`carrom.ts:683`), `BOARD_MAX` (`boardgame.ts:614`), `MAX_PLAUSIBLE_SCORE`/`MAX_TALLY_STEP` (`generic.ts:335-336`). Several are zod enums nested inside a strict object (`CricketWicket.shape.kind`, `cricket.ts:167`; `CricketExtras.shape.kind`, `:162`). Each task exports the existing object, or names the nested enum, without moving its value.
- **FP-4. A stale reference.** `cricket.tsx:138-149` cites `cricket.ts:1275-1276` for the free-hit rule; the rule is now at `:1239-1248`. It is fixed in passing by P2 (the comment goes away with the literal).
- **PC-1 (premise correction to the scout).** Cricket's `RUN_VALUES` (`cricket.tsx:1321`), `BAT_RUN_VALUES` and `EXTRA_RUN_VALUES` (`:1660-1661`) are dock button presets, not rules (5 runs are legal and reachable by "more"). They are out of scope, the same as `DOCK_AMOUNTS`. That leaves cricket's (c) at 3: the penalty of 5, a wide's default of 1, and `VARIABLE_OUT_KINDS`.
- **PC-2.** The boardgame skin's `SCORES = ["none", "2–0", "1½–½"]` (`boardgame.tsx:523`) and the engine's `TIEBREAK_SCORES = [null, "1½–½", "2–0"]` (`boardgame.ts:876`) differ in order and in `none`/`null`. The skin's order is presentation; the value set is the rule. The drift test compares sets, with `none ↔ null`.

## Review Focus

1. **A tautological drift test.** It compares the skin's re-exported constant with `./pad`, which is always green. The test must drive the skin's BUILDER (sheet, step `options`, field `max`), never the constant. Owned by every batch's drift-guard step.
2. **A cfg-dependent fact read once at module load.** For example, a bound computed from the default cfg and then shown for a `youth` cfg. Each cfg-dependent field is a function of cfg, and its drift test runs at least two declared cfgs (`declaredCfgs` in `packages/engine/src/testkit/declared-cfgs.ts`).
3. **A set that changed when its order was meant to stay.** Swapping a literal for an engine enum can reorder chips, which is a visible change. Each swap keeps the skin's display order; the drift test asserts set equality, and the skin's existing order test (where one exists) stays green.
4. **Phone closure growth.** `./pad` pulling a server-only module (`competition/`, `scheduling/`) into a phone bundle. Owned by P0 Task 1 (closure re-pin) and checked in every batch by `engine:boundary`.
5. **A newly declared (c) fact that the fold already enforces differently.** For example, the table-tennis expedite floor 9 versus the kernel's own rule. Each (c) step first finds every kernel site that encodes the fact. If one exists, the declaration is what that site reads; if the kernel disagrees with the skin, STOP and raise it as a Q2.

---

## Batch P0 — the `./pad` subpath, its helpers and the literal guard

Branch `feat/pad-wave-p0`. P1–P4 depend on it.

### Task P0.1: `./pad` subpath skeleton and the per-sport types

**Files:**
- Create: `packages/engine/src/pad/index.ts`, `packages/engine/src/pad/types.ts`, `packages/engine/src/pad/spec-lookup.ts`
- Modify: `packages/engine/package.json` (`exports` at `:13-:35` and `publishConfig.exports` at `:~129`: add `"./pad"` in both, matching the style of `"./sport"`), `packages/engine/phone-subpaths.json` (`subpaths` gains `"./pad"`; re-pin `closure.modules` and `closure.measured`)
- Test: `packages/engine/src/pad/pad.test.ts`

**Interfaces — Produces** (`types.ts`; later tasks fill the records and nothing else may rename them):

```ts
import type { FidelityBand, PadField, PadSpec } from "../sport/module.ts";

/** Shared by every sport record. */
export interface PadRulesBase {
  /** The module's own `fidelity` map: `toBe(module.fidelity)`. */
  readonly eventBands: Readonly<Record<string, FidelityBand>>;
}
export interface PeriodPadRules extends PadRulesBase {        // hockey, icehockey (P1)
  readonly suspensionReasons: readonly string[];
  readonly suspensionClassKeys: readonly string[];          // the static catalogue that keys tone maps
  suspensionClasses(cfg: unknown): readonly string[];        // review I1: what this cfg offers (icehockey recreational ≠ iihf)
  readonly goalKindRequired: boolean;
  readonly assistsMax: number;
  readonly swapBand: FidelityBand;                            // (c)
  suspensionMinutes(cfg: unknown): { readonly min: number; readonly max: number; readonly fallback: number }; // (c) fallback
  goalKinds(cfg: unknown): readonly string[];
  eventAllowedInPhase(eventType: string, phase: string, cfg: unknown): boolean;   // review I2: the fold's phase guards read cfg
}
export interface FootballPadRules extends PadRulesBase {      // P1
  readonly cardColors: readonly string[];
  readonly cardReasons: readonly string[];
  readonly penaltyOutcomes: readonly string[];
  readonly penaltyOffences: readonly string[];
  readonly playPhases: readonly string[];
  readonly teamSizeDefault: number;
  subWindowsCap(cfg: unknown): number | undefined;
  eventAllowedInPhase(eventType: string, phase: string, cfg: unknown): boolean;   // review I2: the fold's phase guards read cfg
}
export interface CricketPadRules extends PadRulesBase {       // P2
  readonly wicketKinds: readonly string[];
  readonly extraKinds: readonly string[];
  readonly fielderCreditedKinds: readonly string[];           // keys of FIELDER_CREDIT_COLUMN
  readonly freeHitDismissalKinds: readonly string[];
  readonly bowlerCreditedKinds: readonly string[];
  readonly variableOutKinds: readonly string[];               // (c) — Q1b
  readonly boundaryValues: readonly number[];
  readonly tossElections: readonly string[];
  readonly inningsCloseReasons: readonly string[];
  readonly retireReasons: readonly string[];
  readonly reviewKinds: readonly string[];
  readonly reviewOutcomes: readonly string[];
  readonly penaltyRuns: number;                               // (c) Law 41: 5
  readonly wideDefaultRuns: number;                           // (c) Law 22: 1
  ballsPerOver(cfg: unknown): number;
}
export interface SetBasedPadRules extends PadRulesBase {      // badminton, tabletennis, volleyball (P3)
  readonly sanctionLevels: readonly string[];
  bestOf(cfg: unknown): number;
  setTo(cfg: unknown): number;
  scoreBound(cfg: unknown): number;
  /** (c) "golden point" / "setting" / null for the open game. */
  deuceNote(state: unknown, cfg: unknown): "goldenPoint" | "setting" | null;
}
export interface BadmintonPadRules extends SetBasedPadRules {
  intervalMark(cfg: unknown, setIndex: number): number;       // (c) ceil(target/2)
}
export interface TableTennisPadRules extends SetBasedPadRules {
  readonly expediteReturns: number;                           // toBe-equal to kernel EXPEDITE_RETURNS
  readonly expediteScoreFloor: number;                        // (c) 9
}
export interface VolleyballPadRules extends SetBasedPadRules {
  readonly liberoBand: FidelityBand;                          // (c)
  rotationCycle(cfg: unknown): number;
}
export interface TennisPadRules extends PadRulesBase {        // P3
  readonly pointKinds: readonly string[];
  readonly interruptionKinds: readonly string[];
  readonly sanctionLevels: readonly string[];
  readonly interruptionMaxSeconds: number;                    // (c) 3600
  readonly pointCalls: readonly string[];                     // (c) ["0","15","30","40"]
  endsChanged(state: unknown): boolean;                       // (c)
  gamesFieldBound(cfg: unknown): number;
  tiebreakFieldBound(cfg: unknown): number;
}
export interface CarromPadRules extends PadRulesBase {        // P4
  readonly adjustReasons: readonly string[];
  readonly opponentCoinsMax: number;
  bestOf(cfg: unknown): number;
  gameTo(cfg: unknown): number;
}
export interface BoardgamePadRules extends PadRulesBase {     // P4
  readonly boardMax: number;
  readonly tiebreakScores: readonly (string | null)[];
}
export interface GenericPadRules extends PadRulesBase {       // P4
  readonly maxPlausibleScore: number;
  readonly maxTallyStep: number;
}
export interface PadRulesBySport {
  hockey: PeriodPadRules; icehockey: PeriodPadRules; football: FootballPadRules; cricket: CricketPadRules;
  badminton: BadmintonPadRules; tabletennis: TableTennisPadRules; volleyball: VolleyballPadRules;
  tennis: TennisPadRules; carrom: CarromPadRules; boardgame: BoardgamePadRules; generic: GenericPadRules;
}
```

`index.ts` exports `type *` from `types.ts`, plus `padFieldOf`, `padEnumValues` and `padNumberBound` from `spec-lookup.ts`. **Review round (I3, m1), as built:** `export interface PadFieldScope { action?: string }`, matched against the action's `labelKey.key`. An unknown action throws and lists the event type's actions; an ambiguous key throws and lists the candidate action keys. Enum and number lookups judge agreement only on what they return. The three real ambiguous keys (boardgame `result` `method`, carrom `game.adjust` `delta`, generic `score` `points`) are read with `scope`. Each later batch adds one `export const <sport>PadRules: <Type>` to `index.ts`. P4 adds `POST_PHASES`. `spec-lookup.ts` signatures:

```ts
export function padFieldOf(spec: PadSpec, eventType: string, path: string, scope?: PadFieldScope): PadField | undefined;
/** Throws (an Error naming eventType and path) when absent or not an enum: a missing field is a build bug, never []. */
export function padEnumValues(spec: PadSpec, eventType: string, path: string, scope?: PadFieldScope): readonly string[];
/** Throws likewise when absent or not a number field. */
export function padNumberBound(spec: PadSpec, eventType: string, path: string, scope?: PadFieldScope): { min: number; max: number };
```

- [ ] **Step 1: Write the failing test.** `pad.test.ts`:
  - `padEnumValues returns the declared values`: a hand-built `PadSpec` with one action `{type: "x.ev", fields: [{kind: "enum", path: "a.b", values: ["p","q"]}]}` gives `["p","q"]`.
  - `padEnumValues throws on a missing path` (`toThrow(/x.ev.*a.c/)`) and `throws on a number field`.
  - `padNumberBound` gets the same three cases.
  - `padFieldOf on a real module`: for every registered sport whose module has `padSpec`, over `declaredCfgs`, every action's every field round-trips through `padFieldOf`. Assert the count of fields checked is greater than 0 and log it.
- [ ] **Step 2:** Run `cd <wt>/packages/engine && npx vitest run src/pad --reporter=json --outputFile=<scratch>/p0.json; echo EXIT=$?`. Expected: collection fails (module missing).
- [ ] **Step 3:** Implement `spec-lookup.ts` and the types, then add `./pad` to both `exports` maps and to `phone-subpaths.json`.
- [ ] **Step 4:** Re-run Step 2: green, and `.testResults[].name` ends in `src/pad/pad.test.ts`. Then `cd <wt> && npm run engine:boundary; echo EXIT=$?`. It fails, printing the closure diff; copy the printed module list into `closure.modules`, set `measured` to today's date, and re-run until EXIT=0. The diff must add only `src/pad/*.ts`; anything else is a Review Focus 4 finding.
- [ ] **Step 5:** Also run `cd <wt>/packages/engine && npm run typecheck && npx vitest run test/boundary-gate.test.ts test/publish-manifest.test.ts --reporter=json --outputFile=<scratch>/p0b.json; echo EXIT=$?`.
- [ ] **Mutation:** make `padEnumValues` return `[]` when absent. The throw test must go red. Restore.
- [ ] **Commit:** `feat(engine): ./pad subpath, spec lookups and per-sport pad rule types`

### Task P0.2: the literal guard

**Files:**
- Create: `apps/web/src/components/v2/scorepad/v3/skins/__tests__/no-rule-literals.test.ts`

**Interfaces — Produces:** `const BANNED: Readonly<Record<string, readonly string[]>>`, a map from skin file basename to the constant names that may no longer be DECLARED in it. Each later task appends its own entries. Also produces `findDeclarations(source: string, names: readonly string[]): string[]`, which matches `^\s*(export\s+)?const\s+NAME\b` per line and returns the names it found.

- [ ] **Step 1: Write the tests.**
  - `findDeclarations finds a const and an export const` (positive) and `ignores an import and a property access of the same name` (the negative pair).
  - `skins declare no banned rule literal`: it reads every file in `skins/` that matches `*.ts` or `*.tsx` (not `__tests__`), asserts the file count is 13 (re-pinned: 13 files at 17948f93a8), and for each `BANNED` entry asserts `findDeclarations` returns `[]`. It reports `scanned files` and `names checked`. In P0, `names checked` is 0 and allowed only while `BANNED` is empty: assert `Object.keys(BANNED).length === 0 || namesChecked > 0`.
- [ ] **Step 2:** Run `cd <wt>/apps/web && npx vitest run src/components/v2/scorepad/v3/skins/__tests__/no-rule-literals.test.ts --reporter=json --outputFile=<scratch>/p0c.json; echo EXIT=$?`. Expected: green. Confirm the test file's name appears under `.testResults[].name`.
- [ ] **Mutation:** temporarily add `"cricket.tsx": ["WICKET_KINDS"]`. The test must go red (WICKET_KINDS is still declared at `cricket.tsx:125`). Remove it.
- [ ] **Commit:** `test(scorepad): literal guard for rule constants in the v3 skins`

**P0 PR:** e2e is not needed (no skin behaviour changes). The Opus batch review checks the closure diff and the `exports` maps.

---

**Every batch, before its PR (P0 batch review I2):** main's engine CI job is red on `stryker-sizing` (stale legs, owned by the mutation session), and that red skips its Sim matrix step. So each batch runs `SIM_SEEDS=5 npm run sim:matrix --workspace packages/engine` locally (EXIT=0) and reads the CI job log for the step, rather than trusting the job colour. Each batch also adds its export under its own anchor comment in `src/pad/index.ts`, and its deleted names must match the P0 inventory in `no-rule-literals.test.ts`.

## Batch P1 — period sports: hockey, icehockey, football

Branch `feat/pad-wave-p1`, off main after P0. Its files are disjoint from P2 and P3 except `src/pad/index.ts` (each batch appends one export) and the `phone-subpaths.json` closure re-pin: expect a small rebase, not a conflict of substance (P0.1 review m5).

Re-pinned items (skin → engine). (b) = duplicate, delete it and import. (c) = declare it first. "trace" = the scout did not follow it end to end; the implementer reads the guard and records what they find before swapping.

| Fact | Skin | Engine source | Kind |
|---|---|---|---|
| event bands | `period-shared.ts:457-469` (`bandsOf`) | `period/kernel.ts:2378` `fidelity` | b |
| event types | `period-shared.ts:437-449` | module `eventSchemas` keys | b |
| phase allows | `period-shared.ts:499-520` | `period/kernel.ts:1131-1448` `wrongPhase` sites | b, trace |
| suspension minutes min 1 / max | `period-shared.ts:1163-1177,1229` | `period/kernel.ts:2112` (padSpec field bound) | b |
| fallback minutes 1 | `period-shared.ts:1163` | none | c |
| assists ≤ 2 | `period-shared.ts:1576` | `period/kernel.ts:288` `.max(2)` | b |
| goal kinds `fg`/`og` | `period-shared.ts:1603,1620,1752` | `period/kernel.ts:2118` | b |
| swap band 2 | `period-shared.ts:478` `SWAP_BAND` | none | c |
| hockey reasons | `hockey.tsx:54-62` | `hockey/hockey.ts:22` `HOCKEY_SUSPENSION_REASONS` | b |
| hockey class keys | `hockey.tsx:66-70` (keys only; tones are presentation) | `period/suspensions.ts:73` `HOCKEY_SUSPENSIONS` | b |
| goal kind required | `hockey.tsx:78` | `hockey/hockey.ts:269` | b |
| icehockey reasons | `icehockey.tsx:51-71` | `icehockey/icehockey.ts:18` | b |
| icehockey class keys | `icehockey.tsx:75-83` | `period/suspensions.ts:56` | b |
| card colours | `football.tsx:95` | `football.ts:245` `CardColor` | b |
| card reasons | `football.tsx:138-152` | `football.ts:250` `CardReason` | b |
| penalty outcomes | `football.tsx:157` | `football.ts:329` `PenaltyOutcome` | b |
| penalty offences | `football.tsx:164-173` | `football.ts:338` `PenaltyOffence` | b |
| event bands | `football.tsx:187-198` | `football.ts:2575` `fidelity` | b |
| play phases | `football.tsx:204` | `football.ts:691` (not exported) | b |
| period markers | `football.tsx:378-421` | `football.ts:2346,1539-1627` | b, trace |
| phase allows | `football.tsx:431-459` | `football.ts:1134-1339` | b, trace |
| second-yellow eligibility | `football.tsx:947-959` | `football.ts:1181` | b |
| sub cap / windows | `football.tsx:1242-1264` | `football.ts:1264` | b |
| re-entry block | `football.tsx:1295-1301` | engine comment only | b, trace |
| team size default 11 | `football.tsx:582` | `football.ts:182` `.max(11)` | b |

### Task P1.1: period kernel declarations and `hockeyPadRules` / `icehockeyPadRules`

**Files:** Modify `packages/engine/src/sports/period/kernel.ts` (export the existing objects; declare `SWAP_BAND` and the fallback minutes beside the suspension bound at `:2112`; declare an `EVENT_PHASES: Readonly<Record<string, readonly string[]>>` table, and make the `wrongPhase` guards at `:1131-1448` read it), `packages/engine/src/pad/index.ts`, `period-shared.ts`, `hockey.tsx`, `icehockey.tsx`. Test: `packages/engine/src/pad/period.test.ts`, `apps/web/src/components/v2/scorepad/v3/skins/__tests__/pad-rules-period.test.ts`.

**Interfaces — Consumes:** P0.1 `PeriodPadRules`, `padNumberBound`, `padEnumValues`. **Produces:** `hockeyPadRules`, `icehockeyPadRules: PeriodPadRules`.

- [ ] **Step 1: Engine test** `period.test.ts`:
  - `eventBands is the module's fidelity`: `expect(hockeyPadRules.eventBands).toBe(hockey.fidelity)`, and the same for icehockey.
  - `suspensionMinutes matches the padSpec bound`: over every `declaredCfgs` entry for both sports, `suspensionMinutes(cfg).max === padNumberBound(module.padSpec(cfg), <suspension type>, "minutes").max`. Count the cfgs checked, and require at least 2 per sport.
  - `eventAllowedInPhase agrees with the fold`: for every event type in `eventSchemas` × every phase token the kernel declares, apply a minimal valid event from the testkit's after-start builder (`testkit/after-start-events.ts`) in that phase. The fold refuses with `wrongPhase` exactly when `eventAllowedInPhase` is false. Count the pairs, which must be greater than 0.
- [ ] **Step 2: Web drift test** `pad-rules-period.test.ts`, in the style of the existing `__tests__/period-pair.test.ts`:
  - It builds the real sheets for the suspension reason step, the class step and the goal-kind step from a `PadHostView` folded from real events. It asserts their `options` value sets equal `hockeyPadRules.suspensionReasons` / `.suspensionClassKeys` / `.goalKinds(cfg)`, and the minutes field `max` equals `.suspensionMinutes(cfg).max`.
  - It asserts that a tile hidden by band matches `eventBands`.
  - It reports the facts compared, which must be at least 10.
- [ ] **Step 3:** Run both and expect red (the exports are missing).
- [ ] **Step 4:** Implement the engine side. Then trace the "phase allows" rows: read `period/kernel.ts:1131-1448` and record in the PR body which guards the table now drives. Then swap the skin literals for imports from `@seazn/engine/pad`.
- [ ] **Step 5:** Append to `BANNED`: `"period-shared.ts": ["SWAP_BAND"]`, `"hockey.tsx": ["HOCKEY_REASONS"]`, `"icehockey.tsx": ["ICEHOCKEY_REASONS"]`. If `HOCKEY_CLASSES` / `ICEHOCKEY_CLASSES` stay as tone maps, they are not banned. Instead add a test asserting that their keys equal `suspensionClassKeys`.
- [ ] **Step 6: Verify.**
  - Engine: `npx vitest run src/pad src/sports/period src/sports/hockey src/sports/icehockey --reporter=json …`.
  - Web: `npx vitest run src/components/v2/scorepad/v3/skins/__tests__/pad-rules-period.test.ts src/components/v2/scorepad/v3/__tests__/period-pair.test.ts src/components/v2/scorepad/v3/skins/__tests__/no-rule-literals.test.ts --reporter=json …`.
  - `cd <wt> && git diff --exit-code origin/main -- 'packages/engine/src/sports/**/*.golden.json' packages/engine/src/sport/fold-epoch.ts`, which must exit 0.
  - `npm run engine:boundary`.
- [ ] **Mutation:** in `EVENT_PHASES`, drop one phase from one event. The engine test must go red.
- [ ] **Commit:** `feat(engine,scorepad): period pad rules declared once; hockey skins read them`

### Task P1.2: football declarations and `footballPadRules`

**Files:** Modify `packages/engine/src/sports/football/football.ts` (export `PLAY_PHASES`; declare `EVENT_PHASES` read by the guards at `:1134-1339`; expose `subWindowsCap` from the existing check at `:1264`), `pad/index.ts`, `football.tsx`. Test: `packages/engine/src/pad/football.test.ts`, `skins/__tests__/pad-rules-football.test.ts`.

**Interfaces — Consumes:** P0.1 `FootballPadRules`. **Produces:** `footballPadRules`.

- [ ] **Step 1: Engine test.**
  - `cardColors equals CardColor.options` (and the same for `cardReasons`/`CardReason`, `penaltyOutcomes`/`PenaltyOutcome`, `penaltyOffences`/`PenaltyOffence`).
  - `playPhases is the fold's PLAY_PHASES` (`toBe`).
  - `eventAllowedInPhase agrees with the fold` (same shape as in P1.1).
  - `teamSizeDefault equals the schema's teamSize max`: read it from the zod schema's `.maxValue`, not a typed 11.
- [ ] **Step 2: Web drift test.**
  - It drives the card sheet (colour and reason options), the penalty sheet (outcome and offence options) and the sub sheet at the window cap, plus one `cfg` with `subWindows` set and one without.
  - For second-yellow eligibility, it folds a yellow for a person and then asserts that the card sheet's `second_yellow` offer appears exactly when the engine accepts it. It applies the event through the real module.
  - It reports facts compared, which must be at least 12.
- [ ] **Steps 3–4:** Red, then implement. Trace "period markers" and "re-entry block" before swapping; if re-entry has no engine guard, it is a (c) and gets declared beside the sub-window check.
- [ ] **Step 5:** `BANNED["football.tsx"] = ["CARD_COLORS", "CARD_REASONS", "PENALTY_OUTCOMES", "PENALTY_OFFENCES", "EVENT_BAND", "PLAY_PHASES"]`. `CARD_TONES` stays (presentation).
- [ ] **Step 6: Verify** as in P1.1, with engine `src/sports/football` and web `skins/__tests__/football.test.ts` plus the new drift test.
- [ ] **Mutation:** remove one value from `CardReason` in a scratch copy. Both the engine test and the web drift test must go red. Restore.
- [ ] **Commit:** `feat(engine,scorepad): football pad rules declared once; skin reads them`

**P1 e2e (CI dispatch on `feat/pad-wave-p1`):** `mobile.spec.ts`, `scorepad-skins.spec.ts`, `scorepad-v3-football.spec.ts`, `scorepad-v3-hockey-goal-type.spec.ts`, `scorepad-v3-retirement.spec.ts`, `scorepad-v3-swap-off-step-enforcement.spec.ts`, `scorepad-v3-swap-candidate-badges.spec.ts`, `walkthrough/scorepad-v3-period-pair.spec.ts`, `walkthrough/tables-w2d.spec.ts`. The dispatch runs the whole suite; read these files' results.

---

## Batch P2 — cricket

Branch `feat/pad-wave-p2`, off main after P0.

| Fact | Skin | Engine source | Kind |
|---|---|---|---|
| wicket kinds | `cricket.tsx:125-128` | `cricket.ts:167` `CricketWicket.shape.kind` | b |
| extra kinds | `cricket.tsx:129` | `cricket.ts:162` `CricketExtras.shape.kind` | b |
| fielder eligible | `cricket.tsx:132` | `cricket.ts:1253-1258` `FIELDER_CREDIT_COLUMN` keys (adds `obstructed`) | b, **Q1** |
| variable-out kinds | `cricket.tsx:136` | none | c, **Q1b** |
| free-hit kinds | `cricket.tsx:150` | `cricket.ts:1239,1248` | b |
| bowler credited | `cricket.tsx:151` | `cricket.ts:1232` | b |
| balls per over default 6 | `cricket.tsx:291` | `cricket.ts:66` | b |
| boundary 4/6 | `cricket.tsx:787,1669` | `cricket.ts:204` | b |
| free-hit fold | `cricket.tsx:927-944` | `cricket.ts:1687` | b, trace |
| target + 1 | `cricket.tsx:1156,1168` | `cricket.ts:1938` | b |
| variant code | `cricket.tsx:1186-1192` | `cricket.ts:3720-3730` | b |
| super-over refusals | `cricket.tsx:1604-1614` | `cricket.ts:3908-3930` | b |
| previous over | `cricket.tsx:758,1840` | engine comment only | b, trace |
| penalty 5 | `cricket.tsx:1463` | none (Law 41) | c |
| wide default 1 | `cricket.tsx:791` | none (Law 22) | c |
| toss | `cricket.tsx:2316` | `cricket.ts:258` | b |
| retire | `cricket.tsx:2379` | `cricket.ts:293` | b |
| review kind/outcome | `cricket.tsx:2450-2463` | `cricket.ts:312,315` | b |
| close reasons | `cricket.tsx:2148` (values; labels stay) | `cricket.ts:267` | b |
| dock presets | `cricket.tsx:1321,1660-1661` | — | out of scope (PC-1) |

### Task P2.1: the rulebook check (Q1, Q1b). No build step.

**Files:** none changed. The output is a written note in the P2 PR draft plus an owner question in chat.

- [ ] **Step 1:** Read `packages/engine/src/sports/cricket/DOMAIN.md:99` (obstructing, "credits the fielder a run out") against MCC Law 37 and the scorebook convention the rulebook cites. Record whether the house rulebook deliberately departs from the Laws.
- [ ] **Step 2:** Read `cricket.ts`'s `out`-person rule for each wicket kind. Under Law 37 either batter can be out obstructing, so `VARIABLE_OUT_KINDS = ["runout"]` may be missing `obstructed` (Q1b). Record which batter the fold accepts for an `obstructed` wicket.
- [ ] **Step 3:** Hand the controller two questions, each with a recommendation:
  - **Q1.** Recommendation: keep the rulebook (fielder credited). The skin gains `obstructed` in the fielder step and no fold moves.
  - **Q1b.** Recommendation: if the fold accepts either batter, the skin asks "who's out" for `obstructed` too, and again no fold moves.
- [ ] **Stop here.** P2.2 starts only after the owner answers. If either answer moves the fold, P2.2 gains a golden re-record plus a cricket `FOLD_EPOCH` bump under that ruling, and its PR body changes to "Matrix rows: cricket × all formats — fielder credit".

### Task P2.2: cricket declarations and `cricketPadRules`

**Files:** Modify `cricket.ts` (name the nested enums, `export const WicketKind = CricketWicket.shape.kind` and the same for `ExtraKind`; export the sets at `:1232,1239-1258`; declare `PENALTY_RUNS = 5` and `WIDE_DEFAULT_RUNS = 1` where the fold computes extras, and make those sites read them; declare `VARIABLE_OUT_KINDS` per Q1b), `pad/index.ts`, `cricket.tsx`. Test: `packages/engine/src/pad/cricket.test.ts`, `skins/__tests__/pad-rules-cricket.test.ts`.

**Interfaces — Consumes:** P0.1 `CricketPadRules`. **Produces:** `cricketPadRules`.

- [ ] **Step 1: Engine test.**
  - `wicketKinds equals the schema enum` and `extraKinds equals the schema enum`.
  - `fielderCreditedKinds is FIELDER_CREDIT_COLUMN's keys`.
  - `freeHitDismissalKinds is the fold's set`: drive a no ball then a wicket of each `wicketKinds` value through the real module; the fold accepts exactly this set. Count the kinds, which must be 10.
  - `penaltyRuns`: a `penalty` extra folds to `penaltyRuns` on the batting side.
  - `variableOutKinds`: for each kind, the fold accepts a non-striker `out` exactly when it is listed.
- [ ] **Step 2: Web drift test.** It drives `wicketSheet(view)`:
  - the kind options equal `wicketKinds`, and in a free-hit-pending view they equal `freeHitDismissalKinds`;
  - the fielder step is offered exactly for `fielderCreditedKinds`, and the who's-out step exactly for `variableOutKinds`;
  - it also drives the extras sheet (kind options), the toss, retire, review and close sheets (option sets), and the boundary flags.
  - It reports facts compared, which must be at least 16.
- [ ] **Steps 3–4:** Red, then implement. Trace "free-hit fold" and "previous over". Remove the stale `cricket.ts:1275-1276` comment (FP-4).
- [ ] **Step 5:** `BANNED["cricket.tsx"] = ["WICKET_KINDS", "EXTRA_KINDS", "FIELDER_ELIGIBLE_KINDS", "VARIABLE_OUT_KINDS", "FREE_HIT_WICKET_KINDS", "BOWLER_CREDITED_KINDS", "CLOSE_REASONS"]`. If `CLOSE_REASONS` keeps its label pairs, keep the name and instead assert in the drift test that its values equal `inningsCloseReasons`.
- [ ] **Step 6: Verify.**
  - Engine: `src/pad src/sports/cricket`.
  - Web: `skins/__tests__/cricket.test.ts` plus the drift test plus the literal guard.
  - The golden diff exits 0 (unless Q1/Q1b ruled otherwise).
  - `engine:boundary`.
- [ ] **Mutation:** remove `"obstructed"` from the free-hit set in the engine. Both tests must go red. Restore.
- [ ] **Commit:** `feat(engine,scorepad): cricket pad rules declared once; skin reads them`

**P2 e2e (dispatch):** `mobile.spec.ts`, `scorepad-skins.spec.ts`, `scorepad-v3-cricket.spec.ts`, `scorepad-v3-cricket-lines.spec.ts`, `scorepad-v3-soft-commit-inventory.spec.ts`, `scorepad-v3-void-confirm.spec.ts`, `walkthrough/scorepad-v3-cricket-icc-picks.spec.ts`, `walkthrough/scorepad-v3-deciders-byhand.spec.ts`, `walkthrough/scorepad-v3-deciders-fullmatch.spec.ts`.

---

## Batch P3 — set-based sports and tennis

Branch `feat/pad-wave-p3`, off main after P0 (shares `src/pad/index.ts` and the closure pin with P1/P2, review m5). Two tasks with disjoint files: P3.1 (setbased) and P3.2 (nested/tennis).

| Fact | Skin | Engine source | Kind |
|---|---|---|---|
| badminton sanction levels | `badminton.tsx:131-136` | `setbased/badminton.ts:76` | b |
| setbased event bands | `badminton.tsx:165-172`, `tabletennis.tsx:166-173`, `volleyball.tsx:329-336` | `setbased/kernel.ts:1882` `fidelity` | b |
| bestOf / setTo defaults | `badminton.tsx:352-354,364,585`; `tabletennis.tsx:356-357,369,514`; `volleyball.tsx:502-516,654` | `badminton.ts:22-24`, `tabletennis.ts:28-29`, `volleyball.ts:41-43` | b |
| score bound +20 | `badminton.tsx:361-365`, `tabletennis.tsx:366-369`, `volleyball.tsx:516` | `setbased/kernel.ts:1681` | b |
| records refusals | `badminton.tsx:1016-1024`, `tabletennis.tsx:930-948`, `volleyball.tsx:1227-1234` | kernel wrongPhase sites | b, trace |
| badminton interval mark | `badminton.tsx:730` | none | c |
| court parity | `badminton.tsx:775` | none | c |
| golden point / setting note | `badminton.tsx:605-610`, `tabletennis.tsx:530-543`, `volleyball.tsx:664-672` | derived from `cfg.cap` / target | c |
| tabletennis sanction levels | `tabletennis.tsx:127` | `tabletennis.ts:80` | b |
| expedite returns 13 | `tabletennis.tsx:155` | `setbased/kernel.ts:423` `EXPEDITE_RETURNS` | b |
| receiver-only returns | `tabletennis.tsx:1134-1141` | `setbased/kernel.ts:587` | b |
| expedite score floor 9 | `tabletennis.tsx:340` | none | c, Review Focus 5 |
| volleyball sanction levels | `volleyball.tsx:293-297` | `volleyball.ts:123` | b |
| rotation cycle | `volleyball.tsx:936` (`?? 6`) | `volleyball.ts:157` | b (drop the fallback) |
| libero return | `volleyball.tsx:1606-1617` | engine comment | b, trace |
| libero band 1 | `volleyball.tsx:349` | none | c |
| tennis point kinds | `tennis.tsx:119` | `nested/kernel.ts:226` | b |
| interruption kinds | `tennis.tsx:121` | `nested/kernel.ts:113` `NestedInterruptionKind` | b |
| tennis sanction levels | `tennis.tsx:123-127` | `nested/kernel.ts:277` | b |
| tennis event bands | `tennis.tsx:150-156` | `nested/kernel.ts:1819` | b |
| 3/6/7 defaults, final set | `tennis.tsx:269-293,507` | `tennis/tennis.ts:21-22`, `nested/kernel.ts:885` | b |
| games / tiebreak bounds, tiebreak shape | `tennis.tsx:826-860` | `nested/kernel.ts:946,1665,1400` | b |
| game award refused, tiebreak server flip | `tennis.tsx:822,1140` | `nested/kernel.ts:1327,993` | b |
| calls 0/15/30/40/AD | `tennis.tsx:480-496` | none | c |
| ends changed | `tennis.tsx:582-589` | none (the skin says so) | c |
| interruption max 3600 | `tennis.tsx:1043` | none | c |

### Task P3.1: set-based kernel declarations and badminton / tabletennis / volleyball pad rules

**Files:** Modify `setbased/kernel.ts` (export the existing bound and `EXPEDITE_RETURNS` use; add `intervalMark`, `deuceNote`, `EXPEDITE_SCORE_FLOOR`, `LIBERO_BAND`, court parity, each as a pure function or constant beside the code it describes), the three sport files (export what the skins copy), `pad/index.ts`, and the three skins. Tests: `packages/engine/src/pad/setbased.test.ts`, `skins/__tests__/pad-rules-setbased.test.ts`.

**Interfaces — Consumes:** P0.1 `BadmintonPadRules`, `TableTennisPadRules`, `VolleyballPadRules`. **Produces:** `badmintonPadRules`, `tabletennisPadRules`, `volleyballPadRules`.

- [ ] **Step 1: Engine test.**
  - `sanctionLevels is the module declaration` (`toBe`), for all three sports.
  - `scoreBound(cfg) equals the padSpec field max`, over `declaredCfgs` (at least 2 per sport).
  - `expediteScoreFloor`: before writing the constant, grep the kernel's expedite logic. If the kernel enforces a floor, the test drives the fold at 8–8 and 9–9 and asserts that the refusal matches the constant. If it does not, the constant is a pad-only hint, and the test asserts the kernel accepts expedite at 8–8 (it documents that the floor is advisory).
  - `deuceNote`: a sweep over a badminton game with a cap from 0–0 to cap−1 all asserts that "goldenPoint" appears exactly at cap−1 all and "setting" exactly at target−1 all. Count the scores visited.
- [ ] **Step 2: Web drift test.**
  - It drives each skin's sanction sheet (level options), its set-score field (`max`), the interval and context line (via the exported builder that produces them), and tabletennis's expedite tile gate (shown iff the returns rule holds).
  - It runs at least 2 cfgs per sport.
  - It reports facts compared, which must be at least 20.
- [ ] **Steps 3–4:** Red, then implement. Trace "records refusals" and "libero return". Volleyball's `rotationCycle ?? 6` fallback goes; if the engine value can be undefined, the type says so and the record function returns the engine default.
- [ ] **Step 5:** BANNED entries:
  - `"badminton.tsx": ["SANCTION_LEVELS", "EVENT_BAND"]`;
  - `"tabletennis.tsx": ["SANCTION_LEVELS", "EVENT_BAND", "EXPEDITE_RETURNS_THRESHOLD", "EXPEDITE_SCORE_FLOOR"]`;
  - `"volleyball.tsx": ["SANCTION_LEVELS", "EVENT_BAND", "LIBERO_BAND"]`.
- [ ] **Step 6: Verify.**
  - Engine: `src/pad src/sports/setbased`.
  - Web: `skins/__tests__/{badminton,tabletennis,volleyball}.test.ts` plus the drift test plus the literal guard.
  - The golden diff exits 0, and `engine:boundary` passes.
- [ ] **Mutation:** change `+ 20` to `+ 21` in `kernel.ts:1681`. The engine bound test must stay green, because both sides follow the shared value. The web drift test must also stay green while the SKIN's own copy is gone. Then re-add a skin literal `+ 20` in a scratch edit: the literal guard does not catch an inline number, so the drift test, running the 21 cfg, must go red. If it doesn't, the drift test is reading the wrong thing (Review Focus 1). Restore both.
- [ ] **Commit:** `feat(engine,scorepad): set-based pad rules declared once; badminton, table tennis and volleyball read them`

### Task P3.2: nested kernel declarations and `tennisPadRules`

**Files:** Modify `nested/kernel.ts` (export `NestedInterruptionKind` use, the point-kind enum and sanction levels; add `POINT_CALLS`, `endsChanged(state)`, `INTERRUPTION_MAX_SECONDS`; `gamesFieldBound` / `tiebreakFieldBound` read the existing `setGamesBound` at `:946` and the bound at `:1665`), `pad/index.ts`, `tennis.tsx`. Tests: `packages/engine/src/pad/tennis.test.ts`, `skins/__tests__/pad-rules-tennis.test.ts`.

**Interfaces — Consumes:** P0.1 `TennisPadRules`. **Produces:** `tennisPadRules`.

- [ ] **Step 1: Engine test.**
  - `pointKinds/interruptionKinds/sanctionLevels equal the schema enums`.
  - `endsChanged`: walk a real set through the fold game by game, then a tiebreak point by point. It is true exactly after odd completed games and after each 6th tiebreak point in the second block. The expected values come from ITF Rule 10 written as the rule itself (odd total; floor(points/6) odd), and are asserted against the folded state at each step. Count the steps.
  - `gamesFieldBound(cfg)` equals `setGamesBound` over `declaredCfgs`.
- [ ] **Step 2: Web drift test.** It drives the point sheet (kinds), the interruption sheet (kinds and duration `max`), the sanction sheet, the games and tiebreak fields (`max`), the call display at each point score, and the ends-change hint. It reports facts compared, which must be at least 11.
- [ ] **Steps 3–4:** Red, then implement.
- [ ] **Step 5:** `BANNED["tennis.tsx"] = ["POINT_KINDS", "INTERRUPTION_KINDS", "SANCTION_LEVELS", "EVENT_BAND", "CALLS"]`.
- [ ] **Step 6: Verify.** Engine: `src/pad src/sports/nested src/sports/tennis`. Web: `skins/__tests__/tennis.test.ts` plus the drift test plus the guard. The golden diff exits 0, and `engine:boundary` passes.
- [ ] **Mutation:** in `endsChanged`, flip `=== 1` to `=== 0`. The engine test must go red. Restore.
- [ ] **Commit:** `feat(engine,scorepad): tennis pad rules declared once; skin reads them`

**P3 e2e (dispatch):** `mobile.spec.ts`, `scorepad-skins.spec.ts`, `scorepad-v3-badminton.spec.ts`, `scorepad-v3-tabletennis.spec.ts`, `scorepad-v3-volleyball.spec.ts`, `scorepad-v3-tennis.spec.ts`, `scorepad-v3-ending-sanction.spec.ts`, `scorepad-v3-partial-amend.spec.ts`, `scorepad-v3-strip-geometry.spec.ts`, `remote-pad-rules-w2c.spec.ts`, `score-engine-epoch.spec.ts`, `walkthrough/scorepad-v3-tabletennis-match.spec.ts`, `walkthrough/scorepad-v3-volleyball-match.spec.ts`, `walkthrough/scorepad-v3-tennis-mtb.spec.ts`, `walkthrough/tables-w2d.spec.ts`.

---

## Batch P4 — carrom, boardgame, generic, and the shared post-phase set

Branch `feat/pad-wave-p4`, off main after P1, P2 and P3 merge. `POST_PHASES` touches every skin.

| Fact | Skin | Engine source | Kind |
|---|---|---|---|
| carrom adjust reasons | `carrom.tsx:87` | `carrom/carrom.ts:683` (not exported) | b |
| carrom coins max 9 | `carrom.tsx:469` | `carrom.ts:114,703` | b |
| carrom event bands | `carrom.tsx:347-351` | `carrom.ts:806` | b |
| carrom bestOf / gameTo | `carrom.tsx:292-293,305,524` | `carrom.ts:62-64` | b |
| carrom delta ±gameTo | `carrom.tsx:536,558` | `carrom.ts:445-452` | b |
| boardgame event bands | `boardgame.tsx:140-144` | `boardgame.ts:762` | b |
| board max 200 | `boardgame.tsx:174` | `boardgame.ts:614` (not exported) | b |
| tiebreak scores | `boardgame.tsx:523` | `boardgame.ts:876` | b (PC-2) |
| armageddon gate | `boardgame.tsx:650,659` | engine | b, trace |
| generic event bands | `generic.tsx:104-107` | `generic/generic.ts:475` | b |
| generic score bounds | `generic.tsx:436-437` | `generic.ts:335-336` (not exported) | b |
| post phases | `period-shared.ts:339`, `badminton.tsx:270`, `boardgame.tsx:234`, `carrom.tsx:163`, `football.tsx:208`, `generic.tsx:187`, `tabletennis.tsx:269`, `tennis.tsx:250`, `volleyball.tsx:435` | none: the tokens `done`/`final`/`abandoned` are used by nine engine modules | c |

### Task P4.1: carrom / boardgame / generic pad rules

**Files:** Modify `carrom.ts`, `boardgame.ts`, `generic.ts` (export the existing constants unchanged), `pad/index.ts`, and the three skins. Tests: `packages/engine/src/pad/small-sports.test.ts`, `skins/__tests__/pad-rules-small.test.ts`.

**Interfaces — Consumes:** P0.1 `CarromPadRules`, `BoardgamePadRules`, `GenericPadRules`. **Produces:** `carromPadRules`, `boardgamePadRules`, `genericPadRules`.

- [ ] **Step 1: Engine test.**
  - Each record field is `toBe` the module's exported constant.
  - `opponentCoinsMax equals the schema max and the padSpec field max` (two sources, one value).
  - `generic maxTallyStep`: the fold refuses a press of `maxTallyStep + 1` and accepts `maxTallyStep`.
- [ ] **Step 2: Web drift test.** It drives carrom's adjust sheet (reasons, delta bound at two `gameTo` cfgs, coins `max`), boardgame's board field `max` and tiebreak-score options (set compare, `none ↔ null`), and generic's score and tally bounds. It reports facts compared, which must be at least 9.
- [ ] **Steps 3–4:** Red, then implement. Trace the armageddon gate.
- [ ] **Step 5:** BANNED entries: `"carrom.tsx": ["ADJUST_REASONS", "EVENT_BAND"]`, `"boardgame.tsx": ["EVENT_BAND", "BOARD_MAX"]`, `"generic.tsx": ["EVENT_BAND", "MAX_PLAUSIBLE_SCORE", "MAX_TALLY_STEP"]`.
- [ ] **Step 6: Verify.** Engine: `src/pad src/sports/carrom src/sports/boardgame src/sports/generic`. Web: the three skin tests plus the drift test plus the guard. The golden diff exits 0, and `engine:boundary` passes.
- [ ] **Mutation:** export `BOARD_MAX` as 201 in a scratch copy. The fold's sentinel test and the web drift test must both go red. Restore.
- [ ] **Commit:** `feat(engine,scorepad): carrom, boardgame and generic pad rules declared once`

### Task P4.2: `POST_PHASES` declared in the engine; every skin reads it; the guard closes

**Files:**
- Create `packages/engine/src/core/phase-tokens.ts`, with `export const POST_PHASES: ReadonlySet<string>`, re-exported from `./core` and `./pad`.
- Modify the nine engine modules that test `phase === "done" | "final" | "abandoned"` only where they test membership of the post set: read `POST_PHASES.has(...)`. Leave single-token comparisons alone.
- Modify all nine skin sites listed above (cricket has none; it reads phase through its own helpers).
- Test: `packages/engine/src/core/phase-tokens.test.ts`, and the existing `no-rule-literals.test.ts`.

- [ ] **Step 1: Engine test.** `every module's terminal phases are POST_PHASES`: for each registered sport, drive the testkit to finish, abandon and forfeit a match. Each resulting `phase` is in `POST_PHASES`, and every `POST_PHASES` member is reached by at least one sport. Count the sports, which must be 11.
- [ ] **Step 2:** Add `POST_PHASES` to `BANNED` for every skin file that declared it. Add the final assertions (P0 batch review m1, m3): every inventory pair is now in `BANNED` (none still declared); a whole-tree check that no banned name is declared in ANY skin file, not only its own; and `namesChecked === <exact count, 46 at P0 review>`, not `>= 40`. Was: `namesChecked >= 40` (the sum of the BANNED lists at the end of P4; recount it and pin it).
- [ ] **Steps 3–4:** Red, then implement.
- [ ] **Step 5: Verify.**
  - Engine: `src/core src/pad` plus each sport dir touched.
  - Web: all nine `skins/__tests__/*.test.ts` plus every drift test plus the guard, in ONE scoped invocation. These are the files this batch changed.
  - The golden diff exits 0, `engine:boundary` passes, and `npm run typecheck` passes for both `apps/web` and `packages/engine`.
- [ ] **Mutation:** remove `"abandoned"` from `POST_PHASES`. The engine test must go red. Restore.
- [ ] **Commit:** `feat(engine,scorepad): one post-phase set, declared in the engine`

**P4 e2e (dispatch):** `mobile.spec.ts`, `scorepad-skins.spec.ts`, `carrom-pad.spec.ts`, `scorepad-v3-soft-commit-inventory.spec.ts`, `scorepad-a11y-evidence.spec.ts`, `scorepad-offline.spec.ts`, `walkthrough/scorepad-v3-carrom-match.spec.ts`, `walkthrough/scorepad-v3-boardgame-result.spec.ts`, `walkthrough/scorepad-v3-r7-console-chrome.spec.ts`, `walkthrough/chess-external-play.spec.ts`, `walkthrough/tables-w2d.spec.ts`. `POST_PHASES` touches every pad, so also re-read every per-sport spec listed in P1–P3.

## Wave close

- [ ] Opus whole-wave review over P0–P4. Check that the scout counts went to zero:
  - (b) left in skins = 0, and each remaining skin constant is classified as presentation in the PR body;
  - (c) all declared;
  - Q1/Q1b recorded.
- [ ] Update `docs/superpowers/specs/engine-split/2026-10-26-owed-work.md` O-3 → DONE (merge shas). Tell the 2b plan that `engine-split-base` can be tagged.

## Self-review notes

- **Spec coverage:**
  - §3.1 → P0.1; §3.2/§3.3 → P1–P4; §3.4 → P0.2 plus each drift step; §3.5 → each Verify step plus the e2e lists; §4 → batch order; §5 Q1 → P2.1; Q2 → Global Constraints and Review Focus 5.
  - Q3 (theme): no task, by design.
- **Counts:** the scout said 82 (b) / 18 (c). This plan keeps 79 (b) and 15 (c); PC-1 removes 3 presets, and `POST_PHASES` is added as one (c) across nine sites. The four "trace" rows may reclassify (b) → (c) during their task; record each.
