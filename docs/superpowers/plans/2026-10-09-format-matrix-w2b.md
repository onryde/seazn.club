# Format × Sport Matrix — W2b (walkover, retirement and double-walkover credit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Agent topology.** Work runs in **loops**, not one dispatch per task. Each loop is implementer → reviewer, repeated until the review is clean and the scoped gate is green (R21). Same-file tasks are batched into one loop (RULES.md batching rule). Two lanes (P1 harness, P2 reference) run in their own worktrees because their file sets are provably disjoint from every other loop's. Task 15 (the reference families) goes to a **different implementer agent** from the one that ran loop D, the engine loop (R8). Models and effort come from `.claude/agents/*.md` frontmatter and `docs/superpowers/RULES.md`. **No dispatch in this plan overrides `model:`**: ruling 80 was W2a-only (Execution model; owner question Q4).

**Goal.** For every sport and every way a match goes unplayed or unfinished, the table, the bracket, player stats and the public page credit what the federation says and say plainly what happened:
- a no-show, a retirement, a disqualification, both sides absent, a withdrawal, an abandon;
- no absent side ever advances;
- no organiser has to fake a walkover to move a draw on.

The W2b reds (spec §8) are reproduced first and are green at the end. The five inherited boardgame R4 cells (CD-T13) turn `works`, and the CI judge regression shows 0 new reds.

**Architecture** (approach 1, ruling 96 / W2b-A1; spec §4):
- **One event carries every unplayed or stopped result.** `core.forfeit {by: EntrantId | "both", reason: "walkover" | "retired" | "disqualified" | "withdrew"}` is strict.
- **The kernel guards it before the module fold.** A new phase guard reads a module hook, `forfeitPhase(state)`, plus the module's declared `walkoverPhases`. An abandon guard sits above guarantee 4.
- **The outcome set gains one kind.**
  - `award` becomes `{winner, loser: EntrantId | null, reason: AwardReason}`; `"bye"` is a system-only reason.
  - A sixth kind, `double_walkover`, is added.
  - `advancesNobody(outcome)` is the one authority on whether anybody advances.
- **Each sport declares its credit.** Every sport implements `forfeitCredit(cfg, state, reason, by)`. Its `standingsDelta` reads that for `award` and handles `double_walkover` explicitly.
- **Readers ask the same question.** The competition readers (`advancingSides`, `bracketWinnerLoser`, `feederIsDead`, `loserFeederIsDead`, `completeTableStage`, the tie-break ratios) all ask `advancesNobody`, and read `excluded` from the hook.
- **The server:**
  - keys `forfeited` on the event, as spec §5.4 orders;
  - refuses a double walkover where no seat is fed;
  - walks a withdrawal over everywhere it used to skip, void or throw;
  - re-classifies unsettled legacy chess double forfeits.
- **The UI.** The console gets one dialog (UI-1). The public pages get short tags plus a sentence (UI-2). The pad's chess dock sends `core.forfeit`.

**Tech Stack:**
- TypeScript 7 (`typescript-native`) on Node 26 `--experimental-strip-types`: no enums, namespaces or parameter properties, and `.ts` import suffixes under `tools/` and `packages/`.
- zod 4, vitest 4, fast-check, Playwright, pnpm.
- Postgres deltas in `db/migration/deltas/`.
- Stryker 10 (`packages/engine/stryker.groups.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` is the authority. Its rulings are 83–101 in `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md` (W2b-R1…R14, UI-1, UI-2, A1, R15/101).

Read with:
- `_RULES.md` R1–R29;
- `docs/superpowers/TEST-STRATEGY.md` rules 1–10;
- `docs/superpowers/RULES.md`;
- `AGENTS.md` classes 1–23 and the phone-composition section;
- the rulebooks `rulebook-W2-sets-cricket.md` (RB2A-n) and `rulebook-W2-goals-boards.md` (RB2B-n);
- the W2a plan `docs/superpowers/plans/2026-10-08-format-matrix-w2a.md`, which is the format and tooling reference;
- the gitignored brainstorm files in `.superpowers/w2b-brainstorm/`:
  - `repin-main-a99147bd0.md`, the current pin of every spec citation;
  - `f-w2-scout-w2b-outcome-set.md`, the 46-row seam checklist (spec §11);
  - `w2a-merge-notice.md`;
  - `w2b-code-map.md`.

Where the spec and the tree disagree, the tree wins, and the disagreement is listed in **Plan-time findings**.

**Abbreviations used below:**

| Short | Path |
|---|---|
| `WT` | `/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b` |
| `E` | `packages/engine/src` |
| `W` | `apps/web/src` |
| `HM` | `tools/matrix` |
| `REF` | `packages/reference/src` |
| `TR` | `docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs` |
| `MUT` | `docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2b` |
| `IDX` | `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md` |

---

## Plan-time findings (spec gaps and false premises; each with evidence)

These were found while planning, by reading the tree at `a0901a933`. Its code equals main `a99147bd0`; only docs commits sit on top. Items marked **OWNER** go to the owner as a recommendation before the task that needs them (class 17). They are collected as Q1–Q7 under **Owner open questions**. The rest are mechanical consequences of the spec's own rules, and the plan follows them.

The re-pin's changed claims C-1…C-10 (`.superpowers/w2b-brainstorm/repin-main-a99147bd0.md` §C) were accepted by ruling 101, and the spec is amended for them. They are not repeated here. Their consequences are in the tasks: C-1 → Task 3, C-2 → Task 8, C-3 → Task 8, C-4 → Task 7, C-5 → Tasks 3 and 6, C-6 → Tasks 3 and 7, C-7 → Task 11, C-8 → Task 8, C-9 → Task 9, C-10 → Step 0.

1. **OWNER (Q1) — the golden corpora record forfeits that W2b refuses.** `git grep -c "core.forfeit" -- 'packages/engine/src/sports/**/*.golden.json'` finds the following `core.forfeit` events:

   | sport | events |
   |---|---|
   | generic | 12 |
   | carrom | 6 |
   | football | 6 |
   | hockey | 6 |
   | boardgame | 5 |
   | icehockey | 5 |
   | each set sport | 1 |
   | tennis | 1 |

   W2b breaks them in two ways:
   - reasons such as `"no-show"` (boardgame, carrom) are refused `INVALID_EVENT` by the strict enum;
   - a `"walkover"` posted AFTER `core.start` (most sports) is refused by the new phase guard.

   The boardgame corpus also holds 18 `double_forfeit` results, which now fold to `double_walkover`. `REBASELINE_GOLDEN=1` keeps recorded events byte for byte (`E/testkit/GOLDEN-POLICY.md:25`), so it cannot repair a refused event.

   **Recommendation** (Task 5):
   1. A scripted, committed event-payload migration in its own commit, with a mapping that is a rule, not a hand edit:
      - a forfeit before any `core.start` becomes `"walkover"`;
      - a forfeit after it becomes `"retired"`;
      - `"both"` is never introduced.
   2. Then an isolated `REBASELINE_GOLDEN=1` commit, reviewed as a state diff.

   The alternative is to regenerate the affected streams from their generators, which loses their provenance. Task 5 does not start without the owner's answer.
2. **OWNER (Q2) — the forfeit vocabulary reaches 140 files.** The count comes from `git grep -l "core\.forfeit" -- apps packages tools scripts ':!*.golden.json'`.

   Where they are:

   | Area | Files |
   |---|---|
   | `W/server` | 36 |
   | engine sports | 28 |
   | components | 11 |
   | `W/lib` | 8 |
   | dictionaries | 8 |
   | `tools/bench` | packs |
   | `tools/matrix` | — |
   | `scripts/smoke-sports.ts` | 1 |
   | e2e specs | 6 (`scoring.spec.ts`, `bracket-finish.spec.ts`, `bracket-new-h1.spec.ts`, and three walkthroughs) |

   Reasons in use:

   | Reason | Uses |
   |---|---|
   | `walkover` | 29 |
   | `no-show` | 14 |
   | `"retired hurt"` | 10 |

   Each of these occurs too: `"test forfeit"`, `no_show`, `withdrawn`, `weather`, `"crowd trouble"`, `"walked off"`, `bored`, `"no-show for the rapid games"`.

   The `tools/bench` packs are under R3 (bench index; never edit `run-suite.ts` or `PackSchema`):
   - `tools/bench/packs/build-packs/suite11.ts` posts START then `"walkover"`.
   - `_tiny.ts` posts `"retired hurt"`.
   - `tools/bench/lib/pack-schema.ts:1268`'s `z.enum` of outcome kinds would throw on `double_walkover`, but no pack builds one.

   The bench also READS `award.method`. That is a second blast, and nothing in the spec names it:
   - `tools/bench/lib/suites/run-suite.ts:1643` copies `outcome.method` into the oracle's award;
   - `tools/bench/lib/oracle.ts:1320` reads `o.method` for `award`.

   After W2b, `award` has `reason` and no `method`, so suite 11's declared walkover would compare `undefined`. The bench's tests run in CI (`ci.yml:237`), so W2b's PR can red them. `run-suite.ts` is R3-protected.

   **Recommendation:** Task 10 does three things, and asks the bench index owner first:
   - edits only the two pack builders' payloads;
   - leaves `PackSchema` untouched;
   - asks the bench programme to switch `run-suite.ts:1643` and `oracle.ts:1320` to `reason` before W2b merges. If that cannot land first, the W2b PR carries the two-line change with the bench owner's written approval quoted in its body.
3. **OWNER (Q3) — an award-policy abandon has no reason to carry.**
   - Football and the period kernel fold an `abandonPolicy: "award"` abandon to `award{winner, score:{home,away}}` with no method (`football.ts` `applyAbandon` :1655+; `period/kernel.ts` :1447-1462).
   - Spec §5.1's closed reason set (`walkover | retired | disqualified | withdrew`, plus the system `bye`) has no "abandoned".

   **Recommendation:** fold it to `win{winner, loser, method: "abandoned"}`, consistent with cricket's DLS `win{method: "dls"}` (`cricket.ts` `applyAbandon` :1142). Consequences:
   - status stays `decided` (§5.4: no `core.forfeit` is active);
   - a double-elimination loser drops normally (it is not a forfeit loser, X-DE-1);
   - X-PS-2 counts it as a match.

   Task 4 builds this unless the owner rules otherwise. The alternative is a fifth award reason `"abandoned"`, which the spec does not list.
4. **The legacy settle replays into a throw.** A chess double forfeit that W2a held and an organiser then settled is stored as `boardgame.result{double_forfeit}` + `core.settle`. Under W2b the result folds to `double_walkover`. `settleApplies` is false for it, so the settle branch (`events.ts` :829-837, not gated on `strict`) throws `SETTLE_NOT_APPLICABLE` on every read of that fixture.

   **Decision D6:**
   - On a non-strict fold, a settle whose only failed precondition is a `double_walkover` outcome is tolerated, and the settlement wins.
   - A strict (write) fold refuses it.

   Both directions are tested, with one hand mutant per direction. Task 17's pre-ship count also counts such rows.
5. **A legacy double forfeit would re-derive as `decided`.** Spec §5.4 keys `forfeited` on an active `core.forfeit`. But the migration (§5.4, last bullets) sets `forfeited` on rows whose result is the legacy `boardgame.result{double_forfeit}`, which carries no `core.forfeit`. The next append's re-derivation would then flip such a row to `decided`.

   **Decision D7:** `forfeited` when a `core.forfeit` is active OR the outcome kind is `double_walkover`. The other kinds still follow the event.
6. **SQL cannot run the dead-seat cascade.** The spec says "re-classify … then run the dead-seat cascade for each" (§5.4). The cascade is TypeScript (`resolveBracketSeats`, `stages.ts:3861`).

   **Decision D12:**
   - The delta re-classifies and reports examined and changed counts (`raise notice`).
   - The seats resolve lazily: `resolveBracketSeats` runs on the next seat read.
   - A DB test proves that the walkover is seated after the migration's UPDATE, with no organiser step.
   - The pre-ship count (Task 17) reads these rows too.
7. **`division_has_results` alone moves; the status set does not.** W2b adds no fixture status, so the trigger's finished set and the partial index are already right. Spec §5.4 makes "redefine together" conditional on touching statuses.

   **Decision D13:** the delta redefines the function only. A test pins that every status the function's arms read is inside the partial index's WHERE and the trigger's finished set.
8. **`INVALID_PAYLOAD` does not exist** (spec §5.4 "Append guards", §7 last row). `git grep -n INVALID_PAYLOAD -- apps packages` finds nothing.
   - A bad core payload is refused `INVALID_EVENT` by `validateCoreEvent` (`E/core/errors.ts:8`).
   - `W/server/api-v1/http.ts:25` maps that to 422.

   The plan uses `INVALID_EVENT` / 422 for a free-text or unknown reason, and §7's row is recorded as false premise W2b-FP-1.
9. **The kernel cannot see a module's phases** (C-1). Module phase unions differ: football has periods plus SHOOTOUT; cricket has super_over; boardgame has tiebreak.

   **Decision D3:** `SportModule` gains:
   - a required `forfeitPhase(state): ForfeitPhase`, where `ForfeitPhase = "pre" | "play" | "tiebreak" | "over"`;
   - an optional `walkoverPhases?: readonly ForfeitPhase[]`, absent meaning `["pre"]`.

   The spec does not name SHOOTOUT or super_over. They map to `"play"`, which admits retired, disqualified and withdrew, and refuses walkover. This is owner question **Q5**, together with retired and DQ in chess `tiebreak`.
10. **The harness posts START before every walkover.**
    - `HM/lib/model/commands.ts:318-327` (`Walkover`);
    - `HM/lib/driver/http-driver.ts:263-269` (`forfeit`);
    - `HM/lib/streams/index.ts:100-101`.

    The phase guard refuses that composition. `HM/lib/streams/types.ts`' reason union is `"walkover" | "retired hurt"`, and `"retired hurt"` is out of vocabulary. Task 2 rewrites the composition: a walkover is posted before START; a retirement is posted after START and some play.
11. **`isForfeit` counts byes** (`E/competition/points.ts:57`): award, or win with method walkover/forfeit. W2b keeps that, so a bye is still a forfeit win for `PointsRule.forfeit` (Decision D14). `double_walkover` scores 0 and earns no bonus (X-DW-4).
12. **Generic has no abandoned phase.** `GenericState.phase` is `pre | live | done | final` (`generic.ts:79`), and an abandon goes to phase `done` with `no_result`. GN-AB-1 (replay, outcome null) needs an `"abandoned"` phase (Task 4).
13. **Auto-advance reads `finalized` as open** (spec §13 premise 9). `maybeAutoAdvance` counts open fixtures as `status <> 'decided' and status <> 'forfeited'` (`W/server/usecases/scoring.ts:844`). Task 1 reproduces it; Task 7 fixes it.
14. **The withdrawal reason is English free text** (`W/server/usecases/withdrawal.ts:74`, `REASON = "entrant withdrew"`). The strict schema refuses it, so it becomes `"withdrew"` (Task 8).
15. **The chess forfeit methods need two different treatments.** `boardgame.result{forfeit | double_forfeit}` stays schema-accepted for replay (spec §5.2), and must be refused on write.

    **Decision D15:** `module.apply` never sees `strict`, so the module cannot tell a write from a replay. The refusal therefore sits in the server's pre-fold append guards (`append-event.ts:313-365`), which every writer passes through: the console, the pad, event import and the API. The refusal is `INVALID_EVENT` with `data.reason: "chess_forfeit_method_retired"`. Replay is untouched.
16. **The touched Stryker families are all ten** (core, competition, modules and every `sports-*` family; `E/../stryker.groups.mjs` `STRYKER_FAMILIES`). So "touched families dispatched" is the same as `group=all`. For W2a the owner ruled that `group=all` is not a merge gate (2026-10-09). This is **Q6**.
17. **The merge notice's owed items** (`.superpowers/w2b-brainstorm/w2a-merge-notice.md`):
    - **N1, a silent hold.** Removed by R14: a pending tie-break now walks over. `WithdrawCascadeOut` still gains a `walked_over_held` count (Task 8).
    - **D-R9, the settle dialog offers a withdrawn entrant.** New rows can no longer reach that state. Legacy rows keep W2a's C17/D-R7 refusal, and Task 11 filters the withdrawn side out of the settle dialog's choices.
    - **Atomic withdrawal.** Stays W9 (ruling 101).
18. **Appendix A's "54 rows" is 53 new ids plus one amendment.** The cross-sport table lists 23 rows, one of which is the X-BR-1 amendment, so it holds 22 new ids. The sport files hold 31. Task 14 pins 53 new ids and checks the amended X-BR-1 text separately.
19. **`BRACKET_WALKOVER_KINDS` (`stages.ts:882`) has a second consumer.** Generation reads it at `:2314` for F14 (departed qualifiers keep their draw positions). Adding page_playoff and ladder to it would change generation for those kinds too, which the spec does not ask. The withdrawal path gets its own `WITHDRAWAL_WALKOVER_KINDS = BRACKET_WALKOVER_KINDS ∪ {page_playoff, ladder}` (Task 8), and `BRACKET_WALKOVER_KINDS` is unchanged.
20. **Boardgame already has an `abandoned` phase** (`boardgame.ts:725-730`): an abandon leaves the game undecided and flagged for replay. Task 3's `forfeitPhase` maps it to `over`.
21. **Struck-through rows.** `stages-panel.tsx:1904` `VOID_STATUSES = {cancelled, abandoned, forfeited}` renders a forfeited row struck through, so a `forfeited` double walkover inherits the strike. That is the right reading: nobody played and nobody advanced. Task 13 keeps it, and adds the UI-2 tag beside it so the strike is explained.

---

## Owner open questions (asked in chat before the task that needs each; class 17)

**ANSWERED 2026-10-09 — ruling 102: all seven as recommended; execution subagent-driven.**

| # | Question | Recommendation | Blocks |
|---|---|---|---|
| Q1 | Golden corpora: migrate recorded forfeit payloads by rule, then rebaseline? (finding 1) | Yes: a scripted event migration in its own commit, then an isolated `REBASELINE_GOLDEN=1` commit | Task 5 (loop D cannot close) |
| Q2 | Bench: may W2b edit `tools/bench/packs/build-packs/{suite11,_tiny}.ts` payloads? And who switches the bench's `award.method` readers (`run-suite.ts:1643`, R3-protected; `oracle.ts:1320`) to `reason`? (finding 2) | The payloads in W2b. The two readers go to the bench programme before W2b merges, or into the W2b PR with the bench owner's written approval | Task 10 Step 4 |
| Q3 | Award-policy abandon: `win{method:"abandoned"}`? (finding 3) | Yes | Task 4 |
| Q4 | Execution model: W2a's ruling 80 (Opus/Sonnet by role) has lapsed. Default is the frontmatter (`opus`, `xhigh` for implementer, reviewer and scout). Does the owner want a W2b ruling? | Keep the frontmatter default; no overrides | Task 0 |
| Q5 | Chess `tiebreak`: are retired and DQ admitted (the general "after start" rule)? Football/period SHOOTOUT and cricket super_over: read as play? (finding 9) | Yes to both | Task 3 |
| Q6 | Stryker: the touched families are all ten. Is a `group=all` dispatch a merge gate for W2b, or post-merge as in W2a? (finding 16) | Post-merge, as in W2a; the probe and every hand mutant gate the merge | Task 18 |
| Q7 | Pre-ship counts (Task 17): any non-zero count stops the ship and goes to the owner with the rows. | Ask only if non-zero | Task 18 |

---

## Pre-flight rulings (orchestrator, 2026-10-09 — binding on every dispatch; they amend the task text below)

The pre-flight scan (`.superpowers/sdd/2026-10-09-format-matrix-w2b/preflight.md`, 74 rows) found 12 conflicts. Each is
ruled with the spec as the authority. These are orchestrator rulings, not owner rulings; PF-6 and PF-7 add rule rows
and are reported to the owner at the end.

- **PF-1 (T3, T8; X-WD-1).** Guarantee 4 refuses any `core.forfeit` over a decided outcome. T3 adds a kernel-owned
  admission mirroring `core.settle`: `core.forfeit{reason:"withdrew"}` is admitted post-decision ONLY when
  `isLevelOutcome(outcome)` and no settlement is active; it folds to `award{winner: other, loser: by, reason:
  "withdrew"}` with retirement credit (the played score stands). `walkover`/`retired`/`disqualified` over any level
  outcome stay `ALREADY_DECIDED`. The server admits that write only from the withdrawal cascade on a `needs_decision`
  row; a `withdrew` forfeit over a league draw is refused (negative pair). Both in T3's guard sweep, one mutant each.
- **PF-2 (T11).** The console dialog never offers `withdrew` (spec §5.1: cascade-only). Tie-break chips are
  `[walkover, retired, disqualified]` (ruling 102 Q5). T7 adds a server append guard: `reason:"withdrew"` and
  `core.abandon{expunge:true}` are refused from every writer except the withdrawal cascade (`INVALID_EVENT` 422), with
  a test and a mutant.
- **PF-3 (T5).** The golden migration follows ruling 102 Q1 literally: a forfeit before any `core.start` → `walkover`,
  after → `retired`, in every sport (D3 R4 admits `retired` after start everywhere). No boardgame exception.
- **PF-4 (T8).** EVERY abandon the withdrawal cascade writes carries `expunge: true` — `voidAndAbandon` and the pending
  branch (`withdrawal.ts:157-161`). T8's D5 test seeds a pending table fixture for every sport and asserts zero table
  delta (cricket NR/DLS, Test draw, award-policy draw included).
- **PF-5 (T7; X-DW-2).** The D-G1 un-beaten guard in `completeStageIfReady` counts both entrants of a
  `double_walkover` fixture as out (added to `lost`), so a stage whose last fixture is a double walkover completes.
  Test plus mutant.
- **PF-6 (T4; CK-WO-1).** Unlimited-overs (Test/first-class) cricket has no Appendix A credit rule. Ruling: a walkover
  credits the result and its table points only; runs and overs credited are 0 and the match is excluded from NRR
  (NRR is undefined without a quota). CK-WO-1's limited-overs sweep filters unlimited cfgs out with a one-line reason
  and counts them; a separate test asserts this credit. T14 adds the rule row `CK-WO-2`.
- **PF-7 (T4, T15; X-WD-1/X-RS-2).** `withdrew` credit is phase-keyed: no `core.start` → walkover credit; after start
  (incl. over a held level result, PF-1) → retirement credit. T4 tests both, T15 models both, T14 adds rule row
  `X-WD-6`.
- **PF-8 (T7, T8).** (a) After X-WD-1 lands, X-WD-5's guard is reachable only from a pre-W2b held row: T8's sole X-WD-5
  witness forces one (`UPDATE` to the legacy held state, then settle); the E1 probe is re-titled to the walk-over
  path. (b) `loserFeederIsDead` delegates to `feederIsDead` (`stages.ts:3719`), so the double-walkover clause lives
  once in `feederIsDead`; the `dead-clause-loser` mutant becomes "`loserFeederIsDead` stops delegating", killed by
  X-DW-2's third-place case. The spec's "a clause in each" is met by the single-owner delegation (deviation recorded).
- **PF-9 (T7 → T8).** `STAGE_SEAT_DEPARTED` is implemented, tested and mutated in T8 (D-G3 corner 3), including D11's
  server-side name lookup and its copy test. T7 does not touch it.
- **PF-10 (T2, T3).** Lane P1 adds the new error codes to `HM/lib/driver/engine-http.ts` only after loop D is merged
  into the lane. T3 lists `tools/matrix/__tests__/engine-http.test.ts` as a carried red until P1 merges, if it reds.
  The "neither set intersects" bullet is wrong for that one file.
- **PF-11 (T9 → T13).** The match-centre check moves to T13, driven through `buildMatchCentre`: the positive
  double-walkover key, and status is not `needs_decision`. Loop F's gate carries no red.
- **PF-12 (T15).** The reference ↔ engine cross-check lives in `tools/matrix/__tests__/` (it depends on both, like W2a's
  `reference-bracket.test.ts`), not in `packages/engine`. It runs on `WT` after P2 and D merge.
- **PF-13 (T14, Step 0).** T14's id regex must match `X-` ids too (the count is 53 new ids + `CK-WO-2` + `X-WD-6`, plus
  the X-BR-1 amendment, asserted by count). `E/core/errors.ts`'s list ends at `:77`, not `:52`.

## Decisions

- **D1. The reasons.** `FORFEIT_REASONS = ["walkover", "retired", "disqualified", "withdrew"] as const` and `AWARD_REASONS = [...FORFEIT_REASONS, "bye"] as const` live in `E/core/events.ts`, beside `CoreForfeit`. `"bye"` is never accepted on `core.forfeit`; only the server's bye writers emit it (C-5).
- **D2. The outcome set.** `OUTCOME_KINDS = ["win", "draw", "tie", "no_result", "award", "double_walkover"] as const` lives in `E/core/types.ts`. `MatchOutcome` is the discriminated union over it:
  - `award = {kind, winner: EntrantId, loser: EntrantId | null, reason: AwardReason}`, with no `method` and no `score`;
  - `double_walkover = {kind}`.

  `isLevelOutcome` is unchanged (spec §5.1, f-w2 must #1).
- **D3. The phase guard** (finding 9). `forfeitPhase(state)` is required on `SportModule`, and `walkoverPhases?` is optional. The rule table is evaluated in this order, and the first matching rule decides:

  | Rule | When | Result |
  |---|---|---|
  | R0 | `forfeitPhase(state) === "over"` | not judged here; the module's own done/final guard and guarantee 4 answer as today |
  | R1 | `by === "both"` and `reason !== "walkover"` | refused, `INVALID_EVENT` (schema refinement) |
  | R2 | `reason === "walkover"` and phase not in `walkoverPhases ?? ["pre"]` | refused, `FORFEIT_REASON_WRONG_PHASE` |
  | R3 | `by === "both"` and phase `"tiebreak"` | refused, `FORFEIT_REASON_WRONG_PHASE` (R14: the classical game was played) |
  | R4 | reason `retired` or `disqualified`, and phase `"pre"` | refused, `FORFEIT_REASON_WRONG_PHASE` |
  | R5 | reason `withdrew` | admitted in any phase other than `over` |

  - **Boardgame** declares `walkoverPhases: ["pre", "play", "tiebreak"]`. Chess walkovers may also be recorded in `play` (FIDE Laws Art. 6.7.1, D-P1) and in `tiebreak` (R14).
  - **During a stoppage**, retired, disqualified and withdrew are admitted. A walkover there follows R2 against the phase the stoppage interrupted.
  - **Placement in `foldMatchWithStoppage`:** after `validateCoreEvent`, after guarantee 4 and after the stoppage `WRONG_PHASE` check; before the module apply. The guard runs on every fold, strict or not. Recorded streams are migrated (Task 5), and none exist in staging or prod if Task 0's count is 0.
- **D4. The abandon guard.** `core.forfeit` while `abandonActive` (an unvoided `core.abandon`) → `ABANDONED_SETTLE_OR_VOID`. It sits ABOVE guarantee 4, because a football award-policy abandon decides the match and guarantee 4 would answer `ALREADY_DECIDED` first. A void of the abandon clears `abandonActive`, because voids resolve first (`resolveVoids`). So void-then-forfeit is admitted, and the reason must be retired, disqualified or withdrew, since play started (X-AB-4).
- **D5. The expunge flag.** `CoreAbandon = {reason, expunge?: true}`. `foldMatchWithStoppage` returns `expunged: boolean`, which is true while an active abandon carries `expunge: true`. `outcomeOf(module, {state, settlement, expunged})` returns `null` while `expunged` is true. Only the withdrawal cascade writes it.
- **D6. The legacy settle** (finding 4). On a non-strict fold, a `core.settle` over a `double_walkover` outcome is tolerated and the settlement wins. A strict fold refuses it with `SETTLE_NOT_APPLICABLE`.
- **D7. The status rule** (spec §5.4 order, plus finding 5). It stays ONE function, `fixtureStatusFromFold(outcome, active, stageKind)`, and the first matching rule decides:

  | Order | Condition | Status |
  |---|---|---|
  | 1 | an active `core.settle` | `decided` |
  | 2 | an active `core.abandon` with outcome `null`, or with a level outcome in a `forbidsLevelResult` kind | `abandoned` |
  | 3 | a level outcome in a `forbidsLevelResult` kind | `needs_decision` |
  | 4 | an active `core.forfeit`, or outcome kind `double_walkover` | `forfeited` |
  | 5 | any other outcome | `decided` |
  | 6 | no outcome | `in_play` / `scheduled`, as today |

  `finalized` keeps coming from `nextStatus` on `core.finalize`, as today.
- **D8. Award-policy abandon** (Q3): `win{winner, loser, method: "abandoned"}`. A level abandon gives `draw` with the real score in draw kinds, and is held in brackets by D7 rule 2 (FB-AB-1).
- **D9. `forfeitCredit`.**
  ```ts
  export type ForfeitBy = "home" | "away" | "both";
  export interface ForfeitCredit {
    /** home, away: the metrics this match credits each side, in the module's own metric keys. */
    readonly perSide: readonly [Readonly<Record<string, number>>, Readonly<Record<string, number>>];
    /** metric keys this match must not feed into a ratio tie-break (set %, game %, NRR, goal ratio). */
    readonly excluded: readonly string[];
  }
  // on SportModule<Cfg, Ev, State>:
  forfeitCredit(cfg: Cfg, state: State, reason: AwardReason, by: ForfeitBy): ForfeitCredit;
  ```
  - `by` is the offending side. `"both"` is the double walkover.
  - `standingsDelta` maps the outcome's `loser` entrant to a side through its existing `ctx` lineups.
  - `"bye"` returns exactly the delta a bye gets today, pinned per sport before the change.
- **D10. Model commands.** `Forfeit {by: "home" | "away" | "both", reason}` is OPT-IN in the model, like W2a's Settle: `modelCommands({ forfeit: true })`. This keeps every committed fast-check regression replaying unchanged. The existing `Walkover` command keeps its kind name and loses its START.
- **D11. `STAGE_SEAT_DEPARTED`** carries `data: {reason: "seat_departed", entrantId, fixtureId}`. Its copy names both, reading names server-side, so no id is shown.
- **D12. The migration** (finding 6): re-classify and report the counts; the seats resolve lazily. The version is chosen at merge time (Task 9 Step 1), never hard-coded.
- **D13. `division_has_results`** (finding 7): the function only, plus a coverage test against the trigger and the index.
- **D14. Points.** `isForfeit` is unchanged for `award`, byes included. `double_walkover` → `applyPointsRule` gives 0 to both and applies no bonus, `forfeit_loss` included: nobody forfeited TO anyone (X-DW-4).
- **D15. Retiring the chess forfeit methods** (finding 15): `boardgame.result{forfeit | double_forfeit}` is refused by the append guard on write (Task 7). Replay keeps reading it.
- **D16. Generic abandon** gets an `"abandoned"` phase, with outcome `null` (GN-AB-1). Carrom already has the phase and changes its outcome to `null` (CA-AB-1).
- **D17. The TBD seat (X-WD-3), if Task 1 reproduces the throw.** The cascade un-seats the withdrawn entrant on a fixture whose other seat is still TBD and stamps `BYE_SLOT_LABEL`, so `awardSeededByes` → `advanceSettledByes` walks the arriving opponent over. This is the F14 departed-qualifier pattern (`walkoverDepartedQualifiers`, `stages.ts`). If Task 1 does NOT reproduce the throw, X-WD-3 is proved by a test of today's path and the premise is recorded false.
- **D18. Auto-advance.** The open count becomes `status not in ('decided','forfeited','finalized','cancelled')`. The decided-abandon and the forfeited double walkover are already covered by D7.

---

## Step 0 — anchors (main `a99147bd0`; re-open each before editing, a grep is not a read)

| Anchor | Pin |
|---|---|
| `CoreForfeit` | `E/core/events.ts:52`; `CoreAbandon` `:53`; `forfeitOf` `:68` |
| settle | `CoreSettle`, `SETTLE_METHODS`, `settledMethod`, `Settlement` `:100-118`; `settleApplies` `:129-135`; `outcomeOf` `:141-150`; `deciderPending` `:153-159` |
| kernel sets | `CORE_EVENT_SCHEMAS` `:162`; `KERNEL_OWNED_CORE` ~`:233`; `POST_DECISION_CORE` ~`:543`; `DURING_STOPPAGE` `:575-594` |
| fold | `foldMatchWithStoppage` `:629` (signature `:629-635`, `strict` `:699`, abandon flag `:818`, settle branch `:829-837`) |
| outcome types | `E/core/types.ts` `BRACKET_KINDS`/`DRAW_KINDS`/`forbidsLevelResult`; `isLevelOutcome` `:119-121`; `MatchOutcome` `:134-158` (doc `:150-156` on `award.method`); `StandingsDelta` `:178` |
| module interface | `E/sport/module.ts` `SportModule` `:690`; `standingsDelta` `:822`; `bracketDeciders` `:834` |
| error codes | `E/core/errors.ts` list ends `LEVEL_RESULT_SEATED` (`:52`) |
| football | `applyForfeit` `:1636-1651`; `awardScore` default `:123`; `abandonPolicy` `:174`; `applyAbandon` `:1655+`; `standingsDelta` `:2610`, exhaustive switch `:2623` |
| period | forfeit `:1430-1445`, abandon `:1447-1462`, `standingsDelta` `:2603+`/`:2616`; hockey `awardScore` `hockey.ts:134`; icehockey `icehockey.ts:175` |
| setbased | forfeit `:804-814`; `standingsDelta` default `invalid` `:2439`/`:2461` |
| nested | forfeit `:1375-1385`; `standingsDelta` `:2197-2216`; `METRICS` `:1452` |
| cricket | forfeit `:3775-3785`; `applyAbandon` `:1142`; award arm `:3913-3922` (`zeroLedger`); `ballsPerInnings` `:50` |
| carrom | forfeit `:453-463`; abandon `:467-472`; `sideLedger` `:481`; `standingsDelta` `:941-969` |
| boardgame | `BoardgameResult` `:140-146`; `decideResult` `:282-310`; `core.forfeit` `:710-723`; `standingsDelta` `:807-855` |
| generic | `sideLine` `:205-222`; phase union `:79`; forfeit `:562-569`; abandon `:570-575`; `standingsDelta` `:615+`/`:624` |
| forfeit reason test | `E/core/forfeit-reason.test.ts` (#772, `CARRIES_ITS_OWN_METHOD`) |
| competition | `E/competition/stage.ts` `SETTLED`/`COUNTS_FOR_STANDINGS` `:24`, `bracketRanks`, withdraw helpers `:412-472`; `E/competition/points.ts` `isForfeit` `:57` |
| append | `W/server/engine-db/append-event.ts` `LOCKED_FIXTURE_STATUSES` `:108`, `nextStatus` `:125`, `fixtureStatusFromFold` `:148-166`, null-seat refusal `:205-209`, pre-fold guards `:313-365` |
| seating | `W/server/engine-db/fed-seats.ts` `advancingSides` `:97-103`, `isCascadeWalkover` `:115-117`; `level-seat.ts` `SEATING_STATUSES` `:6`, `assertNoLevelSeat` `:14-22` |
| competition (web) | `W/server/engine-db/competition.ts` `BYE_PHANTOM` `:83`, `awardByeDelta` `:91-118`, `bracketWinnerLoser` `:156`, `completeStageIfReady` `:588` (D-G1 guard `:666-690`) |
| recorded abandon | `W/server/engine-db/recorded-abandon.ts` (`hasActiveAbandonSql`, `abandonAwaitsSettle`, `bracketEngineStatus`) |
| withdrawal | `W/server/usecases/withdrawal.ts` `bracketWithdrawalStatus` `:49`, `REASON` `:74`, `deciderOwed` `:78-81`, `WithdrawCascadeOut` `:83`, `voidAndAbandon` `:107`, `applyUpdate` `:135`, `withdrawEntrantCascade` `:169`, walkover branch `:230` |
| stages | `W/server/usecases/stages.ts` `BRACKET_WALKOVER_KINDS` `:882`, Swiss bye `:1295`, generator bye `:2545`, `awardSeededByes` `:3613`, `feederIsDead` `:3679`, `loserFeederIsDead` `:3714`, `seatFeederIsDead` `:3739`, `resolveBracketSeats` `:3861` |
| scoring | `W/server/usecases/scoring.ts` organiser gate `:511`, `onDecided` seat `:750`, `maybeAutoAdvance` `:835` (open count `:844`) |
| organiser-only | `W/lib/organiser-only-events.ts` (`ORGANISER_ONLY_EVENT_TYPES`, `ORGANISER_ONLY_SPORT_EVENTS`, `isOrganiserOnlyEvent`); test `W/server/usecases/__tests__/organiser-only-events.test.ts:10-13` |
| status map | `W/lib/fixture-engine-status.ts` |
| V432 | `db/migration/deltas/V432__fixture_status_needs_decision.sql` (check `:7-9`, trigger `:19-31`, backfill `:47-52`, `division_has_results` `:70-80`, index `:84-87`); test `W/server/__tests__/v432-needs-decision-migration.test.ts` |
| `division_has_results` callers | `W/server/usecases/division-slots.ts:43`, `:68`; `admin-divisions.ts:36`; `divisions.ts:245`, `:434`, `:554` |
| console | `W/components/v2/fixture-console.tsx` `decided` `:839`, `held` `:851`, `offerOrganiserActions` `:860`, `ForfeitButton` `:1571`; `needs-decision.tsx` |
| public | `W/server/public-site/match-centre.ts:757-758` (`award` → `matchCentre.result.forfeit`); `qualification-view.ts:97-108`; `live-score.tsx:89-96`; `matches-hub/knockout-tab.tsx:75`, `:454`; `W/components/v2/stages-panel.tsx:1904` (`VOID_STATUSES`), `:1994-2001` |
| pad | `W/components/v2/scorepad/v3/skins/boardgame.tsx:152-169` (`DECISIVE_METHODS`/`DRAWN_METHODS`), `buildDock` `:524`; `W/lib/event-copy.ts:110-113`; `scorepad/v3/ribbon.ts:111`; `W/lib/scoring-vocab.ts:85`, `:546`, `:632-635`, `:1315` |
| harness | `HM/lib/observed.ts:163-171` (`toObservedOutcome`); `HM/lib/streams/types.ts`; `HM/lib/streams/index.ts:100-101`; `HM/lib/streams/boardgame.ts:14-20` (M7); `HM/lib/model/commands.ts:318-327`, `:483`; `HM/lib/model/state.ts:215`; `HM/lib/driver/http-driver.ts:263-269`; `HM/lib/driver/types.ts:213`; `HM/lib/scenarios/r4-withdrawal.ts`; `HM/lib/scenarios/index.ts:11` |
| reference | `REF/families/bracket-finish.ts` `LEVEL_KINDS` `:24`, `PlayResult` `:30`, `Status` `:39`, `WinMethod` `:42` |
| W2a pins W2b rewrites (merge notice) | `E/sports/boardgame/tiebreak.test.ts:46`, `:50`, `:218`; `W/server/usecases/__tests__/withdrawal-bracket-status.test.ts:41`, `:46`; `withdrawal-decider-hold.test.ts:89`, `:132`, `:165`; `W/components/v2/__tests__/fixture-console-authority-band.test.tsx:342`; `W/server/usecases/__tests__/dead-feeder-cascade.test.ts:1205`, `:1220`, `:1252`, `:1466`, `:1517`; `W/server/engine-db/__tests__/needs-decision-status.test.ts:43`; `v432-needs-decision-migration.test.ts`; `TR/w2a-repro/expect-77-rekeys.json` (the 5 boardgame R4 entries) |

The executor re-pins each anchor in the task that uses it, by opening the file. A moved line is recorded in the task report, not silently followed.

---

## Global Constraints

- **Worktree.** `WT` (`/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b`), branch `feat/format-matrix-w2b`.
  - Every shell command starts `cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && …`, because cwd resets to the main checkout between calls.
  - Never edit the main checkout. **Never `git stash`**: the stack is shared with the main checkout.
  - **No heredocs.** Write commit messages with the Write tool to `$TMPDIR/w2b-msg.txt`, then run `git commit -F "$TMPDIR/w2b-msg.txt" -- <paths>`. Every message ends with a blank line and the `Co-Authored-By:` line the committing agent's own system prompt gives.
- **Setup once (Task 0).**
  - `pnpm install --frozen-lockfile`.
  - Symlink `.env.local` and `apps/web/.env.local` from the main checkout. They must be symlinks, not copies: a copy makes DB suites skip while `total` stays the same.
  - Check that `readlink -f node_modules/@seazn/engine` resolves inside `WT`.
  - Symlink `.claude/agent-memory` and add it to the worktree's `info/exclude` (`seazn-local-env` §2).
- **Local env.** Follow `~/.claude/skills/seazn-local-env/SKILL.md` with `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh` and label `w2b`:
  - `$S up --label w2b --all`;
  - `eval "$($S env --label w2b)"`;
  - `psql "$DATABASE_URL" -Atc "show data_directory"` must equal the label's datadir; that path is `BENCH_EXPECTED_DATA_DIR`;
  - after a code change, `$S rebuild --label w2b`, never a second `up`;
  - `SMOKE_BASE=http://localhost:<port>`, never `127.0.0.1`;
  - `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` for every matrix browser run.
- **Local verification is ONLY the tests that cover the files you changed.** Never the full gate, the full vitest suite, the full e2e suite or `seazn-env gate` (owner 2026-09-28). Never a Playwright `-g` slice; run whole spec files (class 21).
  - **apps/web vitest**, where `<N>` is the task number:
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b/apps/web && rm -f "$TMPDIR/w2b-t<N>.json" && pnpm vitest run <paths> --reporter=json --outputFile="$TMPDIR/w2b-t<N>.json"; echo EXIT=$?
    ```
  - **Engine vitest:**
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b/packages/engine && rm -f "$TMPDIR/w2b-t<N>e.json" && pnpm vitest run <paths> --reporter=json --outputFile="$TMPDIR/w2b-t<N>e.json"; echo EXIT=$?
    ```
  - **Reference vitest:** the same, run from `packages/reference`, writing `$TMPDIR/w2b-t<N>r.json`.
  - **Harness vitest** (CI's own recipe):
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && rm -f "$TMPDIR/w2b-t<N>m.json" && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile="$TMPDIR/w2b-t<N>m.json" --testTimeout=30000 <paths>; echo EXIT=$?
    ```
  - **The judge, after every vitest run:**
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && jq -c '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,failedSuites:.numFailedTestSuites,files:[.testResults[].name]|length,names:[.testResults[].name]}' "$TMPDIR/w2b-t<N>.json"
    ```
    Green means all of these hold:
    - `failed == 0`;
    - `failedSuites == 0`;
    - `passed == total > 0`;
    - `files` equals the number of paths passed;
    - every name starts with `WT`.

    A **red** (TDD step 2) means:
    - `failed > 0`;
    - `failedSuites == 0`, because a suite that failed to collect is not a red;
    - each failure message is the assertion the step names, not a `TypeError` or `ReferenceError`. Read `.testResults[].assertionResults[] | select(.status=="failed") | .failureMessages[0]`.

    Paste the line into the task report and pin `total`. Never trust an `rtk` summary.
- **tsc and eslint, changed files only.**
  - Web: `cd WT/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.json; echo EXIT=$?`.
  - Engine: `cd WT/packages/engine && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit; echo EXIT=$?`.
  - Harness: `cd WT && rtk proxy node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json; echo EXIT=$?`.
  - eslint: `cd WT && rtk proxy ./node_modules/.bin/eslint <changed files>; echo EXIT=$?`. It is clean only with `EXIT=0` and no `✖`.
- **`grep -a` always**, through `rtk proxy grep -a …` when the full output matters. Prefer `git grep -n` with `':!*.golden.json'`: a zsh glob in `--include` fails "no matches found".
- **Golden corpus** (`E/testkit/GOLDEN-POLICY.md`). Only Task 5 touches it, and only through its two isolated commits (Q1). `EXTEND_GOLDEN=1` is the only other mode allowed, for a new outcome a coverage stream needs. Every new cfg field is `.optional()` with no default. Hockey's `awardScore` default change (3 → 5) is a preset change, so the corpus' hockey states move, and Task 5 owns that.
- **Strings** (R23). Every new user-facing string goes into `W/dictionaries/{en,fr,es,nl}/` in the same commit, then `pnpm i18n:gen-keys` (root), then `pnpm i18n:check`. `i18n-keys.ts` is generated and never hand-edited. Abbreviations are per locale (UI-2).
- **Boundary.**
  - `packages/reference` imports `@seazn/engine` only as `import type` from `@seazn/engine/core` (R7), and nothing from `apps/web`.
  - `tools/` is never imported by `apps/`, `packages/` or `scripts/`.
  - A client component never imports a server module.
- **Do not touch:**
  - `tools/bench/lib/suites/run-suite.ts` and `PackSchema` (R3);
  - committed `TR/**` evidence, except Task 16's removal of the five rekeys, which the merge notice authorises;
  - `.github/workflows/e2e.yml`;
  - any golden file outside Task 5;
  - the spec (`docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md`). A spec disagreement is a Plan-time finding or a task-report row.
- **Test authority** (TEST-STRATEGY rules 1–10; R9, R13, R16, R25, R26, R28, R29).
  - **Empty case first.** Every task lists its state transitions with its empty case first: a second call, an empty input, after a withdrawal or void, and another sport.
  - **Expected values** come from **Appendix A** and the rulebooks, and from the engine's declarations:
    - `FORFEIT_REASONS`, `AWARD_REASONS`, `OUTCOME_KINDS`, `BRACKET_KINDS`, `DRAW_KINDS`;
    - the module's `configSchema` and `declaredCfgs` (best-of, set targets, overs, `awardScore`);
    - `metrics`, `walkoverPhases`.

    Never from the module's own `forfeitCredit` output. A credit test computes its expectation from the cfg with the Appendix A rule, written out in the test.
  - **Anti-vacuity.** Every sweep returns its count, and **zero checked is a failure**. Sport sweeps go through `forEachSport` (R26). A single-sport test carries a one-line reason, and `pnpm matrix:single-sport --check --against HEAD^1` stays green.
  - **The old-constant case.** Each credit rule has at least one case where the right answer differs from the old constant:
    - football 0-5 retirement stays 0-5, not 0-3;
    - hockey walkover 5-0, not 3-0;
    - 3-set volleyball credits 2-0 sets × 25-0;
    - tennis credits straight sets for set % and excludes games;
    - table tennis credits games-to-win × 11-0;
    - badminton 2-0 × 21-0;
    - carrom games-to-win × 25-0;
    - cricket charges the defaulter its full quota at 0 runs;
    - chess walkover before start is 1-0;
    - generic is win points, 0-0.
  - **Budgets** are stated from the work: `const BUDGET_MS = Math.max(5_000, cases * PER_CASE_MS * 5)`.
- **Mutation, per member** (R17; spec §9), always through the W2a tooling.
  - **Hand mutants.** Each task's mutation step lists `{id, file, find, replace, killers:[{cwd, files, name}]}` in `MUT/t<N>.json`. `name` is a vitest `-t` **regex**: escape `( ) [ ] . * + ? |`. Then run:
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && pnpm mutate --list docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2b/t<N>.json --json-out "$TMPDIR/w2b-mut-t<N>.json"; echo EXIT=$?
    ```
    Expected: `EXIT=0`, every row `KILLED by <test names>`, 0 survived, and the file restored byte-identical. A `COLLECT_FAILED` killer is not a kill. Paste the table into the task report.
  - **Changed-lines Stryker** (engine code only), with `TASK_BASE` = the commit the orchestrator recorded before dispatching the loop:
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b/packages/engine && rm -f reports/mutation/changed.json && M="$(node scripts/stryker-changed.mjs --base "$TASK_BASE")" && STRYKER_MUTATE="$M" pnpm mutation > "$TMPDIR/w2b-stryker-t<N>.log" 2>&1; echo EXIT=$?; node scripts/stryker-changed.mjs --report reports/mutation/changed.json --expect "$M"
    ```
    Expected: `survived: 0, noCoverage: 0`. A survivor gets a killing test, or an equivalence row the reviewer agrees with. Never `// Stryker disable`. Exit 2 with zero mutants means "no mutable lines"; record it.
  - **One member at a time:** per reason, per phase, per outcome kind, per stage kind. Two guards that cover for each other are separate mutants.
- **Truth runs during development cover only the W2b cells.** The selection file is `TR/w2b-local-selection.json`: `{ "cases": [{ "layer", "only", "scenario" }], "browserShards": {"L1": [], "L2": []}, "newScenarios": [<keys>] }`. Task 1 writes `cases`; Task 2 writes `newScenarios`. The command is W2a's Global Constraints truth-run command, with `w2a` replaced by `w2b` throughout and `$OUT` = `$TMPDIR/w2b-local-<tag>`. Every line prints `EXIT=0` or `EXIT=1`; `EXIT=2` or `EXIT=3` is an environment fault. The **full** `matrix:judge regression` runs ONCE, on CI (Task 16).
- **Rule-10 sequences.** Every ordered-action surface this wave touches gets a fast-check sequence test with invariants checked after every step:
  - the fold, over forfeit, abandon, void, settle and finalize;
  - the withdrawal cascade;
  - the model's Forfeit.

  The sequence alphabet must reach every one of these:
  - forfeit after abandon;
  - void then forfeit;
  - double walkover then void;
  - withdraw before and after start;
  - a second forfeit;
  - both sides withdrawing in turn;
  - a tie-break withdrawal.

  A shrunk failure becomes a named regression case with its seed, committed **before** the fix (R29).
- **The four test types per task** (RULES.md): unit, e2e, smoke, regression. A task with no literal UI traces its E2E forward to a named later spec file. Smoke and regression are owed per task, or traced to Task 18's `walkoverCreditSuite` and Task 16's judge regression, by name.
- **The repro probes** (Task 1). `W2B_REPRO=1` gates two probe files. Every task that fixes a probe's gap runs its probes with `W2B_REPRO=1` and expects that id green. Task 16 removes the gate, so the probes become permanent regression tests.
- **Docs as they happen** (R22). Each task's commit updates `IDX`'s W2 row and "False premises found (W2b)" when it found one. Lanes report their `IDX` lines to the orchestrator instead of writing them.

---

## Review Focus

Five inputs the spec implies but no requirement names. Each line's test is written into the owning task.

1. **The organiser voids a double walkover whose cascade already seated a walkover winner in the next match.** The seat must empty and the fed fixture go back to waiting. If the next match has started, the void is refused `NEXT_MATCH_STARTED` and nothing changes. Test: Task 7, `double-walkover-seating.test.ts`, "Review Focus 1: void of a double walkover un-seats the walkover it caused".
2. **The organiser records a walkover against the wrong side, voids it, and records the other side.** Only the active forfeit credits. The table delta is the second side's, never both, and the old winner's seat in the next match is released. Test: Task 3 `forfeit-guard.test.ts` rule-10 sequence, plus Task 7 "Review Focus 2: void then the other side's walkover".
3. **A hockey fixture whose cfg was frozen before W2b** (`awardScore.goals = 3` in the snapshot) is walked over after deploy. It credits the frozen 3-0, because X-WO-1 derives credit from the stage's own cfg. A fixture created after deploy credits 5-0. Test: Task 4 `forfeit-credit.test.ts`, "Review Focus 3: a frozen hockey cfg keeps its 3-0".
4. **Two organisers record a forfeit on the same fixture at once, or one double-submits the dialog.** Exactly one is accepted. The second is refused `ALREADY_DECIDED` or `SEQ_CONFLICT`, the dialog shows the reason, and the table counts one result. Test: Task 11 e2e `forfeit-dialog.spec.ts`, "Review Focus 4: double submit records one forfeit".
5. **An entrant with a held fixture AND a later fixture fed by it withdraws.** The held fixture walks over to the opponent, who is seated in the next match; the withdrawn entrant is never seated. `walked_over_held` counts 1. Test: Task 8 `withdrawal-w2b.test.ts`, "Review Focus 5: X-WD-1 walk-over seats the remaining side in the next match".

---

## Execution model

- **Defaults.** Models and effort come from `.claude/agents/*.md` (today `implementer`, `reviewer` and `scout` are all `model: opus`, `effort: xhigh`) and `docs/superpowers/RULES.md`. **No dispatch sets `model:`.** Ruling 80 (W2a's Opus/Sonnet split) applied to W2a only. Q4 asks the owner whether W2b wants its own ruling. If the owner rules one, it is recorded in `IDX` as a numbered ruling before the first dispatch, and this section is amended by the orchestrator, not by an agent.
- **Dispatch contents.** Every dispatch carries five things (AGENTS.md):
  - exact file paths;
  - acceptance criteria (the task's red and green);
  - what NOT to touch;
  - the verify command;
  - an output cap: "final message under 15 lines — counts, paths, deviations, blockers; no file contents or diffs".
- **Raw counts.** The orchestrator never accepts "done, tests pass" without the judge's raw JSON line. It re-runs the scoped gate itself at each loop boundary.

## Loops and lanes

Eight reviewed loops (P1, P2, D, F, S, H, C, R) and two unreviewed evidence runs (E1, E2), plus Task 0 run by the orchestrator. That is 19 tasks (0–18) in 11 units of work.

| Loop | Tasks | Spec sections it covers | Where | Waits on |
|---|---|---|---|---|
| — (orchestrator) | 0 setup, owner questions, early pre-ship read | §3 (rulings), §5.4 pre-ship (A1, R12), §10.6 | `WT` | nothing |
| E1 | 1 reproduce first | §8.2 (incl. inherited R4 ×5, Swiss chess 422), §13 premises 8, 9 | `WT` | Task 0 |
| **P1** (lane) | 2 harness generators, model Forfeit, observed `double_walkover`, M7 | §5.6 harness, §8.1 | worktree `format-matrix-w2b-harness` | Task 0. The lane's repro run (Step 6) runs against the UNFIXED branch, so it starts before loop D merges into the lane. Its unit-test gate runs after D is merged into the lane |
| D | 3 engine core; 4 sport modules; 5 golden migration (Q1); 6 engine competition readers | §5.1, §5.2, §5.3 (engine half), §9 pins (`forfeit-reason.test.ts`, `tiebreak.test.ts`, BG-KO-1) | `WT` | E1 committed; Q1, Q3, Q5 answered |
| **P2** (lane, a DIFFERENT agent from D's implementer) | 15 reference families | §5.6 reference, §1 done-means 3 | worktree `format-matrix-w2b-reference` | Task 0. Inputs: Appendix A, the rulebooks, the Interfaces frozen in this plan. Its cross-check step waits on D merged into the lane |
| F | 7 server: status, guards, organiser list, byes, readers, auto-advance; 8 withdrawal cascade; 9 migration + `division_has_results` | §5.3 (web half), §5.4, §7 | `WT` | D merged |
| S | 10 vocabulary blast-radius sweep (apps, scripts, e2e, bench packs) | §5.1 "every caller enumerated", finding 2 | `WT` | F merged; Q2 for its bench step |
| H | 11 console dialog (UI-1); 12 pad dock and event copy; 13 public tags (UI-2) | §5.5, §7 copy | `WT` | S merged |
| C | 14 rules rows (54, X-BR-1 amended) | §6, Appendix A | `WT` | H merged (every proving test exists) |
| E2 | 16 truth run and CI judge, `MATRIX.md`, rekeys; 17 pre-ship counts; 18 ship gates and PR | §8.3–5, §9, §10, §5.4 (R12, A1) | `WT` | C, P1, P2 merged |
| R | whole-branch review | §1 done-means 1–4 | read-only | E2's CI dispatches green |

- **Batching.** Same-file tasks share one loop:
  - **D:** `events.ts`, `types.ts`, `module.ts` and every module file.
  - **F:** `append-event.ts`, `stages.ts`, `competition.ts`, `scoring.ts`, `withdrawal.ts`.
  - **H:** the 4 dictionaries, `scoring-vocab.ts` and `fixture-console.tsx`.
- **Why D, F, S, H and C are sequential, not parallel.**
  - Each later loop's tests fold through the earlier loop's types.
  - S's sweep edits tests that F also edits.
  - H reads F's statuses.
  - None of these file sets is provably disjoint.
- **Lanes.** P1's set is `HM/**`; P2's is `packages/reference/**`. Neither set intersects any loop's files.
  - **P1** must not touch `HM/lib/fold.ts` or `HM/lib/model/ledger-fold.ts`. If an engine type change forces an edit there, loop D makes it (W2a C9).
  - **P2** shares nothing.
  - Lanes branch from `feat/format-matrix-w2b` and merge back with a merge commit, never a squash. The lane's scoped gate is re-run on the merged tree:
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && git worktree add ../format-matrix-w2b-<lane> -b feat/format-matrix-w2b-<lane> feat/format-matrix-w2b; echo EXIT=$?
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && git merge --no-ff feat/format-matrix-w2b-<lane> -m "Merge lane <lane> into W2b"; echo EXIT=$?
    ```
  - Each lane worktree gets its own `pnpm install --frozen-lockfile` and `.env.local` symlinks.
  - A lane edit outside its file set stops the lane. Sequence it instead (R2).
- **Lane-owned shared files.** `IDX`, `TR/plans.lock.json`, `TR/w2b-local-selection.json` and `MATRIX.md` are written only on `WT`. A lane reports its lines and the orchestrator commits them.

## File structure

| Path | Responsibility | Task |
|---|---|---|
| `MUT/t<N>.json` | each task's hand-mutant list | every task |
| `TR/w2b-repro/**`, `TR/w2b-local-selection.json` | reproduction evidence; the W2b cell selection | 1, 2 |
| `E/core/w2b-repro.probe.test.ts`, `W/server/__tests__/w2b-repro.probe.test.ts` | the gap probes (gated until Task 16), later permanent regressions | 1, 16 |
| `HM/lib/streams/{types,index,boardgame}.ts`, `HM/lib/model/{commands,state}.ts`, `HM/lib/observed.ts`, `HM/lib/driver/{http-driver,browser-driver,types}.ts`, `HM/lib/scenarios/{common,r4-withdrawal,w2b-forfeit-credit}.ts`, `HM/lib/scenarios/index.ts` | generator breadth, model Forfeit, observed `double_walkover`, M7 | 2 |
| `E/core/events.ts`, `E/core/types.ts`, `E/core/errors.ts`, `E/sport/module.ts` | reasons, outcome set, `advancesNobody`, the phase and abandon guards, expunge, legacy settle, 4 error codes, `forfeitCredit`/`forfeitPhase`/`walkoverPhases` on the interface | 3 |
| `E/core/outcome-set.test.ts`, `E/core/forfeit-guard.test.ts`, `E/core/forfeit-reason.test.ts` (rewritten) | the pinned set; the guard sweep and rule-10 sequence; the reason-in-outcome pin | 3 |
| every module under `E/sports/**` | `forfeitPhase`, `walkoverPhases`, `forfeitCredit`, `standingsDelta` arms, abandon changes, player-stat folds, `arbitraryEvent` legality | 4 |
| `E/sport/forfeit-credit.test.ts`, `E/sport/double-walkover.test.ts`, `E/sport/player-stats-forfeit.test.ts` | per-sport credit, double walkover, stats sweeps | 4 |
| `E/sports/**/<key>.golden.json`, `E/testkit/golden-forfeit-migration.ts` (+ test) | event-payload migration, then rebaseline | 5 |
| `E/competition/{points,stage}.ts`, the tie-break readers | `double_walkover` in tables, `excluded` honoured | 6 |
| `W/server/engine-db/{append-event,fed-seats,competition,level-seat,recorded-abandon}.ts`, `W/server/usecases/{stages,scoring}.ts`, `W/lib/{organiser-only-events,fixture-engine-status}.ts`, `W/server/api-v1/http.ts`, `W/lib/scoring-vocab.ts`, `HM/lib/driver/engine-http.ts` (the codes, restated by lane P1) | server status, guards, byes, readers, auto-advance | 7 |
| `W/server/usecases/withdrawal.ts`, `E/competition/stage.ts` (withdraw helpers) | withdrawal cascade (R8, R14, D-G2, D-G3, X-WD-5) | 8 |
| `db/migration/deltas/V<next>__w2b_double_walkover_and_results.sql`, `W/server/__tests__/w2b-migration.test.ts` | re-classify legacy chess double forfeits; `division_has_results` | 9 |
| `W/server/__tests__/forfeit-vocabulary-scan.test.ts` + every caller found | the vocabulary sweep with a counted source scan | 10 |
| `W/components/v2/forfeit-dialog.tsx`, `W/components/v2/fixture-console.tsx` | UI-1 console dialog | 11 |
| `W/components/v2/scorepad/v3/skins/boardgame.tsx`, `W/lib/event-copy.ts`, `W/components/v2/scorepad/v3/ribbon.ts`, `W/lib/scoring-vocab.ts` | pad dock and event copy | 12 |
| `W/lib/forfeit-tag.ts`, `W/server/public-site/{match-centre,qualification-view}.ts`, `W/components/public-site/matches-hub/knockout-tab.tsx`, `W/components/public-site/live-score.tsx`, `W/components/v2/stages-panel.tsx` | UI-2 public tags and sentences | 13 |
| `packages/engine/rules/{cross-sport,boardgame,carrom,cricket,generic}.md` + 7 new sport files | 54 rows, X-BR-1 amended | 14 |
| `REF/families/walkover-credit.ts` (+ test), `REF/families/bracket-finish.ts` (extended) | independent oracle | 15 |
| `TR/w2b-final/**`, `MATRIX.md` (regenerated), `TR/w2a-repro/expect-77-rekeys.json` (5 entries removed) | truth run and evidence | 16 |
| `apps/web/e2e/{forfeit-dialog,walkover-public}.spec.ts`, `apps/web/e2e/mobile.spec.ts`, `scripts/smoke.ts` (`walkoverCreditSuite`) | E2E, widths, smoke | 11–13, 18 |

---

### Task 0: Setup, the owner's questions, and an early pre-ship read

**Run by the orchestrator. No implementer.**

**Files:**
- Create: `MUT/` (directory only, with a `.gitkeep`; the task lists arrive with their tasks).
- Modify: `IDX` (only the owner's answers to Q1–Q7, each as a numbered ruling after 101).

- [ ] **Step 1: Set up the worktree** (Global Constraints, setup):
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && git log --oneline -1 && pnpm install --frozen-lockfile; echo EXIT=$?
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && ln -sf /Users/ashokhein/github/seazn.club/.env.local .env.local && ln -sf /Users/ashokhein/github/seazn.club/apps/web/.env.local apps/web/.env.local && readlink -f node_modules/@seazn/engine
  ```
  Expected: `EXIT=0`, and the engine path starts with `WT`.
- [ ] **Step 2: Confirm the W2a tooling exists. W2b builds no tooling.**
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && ls scripts/mutate.ts packages/engine/scripts/stryker-changed.mjs tools/matrix/w2a-expect.ts && grep -n '"mutate"\|"matrix:judge"\|"matrix:l3"\|"matrix:browser"\|"matrix:render"\|"test:smoke"\|"i18n:gen-keys"' package.json
  ```
  Expected: three paths and seven script lines. A missing one is a blocker, reported, not rebuilt.
- [ ] **Step 3: Put Q1–Q7 to the owner in chat** (class 17), each with its recommendation and the evidence from Plan-time findings 1, 2, 3, 9 and 16.
  - Record each answer in `IDX` as a numbered ruling (the next free numbers after 101), headed "W2b plan".
  - Loop D does not start until Q1, Q3 and Q5 are answered.
  - Task 10's bench step does not start until Q2 is answered.
  - No agent acts on an answer it heard second-hand.
- [ ] **Step 4: The early pre-ship read.** The same queries as Task 17, run now so a non-zero count reshapes the plan before any code. Use the Supabase MCP: `list_projects` first, then pick the staging and the production project by name. Only read-only `SELECT`s:
  ```sql
  select count(*) as forfeits,
         count(*) filter (where payload->>'reason' not in ('walkover','retired','disqualified','withdrew')) as out_of_vocab,
         count(*) filter (where payload->>'by' = 'both') as both_sides
    from score_events where type = 'core.forfeit';
  select count(*) as chess_forfeit_methods from score_events
   where type = 'boardgame.result' and payload->>'method' in ('forfeit','double_forfeit');
  select count(distinct s.id) as complete_stages_holding_one
    from fixtures f join stages s on s.id = f.stage_id
   where f.status = 'needs_decision' and s.status = 'complete';
  select count(*) as settled_double_forfeits
    from score_events r join score_events st on st.fixture_id = r.fixture_id and st.type = 'core.settle'
   where r.type = 'boardgame.result' and r.payload->>'method' = 'double_forfeit'
     and not exists (select 1 from score_events v where v.voids_event_id in (r.id, st.id));
  ```
  Record the eight numbers (four queries × two projects) in the Task 0 report and in `IDX`. Read them as follows:
  - `forfeits` non-zero on either project: STOP and bring the rows to the owner (W2b-A1). The strict schema cannot ship while stored events would fail to read.
  - `complete_stages_holding_one` non-zero: STOP and bring the rows (W2b-R12).
  - `chess_forfeit_methods` or `settled_double_forfeits` non-zero: the count is reported, and the migration (Task 9) and the D6 tolerance are tested against that shape.

  If the MCP is not connected, say so. The read is owed again at Task 17 regardless.
- [ ] **Step 5: Commit** `MUT/.gitkeep` and the `IDX` rulings: `docs(matrix): W2b plan — owner answers Q1–Q7 and the early pre-ship counts`.

---

### Task 1: Reproduce first — every W2b red, before any product change (spec §8.2)

**Run E1, unreviewed; the orchestrator re-checks every count. It runs before ANY product change on the branch.**

**Files:**
- Create: `E/core/w2b-repro.probe.test.ts`, `W/server/__tests__/w2b-repro.probe.test.ts`
- Create: `TR/w2b-repro/README.md`, `TR/w2b-repro/probes-engine.json`, `TR/w2b-repro/probes-web.json`, `TR/w2b-repro/L3/**` (copied run dirs), `TR/w2b-local-selection.json`
- Modify: `TR/plans.lock.json` (append only), `IDX` (the W2 row, "False premises found (W2b)")

**Interfaces:** none produced. The probes read TODAY's API only: event payloads as JSON, `foldMatchWithStoppage`, `outcomeOf`, `standingsDelta`, and the usecases. Every expected value comes from Appendix A.

- [ ] **Step 1: Bring up the env** (`$S up --label w2b --all`, then the `show data_directory` check).
- [ ] **Step 2: Write the engine probe file** `E/core/w2b-repro.probe.test.ts`. One `it` per gap id; each title starts with its id.

```ts
// W2b Task 1 — reproduction probes (spec §8.2). Each `it` asserts the Appendix A answer, so on main each is RED; the red
// is recorded with its gap id in TR/w2b-repro/ before any fix. Gated (W2B_REPRO=1) so the build's intermediate pushes
// stay green; every fixing task runs its probes green; Task 16 removes the gate and this file stays as a regression suite.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "./events.ts";
import { builtinModules } from "../sports/index.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import type { AnySportModule } from "../sport/module.ts";

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no module ${key}`);
  return m;
};
const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload } as never, voids);
/** Folds `build(H, A)` for `key` at `cfgIn` (parsed by the module's own schema) and returns the outcome and the [home, away] deltas. */
function play(key: string, cfgIn: unknown, build: (H: string, A: string) => EventEnvelope[], stage = "league") {
  const m = mod(key);
  const cfg = m.configSchema.parse(cfgIn ?? {});
  const l = defaultLineupPair(m.positions);
  const H = l.home.entrantId;
  const A = l.away.entrantId;
  const folded = foldMatchWithStoppage(m as never, cfg as never, l, build(H, A));
  const outcome = outcomeOf(m as never, folded as never);
  const deltas = outcome === null ? null : m.standingsDelta(outcome as never, cfg as never, { kind: stage } as never, folded.state as never);
  return { H, A, cfg: cfg as Record<string, unknown>, outcome, deltas };
}
const walkover = (by: (H: string, A: string) => string) => (H: string, A: string) => [ev(1, "core.forfeit", { by: by(H, A), reason: "walkover" })];

describe.runIf(process.env.W2B_REPRO === "1")("W2b reproduction probes (engine)", () => {
  it("H-13: a hockey walkover credits 5-0 (FIH GTR Reg 13.1), not 3-0", () => {
    const r = play("hockey", {}, walkover((_H, A) => A));
    expect(r.deltas?.[0].metrics).toMatchObject({ gf: 5, ga: 0 }); // HK-WO-1
  });
  it("F-16 / H-14 / I-16 / SC-S4: a side further down than the awarded score that retires keeps the real score (FDC 28.1; FB-RT-1, HK-RT-1, IH-RT-1)", () => {
    // Appendix A: awarded football 3, hockey 5, ice hockey 5; the real margin is the awarded one + 2, so it is worse for the offender.
    const AWARDED: Record<string, number> = { football: 3, hockey: 5, icehockey: 5 };
    let checked = 0;
    for (const [key, awarded] of Object.entries(AWARDED)) {
      const goals = awarded + 2;
      const r = play(key, {}, (H, A) => [
        ev(1, "core.start"),
        ...Array.from({ length: goals }, (_, i) => ev(2 + i, `${key}.goal`, { by: A })), // FootballGoal / PeriodGoal {by}
        ev(2 + goals, "core.forfeit", { by: H, reason: "retired" }),
      ]);
      expect(r.deltas?.[1].metrics, key).toMatchObject({ gf: goals, ga: 0 });
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("SC-S3: a 3-set volleyball walkover credits the winner 2-0 sets, each 25-0 (FIVB 6.4.1, VB-WO-1)", () => {
    const r = play("volleyball", { bestOf: 3 }, walkover((_H, A) => A));
    const setsToWin = Math.ceil(3 / 2);
    expect(r.deltas?.[0].metrics).toMatchObject({ sets_won: setsToWin, sets_lost: 0, points_won: setsToWin * 25, points_lost: 0 });
  });
  it("SC-S6: a double walkover is its own outcome in every sport (X-DW-1)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const r = play(m.key, Object.values(m.variants)[0] ?? {}, () => [ev(1, "core.forfeit", { by: "both", reason: "walkover" })]); // first declared variant (generic's {} does not parse)
      expect(r.outcome, m.key).toEqual({ kind: "double_walkover" });
      checked++;
    }
    expect(checked).toBe(11);
  });
  it("B-7: a chess walkover is recordable before the game starts (FIDE 6.7.1, BG-WO-2)", () => {
    const r = play("boardgame", {}, walkover((_H, A) => A));
    expect(r.outcome).toMatchObject({ kind: "award", winner: r.H });
  });
  it("B-9: a chess double forfeit is a double walkover in a league (BG-DW-1)", () => {
    const r = play("boardgame", {}, () => [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })]);
    expect(r.outcome).toEqual({ kind: "double_walkover" });
  });
  it("B-10: a chess double forfeit is a double walkover in a knockout, never held (BG-DW-1)", () => {
    const r = play("boardgame", { tiebreak: true }, () => [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" })], "knockout");
    expect(r.outcome).toEqual({ kind: "double_walkover" });
  });
  it("C-6: a carrom abandon is a replay — no outcome, no shared points (CA-AB-1)", () => {
    const r = play("carrom", {}, () => [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })]);
    expect(r.outcome).toBeNull();
  });
  it("CR-10: a cricket walkover charges the defaulter its full quota at 0 runs and leaves the winner's NRR alone (CK-WO-1)", () => {
    const r = play("cricket", { ballsPerInnings: 120 }, walkover((_H, A) => A));
    expect(r.deltas?.[0].metrics).toMatchObject({ runs_for: 0, balls_faced_eff: 0, runs_against: 0, balls_bowled_eff: 0 }); // the winner's NRR is unaffected
    expect(r.deltas?.[1].metrics).toMatchObject({ runs_for: 0, balls_faced_eff: 120 }); // the defaulter is charged its full quota
  });
  it("SC-S3-TN: a tennis walkover credits straight sets for set % and excludes the match's games (ATP 4.01 C.4, TN-WO-1)", () => {
    const r = play("tennis", {}, walkover((_H, A) => A));
    expect(r.deltas?.[0].metrics).toMatchObject({ games_won: 0, games_lost: 0 });
    expect((r.deltas?.[0].metrics.sets_won ?? 0) > 0).toBe(true);
  });
});
```

  Two notes on the stream:
  - Football's goal payload is `FootballGoal {by: EntrantId, …}` (`football.ts:214`). If the module refuses a goal before a period event, the stream is wrong, not red. Copy the stream prefix from `football.test.ts`'s own goal tests and record the change.
  - The probes read the metric keys from each module's `metrics` (`nested/kernel.ts:1452`, `carrom.ts:481`, and `zeroLedger` in `cricket.ts`). If a key differs, re-pin it from the module, never from a guess.
- [ ] **Step 3: Write the web probe file** `W/server/__tests__/w2b-repro.probe.test.ts`, gated `describe.runIf(process.env.W2B_REPRO === "1" && !!process.env.DATABASE_URL)`. Rigs use the usecases the buttons call:
  - `seedOrg("pro")`, `createCompetition`, `createDivision`, `createEntrants`, `createStages`, `startDivision`, `generateStageFixtures`, `scoreEvent`, `withdrawEntrantCascade`, `getFixtureState`;
  - the pattern is `W/server/usecases/__tests__/swiss-withdrawal-walkover.test.ts:60-112`, with the same `afterAll` client close.

  One `it` per gap. Each asserts the Appendix A answer:

  | Title (prefix = gap id) | Rig | Assertion |
  |---|---|---|
  | `ST-G1: a cricket DLS abandon in a league scores in the table (CK-AB-1)` | cricket t20 league of 2, `core.start`, legal balls to past `minOversForResult`, `core.abandon` | fixture status `decided`; `listStandings` gives the leader `won 1` |
  | `CR-2: a cricket rain no-result in a league is 1 point each and an NR (CK-AB-2)` | cricket league, `core.start`, `core.abandon` before the minimum | status `decided`; both rows `points 1` |
  | `ST-G1b: a football award-policy abandon with a leader is a win (FB-AB-1)` | football league with `abandonPolicy: "award"`, 1-0, abandon | status `decided`, standings win |
  | `C17: withdrawing from a held knockout fixture walks it over to the remaining side (X-WD-1)` | badminton knockout of 4; semi 1 reaches `needs_decision` through an abandon with a level outcome; the home side withdraws | the semi's status is `forfeited`, its outcome winner is away, and away is seated in the final |
  | `PP-WD: a page_playoff withdrawal walks over, never holds (X-WD-2)` | page_playoff of 4; q1 entrant withdraws | q1 `forfeited`, no `core.abandon` row |
  | `LD-WD: a ladder withdrawal walks the pending challenge over (X-WD-2)` | ladder of 4 with one pending challenge | the challenge is `forfeited` |
  | `X-WD-3: withdrawing from a fixture whose opponent is TBD does not throw (X-WD-3)` | knockout of 8 with seeded byes; withdraw a round-2 seat whose opponent is TBD | `withdrawEntrantCascade` resolves; the out-count names no error |
  | `CD-T13: a chess knockout withdrawal on an unstarted board walks over (BG-WO-2)` | boardgame classical knockout of 4, started, nothing played; withdraw S1 | resolves; S1's fixture `forfeited` |
  | `CD-T13-SW: a Swiss chess withdrawal on an unstarted board walks over (BG-WO-2)` | the chess copy of `swiss-withdrawal-walkover.test.ts`'s `pairedRoundOne` (`sport_key: "boardgame"`, `variant_key: "classical"`) | resolves (today 422 `WRONG_PHASE`) |
  | `DE-RK: a double-elimination forfeit loser is out; seating and ranks agree (X-DE-1)` | double_elim of 4; a winners'-bracket walkover | the loser is not seated in the losers' bracket, and `bracketRanks` places it eliminated in that round |
  | `AA-FIN: auto-advance treats a finalized fixture as finished (D18)` | 2-stage division (group → knockout, auto-advance on); finalize every group fixture | the knockout is seeded |
  | `X-WD-5: a settle never seats a withdrawn loser on a loser edge` | knockout with third place; a semi held; its loser withdraws; settle | the third-place seat is dead and the opponent walks over |

- [ ] **Step 4: Run both probe files with the gate open. Expect every probe RED.**
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b/packages/engine && rm -f "$TMPDIR/w2b-t1e.json" && W2B_REPRO=1 pnpm vitest run src/core/w2b-repro.probe.test.ts --reporter=json --outputFile="$TMPDIR/w2b-t1e.json"; echo EXIT=$?
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b/apps/web && rm -f "$TMPDIR/w2b-t1.json" && W2B_REPRO=1 pnpm vitest run src/server/__tests__/w2b-repro.probe.test.ts --reporter=json --outputFile="$TMPDIR/w2b-t1.json"; echo EXIT=$?
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && for f in "$TMPDIR/w2b-t1e.json" "$TMPDIR/w2b-t1.json"; do jq -c '{total:.numTotalTests,failed:.numFailedTests,failedSuites:.numFailedTestSuites,reds:[.testResults[].assertionResults[]|select(.status=="failed")|{t:.title,m:(.failureMessages[0]|split("\n")[0])}]}' "$f"; done
  ```
  - Expected: engine `total 10`, web `total 12`, `failedSuites 0`.
  - Every probe failed with an `AssertionError` or a named `EngineError` / `HttpError` (CD-T13: `WRONG_PHASE`; X-WD-3: today's throw), never a `TypeError` from the probe itself.
  - A probe that PASSES is a false premise. Record it in `IDX` and the README, and drop that row's fix from its owning task, keeping the test as a regression (D17 does this for X-WD-3).
  - Copy the two JSON files to `TR/w2b-repro/probes-{engine,web}.json`.
- [ ] **Step 5: The inherited matrix cells.** These are the 5 boardgame R4 cells (`TR/w2a-repro/expect-77-rekeys.json`, `wave: "W2b"`). Write `TR/w2b-local-selection.json` with:
  - `cases` = those five as `{layer:"L3", only:"<caseId minus |R4>", scenario:"R4"}`;
  - `browserShards: {L1:[], L2:[]}`;
  - `newScenarios: []`.

  Run the Global Constraints truth-run command with `<tag>` = `repro`. Then judge with W2a's judge, which already pins these five:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && R=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs && jq -r '.cases[] | select(.caseId|test("\\|boardgame\\|blitz\\|R4$")) | [.caseId,.verdict,(.reason // "")] | @tsv' "$TMPDIR/w2b-local-repro/L3/results.json"
  ```
  Expected: exactly 5 rows, each `red`, each reason containing `forfeit not allowed in phase` and `pre`. Copy the run dir to `TR/w2b-repro/L3/` and append its lock entry (`pnpm matrix:lock --append`, as in W2a Task 1).
- [ ] **Step 6: The evidence README** (`TR/w2b-repro/README.md`). It holds:
  - one table row per probe and cell: gap id, file and title, the red message's first line, and the owning task;
  - the commands above;
  - the env label and datadir.

  No `.txt` evidence: `committed-matrix.test.ts` refuses it.
- [ ] **Step 7: Prove the gate closes.** Without `W2B_REPRO`, both files collect with every test skipped, so CI stays green:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b/packages/engine && rm -f "$TMPDIR/w2b-t1g.json" && pnpm vitest run src/core/w2b-repro.probe.test.ts --reporter=json --outputFile="$TMPDIR/w2b-t1g.json"; echo EXIT=$?; jq -c '{total:.numTotalTests,failed:.numFailedTests,pending:.numPendingTests,failedSuites:.numFailedTestSuites}' "$TMPDIR/w2b-t1g.json"
  ```
  Expected: `EXIT=0`, `failed 0`, `failedSuites 0`, `pending 10`. If the repo's `check-vitest-collection` lists collected suites, add both probe files there.
- [ ] **Step 8: Four test types.**
  - Unit: the probes.
  - E2E: none in this task. The UI reds are proved by Task 11 and Task 13 specs, which are written first.
  - Smoke: traced to Task 18's `walkoverCreditSuite`.
  - Regression: the R4 cells, via Task 16's judge.

  No hand mutants: the task adds no guard.
- [ ] **Step 9: Commit** the probes, `TR/w2b-repro/**`, the selection, the lock entry and `IDX`: `test(w2b): reproduce the W2b reds before any fix — 22 probes and the 5 inherited R4 cells`.

---

### Task 2: Harness — generator breadth, the model's Forfeit, `double_walkover` observed, M7 (spec §5.6, §8.1)

**Lane P1, in worktree `format-matrix-w2b-harness`.** It starts after Task 0. Step 6 drives the new scenarios against the UNFIXED branch, which is the second half of reproduction. The unit-test gate (Step 7) runs after loop D merges into the lane.

**Files:**
- Modify:
  - `HM/lib/streams/types.ts` (`RequestedOutcome`: forfeit `reason` becomes the four reasons; new `double_walkover` request);
  - `HM/lib/streams/index.ts:100-101` (composition: a walkover before START; a retirement or DQ after START and at least one scoring event);
  - `HM/lib/streams/boardgame.ts:14-20` (M7: `levelRefusal` drops the double-forfeit text; a `double_walkover` request builds `core.forfeit {by:"both", reason:"walkover"}`).
- Modify:
  - `HM/lib/observed.ts:163-171` (`toObservedOutcome` learns `double_walkover` and `award{winner, loser, reason}`; `winnerOf` returns null for `double_walkover`);
  - `HM/lib/model/commands.ts:318-327` (`Walkover`: no START), new opt-in `Forfeit`; `modelCommands` `:483` gains `forfeit?: boolean`;
  - `HM/lib/model/state.ts:215` (`cascade` gains `doubleWalkover`).
- Modify:
  - `HM/lib/driver/{http-driver.ts:263-269,browser-driver.ts:966-969,types.ts:213}` (`forfeit(fixtureId, by: string | "both", reason: ForfeitReason, …)`; no START for a walkover);
  - `HM/lib/driver/engine-http.ts` (the four new codes and their HTTP statuses, restated as W2a D-C2 did).
- Modify: `HM/lib/scenarios/r4-withdrawal.ts` (`WALKOVER_MODEL`: the open formats walk over; a TBD seat goes dead).
- Create: `HM/lib/scenarios/w2b-forfeit-credit.ts` (`W2B_SCENARIOS`), registered in `HM/lib/scenarios/index.ts:11`.
- Create: `MUT/t2.json`.
- Tests: `HM/lib/__tests__/w2b-generators.test.ts`, `HM/lib/model/__tests__/forfeit-command.test.ts`, plus the existing harness tests that pin M7 (find with `git grep -n "double forfeit\|M7" -- tools/matrix`).

**Interfaces (frozen; loops D and F build to them):**
```ts
export type ForfeitReason = "walkover" | "retired" | "disqualified" | "withdrew";
export type RequestedOutcome =
  | /* existing win/draw/tie/level/tiebreak requests, unchanged */
  | { kind: "forfeit"; by: "home" | "away"; reason: ForfeitReason; at: "before_start" | "after_start" }
  | { kind: "double_walkover" };
export type ObservedOutcome =
  | { kind: "win"; winner: string; method?: string }
  | { kind: "award"; winner: string; loser: string | null; reason: string }
  | { kind: "draw" | "tie" | "no_result" | "double_walkover" };
// Model, opt-in (D10): modelCommands({ fences, bias?, settle?, forfeit? })
// Forfeit command: { kind: "Forfeit", by: "home" | "away" | "both", reason: ForfeitReason }
```

**The five new scenarios** (`W2B_SCENARIOS`, keys fixed here, since the selection and the judge read them):

| Key | Drives | Reaches |
|---|---|---|
| `WO-PRE` | every sport × every stage kind: a walkover before START on one fixture per round | X-RS-1, X-WO-1, BG-WO-2 |
| `RT-PART` | every sport: a retirement after partial play (at least one scoring event for each side where the sport allows) | X-RT-1, `*-RT-*` |
| `DW-ALL` | every sport × every stage kind, including a final, a last rung and a third-place match: a double walkover; in a final it expects the `DOUBLE_WALKOVER_NO_NEXT_MATCH` refusal and the fixture open | X-DW-1..4 |
| `AB-AWARD` | football, hockey and icehockey with `abandonPolicy: "award"`: an abandon leading, and an abandon level; cricket with an abandon past and before `minOversForResult` | X-AB-1, X-AB-2, CK-AB-1/2 |
| `WD-CASC` | withdrawal cascades: held, TBD, both withdrawn in turn, chess not started, tie-break pending | X-WD-1..5, BG-WO-3 |

- [ ] **Step 1: Write the failing harness tests.** `HM/lib/__tests__/w2b-generators.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateStream } from "../streams/index.ts";
import { toObservedOutcome } from "../observed.ts";
import { SPORT_KEYS } from "../sport-keys.ts"; // re-pin: the harness's own list of the 11 sport keys

const REASONS = ["walkover", "retired", "disqualified", "withdrew"] as const;

describe("W2b generator breadth (spec §5.6)", () => {
  it("empty case first: a walkover request before start posts no core.start", () => {
    const s = generateStream({ sportKey: "generic", cfg: {}, outcome: { kind: "forfeit", by: "away", reason: "walkover", at: "before_start" } } as never);
    expect(s.map((e) => e.type)).toEqual(["core.forfeit"]);
  });
  it("X-RS-1: every sport builds a walkover before START and a retirement after START, with reasons from the closed list only", () => {
    let checked = 0;
    for (const sportKey of SPORT_KEYS) {
      const pre = generateStream({ sportKey, cfg: {}, outcome: { kind: "forfeit", by: "away", reason: "walkover", at: "before_start" } } as never);
      expect(pre[0]?.type, sportKey).toBe("core.forfeit");
      const post = generateStream({ sportKey, cfg: {}, outcome: { kind: "forfeit", by: "home", reason: "retired", at: "after_start" } } as never);
      expect(post[0]?.type, sportKey).toBe("core.start");
      expect(post.length, `${sportKey}: at least one scoring event before the retirement`).toBeGreaterThan(2);
      for (const e of [...pre, ...post].filter((x) => x.type === "core.forfeit")) expect(REASONS).toContain((e.payload as { reason: string }).reason);
      checked++;
    }
    expect(checked).toBe(11);
  });
  it("X-DW-1: every sport builds a double walkover as core.forfeit {by: both, reason: walkover}, chess included (M7)", () => {
    let checked = 0;
    for (const sportKey of SPORT_KEYS) {
      const s = generateStream({ sportKey, cfg: {}, outcome: { kind: "double_walkover" } } as never);
      expect(s, sportKey).toEqual([{ type: "core.forfeit", payload: { by: "both", reason: "walkover" } }]);
      checked++;
    }
    expect(checked).toBe(11);
  });
  it("X-DW-1: the harness observes double_walkover as itself, never as undecided", () => {
    expect(toObservedOutcome({ kind: "double_walkover" })).toEqual({ kind: "double_walkover" });
    expect(toObservedOutcome({ kind: "award", winner: "a", loser: "b", reason: "retired" })).toEqual({ kind: "award", winner: "a", loser: "b", reason: "retired" });
    expect(toObservedOutcome({ kind: "award", winner: "a", loser: null, reason: "bye" })).toEqual({ kind: "award", winner: "a", loser: null, reason: "bye" });
  });
});
```

  Pin `generateStream`'s real request shape from `HM/lib/streams/index.ts` before writing. The `as never` casts are only there until Step 3 widens the type; remove them in Step 3.

  `HM/lib/model/__tests__/forfeit-command.test.ts`:
  - **Empty case first:** `modelCommands({ fences: true })` without `forfeit` builds exactly today's kinds, read from `COMMAND_KINDS` (not typed again).
  - **Opt-in:** with `forfeit: true`, the `Forfeit` kind is present.
  - **Replay:** every committed regression in `HM/catalogue/regressions.json` replays to the same command path (D10).
  - **Rule-10:** a sequence test over Walkover, Forfeit (one side and `both`), Void and Withdraw. After every step it checks two invariants:
    - **nobody advances from a double walkover:** for each fixture whose model outcome is `double_walkover`, the fed seat is never that fixture's entrant;
    - **the model's table counts one result per active forfeit.**

    The sequences must include: forfeit after abandon; void then forfeit; double walkover then void; withdraw before and after start; a second forfeit; both sides withdrawing in turn; a tie-break withdrawal.
- [ ] **Step 2: Run red.** Use the harness vitest with `<N>` = 2. Expected red:
  - the walkover stream starts with `core.start`;
  - `double_walkover` is not a request kind;
  - `toObservedOutcome` returns `null`;
  - `forfeit` is not an option.
- [ ] **Step 3: Implement** the Interfaces above. Keep the existing `Walkover` kind name. Its START goes, because the phase guard refuses a walkover after START (finding 10). `HttpDriver.forfeit` posts `[forfeitEv]` alone when the reason is `walkover`. When the reason is retired or disqualified on a scheduled fixture it posts `[START, <one scoring event from the sport's stream builder>, forfeitEv]`.
- [ ] **Step 4: Write the five scenarios** in `w2b-forfeit-credit.ts`.
  - Each `check` is counted, and zero checked is a failure. The pattern is `life-bracket-decider-exercised` in `HM/lib/scenarios/w2a-bracket-finish.ts`.
  - Each check's expectation comes from the reference family `walkover-credit` (Task 15), imported by the harness through `HM/lib/reference-*.ts` as W2a did. Until P2 merges, the check reads Appendix A's numbers from the rule row text and the cfg.
- [ ] **Step 5: Re-key `r4-withdrawal.ts`'s `WALKOVER_MODEL`.**
  - The open formats (page_playoff, ladder) expect `forfeited`, not abandoned.
  - A TBD seat expects the arriving opponent walked over.
  - Chess not started expects a walkover.
- [ ] **Step 6: Reproduction, part 2: drive the new scenarios against the UNFIXED branch.** The lane is still at the branch tip without loop D.
  - Run the Global Constraints truth-run command with `<tag>` = `repro2` and `newScenarios` = the five keys.
  - Expected: every scenario's case ends `red`, each for its gap; the README names the expected reason per scenario.
  - **Copy the run to `TR/w2b-repro/new/`. The orchestrator commits it on `WT`** (lane rule), with the five keys added to `newScenarios` and a lock entry.
  - A scenario that is GREEN here is a false premise, or a vacuous check. Find which before merging the lane.
- [ ] **Step 7: The unit gate, after loop D merges into the lane** (`git merge --no-ff feat/format-matrix-w2b` into the lane). Run the harness vitest over the new tests plus every harness test that the M7, `Walkover` and observed changes touch:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b-harness && git grep -l "toObservedOutcome\|Walkover\|levelRefusal\|retired hurt\|WALKOVER_MODEL" -- 'tools/matrix/**/*.test.ts'
  ```
  Expected green, with `total` pinned, plus the harness tsc. Then confirm `pnpm matrix:single-sport --check --against HEAD^1` is green.
- [ ] **Step 8: Hand mutants** (`MUT/t2.json`), each killed by the named test:

  | id | mutation | killer |
  |---|---|---|
  | `observed-dw-null` | `toObservedOutcome`'s `double_walkover` arm returns `null` | "X-DW-1: the harness observes double_walkover as itself" |
  | `walkover-start-kept` | `HttpDriver.forfeit` keeps `START` for a walkover | "empty case first: a walkover request before start posts no core.start" |
  | `forfeit-optin-default` | `modelCommands` includes `Forfeit` without the flag | "empty case first" in `forfeit-command.test.ts` |
  | `dw-invariant-off` | the model's "nobody advances" invariant returns `true` | the rule-10 sequence test |
  | `scenario-zero-checked` | a `W2B_SCENARIOS` check's count forced to 0 | the scenario's own "zero checked is a failure" test |
- [ ] **Step 9: Four test types.**
  - Unit: the above.
  - E2E: the browser page objects are unchanged here. The dialog page object lands with Task 11, reported back to this lane.
  - Smoke: none.
  - Regression: Task 16.
- [ ] **Step 10: Commit** in the lane: `feat(matrix): W2b generator breadth, opt-in Forfeit, double_walkover observed, M7 rewritten`. Report the `IDX` lines and the selection keys to the orchestrator.

---

### Task 3: Engine core — the reasons, the outcome set, `advancesNobody`, the phase and abandon guards, expunge, the legacy settle (spec §5.1)

**Loop D, first task.** It starts when E1 is committed and Q1, Q3 and Q5 are answered.

**Files:**
- Modify `E/core/types.ts`:
  - `FORFEIT_REASONS`, `AWARD_REASONS` and `OUTCOME_KINDS` (D1, D2; they live here because `MatchOutcome` needs them and `events.ts` already imports `types.ts`);
  - `MatchOutcome` `:134-158`: `award` and `double_walkover`; the `award.method` doc at `:150-156` is replaced;
  - `advancesNobody`.
- Modify `E/core/events.ts`:
  - `CoreForfeit` `:52`, `CoreAbandon` `:53`, `forfeitOf` `:68`;
  - `foldMatchWithStoppage` `:629+`: the guards, `expunged`, D6;
  - `outcomeOf` `:141-150`.
- Modify `E/core/errors.ts`: append `FORFEIT_REASON_WRONG_PHASE`, `ABANDONED_SETTLE_OR_VOID`, `DOUBLE_WALKOVER_NO_NEXT_MATCH`, `STAGE_SEAT_DEPARTED`, in that order. Update `E/core/errors.test.ts`' order list.
- Modify `E/sport/module.ts`:
  - `FoldableModule` gains `forfeitPhase?` and `walkoverPhases?`;
  - `SportModule` gains `forfeitPhase`, `walkoverPhases?` and `forfeitCredit?`. `forfeitCredit` is made required at the end of Task 4.
- Modify every module, the phase hook only:
  - `forfeitPhase` and `walkoverPhases` in `football.ts`, `period/kernel.ts`, `setbased/kernel.ts`, `nested/kernel.ts`, `cricket.ts`, `carrom.ts`, `boardgame.ts`, `generic.ts`;
  - every module's own `core.forfeit` handler reads the typed `forfeitOf` and writes `award{winner, loser, reason}`. Football and period stop overwriting the score here; their credit moves to Task 4.
- Modify `W/server/api-v1/http.ts` (`ENGINE_HTTP`: the four codes → 409), `W/lib/scoring-vocab.ts` (`ENGINE_ERROR_KEY`), and `W/dictionaries/{en,fr,es,nl}/ui.json` (`engineError.<CODE>`, the §7 copy).
- Create `E/core/outcome-set.test.ts` and `E/core/forfeit-guard.test.ts`. Rewrite `E/core/forfeit-reason.test.ts` (#772).
- Rewrite these pins, each with a why in the commit:
  - `E/sports/boardgame/tiebreak.test.ts:218`: forfeit `WRONG_PHASE` in `tiebreak` → R14 accepts a one-side walkover and withdrew there, and refuses `both`.

**Interfaces (produced, frozen for loops F and H and lane P1):**
```ts
// E/core/types.ts (re-exported from @seazn/engine/core)
export const FORFEIT_REASONS: readonly ["walkover", "retired", "disqualified", "withdrew"];
export type ForfeitReason = (typeof FORFEIT_REASONS)[number];
export const AWARD_REASONS: readonly ["walkover", "retired", "disqualified", "withdrew", "bye"];
export type AwardReason = (typeof AWARD_REASONS)[number];
export const OUTCOME_KINDS: readonly ["win", "draw", "tie", "no_result", "award", "double_walkover"];
// MatchOutcome award arm: { kind: "award"; winner: EntrantId; loser: EntrantId | null; reason: AwardReason }
// MatchOutcome double_walkover arm: { kind: "double_walkover" }
export function advancesNobody(o: MatchOutcome | null | undefined): boolean; // true iff o?.kind === "double_walkover"
export type ForfeitPhase = "pre" | "play" | "tiebreak" | "over";
export type ForfeitBy = "home" | "away" | "both";
export interface ForfeitCredit { readonly perSide: readonly [Readonly<Record<string, number>>, Readonly<Record<string, number>>]; readonly excluded: readonly string[] }
// E/core/events.ts
export const CoreForfeit: z.ZodType<{ by: string; reason: ForfeitReason }>; // strict; by === "both" ⇒ reason "walkover"
export const CoreAbandon: z.ZodType<{ reason: string; expunge?: true }>;
export function forfeitOf(payload: unknown): { by: string | "both"; reason: ForfeitReason };
// foldMatchWithStoppage now returns { state, stoppage, squads, settlement, expunged: boolean }
export function outcomeOf(module, folded: { state; settlement; expunged?: boolean }): MatchOutcome | null; // null while expunged
// E/sport/module.ts — SportModule<Cfg, Ev, State>
forfeitPhase(state: State): ForfeitPhase;
walkoverPhases?: readonly ForfeitPhase[]; // absent ⇒ ["pre"]
forfeitCredit?(cfg: Cfg, state: State, reason: AwardReason, by: ForfeitBy): ForfeitCredit; // required after Task 4
```
Each module's `forfeitPhase`, read from its own phase union (re-pin each union from the file):

| Module | `pre` | `play` | `tiebreak` | `over` |
|---|---|---|---|---|
| football | `pre` | `H1`, `H2`, `Q2`, `Q3`, `Q4`, `ET_H1`, `ET_H2`, `SHOOTOUT` (Q5) | — | `done`, `final`, `abandoned` |
| period | `pre` | every period and `SHOOTOUT` (Q5) | — | `done`, `final`, `abandoned` |
| setbased, nested, carrom | `pre` | `live` | — | `done`, `final`, `abandoned` |
| cricket | `pre` | `live`, `super_over` (Q5) | — | `done`, `final` |
| boardgame | `pre` | `live` | `tiebreak` | `done`, `final`, `abandoned` (`boardgame.ts:725-730`) |
| generic | `pre` | `live` | — | `done`, `final`, `abandoned` (Task 4 adds `abandoned`) |

Only boardgame declares `walkoverPhases: ["pre", "play", "tiebreak"]`.

- [ ] **Step 1: Write the failing tests.** `E/core/outcome-set.test.ts` is **the first W2b test, and it pins the set**:

```ts
import { describe, expect, it } from "vitest";
import { AWARD_REASONS, FORFEIT_REASONS, MatchOutcome, OUTCOME_KINDS, advancesNobody, isLevelOutcome } from "./types.ts";

describe("W2b outcome set (spec §5.1)", () => {
  it("X-DW-1: the outcome kinds are exactly win, draw, tie, no_result, award, double_walkover — and MatchOutcome is built from them", () => {
    expect([...OUTCOME_KINDS]).toEqual(["win", "draw", "tie", "no_result", "award", "double_walkover"]);
    expect(MatchOutcome.options.map((o) => o.shape.kind.value)).toEqual([...OUTCOME_KINDS]);
  });
  it("X-RS-1: a forfeit reason is one of four; bye is award-only (system)", () => {
    expect([...FORFEIT_REASONS]).toEqual(["walkover", "retired", "disqualified", "withdrew"]);
    expect([...AWARD_REASONS]).toEqual([...FORFEIT_REASONS, "bye"]);
  });
  it("X-DW-1: advancesNobody — empty case first, then true for double_walkover and for nothing else", () => {
    expect(advancesNobody(null)).toBe(false);
    expect(advancesNobody(undefined)).toBe(false);
    const samples: Record<(typeof OUTCOME_KINDS)[number], unknown> = {
      win: { kind: "win", winner: "H", loser: "A" },
      draw: { kind: "draw" },
      tie: { kind: "tie" },
      no_result: { kind: "no_result" },
      award: { kind: "award", winner: "H", loser: "A", reason: "walkover" },
      double_walkover: { kind: "double_walkover" },
    };
    let checked = 0;
    for (const k of OUTCOME_KINDS) {
      expect(advancesNobody(MatchOutcome.parse(samples[k])), k).toBe(k === "double_walkover");
      checked++;
    }
    expect(checked).toBe(6);
  });
  it("X-BR-1: a double walkover is not level — never held, never settleable (f-w2 must #1)", () => {
    expect(isLevelOutcome({ kind: "double_walkover" } as never)).toBe(false);
  });
  it("X-WO-1: award carries winner, loser (null only for a bye) and reason; method and score are gone", () => {
    expect(MatchOutcome.parse({ kind: "award", winner: "H", loser: "A", reason: "retired", method: "x", score: 1 })).toEqual({ kind: "award", winner: "H", loser: "A", reason: "retired" });
    expect(MatchOutcome.parse({ kind: "award", winner: "H", loser: null, reason: "bye" })).toEqual({ kind: "award", winner: "H", loser: null, reason: "bye" });
    expect(MatchOutcome.safeParse({ kind: "award", winner: "H", loser: "A", reason: "no-show" }).success).toBe(false);
  });
});
```

`E/core/forfeit-guard.test.ts` is the guard sweep, the abandon guard, expunge, D6, and the rule-10 sequence:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "./events.ts";
import { FORFEIT_REASONS, OUTCOME_KINDS } from "./types.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload } as never, voids);
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return EngineError.is(e) ? e.code : String(e); } };
const firstCfg = (m: (typeof builtinModules)[number]) => m.configSchema.parse(Object.values(m.variants)[0] ?? {});
/** Appendix A X-RS-1: a walkover is "before play started", and chess also after the session starts (FIDE Laws 6.7.1). */
const walkoverAfterStartAllowed = (key: string) => key === "boardgame";

describe("X-RS-1 phase guard (spec §5.1; D3)", () => {
  it("empty case first: a stream with no forfeit folds exactly as before (no guard fires)", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const l = defaultLineupPair(m.positions);
      expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.start")])), m.key).toBeNull();
      checked++;
    });
    expect(checked).toBe(11);
  });

  it("X-RS-1: 11 sports × 4 reasons × {before, after start}, plus both sides — each refusal and each acceptance", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const cfg = firstCfg(m);
      const l = defaultLineupPair(m.positions);
      const A = l.away.entrantId;
      for (const started of [false, true]) {
        const prefix = started ? [ev(1, "core.start")] : [];
        const n = prefix.length + 1;
        for (const reason of FORFEIT_REASONS) {
          const allowed = reason === "withdrew" || (reason === "walkover" ? !started || walkoverAfterStartAllowed(m.key) : started);
          const run = () => foldMatchWithStoppage(m as never, cfg as never, l, [...prefix, ev(n, "core.forfeit", { by: A, reason })]);
          expect(codeOf(run), `${m.key} ${reason} ${started ? "after" : "before"} start`).toBe(allowed ? null : "FORFEIT_REASON_WRONG_PHASE");
          if (allowed) expect(outcomeOf(m as never, run() as never), `${m.key} ${reason}`).toEqual({ kind: "award", winner: l.home.entrantId, loser: A, reason });
          checked++;
        }
        const both = () => foldMatchWithStoppage(m as never, cfg as never, l, [...prefix, ev(n, "core.forfeit", { by: "both", reason: "walkover" })]);
        const bothAllowed = !started || walkoverAfterStartAllowed(m.key);
        expect(codeOf(both), `${m.key} both ${started ? "after" : "before"} start`).toBe(bothAllowed ? null : "FORFEIT_REASON_WRONG_PHASE");
        if (bothAllowed) expect(outcomeOf(m as never, both() as never)).toEqual({ kind: "double_walkover" });
        checked++;
      }
    });
    expect(checked).toBe(11 * 2 * (FORFEIT_REASONS.length + 1));
  });

  it("X-RS-1: free text, an unknown reason, and both with a non-walkover reason are INVALID_EVENT (schema; W2b-FP-1)", () => {
    const m = builtinModules.find((x) => x.key === "generic")!;
    const l = defaultLineupPair(m.positions);
    for (const payload of [{ by: l.away.entrantId, reason: "no-show" }, { by: l.away.entrantId, reason: "bye" }, { by: "both", reason: "retired" }, { by: l.away.entrantId }]) {
      expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.forfeit", payload)])), JSON.stringify(payload)).toBe("INVALID_EVENT");
    }
  });

  it("BG-WO-3: chess tie-break pending — one side's walkover or withdrew is accepted, both is refused (R14)", () => {
    const m = builtinModules.find((x) => x.key === "boardgame")!;
    const cfg = m.configSchema.parse({ tiebreak: true });
    const l = defaultLineupPair(m.positions);
    const drawn = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "agreement" })];
    for (const reason of ["walkover", "withdrew"] as const) {
      const f = foldMatchWithStoppage(m as never, cfg as never, l, [...drawn, ev(3, "core.forfeit", { by: l.away.entrantId, reason })]);
      expect(outcomeOf(m as never, f as never)).toEqual({ kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason });
    }
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, [...drawn, ev(3, "core.forfeit", { by: "both", reason: "walkover" })]))).toBe("FORFEIT_REASON_WRONG_PHASE");
  });
});

describe("X-AB-4 abandon guard (D4)", () => {
  it("X-AB-4: a forfeit while an abandon is active is ABANDONED_SETTLE_OR_VOID in every sport that records an abandon — even where the abandon decided the match", () => {
    let checked = 0;
    const refusesAbandon: string[] = []; // a module whose own apply refuses core.abandon cannot reach the guard; listed, never silently dropped
    forEachSport(({ module: m }) => {
      const l = defaultLineupPair(m.positions);
      const base = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" })];
      if (codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, base)) !== null) { refusesAbandon.push(m.key); return; }
      const stream = [...base, ev(3, "core.forfeit", { by: l.away.entrantId, reason: "retired" })];
      expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, stream)), m.key).toBe("ABANDONED_SETTLE_OR_VOID");
      checked++;
    });
    expect(refusesAbandon).toEqual([]); // re-pin: `git grep -n '"core.abandon"' -- packages/engine/src/sports`; a sport listed here is a finding for the report, and this line then names it
    const fb = builtinModules.find((x) => x.key === "football")!;
    const l = defaultLineupPair(fb.positions);
    const awardCfg = fb.configSchema.parse({ abandonPolicy: "award" });
    const decided = [ev(1, "core.start"), ev(2, "football.goal", { by: l.home.entrantId }), ev(3, "core.abandon", { reason: "rain" }), ev(4, "core.forfeit", { by: l.away.entrantId, reason: "retired" })];
    expect(codeOf(() => foldMatchWithStoppage(fb as never, awardCfg as never, l, decided))).toBe("ABANDONED_SETTLE_OR_VOID"); // not ALREADY_DECIDED: the guard sits above guarantee 4
    expect(checked + refusesAbandon.length).toBe(11);
    expect(checked).toBeGreaterThan(0);
  });
  it("X-AB-4: void-then-forfeit is allowed and credited as a retirement; a walkover after the void is refused (play started)", () => {
    const m = builtinModules.find((x) => x.key === "generic")!;
    const l = defaultLineupPair(m.positions);
    const base = [ev(1, "core.start"), ev(2, "core.abandon", { reason: "rain" }), ev(3, "core.void", {}, "e-2")];
    const ok = foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [...base, ev(4, "core.forfeit", { by: l.away.entrantId, reason: "retired" })]);
    expect(outcomeOf(m as never, ok as never)).toMatchObject({ kind: "award", reason: "retired" });
    expect(codeOf(() => foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [...base, ev(4, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })]))).toBe("FORFEIT_REASON_WRONG_PHASE");
  });
});

describe("D5 expunge, D6 legacy settle", () => {
  it("D5: an expunge abandon folds to no outcome in every sport; a plain abandon keeps its sport's outcome", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const l = defaultLineupPair(m.positions);
      const f = foldMatchWithStoppage(m as never, firstCfg(m) as never, l, [ev(1, "core.start"), ev(2, "core.abandon", { reason: "withdrew", expunge: true })]);
      expect(f.expunged, m.key).toBe(true);
      expect(outcomeOf(m as never, f as never), m.key).toBeNull();
      checked++;
    });
    expect(checked).toBe(11);
  });
  it("D6: a legacy settled chess double forfeit replays (the settlement wins); a strict write of the same settle is refused", () => {
    const m = builtinModules.find((x) => x.key === "boardgame")!;
    const cfg = m.configSchema.parse({ tiebreak: true });
    const l = defaultLineupPair(m.positions);
    const s = [ev(1, "core.start"), ev(2, "boardgame.result", { winner: null, method: "double_forfeit" }), ev(3, "core.settle", { winner: l.home.entrantId, method: "lot" })];
    expect(outcomeOf(m as never, foldMatchWithStoppage(m as never, cfg as never, l, s) as never)).toEqual({ kind: "win", winner: l.home.entrantId, loser: l.away.entrantId, method: "settled_lot" });
    expect(codeOf(() => foldMatchWithStoppage(m as never, cfg as never, l, s, { strictFromSeq: 3 }))).toBe("SETTLE_NOT_APPLICABLE");
  });
});

describe("rule 10: forfeit, abandon, void and settle in any order (spec §9 sequences)", () => {
  it("every accepted prefix keeps the invariants; refused writes never enter the ledger", () => {
    const keys = ["generic", "boardgame", "football"] as const;
    const step = fc.oneof(
      fc.constant({ t: "start" as const }),
      fc.record({ t: fc.constant("forfeit" as const), by: fc.constantFrom("H", "A", "both"), reason: fc.constantFrom(...FORFEIT_REASONS) }),
      fc.record({ t: fc.constant("abandon" as const), expunge: fc.boolean() }),
      fc.constant({ t: "voidLast" as const }),
      fc.record({ t: fc.constant("settle" as const), who: fc.constantFrom("H", "A") }),
    );
    let accepted = 0;
    fc.assert(fc.property(fc.constantFrom(...keys), fc.array(step, { maxLength: 8 }), (key, steps) => {
      const m = builtinModules.find((x) => x.key === key)!;
      const cfg = firstCfg(m);
      const l = defaultLineupPair(m.positions);
      const id = (s: string) => (s === "H" ? l.home.entrantId : s === "A" ? l.away.entrantId : s);
      const ledger: EventEnvelope[] = [];
      for (const s of steps) {
        const seq = ledger.length + 1;
        const e = s.t === "start" ? ev(seq, "core.start")
          : s.t === "forfeit" ? ev(seq, "core.forfeit", { by: id(s.by), reason: s.reason })
          : s.t === "abandon" ? ev(seq, "core.abandon", s.expunge ? { reason: "x", expunge: true } : { reason: "x" })
          : s.t === "settle" ? ev(seq, "core.settle", { winner: id(s.who), method: "lot" })
          : ledger.length > 0 ? ev(seq, "core.void", {}, ledger[ledger.length - 1]!.id) : null;
        if (e === null) continue;
        let f;
        try { f = foldMatchWithStoppage(m as never, cfg as never, l, [...ledger, e], { strictFromSeq: seq }); } catch (err) { if (EngineError.is(err)) continue; throw err; }
        ledger.push(e);
        accepted++;
        const o = outcomeOf(m as never, f as never);
        if (o !== null) expect(OUTCOME_KINDS).toContain(o.kind);
        if (o?.kind === "double_walkover") expect(ledger.some((x) => x.type === "core.forfeit" && (x.payload as { by: string }).by === "both")).toBe(true);
        if (o?.kind === "award") expect(o.loser).not.toBe(o.winner);
        if (f.expunged) expect(o).toBeNull();
      }
    }), { numRuns: 400 });
    expect(accepted).toBeGreaterThan(0);
  });
});
```

`forfeit-reason.test.ts` (#772) is rewritten deliberately. It now pins that every module (boardgame included, since `CARRIES_ITS_OWN_METHOD` goes because chess is unified) lands the reason in `award.reason`. It no longer uses `award.method`. It sweeps `builtinModules` × `FORFEIT_REASONS` with the phase each reason is legal in, and counts 44.

- [ ] **Step 2: Run red.** Engine vitest, `<N>` = 3, over the three test files plus `src/sports/boardgame/tiebreak.test.ts`. Expected reds:
  - `OUTCOME_KINDS` is not exported. This is a collect failure until a stub export exists, so first add `export const OUTCOME_KINDS = [] as const` and `FORFEIT_REASONS`, `AWARD_REASONS` and `advancesNobody` stubs, so the red is an assertion and not a collect.
  - The sweep's after-start walkover is accepted.
  - The double walkover is refused.
  - The abandon guard answers `ALREADY_DECIDED` or `WRONG_PHASE`.
  - `expunged` is undefined.
  - D6 throws on replay.
- [ ] **Step 3: Implement.**
  - The schema and `forfeitOf`.
  - The guard order inside the loop: `validateCoreEvent` → the D-C7 decider refusal → **the abandon guard (D4)** → guarantee 4 → the stoppage check → **the phase guard (D3)** → the time guard → apply.
  - `abandonActive` is computed from the resolved (void-aware) ledger, as it is today at `:818`. `expunged` comes from the same pass.
  - The settle branch gets D6: tolerate on `!strict && outcome?.kind === "double_walkover"`.
  - Every module's `core.forfeit` handler builds `award{winner, loser, reason}` from `forfeitOf`, and accepts `by: "both"` → `double_walkover`. The football and period goal overwrite (`football.ts:1640-1644`, `period/kernel.ts:1436-1440`) is removed here, because the credit moves to `forfeitCredit` in Task 4.
  - Add the four codes to `errors.ts`, `http.ts` (409 each) and `ENGINE_ERROR_KEY`, with copy in 4 locales (§7). For `FORFEIT_REASON_WRONG_PHASE`, the copy names the phase from `EngineError.data.phase` and the reasons allowed in it.
  - Run `pnpm i18n:gen-keys` and `pnpm i18n:check`.
- [ ] **Step 4: Run green.** The same engine command; expect the judge green with `total` pinned. Then `pnpm --filter @seazn/engine schema:snapshot`. Commit the regenerated `*.schema.json` when it changes, because the core event schemas are part of every sport's snapshot.
  - **Engine tsc is expected to fail at exactly the exhaustive `standingsDelta` / `sideLine` switches** (football `:2623`, cricket `:3910`, period `:2616`, generic `:624`, `:212`). That is the spec's compile-time net for the new kind (§5.2), and Task 4 closes it. Any other tsc error is this task's to fix. Paste the error list into the report.
  - The golden suites (`E/testkit/golden*.test.ts`) are EXPECTED red from here until Task 5, and are excluded from this task's gate by name. They are the first item of loop D's closing gate.
  - Run the probes: `W2B_REPRO=1` over `src/core/w2b-repro.probe.test.ts`. Expect `SC-S6` and `B-7` green; the rest stay red, owned by Task 4.
- [ ] **Step 5: Hand mutants** (`MUT/t3.json`), each killed by the named title:

  | id | mutation | killer |
  |---|---|---|
  | `phase-guard-off` | the D3 guard returns before judging | "X-RS-1: 11 sports × 4 reasons" |
  | `walkover-any-phase` | R2's `walkoverPhases` check becomes `true` | same |
  | `retired-pre-ok` | R4 removed | same |
  | `both-tiebreak-ok` | R3 removed | "BG-WO-3: chess tie-break pending" |
  | `withdrew-refused` | R5 refuses | "X-RS-1: 11 sports × 4 reasons" |
  | `abandon-guard-off` | D4 guard deleted | "X-AB-4: a forfeit while an abandon is active" |
  | `abandon-guard-below-g4` | D4 moved below guarantee 4 | same (the football award-policy line) |
  | `void-ignored` | `abandonActive` ignores voids | "X-AB-4: void-then-forfeit" |
  | `expunge-ignored` | `outcomeOf` ignores `expunged` | "D5: an expunge abandon" |
  | `legacy-settle-strict-ok` | D6 also tolerates when strict | "D6: a legacy settled chess double forfeit" |
  | `legacy-settle-off` | D6 removed | same |
  | `advances-nobody-true` | `advancesNobody` returns `true` | "X-DW-1: advancesNobody" |
  | `dw-level` | `isLevelOutcome` admits `double_walkover` | "X-BR-1: a double walkover is not level" |
  | `both-any-reason` | the `by === "both"` refinement removed | "X-RS-1: free text, an unknown reason" |

  Then run changed-lines Stryker on `events.ts`, `types.ts` and `module.ts`.
- [ ] **Step 6: Four test types.**
  - Unit: the above.
  - E2E: Task 11's `forfeit-dialog.spec.ts` (the refusal copy).
  - Smoke: Task 18's `walkoverCreditSuite`.
  - Regression: the probes plus Task 16.
- [ ] **Step 7: Commit** the code (not the goldens): `feat(engine): W2b core — closed forfeit reasons, double_walkover, advancesNobody, phase and abandon guards, expunge`. The body says why `forfeit-reason.test.ts` and `tiebreak.test.ts:218` were rewritten.

---

### Task 4: Sport modules — `forfeitCredit`, double walkover, abandon changes, hockey 5, chess unified, player stats (spec §5.2)

**Loop D, continued.**

**Files:**
- Modify every module:
  - `forfeitCredit`;
  - the `standingsDelta` `award` arm reads it;
  - an explicit `double_walkover` arm;
  - the compile-time switches at football `:2623`, cricket `:3910`, period `:2616` and generic `:624` / `sideLine` `:212`;
  - the runtime throws at setbased `:2439`, nested `:2207`, carrom `:941` and boardgame `:807` get explicit cases.
- Modify `E/sports/hockey/hockey.ts:134`: `awardScore.goals` 3 → 5 (HK-WO-1).
- Modify `football.ts` `applyAbandon` and the period kernel's `:1447-1462`: award policy → `win{method:"abandoned"}` / `draw` (D8, FB-AB-1).
- Modify `carrom.ts:467-472`: the abandon outcome becomes `null` (CA-AB-1).
- Modify `generic.ts:79`, `:570-575`: an `"abandoned"` phase, outcome `null` (GN-AB-1, D16).
- Modify `boardgame.ts`:
  - `decideResult` `:282-310`: `double_forfeit` → `double_walkover` in every stage kind (BG-DW-1);
  - `core.forfeit` `:710-723` → `award{winner, loser, reason}` in any `walkoverPhases` phase, keeping `forfeited: true`;
  - `BoardgameResult` `:140-146` is refined so that `double_forfeit` ⇒ `winner === null` and `forfeit` ⇒ `winner` present;
  - `standingsDelta` `:807-855`.
- Modify every module's `playerStats.folded.fold` (X-PS-1/2), plus the carrom and generic player-stat folds that read `outcomeOf` (W2a D-C3).
- Modify every module's `arbitraryEvent` that emits `core.forfeit`, so it is legal under D3.
- Modify `E/sport/module.ts`: `forfeitCredit` becomes required.
- Create `E/sport/forfeit-credit.test.ts`, `E/sport/double-walkover.test.ts`, `E/sport/player-stats-forfeit.test.ts`, `E/sport/abandon-result.test.ts`, `E/sport/bye-credit.test.ts` and `E/sport/__fixtures__/bye-deltas.json`.
- Rewrite these pins:
  - `E/sports/boardgame/tiebreak.test.ts:46`, `:50`: double forfeit held `no_result` → `double_walkover` (T15-R1 retired, BG-DW-1);
  - every module test that asserted a free-text reason or `award.method`. Find them with `git grep -n "award.*method\|method: \"walkover\"\|reason: \"no-show\"" -- packages/engine/src ':!*.golden.json'`.

**Interfaces:** `forfeitCredit` as frozen in Task 3. `StandingsDelta` is unchanged. The `excluded` keys are realised by crediting those metrics 0 for this match, so no reader changes its arithmetic. Task 6 proves that the ratios do not move.

- [ ] **Step 0: Pin today's bye deltas BEFORE any module change** (spec §5.1, C-5). Write the generator `E/sport/bye-credit.test.ts` with an `if (process.env.W2B_BYE_SNAPSHOT === "1")` writer. It calls each module's `standingsDelta({kind:"award", winner}, cfg, {kind:"swiss"}, init state)` with the phantom opponent, as `awardByeDelta` does (`W/server/engine-db/competition.ts:91-118`). Run it once on the unchanged tree to write `bye-deltas.json`, and commit that file alone: `test(engine): pin today's bye deltas per sport before W2b (C-5)`. This snapshot is the one place a test reads an expected value from code. The spec orders it (§5.1, "exactly today's bye delta"), and its commit says so.
- [ ] **Step 1: Write the failing tests.** `E/sport/forfeit-credit.test.ts` has every expectation computed from cfg with the Appendix A rule, written out in the test:

```ts
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "../core/events.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";

const ev = (seq: number, type: string, payload: unknown = {}): EventEnvelope => makeEnvelope(seq, { type, payload } as never);
const mod = (k: string) => builtinModules.find((m) => m.key === k)!;
/** Walk A over before start, fold, and return the [home, away] deltas for cfg. */
function walkoverDeltas(key: string, cfg: unknown, stage = "league") {
  const m = mod(key);
  const l = defaultLineupPair(m.positions);
  const f = foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })]);
  return m.standingsDelta(outcomeOf(m as never, f as never)!, cfg as never, { kind: stage } as never, f.state as never);
}
/** Appendix A walkover credit per sport, from the cfg alone (never from forfeitCredit). */
const EXPECTED_WALKOVER: Record<string, (cfg: Record<string, unknown>) => { winner: Record<string, number>; loser: Record<string, number> }> = {
  football: (c) => { const g = (c.awardScore as { goals: number }).goals; return { winner: { gf: g, ga: 0 }, loser: { gf: 0, ga: g } }; }, // FB-WO-1
  hockey: (c) => { const g = (c.awardScore as { goals: number }).goals; return { winner: { gf: g, ga: 0 }, loser: { gf: 0, ga: g } }; }, // HK-WO-1
  icehockey: (c) => { const g = (c.awardScore as { goals: number }).goals; return { winner: { gf: g, ga: 0 }, loser: { gf: 0, ga: g } }; }, // IH-WO-1
  volleyball: (c) => { const n = Math.ceil((c.bestOf as number) / 2); return { winner: { sets_won: n, sets_lost: 0, points_won: n * (c.setTo as number), points_lost: 0 }, loser: { sets_won: 0, sets_lost: n, points_won: 0, points_lost: n * (c.setTo as number) } }; }, // VB-WO-1 (FIVB 6.4.1: 0-25 every set ⇒ setTo, not finalSetTo)
  tabletennis: (c) => { const n = Math.ceil((c.bestOf as number) / 2); return { winner: { sets_won: n, sets_lost: 0, points_won: n * (c.setTo as number), points_lost: 0 }, loser: { sets_won: 0, sets_lost: n, points_won: 0, points_lost: n * (c.setTo as number) } }; }, // TT-WO-1
  badminton: (c) => { const n = Math.ceil((c.bestOf as number) / 2); return { winner: { sets_won: n, sets_lost: 0, points_won: n * (c.setTo as number), points_lost: 0 }, loser: { sets_won: 0, sets_lost: n, points_won: 0, points_lost: n * (c.setTo as number) } }; }, // BD-WO-1
  tennis: (c) => { const n = Math.ceil(((c as { bestOf?: number }).bestOf ?? 3) / 2); return { winner: { sets_won: n, sets_lost: 0, games_won: 0, games_lost: 0 }, loser: { sets_won: 0, sets_lost: n, games_won: 0, games_lost: 0 } }; }, // TN-WO-1 (games excluded) — re-pin the best-of field from nested's configSchema
  cricket: (c) => { const q = (c.ballsPerInnings as number) * ((c as { inningsPerSide?: number }).inningsPerSide ?? 1); return { winner: { runs_for: 0, balls_faced_eff: 0, runs_against: 0, balls_bowled_eff: 0 }, loser: { runs_for: 0, balls_faced_eff: q, runs_against: 0, balls_bowled_eff: 0 } }; }, // CK-WO-1
  boardgame: () => ({ winner: { wins: 1, white: 0, black: 0 }, loser: { wins: 0, white: 0, black: 0 } }), // BG-WO-1: colour history excluded
  carrom: (c) => { const n = Math.ceil((c.bestOf as number) / 2); return { winner: { sets_won: n, sets_lost: 0, points_won: n * (c.gameTo as number), points_lost: 0 }, loser: { sets_won: 0, sets_lost: n, points_won: 0, points_lost: n * (c.gameTo as number) } }; }, // CA-WO-1
  generic: () => ({ winner: { for: 0, against: 0 }, loser: { for: 0, against: 0 } }), // GN-WO-1
};

describe("X-WO-1: walkover credit per sport, from the stage's own cfg (spec §5.2)", () => {
  it("X-WO-1: every declared cfg of every sport credits the Appendix A walkover, the winner gets the sport's win points", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const rule = EXPECTED_WALKOVER[m.key];
      expect(rule, `${m.key}: no Appendix A walkover rule`).toBeDefined();
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const [home, away] = walkoverDeltas(m.key, cfg);
        const want = rule!(cfg as Record<string, unknown>);
        expect(home.metrics, `${m.key}/${name} winner`).toMatchObject(want.winner);
        expect(away.metrics, `${m.key}/${name} loser`).toMatchObject(want.loser);
        expect([home.won, home.lost, away.won, away.lost], `${m.key}/${name}`).toEqual([1, 0, 0, 1]);
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(11);
  });
  it("HK-WO-1: hockey's default walkover is 5-0, not the old 3-0", () => {
    expect(walkoverDeltas("hockey", mod("hockey").configSchema.parse({}))[0].metrics).toMatchObject({ gf: 5, ga: 0 });
  });
  it("Review Focus 3: a hockey cfg frozen before W2b (awardScore 3) keeps its 3-0", () => {
    expect(walkoverDeltas("hockey", mod("hockey").configSchema.parse({ awardScore: { goals: 3 } }))[0].metrics).toMatchObject({ gf: 3, ga: 0 });
  });
  it("VB-WO-1: 3-set volleyball credits 2-0 sets, not the played 0-0", () => {
    expect(walkoverDeltas("volleyball", mod("volleyball").configSchema.parse({ bestOf: 3 }))[0].metrics).toMatchObject({ sets_won: 2, sets_lost: 0 });
  });
});
```

  **Literal titles per rule id.** `rules-reference.test.ts` finds a proof by reading test titles statically, so an `it.each` template title (`"%s"`) proves nothing (W2a Task 2 fix round 1). The sweep above proves X-WO-1. Beside it sits one literal `it` per sport row, each calling the same `walkoverDeltas` + `EXPECTED_WALKOVER` pair:
  - `"FB-WO-1: …"`, `"HK-WO-1: …"` (above), `"IH-WO-1: …"`, `"VB-WO-1: …"` (above), `"TT-WO-1: …"`, `"TN-WO-1: …"`, `"BD-WO-1: …"`, `"CK-WO-1: …"`, `"BG-WO-1: …"`, `"CA-WO-1: …"`, `"GN-WO-1: …"`;
  - `"BD-WO-2: a badminton GROUP stage walkover credits 2-0 × 21-0 (deviation from GCR 16.2.5 until W5)"`, with `stage = "group"`.

  The retirement and abandon rows below follow the same rule: one literal title per id.

  The retirement cases, `describe("X-RT-1 …")`, come one per row. Each uses an explicit played prefix whose events are copied from the module's own existing tests (re-pin the payloads: `FootballGoal {by}` `football.ts:214`, `PeriodGoal {by}` `period/kernel.ts:230`, `SetBasedRally {wonBy}` `setbased/kernel.ts:153`, carrom's board summary, nested's point). The expected values are computed in the test from the rule:

  | Id | Played before the retirement | Expected (rule written in the test) |
  |---|---|---|
  | FB-RT-1 | 0-5, offender home | home gf 0, ga 5 (real worse than 3); and 1-0 offender leading → 0-3 |
  | HK-RT-1 / IH-RT-1 | 0-7 / 1-0 | the real 0-7 / the awarded 0-5 |
  | VB-RT-1 | set 1 won by the retiree 25-20, set 2 at 10-12 | the winner completes set 2 to `setTo` and gets the remaining sets at `setTo`-0; the retiree keeps set 1 and its 25+10 points |
  | TT-RT-1 / BD-RT-1 | one game each, third at 5-3 to the retiree | the current game completes for the winner at max(`setTo`, retiree + 2); the rest at `setTo`-0; the played points stand |
  | TN-RT-1 | any partial | as TN-WO-1 |
  | CA-RT-1 | game 1 completed 25-10 for the retiree, game 2 at 12-8 | game 2 → 25 for the winner (`gameTo`) against the retiree's 8; the remaining games 25-0 |
  | GN-RT-1 | a recorded score 3-1 to the retiree | the winner gets the win points; the recorded score is kept |
  | X-RT-1 | the same streams with `disqualified` | identical credit to `retired`, per sport |
  | BG-WO-1 | a chess game in `live`, then `walkover` | 1-0, `white` and `black` not incremented |

  `E/sport/double-walkover.test.ts` covers X-DW-4 and X-DW-1:

```ts
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";

describe("X-DW-4: a double walkover in a table — P+1, L+1, 0 points, no score, out of every ratio", () => {
  it("X-DW-4: every declared cfg of every sport, both sides", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const l = defaultLineupPair(m.positions);
        const f = foldMatchWithStoppage(m as never, cfg as never, l, [makeEnvelope(1, { type: "core.forfeit", payload: { by: "both", reason: "walkover" } } as never)]);
        const o = outcomeOf(m as never, f as never);
        expect(o, `${m.key}/${name}`).toEqual({ kind: "double_walkover" });
        const deltas = m.standingsDelta(o!, cfg as never, { kind: "league" } as never, f.state as never);
        for (const [i, d] of deltas.entries()) {
          expect({ played: d.played, won: d.won, drawn: d.drawn, lost: d.lost, points: d.points }, `${m.key}/${name} side ${i}`).toEqual({ played: 1, won: 0, drawn: 0, lost: 1, points: 0 });
          expect(Object.values(d.metrics).every((v) => v === 0), `${m.key}/${name} side ${i} metrics ${JSON.stringify(d.metrics)}`).toBe(true);
        }
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(11);
  });
});
```

  `E/sport/abandon-result.test.ts` has one `it` per id:

  | Id | Stream | Expected |
  |---|---|---|
  | FB-AB-1 | football, `abandonPolicy: "award"`: 2-1 then abandon | `win{winner: leader, method: "abandoned"}` (D8) |
  | FB-AB-1 | the same, level 1-1 | `draw` |
  | HK-AB-1 / IH-AB-1 | the same two cases | the same two outcomes |
  | CK-AB-1 | past `minOversForResult` | `win{method:"dls"}`, unchanged |
  | CK-AB-2 | before `minOversForResult` | `no_result`; `standingsDelta` gives 1 point each and `no_results` 1 (ICC 16.10.3) |
  | CA-AB-1 | carrom abandon | outcome `null`; the phase is `abandoned` |
  | GN-AB-1 | generic abandon | outcome `null`; phase `abandoned`; `core.void` of the abandon resumes `live` |

  `E/sport/player-stats-forfeit.test.ts` covers X-PS-1/2, via `forEachSport` over modules with `playerStats`, counted:
  - walkover, withdrew and double walkover credit no appearance and no personal W/L;
  - retired, disqualified and an abandon with a result credit both lineups' players and a personal W/L as decided;
  - BG-WO-3: a chess draw then a tie-break walkover keeps the classical game a draw in stats (D-C6).

  `E/sport/bye-credit.test.ts` covers C-5: per sport, `standingsDelta({kind:"award", winner, loser:null, reason:"bye"})` equals `bye-deltas.json` exactly, for all 11 (counted).

  `arbitraryEvent` legality, in the same file as the credit tests: for each sport, 200 seeds × `buildStream` folded strictly; zero refusals; count the forfeits seen and require at least 1 per sport that emits one.
- [ ] **Step 2: Run red.** Engine vitest, `<N>` = 4, over the five new files plus `src/sports/boardgame/tiebreak.test.ts`. Expected reds:
  - the credit equals the played ledger;
  - hockey credits 3;
  - the double walkover throws `invalid` in setbased, nested and carrom;
  - abandon outcomes are as today;
  - the stats count a walkover.
- [ ] **Step 3: Implement** per module, following spec §5.2's table and the Appendix A rows. `forfeitCredit` reads only cfg and state.
- [ ] **Step 4: Run green.** The new files plus every module test file touched by the pin rewrites (list them in the report). Then run `schema:snapshot` and engine tsc. The probe file (`W2B_REPRO=1`) now expects all ten engine probes green.
- [ ] **Step 5: Hand mutants** (`MUT/t4.json`). There is one per member, each with its killer:
  - per sport: the walkover credit replaced by the played ledger (11 mutants), each killed by "X-WO-1: every declared cfg";
  - the football, hockey and icehockey retirement `max` replaced by `awarded` (3), killed by "FB-RT-1" / "HK-RT-1" / "IH-RT-1";
  - the hockey default back to 3, killed by "HK-WO-1";
  - each sport's `double_walkover` arm returns `points: 1` (11), killed by "X-DW-4";
  - the carrom and generic abandon back to `no_result` (2), killed by "CA-AB-1" and "GN-AB-1";
  - the D8 method dropped, killed by "FB-AB-1";
  - each player-stat skip removed (one per module with `playerStats`), killed by "X-PS-1";
  - the `BoardgameResult` refinement removed, killed by its schema test;
  - the bye arm credits walkover, killed by "C-5".

  Then run changed-lines Stryker over the module files.
- [ ] **Step 6: Four test types.**
  - Unit: the above.
  - E2E: Task 13's `walkover-public.spec.ts` (the credited score on the public page).
  - Smoke: Task 18.
  - Regression: Task 16 and the probes.
- [ ] **Step 7: Commit:** `feat(engine): W2b per-sport forfeit credit, double walkover in all 11 sports, abandon results, hockey 5-0, chess unified`. The body names each pin rewritten and why (T15-R1 retired by BG-DW-1; #772 superseded by `award.reason`).

---

### Task 5: Golden corpora — event-payload migration, then rebaseline (Q1)

**Loop D, continued. Blocked on Q1.** If the owner picks the alternative, regenerate the affected streams from their generators, and this task's Step 1 is replaced by that, recorded in `IDX`.

**Files:**
- Create `E/testkit/golden-forfeit-migration.ts` and `E/testkit/golden-forfeit-migration.test.ts`.
- Modify `E/sports/**/<key>.golden.json`: commit 1 changes events only; commit 2 changes states only.

- [ ] **Step 1: The migration's own failing test** (`golden-forfeit-migration.test.ts`). Synthetic streams, empty case first:
  - an empty corpus maps to an empty corpus, with count 0;
  - a stream with no `core.forfeit` is byte-identical;
  - a forfeit before `core.start` gets reason `walkover`;
  - a forfeit after it gets `walkover` only where the module's `walkoverPhases` admit the phase at that seq (boardgame `live`), else `retired`;
  - a voided `core.start` counts as not started;
  - `by` is never rewritten, and `"both"` is never introduced;
  - the function returns `{streams, examined, rewritten}`, and the test asserts both counts.
- [ ] **Step 2: Implement.** The rule folds the prefix with the module's `forfeitPhase`, so it is the D3 guard's own reading.
- [ ] **Step 3: Run it over the corpus** through a one-off CLI in the same file (`node --experimental-strip-types E/testkit/golden-forfeit-migration.ts --write`). Expect `examined` to equal the finding-1 counts (49 `core.forfeit` events), and `rewritten` > 0. Paste the per-sport table into the report.
- [ ] **Step 4: Commit 1, the events only:** `chore(golden): migrate recorded core.forfeit reasons to the W2b vocabulary (Q1 ruling <n>)`. Golden tests are still red here; that is expected and named in the body.
- [ ] **Step 5: Rebaseline in a clean tree** (GOLDEN-POLICY):
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b/packages/engine && git status --porcelain | wc -l && REBASELINE_GOLDEN=1 pnpm vitest run src/testkit/golden.test.ts; echo EXIT=$?
  ```
  Expected: `0` dirty files before the run; `EXIT=0`; only `*.golden.json` changed. Then the review aid: a jq summary per corpus of outcome kinds before and after (`git show HEAD:<file>` against the working file). It must show only these changes:
  - `award.method` → `award.reason` plus `loser`;
  - boardgame `no_result` → `double_walkover` where the result was `double_forfeit`;
  - hockey walkover credit 3 → 5;
  - the carrom and generic abandon `no_result` → `null`;
  - the football and period award-abandon `award` → `win{method:"abandoned"}`.

  Any other change is a defect in Tasks 3–4, not a rebaseline.
- [ ] **Step 6: Run green.** Every golden suite (`E/testkit/golden*.test.ts`, `golden-policy.test.ts`, `golden-compare.test.ts`) plus `conformance*.test.ts`, judge green.
- [ ] **Step 7: Commit 2, the corpus alone:** `chore(golden): rebaseline for W2b outcome shapes (REBASELINE_GOLDEN=1, events byte-identical)`. No hand mutants: the task adds no guard. The migration's mutants (`walkover-rule-inverted`, `voided-start-counted`) go in `MUT/t5.json`, killed by Step 1's tests.

---

### Task 6: Engine competition readers — points, tables, ratio exclusions (spec §5.3, engine half)

**Loop D, last task.**

**Files:**
- Modify `E/competition/points.ts` (`applyPointsRule`: `double_walkover` → 0 each, no bonus; `isForfeit` `:57` unchanged, D14).
- Modify `E/competition/standings.ts` (`resultsAmong` and head-to-head: `double_walkover` has no winner and gives no h2h point).
- Modify `E/competition/stage.ts` (`bracketRanks`: an `advancesNobody` fixture eliminates BOTH entrants in its round; X-DE-1 any forfeit loser is out in double elimination).
- Modify `E/competition/tiebreakers.ts` only if Step 2 shows a ratio that moves.
- Tests: `E/competition/w2b-tables.test.ts`, plus the existing `points.test.ts` and `stage.test.ts` cases they extend.

**Interfaces (produced):**
```ts
// E/competition/stage.ts — BracketFixture gains one optional field, set by the web's bracketWinnerLoser (Task 7):
walkedOver?: "loser" | "both"; // "loser": the loser forfeited (X-DE-1: out, never drops); "both": a double walkover (X-DW-2: both out)
```

- [ ] **Step 1: Write the failing tests** (`w2b-tables.test.ts`):
  - **X-DW-4:** a league of 3 with one double walkover. Each side's row is `played +1, lost +1, points 0`. `applyPointsRule` with a `forfeit` rule gives 0 and no `forfeit_loss` bonus (D14).
  - **X-DW-4 / TN-WO-1 / CK-WO-1, "excluded keys move no ratio":** two tables over the same played matches, one with an added walkover and one without. Every excluded ratio is equal between them, read through the engine's own tie-break readers (`tiebreakers.ts`):
    - tennis game %;
    - the cricket winner's NRR;
    - every ratio of a double walkover's sides.

    Count the ratios compared; zero is a failure.
  - **X-DE-1:** a `bracketRanks` input with a double-elimination winners'-bracket fixture decided by `award{reason:"walkover"}` (`walkedOver: "loser"`). The loser is ranked eliminated in that round, never in a losers'-bracket round. The positive pair: the same fixture as a `win` drops the loser normally.
  - **X-DW-2:** a knockout with a double walkover in a semi-final (`walkedOver: "both"`, no winner). Both entrants are ranked out in that round.
  - **D14:** a bye (`award{loser:null, reason:"bye"}`) is still `isForfeit` and scores `forfeit.winnerPoints`.
- [ ] **Step 2: Run red** (engine `<N>` = 6). The expected red: `applyPointsRule` / `resultsAmong` / `bracketRanks` treat `double_walkover` as unknown, or throw.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green** (`<N>` = 6), plus the existing `points.test.ts`, `stage.test.ts`, `standings.test.ts` and `tiebreak-rule-award-alias.test.ts`.
- [ ] **Step 5: Hand mutants** (`MUT/t6.json`):
  - `dw-points-one`, killed by X-DW-4;
  - `dw-bonus-applied`, killed by D14;
  - `ranks-dw-one-out`, killed by X-DW-2;
  - `de-forfeit-loser-drops`, killed by X-DE-1.

  Then run changed-lines Stryker.
- [ ] **Step 6: Four test types.**
  - E2E: Task 13 (the public table).
  - Smoke: Task 18.
  - Regression: Task 16.
- [ ] **Step 7: Commit:** `feat(engine): W2b tables — double walkover scores nothing, ratios exclude forfeit credit, double-elim forfeit loser is out`.

**Loop D closing gate** (the reviewer re-runs it):
- the engine vitest over every file Tasks 3–6 touched;
- the golden suites;
- the conformance suites;
- `rules-reference.test.ts` (the existing rows still prove);
- engine tsc;
- `W2B_REPRO=1` engine probes all green.

Pin `total`.

---

### Task 7: Server — status keyed as §5.4, append guards, organiser list, byes, seat readers, auto-advance (spec §5.3 web half, §5.4)

**Loop F, first task.** It starts when loop D is merged (sequential on `WT`).

**Files:**
- Modify `W/server/engine-db/append-event.ts`:
  - `fixtureStatusFromFold` `:148-166`, the D7 order;
  - the pre-fold guards `:313-365`, gaining D15 (the chess forfeit methods) and `DOUBLE_WALKOVER_NO_NEXT_MATCH` (D19, below).
- Modify `W/server/engine-db/fed-seats.ts`:
  - `advancingSides` `:97-103`: an exhaustive switch over `OUTCOME_KINDS`. `double_walkover` → no sides; `award` → winner only.
  - `isCascadeWalkover` `:115-117`: reads `reason`.
- Modify `W/server/engine-db/competition.ts`:
  - `awardByeDelta` `:91-118`: `{kind:"award", winner, loser:null, reason:"bye"}`;
  - `bracketWinnerLoser` `:156`: exhaustive; it sets `BracketFixture.walkedOver` (Task 6's interface);
  - `completeStageIfReady` `:666-690`: `STAGE_SEAT_DEPARTED` where a departed seat cannot resolve (D-G3 corner 3).
- Modify `W/server/engine-db/level-seat.ts`: `assertAdvancingSeat` (D20), called at the three seating callers, `scoring.ts:750`, `competition.ts:185` and `stages.ts:4122`.
- Modify `W/server/usecases/stages.ts`:
  - the three bye writers, `:1295`, `:2545` and `:3613-3618` (SQL `jsonb_build_object('kind','award','winner',…,'loser',null,'reason','bye')`);
  - `feederIsDead` `:3679` and `loserFeederIsDead` `:3714`, each gaining a separate `advancesNobody` clause;
  - the `SeatRow` select carries `outcome`, if it does not already.
- Modify `W/server/usecases/scoring.ts:844` (D18).
- Modify `W/lib/organiser-only-events.ts`: remove `ORGANISER_ONLY_SPORT_EVENTS`' two `boardgame.result` entries (spec §5.2, C-4).
- Modify `W/lib/fixture-engine-status.ts` (no new status; its sweep is re-run).
- Rewrite these pins:
  - `W/server/usecases/__tests__/organiser-only-events.test.ts:10-13`: the D-O1 derivation, now over the post-W2b vocabulary (`award` or `advancesNobody`). Its title gains `X-RS-3`: every event that records a forfeit, walkover, retirement or double walkover is organiser-only. That covers `core.forfeit` for all four reasons and `both`, refused 403 for a device link and an official scorer, with the API key as the positive pair;
  - `W/server/engine-db/__tests__/needs-decision-status.test.ts:43`: a chess double forfeit is no longer held; it is `forfeited` `double_walkover`.
- Create `W/server/engine-db/__tests__/w2b-status.test.ts`, `W/server/engine-db/__tests__/double-walkover-seating.test.ts` and `W/server/usecases/__tests__/auto-advance-finished.test.ts`.

**Decisions made here:**
- **D19. `DOUBLE_WALKOVER_NO_NEXT_MATCH`** is refused when the candidate is `core.forfeit{by:"both"}` AND the stage kind is `knockout`, `double_elim`, `stepladder` or `page_playoff` AND the fixture has `winner_to_fixture IS NULL AND loser_to_fixture IS NULL` (`fed-seats.ts:73-76`). That is the feed graph, never round names (§5.3).
  - Ladder challenges and table kinds are exempt. A ladder wires no feed edge by design (W2a loop G), and a double walkover there leaves the positions unchanged.
  - A third-place match has no outgoing edge, so it is refused (X-DW-3).
  - **Amended in loop F review (I-5):** "no next match" also covers a fixture whose two edges point at the SAME fixture — a grand final with a bracket reset, and a 2-entrant double elimination's winners' match, both of which only feed a rematch. The single rule is `feedsNextMatch` in `apps/web/src/lib/bracket-next-match.ts`, read by append-event, withdrawal and stages. Authority: X-DW-3 ("a final"), since a reset grand final carries `isFinal`.
- **D20. The new seat assertion.** `assertAdvancingSeat(stageKind, status, outcome, seatedEntrant)` throws `LEVEL_RESULT_SEATED` (500) with `data.reason: "advances_nobody"` when `advancesNobody(outcome)` and a seat is about to be filled from it. Reusing W2a's bug-shape code keeps "a seat that must not be filled" one code. The spec names no new one.

**Interfaces consumed:** Task 3's `advancesNobody`, `OUTCOME_KINDS` and `AWARD_REASONS`; Task 6's `BracketFixture.walkedOver`.

- [ ] **Step 1: Write the failing tests** (DB-backed; rigs as in Task 1 Step 3).

`w2b-status.test.ts` covers D7, D15, D19 and ST-G1. The rows are enumerated, with the empty case first:

```ts
import { describe, expect, it } from "vitest";
import { fixtureStatusFromFold } from "../append-event";

const W = { kind: "win", winner: "h", loser: "a" } as const;
const ev = (type: string, payload: unknown = {}) => ({ type, payload });
describe("D7: fixtureStatusFromFold keyed as spec §5.4 (+ plan finding 5)", () => {
  it("empty case first: nothing folded is scheduled", () => {
    expect(fixtureStatusFromFold(null, [], "league")).toBe("scheduled");
  });
  it("X-AB-2 / ST-G1 / X-DW-1: each row of the order, in a draw kind and in a bracket kind", () => {
    const rows: [string, unknown, unknown[], string, string][] = [
      ["settle wins", W, [ev("core.start"), ev("core.settle", { winner: "h", method: "lot" })], "knockout", "decided"],
      ["abandon, no outcome", null, [ev("core.start"), ev("core.abandon", { reason: "rain" })], "league", "abandoned"],
      ["abandon, level, bracket", { kind: "no_result" }, [ev("core.start"), ev("core.abandon", { reason: "rain" })], "knockout", "abandoned"],
      ["ST-G1: abandon, level, draw kind (cricket NR)", { kind: "no_result" }, [ev("core.start"), ev("core.abandon", { reason: "rain" })], "league", "decided"],
      ["ST-G1: abandon, decisive (DLS / award policy)", { kind: "win", winner: "h", loser: "a", method: "dls" }, [ev("core.start"), ev("core.abandon", { reason: "rain" })], "league", "decided"],
      ["level in a bracket", { kind: "draw" }, [ev("core.start")], "knockout", "needs_decision"],
      ["active core.forfeit", { kind: "award", winner: "h", loser: "a", reason: "walkover" }, [ev("core.forfeit", { by: "a", reason: "walkover" })], "league", "forfeited"],
      ["double walkover (event)", { kind: "double_walkover" }, [ev("core.forfeit", { by: "both", reason: "walkover" })], "knockout", "forfeited"],
      ["finding 5: legacy chess double forfeit, no core.forfeit", { kind: "double_walkover" }, [ev("core.start"), ev("boardgame.result", { winner: null, method: "double_forfeit" })], "league", "forfeited"],
      ["award-policy abandon is decided, not forfeited (no core.forfeit)", { kind: "win", winner: "h", loser: "a", method: "abandoned" }, [ev("core.start"), ev("core.abandon", { reason: "rain" })], "knockout", "decided"],
      ["a win", W, [ev("core.start")], "league", "decided"],
    ];
    let checked = 0;
    for (const [name, outcome, active, kind, want] of rows) { expect(fixtureStatusFromFold(outcome as never, active as never, kind), name).toBe(want); checked++; }
    expect(checked).toBe(rows.length);
  });
});
```

The signature and argument shapes are W2a's (`append-event.ts:148`): re-pin the `active` element type from the file before writing.

The same file also holds these DB tests, each through `scoreEvent`:
- **D15:** chess `boardgame.result{method:"forfeit"}` and `{double_forfeit}` are refused `INVALID_EVENT` with `reason: "chess_forfeit_method_retired"`, and a legacy stream that already holds one replays (`getFixtureState`).
- **D19 / X-DW-3:** `core.forfeit{by:"both"}` is refused `DOUBLE_WALKOVER_NO_NEXT_MATCH` in a knockout final, a stepladder last rung, a knockout third-place match and a page_playoff final. It is accepted in a semi-final and in a ladder challenge, which is the positive pair. The fixture stays `scheduled` after each refusal.
- **ST-G1 / CR-2:** a cricket DLS abandon and a rain NR in a league reach `listStandings`, with points from Appendix A (CK-AB-1: the win; CK-AB-2: 1 each).
- **"X-AB-1: an abandon whose sport gives no result stays out of the table"**: a carrom and a generic abandon in a league leave both rows unchanged. Its positive pair is CR-2 above.
- **X-AB-3:** a fixture stored `abandoned` before W2b keeps its status on read (`getFixtureState`, no write), and moves only when a new event is appended.

`double-walkover-seating.test.ts` covers X-DW-2, D20 and Review Focus 1 and 2:
- **X-DW-2 (knockout of 8):** a quarter-final double walkover. The semi seat it feeds is dead, the other quarter-final's winner is walked over into the final, and the stage completes.
- **X-DW-2 (third place):** a semi-final double walkover. The final's seat is dead, the other semi's winner is the champion by walkover, and the third-place seat is won by walkover by the other semi-final loser.
- **X-DW-2 (double elimination):** a winners'-bracket double walkover. Neither entrant appears in the losers' bracket, and the losers'-bracket seat it fed is dead, so its opponent walks over.
- **X-DE-1:** a winners'-bracket single walkover loser is never seated in the losers' bracket, and its losers'-bracket opponent advances by walkover. `bracketRanks` places it eliminated in that round. This is the agreement the spec's false premise 8 asks for.
- **D20:** a forced row, `forfeited` `double_walkover` with a seated next fixture, makes `onDecided` / `toBracketFixture` / the completed-bracket rebuild each throw `LEVEL_RESULT_SEATED` with reason `advances_nobody`. There are three callers and three assertions, with the positive pair: an `award` seats its winner.
- **"Review Focus 1: void of a double walkover un-seats the walkover it caused":** void it, and the fed seat empties. If the next match has started, the void is refused `NEXT_MATCH_STARTED` and nothing changes.
- **"Review Focus 2: void then the other side's walkover":** the table and the seat follow the second forfeit only.
- **"X-BR-1 (amended): a bracket fixture is decided only by a win or a double walkover"**: a level knockout result is held, a double walkover completes the line, and both feed the next round as the rows above say. It is added to X-BR-1's `proved by` beside W2a's `settle-seating.test.ts`.
- **C-5 bye:** the Swiss bye, the generator bye and the seeded bye store `{kind:"award", winner, loser:null, reason:"bye"}`, and a Swiss table credits exactly `bye-deltas.json`'s delta for that sport.

`auto-advance-finished.test.ts` covers D18 and X-AB-2. A group stage feeds a knockout with auto-advance on:
- every group fixture `finalized` → the knockout is seeded (red today, `scoring.ts:844`);
- the same with one fixture an abandon-with-result (`decided`) → seeded;
- the same with one double walkover (`forfeited`) → seeded;
- **the negative pair:** one fixture `in_play` → not seeded.
- [ ] **Step 2: Run red.** apps/web vitest, `<N>` = 7, over the three new files plus the two rewritten pins. Expected reds:
  - the D7 rows for a draw-kind abandon;
  - a legacy double forfeit read as `decided`;
  - the chess methods accepted;
  - no `DOUBLE_WALKOVER_NO_NEXT_MATCH`;
  - a seat waiting forever after a double walkover;
  - auto-advance not firing on `finalized`.

  `W2B_REPRO=1` over the web probe file: `ST-G1`, `ST-G1b`, `CR-2`, `DE-RK`, `AA-FIN` and `X-WD-5` red.
- [ ] **Step 3: Implement.** The dead-seat clauses are separate lines beside W2a's `has_active_abandon` distinction, never inside it (§5.3, f-w2 must #3). `feederIsDead` keeps W2a's doc paragraph that reserves "decided, nobody advances" for this clause (`stages.ts:3679-3686`), now filled in.
- [ ] **Step 4: Run green** (`<N>` = 7), plus the existing seating, withdrawal-adjacent and status suites that share the edited files:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && git grep -l "fixtureStatusFromFold\|advancingSides\|bracketWinnerLoser\|feederIsDead\|awardSeededByes\|ORGANISER_ONLY_SPORT_EVENTS\|maybeAutoAdvance" -- 'apps/web/src/**/*.test.ts' 'apps/web/src/**/*.test.tsx'
  ```
  Pass every listed file and pin `files` and `total`. Then run `W/lib/__tests__/status-set-sweep.test.ts` (W2a's 125-row ledger: a new reader of a status set is classified there or it reds), web tsc, and `pnpm openapi:gen` (expected: no diff, since outcomes are not typed in `openapi/v1*.json`; any diff is committed and named).
- [ ] **Step 5: Hand mutants** (`MUT/t7.json`):

  | id | mutation | killer |
  |---|---|---|
  | `status-dw-decided` | D7 rule 4 drops the `double_walkover` arm | "finding 5: legacy chess double forfeit" |
  | `status-forfeit-on-kind` | rule 4 keys on `award` kind instead of the event | "award-policy abandon is decided" |
  | `status-abandon-result-abandoned` | rule 2 also catches a decisive abandon | "ST-G1: abandon, decisive" |
  | `dw-no-next-off` | D19 guard deleted | "D19 / X-DW-3" |
  | `dw-no-next-ladder` | the ladder exemption removed | the D19 positive pair (ladder) |
  | `chess-method-open` | D15 removed | "D15" |
  | `dead-clause-winner` | `feederIsDead`'s `advancesNobody` clause deleted | "X-DW-2 (knockout of 8)" |
  | `dead-clause-loser` | `loserFeederIsDead`'s clause deleted | "X-DW-2 (third place)" |
  | `seat-assert-off` | D20 returns | "D20" |
  | `advancing-award-loser` | `advancingSides` returns the award loser | "X-DE-1" |
  | `bye-reason-walkover` | a bye writer emits `reason: "walkover"` | "C-5 bye" |
  | `autoadvance-finalized-open` | D18 reverts | "every group fixture finalized" |
  | `organiser-chess-entry-back` | the `boardgame.result` entries restored | the rewritten D-O1 derivation |
- [ ] **Step 6: Four test types.**
  - E2E: Task 11's `forfeit-dialog.spec.ts` drives the D19 refusal in the browser; Task 13 covers the public double walkover.
  - Smoke: Task 18's `walkoverCreditSuite`.
  - Regression: the web probes and Task 16.
- [ ] **Step 7: Commit:** `feat(server): W2b status keyed on the event, double walkover seats nobody, byes carry reason bye, no-next-match guard, auto-advance on finalized`. The body explains each rewritten pin.

---

### Task 8: The withdrawal cascade (R8, R14, D-G2, D-G3, X-WD-5) (spec §5.4)

**Loop F, continued.**

**Files:**
- Modify `W/server/usecases/withdrawal.ts`:
  - `REASON` `:74` → `"withdrew"`;
  - `bracketWithdrawalStatus` `:49-73` and `deciderOwed` `:78-81` rewritten (C-2): the contradiction throw at `:56` goes;
  - `WithdrawCascadeOut` `:83-92` gains `walked_over_held: number`;
  - `voidAndAbandon` `:107` writes `core.abandon{reason, expunge: true}` (D5);
  - `applyUpdate` `:135-167`;
  - `withdrawEntrantCascade` `:169-273`: the three branches.
- Modify `W/server/usecases/stages.ts`:
  - `resolveBracketSeats` `:3861-3940`: both seats dead through departure → `forfeited` + `double_walkover` (X-WD-4), and a TBD seat stamped dead (D17);
  - **no change** to `BRACKET_WALKOVER_KINDS` `:882`, which also gates generation at `:2314`. The withdrawal path uses its own `WITHDRAWAL_WALKOVER_KINDS = BRACKET_WALKOVER_KINDS ∪ {page_playoff, ladder}`.
- Modify `E/competition/stage.ts` `:412-472` (`withdrawTableEntrant` / `withdrawBracketEntrant`) only if Step 1 shows the engine helpers decide a path this task changes.
- Modify `W/components/v2/needs-decision.tsx`: the settle dialog's choices exclude a withdrawn entrant (merge notice D-R9, legacy rows only).
- Rewrite these W2a pins, each with a why:
  - `W/server/usecases/__tests__/withdrawal-bracket-status.test.ts:41`, `:46`;
  - `withdrawal-decider-hold.test.ts:89`, `:132`, `:165` (D-R1 hold → R14 walkover);
  - `dead-feeder-cascade.test.ts:1205`, `:1220`, `:1252` (D-G2) and `:1466`, `:1517` (D-G3);
  - `W/components/v2/__tests__/fixture-console-authority-band.test.tsx:342` is Task 11's.
- Create `W/server/usecases/__tests__/withdrawal-w2b.test.ts` and `W/server/usecases/__tests__/swiss-withdrawal-chess.test.ts` (the chess copy of `swiss-withdrawal-walkover.test.ts`).

**The cascade, per fixture of the withdrawn entrant `X`** (D-decisions, in order):

| Fixture state | Writes | Rule |
|---|---|---|
| table kind, under 50% played (league/group) | `core.void` + `core.abandon{reason:"withdrew", expunge:true}` | expunge stays out of tables (C-6, D5) |
| table kind, otherwise; Swiss always | `core.forfeit{by:X, reason:"withdrew"}` | today's award path, reason fixed |
| bracket or open kind, scheduled, both seated | `core.forfeit{by:X, reason:"withdrew"}` (any phase, R5) | X-WD-2 adds page_playoff and ladder; BG-WO-2 covers chess unstarted |
| `needs_decision` (held level result) | `core.forfeit{by:X, reason:"withdrew"}` | X-WD-1, retirement credit |
| chess tie-break pending | `core.forfeit{by:X, reason:"withdrew"}` | BG-WO-3 / R14 |
| `abandoned`, active abandon, unsettled (D-G2 corner 1) | `core.void` of the abandon, then `core.forfeit{by:X, reason:"withdrew"}` | X-AB-4's void-then-forfeit; the pre-abandon score stands |
| opponent TBD | un-seat X; stamp `BYE_SLOT_LABEL` | X-WD-3 / D17, if Task 1 reproduced the throw |
| both seats now departed | `forfeited` + `{kind:"double_walkover"}` (no event, as `awardSeededByes` writes byes); a final stays open | X-WD-4; R10 → W4 handover |
| X on a loser edge (q2, third place, losers' bracket) | never seated; the seat is dead; the opponent walks over | X-WD-5 |
| `finalized`, `cancelled`, `decided`, `forfeited` | nothing (`skipped_finalized` as today) | — |

- [ ] **Step 1: Write the failing tests.** `withdrawal-w2b.test.ts`, one `it` per row above, each titled with its id. Every assertion reads the stored rows (`fixturesOf`) and the ledger (`score_events`):
  - "X-WD-1: a held knockout fixture is walked over to the remaining side with reason withdrew"
  - "Review Focus 5: X-WD-1 walk-over seats the remaining side in the next match" (and `walked_over_held === 1`)
  - "X-WD-2: page_playoff q1 withdrawal walks over, never abandons"
  - "X-WD-2: a ladder holder's withdrawal walks the pending challenge over (D-G3 corner 4 rewritten)"
  - "X-WD-3: withdrawing from a fixture whose opponent is TBD stamps the seat dead; the arriving winner walks over"
  - "X-WD-4: both entrants of a line withdraw in turn — the fixture is a double walkover, its fed opponent walks over"
  - "X-WD-4: both finalists withdraw — the final stays open (W4 handover)"
  - "X-WD-5: a settle never seats a withdrawn loser on a loser edge (page_playoff q2, third place, double elimination)"
  - "D-G2 corner 1: withdrawal from an abandoned, unsettled bracket fixture voids the abandon and walks over with retirement credit"
  - "D-G3 corner 3: a stepladder qualifier departed before the draw — the rung opponent walks over with no organiser step"
  - "D-G3 corner 3: a seat that cannot resolve is refused STAGE_SEAT_DEPARTED naming the entrant and the fixture" (forced row; the positive pair is the walk-over above)
  - "BG-WO-2 / CD-T13: a chess knockout withdrawal on an unstarted board walks over"
  - "BG-WO-3: a chess withdrawal while the tie-break is pending walks over; the classical draw stays in stats"
  - "D5: a league expunge (under 50%) stays void in the table for every sport, cricket included" (it would score 1 NR point without the flag)
  - "empty case first: an entrant with no fixtures withdraws with every count 0"

  `swiss-withdrawal-chess.test.ts` copies `pairedRoundOne` with `sport_key: "boardgame"`, `variant_key: "classical"`, and the same assertions as the badminton file's walkover case ("CD-T13-SW").

  The rule-10 sequence (`withdrawal-w2b.test.ts`, `describe("rule 10: withdrawals in any order")`) uses fast-check `numRuns: 12`, with `BUDGET_MS` from the work:
  - over a knockout of 8 and a page_playoff of 4;
  - the actions are `withdraw(i)`, `score(next open fixture, home)`, `voidLast(fixture)` and `abandon(next open fixture)`;
  - the alphabet must produce: withdraw before and after start, both sides in turn, a tie-break withdrawal (a chess knockout case), and void then forfeit.

  After every step it checks:
  - no withdrawn entrant is seated in any fixture that is not yet decided;
  - every cascade-written `core.forfeit` has reason `withdrew`;
  - `withdrawEntrantCascade` never throws, for any sequence;
  - every fixture holding a withdrawn seat is decided, or a final with both finalists departed.

  Count the steps; zero is a failure.
- [ ] **Step 2: Run red** (`<N>` = 8) over the two new files plus the rewritten W2a pin files. `W2B_REPRO=1` web probes: `C17`, `PP-WD`, `LD-WD`, `X-WD-3`, `CD-T13` and `CD-T13-SW` red.
- [ ] **Step 3: Implement** per the table. `applyUpdate` posts no `core.start` before a withdrawal forfeit. `withdrew` is legal in every phase but `over`.
- [ ] **Step 4: Run green** (`<N>` = 8): the new files plus every file `git grep -l "withdrawEntrantCascade\|bracketWithdrawalStatus\|resolveBracketSeats" -- 'apps/web/src/**/*.test.ts'` lists. Web probes: the six now green.
- [ ] **Step 5: Hand mutants** (`MUT/t8.json`), one per table row:
  - `held-skipped` → X-WD-1;
  - `open-format-abandons` → X-WD-2 (page_playoff);
  - `ladder-abandons` → X-WD-2 (ladder);
  - `tbd-throws` → X-WD-3;
  - `both-dead-void` → X-WD-4;
  - `final-dw-written` → "both finalists";
  - `loser-edge-seats-withdrawn` → X-WD-5;
  - `abandoned-not-voided` → D-G2 corner 1;
  - `stepladder-config-invalid` → D-G3 corner 3;
  - `tiebreak-holds` → BG-WO-3;
  - `expunge-flag-dropped` → D5;
  - `reason-english` (REASON back to `"entrant withdrew"`) → BG-WO-2, which posts it and is refused.
- [ ] **Step 6: Four test types.**
  - E2E: `apps/web/e2e/withdrawal-walkover.spec.ts`. One whole spec: an organiser withdraws an entrant from a held knockout fixture on the division page, and the run sheet shows the walkover tag (Task 13's tag) and the next match seated. It is written here and goes green when Task 13 lands; loop H runs it.
  - Smoke: Task 18 (`walkoverCreditSuite` withdraws once).
  - Regression: Task 16's `WD-CASC` scenario.
- [ ] **Step 7: Commit:** `feat(withdrawal): W2b — held, tie-break, open-format, TBD and both-withdrawn paths walk over; expunge flagged; reason withdrew`.

---

### Task 9: The migration and `division_has_results` (spec §5.4; D12, D13)

**Loop F, last task.**

**Files:**
- Create `db/migration/deltas/V<next>__w2b_double_walkover_and_results.sql`.
- Create `W/server/__tests__/w2b-migration.test.ts`.
- Rewrite the pin `W/server/__tests__/v432-needs-decision-migration.test.ts`: its held-chess-double-forfeit row is now re-classified by the W2b delta. V432 itself is never edited.

- [ ] **Step 1: Choose the version at the time of writing, and again at merge.** Never hard-code it.
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && git fetch origin && { ls db/migration/deltas; git ls-tree --name-only origin/main db/migration/deltas/; git ls-tree --name-only origin/feat/chess-lichess-external-play db/migration/deltas/ 2>/dev/null; } | grep -o '^V[0-9]*' | sort -t V -k2 -n | uniq | tail -3
  ```
  `<next>` is the largest number printed plus one, so V433 is taken by the chess branch (C-9). Task 18 Step 1 repeats this immediately before merge and renames the file if main moved. The test reads the file by glob (`V*__w2b_double_walkover_and_results.sql`), never by number.
- [ ] **Step 2: Write the failing test** (`w2b-migration.test.ts`). It seeds rows, applies the delta file's SQL with `sql.unsafe(readFileSync(...))`, and reads the notice:
  - **"empty case first: no matching row — examined 0, changed 0, and the test FAILS if its seeded row is not examined"**: seed one held chess double forfeit and assert `examined >= 1`.
  - **"BG-DW-1 migration: an unsettled held chess double forfeit becomes forfeited double_walkover; a settled one is untouched; a voided double forfeit is untouched; a non-bracket row is untouched"**: four rows; examined 1; changed 1.
  - **"D12: after the migration the fed seat resolves lazily — the opponent walks over with no organiser step"**: call `resolveBracketSeats(tx, stageId)` and assert the walkover is seated.
  - **"spec §5.5: no fixture whose active result is a chess double forfeit renders the Level copy after the migration"**: read the public match-centre sentence for the row (`resultSentence` in `match-centre.ts`), assert it is not `matchCentre.result.level…`, and it is the double-walkover key Task 13 adds. This line goes red until Task 13 and is carried there by name.
  - **"X-BL-1: division_has_results — one row per outcome kind × status, with a positive pair for each exclusion"**:

    | Case | Expected |
    |---|---|
    | `no_result` decided | false |
    | `no_result` abandoned | false |
    | `double_walkover` forfeited | false |
    | single walkover `award` forfeited | true |
    | `win` decided | true |
    | `win` finalized | true |
    | `draw` needs_decision | true |
    | null-outcome abandoned | false |
    | null-outcome scheduled | false |

    Each is read through the SQL function, never a TypeScript copy. Count the rows.
  - **"D13: every status the function's arms read is inside the partial index WHERE and the trigger's finished set"**: parse `pg_get_functiondef`, `pg_indexes.indexdef` and the trigger function's source from the live DB, and compare the sets.
- [ ] **Step 3: Write the delta:**
  ```sql
  -- W2b (spec §5.4; plan D12, D13). 1) Re-classify every UNSETTLED held bracket fixture whose active result is the legacy
  -- chess double forfeit: it is now a double walkover (BG-DW-1), never held. Settled rows keep their settle (plan D6).
  -- Seats resolve lazily on the next resolveBracketSeats (plan D12). 2) division_has_results counts only results with a
  -- verdict (W2b-R13): no_result and double_walkover never charge the quota slot, whatever the status.
  do $$
  declare examined integer; changed integer;
  begin
    create temporary table w2b_dw on commit drop as
      select f.id from fixtures f join stages s on s.id = f.stage_id
       where s.kind in ('knockout','double_elim','stepladder','page_playoff','ladder')
         and f.status = 'needs_decision'
         and exists (select 1 from score_events r
                      where r.fixture_id = f.id and r.type = 'boardgame.result' and r.payload->>'method' = 'double_forfeit'
                        and not exists (select 1 from score_events v where v.voids_event_id = r.id)
                        and r.seq = (select max(r2.seq) from score_events r2
                                      where r2.fixture_id = f.id and r2.type = 'boardgame.result'
                                        and not exists (select 1 from score_events v2 where v2.voids_event_id = r2.id)))
         and not exists (select 1 from score_events st
                          where st.fixture_id = f.id and st.type = 'core.settle'
                            and not exists (select 1 from score_events v3 where v3.voids_event_id = st.id));
    select count(*) into examined from w2b_dw;
    update fixtures set status = 'forfeited', outcome = '{"kind":"double_walkover"}'::jsonb where id in (select id from w2b_dw);
    get diagnostics changed = row_count;
    raise notice 'W2b double walkover reclassify: examined=% changed=%', examined, changed;
  end $$;

  create or replace function division_has_results(p_division_id uuid)
    returns boolean
    language sql stable as $$
      select exists (
        select 1 from fixtures f
         where f.division_id = p_division_id
           and coalesce(f.outcome->>'kind', '') not in ('no_result', 'double_walkover')
           and (f.status in ('decided', 'finalized', 'forfeited')
                or (f.status in ('abandoned', 'needs_decision') and f.outcome is not null)))
    $$;
  ```
  The `fixtures_track_finished` trigger stamps `finished_at` for `forfeited` already (V432 `:19-31`), so the moved rows keep or get their stamp. The test asserts that.
- [ ] **Step 4: Run green** (`<N>` = 9) over `w2b-migration.test.ts`, the rewritten V432 test, and `git grep -l "division_has_results" -- 'apps/web/src/**/*.test.ts'`. Apply locally with `pnpm db:apply` against the label's DB only, after `eval "$($S env --label w2b)"`; never without the env (memory: it migrates the dev DB).
- [ ] **Step 5: Hand mutants** (`MUT/t9.json`):

  | id | mutation | killer |
  |---|---|---|
  | `mig-settled-too` | the settle `not exists` removed | "BG-DW-1 migration" |
  | `mig-voided-too` | the void filter removed | same |
  | `mig-any-kind` | the stage-kind filter removed | same |
  | `dhr-no-result-counts` | `no_result` dropped from the exclusion | "X-BL-1" |
  | `dhr-dw-counts` | `double_walkover` dropped | same |
  | `dhr-walkover-excluded` | `award` added to the exclusion | the positive pair |
- [ ] **Step 6: Four test types.**
  - E2E: none here; the quota slot is covered by `division-quota*.spec.ts` if one exists (`git grep -l division_has_results -- apps/web/e2e`). Otherwise Task 18's smoke archives a division whose only fixture is a double walkover and asserts the slot is refunded.
  - Regression: Task 16.
- [ ] **Step 7: Commit:** `feat(db): W2b — re-classify unsettled held chess double forfeits; division_has_results excludes no_result and double_walkover`.

**Loop F closing gate** (the reviewer re-runs it):
- Tasks 7–9's file lists;
- the status-set sweep;
- `organiser-only-events.test.ts`;
- `rules-reference.test.ts`;
- web tsc;
- `W2B_REPRO=1` web probes, all 12 green.

---

### Task 10: The vocabulary blast radius — every forfeit writer outside the engine (finding 2; spec §5.1 "every caller enumerated")

**Loop S.** It waits on loop F merged; its bench step waits on Q2.

**Files:**
- Create `W/server/__tests__/forfeit-vocabulary-scan.test.ts`.
- Modify every file it lists outside `tools/matrix/**` (lane P1 owns that), `*.golden.json` (Task 5) and the files loops D and F already fixed. Enumerate them first:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && git grep -n -E "core\.forfeit|double_forfeit|retired hurt|no-show|no_show|\"walked off\"|award\.method|method: \"walkover\"" -- apps scripts tools/bench ':!*.golden.json' ':!tools/matrix' | cut -d: -f1 | sort | uniq -c | sort -rn
  ```
  Paste the list into the report. Expected: the `apps/web/e2e` specs (`scoring.spec.ts`, `bracket-new-h1.spec.ts`, the three walkthroughs), `scripts/smoke-sports.ts`, `scripts/smoke.ts`, the web unit tests that post a free-text reason, and `tools/bench/packs/build-packs/{suite11,_tiny}.ts` (Q2).

- [ ] **Step 1: Write the failing scan test.** It is counted:

```ts
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FORFEIT_REASONS } from "@seazn/engine/core";

const ROOT = new URL("../../../../../", import.meta.url).pathname; // repo root from apps/web/src/server/__tests__
const SCOPES = ["apps/web/src", "apps/web/e2e", "scripts", "tools/bench/packs/build-packs"];
const files = execFileSync("git", ["grep", "-l", "-e", "core.forfeit", "--", ...SCOPES, ":!*.golden.json"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const PAYLOAD = /type:\s*["']core\.forfeit["'][\s\S]{0,240}?reason:\s*["']([^"']+)["']/g;

describe("X-RS-1: every forfeit this repo writes outside the engine uses the closed vocabulary", () => {
  it("X-RS-1: no core.forfeit payload literal carries a reason outside FORFEIT_REASONS; the scan is not vacuous", () => {
    let payloads = 0;
    const bad: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(ROOT + f, "utf8").matchAll(PAYLOAD)) {
        payloads++;
        if (!(FORFEIT_REASONS as readonly string[]).includes(m[1]!)) bad.push(`${f}: ${m[1]}`);
      }
    }
    expect(files.length).toBeGreaterThan(0);
    expect(payloads).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
  it("X-RS-1: the retired chess forfeit methods are written nowhere outside the engine and legacy fixtures", () => {
    const hits = execFileSync("git", ["grep", "-n", "-e", "method: \"double_forfeit\"", "-e", "method: \"forfeit\"", "--", ...SCOPES], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(hits.filter((h) => !h.includes("legacy"))).toEqual([]); // a deliberate legacy-replay test names itself "legacy"
  });
});
```

  `git grep` exits 1 on no match. Wrap the second call so that "no hits" reads as `[]`, and assert that the first scan found files, so an empty scan cannot pass.
- [ ] **Step 2: Run red** (`<N>` = 10). Expected: `bad` lists the `no-show`, `retired hurt` and other literals from the enumeration.
- [ ] **Step 3: Fix each caller:**
  - free text → the reason the situation means (`no-show` before start → `walkover`; `retired hurt` → `retired`; `weather` / `crowd trouble` → that is an abandon, so the call becomes `core.abandon`);
  - a START posted before a walkover goes, as in `bracket-new-h1.spec.ts` and `scripts/smoke-sports.ts`;
  - every reader of `award.method` outside the engine reads `award.reason`.

  The bench pack builders change only with Q2 answered yes. The bench readers (`run-suite.ts:1643`, `oracle.ts:1320`) change only as Q2 rules.
- [ ] **Step 4: Run green.** The scan, plus every unit test file Step 3 edited, plus the bench's own tests if Q2 allowed the edit (harness recipe over `tools/bench`). Then run each edited e2e spec file whole against a local prod build (`$S rebuild --label w2b`): `scoring.spec.ts`, `bracket-new-h1.spec.ts`, and the three walkthroughs, each once, with raw pass counts.
- [ ] **Step 5: Hand mutants** (`MUT/t10.json`):
  - `scan-vacuous`: `files` forced to `[]`, killed by `files.length > 0`;
  - `scan-regex-blind`: PAYLOAD never matches, killed by `payloads > 0`.
- [ ] **Step 6: Commit:** `chore(w2b): forfeit vocabulary across apps, scripts and e2e — a counted scan refuses free-text reasons`.

---

### Task 11: The console's forfeit dialog (UI-1) (spec §5.5, §7)

**Loop H, first task.** It waits on loop S merged.

The wireframe `.superpowers/brainstorm/51672-1791493602/content/forfeit-dialog.html` (gitignored) gives the flow only. Build with house UI: the v2 dialog pattern of `W/components/v2/needs-decision.tsx`'s settle dialog and `confirm-dialog.tsx`, `btn` classes and tokens, the phone composition spec. UI-1 option A is ruled, so no option round is owed.

**Files:**
- Create `W/components/v2/forfeit-dialog.tsx`: the dialog plus the pure model builder `forfeitDialogModel`.
- Modify `W/components/v2/fixture-console.tsx`:
  - `ForfeitButton` `:1571` and its `TextPromptDialog` use (`:1541`) are replaced;
  - `offerOrganiserActions` `:860` opens for a chess fixture whose tie-break is pending (R14);
  - `decided` `:839` is unchanged (C-7).
- Modify the fixture page `W/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx`: it passes `noNextMatch` (the fixture's `winner_to_fixture`/`loser_to_fixture` are both null in a D19 kind), read server-side.
- Modify `W/dictionaries/{en,fr,es,nl}/ui.json` (the `forfeitDialog.*` keys), then `pnpm i18n:gen-keys`.
- Rewrite `W/components/v2/__tests__/fixture-console-authority-band.test.tsx:342` (R14 opens Forfeit on a pending tie-break) and `fixture-console-forfeit-hooks.test.tsx`.
- Create `W/components/v2/__tests__/forfeit-dialog-model.test.ts`, `apps/web/e2e/forfeit-dialog.spec.ts`, and one `mobile.spec.ts` test per width.
- Find and update every e2e that asserts the old testids, so it opens the new dialog: `git grep -a -n "score-forfeit-home\|score-forfeit-away\|score-forfeit" -- apps/web/e2e tools/matrix/lib/browser`. The `tools/matrix` page object goes to lane P1 as a report, or is fixed on `WT` after P1 has merged.

**Interfaces:**
```ts
export interface ForfeitDialogModel {
  who: readonly ("home" | "away" | "both")[];             // "both" only in the module's walkover phases and when !noNextMatch
  why: (who: "home" | "away" | "both") => readonly ForfeitReason[]; // chips by phase (D3); "both" ⇒ ["walkover"]
  preview: (who, reason) => { home: string; away: string } | null; // from module.forfeitCredit(cfg, state, reason, by)
  confirmKey: (who, reason) => "forfeitDialog.confirm.walkover" | "forfeitDialog.confirm.retired" | "forfeitDialog.confirm.disqualified" | "forfeitDialog.confirm.doubleWalkover" | "forfeitDialog.confirm.withdrew";
  guidance: "noNextMatch" | null;                          // X-DW-3 copy shown instead of "Neither"
}
export function forfeitDialogModel(module: AnySportModule, cfg: unknown, state: unknown, f: { stageKind: string | null; noNextMatch: boolean }): ForfeitDialogModel;
```
Testids:
- the opener keeps `score-forfeit` (fewer e2e moves);
- choices: `forfeit-who-home|away|both`, `forfeit-why-<reason>`;
- `forfeit-preview`, `forfeit-confirm`, `forfeit-refusal`, `forfeit-guidance-no-next-match`.

- [ ] **Step 1: Write the failing model test.** `apps/web` vitest is `environment: "node"`, so the wiring is the e2e's job (class 2).

```ts
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair } from "@seazn/engine/testkit";
import { forfeitDialogModel } from "../forfeit-dialog";

const mod = (k: string) => builtinModules.find((m) => m.key === k)!;
const stateOf = (k: string, started: boolean) => {
  const m = mod(k);
  const cfg = m.configSchema.parse(Object.values(m.variants)[0] ?? {});
  const s0 = m.init(cfg as never, defaultLineupPair(m.positions));
  return { m, cfg, state: started ? m.apply(s0 as never, { id: "e-1", fixtureId: "f", seq: 1, type: "core.start", payload: {}, recordedAt: "2026-01-01T00:00:00.000Z" } as never) : s0 };
};

describe("UI-1 forfeit dialog model (spec §5.5)", () => {
  it("empty case first: a decided fixture offers nothing", () => {
    const { m, cfg } = stateOf("generic", true);
    const done = m.apply(stateOf("generic", true).state as never, { id: "e-2", fixtureId: "f", seq: 2, type: "core.forfeit", payload: { by: defaultLineupPair(m.positions).away.entrantId, reason: "retired" }, recordedAt: "2026-01-01T00:00:01.000Z" } as never);
    expect(forfeitDialogModel(m, cfg, done, { stageKind: "league", noNextMatch: false }).who).toEqual([]);
  });
  it("X-RS-1: before play — Home, Away, Neither; walkover or withdrew; Neither only walks over", () => {
    const { m, cfg, state } = stateOf("generic", false);
    const d = forfeitDialogModel(m, cfg, state, { stageKind: "league", noNextMatch: false });
    expect(d.who).toEqual(["home", "away", "both"]);
    expect(d.why("away")).toEqual(["walkover", "withdrew"]);
    expect(d.why("both")).toEqual(["walkover"]);
  });
  it("X-RS-1: after play started — no Neither; retired, disqualified or withdrew", () => {
    const { m, cfg, state } = stateOf("generic", true);
    const d = forfeitDialogModel(m, cfg, state, { stageKind: "league", noNextMatch: false });
    expect(d.who).toEqual(["home", "away"]);
    expect(d.why("away")).toEqual(["retired", "disqualified", "withdrew"]);
  });
  it("X-DW-3: a final shows the guidance instead of Neither", () => {
    const { m, cfg, state } = stateOf("generic", false);
    const d = forfeitDialogModel(m, cfg, state, { stageKind: "knockout", noNextMatch: true });
    expect(d.who).toEqual(["home", "away"]);
    expect(d.guidance).toBe("noNextMatch");
  });
  it("X-WO-1: the preview is the engine's credit — hockey walkover reads 5–0 against the away side", () => {
    const { m, cfg, state } = stateOf("hockey", false);
    expect(forfeitDialogModel(m, cfg, state, { stageKind: "league", noNextMatch: false }).preview("away", "walkover")).toEqual({ home: "5", away: "0" });
  });
  it("BG-WO-3: a chess fixture whose tie-break is pending offers one side's walkover or withdrew, never Neither", () => {
    const m = mod("boardgame");
    const cfg = m.configSchema.parse({ tiebreak: true });
    const l = defaultLineupPair(m.positions);
    let s = m.init(cfg as never, l);
    s = m.apply(s as never, { id: "e-1", fixtureId: "f", seq: 1, type: "core.start", payload: {}, recordedAt: "2026-01-01T00:00:00.000Z" } as never);
    s = m.apply(s as never, { id: "e-2", fixtureId: "f", seq: 2, type: "boardgame.result", payload: { winner: null, method: "agreement" }, recordedAt: "2026-01-01T00:00:01.000Z" } as never);
    const d = forfeitDialogModel(m, cfg, s, { stageKind: "knockout", noNextMatch: false });
    expect(d.who).toEqual(["home", "away"]);
    expect(d.why("home")).toEqual(["walkover", "withdrew"]);
  });
  it("X-RS-1: one specific Confirm per reason", () => {
    const { m, cfg, state } = stateOf("generic", true);
    const d = forfeitDialogModel(m, cfg, state, { stageKind: "league", noNextMatch: false });
    expect(d.confirmKey("away", "retired")).toBe("forfeitDialog.confirm.retired");
    expect(d.confirmKey("away", "disqualified")).toBe("forfeitDialog.confirm.disqualified");
  });
});
```

  The preview's string form is the module's metric for its headline score: `gf` for goal sports, `sets_won` for set sports, and so on. Pin it from each module's `metrics` order, and test one sport per family.
- [ ] **Step 2: Run red** (`<N>` = 11): the module does not exist (add a stub export first, so the red is an assertion).
- [ ] **Step 3: Implement** the model, then the dialog: who → why → preview → one Confirm. Rules:
  - Confirm stays disabled until who and why are chosen, and while sending.
  - A refusal (`FORFEIT_REASON_WRONG_PHASE`, `ABANDONED_SETTLE_OR_VOID`, `DOUBLE_WALKOVER_NO_NEXT_MATCH`, `ALREADY_DECIDED`, `SEQ_CONFLICT`) closes the dialog and shows the reason through `ENGINE_ERROR_KEY` in `forfeit-refusal`.
  - It sends `core.forfeit {by: <entrant id> | "both", reason}`.
  - Copy, in 4 locales: the four Confirm labels ("Record walkover", "Record retirement", "Record disqualification", "Record double walkover", plus "Record withdrawal"), the chip labels and the guidance (§7 row 3).
- [ ] **Step 4: Write the e2e** `apps/web/e2e/forfeit-dialog.spec.ts`, a whole spec run against a local prod build. Each test asserts through the DOM and then through the API's fixture state:
  - "X-RS-1: walkover before play — the table credits the Appendix A score": a badminton league, so 2-0 × 21-0.
  - "X-RS-1: retirement after play — Neither is gone; the played score stands".
  - "X-DW-3: a knockout final shows the guidance, not Neither".
  - "X-AB-4: an abandoned fixture refuses with the settle-or-void copy": the refusal path, reached by abandoning first.
  - "BG-WO-3: a chess tie-break pending offers the walkover".
  - "Review Focus 4: double submit records one forfeit": two fast clicks on Confirm, or two pages racing. One `core.forfeit` in the ledger, and the second page shows its refusal.
  - "X-RS-3: an official scorer sees no Forfeit button": W2a's minted official, as in `bracket-finish.spec.ts`.

  `mobile.spec.ts` gains one test per width: open the dialog at 320, every choice reachable, no horizontal scroll (`scrollWidth <= clientWidth` on `documentElement`), and Confirm hit-testable with `elementFromPoint` (class 2).
- [ ] **Step 5: Run green.**
  - The model test (`<N>` = 11), the rewritten console tests, and web tsc.
  - `forfeit-dialog.spec.ts` whole: `cd WT/apps/web && PLAYWRIGHT_BASE=http://localhost:<port> pnpm exec playwright test e2e/forfeit-dialog.spec.ts --reporter=list`, with raw pass counts.
  - Every e2e file the testid grep listed, each whole.
  - **The whole `mobile.spec.ts`**, never a `-g` slice. Serial mode means the first red hides the rest, so re-run after each fix until one full pass completes (class 21).
- [ ] **Step 6: Hand mutants** (`MUT/t11.json`):

  | id | mutation | killer |
  |---|---|---|
  | `dialog-both-after-start` | `who` always includes `both` | "after play started" |
  | `dialog-retired-pre` | `why` admits retired before play | "before play" |
  | `dialog-no-guidance` | `guidance` always null | "X-DW-3: a final shows the guidance" |
  | `dialog-preview-played` | `preview` returns the played score | "X-WO-1: the preview is the engine's credit" |
  | `dialog-confirm-generic` | `confirmKey` returns one key | "one specific Confirm" |
  | `console-tiebreak-closed` | the R14 gate reverted | "BG-WO-3" (model) and the e2e |
- [ ] **Step 7: Screenshots** (per screen; the crops stay in the gitignored SDD scratch dir; verdicts are written as text in `IDX`). Three screens at 1280, 768 and 320, each a crop of the dialog:
  - the dialog before play;
  - the dialog after play;
  - the final with the guidance.
- [ ] **Step 8: Commit:** `feat(console): W2b forfeit dialog — who, why by phase, the engine's credit preview, one specific Confirm`.

---

### Task 12: The pad's chess dock, and event copy everywhere (spec §5.5 "Pad", "Copy")

**Loop H, continued.**

**Files:**
- Modify `W/components/v2/scorepad/v3/skins/boardgame.tsx`:
  - `DECISIVE_METHODS` / `DRAWN_METHODS` `:152-169` lose `forfeit` and `double_forfeit`;
  - `buildDock` `:524`: a Forfeit tile whose sheet is "who → why" with UI-1's chips, sending `core.forfeit`, plus a Double-forfeit tile sending `core.forfeit{by:"both", reason:"walkover"}`. Both are organiser-only through `dockFor` / `isOrganiserOnlyEvent`.
- Modify `W/lib/event-copy.ts:110-113`, `W/components/v2/scorepad/v3/ribbon.ts:111` and `W/lib/scoring-vocab.ts:85`, `:546`: the four reasons, the double walkover, and an expunge abandon. The pad, the activity feed and the timeline speak each.
- Modify the 4 dictionaries (`ui.json`, `public.json`), then `pnpm i18n:gen-keys`.
- Tests: `W/components/v2/scorepad/v3/__tests__/boardgame-forfeit-dock.test.ts`, `W/lib/__tests__/event-copy-forfeit.test.ts`, and `apps/web/e2e/walkthrough/scorepad-v3-boardgame-result.spec.ts` (updated).

- [ ] **Step 1: Failing tests.**
  - **Dock:** the dock's methods no longer include `forfeit` or `double_forfeit`. The Forfeit tile's sheet builds `core.forfeit` with each reason the D3 phase rule admits in `live` and `tiebreak`. The Double-forfeit tile builds `{by:"both", reason:"walkover"}`. Neither tile is offered to a non-organiser (`canOrganise: false`, X-RS-3).
  - **Copy:** for every member of `FORFEIT_REASONS`, plus `double_walkover` and `bye`, `eventCopy` and the ribbon return a DISTINCT dictionary key, and the key exists in all 4 locales. The keys are read from the dictionaries, counted, and zero is a failure.
- [ ] **Step 2: Run red** (`<N>` = 12).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green**, then the walkthrough spec whole, then the whole `mobile.spec.ts` if the dock's phone layout changed.
- [ ] **Step 5: Hand mutants** (`MUT/t12.json`):
  - `dock-forfeit-method-back` → the dock test;
  - `dock-not-organiser-only` → X-RS-3;
  - `copy-reason-collapsed` (every reason maps to one key) → the copy test.
- [ ] **Step 6: Screenshots:** the chess dock with the Forfeit sheet open at 1280, 768 and 320.
- [ ] **Step 7: Commit:** `feat(pad): W2b chess dock records core.forfeit with a reason; event copy speaks the four reasons and the double walkover`.

---

### Task 13: Public tags and sentences (UI-2) (spec §5.5 "Public")

**Loop H, last task.**

UI-2 option A is ruled: a short tag where space is tight, and the full sentence as the tooltip, the accessible name and the match-centre line.

**Files:**
- Create `W/lib/forfeit-tag.ts`. It returns `forfeitTag(outcome, ledger)` → `{tagKey, sentenceKey, params} | null`, the one reader. The abandon label reads the ledger (an active `core.abandon` and its reason), not the status (§5.4).
- Modify:
  - `W/server/public-site/match-centre.ts:757-758`: `award` → per reason; `double_walkover`; `win{method:"abandoned"|"dls"}` with the abandon reason;
  - `W/server/public-site/qualification-view.ts:97-108`: X-WO-1 reads `forfeitCredit`, and `divisionAwardAddsToLedger` is rewritten to ask the hook;
  - `W/components/public-site/live-score.tsx:89-96`;
  - `W/components/public-site/matches-hub/knockout-tab.tsx:75`, `:454` (the bracket tile);
  - `W/components/v2/stages-panel.tsx:1994-2001` (the division result line; `VOID_STATUSES` `:1904` keeps the strike, finding 21).
- Modify `public.json` in 4 locales: tags `w/o`, `ret.`, `DQ`, `2× w/o`, `Aband. · DLS`, `Aband. · NR`, per locale. The sentences follow `public-copy.html`'s examples. A bye keeps today's copy.
- Tests: `W/lib/__tests__/forfeit-tag.test.ts`, `W/server/public-site/__tests__/match-centre-forfeit.test.ts`, `apps/web/e2e/walkover-public.spec.ts`.

- [ ] **Step 1: Failing tests.**
  - **`forfeit-tag.test.ts`.** Empty case first: `null` for a played win, a draw and no outcome. Then one row per member, counted:

    | Outcome | Tag | Id |
    |---|---|---|
    | walkover | `w/o` | X-RS-2 |
    | withdrew | `w/o` | X-RS-2 |
    | retired | `ret.` | X-RS-2 |
    | disqualified | `DQ` | X-RS-2 |
    | `double_walkover` | `2× w/o` | X-DW-1 |
    | `win{dls}` with an active abandon | `Aband. · DLS` | X-AB-2 |
    | `no_result` with an active abandon | `Aband. · NR` | X-AB-2 |
    | bye | `null` | — |

    Every tag key exists in all 4 locales, and the fr, es and nl values are not the English string (per-locale abbreviations, UI-2).
  - **`match-centre-forfeit.test.ts`:**
    - "X-RS-2": each reason's sentence names the offending side;
    - "X-DW-1": "Neither side showed up — both lose" plus the next-round walkover clause when a seat was fed;
    - "X-AB-2": "Abandoned (rain) — Eagles won by 12 runs (DLS)";
    - "spec §5.5": no fixture whose active result is a chess double forfeit renders the "Level — winner to be decided" copy. This is the line Task 9 carried forward.
  - **"X-WO-1: the qualification view and the public table show the same credited score as the table":** a hockey walkover reads 5-0 in all three.
  - **`walkover-public.spec.ts`**, the whole spec: the results list at 320 shows the tag and its accessible name is the sentence (`getByRole(..., { name })`); the bracket tile at 320 shows the tag with no second line and no horizontal scroll; the match centre shows the sentence.
- [ ] **Step 2: Run red** (`<N>` = 13).
- [ ] **Step 3: Implement.** The sentence lives in a `score-sentence.tsx` nowrap span where it holds a score (W2a M1).
- [ ] **Step 4: Run green**: the unit files, `walkover-public.spec.ts` and `withdrawal-walkover.spec.ts` (Task 8's, now green), each whole, then the whole `mobile.spec.ts`.
- [ ] **Step 5: Hand mutants** (`MUT/t13.json`):
  - `tag-withdrew-ret` (withdrew → `ret.`) → X-RS-2;
  - `tag-dw-null` → X-DW-1;
  - `abandon-tag-from-status` (reads the status, not the ledger) → X-AB-2;
  - `qualification-played` (the view reads the played ledger) → X-WO-1.
- [ ] **Step 6: Screenshots** at 1280, 768 and 320: the match centre, the results list and the bracket tile. Each crop is checked for no horizontal scroll, and its verdict is written as text.
- [ ] **Step 7: Commit:** `feat(public): W2b tags and sentences — w/o, ret., DQ, 2× w/o, Aband.; one credited score on every surface`.

**Loop H closing gate:** Tasks 11–13's unit files; `i18n:check`; web tsc; the e2e files above, each whole; the whole `mobile.spec.ts`; and the per-screen verdict list (each screen PASS or FAIL, with the widths).

---

### Task 14: The rules rows — 53 new ids and X-BR-1 amended (spec §6, Appendix A)

**Loop C.** It waits on loop H merged, by which point every proving test exists.

**Files:**
- Modify `packages/engine/rules/{cross-sport,boardgame,carrom,cricket,generic}.md`.
- Create `packages/engine/rules/{football,hockey,icehockey,volleyball,badminton,tabletennis,tennis}.md`, in the format of `packages/engine/rules/README.md`.
- Modify `packages/engine/test/rules-reference.test.ts`: a `W2B_IDS` pin beside `SEEDED` (`:15`).

- [ ] **Step 1: Failing test.** `rules-reference.test.ts` gains "W2b: the 53 new ids are present, each signed or deviation with its ruling number from Appendix A, and X-BR-1's text says 'a win or a double walkover'". `W2B_IDS` is typed from Appendix A (the spec is the source here, not the code). Its count is asserted as 53, and the per-file counts as Appendix A's: cross-sport 22 new + 1 amended, football 3, hockey 3, icehockey 3, volleyball 2, tabletennis 2, tennis 2, badminton 3, cricket 3, boardgame 4, carrom 3, generic 3.
- [ ] **Step 2: Run red** (engine `<N>` = 14): the ids are absent.
- [ ] **Step 3: Write the rows** verbatim from Appendix A, with `status` as given (e.g. `signed 86 2026-10-08`; BD-WO-2 and BD-RT-1 `deviation 86` / `deviation 87`). Fill `enforced at` from the files Tasks 3–13 changed. Fill `proved by` from the test file whose title carries the id:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && for id in $(jq -r '.[]' "$TMPDIR/w2b-ids.json"); do printf "%s: " "$id"; git grep -l -E "(it|test|describe)(\.[a-zA-Z]+)?\(\s*[\"'\`][^\"'\`]*\b$id\b" -- '*.test.ts' '*.test.tsx' '*.spec.ts' | tr '\n' ' '; echo; done
  ```
  `$TMPDIR/w2b-ids.json` is the `W2B_IDS` array, written once with `node -e` from Appendix A's id column (`grep -o '^| [A-Z][A-Z]-[A-Z][A-Z]-[0-9]' docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md`, with X-BR-1 added by hand). Its length must be 54: the 53 new ids plus X-BR-1.

  An id with no file is a gap in its owning task. Fix it there, never with a new test written here to fit.
- [ ] **Step 4: Run green**: `rules-reference.test.ts` (the checker counts every signed row's proof).
- [ ] **Step 5: Hand mutants** (`MUT/t14.json`):
  - `w2b-id-dropped` (one row deleted) → the W2B_IDS pin;
  - `x-br-1-old-text` → the amendment check.
- [ ] **Step 6: Commit:** `docs(rules): W2b — 53 rows signed with their proofs, X-BR-1 amended (rulings 83–99)`.

---

### Task 15: The reference families `walkover-credit` and `bracket-finish` (extended) — **a DIFFERENT agent from loop D's implementer** (spec §5.6; R8)

**Lane P2, in worktree `format-matrix-w2b-reference`.** It starts after Task 0, and its only inputs are:
- Appendix A;
- the rulebooks (`rulebook-W2-sets-cricket.md`, `rulebook-W2-goals-boards.md`);
- the Interfaces frozen in Tasks 3, 6 and 7 above (names and shapes only).

It never reads `packages/engine/src/sports/**`, and the dispatch says so.

**Files:**
- Create `REF/families/walkover-credit.ts` and `walkover-credit.test.ts`.
- Modify `REF/families/bracket-finish.ts`: `LEVEL_KINDS` `:24` unchanged; `PlayResult` `:30` gains `double_walkover`; `Status` `:39` gains `forfeited`; `WinMethod` `:42` gains the four reasons; dead seats.
- Modify `bracket-finish.test.ts` (the W2a HELD table's chess double-forfeit rows are rewritten to BG-DW-1, spec §9 pins).
- Modify `REF/index.ts` (re-exports).
- Create `MUT/t15.json`.

**Interfaces:**
```ts
export interface CreditCase { sport: string; cfg: Record<string, unknown>; reason: "walkover" | "retired" | "disqualified" | "withdrew" | "double_walkover"; played?: { home: number[]; away: number[] } }
export interface CreditAnswer { winner: Record<string, number>; loser: Record<string, number>; excluded: string[]; points: "win" | "zero"; statsMatch: boolean }
export function walkoverCredit(c: CreditCase): CreditAnswer;           // from the rows, never the engine
export function enumerateCreditCases(): CreditCase[];                  // 11 sports × 4 reasons + double walkover, each sport's declared cfgs read as DATA from a JSON the lane writes from Appendix A
```

- [ ] **Step 1: Failing tests, empty case first.**
  - `enumerateCreditCases()` is non-empty and holds 11 × 5 = 55 base cases plus the cfg variants. The count is asserted.
  - `walkoverCredit` of each Appendix A example matches the row text: football walkover 3-0; hockey 5-0; 3-set volleyball 2-0 × 25-0; cricket's defaulter is charged its full quota; a double walkover is all zero with every ratio key excluded and `statsMatch: false`; retired and disqualified credit `statsMatch: true`.
  - `bracket-finish`: a double walkover in a semi seats nobody, and the other semi's winner is champion by walkover; X-DE-1; X-DW-3, where a final refuses `both`.
- [ ] **Step 2: Run red**, then implement, then run green (reference vitest, `<N>` = 15).
- [ ] **Step 3: The cross-check, after loop D merges into the lane.** A test in `packages/engine` (not in `REF`, because of the R7 boundary: `REF` may only `import type`) folds every enumerated case through the real engine and compares it with `walkoverCredit`. It counts agreements, and zero compared is a failure. Any disagreement is reported to the orchestrator with both answers. **It is never resolved by editing the reference to match the engine**: the rule row decides, and the loser gets a fix in its own loop.
- [ ] **Step 4: Hand mutants** (`MUT/t15.json`):
  - `ref-hockey-3` → the hockey example;
  - `ref-dw-points` → the double-walkover case;
  - `ref-enumeration-empty` → the count.
- [ ] **Step 5: Commit** in the lane: `feat(reference): W2b walkover-credit family and bracket-finish double walkover — independent oracle from the rule rows`.

---

### Task 16: The W2b cells locally, then the judge regression once on CI; `MATRIX.md`; the rekeys (spec §8.3–5)

**Run E2, unreviewed; the orchestrator re-checks every count.** It waits on loops C, P1 and P2 being merged, and a pushed branch.

**Files:**
- Create `TR/w2b-final/**`.
- Modify:
  - `TR/plans.lock.json` (append);
  - `TR/w2b-final/MATRIX.md` (rendered, never hand-edited);
  - `TR/w2a-repro/expect-77-rekeys.json` (the five `wave: "W2b"` entries removed; the merge notice authorises it);
  - `IDX`.
- Modify `E/core/w2b-repro.probe.test.ts` and `W/server/__tests__/w2b-repro.probe.test.ts`: the `W2B_REPRO` gate is removed.

- [ ] **Step 1: The W2b cells locally**, after a fresh `$S rebuild --label w2b`. Assert the selection first:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && jq '{cases: (.cases|length), newScenarios: (.newScenarios|length)}' docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w2b-local-selection.json
  ```
  Expected: `cases` 5 (the R4 cells) and `newScenarios` 5. Then run the truth-run command with `<tag>` = `final`. Every case is `works`. Each new scenario's counted checks are each `pass` with `checked > 0`. Copy the run to `TR/w2b-final/local/`.
- [ ] **Step 2: The five rekeys are greened, then removed.**
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && R=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs && node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/w2a-expect.ts --expect "$R/w2a-repro/expect-77.json" --rekeys "$R/w2a-repro/expect-77-rekeys.json" --now "$R/w2b-final/local/L3/results.json" --now "$R/w2a-final/ci/L3/results.json" --now "$R/w2a-final/ci/L2/results.json" --now "$R/w2a-final/ci/L1/results.json" --json-out "$R/w2b-final/w2a-expect-before.json"; echo EXIT=$?; jq '.greened' "$R/w2b-final/w2a-expect-before.json"
  ```
  - Expected: `EXIT=0`, and `greened` lists exactly the five boardgame R4 ids.
  - Then remove those five entries from `expect-77-rekeys.json`, with the note's text amended to say "removed by W2b Task 16, judged greened in w2b-final".
  - Re-run the judge with `--json-out …/w2a-expect-after.json`. Expected: `EXIT=0`, `greened: []`, with the five now judged as ordinary `works`.
  - The two non-W2b rekeys (`ko_plate|boardgame|blitz|F1` → W4, `swiss_playoff|generic|score|R4` → W3) stay.
- [ ] **Step 3: Ungate the probes.** Remove `runIf(W2B_REPRO …)`, keeping the DB condition on the web file. Run both files once with no env (engine and web vitest): all 22 green, which makes them permanent regressions.
- [ ] **Step 4: The full matrix once, on CI** (never locally):
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && git push origin feat/format-matrix-w2b && gh workflow run matrix-truth.yml --ref feat/format-matrix-w2b -f scope=full; echo EXIT=$?
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && gh run list --workflow matrix-truth.yml --branch feat/format-matrix-w2b --limit 1 --json databaseId,status,headSha,event
  ```
  Confirm `headSha` equals `git rev-parse HEAD` and `event` is `workflow_dispatch`. Wait with `gh run watch <id> --exit-status` in a background command that writes `EXIT=$?` itself. "cancelled" is not a pass (a push to main cancels it). All jobs red with 0 steps in about 3 s is billing, not a defect.
- [ ] **Step 5: Download and judge each layer.** The baseline is W2a's last committed CI results (`TR/w2a-final/ci/<L>/results.json`). If `gh run download 37951331449 --name merged` still serves W2a's final run, use that as the baseline instead, and record which was used:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && R=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs && rm -rf "$R/w2b-final/ci" && gh run download <id> --name merged --dir "$R/w2b-final/ci"; echo EXIT=$?
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && R=docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs && for L in L1 L2 L3; do NOW="$R/w2b-final/ci/$L/results.json"; [ -f "$NOW" ] || { echo "$L: NOT IN THE ARTIFACT"; continue; }; jq '[.cases[].caseId]' "$NOW" > "$TMPDIR/w2b-expect-$L.json"; pnpm matrix:judge regression --baseline "$R/w2a-final/ci/$L/results.json" --now "$NOW" --expect "$TMPDIR/w2b-expect-$L.json" --json-out "$R/w2b-final/judge-$L.json" > "$TMPDIR/w2b-judge-$L.log" 2>&1; echo "$L EXIT=$?"; jq -c '{compared, newlyRed: (.regressed|length), absent: (.absent|length)}' "$R/w2b-final/judge-$L.json"; done
  ```
  Expected, per layer: `EXIT=0`, `compared` > 0, `newlyRed: 0`. That includes the W3–W7 cells (§8.4). A cell that moved works → red is a regression and goes back to its owning loop. A cell W2b was not meant to move, but moved, is classified in `IDX` before it counts as anything. The W2a M1 harness regressions (`page_playoff_only|*|M1`, W2a false premise 50) are compared against the baseline that already holds them. Then rerun Step 2's judge with the CI L3 results added: `EXIT=0`, `greened: []`.
- [ ] **Step 6: `MATRIX.md` and the lock.** `pnpm matrix:render "$R/w2b-final/ci/L3/results.json" --out "$R/w2b-final/MATRIX.md"`, repeated per layer as W2a did. Append the lock entries. `committed-matrix.test.ts` green (no `.txt`).
- [ ] **Step 7: Commit:** `test(matrix): W2b truth run — 5 R4 cells greened and unpinned, 5 new scenarios works, CI judge 0 regressed`.

---

### Task 17: Pre-ship counts on staging and production (W2b-A1, W2b-R12)

**The orchestrator, immediately before Task 18's merge.**

- [ ] **Step 1:** Run Task 0 Step 4's four queries again, through the Supabase MCP (`list_projects` first; both projects by name; read-only `SELECT` only). Record the eight numbers in `IDX` with the time.
- [ ] **Step 2:** **Any non-zero `forfeits` or `complete_stages_holding_one` → STOP.** Bring the owner the actual rows:
  ```sql
  select id, fixture_id, payload from score_events where type = 'core.forfeit';
  select s.id, s.name, f.id, f.status from fixtures f join stages s on s.id = f.stage_id where f.status = 'needs_decision' and s.status = 'complete';
  ```
  Nothing ships until the owner rules (Q7). A non-zero `chess_forfeit_methods` / `settled_double_forfeits` count is reported. Task 9's migration and D6 already handle that shape, and their tests prove it.

---

### Task 18: Ship gates and the PR (spec §9, §10)

**Run E2, continued.**

- [ ] **Step 1: The migration number, again** (Task 9 Step 1's command). If main or the chess branch moved past `<next>`, rename the file, re-run `w2b-migration.test.ts`, and commit `chore(db): renumber the W2b delta to V<n> (main moved)`.
- [ ] **Step 2: Smoke.** Add `walkoverCreditSuite` to `scripts/smoke.ts` beside `bracketFinishSuite` (`:2251`, called at `:1111`). It runs against a live server:
  - a badminton league walkover reaches the table at 2-0 × 21-0;
  - a hockey walkover is 5-0;
  - a knockout semi double walkover seats the other semi's winner as champion;
  - a final refuses the double walkover;
  - a held chess fixture is walked over by a withdrawal;
  - a division whose only fixture is a double walkover refunds its quota slot.

  Each check is counted, and zero is a failure. Kill each check with one prod-build mutant, as W2a Task 17 did.
  - Run the two suites locally through a temporary copy of `scripts/smoke.ts` that calls only them, on a fresh label server, and paste the raw pass/fail counts.
  - The full smoke runs on the PR's CI (smoke is PR-only).
- [ ] **Step 3: e2e locally, whole files**, against a prod build (`$S rebuild --label w2b`):
  - `forfeit-dialog.spec.ts`, `walkover-public.spec.ts`, `withdrawal-walkover.spec.ts`;
  - `bracket-finish.spec.ts`, `scoring.spec.ts`, `bracket-new-h1.spec.ts`;
  - the walkthroughs Task 10 touched;
  - **the whole `mobile.spec.ts` on all 7 projects**, re-run until one full pass completes (class 21).

  Paste the raw counts.
- [ ] **Step 4: Stryker.**
  - The probe group locally, once: `cd WT/packages/engine && pnpm mutation:probe` (re-pin the script name). Record the score; floors are never auto-raised.
  - The touched families (all ten, finding 16) are dispatched once on CI as `gh workflow run mutation.yml --ref feat/format-matrix-w2b -f group=all`. Whether it gates the merge is Q6's answer. Survivors are routed per that answer, never silently.
- [ ] **Step 5: Per-screen verdicts.** One table in `IDX`, with each screen's verdict at 1280, 768 and 320 as PASS or FAIL in text: the console dialog before play, after play and with the final guidance; the chess dock; the match centre; the results list; the bracket tile; and the run-sheet walkover row. The crops stay in the gitignored scratch dir (owner ruling 2026-10-09). The **owner's verdict** is asked for in chat before merge; "CI green" is not sign-off (class 11).
- [ ] **Step 6: The PR.** One PR, with this body:
  - the `Matrix rows:` line listing the W2b case ids (R27; `tools/matrix/ci/pr-rows.ts`);
  - the rulings;
  - the false premises;
  - the screen verdicts;
  - the raw gate counts;
  - and, last, the PR attribution line the committing agent's system prompt gives.

  Then:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && gh pr create --base main --head feat/format-matrix-w2b --title "Format matrix W2b — walkover, retirement and double-walkover credit" --body-file "$TMPDIR/w2b-pr-body.md"; echo EXIT=$?
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2b && gh workflow run e2e.yml --ref feat/format-matrix-w2b; echo EXIT=$?
  ```
  The e2e is dispatched with `--ref feat/format-matrix-w2b`, because a dispatch runs the workflow file of its ref, and PRs trigger no e2e. Smoke runs on the PR. Before believing any run, confirm its `headSha` and that it was not cancelled.
- [ ] **Step 7: Loop R, the whole-branch review** (read-only; the reviewer agent from frontmatter). The scope is spec §1 "done means" 1–4 and the three standing lenses (customer, owner, test design). The reviewer gets:
  - this plan;
  - the spec;
  - the Review Focus;
  - the per-screen verdicts;
  - the raw gate counts.

  Findings go to a file in the gitignored SDD ledger, not chat. A Needs-Fixes verdict routes each fix to its owning loop's agent, then re-review.
- [ ] **Step 8: Merge** with a merge commit, after Task 17's counts are clean, the owner's screen verdicts are in, and Loop R is READY. Rebase onto main carefully first (migrations, overlap, re-run the scoped gates), per memory. Fold the W2 row into `IDX`: W2b MERGED, the PR, the merge commit and the evidence pointers.

---

## Self-review (writing-plans)

### 1. Spec coverage, section by section

| Spec § | Requirement | Task(s) |
|---|---|---|
| §1 done-means 1 | 54 Appendix A rows signed, enforced, proved by id-titled tests | 14 (with the proofs in 3–13; the literal-title rule in 4) |
| §1 done-means 2 | the §8 reds reproduced first, green after; the judge shows 0 new reds | 1, 2 Step 6, 16 |
| §1 done-means 3 | the reference families by a different agent, agreeing and counted | 15 |
| §1 done-means 4 | per-screen verdicts at 1280/768/320 | 11–13 Steps "Screenshots", 18 Step 5 |
| §2.1 items 1–8 | vocabulary; walkover credit; retirement/DQ; double walkover; RB2A-31; withdrawal; ST-G1; player stats | 3, 10; 4; 4; 3, 4, 6, 7; 3 (X-AB-4); 8; 7; 4 |
| §2.2 | out-of-scope items | not built. The final-DW vacant title is pinned as the W4 handover in 8 ("both finalists") |
| §3 rulings R1–R15, UI-1, UI-2, A1 | every ruling | R2 → 3, 4, 7; R3 → 4, 6; R4 → 4; R5 → 4; R6 → 4, 7; R7 → 3; R8 → 8; R9 → 4; R10 → 7, 11; R11 → 6, 7; R12 → 0, 17; R13 → 9; R14 → 3, 8, 11; R15 → 8 (W9 stays); UI-1 → 11; UI-2 → 13; A1 → 0, 3, 17 |
| §4 | architecture | 3–7 |
| §5.1 | event, phase guard, abandon guard, outcome kinds, byes, `advancesNobody`, `outcomeOf`, gate | 3, 7 (byes, gate) |
| §5.2 | per-module credit table, chess unification, schema tie, D-O1 re-pin, compile/runtime arms, player-stat folds | 4, 7 (D-O1, D15), 12 (dock) |
| §5.3 | `advancingSides`/`bracketWinnerLoser`, dead-seat clauses, seat assert, no next match, `completeTableStage`, ratio exclusions, auto-advance | 6, 7 |
| §5.4 | status order, expunge, append guards, withdrawal cascade + D-G2/D-G3 corners, migration, `division_has_results`, R12, the A1 pre-ship | 7, 3 (expunge), 8, 9, 0, 17 |
| §5.5 | console, pad, public, held chess double forfeits on public pages, copy | 11, 12, 13, 9 + 13 |
| §5.6 | generator breadth, model, observed, M7, reference families | 2, 15 |
| §6 | rules reference | 14 |
| §7 | the five error rows | 3 (codes + copy), 7 (no-next-match), 8 (`STAGE_SEAT_DEPARTED`); the `INVALID_PAYLOAD` row is false → `INVALID_EVENT` (finding 8) |
| §8.1–5 | generators first; reproduce (incl. the R4 ×5 and the Swiss chess 422); fix; CI judge; `MATRIX.md` | 2, 1, 3–13, 16 |
| §9 | 4 test types; anti-vacuity; engine-declared sweeps; Appendix A expectations with old-constant cases; rule-10 sequences; mutation; pins; UI; scoped local | every task; sequences in 2, 3, 8; pins in 3, 4, 7, 8, 9, 11, 15 |
| §10 | rows, one PR, merge commit, e2e by dispatch, smoke on PR, Stryker, whole-branch review, models from frontmatter | 14, 18, Execution model |
| §11 | risks (W2a moves, strict schema, prod behaviour, the sixth kind's reach, badminton deviation) | Step 0 re-pin; 0/17; 16 judge; 3 compile net + the f-w2 seam checklist; 4 (BD-WO-2, BD-RT-1) |
| §12 | f-w2's four musts | not level (3), explicit nobody-advances (7), the separate dead-seat clause (7), migrate unsettled only (9) |
| §13 | false premises 8, 9 | reproduced by 1 (`DE-RK`, `AA-FIN`), fixed by 6, 7 |

**Spec requirements with no task:** none. Three are covered only in part by design:
- §2.2's "replay from 0-0" stays unowned (as the spec records);
- the atomic withdrawal stays W9 (ruling 101);
- the vacant title stays W4.

### 2. Placeholder scan

`<N>`, `<next>`, `<id>`, `<port>`, `<tag>` and `<lane>` are parameters, each defined where it is introduced:
- `<N>` is the task number;
- `<next>` is computed by Task 9 Step 1's command;
- `<id>` is the CI run id that `gh run list` prints;
- `<port>` is the label's server port;
- `<tag>` and `<lane>` are named per step.

There is no "TBD", "TODO" or "similar to Task N" without the content. The "re-pin from the file" instructions name the file and the symbol; they are verification steps (class 5), not placeholders.

### 3. Type consistency

These names are used identically in every task that reads them:
- `FORFEIT_REASONS`, `AWARD_REASONS`, `OUTCOME_KINDS`, `ForfeitReason`, `AwardReason`;
- `advancesNobody`, `ForfeitPhase`, `ForfeitBy`, `ForfeitCredit`, `forfeitCredit`, `forfeitPhase`, `walkoverPhases`;
- `expunged`, `BracketFixture.walkedOver`;
- `WithdrawCascadeOut.walked_over_held`;
- the error codes `FORFEIT_REASON_WRONG_PHASE`, `ABANDONED_SETTLE_OR_VOID`, `DOUBLE_WALKOVER_NO_NEXT_MATCH`, `STAGE_SEAT_DEPARTED`;
- `forfeitDialogModel`, `forfeitTag`.

`award` is `{kind, winner, loser: EntrantId | null, reason: AwardReason}` everywhere (3, 4, 7, 13, 15, 2). `double_walkover` is `{kind}` everywhere. The model's `Forfeit.by` is `"home" | "away" | "both"`, and the event's `by` is `EntrantId | "both"`. Each layer maps between them once: the harness in 2, the dialog in 11.

### 4. Review Focus → owning tests

| # | Test (title) | Task |
|---|---|---|
| 1 | "Review Focus 1: void of a double walkover un-seats the walkover it caused" | 7 |
| 2 | the rule-10 sequence in `forfeit-guard.test.ts` + "Review Focus 2: void then the other side's walkover" | 3, 7 |
| 3 | "Review Focus 3: a hockey cfg frozen before W2b (awardScore 3) keeps its 3-0" | 4 |
| 4 | "Review Focus 4: double submit records one forfeit" | 11 |
| 5 | "Review Focus 5: X-WD-1 walk-over seats the remaining side in the next match" | 8 |
