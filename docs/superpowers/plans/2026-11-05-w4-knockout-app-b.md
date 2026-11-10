# W4 Knockout — App PR B (the engine 4.0.0 bump) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move seazn.club onto `@onryde/seazn-engine` 4.0.0 (the W4 engine release) and wire everything it offers into the product (design §6.3, every row): every bracket rank reader handles ties, history re-ranks to a shared 3rd, the plate takes everyone's first loss and draws after round 2, "Third place: Shared / Play-off match" is a setting on a screen, a final with both finalists out leaves the title vacant, "Declare joint winners" closes an unplayed final, the reference oracle of design §6.4, the matrix scripts that were never driven, the full e2e per row, the L3 re-baseline, and the rule close-out for the 17 "W4 app PR B" rows.

**Architecture:** One PR on `feat/w4-knockout-app-b`, cut from `origin/main` after app PR A has merged.
- **B0** installs the engine and makes the tree compile. The 4.0.0 type breaks (`BracketStage.entrants`, `FinalPlace[]`, `TakeRule.firstLosses`) are adapted at their sites. The wire keeps today's `finalRanks: string[]` through one adapter and gains `places` and `title`, so API, bench and matrix clients do not break silently.
- **B1** makes every rank reader tie-aware through two pure modules: `lib/bracket-places.ts` (place labels from ranks) and `server/public-site/champion.ts` (a title, not an id). It also re-ranks stored history with one LOUD migration.
- **B2–B4** wire the plate feed, the third-place setting and the two title actions. Each has a server half (usecases, routes, migrations) and a UI half, and the UI half is blocked on the owner's R24 picks.
- **B5** adds the reference oracle (`packages/reference`), the matrix scripts, the e2e/walkthrough/smoke, and the truth-run re-baseline.
- **B6** opens the PR, then runs the rule close-out: a companion engine docs commit, a 4.0.1 patch, and a re-pin.

**Tech Stack:** TypeScript 7 / Node 26, Next.js (this repo's non-standard version: read `node_modules/next/dist/docs/` before touching a route or page), postgres.js, zod, vitest (JSON reporter), Playwright (CI dispatch only), Flyway deltas, pnpm 10 workspace with 6 `@seazn/engine` aliases.

**Spec:** `docs/superpowers/specs/2026-11-04-format-matrix-w4-knockout-design.md` (APPROVED, ruling 274; X-CH-5 narrowed by 275).
- Scope: §6.3 (every row), §5.1–§5.3, §6.4 (the reference family; see "Premises found false" 1), §6.6 (T8-a, T8-b, T8-c, T8-d shares), §6.7 (bench gates: record only), §7 (Q8), §12.
- Signed rulebook: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W4-knockout.md`. It is the source of every expected value below. Programme rules are in `_RULES.md` beside it; the brief is `W4-knockout.md`.
- **Contracts consumed, never redefined:**
  - Engine plan `docs/superpowers/plans/2026-11-05-w4-knockout-engine.md`, "Interfaces the app plan consumes".
  - App-A plan `docs/superpowers/plans/2026-11-05-w4-knockout-app-a.md`, its Interfaces blocks and its refusal table `lib/knockout-refusals.ts`.
  - Both are quoted below where a task uses them.
- **Rule rows:** engine `rules/cross-sport.md` and `test/rules-reference.ts` `AWAITING_PROOF`. The 17 entries valued `"W4 app PR B"` are X-SD-11, X-LE-14, X-PL-2, X-PL-5, X-PL-6, X-PL-7, X-PL-8, X-TP-1, X-TP-2, X-TP-3, X-TP-6, X-TP-7, X-CH-3, X-CH-4, X-CH-6, X-FR-4 and X-FR-5. Read them at `/Users/ashokhein/github/seazn.club.engine-worktrees/w4-rule-rows`, then at 4.0.0's published `rules/`.

**Out of scope:**
- Everything in app PR A, including `fixtureStartedSql`, `isByeLine`, the reconcile, the draw, late entry and the waiting flag, the lucky loser, the format gates, the standalone refusal, and the AN-1/AN-2 guards.
- Engine code.
- K11 and K24 (W9).
- D4 (the clubs follow-up, ruling 272).
- QM-1 and K6 (refused).
- The bench gates All England / Wimbledon / WTTC: no pack exists in `tools/bench/packs/` (design §6.7). They are recorded ⏳ deferred in the PR body and `_INDEX.md`, and not built.

---

## Batch status (the owner tracks this table)

| Batch | Tasks | Gaps closed | Rule ids proved | Status |
|---|---|---|---|---|
| B0 Pre-flight, options, bump | 0, 1, 2 | the tree compiles on 4.0.0; overruled tests re-derived | — (`AWAITING_PROOF` copied, X-DW-3 `AMENDED_TEXT`) | ⏳ |
| B1 Rank readers + history | 3, 4, 5, 6 | SH-3 (close), Q4 (read half), ruling 270 | X-TP-3, X-FR-4, X-FR-5 | ⏳ |
| B2 Plate | 7, 8 | FX-G14 (close), PL-1, PL-3, T8-b | X-PL-2, X-PL-5, X-PL-6, X-PL-7, X-PL-8, X-SD-11, X-LE-14 | ⏳ |
| B3 Third place | 9, 10 | 3P-1 | X-TP-1, X-TP-2, X-TP-6, X-TP-7 | ⏳ |
| B4 Title actions | 11, 12, 13 | Q4, WD-CASC (vacant half) | X-CH-3, X-CH-4, X-CH-6 | ⏳ |
| B5 Oracle, matrix, e2e, L3 | 14, 15, 16, 17 | T8-a, T8-c (PR-B share), T8-d, design §6.4 | — (extra tokens only) | ⏳ |
| B6 PR + rule close-out | 18, 19 | — | the 17 rows filled (engine companion commit, 4.0.1) | ⏳ |

**17 ids:** 3 + 7 + 4 + 3 = 17. That is every `"W4 app PR B"` entry. X-TP-3 and X-FR-4 are also re-asserted by B5's e2e. The table at the end maps each id to its tests.

---

## Global Constraints

- **Worktree.**
  - Path `/Users/ashokhein/github/seazn.club-worktrees/w4-app-b`, branch `feat/w4-knockout-app-b`. Cut it from a fresh `origin/main` that contains the merged app PR A. Confirm with `git log --oneline origin/main | grep -m1 "w4"`, and confirm that `apps/web/src/lib/knockout-refusals.ts` exists.
  - Never write in `~/github/seazn.club`: its `node_modules/@seazn/engine` points at an untracked `packages/engine/`, design §3.
  - Never `git stash`; the stack is shared.
  - `$WT` = that worktree. `$S` = the executor's own scratchpad subdirectory `<scratchpad>/w4b-<task>/`. Never `rm` outside it.
  - Shell cwd resets between calls, so prefix every command with `cd $WT && ` or `cd $WT/apps/web && ` in the same call.
- **Re-pin first.**
  - Line numbers below were read at app `97d22c8acd`, before PR A's rewrites, and at the two sibling plans as committed in `6f43116571`.
  - Every task opens its cited lines before editing (AGENTS.md class 5).
  - A moved pin is not a finding. A pin whose BEHAVIOUR changed is a finding; record it in the commit body.
- **Re-read the engine contract** before Task 2 and again before Task 18. Open 4.0.0's `dist` types for `@seazn/engine/competition` (`stage.ts`, `progression.ts`, `first-loss.ts`) and `@seazn/engine/scheduling`. If any name in "Interfaces consumed" differs, the engine wins: stop and report the diff before adapting.
- **Environment:** follow the `seazn-local-env` skill: a fresh DB, `db:apply`, then `sync:sports`. Confirm `show data_directory` is yours. DB suites are red without it, and that red is environmental.
- **Scoped vitest only.** Never the full suite, the full gate or the full e2e locally (owner, 2026-09-28).
  - `VERIFY-WEB <name> <files…>` = `cd $WT/apps/web && npx vitest run <files…> --reporter=json --outputFile=$S/<name>.json; echo EXIT=$?`.
  - Then `node -e 'const r=require(process.argv[1]);console.log(r.numPassedTests+"/"+r.numTotalTests,"failedSuites="+r.numFailedTestSuites);for(const t of r.testResults)console.log(t.status,t.name)' $S/<name>.json`.
  - **Green** = `EXIT=0`, passed = total > 0, `failedSuites=0`, and every named file appears in `.testResults[].name` under `$WT`. The JSON reporter cannot see an Unhandled Rejection, so EXIT=0 is required.
  - Name whole files; positionals are literal filters. Never an empty list (zsh then runs the FULL suite). Never through `rtk`. Never `--root`. Never `--testTimeout`.
  - `VERIFY-ROOT <name> <files…>` = `cd $WT && ./node_modules/.bin/vitest run <files…> --reporter=json --outputFile=$S/<name>.json; echo EXIT=$?`, judged the same way. Use it for `scripts/__tests__`, `tools/matrix/__tests__` and `packages/reference`.
- **Types:**
  - `cd $WT && pnpm turbo run typecheck; echo EXIT=$?` (all six consumers; this is the engine's `downstream` job).
  - `cd $WT && node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json; echo EXIT=$?`.
  - Never through `rtk`.
- **Lint:** `cd $WT/apps/web && rtk proxy npm run lint`. Read `✖ N problems`; the count must not rise.
- **OpenAPI:** a route or schema change runs `npm run openapi:gen` in `$WT`, then `git status --porcelain openapi/`. Only the intended change may appear, and it is committed.
- **Locale (R23):**
  - Every new user-facing string goes into all four `apps/web/src/dictionaries/{en,es,fr,nl}/{ui,public}.json`, as the key's family requires.
  - Then `npm run i18n:gen-keys` and `npm run i18n:check`. Never hand-edit `lib/i18n-keys.ts`.
  - Refusal copy: a row in app-A's `apps/web/src/lib/knockout-refusals.ts` table (`KNOCKOUT_REFUSALS`, `knockoutRefusalKey`), thrown through `knockoutRefusal(code, details?)` (`server/usecases/knockout-refusal.ts`). Never a typed literal status.
- **Migrations:**
  - `db/migration/deltas/V<next>__<name>.sql`. App A takes V492 and V493, so this plan expects **V494** (Task 12, schema), **V495** (Task 7, plate progressions, LOUD) and **V496** (Task 6, Q8 re-rank, LOUD). **Moved 2026-11-09:** R4 took V492 on main, so app A now holds **V493 and V494**; app B's three shift to the next free numbers after app A merges (V495 onwards; `feat/swiss-auto-advance` holds an unmerged V497, so check every open branch, not only main).
  - Re-check the next free number on `origin/main` at task time. A clash is renumbered, never reordered.
  - A data-moving delta opens with a `-- DATA CHANGE (LOUD)` header in V481/V490's shape: count first, then write, in one block, idempotent.
  - It is listed in the PR body's "Data changes", runs pre-deploy (owner rule 2026-10-28), and never ships a compat shim.
  - stg data is test-only: clean up, no compat.
- **Tests (TEST-STRATEGY.md; `_RULES.md` R9/R13/R15/R17/R25/R27/R28): all four types per task.**
  - **Unit:** vitest, DB-backed (`describe.runIf(HAS_DB)`) wherever SQL is involved.
  - **E2E:** a `test.describe` per task in `apps/web/e2e/w4-knockout-app-b.spec.ts` (Task 2 creates it), run only by CI dispatch and judged as a whole file.
  - **Smoke:** counted checks in `scripts/smoke/suites/w4KnockoutB.ts` (Task 2 creates it). `EXPECTED_CHECKS` grows by each task's "+N", and zero checked is a failure.
  - **Regression:** the task's first test fails on today's `main` (or on the bump commit before the task's code) for the gap it closes.
  - **Expected values** come from the rulebook (cite the RB4 id in the assertion message) or from the engine's own declarations (`completeBracketStage`, `bracketTitle`, `firstLossField`, `generateSingleElim`, `BRACKET_SHARED_RANKS`). Never from the app code under test. At least one case per guard has a right answer that differs from today's wrong one, marked `// differential: today X`.
  - **Anti-vacuity:** every sweep, property and table test prints its count and asserts it is > 0. Where the axes are enumerable, the count equals the product. Each rule set states its empty case first (R13).
  - **Mutation:** mutate each new guard once, one at a time: delete it, `return true`, or revert to today's line. See a named test go red, restore, and record `mutant → killer test` in the commit body. Guards that cover for each other are mutated separately.
  - **Sequence (R27):** every behaviour task covers:
    - a **second call**;
    - an **empty input**;
    - **after a withdrawal or void**;
    - **after an Undo** (where one exists);
    - **another sport**: badminton plus one of football or chess, chosen by `sportFor` from engine declarations, and cricket wherever CK-KO-1 is involved.
  - **Seats and ranks, never shell counts:** assert who plays whom (`home_entrant_id`/`away_entrant_id`) and who holds which rank, never "the stage completed" (brief trap 3).
- **Rank places** (the table every rank assertion derives from; engine plan Global Constraints, RB4-T2/T3/T6/C1–C4/R1/R2/S7, quoted unchanged):

  | Case | Ranks, in order |
  |---|---|
  | n = 2 | 1, 2 |
  | n = 3 (one real semi-final) | 1, 2, 3 |
  | n ≥ 4, Shared (no third-place fixture) | 1, 2, 3, 3, then 5 … strict |
  | n ≥ 4, Play-off decided | 1, 2, 3, 4, then 5 … |
  | Play-off, both sides out | 1, 2, 4, 4, then 5 … (3rd vacant) |
  | Play-off voided | 1, 2, 3, 3, then 5 … |
  | Joint winners | 1, 1, then the 3rd-place block, then 5 … |
  | Vacant title | 2, 2, then the 3rd-place block, then 5 … |
  | double_elim, stepladder, page_playoff | strict 1 … n, except joint (1, 1, 3 …) and vacant (2, 2, 3 …) |

- **Rule ids: the engine rows are the only id authority.**
  - A proving test's `describe`/`it` title carries the id as a whole token (`X-TP-3 …`).
  - Never put `-KO-` in an id or a title token (design §12; `packages/reference`'s bracket-finish family reds on it).
  - Never invent an id. A behaviour with no row is a finding for the orchestrator.
  - The proving paths in the table at the end are a CONTRACT with Task 19's engine commit. Never rename or move a cited file, and never drop an id from a title, without amending that table first.
- **UI tasks (5, 8 Step 6, 10, 13):**
  - Blocked on the owner's pick from Task 1's options page (R24). Invoke the `frontend-design` skill first. Use the house theme; mocks are layout only.
  - Mobile-first: one DOM, `max-md:*` branches, no second phone tree (AGENTS.md "phone composition").
  - Verify at 1280, 320 and 768 with no horizontal page scroll. Compare the control SET at 320 against 1280.
  - Screenshots go to the local sign-off server on `:8765` with a per-screen verdict, plus a copy under `~/seazn-artifacts/w4-app-b/`. Never into the repo, never an Artifact.
  - A new testid on the stage rail, the fixture console or a public table: grep `apps/web/e2e/mobile.spec.ts` and keep its control-set and clipping scans true. Anchor HTML assertions on `="`.
  - `/admin` is untouched.
- **E2E by CI dispatch only:** `gh workflow run e2e.yml --ref feat/w4-knockout-app-b -f pr=<N>`, always with `--ref`, at batch ends.
  - Judge whole spec FILES, never a `-g` slice. A serial file's red count is a floor (AGENTS.md class 21).
  - A push cancels a running dispatch. Dispatch, then hand back; the main thread watches the run.
- **Smoke wiring:**
  - One `suite("w4KnockoutB", …)` call in `scripts/smoke/main.ts`, after app-A's `w4KnockoutA`.
  - The owner `delivered+w4b_${tag}@resend.dev` in `scripts/smoke/harness.ts`'s cleanup list.
  - A `SELECTABLE_SUITES` entry in `scripts/smoke/index.ts`.
  - Run `SMOKE_ONLY=w4KnockoutB npm run test:smoke` against a live local server. The count must equal `EXPECTED_CHECKS`.
- **R27 PR body line:** `Matrix rows: knockout, knockout_third_place, ko_plate, qualifying_main, stepladder_only, page_playoff_only, league_ko, groups_ko, group_stepladder, group_playoffs, swiss_knockout, swiss_playoff, double_elim × all (engine 4.0.0)`. The bump moves every bracket kind's ranks and completion. Confirm the grammar with `pnpm matrix:pr-rows` on the body before opening.
- **Never touch:**
  - the engine repo, except Task 19's companion commit, which the controller runs;
  - `stryker-*.json`;
  - the spec, the rulebook and the two sibling plans;
  - `_INDEX.md` rulings. Tasks append to "W4 status" and "False premises found (W4)" only. The next free ruling was 276 on 2026-11-05; re-check before claiming one.
  - `truth-runs/w1d-baseline/**`.
- **Commits:** conventional. End every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Interfaces consumed (engine 4.0.0, verbatim from the engine plan; re-verify against the published types)

```ts
// @seazn/engine/competition (stage.ts)
export interface FinalPlace { readonly entrantId: EntrantId; readonly rank: number }
export const BRACKET_SHARED_RANKS: ReadonlySet<number>;            // {1, 2, 3, 4}
export type BracketTitle =
  | { readonly kind: "champion"; readonly entrantId: EntrantId }
  | { readonly kind: "joint"; readonly entrantIds: readonly [EntrantId, EntrantId] }
  | { readonly kind: "vacant"; readonly finalists: readonly [EntrantId, EntrantId] };
export interface BracketStage { id: string; kind: Extract<StageKind, "knockout" | "double_elim" | "stepladder" | "page_playoff">;
  seeds?: ReadonlyMap<EntrantId, number>; entrants: readonly EntrantId[] }            // entrants NEW, REQUIRED
export interface BracketFixture { /* …existing… */ jointWinners?: true }             // only on the deciding final, both seats,
                                                                                     // no winner/loser/walkedOver, status "decided"
export type DivisionEvent = /* … */ | { type: "stage_completed"; stageId: string; finalRanks: FinalPlace[] } /* … */;
//   BREAKING for every stage kind: a table stage's finalRanks is its cross-pool order with rank = position (i + 1).
export interface CompletedBracketStage { events: DivisionEvent[]; finalRanks: FinalPlace[]; title: BracketTitle }
export function isBracketStageComplete(stage: BracketStage, fixtures: readonly BracketFixture[]): boolean; // every fixture settled
export function undecidedBracketFixtures(fixtures: readonly BracketFixture[]): string[];
export function completeBracketStage(stage: BracketStage, fixtures: readonly BracketFixture[]): CompletedBracketStage;
//   throws EngineError("STAGE_NOT_READY", …, { stageId, reason: "fixtures_undecided", undecided }) | { reason: "no_final" }
export function bracketRanks(stage: BracketStage, fixtures: readonly BracketFixture[]): FinalPlace[];  // provisional mid-bracket
export function bracketTitle(fixtures: readonly BracketFixture[]): BracketTitle | undefined;
export function assertBracketPlaces(places: readonly FinalPlace[], entrants: readonly EntrantId[]): void;

// @seazn/engine/scheduling — generateSingleElim({ thirdPlace: true }) with fewer than two real semi-finals:
//   throws EngineError("CONFIG_INVALID", …, { reason: "third_place_needs_two_semis", entrants: n, realSemis })

// @seazn/engine/competition (first-loss.ts, NEW)
export interface FirstLoss { readonly entrantId: EntrantId; readonly fixtureId: string; readonly round: number }
export interface FirstLossField { readonly complete: boolean; readonly losers: readonly FirstLoss[];
  readonly excluded: readonly FirstLoss[]; readonly pending: readonly string[] }
export function firstLossField(rows: readonly BracketFixtureRow[]): FirstLossField;

// @seazn/engine/competition (progression.ts)
export type TakeRule = /* … */ | { kind: "firstLosses" };
export type SlotDescriptor = /* … */ | { kind: "first_loss"; position: number };  // key `first:${p}`, label { key: "slot.first_loss", params: { n } }
export interface SourceShape { poolKeys: string[]; firstLosses?: number }
export interface BracketFixtureRow { round: number; loser?: EntrantId; id?: string; status?: FixtureStatus; home?: EntrantId;
  away?: EntrantId; winner?: EntrantId; walkedOver?: "loser" | "both"; bracket?: "WB" | "LB" | "GF"; thirdPlace?: boolean }
export function placementTable(finalRanks: readonly EntrantId[] | readonly FinalPlace[]): PoolTable;
// resolveProgression first_loss: STAGE_NOT_READY reason "first_loss_field_incomplete" | "first_loss_field_changed".
// rank_range resolves by POSITION; a cut through a shared rank sets tieUnbroken + tieBreak { key: "shared_place", with }.
```

Behaviour with no type change:
- A knockout with no third-place fixture ranks both semi-final losers 3rd.
- A stage with an unplayed third-place match is not complete.

The 14 engine-PR rows are proved in the engine. The 39 app-A rows are proved by engine B6, or by a later patch before this bump (engine plan T12 gate). Task 0 records which.

## Interfaces consumed (app PR A, merged)

- `lib/knockout-refusals.ts`: `KnockoutRefusalCode`, `KNOCKOUT_REFUSALS: Record<KnockoutRefusalCode, { status: 400 | 409 | 422; en: string; key: MessageKey }>`, `knockoutRefusalKey(code)`, `isKnockoutRefusalCode(code)`. `server/usecases/knockout-refusal.ts`: `knockoutRefusal(code, details?) → HttpError`. New codes added here go into the same table.
- `server/usecases/fixture-started-sql.ts`: `fixtureStartedSql(tx, on = "f")`, `stageHasStarted(tx, stageId): Promise<boolean>` (score, live, decided or a Match Day call; X-LE-9).
- `lib/bye-line.ts`: `isByeLine(f)`, and `byeLineSql(tx, on)` in `engine-db/system-bye-sql.ts`.
- `lib/bracket-role.ts`: `bracketRoleKey(row, finalRound)`, `finalRoundOf(rows)`.
- `server/usecases/stages.ts`: `knockoutDrawOrder(stageId, active, cfg)` and `readStageDrawSeed(tx, stageId): Promise<number | null>`, which use `swissDrawSeed`/`swissRoundOneOrder` from `lib/swiss-draw.ts`. Also `undecidedBracketFixtures(tx, stageId)`; it shares a name with the engine's new export (Task 2 resolves the import).
- `server/usecases/knockout-late-entry.ts`: `admitKnockoutLateEntrant`, `applyKnockoutLateDecision`, `placeWaitingKnockoutEntrant`, and `KnockoutLateEntryResult` (`format: "knockout"`, `case: "bye" | "withdrawn_slot" | "waiting" | "refused" | "rebuild_offered"`).
- `lib/format-size-gates.ts`: `stageGraphSizeRefusal(stages, n)` (`KO_PLATE_TOO_FEW` below 4; it reads a `roundLosers` stage today, and Task 7 extends it to `firstLosses`), `isWholeRoundCut(width)`.
- `lib/division-phase.ts` attentions `late_players_waiting` (amber) and `final_decided` (red).
- `apps/web/e2e/w4-knockout-app-a.spec.ts` helpers. Import them, or move module-private ones to `apps/web/e2e/support/` in Task 2. Also `scripts/smoke/suites/w4KnockoutA.ts` (24 checks).
- App A's matrix share: Q4b ⛔, D4b ⛔, D4a ⏳, the R2/R10/R6 scripts, `stepladder_only`/`page_playoff_only` ⛔, and possibly 22 L3 entries re-baselined (its Task 16 Step 5; Task 0 reads which).

## Review Focus

1. **A double-elimination stage whose winners' champion wins the first grand final.** The reset (`gf-reset`, `conditional`) is never played and nothing in production writes its void (`champion.ts` header). Under 4.0.0's "every fixture settled" (X-CH-7), that stage would never complete. A person expects the stage to complete with the WB champion crowned. Pinned in Task 2: `X-CH-1 a double-elim won in the first grand final completes after the bump`.
2. **A plate whose first-loss field is complete while a bye holder's round-2 line is the LAST thing decided, and that result is then corrected.** The proposal must re-propose (field changed), never seat the stale loser. Pinned in Task 8: `X-PL-7 a corrected round-2 result re-proposes the plate (first_loss_field_changed)`.
3. **A knockout set to "Play-off match" that falls to 3 active entrants before Start** (a withdrawal, then Generate). A person expects a named refusal with a one-tap "Use Shared" recovery, never a 500 and never a silent bracket without the play-off. Pinned in Task 9: `X-TP-1 a play-off stage that shrinks to 3 refuses by name and offers Shared`.
4. **Joint winners declared, then a finalist withdraws.** The final is already closed. A person expects the joint title to stand (the withdrawal walks over nothing), never a vacant title and never a 500 in the cascade. Pinned in Task 12: `X-CH-4 a withdrawal after joint winners leaves the joint title standing`.
5. **A finished bracket read by an API client that parses `finalRanks` as strings** (the bench, the matrix, an integrator). Its order must still parse, with ties visible only in the new `places`. Pinned in Task 3: `X-FR-4 stage_completed keeps finalRanks: string[] in rank order and adds places`.

---

## Task 0: Pre-flight, merge order, live data (controller-run; no code)

**Files:** none in the repo. Output goes to `$S/preflight.md`, then into the PR body and an `_INDEX.md` "W4 status" note.

- [ ] **Step 1: Gates to start.**
  - App PR A is merged to `origin/main`.
  - Engine 4.0.0 status:
    - **(a)** Published: `gh api /orgs/onryde/packages/npm/seazn-engine/versions --jq '.[].name' | grep -x 4.0.0`; `gh release view v4.0.0 -R onryde/seazn.club.engine` exists; and its epoch report names no `FOLD_EPOCH` move (engine plan Global Constraints: none expected). Or:
    - **(b)** Only the engine PR is open with a `0.0.0-pr<N>.<sha>` snapshot (engine plan T13 Step 2 recommends merging the engine PR once THIS PR is green on the snapshot).
    - Record which. An epoch move is a STOP.
  - Which app-A rows 4.0.0 carries proved: read `node_modules`-free from the tag, `gh api repos/onryde/seazn.club.engine/contents/test/rules-reference.ts?ref=v4.0.0 --jq .content | base64 -d | grep -c '"W4 app PR A"'`. Expected 0 (engine T12 ran) or 39. Record the count; Task 2 copies whatever remains.
  - Which L3 cells app A re-baselined: `git log origin/main -- tools/matrix/catalogue/baseline.json`. Task 17 needs it.
- [ ] **Step 2: Merge-order decision — PUT IT TO THE OWNER in chat; do not decide it.**
  - **Recommended: flow A (paired PRs).** This is the engine plan's T13 Step 2 and W3's precedent.
    1. Install the snapshot through ONE `pnpm-workspace.yaml` `overrides:` entry (`"@seazn/engine": "npm:@onryde/seazn-engine@0.0.0-pr<N>.<sha>"`, the block at `:52`). The 6 manifests and their range tests stay as they are.
    2. Build and gate every task on the snapshot.
    3. The owner merges the engine PR over its expected `downstream` red, then cuts `release/4.0.0` (engine-release skill §1).
    4. Task 18 removes the override and moves the 6 manifests to `^4.0.0`.
    - Owner value: the major is proven by its only consumer before it ships, and app main is never broken (a `^3` caret never resolves 4.x).
  - **Alternative: flow B.** Release 4.0.0 first, then build on `^4.0.0`. This is the brief's framing ("after the engine 4.0.0 release") and the skill's "never pin a snapshot". Cost: a defect found here needs a 4.0.1 round-trip.
  - Record the owner's words. A recommendation is never labelled a ruling (class 17).
- [ ] **Step 3: Live data (stg standing read; prod only with the owner's OK and route given in chat).**
  - Connection rules: the URL is the commented `REMOTE_DATABASE_URL` (`seazn.club/.env.local:9`), passed by env only (never argv, logs or chat). Set `default_transaction_read_only=on` and `search_path=seazn_club`.
  - Counts, each grouped by division and sport:
    1. **Q8 (feeds V496):** complete `knockout` stages with a pool-null `standings_snapshots` row, no `third_place` fixture, and two seated semi-final losers holding ranks 3 and 4. List how many sit in a completed competition.
    2. **Plate (feeds V495):** stages whose `progression.sources[].take` holds `roundLosers`. Split them into: plate fixtures all TBD with no seated entrant and no result, versus seated or played.
    3. **X-CH-3 shapes:** bracket finals whose two seated finalists are both in `DEPARTED_STATUSES`, with the final open (today they wait for settle under X-WD-4).
    4. **Review Focus 1:** complete `double_elim` stages whose `gf-reset` row is `scheduled` (conditional, never played).
    5. **Third place:** knockout stages with `config.thirdPlace = true` and fewer than 4 entrants.
  - Prod: counts 1, 3 and 4 only, as one statement, if the owner gives the OK. The owner's census found 9 finished prod brackets (design §7), so count 1 is expected to be 9. If the owner declines, the PR body says "prod not read" and V495/V496 stay idempotent.
- [ ] **Step 4: Decide and record.**
  - Count 4 > 0 means Task 2's DE-reset mapping is a live fix, not a pin.
  - Count 2's seated/played rows keep their stored `roundLosers` progression (the engine still resolves it); only all-TBD plates are rewritten.
  - Count 3 > 0 means Task 11 re-reads those finals in V496's block, and says so (LOUD).

## Task 1: R24 options page for PR B's new UI (owner picks before any UI task builds)

**Why:** R24 and design §11 "the R24 options page for every new control". App A's page covered the late-entry flag, the draw seed, the AN-1 warning, the plate reason line and the bracket-only OG card. This page covers PR B's.

**Files:** none in the repo. A static page served from the local sign-off server on `:8765`, with a copy in `~/seazn-artifacts/w4-app-b/r24/`, built with the `frontend-design` skill in the house theme.

- [ ] **Step 1:** For each item, at least two layouts, each drawn at 1280, 768 and 320. The candidates below are the designer's, for the page, not decisions:
  1. **Third-place control** (design §5.2). Both sit in the division builder (format picker) and the stage settings.
     - (A) A two-segment control "Shared | Play-off match".
     - (B) A single toggle "Play a third-place match", off = Shared, with one helper line.
     - Both are hidden below 4 entrants, with a one-line reason.
  2. **Shared 3rd on standings surfaces** (bracket placement list, public standings, hub, embed, `/present`).
     - (A) Both rows read "3rd" with a small "shared" chip.
     - (B) Both rows read "=3rd" (a tie marker) with the next row "5th".
  3. **Title display** (bracket final tile, public banner, hub, OG card).
     - (A) "Joint winners: X and Y" with one trophy, and "Title vacant" as a muted line.
     - (B) Two crowned names stacked, and "No champion — both finalists withdrew".
  4. **"Declare joint winners" and its Undo** (fixture console organiser actions on a final; X-CH-6).
     - (A) Beside "Settle" in the organiser block, with a confirm sheet naming both finalists.
     - (B) Inside the final's More menu, with the same confirm.
     - Undo: "Undo joint winners" in the same place, shown only on a joint final.
  5. **Plate before its field is known** (stage card and bracket): (A) a placeholder card "Plate draws after round 2 — N of M first matches decided"; (B) a muted line on the Main draw card.
  6. **The X-PL-2 outcome** "Not enough first-match losers for a plate": (A) the plate card completes with the sentence; (B) a desk notice plus the card's sentence.
  7. **The X-TP-1 refusal's recovery** (Review Focus 3): (A) the refusal names the count and offers "Use Shared"; (B) the same, plus a link to the stage settings.
- [ ] **Step 2:** Post the link in chat with a recommendation per item, stating the owner value. Record the picks in `$S/r24-picks.md` and the PR body. Tasks 5, 8 (Step 6), 10 and 13 read this file; none starts its UI step before its pick exists.

---

## Task 2: Bump onto 4.0.0; adapt every breaking type; re-derive the tests the release overrules; rules checker at the bump

**Rules:** none new. This is the substrate. The engine-side behaviour changes are re-derived wherever app tests froze the old values:
- shared 3rd (X-FR-1, ruling 270);
- a play-off holds completion (X-TP-4);
- every fixture settled (X-CH-7);
- the n<4 third-place refusal (X-TP-5).

**Files:**
- Install (per Task 0's flow):
  - Flow A: ONE `pnpm-workspace.yaml` `overrides:` entry plus `pnpm-lock.yaml`.
  - Flow B: the 6 manifests (`package.json:73`, `apps/web/package.json:25`, `packages/scheduler/package.json:20`, `packages/reference/package.json:14`, `tools/bench/package.json:8`, `tools/matrix/package.json:7`) to `npm:@onryde/seazn-engine@^4.0.0`, plus `pnpm-lock.yaml`.
  - Never edit the 4 range tests: `scripts/__tests__/registry-install.test.ts`, `scripts/__tests__/engine-package-identity.test.ts`, `tools/matrix/__tests__/workspace-wiring.test.ts`, `apps/web/src/__tests__/toolchain.test.ts`.
- Modify `apps/web/src/server/engine-db/competition.ts`:
  - `:990-994`: `BracketStage` gains `entrants: inputs.entrants`. These are the stage's entrants with withdrawn and disqualified included; re-read how `loadStageInputs` builds `inputs.entrants` and `inputs.field`, and pass the full stage roster, not `field`.
  - `:969-981`: the ladder's `stage_completed` maps `ladder_order` to `FinalPlace[]` with rank = i + 1.
  - `:1063-1070`: `placementTable(completed.finalRanks)` takes `FinalPlace[]`, so ties are kept.
  - The `toBracketFixture` status of an unneeded DE reset: see Step 4.
- Modify: every exhaustive switch over `TakeRule["kind"]` / `SlotDescriptor["kind"]` that tsc names. Known: `components/v2/template-gallery.tsx:128`, `tools/matrix/lib/scenarios/advance.ts:71-102`, `lib/slot-label.ts`, `server/usecases/stage-seeding.ts`, `server/api-v1/schemas/` (the `TakeRuleSchema` compile-time tie at `:1037-1040`).
  - At the bump, each answers `firstLosses` with a named "not yet wired" throw; Task 7 replaces it. The tie in `api-v1/schemas/` admits `firstLosses` only in Task 7, so the throw is unreachable from the wire in between. Say so in the commit body.
- Modify: `TIE_BREAK_MSG_KEYS` (`server/public-site/standings-view.ts`) gains `shared_place` → `table.tieBreak.shared_place` ("Shared place"), in 4 locales, if tsc demands it. Otherwise it is added in Task 4.
- Modify: `scripts/lib/rules-reference.ts:37` `AWAITING_PROOF`. Copy every entry the installed 4.0.0 still holds: the 17 `"W4 app PR B"`, plus any `"W4 app PR A"` Task 0 counted. Copy the values verbatim. The doc comment gains the W4 paragraph, in the engine's words (`test/rules-reference.ts` at 4.0.0).
- Modify: `scripts/__tests__/rules-reference.test.ts` `AMENDED_TEXT` (`:41-81`) gains `X-DW-3`. `says` is 4.0.0's row text verbatim: `"A double walkover is refused where the fixture has no next match (final, last rung, third-place match) with guidance: reschedule, record a walkover if one side turned up, or settle as a last resort; the fixture stays open. A vacant title, joint winners and a vacant 3rd are X-CH-3, X-CH-4 and X-TP-7 (rulings 267 and 274)."`; `by` is `"rulings 267 and 274 (2026-11-04, W4 rulebook RB4-C3, RB4-C4, RB4-T6): the vacant title and joint winners it handed to W4"`. Then the `amended` count assertion at `:207` moves by one; re-read it.
- Modify `apps/web/src/lib/division-phase.ts:716-722`: the comment claims "a third-place playoff completes on its FINAL alone". That is false on 4.0.0. Rewrite the comment, keep the guard, and add the test in Step 1.
- Re-derive every app test the release overrules. Find them BY BEHAVIOUR, not by filename (AGENTS.md class 16):
  - `cd $WT && rtk proxy grep -arln "finalRanks\|rank: 4\|rank === 4\|\"4th\"\|third.place\|thirdPlace\|-3p\|isBracketStageComplete\|completeBracketStage\|roundLosers" apps/web/src apps/web/e2e scripts tools packages/reference --include='*.ts' --include='*.tsx'`;
  - plus whatever `pnpm turbo run typecheck` and the scoped runs name.
  - Each re-derived expectation carries its rulebook citation (`// RB4-T2, ruling 270: was 3/4 by seed`). The commit body lists every file and assertion changed, with the ruling that overrules it (class 4).
  - Expectations NOT explained by a ruling are findings. Report them; never edit one to green.
- Create:
  - `apps/web/e2e/w4-knockout-app-b.spec.ts` (an empty describe scaffold, modelled on `w4-knockout-app-a.spec.ts`);
  - `scripts/smoke/suites/w4KnockoutB.ts` (`EXPECTED_CHECKS = 1`, with a zero-checked failure);
  - the smoke wiring in `scripts/smoke/{main,harness,index}.ts`.
- Test: `apps/web/src/server/engine-db/__tests__/bracket-bump-w4.test.ts` (new).

**Interfaces:**
- Consumes: the engine block above.
- Produces:
  - `stageRosterIds(inputs): string[]` in `engine-db/competition.ts`: every entrant of the stage, departed included, deduplicated, in `inputs.entrants` order. It is the `BracketStage.entrants` value.
  - `CompleteResult.events` still carries engine events internally. The wire mapping is Task 3's.

- [ ] **Step 1: Write the failing tests** in `bracket-bump-w4.test.ts` (DB; badminton, then chess by `sportFor`):
  - `X-FR-1 a 4-draw with no third-place match completes with both semi-final losers at rank 3` (`// differential: today 3/4 by seed`). Read the stored snapshot rows' ranks. The expected multiset is `[1,2,3,3]`, from the Rank places table.
  - `X-TP-4 a play-off stage with the -3p scheduled is not complete; deciding it completes 1,2,3,4`. Pair it with the division-phase assertion: the desk reads the division not finished while the `-3p` is live (`division-phase.ts:716`).
  - `X-FR-1 a declared entrant in no fixture (a departed qualifier whose line was voided, F14) ranks last, never missing`. This proves `entrants` is the full roster: a mutant passing `field` reds here.
  - `X-CH-1 a double-elim won in the first grand final completes after the bump` (Review Focus 1). The WB champion wins `gf`; the `gf-reset` row stays as production leaves it; `completeStage` completes, and the champion is the WB champion.
  - `X-TP-5 a play-off knockout of 3 refuses at Generate by name` asserts only that the generate throws through a named HTTP refusal and not a 500. Task 9 owns the copy and the recovery.
  - Empty case first: a stage with no fixtures does not complete (`no_final`), and the refusal is a 409/422, never a 500.
- [ ] **Step 2: Run on the old engine.** Use VERIFY-WEB before installing; expect FAIL on the shared-3rd and DE cases.
- [ ] **Step 3: Install** per Task 0's flow, then `cd $WT && pnpm install; echo EXIT=$?`. Confirm `node -p 'require("./apps/web/node_modules/@seazn/engine/package.json").version'` prints the expected version, and the same under `packages/reference/`. `git diff --stat` shows only the install files. App CI's registry guard (`ci.yml:131-148`) must accept the result. If it rejects the override, STOP and report rather than editing the guard.
- [ ] **Step 4: Adapt.** Run `pnpm turbo run typecheck`, and fix each error at its site with no cast and no non-null assertion.
  - **DE reset:** in `completionEngineStatus` / `toBracketFixture`, a `conditional` final whose reset is not owed reads `"void"`. "Not owed" is `champion.ts`'s own test: the deciding `gf` was won by its home entrant. Never write that void to the row; the read is enough, and `champion.ts` already reads it the same way.
  - **Import collision:** import the engine's `undecidedBracketFixtures` under an alias where `stages.ts` also has app-A's function of that name. Keep app-A's name, so the X-CH-7 app-half test titles do not move.
- [ ] **Step 5: Re-derive** the overruled tests listed by the grep, as above.
- [ ] **Step 6: Rules checker at the bump.** Run `VERIFY-ROOT t2-rules scripts/__tests__/rules-reference.test.ts`. It must be green with the copied `AWAITING_PROOF` and the X-DW-3 amendment.
  - Mutate (a): delete one copied entry, and see "names no proving test" red.
  - Mutate (b): drop X-DW-3 from `AMENDED_TEXT`, and see "the text is not Appendix A's" red. Restore both.
- [ ] **Step 7: Run, verify PASS:**
  - `VERIFY-WEB t2` with `bracket-bump-w4.test.ts`, `placement-snapshots.test.ts`, `auto-advance-finished.test.ts`, `dead-feeder-cascade.test.ts`, `bracket-complete-guard.test.ts` (app A), `withdrawal-w2b.test.ts`, `division-phase.test.ts`, and every file Step 5 touched (named);
  - `VERIFY-ROOT t2-root scripts/__tests__/registry-install.test.ts scripts/__tests__/engine-package-identity.test.ts scripts/__tests__/engine-bare-imports.test.ts tools/matrix/__tests__/workspace-wiring.test.ts`, and `VERIFY-WEB t2-tc src/__tests__/toolchain.test.ts`;
  - both tsc commands and lint.
- [ ] **Step 8: Mutate:**
  - (a) Pass `inputs.field` as `entrants` → the departed-qualifier test reds.
  - (b) Drop the DE-reset void read → the double-elim test reds.
- [ ] **Step 9: E2E + smoke.**
  - E2E: describe `X-FR-1 a finished 4-draw shows two 3rds on the bracket` (API-built; it reads the public standings JSON; Task 5 drives the screen).
  - Smoke check 1: complete a 4-draw → the snapshot holds ranks `[1,2,3,3]`.
- [ ] **Step 10: Commit** `chore(engine): bump to @onryde/seazn-engine 4.0.0; adapt FinalPlace, BracketStage.entrants, firstLosses; re-derive ruling-270 ranks; rules checker at the bump`. The body lists the re-derived tests and the rulings.

---

## Task 3: The wire keeps `finalRanks: string[]` and gains `places` and `title`

**Rules:** none of the 17. This is the substrate for X-FR-4's API half. The title token `X-FR-4` goes on the regression test.

**Why (plan's call, for the owner):**
- `POST /api/v1/stages/{id}/complete` returns the engine's events as free-form objects (`openapi.ts:158`, `S.CompleteResult`, `events: object[]`).
- Passing 4.0.0's event through unchanged would silently turn every client's `finalRanks` from ids into objects: the bench (`tools/bench/lib/advance.ts:104,272,301`), the matrix (`tools/matrix/lib/driver/types.ts:75`, `observed.ts:63`, `scenarios/common.ts:825,1051`), and any integrator.
- An adapter at this genuine external boundary is the standard pattern (standing rule). The wire keeps `finalRanks` as ids in rank order, and adds `places` and `title`.

**Files:**
- Create: `apps/web/src/server/api-v1/stage-events.ts`.
- Modify:
  - `server/usecases/stages.ts` `completeStage` / `progressCompletedStage` (`:5683-5760`): map `result.events` through the adapter before returning.
  - `server/api-v1/schemas/`: a `StageCompletedEvent` zod schema inside `CompleteResult.events` (a union member, with every other event still free-form), then `openapi:gen`.
  - `tools/matrix/lib/driver/types.ts:75` and `tools/matrix/lib/observed.ts:63`: `places?` and `title?`, read by Task 15.
- Test: `apps/web/src/server/api-v1/__tests__/stage-events.test.ts` (unit); extend the complete-route test (grep `stages/[id]/complete` under `app/api/v1/stages/__tests__`).

**Interfaces:**
- Produces:
  - `type WirePlace = { entrant_id: string; rank: number }`.
  - `type WireTitle = { kind: "champion"; entrant_id: string } | { kind: "joint"; entrant_ids: [string, string] } | { kind: "vacant"; finalists: [string, string] }`.
  - `toWireEvents(events: readonly DivisionEvent[], title?: BracketTitle): Record<string, unknown>[]`. A `stage_completed` event becomes `{ type, stageId, finalRanks: string[] /* ids, rank order, ties by input order */, places: WirePlace[], title?: WireTitle }`, and every other event passes through unchanged.
  - `CompleteResult` carries `title?: BracketTitle` from `completeStageIfReady` (bracket kinds only), so the adapter can attach it.

- [ ] **Step 1: Failing tests.**
  - `X-FR-4 stage_completed keeps finalRanks: string[] in rank order and adds places` (Review Focus 5). On a shared-3rd 4-draw, `finalRanks` is 4 strings and `places` is `[1,2,3,3]` against the same ids. The expectation derives from `completeBracketStage`'s own `finalRanks` (R9).
  - `… a joint final carries title joint and places [1,1,3,3]`.
  - `… a table stage carries places with rank = position and no title`.
  - Empty case first: no events → `[]`.
  - The route test asserts the JSON body anchored on `"finalRanks":["`.
- [ ] **Step 2: Run FAIL**, **Step 3: Implement**, `openapi:gen` (only `CompleteResult` moves).
- [ ] **Step 4: Run PASS:** the two files, plus `VERIFY-ROOT t3-bench tools/bench/__tests__/advance.test.ts` (or the file that pins `compareFinalRanks`; grep it) and `tools/matrix/__tests__/observed*.test.ts`. They must stay green unchanged, which is the point. tsc, lint.
- [ ] **Step 5: Mutate:** emit the engine's `FinalPlace[]` as `finalRanks` → the bench test and `X-FR-4 …string[]…` red.
- [ ] **Step 6: Smoke** +1: `POST …/complete` on a 4-draw → `finalRanks` is a string array and `places` holds two rank-3 rows.
- [ ] **Step 7: Commit** `feat(api): stage_completed keeps finalRanks as ids and gains places and title (FinalPlace adapter)`.

## Task 4: The title — champion, joint winners, vacant — on every champion surface

**Rules:** X-FR-4 (the champion half: the title is recomputed under the current rule on every read).

**Gap:** Q4's read half. `bracketChampion` (`server/public-site/champion.ts:113-140`) returns one winner and `divisionChampion` (`:162-196`) one id. A joint or vacant final has no winner, so both answer null and every crown disappears, unannounced.

**Files:**
- Modify:
  - `apps/web/src/server/public-site/champion.ts`: `bracketChampion` → `bracketTitleOf`, and `divisionChampion` → `divisionTitle`. Keep the old names as thin wrappers ONLY if a caller outside this task's file list remains. None should; delete them.
  - `ChampionFixture` gains `joint_winners_at?: string | null` (V494, Task 12) and reads `outcome.kind`.
  - Every caller (scout sweep at pin, by behaviour; re-grep `divisionChampion\|bracketChampion` before editing):
    - `app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx:249,254` (one banner, one name) → renders joint / vacant;
    - `server/public-site/competition-hub.ts:614,665` (`championFixtureId`) and `:949,976` (row `champion` flag);
    - `server/public-site/competition-hub-schema.ts:270,349`: the wire gains `title` (a `DivisionTitle`, snake-cased), and keeps `championFixtureId` and the row `champion` bool (both joint rows `true`);
    - `components/public-site/matches-hub/knockout-tab.tsx:416` (banner from `championFixtureId`) → reads `title`;
    - `components/public-site/matches-hub/table-tab.tsx:130` (`.find(r => r.champion)` keeps only the first) → `.filter`;
    - the `unstable_cache` at `server/public-site/data.ts:1121` holds `championId` → it holds `title`. Bump its cache key, so a deploy never serves the old shape.
- Test: `apps/web/src/server/public-site/__tests__/champion.test.ts` (extend; keep its `CHANGED` pins), and `apps/web/src/server/public-site/__tests__/champion-title-engine-parity.test.ts` (new).

**Interfaces:**
- Produces:
  - `type DivisionTitle = { kind: "champion"; entrantId: string } | { kind: "joint"; entrantIds: [string, string] } | { kind: "vacant"; finalists: [string, string] }`. This is the engine's `BracketTitle` shape. A table stage's crown is `champion` only.
  - `bracketTitleOf(fixtures: readonly ChampionFixture[]): (DivisionTitle & { fixtureId: string }) | null`. It keeps today's rules (the latest-round settled final, a later owed final withholds) and adds two:
    - a final with `joint_winners_at` set and status `decided` → `joint`;
    - a final whose outcome kind is `double_walkover` (a departure, X-CH-3) → `vacant`.
  - `divisionTitle(stages, fixtures, standings): DivisionTitle | null`. For a table decisive stage it answers as today: `champion` from rank 1.
- Consumes: Task 12's V494 column (read as optional until then; a test fixture sets it).

- [ ] **Step 1: Failing tests.**
  - `champion.test.ts`, each `// differential: today null`:
    - `X-FR-4 a joint final crowns both finalists (joint)`;
    - `X-FR-4 a departure double walkover on the final is a vacant title`;
    - `X-FR-4 a vacant title reverses when the final is re-decided` (the same rows with the final re-decided, as Task 11's reversal leaves them, give `champion`).
    - Empty case first: no stages → null.
  - `champion-title-engine-parity.test.ts`, which derives from the engine (R9):
    - Build n = 2…32 brackets with the engine's `generateSingleElim`, under each of {champion, joint, vacant} × {Shared, Play-off}.
    - Play each to its final state as DB-shaped `ChampionFixture` rows.
    - Assert `bracketTitleOf(rows)` equals the engine's `bracketTitle(asBracketFixtures(rows))` for every case.
    - Assert `checked + skipped === 31 * 3 * 2` (= 186). Play-off at n = 2–3 is skipped by X-TP-5's refusal (2 × 3 = 6 skipped). The test computes `skipped` from that same rule, asserts `checked === 180`, and prints both.
- [ ] **Step 2: Run FAIL**, **Step 3: Implement**, then update the callers.
- [ ] **Step 4: Run PASS:** both files plus every caller's test (named after the grep), `competition-hub*.test.ts`, `table-tab*.test.tsx`. tsc.
- [ ] **Step 5: Mutate:**
  - (a) Drop the `double_walkover` arm → the vacant test reds.
  - (b) Drop the joint arm → the joint test and the parity sweep red.
- [ ] **Step 6: Commit** `feat(public): a bracket's title is champion, joint winners or vacant (X-FR-4 champion half)`.

## Task 5: Shared places on every surface (X-TP-3)

**Rules:** X-TP-3 ("on every surface: bracket, public page, hub, embed, `/present`, OG card, standings API, history").

**Files:**
- Create: `apps/web/src/lib/bracket-places.ts` (pure; client-safe, with no `server-only` import).
- Modify: every reader the by-behaviour sweep found (scout, at pin). Readers marked "table-only, safe" are only listed in the test's count, not edited: `org-posts.ts` (TABLE_KINDS), `slideshow-data.ts:422` (organiser deck), `stage-seeding.ts:88`, `qualification-view.ts:437`, and the snapshot-exists checks `entrants.ts:650` / `stage-rules.ts:300`.
  - `server/slideshow-data.ts:721` `buildPublicDivisionSlides` (`/present`): reads every snapshot, bracket included; rank is `r.rank ?? i + 1` (`:195`). Read the stored rank and drop the index fallback for a bracket kind (a guard: a bracket row without a rank throws). `components/v2/slideshow.tsx:397` keys rows `r.rank + r.name`, so key on the entrant id instead.
  - `app/embed/divisions/[id]/[widget]/page.tsx:209-218` → `components/public-site/standings-table.tsx:146,150`: leader is `rank === 1`, and the medal colour comes from 1/2/3. Joint: two gold leaders (correct). Shared 3rd: two bronze (correct). Vacant: no gold row and no leader. Assert all three, and label via `bracketPlaceLabels`.
  - `app/(public)/live/…/opengraph-image.tsx:34` + `server/og/model.ts:110-119`: the leader is index 0 of `data.standings[0]`, so joint flags only one and vacant flags a 2nd as leader. For a bracket kind it reads Task 4's `divisionTitle`.
  - `server/usecases/exports.ts:473-484` + `exports-standings.ts:60-68`: prints rankText through `bracketPlaceLabels` (a shared place is marked).
  - `server/usecases/stages.ts:6173` `getStandings` → `/api/v1/stages/{id}/standings` (`level-rank.ts:19`), and `usecases/public.ts:564` → the public standings route: pass the ranks through unchanged. These are pinned in the test (duplicates visible, never renumbered); there is no code change.
  - Progression from a bracket snapshot: `stages.ts:5988` `tablesForCompletedStage` → `resolveProgression` (`:6071`), and `stage-seeding.ts:265` `sourceStandingsTables` (setup path; `standingsHash` `:236`). The engine's `rank_range` resolves by position, and a cut through a shared 3rd sets `tieUnbroken` (`shared_place`). Pin it: a `rankRange 1–3` from a Shared 4-draw surfaces the tie-break notice on the proposal, never a silent pick.
  - `server/usecases/officials.ts:842-859` `resolveOfficialSourcing`: rank lookups go through `@seazn/engine/officials` (not read). Add one case: a source picking rank 3 from a Shared bracket returns both or refuses by name. Its `s.status = 'completed'` check (`:844`) can never match: V210 allows `pending|active|complete`. That is a live defect found by this sweep, and it is fixed here (`complete`) with its own failing test, because it is in this task's blast radius.
- UI per Task 1 items 2 and 3 (the owner's picks).
- Copy, in 4 locales plus gen-keys:
  - `place.shared` "{place} (shared)" — or the "=" form, per the pick;
  - `title.joint` "Joint winners: {a} and {b}";
  - `title.vacant` "Title vacant";
  - `title.vacant.reason` "Both finalists withdrew".
- Test:
  - `apps/web/src/lib/__tests__/bracket-places.test.ts`;
  - `apps/web/src/server/__tests__/shared-place-surfaces.test.ts` (DB: one shared-3rd bracket read through every server reader);
  - the component tests the readers' UI owns (named after the sweep);
  - e2e describe `X-TP-3 every surface shows two 3rds`.

**Interfaces:**
- Produces:
  - `type PlaceLabel = { rank: number; shared: boolean; ordinalKey: MessageKey }`.
  - `bracketPlaceLabels(rows: readonly { entrantId: string; rank?: number }[]): Map<string, PlaceLabel>`. A rank held by two rows gets `shared: true`. It throws a named `Error` on a row without a rank, or on three rows sharing one rank. That is an assumption made a guard; it mirrors the engine's `assertBracketPlaces`.
  - `isBracketPlacement(stageKind: string): boolean` = `BRACKET_KINDS.has(kind)` (champion.ts's set).
- Consumes: Task 4's `divisionTitle`.

- [ ] **Step 1: Driving test first** (`shared-place-surfaces.test.ts`, DB, badminton).
  - Build one 8-draw and complete it Shared; build a second and complete it Play-off.
  - Then, for EACH server reader the sweep listed, read the bracket's places through the reader's own exported function, and assert: the two semi-final losers both carry rank 3 and no row carries rank 4 (Shared); ranks 3 and 4 (Play-off).
  - The expected sets come from the engine's `completeBracketStage` over the same rows (R9).
  - The test's last `it` asserts that the readers checked equal the sweep's list length (> 0). That makes it a counted sweep, and a reader dropped from the list reds it.
- [ ] **Step 2: Unit tests** for `bracketPlaceLabels`:
  - empty first (`[]` → empty map);
  - strict ranks;
  - one shared 3rd;
  - joint 1st;
  - vacant (two at rank 2);
  - three at rank 3 throws.
- [ ] **Step 3: Run FAIL**, **Step 4: Implement** the readers (server first, then UI per the picks; `frontend-design` skill).
- [ ] **Step 5: Verify UI** at 1280, 320 and 768 on the public division page, the hub knockout tab, the embed bracket and standings widgets, `/present`, and the bracket panel. Use a realistic 43-character entrant name. Screenshots go to `:8765` with a per-screen verdict, with no horizontal scroll, and the control-set diff 320 vs 1280.
- [ ] **Step 6: Run PASS:** the Files' tests plus every reader's existing suite (named). tsc. Locale + gen-keys.
- [ ] **Step 7: Mutate:** make `bracketPlaceLabels` number by index (i + 1) → the surfaces test reds on every reader that uses it.
- [ ] **Step 8: E2E + smoke.**
  - E2E: describe `X-TP-3 every surface shows two 3rds`. It drives the public division page, hub, embed, `/present` and the OG image route for one Shared bracket; the OG check is anchored on `="`.
  - Smoke +1: `GET` public standings JSON → two rank-3 rows.
- [ ] **Step 9: Commit** `feat(public): shared places read the same on every surface (X-TP-3)`.

## Task 6: Q8 history — finished brackets re-rank to a shared 3rd (V496, LOUD)

**Rules:** X-FR-5; X-FR-4 (the history half).

**Finding (design §11 "derived versus stored"):** BOTH apply.
- **Stored:** a completed bracket's ranks live in `standings_snapshots.rows` (pool null), written once at completion (`engine-db/competition.ts:1063-1070`, `writeSnapshot` `:680-698`). They are read by every snapshot reader in Task 5, and by `stage-seeding.ts` for progression.
- **Derived:** the champion is derived from fixtures on read (`champion.ts`), so it recomputes automatically. 4.0.0 changes no champion for history: no final was joint or vacant before W4.
- So the one-off LOUD migration is owed for the snapshot rows only.

**Files:**
- Create: `db/migration/deltas/V496__w4_shared_third_history.sql` (DATA CHANGE, LOUD).
- Test: `apps/web/src/server/__tests__/w4b-migration.test.ts` (new; it also holds V494/V495's tests).

**Interfaces:** none produced. The migration's shape (SQL), for an algorithm the tests do not determine on their own:
```
-- for each stage s: kind = 'knockout', status = 'complete', a standings_snapshots row (s.id, pool null),
--   no fixture of s with third_place = true (V368) or ext_key like '%-3p',
--   SF = the two non-third-place fixtures at round_no = (max non-3p round_no) - 1, both settled with a seated loser
--        (outcome kind 'win' with loser, or 'award' with a seated loser — never 'double_walkover', never a bye),
--   the snapshot holds exactly one row at rank 3 and one at rank 4, and those two entrantIds are SF's two losers;
-- set the rank-4 row's "rank" to 3 inside rows (jsonb_set over the array element), leave previous_rows,
-- computed_through_seq and every other row untouched. Count first (raise notice '<n> knockout stages re-ranked to a
-- shared 3rd (ruling 270)'), write in one statement, idempotent (a second run finds no rank-4 SF loser).
```

- [ ] **Step 1: Failing tests** (`w4b-migration.test.ts`, DB). Each case is seeded through the REAL 3.x shape: completion rows written by SQL exactly as `writeSnapshot` stored them before the bump (strict 1..n).
  - `X-FR-5 a finished 8-draw with no third-place match re-ranks its semi-final losers to a shared 3rd`. After V496, the rows' ranks equal what 4.0.0's `completeBracketStage` gives on the same fixtures (R9: the engine is the oracle, never a typed list).
  - `X-FR-5 a played third-place match keeps 3rd and 4th`.
  - `X-FR-5 n=3 (one real semi-final) is untouched`.
  - `X-FR-5 a semi-final double walkover is untouched` (the engine's strict-block call).
  - `X-FR-5 a table stage, a stepladder, a page playoff and a double-elim are untouched` (counted, 4).
  - `X-FR-5 a second run changes 0 rows`.
  - `X-FR-4 after V496 the champion and every Task 5 reader agree with a fresh completion` (one bracket, read through `divisionTitle` and the public standings reader).
  - Sequence: a stage whose snapshot was already re-ranked by a post-bump completion is skipped (the empty arm).
- [ ] **Step 2: Run FAIL** (file missing), **Step 3: Implement** the delta, quoting Task 0's count 1 in its header.
- [ ] **Step 4: Run PASS:** the file plus `w4-migration.test.ts` (app A; it reads deltas by glob, so a numbering clash shows here) and `placement-snapshots.test.ts`.
- [ ] **Step 5: Mutate:**
  - (a) Drop the "no third-place fixture" predicate → the played-play-off test reds.
  - (b) Drop the "both are SF losers" predicate → add and red `X-FR-5 a corrupted snapshot whose rank-4 row is not a semi-final loser is untouched`.
- [ ] **Step 6: Post-deploy check (stg, after the owner deploys).** Read Task 0's count-1 stages: no rank-4 row remains, and each public division page shows two 3rds. Record what you SAW, on `:8765`.
- [ ] **Step 7: Commit** `fix(w4): finished knockouts re-rank to a shared 3rd (ruling 270; V496, LOUD)`. The body says DATA CHANGE and quotes the counts.

---

## Task 7: The plate takes `firstLosses` — wire, template, builder, estimate, stored progressions (V495)

**Rules:** X-PL-6.

**Gaps:** PL-1 (q = 4 drops first losses above 12 entrants), and the builder half of FX-G14.

**Files:**
- Modify:
  - `server/api-v1/schemas/`: a `FirstLossesTakeS = z.object({ kind: z.literal("firstLosses") }).strict()` member of the take union. The compile-time tie (`:1037-1040`) now holds both ways. Then `openapi:gen`.
  - `lib/format-templates.ts:283-296`: `ko_plate` builds `take: [{ kind: "firstLosses" }]` and ignores `qualified`.
  - `lib/division-builder/format-choice.ts`: `formatStagesFor` (`:80-91`), the comment at `:33-35`, and `:146,174` (no hidden `qualified: 4` for `ko_plate`; `qualifying_main` keeps its 4).
  - `lib/division-builder/format-estimate.ts:44-46,107`: the plate's estimated field is `estimatePlateField(n)`.
  - `lib/slot-label.ts`: a `first_loss` descriptor → `slot.first_loss` "First-match loser {n}", in 4 locales plus gen-keys.
  - `lib/format-size-gates.ts` `stageGraphSizeRefusal` (app A): it recognises a `firstLosses` stage, as it does `roundLosers`.
  - `template-gallery.tsx:128` and `tools/matrix/lib/scenarios/advance.ts:71-102`: replace Task 2's throws with real arms.
- Create: `db/migration/deltas/V495__w4_plate_first_losses.sql` (DATA CHANGE, LOUD). For every stage whose progression's take is exactly `[{ kind: "roundLosers", round: 1, count: q }]` and whose fixtures are all TBD: no seated entrant, no result, nothing started (`fixtureStartedSql`'s SQL arms, inlined).
  - Rewrite the take to `[{ kind: "firstLosses" }]`.
  - Delete those placeholder fixtures (count first, one block, idempotent).
  - A seated or played plate keeps `roundLosers`, which 4.0.0 still resolves. Quote Task 0 count 2.
- Test: `lib/__tests__/format-templates.test.ts` (extend), `lib/division-builder/__tests__/format-estimate.test.ts` (extend), `lib/__tests__/slot-label.test.ts` (extend), `server/api-v1/__tests__/progression-schema.test.ts` (or the file that pins `ProgressionSchema`; grep `RoundLosersTakeS`), `server/__tests__/w4b-migration.test.ts` (V495 cases).

**Interfaces:**
- Produces:
  - `estimatePlateField(n: number): number`. It is the rulebook count under "better seed wins", for display only: `(2n − S) / 2` round-1 losers, plus one for every round-2 line whose two seats are both bye holders, counted from the RB4-D1 fold. The engine plan's T9 sweep derives the same count, so the test reuses that derivation, not this function.
  - `slot.first_loss`.
- Consumes: the engine's `TakeRule.firstLosses`, `SlotDescriptor.first_loss`.

- [ ] **Step 1: Failing tests.**
  - `X-PL-6 ko_plate's plate takes every eligible first loss: no count, no hidden Top N`. The template pins `take: [{ kind: "firstLosses" }]`, and `formatStagesFor("ko_plate", knobs)` sends no `qualified` for the plate, whatever the knob says. `// differential: today roundLosers count 4`.
  - `X-PL-6 the estimate counts the first-loss field, n = 4…131 counted`. It holds for n = 5, 6, 7, 9, 13, 17, 33–35, 65–67 and 129–131 named. Above 12, the estimate exceeds 4 (PL-1). The expected count derives from the fold (RB4-D1), independently of `estimatePlateField`.
  - The schema accepts `{ kind: "firstLosses" }` and refuses `{ kind: "firstLosses", count: 4 }` (strict).
  - V495: an all-TBD plate is rewritten and its placeholders are gone; a seated plate is untouched; a second run changes 0 rows.
  - Empty case first: `estimatePlateField(0)` and `(1)` are 0.
- [ ] **Step 2: Run FAIL**, **Step 3: Implement**, `openapi:gen` (only the take union moves).
- [ ] **Step 4: Run PASS:** the Files' tests plus `format-picker*.test.tsx`, `format-size-gates.test.ts` (app A), and `w4-migration.test.ts`. `VERIFY-ROOT t7-matrix` covers the advance scenario's test (grep `advance.ts`'s spec). tsc both. Locale + gen-keys.
- [ ] **Step 5: Mutate:** restore `count: q` in the template → `X-PL-6 …no count…` reds.
- [ ] **Step 6: Commit** `feat(w4): the plate takes every first loss — firstLosses on the wire, template and estimate; V495 rewrites unplayed plates (PL-1, X-PL-6)`.

## Task 8: The plate is proposed after round 2, drawn at its field size, and completes for every offered n (FX-G14 close, PL-3, T8-b)

**Rules:** X-PL-2, X-PL-5, X-PL-7, X-PL-8, X-SD-11, X-LE-14.

**Gaps:**
- FX-G14 (409 at every n with byes).
- PL-3 (the plate waits for the main final).
- T8-b: the allowlist entry at `bracket-placement-sweep.test.ts:133-137` freezes the n=5 refusal (app A widened its count, Task 24; this task deletes it).

**Files:**
- Create: `apps/web/src/server/usecases/plate-field.ts`.
- Modify:
  - `server/usecases/stages.ts`:
    - the day-one TBD generator for `timing: "setup"` (`:4464-4600`) generates NO plate fixtures for a `firstLosses` take: its size is unknown until round 2;
    - `computeSeedProposal` (`:6330`) resolves `first_loss` slots from `firstLossField(rows)`;
    - `confirmSeedProposal` (`:6558`) generates the plate's bracket at the field's size when the destination has no fixtures, then fills it;
    - `loadBracketFixtures` (`:5592-5640`) also returns the `BracketFixtureRow` fields `firstLossField` reads (`id`, `status`, `home`, `away`, `winner`, `walkedOver`, `bracket`, `thirdPlace`).
  - `server/usecases/scoring.ts` (the decided-result hook beside `:1136-1145`): after a main-draw result is decided or corrected, call `maybeProposePlate`.
  - `lib/knockout-refusals.ts`: add `PLATE_FIELD_TOO_SMALL`, 422, "Not enough first-match losers for a plate." This is the X-PL-2 named outcome. It is a COMPLETION outcome, not a throw to the user: the plate stage completes with it.
  - `server/usecases/__tests__/bracket-placement-sweep.test.ts`: delete the `ko_plate n=5` KNOWN_REFUSALS entry (`:133-137` at pin) and its audit literal (`:319-337`). Seed every n the builder offers for ko_plate (app A's gate: n ≥ 4) through the real usecases.
  - The plate stage card per Task 1 items 5 and 6.
- Test:
  - `apps/web/src/server/usecases/__tests__/plate-first-loss.test.ts` (new);
  - `bracket-placement-sweep.test.ts` (T8-b);
  - `apps/web/src/server/usecases/__tests__/plate-first-loss-sweep.test.ts` (new; X-PL-8's counted sweep);
  - e2e describes.

**Interfaces:**
- Produces:
  - `plateFieldOf(tx: Tx, mainStageId: string): Promise<FirstLossField>`. It wraps `firstLossField(await loadBracketFixtureRows(tx, mainStageId))`.
  - `maybeProposePlate(tx: Tx, auth: AuthCtx, mainStageId: string): Promise<{ proposed: boolean; outcome?: "too_small" }>`. Its order:
    - No dependent `firstLosses` stage → `{ proposed: false }`.
    - Field incomplete → `{ proposed: false }`.
    - Complete with `losers.length < 2` → complete the plate stage with the named outcome. That means a `stage_completed` with empty `finalRanks`, a `plate_too_small` desk notice, and the stage reading `complete`; never an empty success.
    - Complete with ≥ 2 → `computeSeedProposal` (draft). With `auto_progress` on, `confirmSeedProposal` follows immediately.
    - A field that changes after a proposal (a correction) stales it and re-proposes (`markDependentSeedProposalsStale`, app A's `includeConfirmed` before the plate starts).
  - The plate draw (X-SD-11, RB4-D10): seeds are the entrants' MAIN-DRAW seeds on the fold; the unseeded are ordered by `knockoutDrawOrder(plateStageId, …)`, the plate stage's own stored seed (app A).
- Consumes:
  - the engine's `firstLossField`;
  - app A's `knockoutDrawOrder`, `readStageDrawSeed`, `markDependentSeedProposalsStale(…, { includeConfirmed })`, `stageHasStarted`;
  - Task 7's template.

- [ ] **Step 1: Driving tests (regression)** in `plate-first-loss.test.ts` (DB, badminton, then football by `sportFor`). Each asserts SEATS:
  - `X-PL-5 the plate is proposed after round 2, never waiting for the final`. ko_plate n=5: once R1 and the bye holders' R2 lines are decided, a draft proposal exists while the main semi-finals and final are still scheduled. `// differential: today nothing until the final, then 409`.
  - `X-PL-5 n=5 plate field = [e5, e3]`. The expected membership is the engine plan's own derivation (RB4-P1 + the RB4-D1 fold): 4 v 5 in R1, then bye holders 2 v 3 meet in R2. Assert the plate's two seats after confirm.
  - `X-PL-7 with auto_progress on the plate is confirmed and drawn automatically`, and `… with it off the proposal waits for the organiser`.
  - `X-PL-7 a corrected round-2 result re-proposes the plate (first_loss_field_changed)` (Review Focus 2).
  - `X-PL-2 a plate field under 2 completes the plate with "Not enough first-match losers for a plate"`. n=4 with one R1 walkover and one R1 withdrawal: the field is 0 (X-PL-4). n=4 with one walkover: the field is 1. The plate stage is `complete`, has no fixtures, and the desk notice names the outcome. Then `completeStage` on the division never 409s.
  - `X-SD-11 the plate draw: main-draw seeds on the fold, the rest by the plate's own draw seed`, against the engine's `generateSingleElim` fed the expected order (R9). Do the same for a fed main draw: qualifying_main's main draw by qualifying rank on the fold (app A's X-QM-3, re-asserted under the X-SD-11 token).
  - `X-LE-14 a late entrant placed by the bye feeds the plate with their first loss`. ko_plate n=7: app A's Add late player takes the bye (case 1), the late entrant loses R1, and they are in the plate's seats.
  - Sequence:
    - a second `maybeProposePlate` with no change is a no-op;
    - empty: a main draw with no fixtures → `{ proposed: false }`;
    - after a withdrawal: a first-loss withdrawal is excluded (X-PL-4), and the next eligible first loss still enters;
    - after an Undo of an unrelated schedule edit: the proposal stands.
- [ ] **Step 2: X-PL-8 counted sweep** `plate-first-loss-sweep.test.ts`, which reuses the placement sweep's rig.
  - For every n the builder offers for ko_plate (4 … 33, plus 65–67 and 129–131 at a sampled kind), play the main draw with better-seed-wins through the real usecases (createCompetition, createDivision, createEntrants, createStages, startDivision, generateStageFixtures, scoreEvent).
  - Let the plate propose, confirm and play out, then complete both stages.
  - Assert per n: the plate's seated entrants equal the fold-derived first-loss set (same derivation as Task 7), and the division completes with no 409.
  - Named `it.each` cases: n = 5, 6, 7, 9, 17. The last `it` asserts `checked.size` equals the n list's length exactly (a `-t` slice reds it).
  - Header: "A coverage sweep: it builds nothing. Expected values come from RB4-P1 and the fold, never from the code under test."
- [ ] **Step 3: T8-b** in `bracket-placement-sweep.test.ts`. Delete the `ko_plate n=5` entry. Its audit test (`accepts exactly what the sweep meets today`) changes count by the removed cases, and the drift test's literal goes too. Re-run: zero ko_plate refusals.
- [ ] **Step 4: Run FAIL** (Steps 1–3 on the Task 7 tree), **Step 5: Implement.**
- [ ] **Step 6: UI** (after Task 1 items 5 and 6): the plate card before its field, and the too-small outcome. Use the `frontend-design` skill; 1280/320/768; copy in 4 locales plus gen-keys:
  - `plate.drawsAfterRound2` "Plate draws after round 2 — {done} of {total} first matches decided";
  - `plate.tooSmall` "Not enough first-match losers for a plate".
- [ ] **Step 7: Run PASS:** the three files plus `stage-progression.test.ts`, `knockout-source-correction.test.ts` (app A), `seed-confirm-undo.test.ts` (app A; the plate confirm still writes the barrier), `knockout-late-entry.test.ts` (app A), and `format-size-gates.test.ts`. tsc. Locale + gen-keys.
- [ ] **Step 8: Mutate:**
  - (a) Propose only on main-final completion (today's trigger) → `X-PL-5 …never waiting…` reds.
  - (b) Treat a field of 1 as a plate → `X-PL-2` reds.
  - (c) Skip the stale-and-re-propose → `X-PL-7 …corrected…` reds.
  - (d) Draw the plate's unseeded by main-draw position → `X-SD-11` reds.
- [ ] **Step 9: E2E + smoke.**
  - E2E: describe `X-PL-5 the plate draws after round 2` at n=5, and `X-PL-8 the plate completes at n=6, 7, 9`, one test each.
  - Smoke +2: n=5 plate proposed before the final; a too-small plate completes by name.
- [ ] **Step 10: Commit** `feat(w4): the plate is proposed after round 2, drawn at its field, and completes for every offered n (FX-G14, PL-3, T8-b; X-PL-2/5/7/8, X-SD-11, X-LE-14)`.

---

## Task 9: "Third place: Shared / Play-off match" — the server half (X-TP-1, X-TP-2, X-TP-6, X-TP-7)

**Rules:** X-TP-1, X-TP-2, X-TP-6, X-TP-7.

**Gap:** 3P-1 (API-only `StageConfig.thirdPlace`, `api-v1/schemas/`).

**Files:**
- Create: `apps/web/src/lib/third-place.ts`.
- Modify:
  - `server/api-v1/schemas/generation.ts`: `PatchSwissStage` (`app/api/v1/stages/[id]/route.ts:29-36`) becomes `PatchStage = z.union([PatchSwissStage, PatchKnockoutStage])`, with `PatchKnockoutStage = z.object({ thirdPlace: z.enum(["shared", "playoff"]) }).strict()`. Then `openapi:gen`.
  - `app/api/v1/stages/[id]/route.ts`: PATCH dispatches on the stage's kind; a mismatched body is a named 422.
  - `server/usecases/stages.ts`:
    - `patchKnockoutStage(auth, stageId, body)`: under the `division:` lock; refused once `stageHasStarted` (app A); writes `config.thirdPlace` (true = Play-off); regenerates before Start through app A's reconcile (`reconcileRootBracket` / `regenerateStageInTx`) when fixtures exist.
    - Generate maps the engine's `third_place_needs_two_semis` to `KO_THIRD_PLACE_TOO_FEW`.
  - `server/usecases/withdrawal.ts` (`:426-440`): on a `-3p` line with both sides departed, write the departure double walkover (X-TP-7, superseding X-DW-3's hold for that match). One side departed stays a walkover.
  - `lib/knockout-refusals.ts`:
    - `KO_THIRD_PLACE_TOO_FEW`, 422, "A third-place match needs at least 4 entrants. Use Shared third place instead." with `entrants`;
    - `THIRD_PLACE_LOCKED`, 409, "Third place can't change once play has started."
- Test:
  - `apps/web/src/lib/__tests__/third-place.test.ts`;
  - `apps/web/src/server/usecases/__tests__/third-place-setting.test.ts`;
  - `apps/web/src/app/api/v1/stages/[id]/__tests__/patch-knockout.test.ts`.

**Interfaces:**
- Produces:
  - `type ThirdPlaceMode = "shared" | "playoff"`.
  - `thirdPlaceModeOf(cfg: { thirdPlace?: unknown } | null): ThirdPlaceMode` (true → playoff, anything else → shared: X-TP-2's one default).
  - `thirdPlaceOffered(n: number): boolean` (n ≥ 4, X-TP-1). The builder and the server read this ONE predicate.
  - `patchKnockoutStage(auth: AuthCtx, stageId: string, body: { thirdPlace: ThirdPlaceMode }): Promise<{ stage_id: string; thirdPlace: ThirdPlaceMode; regenerated: boolean }>`.
- Consumes: app A's `stageHasStarted`, `reconcileRootBracket`, `regenerateStageInTx`, `knockoutRefusal`.

- [ ] **Step 1: Failing tests.**
  - `X-TP-2 every knockout stage reads Shared by default in every sport`. Counted over `builtinModules` × the knockout-bearing templates (`knockout`, `league_ko`, `groups_ko`, `swiss_knockout`, `ko_plate` ×2 stages, `qualifying_main` ×2 stages): `thirdPlaceModeOf(stage.config)` is `shared`, and the count equals the product.
  - `X-TP-6 the setting is editable until the stage starts, then read-only`. PATCH to playoff before Start regenerates with exactly one `-3p` line fed by the two semi-finals (assert its `homeFrom`/`awayFrom` against the engine's generator). After a Match Day call (X-LE-9's started), PATCH → `THIRD_PLACE_LOCKED`.
  - `X-TP-1 third place is not offered below 4`: `thirdPlaceOffered(3)` is false, PATCH at n=3 → `KO_THIRD_PLACE_TOO_FEW`. The n=3 Shared stage ranks its single semi-final loser 3rd alone (RB4-E5, from the Rank places table).
  - `X-TP-1 a play-off stage that shrinks to 3 refuses by name and offers Shared` (Review Focus 3). Playoff at n=4, one withdrawal before Start, then Generate → 422 `KO_THIRD_PLACE_TOO_FEW` with `entrants: 3`, never a 500. Then PATCH shared → Generate succeeds.
  - `X-TP-7 a third-place play-off with one side out is a walkover; with both out, 3rd is vacant and both rank 4th`. Both semi-final losers withdraw before the `-3p`: the stage completes 1, 2, 4, 4 (Rank places table). `// differential: today the -3p waits for settle`.
  - Sequence:
    - a second identical PATCH is a no-op (`regenerated: false`);
    - an empty body → 422;
    - PATCH on a league stage → named 422;
    - chess and badminton.
- [ ] **Step 2: Run FAIL**, **Step 3: Implement**, `openapi:gen`.
- [ ] **Step 4: Run PASS:** the three files plus `bracket-reconcile.test.ts` (app A), `withdrawal-w2b.test.ts`, `double-walkover-next-match.test.ts`, `bracket-bump-w4.test.ts`. tsc. Locale + gen-keys.
- [ ] **Step 5: Mutate:**
  - (a) `thirdPlaceOffered` → `return true` → `X-TP-1 …not offered…` reds.
  - (b) Drop the started check → `X-TP-6` reds.
  - (c) Keep X-DW-3's hold on `-3p` → `X-TP-7` reds.
- [ ] **Step 6: Smoke** +2: PATCH playoff → one `-3p`; both play-off sides withdraw → ranks 1, 2, 4, 4.
- [ ] **Step 7: Commit** `feat(w4): Third place is Shared or Play-off on every knockout stage, editable until Start (3P-1; X-TP-1/2/6/7)`.

## Task 10: The third-place control in the builder and the stage settings (UI)

**Rules:** X-TP-2 (UI half), X-TP-1 (hidden below 4). These are extra tokens on the tests below; the server proofs are Task 9's.

**Files:**
- `components/v2/format-picker.tsx` and `lib/division-builder/format-choice.ts`:
  - `FormatKnobValues` gains `thirdPlace: ThirdPlaceMode`;
  - `FormatKnobsShown` gains `thirdPlace: boolean`, true for every template with a knockout stage when `thirdPlaceOffered(n)` for that stage's n (root: `plan.entrants`; fed: the Top N knob);
  - `formatStagesFor` writes `config.thirdPlace` on every knockout stage.
- The stage settings, where the stage's other settings live (re-pin `components/v2/stages-panel.tsx`'s stage card settings; grep `patchSwissStage(` in components for the Swiss twin): the control, read-only once started, with `THIRD_PLACE_LOCKED`'s copy.
- The owner's Task 1 item 1 pick, with the item 7 recovery on the refusal.
- Copy in 4 locales plus gen-keys:
  - `thirdPlace.label` "Third place";
  - `thirdPlace.shared` "Shared";
  - `thirdPlace.playoff` "Play-off match";
  - `thirdPlace.hiddenBelow4` "Needs at least 4 entrants";
  - `thirdPlace.useShared` "Use Shared".
- Tests: `components/v2/__tests__/format-picker-third-place.test.tsx`, `components/v2/__tests__/stages-panel-third-place.test.tsx`, `lib/division-builder/__tests__/format-choice.test.ts` (extend).

- [ ] **Step 1:** Run the `frontend-design` skill; build the picked layout.
- [ ] **Step 2: Failing tests:**
  - `X-TP-2 the builder sends thirdPlace on every knockout stage of the format` (each template above, counted);
  - `X-TP-1 the control is hidden at 3 entrants and shown at 4` (`formatKnobsShown` table; empty case first: 0 entrants);
  - `X-TP-6 the stage settings show the control read-only once started`.
  - Anchor markup assertions on `="`, and `\s…hidden"` for phone classes (AGENTS.md: `/\bmd:hidden\b/` matches `max-md:hidden`).
- [ ] **Step 3: Implement, Run PASS** (the three files plus `division-builder*.test.tsx`), **Mutate** `thirdPlace` out of `formatStagesFor` → the builder test reds.
- [ ] **Step 4: Verify** at 1280, 320 and 768, in the builder and the stage settings. Screenshots go to `:8765`; no horizontal scroll; control-set diff 320 vs 1280; `mobile.spec.ts` scans kept true.
- [ ] **Step 5: E2E:** describe `X-TP-2 the organiser picks Play-off match in the builder and the bracket holds a third-place match`. Also: builder → Start → play the semi-finals → the `-3p` tile exists; play it → 3rd and 4th on the public page.
- [ ] **Step 6: Commit** `feat(w4): the third-place control in the builder and the stage settings (3P-1 UI)`.

---

## Task 11: Both finalists out — the title is vacant automatically, and reverses (X-CH-3; X-WD-4 amended)

**Rules:** X-CH-3.

**Gap:** WD-CASC's vacant half. Today a final with both seated finalists departed "stays open for W4's vacant title, and nothing is written" (`stages.ts:5340-5342`; `withdrawal.ts:435-440`, X-WD-4 sends a final to settle).

**Files:**
- Modify:
  - `server/usecases/withdrawal.ts:414-470`: when the line feeds no next match AND it is the deciding final (`is_final`, not `third_place`), and both seated sides are in `DEPARTED_STATUSES`, write the departure double walkover through `writeDepartedSeat` (no event, as X-WD-4 writes one elsewhere).
  - `server/usecases/stages.ts:5330-5345`: the same for the generator-side departure write.
  - `server/engine-db/fed-seats.ts:486-500`: a departure double walkover on a FINAL is revivable. Reinstating one finalist re-reads the final as a walkover to them (X-CH-2); reinstating both re-opens it `scheduled`.
  - `server/usecases/entrants.ts` (the Reinstate branch, `:1009-1046`): call `reviveVacantFinal` BEFORE app A's knockout admitter. A finalist's seat is still theirs, so this reverses a departure write and does not place anyone (the X-CH-3 exception to ruling 271; see "Decisions" 3).
  - `server/engine-db/competition.ts` completion: a vacant final completes (both finalists are in `lost` already, `:1018-1022`). When a reversal lands on a COMPLETE stage, `reviveVacantFinal` rewrites that stage's placement snapshot in the same transaction (re-runs the bracket completion write) and leaves the stage `complete`. A stage that seeded another from these ranks is refused by name instead (`VACANT_TITLE_ALREADY_SEEDED`, 409, "This result already seeded the next stage. Correct it there first.").
  - `lib/double-walkover-next-match.ts` and `lib/bracket-next-match.ts` (X-DW-3's predicate): unchanged for the CONSOLE path. A recorded double walkover on a final stays refused; only the departure path writes one.
- Test: `apps/web/src/server/usecases/__tests__/vacant-title.test.ts` (new).

**Interfaces:**
- Produces: `reviveVacantFinal(tx: Tx, entrantId: string): Promise<{ fixtureId: string; now: "walkover" | "scheduled" } | null>` in `fed-seats.ts`. Null when the entrant holds no seat in a departure-double-walkover final.
- Consumes: `writeDepartedSeat`, `DEPARTED_STATUSES`, Task 4's `divisionTitle`, the engine's `bracketTitle`.

- [ ] **Step 1: Driving tests (regression)** (DB; badminton individual and badminton doubles (a pair), then football):
  - `X-CH-3 both finalists withdraw: the title is vacant automatically, both rank 2nd, nobody 1st`. Both finalists withdraw, one after the other. The final reads a double walkover. The stage completes with places `[2,2,3,3,…]` (Rank places). `divisionTitle` is `vacant`, the public banner says so, and no settle is asked. `// differential: today the final waits for settle`.
  - `X-CH-3 a disqualification counts as out` (one withdraws, one is DQ'd).
  - `X-CH-3 reinstating one finalist reverses it: a walkover to them, champion` (X-CH-2's shape).
  - `X-CH-3 reinstating both re-opens the final`.
  - `X-CH-3 a reversal after the stage completed re-ranks its snapshot`.
  - `X-CH-3 the console's double walkover on a final is still refused` (X-DW-3 holds for a recorded one; the negative pair).
  - Sequence:
    - the second withdrawal is the trigger, so a single withdrawal leaves a walkover (X-CH-2);
    - empty: a final with one seat TBD and the seated finalist withdrawing stays X-WD-3's dead-seat walkover.
- [ ] **Step 2: Run FAIL**, **Step 3: Implement**, **Step 4: Run PASS:** the file plus `withdrawal-w2b.test.ts` (re-derive the "final goes to settle" expectations with the X-CH-3 citation; class 4), `withdrawal-table-double-walkover.test.ts`, `knockout-late-arrival.test.ts` (app A: Reinstate of a NON-finalist still waits), `bracket-complete-guard.test.ts`, `double-walkover-seating.test.ts`. tsc. Locale + gen-keys for `VACANT_TITLE_ALREADY_SEEDED`.
- [ ] **Step 5: Mutate:**
  - (a) Drop the `is_final` scope (a `-3p` with both out is Task 9's) → add and red `X-CH-3 only the deciding final goes vacant`.
  - (b) Drop the revival → the reinstate test reds.
- [ ] **Step 6: E2E + smoke.**
  - E2E: describe `X-CH-3 both finalists withdraw and the title reads vacant` (the desk withdraws both; the public banner reads "Title vacant").
  - Smoke +1: both finalists withdrawn → title vacant.
- [ ] **Step 7: Commit** `feat(w4): both finalists out leaves the title vacant, reversed by Reinstate (WD-CASC vacant half; X-CH-3)`.
- [ ] **Step 8: X-WD-4 amendment text, for Task 19.** Write to `$S/x-wd-4.md`. The proposed text (plan's call; the owner checks it at the PR review):

  > "When both sides of a fixture have withdrawn, the fixture is a double walkover (X-DW-*); a final goes to settle (X-DW-3), except the deciding final, whose title is then vacant (X-CH-3), and a third-place play-off, whose 3rd is then vacant (X-TP-7) (rulings 267 and 274)."

  Its citation gains `; amended by rulings 267 and 274 (2026-11-04, W4 rulebook RB4-C3, RB4-T6)`.

## Task 12: "Declare joint winners" on an unplayed final — server, storage and the completion guard (X-CH-4, X-CH-6) — V494

**Rules:** X-CH-4, X-CH-6.

**Gap:** Q4 (joint winners cannot be expressed). Also the engine plan's finding 5: the completion guard (`engine-db/competition.ts:1008-1058`) refuses any unbeaten field entrant who won no final, so a joint final would never complete.

**Storage (plan's call):**
- The engine's `MatchOutcome` kinds are closed (`bracketWinnerLoser`'s exhaustive switch, `competition.ts:198-221`), so the declaration cannot be a new outcome kind.
- It is a fixture column. The final is `status = 'decided'`, `outcome = null`, `joint_winners_at = now()`.
- The prior status and outcome are kept in a division-ledger row for the Undo.

**Files:**
- Create:
  - `db/migration/deltas/V494__w4_fixture_joint_winners.sql`. It adds `alter table fixtures add column joint_winners_at timestamptz null`, plus `check (joint_winners_at is null or (status = 'decided' and outcome is null and home_entrant_id is not null and away_entrant_id is not null))`. No data change.
  - `apps/web/src/server/usecases/joint-winners.ts`.
  - The two routes `app/api/v1/fixtures/[id]/joint-winners/route.ts` (POST declare, DELETE undo). Read `node_modules/next/dist/docs/` for route handlers first.
- Modify:
  - `server/engine-db/competition.ts`:
    - `toBracketFixture` (`:239-262`) maps `joint_winners_at` → `jointWinners: true`, status `"decided"`, no winner;
    - `FixtureRow` and `loadStageInputs` select the column;
    - the D-G1 guard (`:1008-1058`) counts a joint final's two seats as `finalWinners`.
  - `server/usecases/stages.ts` `loadBracketFixtures` (the same mapping).
  - The `decided ⇒ outcome` readers: sweep by behaviour, `rtk proxy grep -arln "outcome->>'winner'\|outcome?.winner\|outcome.winner\|division_results" apps/web/src --include='*.ts' --include='*.tsx'` (13 production files at pin). Each reader either already treats a null outcome as "no winner" (record it), or gains the joint arm. The public results row reads "Joint winners".
  - `lib/knockout-refusals.ts`:
    - `JOINT_WINNERS_NOT_A_FINAL`, 422, "Joint winners can only be declared on a final.";
    - `JOINT_WINNERS_FINAL_DECIDED`, 409, "This final already has a result.";
    - `JOINT_WINNERS_NOT_DECLARED`, 409, "This final has no joint winners to undo.".
  - `lib/division-phase.ts`: a joint final is settled (no `final_decided` nag once the stage completes; app A's attention reads it as decided).
- Test: `apps/web/src/server/usecases/__tests__/joint-winners.test.ts`, `server/__tests__/w4b-migration.test.ts` (V494), and the route test `app/api/v1/fixtures/[id]/joint-winners/__tests__/route.test.ts`.

**Interfaces:**
- Produces:
  - `declareJointWinners(auth: AuthCtx, fixtureId: string): Promise<{ fixture_id: string; stage_completed: boolean }>`.
    - Under the `division:` lock. Organiser-only (X-ST-2's door).
    - Offered on a bracket final (`is_final`, not `third_place`, not a DE reset that is not owed) with both seats and no decided result: status `scheduled`, `in_play`, `abandoned` (awaiting settle) or `needs_decision` (X-CH-6, the CK-KO-1 held cricket final included).
    - It writes `status='decided'`, `outcome=null`, `joint_winners_at=now()`, and a ledger row `joint_winners_declared { fixture_id, prior: { status, outcome } }` (`appendLateEntryRow`'s pattern: no watermark move).
    - Then it calls `completeStageIfReady`.
  - `undoJointWinners(auth: AuthCtx, fixtureId: string): Promise<{ fixture_id: string; status: string }>`.
    - Restores `prior` from the newest `joint_winners_declared` row for the fixture, and clears the column.
    - If the stage completed on it, it re-opens the stage (`status='active'`, its pool-null snapshot deleted) in the same transaction. A stage whose completion already seeded another refuses `VACANT_TITLE_ALREADY_SEEDED` (Task 11's code, same reason).
  - `jointWinnersOffered(f: { is_final: boolean; third_place: boolean; status: string; home_entrant_id: string | null; away_entrant_id: string | null; joint_winners_at: string | null }): boolean` (pure, `lib/joint-winners.ts`). The UI and the server read this ONE predicate.
- Consumes: the engine's `BracketFixture.jointWinners` and its guards; Task 4's `bracketTitleOf`.

- [ ] **Step 1: Failing tests** (DB; badminton, cricket, then chess by `sportFor`):
  - `X-CH-4 declaring joint winners on a scheduled final: both rank 1st, nobody 2nd, the bracket says Joint winners`. Places `[1,1,3,3,…]` from the Rank places table; `divisionTitle` is `joint`; the stage completes. `// differential: today refused (no path) and the D-G1 guard would 422`.
  - `X-CH-4 the action is undoable`: undo → the final is `scheduled` again, the stage is `active`, the snapshot is gone, and the title is null. A second undo → `JOINT_WINNERS_NOT_DECLARED`.
  - `X-CH-6 offered on scheduled, abandoned awaiting settle, and held level (needs_decision)`: one case each. The settle stays offered beside it (assert the settle route still accepts the abandoned final before the declaration).
  - `X-CH-6 a cricket final held under CK-KO-1 takes joint winners` (a tie with no super over → `needs_decision`).
  - `X-CH-6 not offered on a semi-final, a third-place match, a decided final, or a final with a TBD seat` (four refusals, each by code).
  - `X-CH-4 a withdrawal after joint winners leaves the joint title standing` (Review Focus 4).
  - `X-CH-4 the D-G1 guard still refuses an unbeaten entrant on a final that decided nobody without joint winners` (the guard's negative pair).
  - The V494 constraint refuses `joint_winners_at` on a fixture with an outcome.
  - Sequence:
    - declare → undo → declare again (the second declaration writes a second ledger row, and undo reads the newest);
    - declare → Reinstate of an unrelated entrant changes nothing.
- [ ] **Step 2: Run FAIL**, **Step 3: Implement** (V494, usecase, routes, mapping, guard, readers sweep), `openapi:gen`.
- [ ] **Step 4: Run PASS:** the three files plus `bracket-complete-guard.test.ts`, `settle-seating.test.ts`, `needs-decision-status.test.ts`, `organiser-only-events.test.ts`, `status-set-sweep.test.ts` (a status-literal reader moved), `champion.test.ts`, and every reader test the sweep touched (named). tsc. Locale + gen-keys.
- [ ] **Step 5: Mutate:**
  - (a) Drop the guard's joint arm → `X-CH-4 …both rank 1st…` reds.
  - (b) `jointWinnersOffered` → `return true` → `X-CH-6 …not offered…` reds.
  - (c) Restore without `prior` (always `scheduled`) → add and red `X-CH-4 undo on a held cricket final restores needs_decision`.
- [ ] **Step 6: Smoke** +2: declare → title joint; undo → title null.
- [ ] **Step 7: Commit** `feat(w4): Declare joint winners on an unplayed final, undoable (Q4; X-CH-4, X-CH-6; V494)`.

## Task 13: Joint winners and the vacant title on the desk and the bracket (UI)

**Rules:** X-CH-4 and X-CH-6, UI halves (extra tokens).

**Files:**
- `components/v2/fixture-console.tsx`, the organiser block where Settle lives (re-pin it by grepping `settle` in the console), per Task 1 item 4. The action and its Undo, gated by `jointWinnersOffered`, with a confirm sheet naming both finalists.
- `components/v2/bracket-panel.tsx`: the final tile reads "Joint winners" / "Title vacant" (Task 1 item 3). The headline box comes from app A's N-1 fix; never draw over a name.
- Copy in 4 locales plus gen-keys:
  - `jointWinners.action` "Declare joint winners";
  - `jointWinners.confirm` "{a} and {b} will both be champions. You can undo this.";
  - `jointWinners.undo` "Undo joint winners";
  - `bracket.jointWinners` "Joint winners";
  - `bracket.titleVacant` "Title vacant".
- Tests: `components/v2/__tests__/fixture-console-joint-winners.test.tsx`, `components/v2/__tests__/bracket-panel-title.test.tsx`.

- [ ] **Step 1:** Run the `frontend-design` skill; build per the pick.
- [ ] **Step 2: Failing tests:**
  - the action renders on each X-CH-6 state and not on the four refused ones (the same table as Task 12; empty case first: a fixture with no seats);
  - the Undo renders only on a joint final;
  - the tile renders both titles, anchored on `="`.
- [ ] **Step 3: Implement, Run PASS, Mutate** (gate → `true` → the refused-state case reds).
- [ ] **Step 4: Verify** at 1280, 320 and 768: the console at a phone width per the phone-composition design (the organiser block's fold; open EVERY disclosure before asserting), and the bracket tile with a 43-character name. Hit-test the action with `elementFromPoint`. Screenshots go to `:8765`.
- [ ] **Step 5: E2E:** describe `X-CH-4 the organiser declares joint winners on a rained-off final and undoes it` (console → confirm → public banner "Joint winners" → Undo → the final is open).
- [ ] **Step 6: Commit** `feat(w4): Declare joint winners and the vacant title on the desk and the bracket (Q4 UI)`.

---

## Task 14: The reference family — bracket progression and final ranks (design §6.4)

**Who:** dispatch to a DIFFERENT agent from every implementer of Tasks 2–13 and from the engine fixer (R8). The brief names only the signed rulebook, the rule rows and this task, never the engine's or the app's source.

**Files:**
- Create: `packages/reference/src/families/bracket-progression.ts`, `packages/reference/src/families/bracket-progression.test.ts`.
- Modify:
  - `packages/reference/src/index.ts` (export);
  - `scripts/reference-boundary.ts` (its type-only engine import allowance, if it lists families);
  - `tools/matrix/__tests__/reference-bracket-progression.test.ts` (new): the product's observed outputs against the oracle.

**Interfaces:**
- Produces `bracketProgression: { draw, lateEntryCase, plateField, luckyLoser, ranks, ladderSeats }`, every function pure and stated in the rulebook's terms:
  - `draw(n, seeds, drawSeed)`: the fold, byes to the top seeds, the unseeded by a seeded shuffle that replays. RB4-D1, D2, D5–D7.
  - `lateEntryCase(lines, started)`: `bye` | `withdrawn_slot` | `refused` | `rebuild_offered`. RB4-L3 … L7.
  - `plateField(results)`: the first-loss set and its exclusions. RB4-P1, P2, E6.
  - `luckyLoser(pool, drawSeed)`. RB4-V1 … V5.
  - `ranks(result)`: shared 3rd, joint, vacant, vacant 3rd, strict below. RB4-T2, T6, C1–C4, R1, R2.
  - `ladderSeats(withdrawals)`: stepladder and page-playoff seats and ranks after a withdrawal. RB4-S4, S5.
- Every function throws `RuledOut` / `OutOfScope` (the bracket-finish family's classes) where the rows are silent. It never guesses (R6), and it is never a second bracket generator.

- [ ] **Step 1:** The family's own tests, one `describe` per rulebook group, each test citing its RB4 id. Every check reports how many items it examined, and zero is a failure (R25).
- [ ] **Step 2:** `reference-bracket-progression.test.ts` compares the oracle against:
  - (a) the engine's `completeBracketStage` / `firstLossField` / `generateSingleElim` over a counted grid (n = 2 … 33 × Shared/Play-off × champion/joint/vacant);
  - (b) the app's `bracketPlaceLabels` (Task 5);
  - (c) Task 6's migration output on seeded 3.x rows.
  - Any disagreement is a finding routed to the owning task, never an oracle edit to match.
- [ ] **Step 3: Run PASS:** `VERIFY-ROOT t14 packages/reference/src/families/bracket-progression.test.ts tools/matrix/__tests__/reference-bracket-progression.test.ts scripts/__tests__/reference-boundary.test.ts` (grep the boundary test's name).
- [ ] **Step 4: Mutate** the oracle once (rank SF losers 3/4) → the engine comparison reds. Restore.
- [ ] **Step 5: Commit** `test(reference): bracket progression and final-ranks oracle from the W4 rulebook (design §6.4)`.

## Task 15: Matrix — the PR-B share of T8-c (Q3, Q5a, Q5b, Q4a scripts; the third-place row on the builder)

**Files:**
- Create, under `tools/matrix/lib/scenarios/` and modelled on `r4-withdrawal.ts` and app A's R2/R10/R6 scripts, each check counting what it examined:
  - `q3-third-place.ts`:
    - Shared: two 3rds, read from the completion's `places` (Task 3), the public standings and the banner;
    - Play-off: who plays whom in the `-3p` (the two SF losers), then 3rd/4th;
    - Play-off with both sides withdrawn: 4, 4.
  - `q4a-joint-winners.ts`: declare on an unplayed final → `places` 1,1 and `title.kind = "joint"`, then undo.
  - `q5-plate.ts`. The atoms are the catalogue's (`scenario-catalogue.ts:109`), not the rulebook's label (Premises 4):
    - **Q5a "plate entrant withdraws":** after the plate is drawn, a plate entrant withdraws, and their plate line walks over (X-WD-2). Assert the seats.
    - **Q5b "a main-draw loser declines the plate":** modelled as that loser withdrawing after their first loss and before the proposal. They are not seated in the plate, and the plate draws from the rest (ruling 116: a departed entrant is never seated).
- Modify:
  - `tools/matrix/lib/scenario-catalogue.ts:146-153` (`KNOWN_NO_PATH`): Q4 is fully routed (Q4a scripted here, Q4b ⛔ from app A).
  - `tools/matrix/lib/api-only-ui.ts:17`: drop `knockout_third_place` (it is a builder path now, Task 10), so its 11 L1 🚫 cells are driven.
  - `tools/matrix/lib/catalogue.ts:162-170`: the row builds through the builder knob.
  - `tools/matrix/lib/applicability.ts:355` (Q3's rule): applies to `knockout` (Shared) and `knockout_third_place` (Play-off).
  - `tools/matrix/lib/driver/browser-driver.ts:1238-1250`: the banner's expected crown reads `title`, not `finalRanks[0]`.
  - `tools/matrix/lib/scenarios/m1-walkover.ts:92-108` and `w2b-forfeit-credit.ts:452-470`: read `places`/`title`. The latter's "vacant half pins no finalRanks … a W4" note becomes an assertion of `title.kind = "vacant"`.
  - `tools/matrix/lib/invariants.ts:104,140,186,195`: "every field entrant ranked exactly once" and "ranks[0] = the unbeaten entrant / terminal-final winner" read `places`/`title`. A joint title satisfies with either finalist, and a vacant title asserts no champion. Each invariant keeps its counted-items report.
  - `tools/bench/lib/oracle.ts:573,615,668` and `advance.ts:300,345` stay on `finalRanks: string[]` (Task 3 keeps it). No bench pack holds a joint, vacant or shared-3rd case (the gates are deferred), so record that and do not edit.
- Test: `tools/matrix/__tests__/w4b-scenarios.test.ts` (unit tests of the three scripts against recorded fixtures), plus the catalogue pins (grep `KNOWN_NO_PATH` and `api-only-ui` in `tools/matrix/__tests__`).

- [ ] **Step 1: Failing tests:**
  - each script against a recorded fixture of the right answer and of today's wrong answer (a differential pair);
  - the catalogue: Q3, Q4a, Q5a and Q5b are scripted (the cells move from ░ to driven, counted by id);
  - `knockout_third_place` L1 is no longer API-only (11 cells).
- [ ] **Step 2: Run FAIL**, **Step 3: Implement**, **Step 4: Run PASS** (`VERIFY-ROOT t15 …` with the named files), tsc, lint.
- [ ] **Step 5: Mutate:** make `q3-third-place.ts` accept 3/4 by seed in Shared → its differential test reds.
- [ ] **Step 6: Commit** `test(matrix): third place, joint winners and plate scripts; knockout_third_place on the builder (T8-c, PR-B share)`.

## Task 16: Full e2e per row, the badminton doubles walkthrough, and smoke (T8-a, T8-c)

**Files:**
- `apps/web/e2e/w4-knockout-app-b.spec.ts`: the per-task describes from Tasks 2–13, plus the row journeys below.
- `apps/web/e2e/walkthrough/w4-knockout-doubles.spec.ts` (new; T8-a).
- `scripts/smoke/suites/w4KnockoutB.ts`: count it.

- [ ] **Step 1: The row journeys,** each driven through the UI where a screen exists and asserting seats and ranks:
  - **late entry, every case:**
    - `bye`;
    - `withdrawn_slot`;
    - `refused` (round 1 complete);
    - `rebuild_offered`;
    - and an automatic arrival (a paid registration) waiting, then placed by the desk tap (app A's flag, now with the first-loss feed downstream: the tapped player then loses R1 and appears in the plate, X-LE-14).
  - **plate at odd n:** 5, 7 and 9, plus 6 (even with byes).
  - **third place:** Shared (two 3rds on the public page) and Play-off played (3rd/4th).
  - **joint winners** on a rained-off final, and its undo.
  - **vacant title:** both finalists withdraw.
  - **a PAIR bracket:** badminton doubles, 6 pairs.
- [ ] **Step 2: The walkthrough** `w4-knockout-doubles.spec.ts`. An organiser builds a badminton doubles Knockout + Plate for 7 pairs with "Third place: Shared" in the builder, starts it, adds a late pair (case 1), plays round 1 and the round-2 bye lines, and confirms the plate. They play both brackets out, and read the public page: two shared 3rds in the main draw, the plate champion, and every pair once. Screenshots at 1280/320/768 go to `:8765`.
- [ ] **Step 3: Smoke** total: the per-task "+N" sum, asserted equal to `EXPECTED_CHECKS`. Run `SMOKE_ONLY=w4KnockoutB npm run test:smoke` locally.
- [ ] **Step 4: Dispatch** e2e (`--ref`), judging as whole files `w4-knockout-app-b.spec.ts`, `w4-knockout-app-a.spec.ts`, `bracket-finish.spec.ts`, `hub-knockout.spec.ts`, `knockout.spec.ts`, `forfeit-dialog.spec.ts`, `progression-bye.spec.ts`, `walkthrough/w4-knockout-doubles.spec.ts`, `walkthrough/knockout-void-unfill.spec.ts` and `mobile.spec.ts`. Plus every spec the Task 2 by-behaviour grep touched. Hand back.
- [ ] **Step 5: Commit** `test(w4): full e2e per row, the doubles walkthrough, smoke (T8-a, T8-c)`.

## Task 17: Re-baseline L3 on this branch's truth run (T8-d)

**Why one run, not one per fix:** `matrix-truth.yml` dispatch is full-scope only (`:35-38`). "In the same change as each fix" is met by landing the re-baseline in THIS PR, which holds every fix. The judge must show each of the 33 baseline reds moved, by id:
- `ko_plate` F1 ×11 → works;
- `stepladder_only` R4 ×11 and `page_playoff_only` R4 ×11 → ⛔ refused, unless app A already re-baselined them (Task 0).

**Files:**
- Create: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w4-final/` (in `w3-final`'s shape), and append to `truth-runs/plans.lock.json`.
- Modify: `tools/matrix/catalogue/baseline.json` (repoint `L3` to `truth-runs/w4-final/ci/L3/results.json`).
- Modify: `tools/matrix/catalogue/triage-rules.json`, via `pnpm matrix:catalogue` (never hand-edit generated JSON). Do this only where a rule's cells are gone: re-key or retire `stepladder-withdraw-wrong-phase` and `page-playoff-withdraw-voids` if app A left them.

- [ ] **Step 1: CI truth run.** `git push origin feat/w4-knockout-app-b && gh workflow run matrix-truth.yml --ref feat/w4-knockout-app-b -f scope=full; echo EXIT=$?`. Confirm `headSha` = HEAD and event `workflow_dispatch`, then hand back. When it ends: `gh run download <id> --name merged --dir truth-runs/w4-final/ci`, then `pnpm matrix:render`.
- [ ] **Step 2: Judge against the current baseline:** `pnpm matrix:judge regression --baseline <current L3> --now truth-runs/w4-final/ci/L3/results.json --json-out truth-runs/w4-final/judge-L3.json; echo EXIT=$?`, and the same for L1 and L2.
  - Expected: 0 regressions.
  - Each of the 33 cells is listed with its new verdict.
  - Every other moved knockout-family cell is triaged by ruling (270 shared 3rd, X-CH-7 stricter completion). A defect found here is fixed in this PR and that cell is re-run.
- [ ] **Step 3: Failing test first:** `the committed baseline holds no ko_plate F1 red` and `every one of the 33 W4 baseline reds is works or ⛔ in w4-final` (counted by id; zero listed is a failure). Put both in `tools/matrix/__tests__/baseline-w4.test.ts`.
- [ ] **Step 4: Repoint**, regenerate, `pnpm matrix:lock-check --against HEAD`.
- [ ] **Step 5: Run PASS:** `VERIFY-ROOT t17 tools/matrix/__tests__/baseline-w4.test.ts tools/matrix/__tests__/pr-sample.test.ts tools/matrix/__tests__/triage.test.ts tools/matrix/__tests__/triage-rules-shapes.test.ts tools/matrix/__tests__/backlog.test.ts`, plus tsc.
- [ ] **Step 6: Mutate:** point L3 back at `w3-final` → `baseline-w4.test.ts` reds. Restore.
- [ ] **Step 7: Commit** in two:
  - `docs(matrix): W4 truth run (w4-final)`;
  - `chore(matrix): L3 re-baselined on the W4 run — 33 knockout reds retired (T8-d)`.

---

## Task 18: Re-pin, PR, CI, review, owner sign-off

- [ ] **Step 1: Flow A only.**
  - Gate: the engine PR has merged, `release/4.0.0` has merged, and the publish is proven (registry `4.0.0`, tag `v4.0.0`, Release epoch line "none").
  - Remove the override.
  - Set the 6 manifests to `npm:@onryde/seazn-engine@^4.0.0` and run `pnpm install`. `grep -arn "0.0.0-pr" --include='*.json' --include='*.yaml' --include='*.ts' . | grep -v node_modules` returns nothing.
  - If `git -C ~/github/seazn.club.engine diff <snapshot sha> v4.0.0 -- src` is non-empty, re-run every task's VERIFY list and Task 17 Steps 1–2.
  - The 4 range tests stay green unchanged. Mutate once: put one manifest back on `^3.0.2` → the identical-manifests check reds.
- [ ] **Step 2: Gates:**
  - `pnpm turbo run typecheck`, `tsc -p tsconfig.tools-tests.json`, lint (the count must not rise);
  - `i18n:check`;
  - `openapi:gen` with a clean diff;
  - `pnpm matrix:single-sport --check --against origin/main`;
  - `VERIFY-ROOT t18-rules scripts/__tests__/rules-reference.test.ts`, green on the copied `AWAITING_PROOF`;
  - the smoke guard tests `scripts/__tests__/smoke-{paths,select,manifest}.test.ts`, then `SMOKE_ONLY=w4KnockoutB npm run test:smoke` = `EXPECTED_CHECKS`.
- [ ] **Step 3: PR body:**
  - the Matrix rows line (Global Constraints);
  - "Paired with onryde/seazn.club.engine#<N>; engine 4.0.0 release <link>";
  - the owner's merge-order answer, in their words;
  - "Data changes": V494 (schema), V495 and V496 (LOUD), with Task 0's counts and the stg runbook line "run V495/V496 pre-deploy; idempotent";
  - the wire note: `stage_completed.finalRanks` is unchanged as ids, plus `places` and `title`;
  - Task 2's re-derived test list;
  - Task 17's judge lines;
  - the R24 picks;
  - bench gates All England / Wimbledon / WTTC ⏳ deferred (no pack);
  - the rule-id table below;
  - the premises found false;
  - the Claude Code line.
- [ ] **Step 4: Dispatch** e2e (Task 16's file list) and hand back.
- [ ] **Step 5:** A final Opus `reviewer` pass over the whole branch (never skipped, class 12), with its findings written to disk. Then the per-screen owner sign-off for Tasks 5, 8, 10 and 13 (class 11). Merge only on the owner's explicit go.
- [ ] **Step 6: Post-deploy stg check** (after the owner deploys; V494–V496 run pre-deploy). Drive the product on stg and record what you SAW on `:8765` (class 5):
  - a re-ranked historical bracket shows two 3rds;
  - a new Knockout + Plate at n=5 proposes its plate after round 2;
  - "Third place: Play-off match" makes a `-3p` tile;
  - joint winners and its undo work on a final;
  - both finalists withdrawn reads "Title vacant".
  - Any miss: STOP before merge.
- [ ] **Step 7: `_INDEX.md`:** append "W4 App B" status, the premises found false, and the bench-gate deferrals (status sections only).

## Task 19: Rule close-out — the companion engine docs commit, 4.0.1, and the re-pin (W3 precedent `7aad874`)

**Who:** the controller, after this PR is green on 4.0.0 with every proving title present. That way 4.0.1's rows cite files that exist and the app checker proves them in THIS PR (M9), not in someone's later bump.

- [ ] **Step 1: Engine docs PR** (`docs/w4-app-b-proofs` on `onryde/seazn.club.engine`, from `origin/main`; never `git stash`).
  - For each of the 17 ids, in ONE commit:
    - fill `proved by` with the app paths in the table below (repo-relative, `apps/web/...`, `tools/matrix/...`, `packages/reference/...`);
    - fill `enforced at` with the production paths each task changed;
    - drop the citation's `; not yet implemented (W4 app PR B)` note;
    - delete its `AWAITING_PROOF` entry in `test/rules-reference.ts`.
  - Amend **X-WD-4**'s rule text and citation with Task 11 Step 8's wording (status stays `signed 90 2026-10-08`; X-CH-3's row already says it "supersedes … X-WD-4's settle for a final").
  - Add a `patch` changeset.
  - Verify `test/rules-reference.test.ts` (JSON reporter). In the commit body, count the app proof paths named (> 0; the engine checker is blind to them).
- [ ] **Step 2: Release 4.0.1** with the `engine-release` skill §1.
- [ ] **Step 3: Re-pin this PR** to `^4.0.1` (the 6 manifests plus the lock).
  - Empty `scripts/lib/rules-reference.ts` `AWAITING_PROOF` of every W4 id. Any id still awaiting in 4.0.1 stays, with its reason in the PR body.
  - Add **X-WD-4** to `AMENDED_TEXT`, with 4.0.1's text verbatim and `by: "rulings 267 and 274: the deciding final goes vacant (X-CH-3) and a third-place play-off's 3rd goes vacant (X-TP-7)"`.
  - Run `VERIFY-ROOT t19 scripts/__tests__/rules-reference.test.ts`. Every one of the 17 rows' app paths exists and holds its id as a whole token. A red naming a PR-B path is a defect here; a red naming a PR-A path goes to the orchestrator.
- [ ] **Step 4: Fallback (owner's call).** If the owner prefers to merge this PR first, Steps 1–3 become a follow-up bump PR (`chore/engine-4.0.1`). This PR keeps the 17 entries in `AWAITING_PROOF`, and the PR body says the proofs ride the follow-up.
- [ ] **Step 5: Commit** `chore(engine): bump to 4.0.1 — the W4 app PR B rule proofs; X-WD-4 amended (rulings 267, 274)`.

---

## Batches (execution order and parallelism)

| Batch | Tasks | Order and why |
|---|---|---|
| B0 | 0 → 2, with 1 beside them | 0 is controller-run; 1 waits on nothing; 2 is the substrate everything compiles on. |
| B1 | 3 → 4 → 5 → 6 | 4 consumes 3's `title`; 5 consumes 4; 6's equivalence test reads 5's readers. 5's UI step waits on the Task 1 pick, and 6 may run while it waits (6 touches only `db/` and its test). |
| B2 | 7 → 8 | 8 consumes 7's template and wire. |
| B3 | 9 → 10 | 10 is the UI of 9. 9 is disjoint from B2's files except `stages.ts` and `knockout-refusals.ts`, so it runs sequentially after B2. |
| B4 | 11 → 12 → 13 | 11 and 12 both touch `engine-db/competition.ts` and the completion guard; 13 is their UI. |
| B5 | 14 ‖ 15, then 16 → 17 | 14 (`packages/reference`, a different agent) and 15 (`tools/matrix`) are disjoint. 16 needs every feature, and 17 needs the final tree. |
| B6 | 18 → 19 | 19 needs 18's green PR. |

Each batch ends with an Opus `reviewer` pass over the batch diff, a push and an e2e dispatch. The controller reruns the batch's scoped VERIFY lists itself and pastes the raw counts (never "done, tests pass").

## Decisions recorded in this plan (recommendations, not rulings)

1. **The wire adapter (Task 3).** `stage_completed.finalRanks` stays `string[]`, and `places` and `title` are added. Recommend yes: the events are documented as free-form objects, so a silent shape change would break every client while the OpenAPI drift check stays green.
2. **Joint winners are a fixture column (V494), not an outcome kind (Task 12):** the engine's outcome kinds are closed. The prior state lives in a ledger row for the Undo.
3. **A reinstated finalist reverses a vacant title (Task 11)**, while every other knockout Reinstate waits on the desk flag (ruling 271, app A). The finalist's seat was never taken from them, so nothing is placed. Recommend: RB4-C3 ("reverses itself if Reinstate … restores a finalist") wins for the final. Put to the owner as the one place 271 and 267 meet.
4. **The plate has no day-one fixtures (Task 8):** its size is the first-loss field, known only after round 2. The stage card says so (Task 1 item 5).
5. **A too-small plate completes with no fixtures and a named outcome** (X-PL-2). It is not a refusal, so Complete never 409s (X-PL-8).
6. **The proposed X-WD-4 text** (Task 11 Step 8) is the plan's wording of a consequence rulings 267 and 274 already signed. The owner reads it at the PR review.
7. **The rule close-out lands before this PR merges** (Task 19, 4.0.1), so the app checker proves the 17 rows here. The fallback is a follow-up bump; that is the owner's call.

## Premises found false or stale (to `_INDEX.md` "False premises found (W4)")

1. **Design §6.4 (the `packages/reference` oracle) is owned by neither sibling plan.** The engine plan names it only as something the Q8 migration "must agree" with (T6 seam). App A's "Out of scope" omits it. This plan takes it (Task 14), because the oracle must judge the bumped engine and the app together.
2. **The completion guard at `engine-db/competition.ts:1008-1058` cannot complete joint winners** (the engine plan's finding 5): confirmed. It also needs no change for a vacant title, because a departure double walkover already puts both finalists in `lost` (`:1018-1022`).
3. **Q8 is "stored and derived", not one or the other.** Ranks are stored (`standings_snapshots`, written at `competition.ts:1063-1070`), and the champion is derived from fixtures on read (`champion.ts`). Only the snapshot migration is owed (V496).
4. **The matrix Q5 atoms are not the rulebook's.** `scenario-catalogue.ts:109` defines Q5a "plate entrant withdraws" and Q5b "a main-draw loser declines the plate". The rulebook's L2 table (`rulebook-W4-knockout.md`, "Q5a/b | Plate with byes / odd n") describes the odd-n fix, which L3 F1 and the Task 8 sweep cover. Task 15 scripts the catalogue's atoms.
5. **A conditional DE reset is never voided in production** (`champion.ts`'s header). Under 4.0.0's X-CH-7, a DE stage won in the first grand final would never complete. Neither the engine plan nor the design names this bump hazard; Task 2 maps it on read.
6. **`division-phase.ts:716`'s comment** ("a third-place playoff completes on its FINAL alone") becomes false at the bump. The engine plan flags the re-read; Task 2 rewrites it.
7. **The stage PATCH route is Swiss-only** (`app/api/v1/stages/[id]/route.ts:29-36`, `PatchSwissStage`). The third-place setting needs a kind-dispatched body (Task 9).
8. **App A and the engine both export `undecidedBracketFixtures`**, with different signatures. This is an import collision at the bump (Task 2).
9. **`server/usecases/officials.ts:844` checks `s.status = 'completed'`**, but `V210__stages.sql:10` allows only `pending|active|complete`. So officials' "source decided" is always false. This is a live defect found by the reader sweep; Task 5 fixes it in its blast radius.
10. **`/present` (`slideshow-data.ts:721`) and the embed standings widget read bracket snapshots with no kind filter**, and `/present` falls back to `i + 1` for a missing rank (`:195`). So X-TP-3's "every surface" holds only if the stored rank is read, never the index (Task 5).

## Rule-id table (the 17 "W4 app PR B" rows; for Task 19's companion commit)

| Id | Rule (short) | Proving test(s) — `apps/web/src/…` unless prefixed :: title token | Task |
|---|---|---|---|
| X-TP-3 | Shared 3rd on every surface | `server/__tests__/shared-place-surfaces.test.ts`, `lib/__tests__/bracket-places.test.ts`, `apps/web/e2e/w4-knockout-app-b.spec.ts` | 5 |
| X-FR-4 | Ranks and champion recomputed under the current rule | `server/public-site/__tests__/champion.test.ts`, `server/public-site/__tests__/champion-title-engine-parity.test.ts`, `server/api-v1/__tests__/stage-events.test.ts`, `server/__tests__/w4b-migration.test.ts` | 3, 4, 6 |
| X-FR-5 | History switches to shared 3rd; stored ranks migrated LOUD | `server/__tests__/w4b-migration.test.ts` | 6 |
| X-PL-2 | Field under 2 → named outcome | `server/usecases/__tests__/plate-first-loss.test.ts` | 8 |
| X-PL-5 | Plate draws after round 2 | `plate-first-loss.test.ts`, `apps/web/e2e/w4-knockout-app-b.spec.ts` | 8 |
| X-PL-6 | No fixed q | `lib/__tests__/format-templates.test.ts`, `lib/division-builder/__tests__/format-estimate.test.ts` | 7 |
| X-PL-7 | Proposed through propose/confirm; auto-confirm | `plate-first-loss.test.ts` | 8 |
| X-PL-8 | Every offered n completes or is refused up front | `server/usecases/__tests__/plate-first-loss-sweep.test.ts`, `server/usecases/__tests__/bracket-placement-sweep.test.ts`, `apps/web/e2e/w4-knockout-app-b.spec.ts` | 8 |
| X-SD-11 | Plate / fed main draw follow the draw rules | `plate-first-loss.test.ts` | 8 |
| X-LE-14 | A late entrant feeds the plate | `plate-first-loss.test.ts` | 8 |
| X-TP-1 | Third place not offered below 4 | `lib/__tests__/third-place.test.ts`, `server/usecases/__tests__/third-place-setting.test.ts`, `components/v2/__tests__/format-picker-third-place.test.tsx` | 9, 10 |
| X-TP-2 | One setting, Shared default, every sport | `third-place-setting.test.ts`, `components/v2/__tests__/format-picker-third-place.test.tsx`, `apps/web/e2e/w4-knockout-app-b.spec.ts` | 9, 10 |
| X-TP-6 | Editable until Start | `third-place-setting.test.ts`, `app/api/v1/stages/[id]/__tests__/patch-knockout.test.ts`, `components/v2/__tests__/stages-panel-third-place.test.tsx` | 9, 10 |
| X-TP-7 | Play-off both out → 4, 4 | `third-place-setting.test.ts` | 9 |
| X-CH-3 | Both finalists out → vacant, reversible | `server/usecases/__tests__/vacant-title.test.ts`, `apps/web/e2e/w4-knockout-app-b.spec.ts` | 11 |
| X-CH-4 | Declare joint winners, undoable | `server/usecases/__tests__/joint-winners.test.ts`, `components/v2/__tests__/fixture-console-joint-winners.test.tsx`, `apps/web/e2e/w4-knockout-app-b.spec.ts` | 12, 13 |
| X-CH-6 | Offered on any final without a decided result | `joint-winners.test.ts`, `components/v2/__tests__/fixture-console-joint-winners.test.tsx` | 12, 13 |

17 ids: X-TP 5, X-FR 2, X-PL 5, X-SD 1, X-LE 1, X-CH 3.

Extra tokens (not counted; proved elsewhere): X-FR-1, X-TP-4, X-TP-5 and X-CH-1 (Task 2, the engine rows' app evidence); X-CH-7 (app A); X-PL-4 (Task 8's exclusion case).

Matrix evidence for the companion commit (`matrix:` entries, additional only): `matrix:knockout|*|Q3`, `matrix:ko_plate|*|Q5a`, `matrix:ko_plate|*|Q5b`, `matrix:knockout|*|Q4a`, with the id grammar confirmed against an existing `matrix:` entry before writing.
