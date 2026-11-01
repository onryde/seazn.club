# Format × sport matrix — programme index

Decision log and session status. Read `_RULES.md` beside this file first.

- **Design of record:** `../2026-09-27-format-matrix-design.md`
- **Audit inputs (hypotheses, not facts):** `audit-2026-09-27/`
- **Cross-programme sequencing:** `../bench-product-value/_MASTER.md`

## Status

| Wave | Scope | State |
| --- | --- | --- |
| W1a | L3 core: lean runner, HttpDriver, 11 stream generators, invariants, MATRIX generator | **Tasks 1–11 done; final review (R21) fix batch landed and re-reviewed 2026-09-28 (27/27 findings fixed, 0 new Critical/Important); CI green at `12029f214` (matrix step 1251/1251). MERGED 2026-09-28 — PR #896, merge `a5f813404`.** Live re-run after the batch: 24/24 ✅ at harness `e96a51ff1` — a pre-rebase SHA; its `scripts/matrix` is byte-identical to `61f8e19b7` on the rebased branch (run `fm-w1a-fix-b`, evidence `truth-runs/w1a-slice/`, schema v2), all three canaries red on their own check only — see "W1a session status" below. Worktree `format-matrix-w1a`, branch `feat/format-matrix-w1a`, PR #896 |
| W1b | Catalogues (atomic cases, applicability, variants, pairs) + reference skeleton | **Tasks 1–16 done: Tasks 1–15 end at `7c42d0ec2`, and Task 16 is the docs commit that writes this row; the final whole-branch review is next. PR and CI: controller's (R-PF10).** Plan `docs/superpowers/plans/2026-09-28-format-matrix-w1b.md`, branch `feat/format-matrix-w1b`. Live: slice 24/24 ✅ (run `w1b-slice-0928a`, `truth-runs/w1b-slice/`); probe 13 cases, 5 ✅ and 8 ❌ — the 7 DENIED cases are red on `denied-put-keeps-stages` (false premise 8 CONFIRMED, → W9), and `page_playoff_only` LIFECYCLE is red on a HARNESS defect, not the product (run `w1b-probe-0928a`, `truth-runs/w1b-probe/`); abandon check (ruling 30): ST-G1 CONFIRMED, judged 4/4 (run `w1b-abandon-0928a`, `truth-runs/w1b-abandon/`); model at HEAD on the 6 slice cells, fences on (`truth-runs/w1b-model-final/`): league\|generic ok, league\|badminton ok, knockout\|generic ok and knockout\|badminton ok, 20/20 runs each with the knockout fences on (final batch F-1 re-run `w1b-model-final-ko`; the first final run's knockout\|badminton, known MB-005 after 2 of 20 runs, was vacuous), swiss\|generic ok (run `w1b-model-final`, 20 runs), swiss\|badminton ok at `--runs 40` (run `w1b-model-final-sb40`, seed -2002771143; fix round 1's seed for this cell, -1180181307, was vacuous at the default 20 runs ("command Correct never ran", run `w1b-model-0929b`) and ok at 40 (run `w1b-model-0929g`)), 0 NEW; `--regressions` 5 known, each replays exactly (run `w1b-model-final-regressions`); MB-001 = #879 (seed 752674687, path `1:2:3:3:3:3:3:3`, run `w1b-model-0929f`). See "W1b session status" and "Findings routed (W1b)". |
| W1c | Browser layers: page objects, 11 pad adapters, L1/L2 | **Tasks 1–15 done 2026-09-30. Task 14 is the live evidence, and Task 15 is the docs commit that writes this row. Task 14+15 review (2026-09-30): Needs fixes; fix round 1 (`62d91dd48`, `93eb5af0d`), re-review 1 Approved. Final whole-branch review (2026-09-30): Needs fixes, 0 Critical / 2 Important / 19 Minor; the final fix landed (`0532d0cb6`, `e431cbbce`, `80f370e9f`, `d5ce3e871`, `6e857491d`, `975f53b23`). Final re-review: Needs fixes (I-2's own probe still passed); fixed in `f33c1b312` and the docs commit that writes this line. MERGED 2026-09-30 — PR #905, merge `ebf7ec040`.** Plan `docs/superpowers/plans/2026-09-29-format-matrix-w1c.md` (rulings 37–40). Worktree `format-matrix-w1c-exec`, branch `feat/format-matrix-w1c`. Live runs (2026-09-30, harness `b7668c0ff`, clean tree; evidence commit `79a141448`, in `truth-runs/`): HTTP slice 24/24 ✅ (`w1c-http-slice/results.json`); L1 at 1280, three runs of 6/6 ✅ each (`w1c-l1/w1c-l1-r{1,2,3}/results.json`); L2 slice 68 cases = 3 ✅, 7 🚫, 58 ░ (`w1c-l2/results.json`); API-only 5 🚫, each naming its wave, W4 ×3 and W5 ×2 (`w1c-api-only/results.json`); knockout\|badminton width sweep 1/1 ✅ at each of 7 widths (`w1c-sweep-ko/w1c-sweep-ko-<w>/results.json`); pad proof over 7 runs, 1280 × 4 (r4 a fresh-id rerun) and 320 × 3: 11/11 ✅ in six. In 1280 r3, 10 ✅ and cricket ❌: flake finding F-PP-1, one tap-wait timeout on `pad-ledger-as-generated`, cause unexplained, → W1d (`w1c-padproof/w1c-pp-<w>-r<n>/results.json`). Owner ruling 43 (2026-09-30) accepts the knockout sweep cell and the API-only set as planned 🚫. Parity against the HTTP slice: 0 differences for L1 r1, r2 and r3 (102 common checks each) and for L2 (46). Per-screen verdicts: `w1c-l1/README.md`, `w1c-l2/README.md`, `w1c-sweep-ko/README.md`, `w1c-padproof/README.md`. New product findings: N-1 (→ W4) and N-4 (→ W10), plus soft N-2, N-3 and N-5. See "W1c session status", "Findings routed (W1c)" and "W2 checklist". |
| W1d | CI (weekly + dispatch, visibility guard) + first full truth run | **Done (2026-10-08)**: **PR-A merged (#921, merge commit `47f210e3f`, 2026-10-05). PR-B (Tasks 17–22) merged (#926, merge commit `f10392517`, 2026-10-08; both Opus whole-branch reviews closed) and `MATRIX_WEEKLY_ENABLED` is set (2026-10-08); the first weekly runs (matrix truth Sat 2026-10-10, Stryker Sun 2026-10-11, cold) are read as a carry: Tasks 17–22 are done (17 the three dispatches, see "W1d dispatches"; 18 the triage tooling; 19 the triage rules and the 164 P-rule reds re-keyed (163 to a gap, 1 with none); 21 the baseline commit at `truth-runs/w1d-baseline`, owner ruling 70's three cells held red by `judge regression`; 22 Steps 1–2 the per-wave backlog written at the end of this file by `matrix:backlog`). Task 20 (Stryker) is done: the first full run is workflow run 37371368951; seven long legs were cut into parts from it and every one of the 81 legs is timed from its own measured run; the ten family floors sit 0.5 point under the measured scores (ruling T20-FLOOR-MARGIN); see `truth-runs/w1d-baseline/MUTATION.md`. Task 22 Step 3, the owner setting `MATRIX_WEEKLY_ENABLED`, comes AFTER PR-B merges (ruling T22-REORDER, with Task 20 Steps 2–4): the one variable also gates the Sunday Stryker run, and main's PR-A Stryker workflow is uncalibrated and has no `max-parallel`.** PR-A is Tasks 1–16 on `feat/format-matrix-w1d-infra` (worktree `format-matrix-w1d-exec`), each task closed on a clean task review (the whole-branch review's fixes landed in the final-fix round), and the 28 "W1d first tasks" are closed below (each names its task and commit; item 13 is accepted with no code). Task 16's live smoke on a fresh env: the HTTP slice is unchanged (24/24, no difference against `w1drv-http-slice`), and the sharded form (`--shard 1/2`, `2/2`, `matrix:merge`) is state-for-state identical to the unsharded run. Merge gate: the owner merges PR-A (ruling 62); PR-B (Tasks 17–22, the evidence) is cut from `main` after. **Plan APPROVED (ruling 69)**; review 8 Approved (0C/0I/3m carried) on `2d3a7801f` (review-1 to review-7 fixes on `ed9801b60`) (2026-10-04): `docs/superpowers/plans/2026-10-04-format-matrix-w1d.md` on `docs/format-matrix-w1d-plan` off `main` `dfe8132da`. Owner rulings 60–68: GitHub weekly + dispatch, harness-green per §6.5, one plan and two PRs (PR-A Tasks 1–16 infra, PR-B Tasks 17–22 evidence), every ❌ keyed by gap ID, full scope L1 231 + L2 1,731 + L3 937. **D7 resolved by ruling 65** (no ░ applies to driven cases only; the merge judges with `--planned-not-run allow`). **Ruling 66:** the matrix proves formats and rules, not scheduling, so the placement container and greedy guard are removed. **Ruling 67:** Stryker covers the whole engine except placement scheduling, in ten groups sized from measured mutant counts and wall time (Task 15 cut them into 27 legs from the measured 26 runner-seconds per mutant, 2.6× the plan's formula). **Ruling 68:** the repo goes private after W1d, so every matrix and Stryker job takes a switchable runner (`vars.MATRIX_RUNNER`); the Fly runner is a follow-up outside W1d. Sonnet for implementers and task reviewers, Opus for the two whole-branch reviews (owner). No owner question blocks a task. |
| W1-driving | L3 driving breadth W1a deferred: multi-stage seeding, team rosters, ladder/americano/mexicano, parallel workers, I2 champion rules for DE/stepladder/page-playoff | **Tasks 1–16 done 2026-10-01. Tasks 1–15 each closed on a clean review (Task 15 on re-review 1, Approved, after two fix rounds). Task 16's review: Needs fixes (0 Critical, 1 Important, 7 Minor); fix round 1 landed (T16-R3, T16-R4). Its re-review passed, and the final whole-branch review (the controller's, T15-R1) and its scoped re-review both Approved. MERGED as PR #912, merge commit `c347fedf9` (2026-10-01), and the worktree and branches were removed afterwards. The post-wave cleanup (rulings 55, 56, 58) is PR #913 (`67d6b1a8a`, 2026-10-04): the harness now lives at `tools/matrix`.** Plan `docs/superpowers/plans/2026-09-30-format-matrix-w1-driving.md` (rulings 44–54; the owner's 2026-10-01 decisions are rulings 55–59); prompt `W1-driving.md`. Worktree `format-matrix-w1-driving-exec` and branch `feat/format-matrix-w1-driving` were removed after the merge. **Done-when (ruling 48), on `truth-runs/w1drv-l3/results.json`** (`--set w1-driving --workers 4`, harness `15ed62365`, clean): 937 cases = 743 ✅ + 194 ❌; ⏳ naming W1-driving **0** (⏳ of any wave 0); harness ❌ **0** after triage — the 60 harness reds were three defects, each fixed test first (`9a64ec4cd`, `b1325f721`, `e51bf3699`), and 30 of those cases are ✅ on their re-run. **164 product reds**, each judged on its latest committed run (`truth-runs/w1drv-l3-rerun/`, `truth-runs/w1drv-l3-fr1/`, `truth-runs/w1drv-l3-fr2/`), 0 unfit, 0 unclassified, per wave **W2 62, W4 32, W7 56, W5 11, W3 3** (`truth-runs/w1drv-l3/TRIAGE.md`; before ruling T15-R4 moved the bracket-draw stall to W2: W4 94, W7 56, W5 11, W3 3). HTTP slice on 4 workers: 24/24 ✅, the 378 checks it shares with W1c identical in verdict and count (`truth-runs/w1drv-http-slice/results.json`). **L1 proof at 1280, ×3** (`truth-runs/w1drv-l1/w1drv-l1-t15-r1/results.json`, `-r2`, `-r3`, harness `63bda33e4`): 7 cases each, 6 ✅ and `mexicano\|generic` ❌ (the predicted W7 round-2 self-pair 500); r2 and r3 identical to r1 on every check, and r1 identical to T13's `w1drv-l1-r1` on all 206 checks; per-screen verdicts in `truth-runs/w1drv-l1/README.md`. Model (`truth-runs/w1drv-model/`): swiss\|badminton and swiss\|generic ok at 40 runs, league\|football ok at 20; of the six single-stage rows without model evidence, four ok, and double elim and stepladder each found a NEW product red, committed as MB-007 and MB-008; Task 16's widened-fence run found MB-009 (`w1drv-t16-model-g1`), then both cells ran ok (`w1drv-t16-model-g1c`), and `--regressions` replayed all 8 committed cases as known (`w1drv-t16-model-reg2`). **MB-010 (fix round 1, T16-R3):** with the double-elim generate fence narrowed to the added-entrant branch, the live double-elim cell found Start → Withdraw → Generate 500ing in MB-007's words (`w1drv-t16fr1-model-de`). It is committed as MB-010, and the fence's withdrawn branch now covers double elim on its evidence. Double elim then ran ok 20/20 (`w1drv-t16fr1-model-de2`), and `--regressions` replays all 9 committed cases as known, each under its own id (`w1drv-t16fr1-model-reg`). See "Findings routed (W1-driving)" and "W1d first tasks". The branch was rebased onto `main` twice (2026-10-01): every recorded harness SHA is pre-rebase and stays as recorded; `truth-runs/W1-DRIVING-REBASES.md` maps each to its rebased commit and shows the harness unchanged across both. |
| W2 | Sport scoring fidelity | **Awaiting** the owner's merge go on PR B (#1069) — W2 is built, and the row closes then. **W2e: PR A MERGED** (#1068, merge commit `18155d5ca0`, 2026-10-29; Tasks 0–26, engine, rules and harness; migration V481, `V481__w2e_stored_config_cleanup.sql`). **PR B** (Tasks 27–36): the web (ruling-157 editor fields, the sanction-ending and short-team pad prompts, `rank: null` on a level table), the W2 truth run (CI 40874582041 15/15; L3 EXIT 1 is the two known SW-H1 flips), the data audit, the release-notes draft and this fold (rulings 221–241, "Controller rulings (execution, W2e)", "False premises found (W2e)", "Findings routed (W2e)"); its final whole-branch review, CI and the owner's merge go after the owner's staging steps are owed. Every W2e rule row is signed by its ruling and proved (`AWAITING_PROOF` empty). **Not yet closable:** the five #1061 export rows are open (ruling 237), and eleven harness routes still name W2 ("Findings routed (W2e)"). **W2b MERGED** (#945, merge commit `04bfa54f9`, 2026-10-13; rulings 83–128; the known reds left on main are the two `stryker-sizing` tests, re-cut by the mutation session, and a flaky stream-credits claw-back test). **W2a MERGED** (#931, merge commit `a99147bd0`, 2026-10-09). **W2b**: spec approved (rulings 83–100), build branch `feat/format-matrix-w2b`; plan approved (ruling 102), executing subagent-driven. **W2b Task 1 — reproduction (2026-10-09, `46251836c`, before any product change):** all 22 gap probes red (engine 10 of 10, server 12 of 12, each an `AssertionError` or a named `EngineError`, none a probe `TypeError`) and the 5 inherited CD-T13 boardgame R4 cells red for their pinned reason (W2a's judge on the five: exit 0, 5 red as pinned); probes gated `W2B_REPRO=1` (closed: 10 and 12 skipped, exit 0); evidence `truth-runs/w2b-repro/`; X-WD-3 reproduces the throw, so D17's fix applies; six false premises in "False premises found (W2b)" (11–16). **W2c PR pending** on `feat/format-matrix-w2c`: Tasks 0–22 done (2026-10-23, head `0bd3d3e1cf` before Task 23's rebase onto main); Task 23 owes the rebase, the scoped gate, the final review, the PR, the e2e dispatch and P8, under the owner's "rebase and pr when ready" and "merge if all green" (ruling 159). Spec `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` approved (owner Q1–Q11, S1–S5 and the §1 amendment, rulings 160–176; P-1..P-6); plan `docs/superpowers/plans/2026-10-13-format-matrix-w2c.md` approved 2026-10-13 (rulings 135–141). W2c's rulings are 129–176. Its 17 Appendix A rule rows and X-AB-5 are proved (`AWAITING_PROOF` empty). MD-1 classified 69 survivors (W2c's changed lines, plus `points.ts` in full), 0 unclassified. The plan's decisions are under "Recommendations" ("For W2c"); see also "Controller rulings (execution, W2c)", "False premises found (W2c)" and "Findings routed (W2c)". Batch 1 closed: Task 1 splits `match-rules` per sport; Task 2 locks division settings by name per started inheriting stage (X-SR-4, proved). Task 3 wrote the 17 Appendix A rule rows (ruling 129; 15 new, BG-KO-1 and BG-KO-2 amended), 16 of them awaiting their proving task in `AWAITING_PROOF`. Task 1's `t1-order` mutant is equivalent: every `SPORT_RULES` consumer indexes by sport key, the only iteration (`match-rules-best-of-one.test.ts:35`) is sorted, and `STAGE_RULES_SPORTS` is a literal. **W2d:** **PR A MERGED** (#1038, merge commit `79ebb3187b`, 2026-10-27; Tasks 0–12 plus A14, A20 and A21; migration V475, `V475__w2d_table_rules.sql`). **PR B** (Tasks 13–21, branch `feat/format-matrix-w2d-b`, draft #1053) rebased onto main `4a9e180958` at `a719e11309` (2026-10-28); Task 21 folded W2d into this file (rulings 177–220, "Controller rulings (execution, W2d)", "False premises found (W2d)", "Findings routed (W2d)", "W2d and ruling 70"), and PR B's gates, final review, CI and the owner's merge go are owed. Spec and plan approved by the owner 2026-10-20 (rulings 177–196); started 2026-10-24 at `W2D_BASE=e97823e4d8`. Rule rows: spec Appendix A's 43 new rows are signed by ruling 197 (2026-10-24) and every one is proved (`AWAITING_PROOF` empty); X-WO-1 carries ruling 182 (D6). No production release until the whole of W2 is done (ruling 213). Prior W2a detail: **In progress** — W2a Tasks 0–17 done; **PR #931 open, awaiting merge** — loop R re-review READY (2026-10-09). CI truth run 37951331449 at 4162e7962: `w2a-expect` judge exit 0 (70 works + 6 red as pinned: five boardgame R4 → CD-T13/W2b, ko_plate F1 → FX-G14/W4; `swiss_playoff|generic|score|R4` greened, so its SW-H1 pin is stale and is reported, not failed); regression judge 0 regressed, 0 absent over L1 231 / L2 1729 / L3 937. e2e dispatch 37951344351 green on `refs/pull/931/head`. Full Stryker `group=all` is not a merge gate (owner 2026-10-09); it runs on main after merge. **Split into W2a–W2e (2026-10-08, ruling 71).** **W2a — brackets always finish:** design approved section by section in chat 2026-10-08 (rulings 72–79); spec `docs/superpowers/specs/2026-10-08-format-matrix-w2a-design.md` APPROVED; plan `docs/superpowers/plans/2026-10-08-format-matrix-w2a.md` APPROVED (rulings 80–82), executing subagent-driven; worktree `seazn.club-worktrees/format-matrix-w2a`, branch `feat/format-matrix-w2a`. W2b–W2e not started. **W2a Task 1 — reproduction (2026-10-08, harness `805443544`, before any product change):** all 77 reds reproduce (SC-O1 65/65, SC-O2 12/12; L1 12, L2 3, L3 62), each with the baseline's own failing-check set; NEW-H1 reproduces (an abandoned badminton semi-final, then a walkover on the other semi, turns the final into a `forfeited` award for the walkover's winner); evidence `truth-runs/w2a-repro/`, probe `apps/web/e2e/bracket-new-h1.spec.ts`; two false premises in "False premises found (W2a)". **W2a Task 2 — rules reference (2026-10-08):** `packages/engine/rules/` seeded with the ten signed rows (X-BR-1, X-BR-2, X-ST-1, X-ST-2, X-DR-1, BG-KO-1, BG-KO-2, CA-KO-1, GN-KO-1, CK-KO-1), every one awaiting its proving task (`AWAITING_PROOF` in the checker); checker `packages/engine/test/rules-reference.test.ts`; rulings 71–79 point to their rule rows. **Fix round 1 (review I-1..I-3, spec §6 amended):** a proof must be a test file (not `rules/`, `docs/` or the checker) whose `it`/`test`/`describe` title holds the id as a whole token, every listed path proving it, a matrix case never sufficient alone; a row-shaped line the parser skips is a failure; the ten seed ids are pinned; and the checker runs on every PR as a step of the `gates` job in `ci.yml` (22 tests; 65 hand mutants through `pnpm mutate`, all KILLED, `mutants/w2a/t2.json`). **Round 2 (re-review M-1, M-2, M-4):** a conditional skip (`it.skipIf(c)(…)`, `.runIf`) and `test.describe.serial|parallel` carry a title; an unconditional `.skip`/`.todo`/`.fixme` yields none and its body is not entered; the gates step judges with `node -e` like its siblings, tested through real bash and node (25 tests; 83 hand mutants, all KILLED). **W2a Task 3 — X-DR-1 (2026-10-08):** `@seazn/engine/core` exports `BRACKET_KINDS` (knockout, double_elim, stepladder, page_playoff, ladder), `DRAW_KINDS` (league, group, swiss, americano), `forbidsLevelResult` and `isLevelOutcome`; every `supportsDraws` is an allow-list over `DRAW_KINDS` (boardgame no longer draws in a bracket, generic no longer in page_playoff or ladder; football, cricket and the period kernel gain americano, plan finding 15); the testkit's `declaredCfgs` is the one cfg source for W2a sport sweeps; the 11 sports × 9 kinds sweep reads its expectation from a per-sport rule row, never from `supportsDraws`. X-DR-1 proved (`sport/supports-draws.test.ts`, `core/stage-kind-sets.test.ts`). The 18 boardgame golden streams whose outcome is a draw are re-baselined for `deltas.knockout` only, in the commit after Task 3's (controller ruling D-G1; W2a false premise 3). Four `tools/matrix` tests that pinned ladder and page_playoff draws go to lane P1 (ruling D-H1; W2a false premise 4). **W2a Task 4 — X-ST-1 (2026-10-08):** the kernel owns `core.settle` (`SETTLE_METHODS` lot, higher_seed, organiser; never forwarded to `module.apply`, so no golden moves); `settleApplies` is the one precondition (a level outcome, or nothing decided with an abandon or a pending `awaitingDecider`); `outcomeOf(module, folded)` is the outcome of every fold, read by the six briefed readers plus carrom's and generic's player-stat folds (ruling D-C3), and `apps/web/.../outcome-readers.test.ts` pins both the bare-call and the property-read shape; four error codes are appended (`SETTLE_NOT_APPLICABLE`, `TIEBREAK_NOT_APPLICABLE`, `LEVEL_RESULT_IN_BRACKET` 409, `LEVEL_RESULT_SEATED` 500) and mapped in `http.ts`, `scoring-vocab.ts`, the harness restatement `tools/matrix/lib/driver/engine-http.ts` (ruling D-C2) and four locales; `core.settle` has interim copy on the activity feed, the scorer ribbon and the public timeline (ruling D-C1; keys `event.core.settle`, `eventCopy.settled` + `.lot`/`.higher_seed`/`.organiser`, `pad.ribbon.core.settle`, `timeline.core.settle` + the same three — loop H reuses them). X-ST-1 proved (`core/settle.test.ts`; W2a false premises 5 and 6). **W2a Task 5 — BG-KO-1, CA-KO-1 (2026-10-08):** every module declares `bracketDeciders(cfg)` (boardgame `{tiebreak: true}`, carrom `{tieBoard: "extra"}`, the other nine `{}`); boardgame's optional `tiebreak` cfg sends a drawn bracket game to phase `tiebreak` (a double forfeit is held `no_result`, controller ruling T15-R1) and `boardgame.tiebreak {rung, winner, score?}` decides it with `tiebreak_<rung>`, the summary keeping the level game; `deciderPending(module, folded)` is the engine's "a decider is still owed" signal and `settleApplies` short-circuits on any decided outcome (ruling D-C5); the app vocabulary the new type forced lands with it (ruling D-C4; keys `event.boardgame.tiebreak`, `pad.boardgame.ribbon.tiebreak`, `pad.boardgame.action.tiebreak`, `pad.boardgame.panel.tiebreak`, `pad.boardgame.tiebreak.rung.rapid`/`.blitz`/`.armageddon` — loop H reuses them). Golden coverage `boardgame/knockoutTiebreak` appended (one stream). BG-KO-1 and CA-KO-1 proved (`sports/boardgame/tiebreak.test.ts`; `sport/bracket-deciders.test.ts`, `sports/carrom/carrom.test.ts`); W2a false premises 7–9. **W2a Tasks 6–9 — loop F (2026-10-08):** T6 `ba20f2061`: `resolveFixtureCfg` overlays the sport's `bracketDeciders` when the stage kind forbids a level result, at all 11 call sites (each driven through a spy; 19/19 mutants). T7 `1eb60c9ae`: a level bracket result is held `needs_decision` (V432 — V431 was taken by #928; backfill per ruling 82); `FIXTURE_STATUSES` is the one list; `status-set-sweep.test.ts` counts every status set against a classified ledger (125 rows); 26/26 mutants. T8 `02c83ed52`: hold, not refuse (generic alone refused `LEVEL_RESULT_IN_BRACKET`); finalize refused while `settleApplies` (folded BEFORE the candidate — the module's WRONG_PHASE answers first otherwise); settle refused outside a bracket and for a withdrawn winner; `assertNoLevelSeat` (`LEVEL_RESULT_SEATED`) on every seating read; X-BR-1, X-BR-2, GN-KO-1, CK-KO-1 proved; 18/18 mutants. T9 `bf49cd67e`: settle/forfeit/abandon organiser-only (403 for device links and official scorers, API key passes) and, per owner ruling D-O1, chess `boardgame.result` method forfeit/double_forfeit too — one client-safe predicate `isOrganiserOnlyEvent` (`lib/organiser-only-events.ts`) read by the server gate and the pad's tile filter, the sport list DERIVED in the test from the engine's declarations (11 modules, 26 enum fields, 7 candidates, 2 gated); X-ST-2 proved; 14/14 mutants. The chess dock's forfeit chips (`skins/boardgame.tsx:148-165`, `buildDock` :524) are routed to loop H. Report the loop-F report in the local (gitignored) SDD ledger; W2a false premises 10–18. **W2a Task 10 — NEW-H1 (loop G, 2026-10-09, D4):** `feederIsDead` (`usecases/stages.ts`) no longer reads an `abandoned` fixture with no outcome as a generator void when its ledger holds an ACTIVE `core.abandon` (one no `core.void` targets; `has_active_abandon` on `resolveBracketSeats`' SeatRow). A scorer-abandoned feeder's fed seats (winner and loser edge) wait unstamped and visible for the organiser's settle; a generator void (no event) and a voided abandon still cascade the walkover; a held `needs_decision` feeder is not dead either. The 11-sport sweep (each module's first declared variant at its default cfg: 8 fold an abandon to `null`, 3 to `no_result`, both shapes required) proves the fed seat waits; the 6-shape sweep (the five `BRACKET_KINDS` plus knockout third place) abandons a feeder in each of the five seated shapes, then settles it and plays each to `completeStage`; the ladder wires no feed edge and is the empty case there. Probe `e2e/bracket-new-h1.spec.ts` green. `stage-roster-drift.test.ts` gains the loop-F `needs_decision` row its vocabulary pin was missing (red on the branch since T7). X-ST-1 also proved by `dead-feeder-cascade.test.ts`. W2a false premises 19–21. **Fix round 1 (loop G review, ruling D-G1 — measured by the reviewer):** a scorer-abandoned FINAL completed the stage and ranked its two finalists below the semi-final losers (`engineFixtureStatus` maps `abandoned` to `void`, which the engine counts as settled; `bracketRanks` ranks an entrant with no loss at round −1), and an abandoned ladder challenge completed the ladder the same way. `engine-db/recorded-abandon.ts` is now the one definition of a recorded abandon (`hasActiveAbandonSql`, gated on the status, read by the cascade and by `loadStageInputs`) and of one that decided nobody (`abandonAwaitsSettle`: active abandon, outcome null or level); `bracketEngineStatus` reads it as `in_play` in the bracket and ladder completion branches, so the stage waits for the settle (table stages keep `void`). A guard refuses (`CONFIG_INVALID`) to complete a bracket that would rank an unbeaten entrant still in the field by the −1 default; departed entrants (F14) stay exempt. Proved across all 11 sports (both abandon shapes), the probe, a ladder, and the guard on a forced row with its departed positive pair. Ruling D-G2 characterisations (W2b): a settle seats a withdrawn loser on page_playoff's loser edge; an abandoned line whose entrants both withdraw refuses every settle (knockout and page_playoff), with the organiser's void-and-forfeit escape driven. **Fix round 2 (re-review, ruling D-G3 — deferred to W2b):** the guard has one product path today, pinned as a characterisation: a stepladder seed who departs before the draw has her final voided by the generator (F14) and the climber seated into it, so completion is refused at generation and after the rungs until the organiser forfeits her in the final. A ladder holder's withdrawal holds the ladder until the remaining challenger is settled through (the swap applies). A league with recorded abandons (a scorer's and an expunge withdrawal's) still completes: table stages keep `void`. 15/15 mutants (`mutants/w2a/t10.json`). **W2a Task 11 — the console settles a held fixture (loop H, 2026-10-09; UI-1 option A):** `components/v2/needs-decision.tsx` — `needsDecision` = bracket kind AND the kernel's own `settleApplies` (outcome, an ACTIVE `core.abandon` in the ledger, the module's `awaitingDecider`), so a level knockout result, an abandon that decided nobody and a chess game waiting on its tie-break all show "Needs a decision" with a settle dialog (winner, why: lot / higher seed / organiser, optional note; confirm blocked until both are chosen and while sending; a refusal closes it and shows the reason in the block). The console gains `canOrganise` (the page's owner/admin `canEdit`, never `canScore`) and `stageKind` (from `loadFixturePadCfg`, no longer discarded on the fixture page): the block, Forfeit and Abandon are organiser-only (X-ST-2, finding 11), Finalize is hidden while held (finding 27), and the match-actions band renders only when it holds a control. Run sheet: a held row carries a red "Needs a decision" chip and its one action is Settle (`fixtureRowAction` kind `decide`, editors only). 13 keys × 4 locales. e2e `bracket-finish.spec.ts` (console part, 6 tests incl. an official scorer minted in-spec); 11/11 mutants (`mutants/w2a/t11.json`). W2a false premises 22–25. **Task 12 — the pad is stage-aware (loop H, 2026-10-09; UI-2 option B):** the fixture's `stageKind` (from `loadFixturePadCfg`, no longer discarded on either page — addendum 4) rides `ScorePadBootstrap` to `PadHostView.stageKind`, beside a new `canOrganise` (the console's organiser flag; always false on a device link). Generic: `allowsDraws(cfg, stageKind)` adds `!forbidsLevelResult(kind)`, so a bracket loses the Draw tile (win_loss), the level "Finish from tally" (score) and the "Draws allowed" context, and its level strip is accented. Chess keeps Draw in every kind while live (D-P1); a drawn knockout game offers ONLY the tie-break tile, gated on the kernel's `deciderPending` with the ledger's active settle (`settlementOf`, `resolveVoids`) — so after an organiser's settle the pad reads post and offers nothing (addendum 1). The three-step sheet: rung (lots hint → the organiser), winner (exactly the two entrants; the Armageddon step alone carries "a draw means Black advances", ruling 82), optional score (rapid/blitz). The chassis drops any dock chip whose write is organiser-only for a non-organiser (`dockFor`, `isOrganiserOnlyEvent`; chess forfeit / double forfeit — addendum 2). `SheetChoiceOption.labelText` (a winner's name). 8 keys × 4 locales. BG-KO-2 proved (`boardgame-tiebreak.test.ts`). e2e `bracket-finish.spec.ts` pad part (8 tests) + a `mobile.spec.ts` tie-break test per width; 34/34 mutants (`mutants/w2a/t12.json`). W2a false premises 26–31. **Task 13 — the public site and the status surfaces (loop H, 2026-10-09; addenda 6, 8, 9):** every settle method (`settled_lot`, `settled_higher_seed`, `settled_organiser`) and tie-break rung (`tiebreak_rapid`, `_blitz`, `_armageddon`) has its own decided sentence in 4 locales, the list read off the engine (`SETTLE_METHODS` through `settledMethod`, `TIEBREAK_RUNGS`); a scored rapid or blitz tie-break states its score from the summary's own `detail.tiebreak.score` (`tiebreakScoreFromDetail`, the one reader) on the match centre, the hub result line, the live score, the console, the overlay band and the public page's meta description, and the board keeps the level score. The match centre's `RESULT_KINDS` carries the six methods (16 kinds) and two `.scored` keys (`RESULT_SCORED_KEYS`). A held fixture (`needs_decision`) is marked on the public bracket (amber rail, held chip, level score, no winner highlighted), keeps its subheading time line, is `EventCompleted` in JSON-LD and gets a `held` OG poster. The officiating lane's assignment card says a held duty is held and keeps its Score link; its status badges are the dictionary's words in the dictionary's case (`scoreStatusLabel`, `lib/score-status-label.ts`, one helper for the lane, the console and the device pad). Desk (addendum 9): a recorded abandon in a bracket stage that decided nobody (`fixtureAwaitsSettle` over `abandonAwaitsSettle`, the one source) is live work and never Finished, and every held fixture raises one red `needs_decision` attention (pill "Needs a decision"; Needs-you row "Settle the match", opening the console for one fixture and the fixtures tab for several); the division page reads the same predicate (`listFixturesAwaitingSettle`). 8 public + 14 ui keys × 4 locales. e2e `bracket-finish.spec.ts` (public part: 5 tests, incl. the official's lane and the desk; plus a 320-vs-1280 control-set diff of the tie-break pad) and a `competition-desk-actions.spec.ts` row on the recorded-abandon shape; 38/38 mutants (`mutants/w2a/t13.json`). W2a false premises 32–38. **Loop H fix round 1 (review C0/I2/M14; rulings D-H1–D-H3, 2026-10-09):** the console offers Forfeit and Abandon only while nothing is held (`!decided && !held && canOrganise`, I1); the chess tie-break's winner and Armageddon options read the ENTRANTS' names with ids home/away (`PadHostView.entrantNames`, I2); a result sentence's score never splits across lines (`components/score-sentence.tsx`, a nowrap span at the HTML surfaces only — share text, OG and overlay strings unchanged, M1); a held fixture counts as played for the desk phase, so a held-only division reads in progress, not "Setting up" (D-H2: `PLAYED_STATUSES` gains `needs_decision`, `hasPlayedFixture` reads `awaitsSettle`); the public held wording is "Level — winner to be decided" (D-H3, 4 locales), the console block's sentence branches by cause (`heldCause`: level result / abandoned / tie-break pending) and the officiating lane's link on a held duty reads "View match" (superseding addendum 8's Score link); an official scorer on a held fixture is told why nothing is offered (`held-note`, M7); the public schedule reads a held fixture as ended (M5); the console status badge keeps the dictionary's case (M6); the run sheet carries a recorded abandon's hold — `awaitingSettle` threaded page → StagesPanel → RunSheet → row, chip and Settle, names not struck (M10); the settle dialog's names wrap whole (M12); the match centre's `DECIDER_METHOD_SET` guard is restored ahead of cricket's margin (M13; premise 37 reversed); `scoring-vocab.ts` restates the engine's settle-method and rung tuples, pinned against the engine by an equality test, because the value import put the boardgame module into the public match page (450,468 → 295,410 B gz of client JS, 24 → 20 files, measured on prod builds; M4); the pad ribbon wraps to two lines instead of truncating (`line-clamp-2`); the status-set ledger is brought current (`status-set-sweep.test.ts` had been red since `cea1a52c8`, premise 46). 4 ui keys + 1 public value × 4 locales. W2a false premises 39–47. **W2a Tasks 16–17 — the evidence and the ship gate (run E2, 2026-10-09):** CI truth run **37916609028** (workflow_dispatch, `e45d74203`) plus 81 local runs at `dbff3e5cc` (label `w2ae2`). Ruling D-P2's judge (`w2a-expect.ts`) is **NEGATIVE**: on CI, 69 works + 6 red as pinned + **2 unexpected red**; locally, 70 + 6 + 1. In both, 0 have the wrong reason and `greened` is [] (no stale pin). The six re-keyed cells match their pins: five boardgame R4 cells (knockout, knockout_third_place, double_elim, ko_plate, qualifying_main; `failing: []`, "forfeit not allowed in phase pre") are owed to **CD-T13 (W2b)**, and `ko_plate|boardgame|blitz|F1` (3 checks, `STAGE_COMPLETED_SEEDING_FAILED`) is owed to **FX-G14 (W4)**. Unexpected red 1: `page_playoff_only|generic|*|M1`, a HARNESS defect (`m1-walkover.ts:110-113` puts the decider check on M1, and on a page playoff no decider is ever posted: false premise 50). It also costs 9 L3 regressions against W1d (L1 0/231, L2 0/517, L3 9/937), and is routed to the controller. Unexpected red 2: SC-O2 `swiss_playoff|generic|score|R4`, CI only; it hit SW-H1 (P6, W3) and works locally, which is the reason flip, not a regression (classified below the per-screen verdicts). Five new scenarios, 136/136 works locally. Evidence: `truth-runs/w2a-final/`, plans.lock +84. Task 17: full smoke **1195/0** on a fresh label server (`bracketFinishSuite` 17 checks; 4 prod-build mutants each killed by its own flow). Local e2e, whole files: parallel 235/235, serial journey-pro 14/14, `mobile.spec.ts` on 7 projects with 0 unexpected (the only skip is the by-design LCP test). Status-set sweep 5/5. Stryker probe group locally: EXIT 0, 98 killed, 30 survived, 74.81%. 21 screens × 3 widths cropped; the crops stay in the gitignored SDD scratch dir (owner ruling 2026-10-09: no committed evidence images), and the per-screen PASS/FAIL verdicts are below as text, with the **owner verdict pending**. PR **#931**. e2e **37923877314** (pr=931, ref main): 10 of 11 jobs green; walkthrough 2/3 is red on the widest-status pin (false premise 57, routed). PR CI **37923861041** (`7569ed0fc`) had 5 red jobs (gates, R27, engine coverage, both smoke DB jobs), now fixed on the branch: the generated-backlog section (`402fa5186`); R27 (body line); controller ruling **D-M1**, under which a held fixture arms the stream's automatic stop and its public link reads Replay (`d5fbfd56a`, V432 amended to stamp `finished_at`); `check-vitest-collection` lists the new public-site suite (`861675549`); `stryker-cuts` takes makePeriodModule's bound from the instrumenter, not a typed 938 (`6d95c5e8a`); core-2 is re-measured from CI job 113798142175 (`806ac17eb`, timeout 93→126). Smoke DB+Redis and usecases [i-z] are green on PR CI 37929197201 (`20b9dce09`). sports-other-1 (362→429 mutants) is re-measured from job 113809766965 of dispatch 37927448469 (timeout 205→213), and modules-7 from single-leg run 37937855917 (593 s against its 10-minute floor, after a cancel at 617 s in 37923872826 at an unchanged count; timeout 10→15). The walkthrough widest-status case follows the measured widest es status (ruling D-R2, `0cf29946a`; e2e 37946956371 green on `refs/pull/931/head`). Routed: the per-PR matrix sample's L3 red is the M1 harness defect's 9 regressions (false premise 50). Mutation dispatches **37923872826** (group=all, `7569ed0fc`) and **37927448469**: post-merge follow-up, survivors routed after merge (owner ruling 2026-10-09: not a merge gate). **Owed to W2b:** CD-T13 ×5, the D-G2/D-G3 characterisations. **Owed to W4:** FX-G14. W2a false premises 48–58. Backlog: W1d baseline `47f210e` (77 reds = SC-O1 65 + SC-O2 12; 54 audit ids). |
| W3 | Swiss | design 2026-10-31 (`2026-10-31-format-matrix-w3-swiss-design.md`), rulings 250–255; plans written |
| W4 | Knockout family | not started |
| W5 | Round-robin family | not started |
| W6 | Double elimination | not started |
| W7 | Americano, mexicano, ladder | not started |
| W8 | Scorer sheets (lane) | not started |
| W9 | Operational [O] (lane) | not started |
| W10 | Sweep lane: ST-G22 youth-name privacy FIRST, #878 browser Sentry, shadow invariants, #858 #853 #843 | not started |

## W1a session status

**2026-09-28 — final review fix batch, live re-run** (`seazn-local-env` label
`fm-w1a-fix`: fresh Postgres at v419, `db:apply` + `sync:sports` (11 sports,
31 system variants), standalone prod server (build newer than every
`apps/web` and engine source file) with `AUTH_DEV_LINKS=1`, no `REDIS_URL`,
PostHog and Sentry keys blanked in the launching env, no non-loopback TCP
from the server PID; `show data_directory` equal to
`BENCH_EXPECTED_DATA_DIR`; the LISTEN PID equal to `server.pid`).

- **Committed evidence (supersedes `fm-w1a-a2`):** `truth-runs/w1a-slice/results.json`
  is run `fm-w1a-fix-b` at harness `e96a51ff1` (a clean tree: `harnessCommit`
  now says `-dirty` otherwise), schema v2. v2 cases carry `notes`, and the file
  carries the catalogue `grid` MATRIX.md renders from, so the render no longer
  reads the live catalogue. `committed-matrix.test.ts` now also checks that each
  case's state is `decideState` of its own checks, that the 24 caseIds are
  distinct, that the commit is clean and that no raw string is secret-shaped.
  Seven data mutants of the evidence are each red.
- **Smoke** `fm-w1a-fix-smoke`: `league|generic|score|LIFECYCLE` → ✅, 13
  checks, 194 items.
- **Slice** `fm-w1a-fix-a` / `fm-w1a-fix-b`:
  `{"cases":24,"counts":{"works":24},"differ":[]}`. The two runs agree check by
  check, notes included. Vacuous: none. Error reds: none.
- **The batch's new checks, live, in all 24 cases:**
  - `life-built-as-posted` (I-2): pass, 20–23 items.
  - `life-results-as-posted` (I-1): pass, 7–28 items.
  - `life-fold-parity`: pass, 6–28 items.
  - `r4-cascade-consistent` now includes `skipped_finalized`. It passed in all
    six R4 cases.
- **Notes (m-5) seen live:** only the stage status after start (`active` in
  all 24) and the config-lock answers (`409 FORMAT_LOCKED` / `200`). There was
  no SEQ_CONFLICT retry, no foreign event and no loop cap.
- **Canaries** (each EXIT=0, red on its own check only, every failing evidence
  line canary-marked):
  - `canary M1: red on m1-walkover-recorded, as designed`
  - `canary R4: red on r4-cascade-consistent, as designed`
  - `canary F1: red on f1-round-size, as designed`
- **Findings:** none. The live re-run found no product red.

**2026-09-28 — Task 11, the first live truth run** (`seazn-local-env` label
`fm-w1a`: fresh Postgres, `db:apply` + `sync:sports` (11 sports, 31 system
variants), standalone prod server with `AUTH_DEV_LINKS=1`, no `REDIS_URL`,
PostHog and Sentry keys blanked; `show data_directory` equal to
`BENCH_EXPECTED_DATA_DIR`).

- **Committed evidence (then; superseded by `fm-w1a-fix-b` above):**
  `truth-runs/w1a-slice/results.json` was run `fm-w1a-a2` at harness
  `f013af525`; `MATRIX.md` is its render, and
  `tools/matrix/__tests__/committed-matrix.test.ts` keeps the two equal (R10).
- **Smoke** `fm-w1a-smoke` (harness `22ac77387`): `league|generic|score|LIFECYCLE`
  → ✅, 11 applied checks, 143 items.
- **Baseline slice** `fm-w1a-a` / `fm-w1a-b` (harness `22ac77387`):
  `{"cases":24,"counts":{"works":23,"red":1},"notRun":0,"vacuous":[],"differ":[]}`,
  and the two runs agree check by check.
  - ❌ `league|generic|score|R4` — `I3-table-points-equal-declared: checked 0
    items (vacuous, R25)`, evidence `skipped 8 entrant(s) with undeclared or
    changed results`. **Harness defect, fixed in `f013af525`** with its unit
    tests. Generic folds `core.abandon` to `{"kind":"no_result"}` (badminton
    folds it to null), so the expunge cascade leaves the withdrawn entrant's
    fixtures abandoned with an outcome. I3 keyed "struck" on a null outcome and
    skipped every entrant. The product's table was right: the other seven at P6,
    the withdrawn entrant at P0 and 0 points.
- **Final slice** `fm-w1a-a2` / `fm-w1a-b2` (harness `f013af525`):
  `{"cases":24,"counts":{"works":24},"notRun":0,"vacuous":[],"differ":[]}`,
  and the two runs agree check by check. No error reds.
- **Canaries** (harness `f013af525`, each EXIT=0 and red on its own check only):
  - `canary M1: red on m1-walkover-recorded, as designed`
  - `canary R4: red on r4-cascade-consistent, as designed`
  - `canary F1: red on f1-round-size, as designed` (3 seated, expected 4)

  At `22ac77387` the R4 canary was also red on I3, the same vacuity as its
  twin. None of the non-canary twins fails its canary's check.
- **Live-only checks** (what the product did):
  - Builder variant order (plan open question 3), read from the DB: generic
    `score,win_loss`, badminton `bwf,short`. The slice variants are `score` and
    `bwf`, as the plan read.
  - The fixture `outcome` on the fixtures list arrives as an object.
    `life-draw-path-exercised` counts `kind:"draw"` rows off that list.
  - The config lock, in all six LIFECYCLE cases: a format edit gets
    `409 FORMAT_LOCKED`, and the entrants-only save gets `200`.
  - Knockout standings are NOT `[]`. The product returns all 8 rows, and the
    public table equals the org one (`life-public-standings-match` 8 items).
  - No stage is left with an open or one-sided scheduled fixture (Task 5 M-5).
    `life-loop-bounded` passes in all 24 cases.
  - None of these occurred: `VisibilityDegraded` (one org per case), "owner has
    no users row", or a parity row the harness could not judge (no foreign
    events on any fixture).
  - A35 / `realDeps`: the runner exits 124 ms after `finishedAt`, although its
    clients are `max: 1` with no idle timeout. After the runs, the only open DB
    sessions belong to the server's PID.
  - The org-switch proof is the `seazn_org` cookie. It held for all 104 case
    orgs. `GET /api/orgs` is no longer read at all.
- **Findings:**
  - **F-TRIPLE (CONFIRMED, W5).** The builder's `triple_rr` builds a
    one-meeting league. The legs picker is hidden
    (`division-builder.tsx:816-819`), `buildTemplateStages` overwrites `legs`
    with the knob, and the division reads back "league". Reported by the W1a
    controller as owner-verified by driving the product, 2026-09-28. The slice
    does not cover it.
  - The live slice found no product red.

## W1b counts (design §6.2)

Every value is quoted from `scripts/matrix/catalogue/counts.json` (schema v1)
as committed at `7c42d0ec2`, and each formula is that file's own text,
verbatim. The drop split is quoted from `drop-list.json` and the floors from
`floors.json`, beside it. `gen-catalogue.ts --check` keeps all five generated
files equal to the code (`committed-catalogue.test.ts`).

- **Grid:** 21 rows × 11 sports = 231 cells.
- **Scenario catalogue:** 70 design parents → 94 atomic cases; 87 of them run
  in L3 and 93 in L2.

| Layer | Formula (verbatim from `counts.json`) | Value |
| --- | --- | --- |
| L1 | cells × 1 width (1280; ruling 39) | **231** (462 at `7c42d0ec2`, before ruling 64 corrected the formula; `counts.json` now says 231) |
| L2 | runs in l2-pairs.json; pairTargets = owed (row, scenario) + (sport, scenario) pairs (the scenario applies there, or its only drop is the L3 harness gap — that run is marked l3Gap), each covered by one run, so runs ≥ owed (row, scenario) pairs | **1,732** runs; 2,594 pair targets; 1 run marked `l3Gap` |
| L3 | Σ cells (1 LIFECYCLE + applicable L3 atomic, variant-bound included) + scorable variant cases (Q-B: LIFECYCLE each; unscorable ones are listed under variants, not run) + denied cases (one per gated row, generic) + regression cases | lifecycle 231 + applicable atomic 15,240 (of which 118 variant-bound) + scorable variant cases 1,001 + denied 7 + regressions 5 = **16,484** |

- **L3 grows by 1 for each committed regression case**, so these numbers are a
  snapshot at `7c42d0ec2`. L3 was 16,479 at `39134e112` (no regressions).
  Three commits took it to 16,484: `90d2ef8c8` +1 (MB-001), `299df5b32` +2
  (MB-002/003) and `d860d74f2` +2 (MB-004/005). Every later MB-NNN adds one
  more.
- **Against design §6.2's estimates**
  (`../2026-09-27-format-matrix-design.md:270-271`: L2 "up to 21 × 70 =
  1,470", L3 "≤ 231 × 70 = 16,170 before drops, plus the variant set"). Both
  counted the 70 parent scenarios. Atomisation replaced them with 93 L2 atoms
  and 87 L3 atoms, plus LIFECYCLE. So L3 before drops is 231 × 88 = 20,328, of
  which 4,857 drop, leaving 15,471 (231 lifecycle + 15,240 atomic). The L2
  estimate counted only (format, scenario) pairs. The committed L2 covers 2,594
  owed pair targets, (row, scenario) and (sport, scenario) alike, with 1,732
  runs.

- **Drops:** 4,857 (cell, scenario) pairs = 4,840 inapplicable + 14 harness
  gap + 3 unscorable-only (`drop-list.json` `total`, `inapplicable`,
  `harnessGap`, `unscorableOnly`). Each drop group carries its reason.
- **Floors:** planned L3 cases per row (LIFECYCLE + atomic), from 640
  (`stepladder_only`) to 838 (`groups_ko`, `swiss_knockout`,
  `group_group_ko`); the 21 rows sum to 15,471 = 231 + 15,240.
  `gen-catalogue.ts --write` refuses to lower a floor without
  `--accept-lower-floors`, and refuses a zero floor always.
- **Variants:** 1,065 cases = 1,001 scorable + 64 unscorable. The 64 are not
  run and are not in the L3 total:
  - 40 engine-unscorable (volleyball and table tennis sets to 1 point at
    win-by-2; the engine refuses the cfg or its stream) → W2 (ruling 31);
  - 24 generator-unsupported (cricket's two-innings `test` preset) →
    W1-driving.

  38 factor-level pairs have no valid case (`uncoverablePairs`, proven by brute
  force in Task 5), and 35 cases are no-ops at their sport's builder-default
  preset (listed, not removed). Cases per sport:

| football | cricket | boardgame | carrom | generic | volleyball | badminton | tabletennis | tennis | icehockey | hockey |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 92 | 107 | 90 | 95 | 64 | 127 | 97 | 109 | 108 | 90 | 86 |

## W1b session status

**2026-09-29 — Task 15, the live walkthrough, and its three fix rounds.** Run
ids ending `0928` keep the names the plan gave them; every run happened on
2026-09-29. Each environment was a fresh `seazn-local-env` stand-up (labels
`w1bt15`, `w1bt15b`, `w1bt15c`, `w1bt15d`): fresh Postgres at v420,
`db:apply` + `sync:sports`, a standalone prod server built at `d8186ae24` (for
every later run `git diff d8186ae24 HEAD -- apps packages` was empty),
`AUTH_DEV_LINKS=1`, no `REDIS_URL`, PostHog and Sentry keys blanked, and
`show data_directory` equal to `BENCH_EXPECTED_DATA_DIR`. Redis's absence was
witnessed by the three commands under "Found during W1b planning and
execution", not by `ps`. The SDD ledger and task reports are gitignored, so
this section, "W1b counts" above, the W1b false premises and "Findings routed
(W1b)" are the lasting record. Rulings applied in W1b: 24, 26–30, 31 (its
cricket half; the points floor is W2's) and 32. Ruling 33 is recorded and
routed to W2, not applied. Rulings 34–36 were made during W1b.

| Run | What it drove | Verdict | Evidence (`truth-runs/`) |
| --- | --- | --- | --- |
| `w1b-slice-0928a` | the 24 W1a slice cases, harness `d8186ae24` | 24/24 ✅. Every W1a check keeps its verdict; W1b adds I8 (pass ×24) and I7 (pass ×8 league cases, abstain ×16 knockout and swiss) | `w1b-slice/` |
| `w1b-probe-0928a` | `--set w1b-probe`: 4 API-only LIFECYCLE rows, 7 DENIED rows, 2 variant cases | 5 ✅, 8 ❌: 7 DENIED red on `denied-put-keeps-stages` (product → W9), `page_playoff_only` LIFECYCLE red on the harness's fixed 8 entrants (→ W1-driving). `knockout_third_place` ✅: its third-place fixture is judged inside `life-built-as-posted`, which passed | `w1b-probe/` |
| `w1b-abandon-0928a` | ST-G1, four legs | CONFIRMED, judged 4/4, control `void-correct` | `w1b-abandon/abandon-probe.json` |
| `w1b-tie-ko-0928b` | CD-T6, a tied t20 knockout semi (ruling 32) | CONFIRMED, control seated. `0928a` was a probe bug (it read the wrong seat keys; its evidence is not committed), re-run under a new id | `w1b-tie-ko/tie-ko-probe.json` |
| `w1b-withdraw-0928a`, `w1b-withdraw-0928b` | CD-T13, a boardgame withdraw after Start | CONFIRMED on the walkover shape (the briefed shape reaches only expunge: REFUTED), and half-applied when one fixture had started | `w1b-withdraw-boardgame/` |
| `w1b-cricket001-0929a` | the Task 8 carry: cricket#001 at run time | config accepted as posted; M4b voided (as ST-G1); M6 stays `in_play` (super over on, consistent with the engine); ball-by-ball refused without rosters | `w1b-cricket-001/cricket-001-probe.json` |

**The model, final run at HEAD** (harness `e9cda4a38`, clean tree; 30 commands
per run, fences on; `truth-runs/w1b-model-final/`, whose `README.md` records
why swiss\|badminton runs at 40). Every cell: 0 unexpected refusals, `masked`
and `maskedNew` empty, no vacuity, no timeout. The two knockout rows are the
final batch's re-run (F-1), run `w1b-model-final-ko` at harness `15d434d35`
with the knockout fences on (`model-report-knockout.json`): the first final
run's knockout\|badminton stopped at its known MB-005 after 2 of 20 runs with
Rebuild never run, a vacuous cell the model did not then judge.

| Cell | Variant | Seed | Runs | Verdict | Step-check items | CD-T13b |
| --- | --- | --- | --- | --- | --- | --- |
| league\|generic | score | -396057224 | 20 | ok | I7 1,236 · I8 165 | 8 |
| league\|badminton | bwf | -1248422361 | 20 | ok (fence `late-entry-then-generate` blocked a command 2×) | I7 1,296 · I8 191 | 11 |
| knockout\|generic | score | -1424798710 | 20/20 | ok; fences `ko-generate-after-roster-change` 15×, `ko-withdraw-waiting-on-tbd` 1× | I8 136 | 23 |
| knockout\|badminton | bwf | -1451311303 | 20/20 | ok, every command kind ran; fence `ko-generate-after-roster-change` 8× | I8 68 | 16 |
| swiss\|generic | score | 1377112074 | 20 | ok | I6 175 · I8 232 | 19 |
| swiss\|badminton | bwf | -2002771143 | 40 | ok, every command kind ran | I6 288 · I8 371 | 26 |

- **Why swiss\|badminton runs at 40.** At the default 20 runs, fix round 1's
  seed for this cell never drew a Correct, so the cell was vacuous on coverage
  and exited 1 (`w1b-model-fr1/model-report-0929b.json`). That verdict was
  correct. The same seed at 40 runs was ok
  (`model-report-0929g-swiss-badminton-40.json`). A Swiss
  result needs Start, then a pairing Generate, then a Score, so a Correct comes
  late. The final run pins the seed `w1b-model-final` derives for the cell, so
  only the run count differs.
- **`--regressions`** (run `w1b-model-final-regressions`): 5 known, 0 NEW,
  0 not reproduced; every case replays its committed path, `replayPath` and
  command list. Re-run after the final batch (run
  `w1b-model-final-ko-regressions`, harness `15d434d35`,
  `model-report-regressions-ko.json`): the same 5 known, each failure's check,
  case, seed, path, `replayPath` and command list identical.
- **Earlier model runs, superseded** (kept as evidence):
  - `w1b-model/` — Step 4 (`w1b-model-0928a`, pre-fix): 2 ok and 4 NEW. The
    knockout pair was a product finding (MB-002/003). The swiss pair was a
    MODEL bug: step-level R25 failed I6 on Start's unpaired shells (fixed
    `15b811792`). Shrinks were also cut short by the case org's plan cap of
    20 divisions per competition (fixed `125573b93`). Step 5 (`w1b-model-0928b`, fences off) reproduced #879
    before Start.
  - `w1b-model-fr1/` — fix round 1 (`0929b`–`0929g`, plus two hand-driven
    knockout probes): the knockout Generate 500 found by two routes.
  - `w1b-model-fr2/` — fix round 2: `0929h` replays 5 known, each exactly;
    `0929i` finds only known failures on both knockout cells.

**Regressions committed** (`tools/matrix/catalogue/regressions.json`, all
`open`, found 2026-09-29). A replay is known only when the cell, the check and
`match` (tested against the product's own answer) all agree.

| Id | Cell | Check | `match` | Seed · path | Found by | Finding → owner |
| --- | --- | --- | --- | --- | --- | --- |
| MB-001 | league\|generic (score) | `I7-rr-no-pair-over-legs` | `null` (I7 owes no match); fence `late-entry-then-generate` | 752674687 · `1:2:3:3:3:3:3:3` | `w1b-model-0929f` | #879: Generate → AddEntrant → Generate before Start duplicates round-robin pairs → **W5** (`W5-round-robin.md`, #879 all parts; part 3's wipe is W3's #840) |
| MB-002 | knockout\|generic (score) | `model-unexpected-refusal` | "fixture has an unassigned entrant" | -1372716623 · `8:4:3:3` | `w1b-model-0929b` | withdrawing a knockout entrant who waits for a TBD opponent → 422 WRONG_PHASE → **W9 + W4** |
| MB-003 | knockout\|badminton (bwf) | `model-unexpected-refusal` | "fixture has an unassigned entrant" | -355591138 · `14:6:10:8:11:9:9:9:4:10` | `w1b-model-0929c` | as MB-002 → **W9 + W4** |
| MB-004 | knockout\|generic (score) | `model-refusal-named` | "would strand home_slot_label" | 63878783 · `3:2:3:3:3:5:6:6` | `w1b-model-0929d` | knockout Generate after the roster changes → 500 "bye-award bulk UPDATE would strand home_slot_label" → **W4 + W9** |
| MB-005 | knockout\|badminton (bwf) | `model-refusal-named` | "would strand home_slot_label" | 180087602 · `0:3:3:3:3:3:3` | `w1b-model-0929b` | as MB-004 → **W4 + W9** |

MB-001 was re-pointed from `w1b-model-0928b`'s path `1:2:3:3:3` to its full
shrink (`3d20959f8`): the Step 5 shrink was cut short by the division cap.
`stages.ts:2672` holds a twin assertion for `away_slot_label`. No run has hit
it yet, and a run that does will read NEW against MB-004/005's `match` — a
correct over-report; the W4 fix should cover both.

## W1c session status

**2026-09-30: Task 14, the live evidence.** Every run below happened on 2026-09-30 in one environment, a fresh
`seazn-local-env` stand-up (label `w1c-t14`):

- Postgres was fresh at v423, with `db:apply` and `sync:sports`. `show data_directory` equalled
  `BENCH_EXPECTED_DATA_DIR`.
- The server was the standalone production build of 2026-09-30 01:15 (Task 7's), with
  `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000`. It was reused because nothing under `apps`, `packages` or `services` changed
  after it: the newest such commit is `060ce7fc0`, 2026-09-29 17:46. Every browser run's preflight re-proves that
  the served hold equals the shell's.
- There was no `REDIS_URL`, and the PostHog and Sentry keys were blanked.
- Every run is at harness `b7668c0ff`, on a clean tracked tree.

The SDD ledger and task reports are gitignored. This section, "Findings routed (W1c)", the W1c false premises and
the per-adapter table below are the lasting record.

| Run | What it drove | Verdict | Evidence (`truth-runs/`) |
| --- | --- | --- | --- |
| `w1c-http-slice` | L3 · http · plan `slice`: the 24 slice cases (6 cells × LIFECYCLE, M1, R4, F1) | 24/24 ✅, 378 checks. Drift against the committed `w1b-slice`: none (same 24 ids, same states) | `w1c-http-slice/` |
| `w1c-l1-r1`, `-r2`, `-r3` | L1 · browser · 1280 · plan `--layer L1`: the 6 slice cells × LIFECYCLE | 6/6 ✅ in each run | `w1c-l1/` |
| `w1c-l2` | L2 · browser · plan `--layer L2`: the committed `l2-pairs.json` filtered to the slice cells | 68 cases: 3 ✅ (swiss\|badminton R4a@375, M1@390, F1@375), 7 🚫, 58 ░ | `w1c-l2/` |
| `w1c-api-only` | `--set api-only-browser` at 1280 | 5 🚫, each naming its wave (W4 ×3, W5 ×2); no browser launched | `w1c-api-only/` |
| `w1c-sweep-ko-320` … `-834` (7 runs) | knockout\|badminton LIFECYCLE at each L2 width, 320 / 360 / 375 / 390 / 430 / 768 / 834 | 1/1 ✅ at every width; no-horizontal-scroll pass 26 at each | `w1c-sweep-ko/` |
| `w1c-pp-1280-r1..r4`, `w1c-pp-320-r1..r3` | `--set pad-proof`: 11 sports, 3-entrant league at the builder default, 3 fixtures scored on the pad and finalized | 11/11 ✅ in six of the seven runs. In 1280 r3, 10 ✅ and cricket ❌: flake finding F-PP-1, one tap-wait timeout, cause unexplained (see below). r4 is a fresh-id run: 11/11 ✅ | `w1c-padproof/` |

**Parity** (`pnpm matrix:parity`, the HTTP slice against each browser run):

- L1 r1: `compared 6 cases, 102 common checks, 0 differences; 18 HTTP cases outside the browser plan; 0 planned without a harness script (🚫/░)`
- L1 r2: `compared 6 cases, 102 common checks, 0 differences; 18 HTTP cases outside the browser plan; 0 planned without a harness script (🚫/░)`
- L1 r3: `compared 6 cases, 102 common checks, 0 differences; 18 HTTP cases outside the browser plan; 0 planned without a harness script (🚫/░)`
- L2: `compared 3 cases, 46 common checks, 0 differences; 21 HTTP cases outside the browser plan; 65 planned without a harness script (🚫/░)`
- API-only: not run, by ruling. Its 🚫 cases are recorded under LIFECYCLE, so parity would exit 1 there by construction (`layers.ts:218-229`). That is routed to the final review.

**Flake reruns (class 8): Step 2 and Step 4, three runs each. At 1280, Step 4 also got a fourth, fresh-id run, after r3's red.**

| L1 case (1280) | r1 | r2 | r3 | checks recorded r1 / r2 / r3 | pad ledger r1 / r2 / r3 |
|---|---|---|---|---|---|
| `league\|generic\|score\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 2 / pass 2 / pass 2 |
| `league\|badminton\|bwf\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 3 / pass 3 / pass 3 |
| `knockout\|generic\|score\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 2 / pass 2 / pass 2 |
| `knockout\|badminton\|bwf\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 3 / pass 3 / pass 3 |
| `swiss\|generic\|score\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 2 / pass 2 / pass 2 |
| `swiss\|badminton\|bwf\|LIFECYCLE@1280` | ✅ works | ✅ works | ✅ works | 26 / 26 / 26 | pass 3 / pass 3 / pass 3 |

| pad proof sport | 1280 r1 | 1280 r2 | 1280 r3 | 1280 r4 (rerun) | 320 r1 | 320 r2 | 320 r3 |
|---|---|---|---|---|---|---|---|
| football | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| cricket | ✅ works | ✅ works | ❌ red | ✅ works | ✅ works | ✅ works | ✅ works |
| boardgame | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| carrom | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| generic | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| volleyball | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| badminton | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| tabletennis | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| tennis | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| icehockey | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |
| hockey | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works | ✅ works |

**The one red: 1280 r3, cricket. Flake finding F-PP-1, UNEXPLAINED → W1d.** The cause is not established.

- **The check that failed.** `pad-ledger-as-generated`, on fixture `dabf515d-99da-4a03-8e52-c3e052c611e3` (fixture 1 of
  the case), at event 3 of 3 (its second `cricket.innings.summary`). Tap 15 of 141, a tile, threw
  `TimeoutError: locator.waitFor: Timeout 15000ms exceeded`. 15 s is the harness's derived floor, `FLOOR_MS`
  (`lib/browser/budget.ts:16`). Quoted from the committed `w1c-pp-1280-r3/results.json`.
- **What followed.** The ledger check read 3 equal / 0 tolerated / 5 fallback / 1 missing rows, plus one "stopped
  after event 3 of 3" finding: 10 evidence items, not 10 rows. The fixture stayed in play, so it also fails the
  finalize, outcome, fold and I4 checks. Fixtures 2 and 3 of the same case scored cleanly.
- **Timings seen** (results.json `durationMs`; shot file times). The case took 405 s, against 288 s (r1) and
  295 s (r2). Fixture 1 took 187 s to the post-timeout shot, against 106 s for the whole fixture in r1; fixtures 2
  and 3 took 86 s and 94 s, against 80 s each.
- **What the screen shows.** The shot taken after the timeout shows the "End of over 3" tile present and enabled.
  It was present by the time of that shot; when it arrived was not measured.
- **Unknown.** Whether the awaited locator was ever attached, whether the pad's sync or poll stalled, and what the
  machine was doing at the failing tap.
- **Hypothesis (not established): machine load.** The one `uptime` sample (232 / 199 / 114) was taken at 13:52Z.
  The failing tap's wait began about 13:50:34Z: 15 s before `08-pad-scored`, taken right after the timeout, whose
  file time is 13:50:49Z. So the sample came about 1.5 minutes after the tap. Fixture 2 ran at near-normal pace
  across that sample, which weakens the hypothesis.
- **Recurrence: not measured — no single-sport scope.** `--set pad-proof` refuses `--only` (`run.ts:468-469`,
  `lib/pad-proof-set.ts:16`), so cricket cannot run alone without a code change. The fresh-id run
  `w1c-pp-1280-r4` passed all 11 sports: one more pass, not an explanation.
- **→ W1d:** capture tap timestamps or a trace on a tap-wait timeout before judging; give pad proof a single-sport
  scope so recurrence can be measured. No harness change was made in W1c. Full record: `w1c-padproof/README.md`.

**Per-screen verdicts (class 11).** Each verdict was read from contact sheets of every distinct screen.

- `w1c-l1/README.md`: L1 run 1, 160 shots, 132 distinct.
- `w1c-l2/README.md`: 61 shots, 52 distinct.
- `w1c-sweep-ko/README.md`: 16 screens × 7 widths, plus the stage-rail fold at every width.
- `w1c-padproof/README.md`: 11 sports × 3 screens × {1280, 320} = 66, plus 1280 r3's red cricket screen.
- `w1c-walkthrough-a/README.md`: Task 8's walkthrough, already committed.

Across all of them, every after-shot differs from its before-shot, except the named first-visit baselines.

**The Task 14 carries, answered:**

1. **Knockout and swiss score their first fixture on the pad.** Pad policy `first` passed `pad-ledger-as-generated`
   on all four knockout/swiss L1 cells in every run, with every row equal (`w1c-l1/README.md`).
2. **Run-sheet shot after the filter widens.** `ea148cca0` (`showAllFixtures`). The filter read "All" at every
   width in every run, so the shot is a single named baseline. **The press branch never ran live:** 0
   `run-sheet-all-before` shots across all 91 live cases. The product defaults to "Today" only on a match day
   (`stages-panel.tsx:555`), and no matrix run reaches one (false premise, "Found during W1c", Task 14). The
   match-day default is never driven → **W1d**.
3. **Committed-matrix `decideState` consistency.** First version `342d49cfc`: it skipped a planned 🚫/░ case by
   state alone, under `skipped >= 70` and `checked >= 177` floors, so a DRIVEN case stored as planned with its checks
   lost passed (review I-1). Fix round 1 (`62d91dd48`): each committed results.json is judged against the plan named
   by its recorded `plan`, rebuilt by the runner's own planners. A planned row must be exactly the plan's; a driven
   case must never be stored as planned; no case may be missing, stray or repeated. Exact over the committed tree:
   33 files, 200 driven, 70 planned. RED first on a probe flipping w1c-l2's driven R4a@375 to not_run; 9 of 9
   mutants killed. Final review I-1 and I-2 (`0532d0cb6`): each run is judged against its plan FROZEN in
   `truth-runs/plans.lock.json`, never against today's planners. On a driven case, ⏳/🚫 reds only in
   recordPlanned's shape (0 ms, zero counts), and not_run always reds. 7 of 7 mutants killed. Re-review I-2
   (`f33c1b312`): a driven ⏳/🚫 that counts fixtures or events also reds, because the runner cannot write that shape
   (`run.ts` runCase sets both only after the scenario returns; its catch updates calls alone).
4. **`l3Gap` is never recorded.** The only run the catalogue marks is run 514, `groups_ko|cricket|t20|M5@375`. That
   run is outside the slice, and M5 is unscripted. The type is kept. The final review routes it to W1d, to be
   recorded, not dropped (m-7; `w1c-l1/README.md`).
5. **MATRIX.md names its layer, driver and plan.** Commit `b7668c0ff`.
6. **`results.json` records its plan.** Commit `3c36ea1b3`.
7. **Walkthrough-a's 320 results read `L1`.** They predate `layerOfWidth`. They are history and are not rewritten
   (note in `w1c-l1/README.md`).
8. **Forfeit and withdraw.**
   - Over HTTP: M1 and R4 on all six cells.
   - In the browser: swiss\|badminton only, R4a@375 and M1@390 (`w1c-l2/README.md`).
   - Neither runs at 1280, and neither runs in the browser on a league or knockout cell. That coverage goes to W1d.
9. **Flake reruns.** See the table above.

**Harness fixes in Task 14.** Each was made test-first in its own commit, and the affected run was repeated:

- `ea148cca0`: carry 2.
- `3c36ea1b3`: carry 6.
- `64e0d1619`: the committed-matrix sweep reads `git ls-files`, and every committed PNG must be cited by a README in
  its run directory.
- `b7668c0ff`: carry 5.
- `342d49cfc`: carry 3.
- `62d91dd48` (fix round 1): carry 3 judged per run against its own plan (review I-1, m-2 to m-6).
- Final review: `0532d0cb6` (frozen plans, I-1/I-2), `e431cbbce` (`--set width-sweep` → knockout, m-1),
  `80f370e9f` (test minors), `d5ce3e871` (shots/ ignored, m-13), `6e857491d` (comments, m-5/m-10).
- Final re-review: `f33c1b312` (a driven ⏳/🚫 that counts fixtures or events reds, I-2).

**Owner ruling 43 (2026-09-30) settles both questions this task raised.**

- **The sweep cell.** The width sweep on `knockout|badminton` stands, in place of ruling 39's `league|badminton`.
  Knockout was otherwise never driven below 1280: the L2 rotation drew only swiss\|badminton.
- **D7 as executed.** The API-only set runs as planned 🚫 `no_path` `{wave, reason}` with no browser, not as ❌
  `organiser-ui-path` from Generate onward.

**Status.** Task 14+15 review: Needs fixes (2026-09-30), fix round 1, re-review 1 Approved. Task 14 Step 11, the
final whole-branch review: Needs fixes, final fix landed (see "W1d first tasks"); its re-review's I-2 is fixed in
`f33c1b312`. PR and merge: pending, the owner's decision.

### Per-adapter status for W1d

Pad proof across seven runs (1280 × 4, the fourth being a fresh-id rerun; 320 × 3). A route is one of:

- **one-for-one**: the pad writes the generated event.
- **tolerated \<keys\>**: the pad writes the event plus the named keys.
- **fallback \<why\>**: the pad's own route to the same result, judged by `Fallback.judge`.

The ledger column reads rows = equal / tolerated / fallback. It is identical in every clean run. Mismatch and missing were 0 in every
run except 1280 r3's cricket, which is named in its row.

| sport | builder default | route per emitted event type | rosters | pad proof 1280 r1–r4 | pad proof 320 r1–r3 | ledger rows (equal / tolerated / fallback) | what W1d may assume |
|---|---|---|---|---|---|---|---|
| football | 11-a-side | `core.start` one-for-one; `football.period` one-for-one (period tile → HT / FT choice); `football.goal` **fallback** — the goal tile writes `{by}` only, and the generated `minute` has no tap (`football.tsx:769`); judged on `by` | none — team entrants with 0 members (PADPROOF only) | ✅ ✅ ✅ ✅ | ✅ ✅ ✅ | 11 = 9/0/2 in all 7 clean runs | pad proven; L1/L2 cells ⏳ W1-driving (team rosters) until rosters are seeded |
| cricket | t20 | `core.start` one-for-one; `cricket.innings.summary` **fallback** — the pad authors an innings only as cumulative per-over summaries (`partial: true`, one row per over, `cricket.tsx:2585`), and the innings closes itself; rows = ⌈legalBalls / 6⌉; judged on the last cumulative row | none — team entrants with 0 members (PADPROOF only); T11-O1: the rosterless pad shows "No bowler is eligible…" while scoring works | ✅ ✅ ❌ ✅ | ✅ ✅ ✅ | 9 = 3/0/6 in all 6 clean runs. 1280 r3 ❌: flake finding F-PP-1, one tap-wait timeout, cause unexplained; 10 evidence items = 3/0/5 + 1 missing + 1 stop finding (→ W1d; `w1c-padproof/README.md`) | pad proven on single-innings variants whose innings end themselves; an innings that would need an explicit close is refused by name; L1/L2 ⏳ W1-driving (team rosters) |
| boardgame | blitz | `core.start` one-for-one; `boardgame.result` one-for-one (half + `method:checkmate` chip; draw tile + `method:agreement` chip, the chip being required) | none (individual) | ✅ ✅ ✅ ✅ | ✅ ✅ ✅ | 6 = 6/0/0 in all 7 clean runs | pad proven; the L1 cell can run at the builder default |
| carrom | club-29 | `core.start` one-for-one; `carrom.board.summary` one-for-one (board tile → winner → coins left); `queenTo: null` is read as absent | none (individual) | ✅ ✅ ✅ ✅ | ✅ ✅ ✅ | 27 = 27/0/0 in all 7 clean runs | pad proven; the L1 cell can run at the builder default |
| generic | score | `core.start` one-for-one; `generic.result` one-for-one (bench `genericAdapter` score sheet; draw tile) | none (individual) | ✅ ✅ ✅ ✅ | ✅ ✅ ✅ | 6 = 6/0/0 in all 7 clean runs | pad proven; L1 cells run today (slice) |
| volleyball | beach | `core.start` one-for-one; `volleyball.set.summary` one-for-one (setScore sheet, home first) | none — beach is team-kind; team entrants with 0 members (PADPROOF only) | ✅ ✅ ✅ ✅ | ✅ ✅ ✅ | 9 = 9/0/0 in all 7 clean runs | pad proven; L1/L2 cells ⏳ W1-driving (team rosters) |
| badminton | bwf | `core.start` one-for-one; `badminton.game.summary` one-for-one (setScore sheet) | none (individual) | ✅ ✅ ✅ ✅ | ✅ ✅ ✅ | 9 = 9/0/0 in all 7 clean runs | pad proven; L1 cells run today (slice) |
| tabletennis | bo5 | `core.start` one-for-one; `tabletennis.game.summary` one-for-one (setScore sheet; no serve-anchor step needed) | none (individual) | ✅ ✅ ✅ ✅ | ✅ ✅ ✅ | 12 = 12/0/0 in all 7 clean runs | pad proven; the L1 cell can run at the builder default |
| tennis | tour | `core.start` one-for-one; `tennis.set_summary` one-for-one (setScore sheet; a 6-3 set asks no tie-break numbers) | none (individual) | ✅ ✅ ✅ ✅ | ✅ ✅ ✅ | 9 = 9/0/0 in all 7 clean runs | pad proven for straight sets without a tie-break; the L1 cell can run at the builder default |
| icehockey | iihf | `core.start` one-for-one; `icehockey.goal` one-for-one (goal tile + hold release); `icehockey.period.advance` **fallback** — the advance tile stamps `at: {period, elapsed}` beside `to` (`period-shared.ts:961`); judged on `to` | none — team entrants with 0 members (PADPROOF only) | ✅ ✅ ✅ ✅ | ✅ ✅ ✅ | 15 = 6/0/9 in all 7 clean runs | pad proven for regulation results (no OT / GWS is generated); L1/L2 ⏳ W1-driving (team rosters) |
| hockey | fih-outdoor | `core.start` one-for-one; `hockey.goal` one-for-one; `hockey.period.advance` **fallback** (as ice hockey) | none — team entrants with 0 members (PADPROOF only) | ✅ ✅ ✅ ✅ | ✅ ✅ ✅ | 17 = 5/0/12 in all 7 clean runs | pad proven for regulation results (no shoot-out is generated); L1/L2 ⏳ W1-driving (team rosters) |

**What W1d may assume, across all sports.**

- `NoPadAdapter` is unreachable: `PAD_ADAPTERS` covers all 11 catalogue sports.
- No adapter declares a tolerated key.
- Every fallback is judged, never waved through: `registerPads` refuses an unjudged one at load.
- **Team entrants.** Five sports are team-kind (football, cricket, volleyball, ice hockey, hockey). Their pads are
  proven on rosterless team entrants, and in PADPROOF only (ruling D-T9-2). LIFECYCLE and every other scenario
  still defer team rosters to W1-driving. So an L1/L2 cell for one of those five records ⏳ `later` (W1-driving,
  "team rosters"), not ❌, until W1-driving seeds rosters.
- **Builder defaults.** PADPROOF runs at the builder default only. Builder defaults are the only variants proven on
  a pad.

## Session prompts

One per wave, beside this file. Each carries its read-first list, prerequisites,
routed gaps (copied from design §8), lifecycle, decisions owed, done-when and
traps.

- [W1a — L3 core](W1a-l3-core.md)
- [W1b — catalogues + reference skeleton](W1b-catalogues-reference.md)
- [W1c — browser layers](W1c-browser-layers.md)
- [W1-driving — L3 driving breadth](W1-driving.md) (runs before W1d, ruling 28)
- [W1d — CI + first truth run](W1d-ci-truth-run.md)
- [W2 — sport scoring fidelity](W2-scoring-fidelity.md)
  - [W2 coverage audit](w2-coverage-audit.md): the controller's engine → rulebook → generator audit (2026-09-30) behind the W2 checklist
- [W3 — Swiss](W3-swiss.md)
- [W4 — knockout family](W4-knockout.md)
- [W5 — round-robin family](W5-round-robin.md)
- [W6 — double elimination](W6-double-elim.md)
- [W7 — americano, mexicano, ladder](W7-americano-mexicano-ladder.md)
- [W8 — scorer sheets (lane)](W8-scorer-sheets.md)
- [W9 — operational (lane)](W9-operational.md)
- [W10 — sweep (lane)](W10-sweep.md)

## Owner rulings

Rulings BY THE OWNER, 2026-09-27 brainstorm. Recommendations I made are in the
next section and are **not** interchangeable with these. Never carry either to
a peer session as the other.

1. **Scope B** — all nine issues opened 2026-09-23 → 09-27 are folded in:
   #879 #850 #846 #870 (format work), #880 #878 #858 #853 #843 (lanes).
2. **Order by what customers hit next** — no events booked, so production
   usage was pulled (badminton knockout 10 / Swiss 9 / league 1 divisions).
   Refined by ruling 3.
3. **The whole format × sport matrix is the frame; approach 1** — customer-path
   waves grouped by format family. No guard-only "W0" wave.
4. **Every offered cell gets a browser walkthrough (B)**, and edge cases are a
   first-class axis — "what happens in the middle of a withdrawal, a walkover
   in only one match, etc."
5. **All [M] scenarios join the scenario axis; [O] items are a separate wave**
   (W9).
6. **Unfit cells and unsupported scenarios: case by case (C)** in each wave's
   rulebook — no blanket default.
7. **Three layers (A):** L1 every cell's lifecycle in the browser, L2 every
   (format, scenario) and (sport, scenario) pair in the browser, L3 the full
   cartesian through the real server.
8. **Bench: fold B17 into this programme (A); this programme goes first,
   bench suites interleave** as closing gates after the matching wave.
9. **Section 1 (programme shape and waves) approved.**
10. **Expected values: a full reference model (C)** — pairing, brackets,
    progression and standings — plus invariants.
11. **Rulebooks follow federation rules (A)**; product rules where no federation
    governs; deliberate deviations recorded as owner rulings.
12. **Customisation levels:** stage-level for every setting; fixture-level for
    **match format only** (game points, sets, best-of, overs, halves), **only
    before the fixture starts**; **never** per-fixture table points or
    tiebreakers (Q11 A); **no mid-match rule change**. Worst case named by the
    owner: a final with no time left gets shorter games before it starts.
13. **Sections 2 (harness) and 3 (rules and done) approved.**
14. **Written spec approved** (2026-09-27, commit `b56a19ad4`).
15. **Mixed-driver lifecycle accepted** for L1/L2 (design §6.2, O2): every
    distinct action type in the browser at least once; filler fixtures scored
    over HTTP.
16. **CI cadence: weekly scheduled full run + manual dispatch** (design §6.5,
    O1). Refined by ruling 20.
17. **Do not split `run-suite.ts`** — the L3 runner is a lean runner of its own
    reusing only the bench's small helpers; bench runner work is no longer
    blocked by W1 (amends the sequencing half of ruling 8; B17 stays folded in).
18. **W1 is split into W1a–W1d** (L3 core · catalogues + reference skeleton ·
    browser layers · CI + truth run).
19. **Wave done = zero ❌ attributable to the wave's own routed gaps**; other
    reds on its rows are tagged ⏳ with their owning wave; the programme end
    still requires the whole matrix green.
20. **Weekly L1 + L2 + L3 while the repo is public ($0 on standard runners).**
    The owner will make the repo private later; the private-repo plan
    (self-hosted runner) is a recommendation to be ruled at the switch.
21. **Hole-finding additions approved** (design §7.3a, §7.5; `_RULES.md`
    R25–R28): fast-check model-based sequence testing (W1b), anti-vacuity counts
    on every invariant, automated Stryker mutation testing weekly (W1d),
    `forEachSport` sweep by default, production shadow invariants logging to
    Sentry (W10 lane, after #878), and the PR row-declaration + four reviewer
    questions.
22. **W1a plan approved** (2026-09-28): `docs/superpowers/plans/2026-09-27-format-matrix-w1a.md`
    as written; execution is subagent-driven (fresh implementer + reviewer per
    task, whole-branch review at the end).
23. **Read-only transitive `PackSchema` load accepted** (W1a open question 1):
    importing `tools/bench/lib/plan.ts` transitively loads the pack schema
    for reading; R3 still forbids importing or editing `run-suite.ts` /
    `pack-schema.ts` directly.
24. **W1a/W1b defaults** (W1a open questions 2–3): the W1b double_elim denied
    state is produced by an entitlement-override deny, not a plan downgrade;
    "default config" = the builder's own default (`pickVariant`). Volleyball
    defaulting to beach and chess to blitz are flagged for a product look, not
    changed in W1a.
25. **W1b plan approved, executed subagent-driven** (2026-09-28):
    `docs/superpowers/plans/2026-09-28-format-matrix-w1b.md`. The owner
    applied the controller's recommendations on 26–29 as written.
26. **O9 — entry path E is its own scenarios, not an axis** (E1, E2, E3,
    E4a, E4b; only E2 in L3). M and C are not multiplied by E.
27. **O10 — `packages/reference` imports engine types by statement-form
    `import type` from `@seazn/engine/core` only**; inline `{ type X }` is
    refused (strip-types keeps it as a runtime load). No leaf types package.
28. **Q-A — W1a's deferred driving work becomes a "W1-driving" wave before
    W1d**, so no ⏳ row points at a closed wave.
29. **Q-B — variant cases run LIFECYCLE only**, not × every scenario.
30. **M12 injured player; M4 split into no-result / with-result** (2026-09-28).
    The owner said "yes" to the controller's recommendation; it is recorded
    here as the owner's ruling on that recommendation.
    - **M12 "player injured mid-match (team sport)"** has three atoms:
      - M12a: a substitute comes on and the match continues.
      - M12b: there is no replacement, so the team plays short.
      - M12c: a cricket batter retires hurt, then resumes.
    - **Where M12 applies.** M12a and M12b apply to team-entrant sports only
      (R16's rule). M12c applies to cricket only.
    - **M12b's paths.** It runs in L3 over HTTP (`core.lineup.retirement`).
      In L2 it is a known no-path, because no pad or console control sends
      it.
    - **M4 splits** into M4a "abandoned, no result" and M4b "abandoned with a
      result", for example a cricket DLS decision or a football award-policy
      abandon.
    - **The suspected abandon→void defect** (ST-G1) is confirmed or refuted
      live in W1b Task 15.
    - Applied in the W1b plan (Tasks 4, 6, 7, 15 and 16) and in design §4.
31. **No set-to-1: the points-per-set floor is 5 for volleyball and table
    tennis** (2026-09-28). The owner said "5 points OK" to the controller's
    recommendation.
    - **Why.** W1b's variant sweep (Task 5) found 40 unscorable
      volleyball and table tennis cases: sets to 1 point with win-by-2.
    - **Who owns it.** W2 owns the change: raise the `SPORT_RULES` minimum
      in `match-rules.ts`.
    - **Re-read the bounds first.** W2 reads the current bounds before
      editing; they have not been re-read since W1b's plan.
    - **Regenerate the catalogue.** The regenerated variant catalogue ships
      in the same PR, as a reviewed diff.
    - **Cricket is separate, and was never a product item.** The 38 cricket
      cases at 3–5 a side that failed with "wickets exceed all-out" were a
      harness generator bug. `streams/cricket.ts` hard-coded its wicket counts
      and ignored `playersPerSide`. The W1b Task 8 re-review found this (RR-1),
      and the generator was fixed in W1b. Nothing is routed to W2 for them.
      The 24 cricket `test`-preset cases (two-innings streams the generator
      cannot build yet) are a harness gap routed to W1-driving.
    Closed by ruling 228 (W2e D8, 2026-10-28): the write door refuses a set target below 5 for volleyball and table
    tennis (`SetBasedPreset.minSetTo` through `configWriteIssues`), the editors floor at 5, and migration V481 fails the
    deploy loudly on any stored config below it (staging counted 0).
32. **A tied T20 knockout is checked live in W1b Task 15 (Step 3c)**
    (2026-09-28). The owner said "yes" to the controller's recommendation.
    - **The suspicion** (candidate defect CD-T6, from reading the code, not
      a run):
      - At cricket's builder default (t20, super over off), equal runs
        fold to `{kind:"tie"}`.
      - The knockout draw guard checks only `kind === "draw"`
        (`append-event.ts:335-345`).
      - `competition.ts:147-163` assumes a tie never reaches a bracket.
      - So a tied knockout may complete with no advancer and stall the
        bracket.
    - **If confirmed,** route it to W4 (knockout family) and W2 (what a tie is
      worth in a knockout). No check is loosened to pass.
33. **Board-game time control: fix the editor and show it, no pad clock**
    (2026-09-28). The owner said "OK 1 and 2" to the controller's
    recommendation.
    - **The finding** (CD-T8, found by reading, not a run; W1b Task 8 review
      plus a trace): the time control is INERT from end to end.
      - The editor (`match-rules.ts:667-697`) writes
        `divisions.config.clock`, and the engine carries it as "metadata only"
        (`boardgame.ts:55-85`).
      - Nothing reads it: no fold, no pad skin (`skins/boardgame.tsx:208-217`
        reads only colours), no public page, sheet, overlay or OpenAPI.
      - The editor also shows increment and delay while the base is blank,
        and then silently drops them.
      - A saved clock reopens blank, because the field has no `read`.
    - **W2 owns two fixes:**
      1. **Editor.** Rehydrate the saved time control, stop dropping
         increment and delay, and hide both until a base is entered.
      2. **Display.** Show the time control (for example "90+30") on the
         public division page and on the scorer sheet. The sheet is W8's
         surface, so agree ownership of the shared code first. The new
         strings go into all four locales.
    - **No pad countdown clock.** Players at each board run a chess clock, not
      an organiser. With N boards the event needs N devices, and nothing syncs
      them centrally. A loss on time is recorded as the result method `time`,
      which already exists. A per-board clock returns as its own feature only
      if clubs without clocks ask for it (#421 stays parked).
34. **The Pro plan change: later** (2026-09-28). The owner said "let's do pro
    plan later on".
    - *Controller note (context, not the owner's words):* the question was
      whether to free the Pro formats for Community. The controller had
      recommended granting `formats.double_elim` and `formats.advanced` to
      Community in the plan catalogue, in a PR of its own. W1b changed
      nothing for it: the seven DENIED cases stay as built, and their gate map
      is derived from the product (`format-gates.ts`), so a later plan change
      moves them with it.
35. **The PUT-stages data loss: W9** (2026-09-29). The owner said "let's
    leave to W9".
    - *Controller note (context, not the owner's words):* the finding is
      false premise 8, confirmed live. A refused format change deletes the
      division's existing stage (evidence `truth-runs/w1b-probe/results.json`).
36. **No browser/visual check in W1b of the 5 listed findings** (2026-09-29).
    Asked whether W1b should add a browser/visual check of five findings, the
    owner said "No". The five: the gated-PUT data loss, ST-G1, CD-T6, CD-T13
    and MB-002/003. The ruling does not cover MB-004/005, which were found
    after the answer.
    - *Controller note (routing, not the owner's words):* the alternative the
      controller offered was to leave visuals to W1c.
37. **W1c: `BrowserDriver` runs inside the matrix runner** (2026-09-29). The
    owner answered "1" to the controller's two options.
    - **What it means.** `BrowserDriver` lives in `tools/matrix/lib/driver/`,
      uses the Playwright *library* (the root `playwright` dependency, as
      `tools/bench/lib/tap-play.ts` already does), and is selected by the
      matrix runner. L1 and L2 share L3's planner, invariants, `decideState`,
      `results.json` and `MATRIX.md`.
    - **Rejected alternative:** Playwright Test specs under
      `apps/web/e2e/matrix/` importing the scenario scripts. That would have
      been a second verdict pipeline, an `e2e-ci-wiring.test.ts` inventory to
      keep, `scripts/` pulled into the `apps/web` typecheck, and the `-g` and
      serial traps of class 21.
    - *Controller note (context, not the owner's words):* the controller
      recommended option 1 because a browser green and an HTTP green then mean
      the same check set, parity is a JSON diff, and W1d can shard L1/L2 like
      L3 without editing `e2e.yml`, which runs only on a push to `main`.
38. **W1c borrows the bench's tap helpers by import** (2026-09-29). Asked
    "import, or copy?", the owner answered "1" (import).
    - **What it means.** `tools/matrix` may import four more bench modules:
      `tools/bench/lib/ledger.ts`; the sport-blind exports of
      `tools/bench/lib/drivers/scorer.ts` (`TapStep`, `selectorForTapStep`,
      the chassis testids, `TAP_PACING_MS`, `PadPage`, `organiserStepsFor`);
      `tools/bench/lib/drivers/adapters/generic.ts` (`genericAdapter`); and
      the pure helpers of `tools/bench/lib/tap-play.ts` (consent seed,
      device-link mint and pad URL, `waitForStartRow`,
      `reloadConsoleBeforeAction`). The private `executeStep` is copied.
      `playMatchByTaps` and `createTapPlayer` are not used: they fix the
      scorer at 390 px and the organiser at 1280 px, and always finalize,
      which the HTTP path never does.
    - **This extends ruling 23.** `scorer.ts` loads the pack schema a second
      way, through `simulate.ts`; ruling 23 had accepted that load only
      through `plan.ts`. R3 still holds: this programme never edits those
      bench files, and a change to one is coordinated with the bench's index
      first.
    - **Rejected alternative:** import only `ledger.ts` and copy the rest with
      the matrix's own pins — no ruling-23 extension, but two copies of the
      tap vocabulary to keep in step.
    - *Controller note (context, not the owner's words):* the bench-reuse
      scout (2026-09-29) also found that the badminton, table tennis and
      volleyball pads write the coarse `*.summary` event through a `setScore`
      tile, so the matrix pads can replay generated events one for one in the
      bench's `TapAdapter` shape. Found by reading, not yet driven.
39. **W1c's first browser layer (L1) runs at 1280 only** (2026-09-29, plan
    review). The owner asked: "D1, I think 1280 is good right as we are
    proving the product work?" The controller agreed, with a condition: the
    phone path has to be proven somewhere else. The owner answered "confirm".
    - **What it means.** L1 = every cell at 1280. The phone path is proven by
      the L2 rotation over all seven narrow widths (committed
      `l2-pairs.json`), by W1c's one-off width sweep (`league|badminton`
      LIFECYCLE at all seven widths, 320 included, 7 runs), and by pad proof
      at 1280 and 320.
    - **Cost:** 231 L1 runs full-grid in W1d, not 462 (`counts.json`'s L1
      figure is corrected in W1d).
    - **Rejected:** L1 at 1280 and 320 (the plan's original D1).
40. **W1c plan D2–D9 accepted as written; execution is subagent-driven**
    (2026-09-29, plan review; owner: "Remaining D* are fine", "subagent is
    fine"). Plan: `docs/superpowers/plans/2026-09-29-format-matrix-w1c.md`.

41. **Batch the same-shape work** (2026-09-29). The owner asked for work of the same shape to go out as one
    dispatch with one review, instead of one of each per task.
    - *Controller note (application, not the owner's words):* in W1c the controller batched two groups.
      Tasks 9–11 (nine sport pad adapters, one shared recipe) went out as one implementer dispatch and one review.
      Tasks 14 and 15 (the live evidence and the `_INDEX` record of it) also went out as one dispatch and one review.
      Tasks 5, 6, 7, 8, 12 and 13 kept their own dispatches, because each had a different shape. Each batch still got
      its own review.
42. **Enumerate every possibility, and give each one to a wave** (2026-09-30). The owner's words: "don't miss
    any possibilities". Every sport's rule-level possibilities must be enumerated, and each must be owned by a wave.
    - *Controller note (application, not the owner's words):*
      - The controller ran a read-only audit of the engine, the W2 rulebooks and the generators, sport by sport
        (`w2-coverage-audit.md`).
      - The audit's result is written below as a binding checklist for W2: see "W2 checklist" and
        `W2-scoring-fidelity.md`.
      - The same engine → rulebook → generator audit runs before each of W3–W7.
      - The specific rows in the checklist are the controller's audit. They are an input for recommendations, not an
        owner ruling on each row (class 17).
43. **Task 14's two recommendations are accepted** (2026-09-30; relayed by the controller and recorded in the W1c
    ledger, `.superpowers/sdd/2026-09-29-format-matrix-w1c/progress.md`, gitignored).
    - (a) **The width sweep on the KNOCKOUT cell stands.** `knockout|badminton` at all seven widths, in place of
      ruling 39's `league|badminton`. The league sweep is not owed by W1c.
    - *Applied (not the owner's words):* since `e431cbbce`, `--set width-sweep` plans `knockout|badminton`, so the
      set's PLAN matches the committed `w1c-sweep-ko` evidence: the same seven case ids, in one layered run (final
      review m-1). The set itself has never been run live.
    - (b) **The API-only set runs as planned 🚫 `no_path` with no browser,** each row naming its wave and reason, not
      ❌ `organiser-ui-path` from Generate onward as D7 (ruling 40) said.
44–49. **W1-driving scope** (2026-09-30). The controller put six scope recommendations for W1-driving planning, and
    the owner answered "all rec". They are recorded here as the owner's rulings on those recommendations (class 17).
    Inputs: three read-only scouts at `ebf7ec040`, which found 13 items routed to W1-driving (the status row names 5)
    and 177 of 231 LIFECYCLE cells ⏳ W1-driving (33 ladder-family, 99 multi-stage, 45 team-roster).
    - **44. The cricket two-innings (`test`) generator and the cricket tie outcome belong to W1-driving.** Both are
      struck from W2's generator-breadth checklist. Ruling 31 had already routed the 24 `test` cases here. The W2
      checklist also claimed both, which left two owners.
    - **45. I2 on double elim, stepladder and page playoff is STRUCTURAL only.**
      - What W1-driving asserts:
        - the champion is the winner of the terminal final fixture: `pp-final`, the last stepladder game, or
          GF / gf-reset;
        - that winner is `finalRanks[0]`;
        - `finalRanks` is a permutation of the field.
      - "Exactly one unbeaten entrant" stays knockout-only. A DE or page-playoff champion may have lost once.
      - Rulebook semantics, including the bracket-reset rules, stay with W4 and W6 (R8/R9).
    - **46. Parallel workers are in-process and belong to W1-driving.**
      - N workers run against ONE server and DB.
      - Each worker has its own sign-in, session and cookie jar.
      - Results are written in plan order.
      - W1d owns the CI shards (one DB each), and runs these workers inside each shard.
    - **47. Browser scope.**
      - Roster and lineup seeding, seed-proposal → confirm and ladder challenges are HTTP setup filler.
        `BrowserDriver` uses the same filler, so L1 on those cells stops being ⏳.
      - Live L1 proof at 1280 covers one cell per new capability. The full L1 grid stays W1d's.
      - Rule-override driving in the browser (`OVERRIDE_WAVE`, which no wave owned) goes to **W2**. W2 owns the
        editor fixes under ruling 33.
      - The two template-only cells (`group_only|badminton`, `group_group_ko|cricket`) are driven by W1-driving.
    - **48. Done-when.**
      - The evidence is an HTTP run of the four scripted scenarios (LIFECYCLE, M1, R4a, F1) over all 231 cells
        (924 cases, on workers), plus the 24 cricket `test` variant cases.
      - The wave is done when no ⏳ names W1-driving and no ❌ has a harness cause.
      - Product reds are recorded and routed, never fixed in this wave (ruling 19).
    - **49. Reference model.**
      - The model gets team rosters, so team cells can run in it.
      - Swiss gets a command generator biased toward Start → Generate → Score, instead of relying on 40 runs.
      - Multi-stage and the ladder family in the model go to the family waves (W4, W5, W7), where their rulebooks
        live.
    - *Folded in by the controller without a separate ruling* (the owner was told and did not object):
      - Field size is per format: a page playoff seeds 4. F1 on `page_playoff_only` is dropped as unfit, because
        an odd field is impossible there (ruling 6, case by case).
      - Rosters are always the full declared size. Lineups are PUT before each fixture's first event.
      - Americano and mexicano individual entrants get linked persons.
      - The Q-A guard is widened to read the six blind-spot routes. The W1-driving status row reads "in progress"
        while deferrals remain.
      - A `W1-driving.md` prompt file is written, and R1's sequence gains W1-driving.
50–52. **W1-driving plan review 1** (2026-09-30). The controller put two questions from plan review 1 and the plan's
    D1–D13 to the owner, and the owner answered "all rec". They are recorded here as the owner's rulings on those
    recommendations (class 17). Plan: `docs/superpowers/plans/2026-09-30-format-matrix-w1-driving.md`.
    - **50. The `l2-pairs.json` reshuffle is accepted once.**
      - Dropping F1 on `page_playoff_only` renumbers 931 of 1,731 L2 runs and re-widths 949. The cause is global
        numbering plus a lap shift every 7 picks (`pairs.ts:132-165`).
      - The reshuffle is accepted and named in the commit.
      - Committed evidence stays judged against `plans.lock.json`.
      - Task 10's regen must change only `l3Gap` fields.
    - **51. M1 and R4 get a defined meaning on the ladder family.**
      - M1 on americano and mexicano targets the first fixture whose pair entrant has seed 1's person as a member.
      - R4 on the ladder withdraws seed 3 after its first challenge.
      - R4 on americano and mexicano, where the withdrawn player keeps playing their pair games, is a predicted
        product red routed to W7.
      - Not dropped as unfit, per ruling 42.
    - **52. Plan decisions D1–D13 are accepted as written.**
      - D6 amends ruling 49: model refusals route by design §8, which adds **W3** for `swiss_playoff` and
        `swiss_knockout` beside W4, W5 and W7.
      - D5: future generator gaps route to W2.
      - D10: `--workers > 1` is HTTP-only in this wave.
      - D13: the L1 proof excludes cricket `test`, and the pad routes for its new events go to W1d's list.
53. **R4 on the ladder is judged by what a withdrawal actually leaves** (2026-09-30). The owner said "apply rec" to
    the controller's recommendation from plan review 2. It is recorded here as the owner's ruling on that
    recommendation (class 17).
    - **Why.** False premise 13 was confirmed by the review. After seed 3's decided first challenge, nothing is
      pending. The ladder takes the open-format branch (`withdrawal.ts:213-217`), so the policy is `none` and
      nothing is voided.
    - **What a ladder R4 asserts:**
      - the policy is derived from the product's pending set;
      - seed 3's decided challenge is unchanged;
      - seed 3 is gone from the live ladder order but stays in the raw `ladder_order`;
      - no later challenge seats seed 3;
      - zero challenges are refused.
    - **Noted for W7, not asserted:** `finalRanks` is the raw `ladder_order` (`competition.ts:606`), so a withdrawn
      player keeps their rung.
54. **The W1-driving plan is approved; execution is subagent-driven** (2026-09-30). The owner answered "Yes" to the
    controller's three questions: does the plan capture what you want, which execution method (the controller
    recommended subagent-driven), and push the branch.
    - Plan `docs/superpowers/plans/2026-09-30-format-matrix-w1-driving.md` at `dc85a7741`, after plan review 4
      (Approved, five minors carried to the executor).
    - Execution worktree `format-matrix-w1-driving-exec`, branch `feat/format-matrix-w1-driving`. Same-shape tasks are
      batched per ruling 41.

The five decisions below are the owner's, made on 2026-10-01 and recorded by the controller in the W1-driving SDD
ledger. Controller ruling T16-R4 numbered them. Quotation marks hold the owner's words where the ledger or the controller's 2026-10-01 conversation with the owner has them.
Elsewhere the text is the controller's record.

55. **Format templates stay in code** (2026-10-01). The owner, asked "should we hardcode like this, should driven from
    db?" and given the controller's recommendation (stay in code; the matrix catalogue reads the file, so a DB list
    would make case counts differ per environment): "apply rec". No DB table. The cleanup (move the file out of
    `components/v2`, single-source `TakeRuleSchema`) is owed after this wave and is outside W1-driving's scope.
    - **Landed 2026-10-04** (the cleanup PR, branch `chore/matrix-cleanup`). The file is
      `apps/web/src/lib/format-templates.ts`, its test `apps/web/src/lib/__tests__/format-templates.test.ts`; every
      importer moved with it, with no re-export shim (`eb536d4b4`). `TakeRuleSchema` is tied to the engine's
      `TakeRule` at compile time in both directions — `TakeRuleSchemaMatchesEngine` and
      `TakeRuleSchemaMatchesEngineFields` in `server/api-v1/schemas.ts` — and
      `server/api-v1/__tests__/take-rule-schema.test.ts` parses every template's take rules at runtime (builder
      grid, format families and the catalog JSON; `b84d3cc28`).
56. **The matrix harness gets a boundary, not a separate repo** (2026-10-01). The controller's record (T16-R4): the
    harness moves to its own workspace package, behind an import guard, with its evidence moved out and a
    `.dockerignore` entry. It is NOT a separate repo. The owner raised the concern ("I a thinking as we are making
    bigger monolithic") and answered the recommendation with "Ok". The runtime image already excludes the harness
    (`Dockerfile:88-105` copies only the standalone build). Timing: the same post-W1-driving cleanup as ruling 55.
    - **Amended 2026-10-04: the evidence STAYS.** Recorded from the controller's cleanup brief, which carries the
      owner's "ok": the truth runs are 12 MB, read by 12 CI test files, W1d's baseline, and history already holds
      them, so moving them out buys nothing. They are left out of the image instead.
    - **Measured 2026-10-05:** `truth-runs` is 24136 KiB under `du -sk` (24074264 bytes over its 362 tracked
      files, the sum of `git ls-files -z truth-runs | xargs -0 stat -f %z`; an earlier draft of this line carried 24074186), of which `w1d-baseline` is 9916 KiB, not the ~12 MB written above (that figure predates the W1d
      baseline). The ruling stands; only the number moved.
    - **The package.** The harness lives at `tools/matrix` as `@seazn/matrix`; `tools/` is the home for dev-only
      harnesses (bench to follow; it did on 2026-10-04 as `tools/bench`, `@seazn/bench`, recorded in the bench
      programme's `_INDEX.md`). Choosing `tools/` over `packages/` was the controller's ruling (CL-R3, revised),
      not the owner's: the owner asked "tools or package?" and said the bench would follow later, and the
      controller ruled on that. `tools/*` is a pnpm workspace glob; the harness's manifest declares what it
      really imports. Nothing in `apps/`, `packages/` or `scripts/` may import `tools/**` or `@seazn/matrix`:
      the eslint rule from `scripts/lib/tools-import-guard.mjs` is the coarse layer, and
      `scripts/__tests__/tools-import-guard.test.ts` resolves every import exactly. Nor may they reach it at
      runtime: the same test refuses a root `package.json` dependency on a harness, and any string in those trees
      that names a root script whose command points into `tools/`. **Limit, closed in part by W1d item 28
      (Task 11, `b6de52dba` and `b8700d19e`, 2026-10-05):** the guard also reads the ARGUMENTS of `child_process`
      calls. A string literal, or adjacent literal pieces such as `"tools"`, `"matrix"`, passed to `exec`,
      `execFile`, `spawn`, `fork` or a `Sync` form under `apps/`, `packages/` or `scripts/` that resolves into
      `tools/matrix` or `tools/bench` is a hit; its own two exempt files are READ too, and their hits are pinned to
      an explicit list (`[]` today). Real tree on 2026-10-05: 387 calls in 170 files, 0 hits (341 of the 387 are
      `RegExp#exec`, so the floors count the unambiguous names). **What it still does NOT see** (each is a
      pinned known gap, `SPAWN_KNOWN_GAPS` in the guard test, so closing one means moving its row): a spawn that
      names the harness by PACKAGE (`pnpm --filter @seazn/matrix`), a path held in a variable or built from an
      interpolated harness name, `execa` and other libraries, an aliased or promisified spawner, and
      `tools/Matrix` (only a case-insensitive filesystem resolves it). A REAL file that loads `child_process` and
      spawns through an alias is still seen: the importers oracle reds on any file that loads it but holds no
      inspected spawn call. Code the gates share with the harness lives in
      `scripts/lib`: `main-module.ts`, and `crash-exit.ts`, which `reference:boundary` preloads and
      `packages/reference`'s test spawns (the cleanup review's I-1, fixed by lifting it). `.dockerignore` lists
      `tools/` and `docs/superpowers/specs/**/truth-runs/` (`scripts/__tests__/dockerignore.test.ts`).
    - **Scans (2026-10-04, controller ruling BT-R2).** #913 silently dropped `tools/matrix` from three scans:
      `test-email-domain`, `z3-retirement-drift` and the engine's `z3-dependency-retired` (AGENTS class 6). The
      bench move's PR restored it. All three read all of `tools/` now. Each checks that every workspace there
      contributes files, and each holds a floor for the bench and the matrix.
    - **Old paths.** The committed evidence still spells `scripts/matrix` and is never rewritten.
      `tools/matrix/lib/harness-path.ts` is the one map from the old paths to the new ones (the directory, and
      the two files that left the harness for `scripts/lib`); the single-sport ratchet's `--against` reads a
      pre-move base through it. In this index a citation pinned to a SHA (a line number "at `<sha>`", a file "as
      committed at", a run's tree, a command a past review ran) keeps the path that existed at that SHA, as the
      executed plans do. Every other path was updated to `tools/matrix` in the same PR and names today's file.
57. **The W9 stage delete stays with W9** (2026-10-01). The owner: "W9 is fine". A refused format change deletes the
    division's stages first: `replaceStages` deletes at `stages.ts:543`, before `createStages`' `requireFeature`
    gates. This is read-derived: the controller read it on `main` `58e8103e3`, and no committed run drives it. It
    is not fixed now, and there is no separate PR.
58. **No CI live-matrix proposal** (2026-10-01). Offered a W1d proposal for a live matrix job in CI (sharded, judged
    against the committed `results.json`, triggered on a `main` push or by hand), the owner: "no". Not logged as a
    W1d item.
    - **Clarified 2026-10-04.** The "no" meant "do not log a separate proposal": W1d already covers CI truth runs.
      The owner's 2026-10-01 answer "a", confirmed verbatim: "the matrix runs itself: weekly and on dispatch,
      sharded on fresh databases". W1d's design note is item 27 of "W1d first tasks" below.
59. **The W1-driving PR is raised after the reviews approve** (2026-10-01). The owner: "raise pr after review
    approve". Push `feat/format-matrix-w1-driving` and open the PR once Task 16's review and the final whole-branch
    review are approved, rebasing onto `main` first if it is behind, with a scoped re-verify. The merge is the
    owner's decision.

60. **The W1d weekly trigger stays in GitHub** (2026-10-04, W1d planning, Q1). Offered: (a) a GitHub-dispatch target
    in `apps/cron-worker` (#909), (b) an app route holding a GitHub token, (c) dispatch only. The owner: "ok to hve
    weekly or dispatch direclty GH". The controller's reading: the truth-run workflow carries its own weekly
    `schedule:` plus `workflow_dispatch`, and no Cloudflare worker is added. This relaxes "W1d first tasks" item 27's
    "must NOT be GitHub `schedule:`" for this one weekly job: a weekly run that fires hours late is harmless, and
    help-shots' weekly schedule has fired every week, 5–6.5 h late. A missed week must still be visible (see the
    plan's staleness check).
61. **Harness-green is design §6.5's definition** (2026-10-04, Q2, owner "Ok"). Every shard completes, every case
    reports a state (no ░, no harness error), and case states are identical across the three runs. Product reds are
    data. The W1d prompt's shorter suggestion, which dropped the identical-states clause, is not used.
62. **W1d ships as one plan and two PRs** (2026-10-04, Q3, owner "Ok"). `workflow_dispatch` can only fire a workflow
    file that is already on `main`. PR-A (infra): the "W1d first tasks" items, sharding, the workflow with its
    visibility guard, and the Stryker workflow, with the weekly schedule shipped disabled. PR-B (evidence): three
    harness-green dispatches, the triaged baseline committed, the Stryker floor, and the schedule enabled.
63. **Every ❌ carries an audit gap ID or a new ID** (2026-10-04, Q4, owner "Ok"). The ID is an audit gap (`SW-`,
    `FX-`, `ST-`, `SC-`, `SH-`) or `NEW-W1d-<n>`, with its owning wave. W1-driving's 164 product reds, keyed today by
    triage rule P1–P7, are re-keyed in the same pass.
64. **The first full truth run's scope** (2026-10-04, Q5, owner "Ok"). L1 is the full grid of 231 cells at 1280
    (ruling 39), and `counts.json`'s L1 figure is corrected from 462 to 231. L2 is the 1,731 pair-runs in
    `l2-pairs.json`, and L3 is the W1-driving set of 937 cases. Each GitHub job is one shard on a fresh Postgres with
    `sync:sports`, about 12 shards. That is $0 while the repo is public.

65. **Ruling 61's "no ░" applies to driven cases only** (2026-10-04, plan D7, owner "ok" to recommendation (a)).
    Ruling 64's full L2 scope plans 62 driven runs, 164 🚫 and 1,505 ░ of 1,731. The ░ runs have no scenario script
    yet, by construction. Those 1,505 are recorded as planned ░ (`planned: true`) and counted per atom in the summary,
    and they do not make a run harness-red. A ░ on a case the plan drives is still harness-red. The ░ count shrinks as
    W2–W7 add scenario scripts. Rejected: (b) shrinking L2 to the drivable runs, which hides the backlog, and (c) the
    literal reading, under which the weekly schedule could never be enabled.

66. **The matrix proves formats and rules, not scheduling** (2026-10-04, W1d plan review 3). Raised by fix round 2's
    caveat: `http-driver.ts` calls no `/schedule/` route, so the matrix may never reach the placement solver. The
    owner: "We are here to prove the format and rules, not the scheudling". For W1d:
    - The shard jobs carry no placement container and no "falling back to greedy" guard, unless a matrix path
      needs the solver to function. If one does, the container stays as plumbing, and no check claims to prove
      scheduling.
    - The Stryker scope is the format and rules code: `src/competition/**` and the draw generators under
      `src/scheduling/` (bracket, bracket-layout, roundrobin, swiss, americano, participants, feedgraph). The
      time/court placement groups (build, calendar, repair) are out, and the PR self-proof probe moves to a format
      file.
    - Design §7.5 item 2's "engine scheduling" therefore reads as draw generation, not placement. Scheduling quality
      stays with the bench programme.

67. **The Stryker scope is the whole engine except placement scheduling** (2026-10-04; it amends ruling 66's Stryker
    bullet). The owner: "Only scheduling is low priority, other than all include". The controller's reading:
    - **In scope:** every engine module under `packages/engine/src`, which is competition, core, sport, sports,
      stats, history, officials, import and exports, plus the draw generators under `src/scheduling/`. Those are
      bracket, bracket-layout, roundrobin, swiss, americano, participants and feedgraph; they are format code.
    - **Out of W1d's floor:** the placement files under `src/scheduling/`, meaning the build, calendar and repair
      groups. They are low priority, not banned: a named exclusion that a later wave may lift.
    - **Out entirely:** `testkit/`, which is test helpers. That is the controller's call; testkit is not product.
    - **Size, as the controller measured it on `dfe8132da`:** about 33k non-test lines, of which `sports/` is 21.5k.
      The weekly mutation job is sharded by group to fit the job limits.
    - **The unclassified `src/scheduling/` files** (owner "apply your rec", 2026-10-04). `index.ts` is a barrel and
      `logger.ts` holds no logic; `solver-test-bounds.ts` is a test helper; `placement-client.ts` is the gRPC client
      that only the integration tests cover; `payload-fixtures.ts` is excluded if it only builds the placement
      request, which fix round 3 checks. All five are excluded by name, with reasons. `generated/**` is excluded too.

68. **The repo goes private after W1d; the matrix runner is switchable now** (2026-10-04). The owner first asked about
    running the matrix on a Fly.io VM, as a thought rather than a decision, then said "mostl we will keep the private
    repo only". Two decisions follow from the owner's answer "apply your rec, go private after W1d":
    - **In W1d PR-A:** every matrix and Stryker job takes `runs-on: ${{ vars.MATRIX_RUNNER || 'ubuntu-latest' }}`.
      The visibility guard fails loudly when the repo is private AND `runner.environment == 'github-hosted'`; on a
      self-hosted runner it passes. A test proves both directions.
    - **Before the switch, outside W1d:** a short follow-up builds an ephemeral self-hosted GitHub Actions runner on
      Fly Machines. It gets its own Fly app, its own image (Node, Playwright browsers, Postgres) and no production
      secrets. Then only `vars.MATRIX_RUNNER` changes. This supersedes the design §6.5 recommendation's "a VPS or the
      owner's machine". W1d still builds no runner (W1d prompt, "Decisions owed").
    - **The order:** W1d's PR-B dispatches run on GitHub-hosted runners while the repo is public. Then the Fly
      runner follow-up, then the switch to private. PR CI (`ci.yml`) goes back on the meter at the switch; that cost
      is outside the matrix.

69. **The W1d plan is approved** (2026-10-04). The owner answered "apporve" to: "Does the plan cover what you want,
    and shall I push the plan branch and start PR-A?" The approval covers the plan as written at `5978f46b6`: its
    22 tasks, its recommendations D1–D24, and its executor carries. It is executed subagent-driven under the plan's
    Execution model policy (Sonnet for implementers, task reviewers and fixers; Opus for the whole-branch reviews,
    owner 2026-10-04). The plan branch is pushed, and PR-A starts.
70. **Harness-green holds with three named P6 exceptions** (2026-10-05, owner "A" to the Task 17 Step 5 question).
    Three dispatches on `matrix-truth/w1d-baseline` (`47f210e3f`) judged `across`: L1 (231) and L2 (1731) 0 differing;
    L3 (937) 3 differing — `swiss_knockout|football|11-a-side|R4`, `swiss_knockout|carrom|club-29|R4`,
    `swiss_knockout|generic|score|R4`. Every red reads "round 5 paired nobody (SW-H1)". The cause is the product:
    the `lots` tie-break (`packages/engine/src/competition/tiebreakers.ts`, `lotSeed` hashes the per-run entrant
    UUIDs) reorders tied Swiss entrants every run in the sports whose cascade ends in `lots` (football, carrom,
    boardgame, generic), so `rank_adjacent` pairs a different path to round 5, which on some paths has no
    rematch-free matching, and P6 (SW-H1: an empty round reported as success) fires. The harness is deterministic
    (code read: seed-order policy, fixed withdrawer, `fixture_no` order). Ruled: the harness is green for W1d; the
    committed baseline records those three cases RED with cause P6 (the worst observed state), and a later `works`
    is an improvement, not a regression. No re-dispatch. Recommendation (mine, not a ruling): move P6 up in W3,
    because a real Swiss-into-knockout after a withdrawal can strand on an empty round 5 that says it succeeded.
    W2d (2026-10-28): Swiss stages keep their own orders (ruling 193), so the three cells' lots flip stands; PR A's L3
    sample found no new P6 cell (see "W2d and ruling 70").

71. **W2 is split into five sub-waves, strictly sequenced** (2026-10-08, owner "approve"). W2a brackets always
    finish (SC-O1, SC-O2, SC-X1, SC-X3, NEW-H1) → W2b walkover/retirement/double-walkover credit → W2c stage-level
    rules with a screen, fixture override, O8 → W2d tables and tie-breaks → W2e sport-specific fidelity and the rest
    of the checklist. Each has its own spec, plan and PR; its rulebook items are signed at its own start. RB2A-1
    (BWF 3×15, effective 2027-01-04) sits in W2e; if W2e has not merged by 2026-12-01 it ships as a small standalone
    PR then (owner "Ok"). The owner also said prod is not urgent before 2026-10-31 (few customers).
    Rule rows: none (sequencing).
72. **A bracket match never ends level; one core settle event** (2026-10-08, owner "Ok"; RB2B-14, RB2A-31). In a
    bracket stage `draw`, `tie` and `no_result` are never a decided result. `core.settle` (organiser-only; lot,
    higher seed / higher group finisher, organiser decision; no invented score) completes a level or abandoned
    bracket fixture. RB2A-31's refusal of a walkover after an abandon is deferred to W2b. Rules X-BR-1, X-ST-1.
    Rule rows: X-BR-1, X-ST-1, X-DR-1 in `packages/engine/rules/cross-sport.md`.
73. **Chess knockout: RB2B-16 option A, narrow** (2026-10-08, owner "Ok", amended the same day). A drawn bracket game
    goes to a tie-break phase; the scorer records `boardgame.tiebreak` with rung rapid, blitz or armageddon (a drawn
    armageddon is won by Black). **Lots is not a rung** — it is the organiser's settle (owner, at the pad mockup).
    Rung configuration and games per match go to W2c. Rules BG-KO-1, BG-KO-2.
    Rule rows: BG-KO-1, BG-KO-2 in `packages/engine/rules/boardgame.md`.
74. **Other sports in brackets** (2026-10-08, owner "Ok"). Carrom always plays the ICF extra board (RB2B-23); generic
    refuses a draw and the scorer enters the winner (RB2B-28); a cricket knockout tie or no-result is closed by
    settle (RB2A-17); RB2B-1's creation refusal goes to W2c; RB2A-30 joint winners goes to W4; NEW-H1 (RB2A-29) is
    reproduced before it is fixed. Rules CA-KO-1, GN-KO-1, CK-KO-1.
    Rule rows: CA-KO-1 in `packages/engine/rules/carrom.md`, GN-KO-1 in `generic.md`, CK-KO-1 in `cricket.md`
    (same directory).
75. **A living rules reference in the engine** (2026-10-08, owner "yes"): `packages/engine/rules/`, one file per sport
    plus `cross-sport.md`, rows with id, rule, citation, status, enforced-at and proved-by, and a checker test (unique
    ids; every signed row names a test that contains its id). It moves with the engine in the split. The wave
    rulebooks are frozen research drafts; rulings point to rule ids.
    Rule rows: none; this ruling is the reference itself, built in W2a Task 2 (`packages/engine/rules/README.md`,
    checker `packages/engine/test/rules-reference.test.ts`).
76. **W2a approach A** (2026-10-08, owner "Ok"): deciders are match-config phases declared per sport
    (`bracketDeciders`) and applied by stage kind in `resolveFixtureCfg`; `core.settle` is kernel-owned and folds to
    `win{method: settled_<m>}` so both sides are seated. Rejected: commit-then-override; a new `settled` outcome kind.
    Rule rows: none (approach).
77. **One server-side organiser check for `core.settle`, `core.forfeit` and `core.abandon`** (2026-10-08, owner "Ok").
    Today forfeit and abandon are organiser-only in the pad's interface only. Rule X-ST-2.
    Rule rows: X-ST-2 in `packages/engine/rules/cross-sport.md`.
78. **The draw allow-list includes americano** (2026-10-08, owner "yes"): league, group, swiss, americano — no level
    result where someone must advance. Rule X-DR-1.
    Rule rows: X-DR-1 in `packages/engine/rules/cross-sport.md`.
79. **Hold, don't refuse** (2026-10-08, owner "Ok"; corrects the first draft of design section 2). A play-produced
    level result in a bracket is saved with the new fixture status `needs_decision` (not decided, nobody seated) and
    is closed by settle; refusal remains only for a generic draw. Reason: today a football knockout level at full
    time with no shoot-out is refused at write time and its cfg is frozen, so it can never record full time.
    Rule X-BR-2. Interface (owner 2026-10-08, wireframes only — the build applies house UI/UX): UI-1 a "Needs a
    decision" block on the fixture console; UI-2 a three-step chess tie-break on the pad.
    Rule rows: X-BR-1, X-BR-2 in `packages/engine/rules/cross-sport.md`.

80. **W2a execution model: Opus and Sonnet by role** (2026-10-08, owner "use Opus and Sonnet wisely"). Overrides the
    `.claude/agents/*.md` default for **W2a only**, like ruling 69 for W1d. Opus implements and reviews where a miss can
    pass a green suite or the judgement is semantic, security or the oracle: the engine batch, the web status/guard batch,
    the organiser gate, NEW-H1, the changed-lines Stryker config and the reference family. Sonnet implements with an Opus
    review where the spec dictates the output: the mutation runner, the UI tasks and harness breadth. Sonnet with a Sonnet
    review: the rules seed. Sonnet alone: evidence runs, `MATRIX.md`, screenshots, CI dispatches, PR text, pure-locate
    scouts. Opus: claim-verifying scouts and the whole-branch review. The per-loop table is the plan's "Execution model".
81. **W2a speed: tooling, batching and CI** (2026-10-08, owner "Ok"). Task 0 builds a one-command hand-mutation runner
    (one mutant at a time, only its named killer tests, restore and verify, killer table, non-zero on a survivor or an
    empty list) and a changed-lines Stryker override for the engine (no behaviour change when unset). Grouping mutants
    into one run is rejected: one red proves one kill. Local truth runs cover only the W2a cells; the full judge
    regression runs once from a CI dispatch. Same-file tasks share one loop (ten reviewed loops); the harness and the
    reference family run in parallel worktrees; Stryker families and e2e are dispatched once at the end.
82. **The W2a plan is approved, subagent-driven** (2026-10-08, owner "approve"). Plan
    `docs/superpowers/plans/2026-10-08-format-matrix-w2a.md` at `53c69eced`, amended at `bff86eedb` with the owner's
    answers: (a) finding 7 — V431 also moves legacy bracket rows stored decided/finalized with a level outcome to
    `needs_decision`; (b) finding 20 — no "Drawn, Black advances" choice in W2a: the scorer always taps the winner and
    the armageddon step shows the hint "In Armageddon a draw means Black advances"; recording armageddon colours is W2c;
    (c) the UI layouts were chosen in brainstorming (UI-1 option A, UI-2 option B), so Task 11 ends with a per-screen
    verdict on the built screens at 1280, 768 and 320 instead of a second choice. The owner also accepted the planner's
    findings 19 (the console block also shows for an abandoned bracket fixture with a level outcome) and 27 (Finalize is
    refused on a held fixture with `LEVEL_RESULT_IN_BRACKET` and hidden on the console).

83. **W2b scope** (2026-10-08, owner "ok"; W2b-R1). Walkover, retirement and double-walkover credit: closed reason
    vocabulary; walkover and retirement credit per sport; double walkover in all 11 sports; RB2A-31; withdrawal holes
    (C17 and friends); ST-G1 abandon-with-result counts; player stats. Out, each owned: RB2A-3/RB2A-16 → W5 (badminton
    keeps 50% as a recorded deviation), RB2A-7 → W2d, ST-G8 + stage settings → W2c, sanction/short-team endings → W2e,
    Swiss not-met/Buchholz → W3, RB2B-34 → W9, vacant title → W4. Spec §2.
    `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
84. **Double walkover is its own outcome** (2026-10-08, owner "OK, A but check and brainstorm with f-w2"; W2b-R2).
    `double_walkover`: both lose, nobody advances; fed seats dead so the opponent walks over; DE: neither drops;
    amends X-BR-1 to "a win or a double walkover"; not level; chess `double_forfeit` folds to it (retires T15-R1).
    Checked with f-w2: no clash. Rows X-DW-1, X-DW-2, BG-DW-1.
    `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
85. **Double walkover in a table** (2026-10-08, owner "A"; W2b-R3). P+1, L+1, 0 points, no score, out of every ratio.
    Row X-DW-4. `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
86. **Walkover credit per sport** (2026-10-08, owner "Ok"; W2b-R4). Derived from stage cfg, one credited score
    everywhere; hockey default 3 → 5; badminton groups a deviation until W5. Rows X-WO-1, *-WO-1, BD-WO-2, CK-WO-1,
    BG-WO-1. `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
87. **Retirement credit per sport** (2026-10-08, owner "Ok"; W2b-R5). Goal sports keep the real score if worse for the
    offender (FDC 28.1); in-match DQ = retirement credit. Rows X-RT-1, *-RT-1.
    `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
88. **An abandon counts only with a result** (2026-10-08, owner "Ok"; W2b-R6). Cricket DLS / NR 1 point; goal sports
    under award policy: leader wins, level = draw; carrom and generic abandon → replay; status follows the result; no
    backfill. Fixes ST-G1. Rows X-AB-1..3, FB/HK/IH-AB-1, CK-AB-1/2, CA-AB-1, GN-AB-1.
    `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
89. **Forfeit after an abandon** (2026-10-08, owner "A"; W2b-R7). Refused `ABANDONED_SETTLE_OR_VOID`;
    void-then-forfeit stays, credited as a retirement (RB2A-31, deferred by ruling 72). Row X-AB-4.
    `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
90. **Withdrawal walks over** (2026-10-08, owner "ok"; W2b-R8). Held fixture → auto-walkover (answers C17); chess
    pre-start forfeit; page_playoff/ladder walk over; TBD seat dead; both withdrawn → double walkover. Absorbs W2a
    D-G2/D-G3 corners. Rows X-WD-1..5, BG-WO-2. `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
91. **Player stats for unplayed matches** (2026-10-08, owner "ok"; W2b-R9). Walkover/withdrew/double walkover are not
    a match and credit no W/L; retired/DQ/abandon-with-result count. Rows X-PS-1/2.
    `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
92. **No double walkover without a next match** (2026-10-08, owner "a"; W2b-R10). Refused in a final, last rung or
    third-place match; fixture stays open; vacant title → W4. Row X-DW-3.
    `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
93. **DE: any forfeit loser is out** (2026-10-08, owner "a"; W2b-R11). No losers'-bracket drop; ranks agree with
    seating. Row X-DE-1. `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
94. **Console forfeit dialog** (2026-10-08, owner "A"; W2b-UI-1). One dialog: who → why (chips by phase) → credit
    preview → one Confirm. Wireframes only; build applies house UI.
    `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
95. **Public reason tags** (2026-10-08, owner "A"; W2b-UI-2). Short tag where space is tight (w/o, ret., DQ, 2× w/o,
    Aband. · DLS/NR), full sentence as tooltip, accessible name and match-centre line; per-locale abbreviations. Rows
    X-RS-2. `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
96. **W2b approach 1** (2026-10-08, owner "1"; W2b-A1). Extend `core.forfeit {by: entrant | "both", reason}`, strict
    (owner: no old forfeit data — verified before ship); per-sport `forfeitCredit` hook; `advancesNobody`. Rows
    X-RS-1, X-RS-3. `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
97. **Legacy completed stages holding a V432-moved fixture** (2026-10-09, owner "A"; W2b-R12). No reopen path;
    pre-ship count on staging and prod, stop and ask if non-zero.
    `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
98. **Quota slot counts only results with a verdict** (2026-10-09, owner "A"; W2b-R13). `division_has_results`
    excludes `no_result` and `double_walkover` whatever the status; a single walkover counts. Row X-BL-1.
    `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
99. **Chess tie-break pending: withdrawal walks over** (2026-10-09, owner "A"; W2b-R14). `core.forfeit`
    withdrew/walkover accepted in phase `tiebreak`; classical stays a draw in stats; replaces W2a D-R1. Row BG-WO-3.
    `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.
100. **The W2b spec is approved** (2026-10-08, owner "approve"; W2b-spec). Incl. the chess forfeit unification on
    `core.forfeit` and the boardgame `live` walkover phase; amended 2026-10-09 with rulings 97–99 and the W2a
    hand-overs (D-G2, D-G3, D-P2, D-R1, D-F4). `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3.

101. **W2b re-pin amendments and the atomic withdrawal** (2026-10-09, owner "Ok"). The spec's re-pin against main
     `a99147bd0` is accepted: byes become `award{loser: null, reason: "bye"}` with today's credit; `core.abandon`
     gains a cascade-only `expunge` flag so a table expunge never scores; a level bracket abandon keeps status
     `abandoned` and `forfeited` stays keyed on the `core.forfeit` event; W2b removes the two chess `boardgame.result`
     entries from the organiser-only list and rewrites its derivation. Making the withdrawal cascade one transaction
     stays **W9** (CD-T13's all-or-nothing half); W2b removes the known partial-withdrawal failures and proves every
     withdrawal path in its truth run completes. `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §3,
     §5.

102. **W2b plan approved, Q1–Q7 as recommended** (2026-10-09, owner "approve"). Plan
     `docs/superpowers/plans/2026-10-09-format-matrix-w2b.md`. Q1: golden forfeit payloads migrated by a committed
     rule (forfeit before `core.start` → `walkover`, after → `retired`, never `both`), then an isolated
     `REBASELINE_GOLDEN=1` commit. Q2: W2b edits the two bench pack builders' payloads; the bench's two `award.method`
     readers move to `reason` via the bench programme before W2b merges, or in the W2b PR with the bench owner's
     written OK. Q3: an award-policy abandon folds to `win{method: "abandoned"}`. Q4: no model override; agent
     frontmatter defaults. Q5: retired/DQ admitted in a chess tie-break; football SHOOTOUT and cricket super_over read
     as play. Q6: Stryker `group=all` is post-merge, not a merge gate; the probe and every hand mutant gate the merge.
     Q7: any non-zero pre-ship count stops the ship and goes to the owner with the rows. Execution: subagent-driven,
     loops as the plan's table.

103. **W2b plan — early pre-ship counts not taken** (2026-10-09, orchestrator record, not an owner ruling). Task 0
     Step 4's staging/prod reads could not run: the Supabase MCP failed to connect. The owner's 2026-10-08 statement
     "we don't have any forfeit old data" stands in until Task 17, where the same four queries on both projects are a
     hard ship gate (ruling 102 Q7: any non-zero stops the ship).

104. **No forfeit records on staging or production** (2026-10-09, owner: "no forfeit record"). The early pre-ship read
     (ruling 103) is answered by the owner: zero `core.forfeit` events, zero chess
     `boardgame.result{forfeit|double_forfeit}` and zero settled double forfeits on either project, so the strict
     `core.forfeit` schema and the chess method retirement cannot break a stored stream. Task 17 still runs the four
     queries if the Supabase MCP connects (incl. `complete_stages_holding_one`, which is not a forfeit count); if it
     does not, this ruling stands.

105. **An expunged group fixture no longer blocks auto-advance** (2026-10-10, owner: "fix it"). Pre-existing gap found
     in the W2b loop F review (M-10): a table withdrawal under 50% expunges its fixtures, which stay `abandoned`, so
     the auto-advance open count never reached 0 and the group never advanced. W2b counts an `abandoned` fixture whose
     active abandon carries `expunge: true` as closed for auto-advance; an organiser's plain abandon still holds, as
     before.

106. **Ruling 53 extends to every bracket kind** (2026-10-10, owner "A"). Ruling 53 covered the ladder only. A
     knockout, double-elimination, stepladder or page-playoff withdrawal that leaves nothing pending (e.g. an entrant
     already eliminated) also reports policy `none`, not `walkover`, because nobody is walked over. `withdrawal.ts`
     and the harness cite rulings 53 + 106; the earlier comment calling the knockout extension "owner ruling 53" was
     the orchestrator's reading and is corrected (class 17).

107. **W2b fixes `tools/bench` in its own PR** (2026-10-10, owner: first "update the index, don't fix", then "if it is
     a 30-min job with Sonnet, fine; otherwise disable that bench in CI", then "an hour is fine"). Answers plan Q2. A
     bench lane (`feat/format-matrix-w2b-bench`, merged into W2b) moved the bench onto the W2b outcome shape: the
     `double_walkover` arm in `PackExpectedOutcome` and the claim kinds, one shared `packMethodOf` (a pack's
     `award.method` compares against the engine's `award.reason`), `suite11`'s walkover as a lone `core.forfeit` with
     no `core.start`, and `_tiny` `retired hurt` → `retired`. Bench vitest went from 1613/1840 to 1909/1909. The pack
     `method` stays a free string (narrowing it would not be additive under the bench `_RULES.md` §4 freeze). The PR
     body must flag both additive PackSchema changes for the owner, as §4 requires. The owner's permission covers the
     R3-protected `run-suite.ts` / `PackSchema` edits for this fix only.
108. **A credited result pays the table points of its credited score** (2026-10-11, owner "A"). This confirms the
     orchestrator's reading of X-WO-1, which the W2b T15 cross-check surfaced: the engine paid every award the
     clean-sweep pair, while the reference paid the credited score. A volleyball side that retires, is disqualified or
     withdraws after the start at two sets all is credited a 3-2 loss and takes that score's points (FIVB 6.4.3: the
     incomplete team keeps its sets; FIVB table 2/1). A walkover credited 3-0 pays 3/0, and a bye still pays the
     clean-sweep pair. One rule for every credited result, with no offender-gets-0 exception. Engine fix 570f53890.
     Amended by ruling 182 (W2d D6, 2026-10-20): a sport may declare a loss-not-played value; table tennis declares 0.

109. **MD-1 in W2b covers W2b's own lines only** (2026-10-11, owner "B"). MD-1 is f-w2's owner-approved survivor
     classification; PR #934 adds its text, and it was put to this owner separately (class 17). W2b runs Stryker
     `--mutate` with line ranges limited to the lines W2b added or changed in engine files, never group=all locally.
     It classifies each Survived/NoCoverage mutant there: A-real gets a test, A-msg gets one line, B-equivalent goes
     into `stryker-equivalent.json`, C-dead needs a caller search. The PR body carries per-file counts and the score
     before and after. Older survivors in the same files belong to W2e. The owner also approved ("yes") that W2b excludes the `arbitraryEvent` test-data generators in its engine files from mutation.
110. **The console's forfeit dialog is the only place an organiser records a forfeit** (2026-10-11, owner "Ok" to
     recommendation C). This amends spec §5.5 "Pad". The chess pad dock loses its old `forfeit` / `double_forfeit`
     result methods and gains NO Forfeit or Double-forfeit tile. A tile would duplicate the dialog's phase,
     `feedsNextMatch` and cascade-only rules, and it would need an exception to the pad's `filterTilesByBand`
     rule (D-12). Forfeits are organiser-only (X-RS-3), and organisers already have the console. Open follow-up: if
     the chess pad has no one-step route to that fixture's console, W2b adds a link rather than tiles. Closed in
     review: the console's Forfeit is one tap away on the same fixture page, so no link is owed.
111. **A player cannot withdraw themselves once the tournament has started. W5 builds it** (2026-10-11, owner "A but
     after match tournament started, player can't withdraw"). This was found in the W2b T12 review (G-2) and also
     exists on main.
     - **The gap:** a player's registration self-withdraw (`withdrawRegistrationPublic`/`ByRef` → `withdrawCore`)
       sets `status='withdrawn'` and never runs the withdrawal cascade, and nothing checks the division phase. The
       player's held or pending lines then stay as they are.
     - **The knock-on:** the organiser's Withdraw on that player is refused 409 "already withdrawn". The only way
       out is Reinstate, then Withdraw.
     - **The rule:** after the start, the self-withdraw is refused and the player is told to contact the organiser.
       The organiser's Withdraw (with its cascade) is the only departure route mid-event.
     - **Owner of the work:** W5, with RB2A-16, the DQ cascade. W2b changes nothing.
     - **For W5 to pin and put to the owner:** what "started" means. My reading is that the first fixture of the
       division has started or been scored, not merely that fixtures exist.
112. **A walkover stays recordable after Start until something is played** (2026-10-11, owner "fix it", given after
     my recommendation C). Found by the Task 17 pre-ship read.
     - **What is stored:** the only real walkover on production (fixture 069dbf22…) and the active one on staging
       (seazn_club, d26fca49…, football) are both `core.start` → `core.forfeit{walkover}`. The organiser pressed Start
       and the opponent did not show.
     - **The defect:** under X-RS-1 as written, the W2b phase guard refuses that stream on every fold. A probe on the
       WT engine got FORFEIT_REASON_WRONG_PHASE. Both stored matches would fail to load after the deploy, and the
       console dialog would offer no walkover after Start.
     - **The rule:** for a walkover (and a double walkover), the phase reads "pre" while no sport (module-owned) event
       is active after `core.start`. Kernel admin events do not count as play.
     - **Unchanged:** once anything is played, a walkover is refused as before, and chess keeps its wider
       `walkoverPhases`.
     - **Amends** X-RS-1 and spec Appendix A, and is built in W2b. No data migration is needed.
     - **False premise:** the early pre-ship read and the first Task 17 staging read used the stale `public` schema.
       The app's schema is `seazn_club`.
113. **Nothing played means not started, for every forfeit reason** (2026-10-11, owner "Ok A"). This extends ruling 112
     from the walkover to every reason. "Played" is ruling 112's test: an active sport (module-owned) event after
     `core.start`.
     - **The rule:** after Start with nothing played, the match counts as not started.
       - A walkover and a double walkover are admitted (ruling 112).
       - A withdrawal is admitted and credits the walkover score.
       - A disqualification stays admitted, because misconduct before play is real.
       - A retirement is NOT admitted until something has been played: nobody retires from a match never played.
     - **Supersedes** PF-7's "after start → retirement credit" for that state. This settles the X-WD-6 wording.
     - **Why:** before this ruling a no-show tapped as Retired read "ret." and "stopped during the match", counted as
       played in player stats, and in volleyball Best of 1 was credited 15-0 against the walkover's 25-0. The
       credit half of that is fixed as R112-I-1.
     - **No stored row changes:** production's only forfeit is a walkover.
     - **Amends** X-RS-1, X-RT-1 and X-WD-6. Built in the ruling-112 lane.
114. **Any sport event after Start counts as "played", scoring or not** (2026-10-11, owner "A"). This keeps ruling 112's
     test exactly as built: `playRecorded` counts any active module-owned event after `core.start`.
     - **Edges accepted:** a rain delay before the first ball (`cricket.interruption`), a sanction or warning in
       tennis and the set sports, a card or sin-bin before kick-off (football), or a suspension before face-off
       (hockey) all count as play. A no-show after one of them is not offered a walkover.
     - **Workaround:** take the event back (void it), then record the walkover.
     - **Rejected:** deriving "played" from a score change, as an engine change late in the wave. Reopen it as its
       own small change if a real organiser hits the edge.
115. **A disqualification with nothing played is treated like a walkover** (2026-10-12, owner "A"). The question was
     whether a disqualification recorded before anything is played counts as a match played in player stats. Option A,
     as put to the owner: "doesn't count — treated like a walkover. It also scores like a walkover, which is how it's
     built now."
     - **Covers** a disqualification after a Start with nothing played (ruling 112's test, widened by ruling 114).
       Correction (2026-10-12, controller): X-RS-1 already refuses a disqualification before `core.start`. The first
       version of this ruling also named that case, which cannot arise.
     - **Credit:** the sport's walkover credit.
     - **Stats:** it does not count as a match played for either side's players, and it credits no personal W/L.
       This is the same as X-PS-1.
     - **Unchanged:** once something is played, a disqualification counts as in-match. X-PS-2 applies, and the
       score already played stays credited.
     - **Why:** one rule everywhere ("nothing played means not started", ruling 113). A player's record never shows
       a match nobody played, and the stats do not depend on whether the organiser pressed Start before recording
       the no-show.
     - **Amends** X-PS-1, X-PS-2 and X-RT-1, and closes the "pending owner ruling (DQ with nothing played)" clauses.
116. **A withdrawn knockout winner's next tie reads as a walkover, naming who withdrew** (2026-10-12, owner "A",
     given after my recommendation A). Found in the Task 16 truth run (R16-5 Q1).
     - **What happened before:** the tie was stored as `{award, reason:"bye"}` with no loser. Every surface read
       "Bye":
       - schedule: "Ended · Bye · Team 4";
       - bracket: "Bye · Team 4 · TBD";
       - match page: "Bye vs Team 4 — (Forfeited)".
       
       That contradicts X-WD-3 ("advances by walkover"), and no surface said that a side had withdrawn.
     - **The rule:** that tie reads "w/o" and names the withdrawn side, like any other walkover, on the schedule,
       the bracket and the match page.
     - **Still holds:** the withdrawn side is still never seated in the next round, so the seat stays dead
       (X-WD-3/X-WD-5).
     - **Scope:** only this case, in W2b. The bracket's "TBD" on finished bye tiles stays with W4, with the rest of the
       bye and vacant copy family. So does the SF2 void copy (R16-5 Q2), which follows owner ruling C2 of
       2026-09-21.
117. **The owner confirms the R16-3 abandon ruling and the W4 handoffs** (2026-10-12, owner "Ok, confirm", given
     after the status list that set out both). Both were controller rulings and are now owner-confirmed.
     - **R16-3:** under abandonPolicy award, a level abandon in a sport/cfg with draws off is accepted with no result.
       It stays out of the table and is flagged for the organiser to settle or replay (X-AB-1); it is never refused
       and never forced to a draw.
       - The cfgs: icehockey/iihf, including the icehockey default, and hockey/fih-shootout.
       - In draw kinds it is still a draw with the real score (FB-AB-1).
       - This qualifies HK-AB-1 and IH-AB-1, and their rule rows record it. FB-AB-1 is not amended: football always
         admits a draw, and its row already covers brackets (T16 round-2 review).
     - **Handed to W4:**
       - the bye and vacant-final copy family, which includes the SF2 void copy (R16-5 Q2) and "final after a semi DW
         shows bye copy";
       - the vacant-final Generate 500 (MB-004/005);
       - "TBD" printed on finished bye tiles.
118. **In chess, Start means play has begun** (2026-10-12, owner "A", given after my recommendation A). Found while
     checking the ECF 2026 English Championships rules (Section G: a ringing phone forfeits the game).
     - **What it fixes:** Seazn records no chess moves, so under rulings 113 and 115 a chess game in progress always
       read "nothing played".
       - The organiser could not record a retirement.
       - A forfeit during the game scored as a walkover.
       - The game did not count in either player's stats.
     - **The rule (chess only):** after `core.start`, a retirement or a disqualification counts as a game played.
       It carries the result, and both players' stats count it (X-PS-2).
     - **No-shows:** they are still recorded as a walkover. Chess already admits a walkover after Start (its wider
       `walkoverPhases`, FIDE 6.7.1). The reason the organiser picks is what tells "never arrived" (walkover) apart
       from "forfeited during the game" (disqualified or retired).
     - **Other sports:** unchanged. "Nothing played means not started" (rulings 113–115) still holds.
     - **Owner scoping in the same message:** Seazn needs no player ratings, because the seed number serves, and no
       shared places. The ECF gap list drops ratings, TPR, the performance prize, shared places and the 90/10 split.
       Its remaining candidates for a later wave are: requested zero-point byes, a per-event default time, the
       playoff game sequences (two-game rounds, the sudden-death bid, the coin toss), a public time-control display,
       and fee and refund tiers.
119. **The chess playoff series gets its own wave, after W2c and after the chess in-page programme** (2026-10-12,
     owner "A, along side after @chess program?", given after my recommendation A).
     - **What it covers:**
       - ECF 2026 Section C: two-game playoff rounds, the faster rounds after that, the sudden-death game with its
         time bid, and the coin toss.
       - The other ECF candidates from ruling 118: requested zero-point byes and a per-event default time.
     - **Shape**, as recommended by the chess session and not yet ruled: one ordinary fixture per game, grouped under
       a series with an aggregate. The series generates each round's games with the colours reversed, then ends or
       generates the next round. The sudden-death bid is entered in the organiser console, because Lichess may not
       support unequal clocks (unverified).
     - **Owner of the work:** a new wave with its own spec, which goes to the owner before anything is built. W2c
       (colours) and the chess in-page programme (feat/chess-lichess-external-play) finish first. The chess
       programme's only part is a time control per fixture or per round for online games.
     - **W2b:** builds none of it.
120. **An abandon counts as a match played only if something was played** (2026-10-12, owner "A", given after my
     recommendation A). Found in the R115 M3 fix: the stats reader had counted every abandon as a match, including
     one with no result and no score. No signed row covered the case. Example: cricket started, then rain before the
     first ball.
     - **The rule:** an abandon counts as a match played in player stats only if `playRecorded` is true before it.
       That is the same test used for forfeits (rulings 112–115): any active sport event after `core.start`, scoring
       or not (ruling 114). In chess, Start itself counts (ruling 118).
     - **Nothing played:** nobody's stats get a match, whatever the abandon's result or settle.
     - **Something played:** X-PS-2 applies, as before.
     - **Why:** one rule everywhere, so a player's record never shows a match nobody played. It also matches cricket,
       where a match abandoned without a ball bowled does not count in players' records.
     - **Amends** X-PS-2 and X-AB-1 (stats clause only). Table and standings treatment is unchanged.
121. **The core scoring rules get rule rows in their own backfill wave, after W2** (2026-10-12, owner "A", given
     after my recommendation A).
     - **The gap:** `packages/engine/rules/` holds about 70 rows, almost all W2 topics (walkover, abandon,
       retirement, withdrawal, double walkover, knockout tie-break). The core scoring rules live only as prose, in
       11 `DOMAIN.md` files of about 1,700 lines, so nothing fails when one of them stops being proved. That prose
       covers:
       - tennis games, sets and tie-breaks;
       - serve and rotation;
       - set targets and win-by;
       - cricket overs, innings and DLS;
       - periods, extra time and shoot-outs;
       - carrom boards;
       - chess result methods.
     - **The wave:** turn each sport's `DOMAIN.md` rules into rows, one sport at a time, in the format of
       `rules/README.md`.
       - Link each row to the tests that already prove it.
       - Write a test only where none exists. Each such gap is a finding, recorded as found.
       - Expected size: a few hundred rows.
     - **Sequencing:** after W2 merges. It may run in parallel with W3, because it mostly writes docs and tests, not
       product code. It also underpins the single-reader build guards the owner approved on 2026-10-12.
     - **W2b:** adds no backfill rows.
122. **A team match counts on a person's career record only for players: the recorded lineup, or the roster when no
     lineup was recorded** (2026-10-12, owner "B", given after my recommendation B).
     - **How it was found:** the reviewer of 30284f140 found that the career count credits every `entrant_members` row,
       so a volleyball coach, and a member added after the fixture, were each listed with 1 match. The count had
       always done this; 30284f140 made the listing agree with it, so the defect became visible. `entrant_members`
       has no join date. It does have `roles` (player / coach / staff).
     - **The rule:**
       - A person gets a match only with the player role. Coach and staff never get one.
       - If the fixture has a recorded lineup, only people in it get the match.
       - If no lineup was recorded, the roster's players get it.
       - Individual-entrant sports are unchanged.
     - **Known residue, accepted:** a player added to the roster after a fixture with no lineup is still credited,
       because no join date is stored. A full appearance rule per sport (starters and the substitutes who came on)
       and join dates belong to the ruling-121 backfill wave or later.
     - **Implementation:** one reader, shared by the career count and the listing. It follows `careerMatchesByDivision`.
     - **Built (correcting this ruling's premise):** `entrant_members.roles` holds position roles, not player/coach/staff.
       "Player role" therefore means two things:
       - on a recorded lineup, `lineups.role = 'player'`;
       - with no lineup, `persons.lane = 'player'`.
       The rule lives once, in `apps/web/src/server/appearances.ts`. A source scan
       (`appearance-rule-one-reader.test.ts`) keeps it there. Bench rows follow the owner's 2026-09-16 bench rule
       (`benchRowIsAppearance`) in the count as well as the lines.
     - **Second residue, the mirror of the first:** a player removed from the roster loses credit for earlier
       matches that had no lineup. The cause is the same (no join or leave dates), and so is the later wave.
     - **/me "Recent results":** still lists a team's results to its coach. That is a team feed, not match credit,
       and is exempt from the scan with a reason.
123. **The lineup decides, not the person's lane** (2026-10-12, owner "A", given after my recommendation A).
     - **The case:** a person whose lane is coach is named as a player on a match lineup. They get the match. The
       reverse also holds: a lane-player named as coach on a lineup gets nothing.
     - **Why:** the lineup is the organiser's record of who took part, and player-coaches are real in grassroots
       sport.
     - **Known risk, not a stats rule:** the lineup editor defaults every row to player, so a coach added without a
       role change is credited. A later wording or default change to the editor may address it.

124. **A generic retiree or DQ keeps the real score only if it is worse for the offender** (2026-10-13, owner "A",
     Loop R Q1). Otherwise the walkover credit applies, the same rule as football.
     - **Amends:** GN-RT-1. Built in `f700211ca`; `genericForfeitCredit` calls football's own `goalCredit`.
125. **CK-WO-2 is signed as built** (2026-10-13, owner "A", Loop R Q2). An unlimited-overs cricket walkover credits
     the result and the table points only: no runs, no overs, and it is out of NRR.
126. **A double walkover counts as a match served for a suspended entrant** (2026-10-13, owner "A", Loop R Q3). Built
     in `a57c584ad`; the guard is `status === "forfeited"` at `discipline.ts`, read off the stored outcome, so a
     voided double walkover serves nothing.
127. **A withdrawal after recorded play counts in player stats, with no personal W/L** (2026-10-13, owner "A", Loop R
     Q4). Appearances and keeper stats count; the personal win/loss does not. A withdrawal before play, after a bare
     Start, or after play that was voided away is not a match. In chess a withdrawal after Start counts (rulings 118
     and 127).
     - **Amends:** X-PS-1. Built in `48e8bd5b8`; `STATS_FOLD_VERSION` is 6, so stored snapshots refold.
128. **FB-AB-1 stays as signed** (2026-10-13, owner "A", Loop R Q5). A football Start-then-abandon at 0-0 with nothing
     recorded, under the award policy, is a 0-0 draw with 1 point each, and is not a match in player stats. No code
     change.
     - **Controller rulings made in Loop R (not owner questions):** M-4 (both entrants gone in a table stage records a
       double walkover) was a defect against signed ruling 90 and was fixed; I-1 (the pre-W2b stored walkover shape)
       is read by tolerance with no data rewrite; the stale-BYE race of a double-walkover void against the
       withdrawal cascade is parked for W9 (ruling 101).
129. **W2c rule rows signed** (2026-10-13, owner "sign all", P-6): X-SR-1..7, X-PT-1, BG-KO-1 (amended), BG-KO-2
     (amended), BG-KO-3, CK-SO-1, HK-AB-2, CA-AB-2, GN-AB-2 (with the P-5 sentence), IH-KO-1, FB-SO-1, as worded in the
     W2c plan Appendix A (`docs/superpowers/plans/2026-10-13-format-matrix-w2c.md`). Written to
     `packages/engine/rules/` in W2c Task 3; each cites `signed 129 2026-10-13`.
130. **Swiss abandon is settled by the organiser** (2026-10-13, owner P-7 "Ok A,"; rule row signed "sign"):
     **X-AB-5** "An abandoned match in a Swiss stage holds the next round until the organiser settles it." Found by the
     chess session on main (`stages.ts` DECIDED omits `abandoned` → STAGE_NOT_READY; settle refused SETTLE_NOT_APPLICABLE).
     Built in W2c Task 7; the row is written at the batch-3 proof commit, citing `signed 130 2026-10-13`.
131. **Engine repo split: cut over after W2e** (2026-10-13, owner "cutover be after W2e"). `packages/engine` moves to
     its own repo (GitHub Packages; Stryker moves with it) once W2 is complete — W2c, W2d and W2e stay in the monorepo.
     Repo name **`onryde/seazn.club.engine`** (owner "repo name seazn.club.engine"). Engine repo is **public for now** (owner "public for now", same day), so GitHub-hosted Actions stay free; the split's
     spec and plan start now (owner "start"), docs only, in their own session.
     Prep: `.superpowers/handoff/2026-10-08-w1d-close/` (split prompt, per-wave engine/web map, runner research).
     Rule rows: none (sequencing).

132. **The chess tie-break list is an ordered menu** (2026-10-14, owner "2 Ok"). BG-KO-1 says a drawn game goes to the
     stage's rungs "in order". The engine cannot enforce that order: rapid and blitz events always carry a winner and an
     Armageddon always decides, so it never learns a rung ended level, and enforcing would accept only the first rung.
     The pad offers the rungs in the organiser's order; the engine refuses a rung NOT in the list, not one out of order.
     A "rung ended level" fact (event schema + goldens + pad + matrix) was offered and not taken.
     Rule rows: BG-KO-1 citation amended.
133. **"Share the points" on an abandon is a table stage's** (2026-10-14, owner "3. Ok"). In a bracket stage the
     `share` policy is ignored and the abandon is held for the organiser to settle (W2a ruling 72), never refused or
     drawn (W2c Task 7 fix round, I3).
     Rule rows: GN-AB-2 and CA-AB-2 re-worded "in a table stage … in a knockout the abandon is held for the organiser to
     settle".
134. **Run-sheet filters hiding untimed held rows go to the competition desk** (2026-10-14, owner "4 Ok"). Pre-existing:
     "Today" and "Needs result" never show an untimed held row. Owed in
     `docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md`.
     Rule rows: none.

135. **P-1 "A": the rules version** (2026-10-13, owner "A" to the plan review; fixes review C1 and C2). A new column
     `fixtures.rules_version int not null default 0`, in the same migration as `rules_override`. Only a correction or
     a staff re-freeze (`refreezeFixture`) increments it. The server checks it only when the sender includes it, and
     only the two scoring pads send it (the console pad and the remote pad). A stale version is refused
     `409 FIXTURE_RULES_CHANGED` before any write, and the pad reloads its rules and says so. The console's own
     actions, the americano panel and the server's own writers (withdrawal, finalize, import) never send it and are
     never blocked. Plan §"Owner answers and open questions", D14; rule row X-SR-7. Widened in execution (controller
     rulings below; ruling 144).
136. **P-2 "A": division locks** (2026-10-13, owner "A"; was OQ-1). The `patchDivision` config lock loosens from "any
     fixture exists" to "a stage that inherits the key has started", refused by name (`DIVISION_FORMAT_LOCKED`,
     `DIVISION_TABLE_RULES_LOCKED`) while the rest of the save lands. The `tiebreakers` column gains the lock.
     `replaceStages`' `FORMAT_LOCKED` is untouched. Includes review I1 (the final config is re-parsed after refused keys
     are restored, and a refused variant drops its preset keys) and I2 (the two old lock pins). D11; X-SR-4.
137. **P-3 "A": a stage-points forfeit is an award with nothing played** (2026-10-13, owner "A"; was OQ-2, reworded per
     review I7). Whatever its reason (a walkover, or a withdrawal or disqualification before play). It is decided by
     W2b's `playRecorded` over the fixture's `score_events` (rulings 112–115, 118, 120), the one predicate. After play,
     normal points. A bye keeps its points but never gets `awardScore`, and `awardScore` replaces the credit. The public
     qualification calculator (`qualification-view.ts`) follows, with a parity test. X-PT-1.
138. **P-4 "A": a correction that would end the match is refused** (2026-10-13, owner "A"; was OQ-3).
     `FORMAT_DOES_NOT_FIT_PLAY`, "This format would end the match as it stands." Proved on real ledgers (Task 14).
     X-SR-5.
139. **P-5 "A": sharing the points needs draws** (2026-10-13, owner "A" on the plan re-review; was OQ-4, plan finding
     34). `abandonPolicy: "share"` with `allowDraws: false` is refused `CONFIG_INVALID`, "Sharing the points needs
     draws to be allowed.", on every config save (`patchDivision`, `putStageRules`, `createStages`), and the stage form
     shows the option unavailable with the same reason. Carrom has no `allowDraws`; its analogue is a controller ruling
     (below). GN-AB-2 carries the sentence (ruling 129).
140. **W2c execution: "A Sonnet with those 4 tasks on Opus"** (2026-10-13, owner, verbatim). A W2c-only exception to
     the Opus minimum, recorded in `docs/superpowers/RULES.md` § Agent topology. Ordinary tasks run on
     `implementer-sonnet` and `reviewer-sonnet`. Four pieces of work run on the Opus `implementer` and `reviewer`: (1)
     the engine `ruleKeys` contract and the resolver change across every caller (Tasks 4, 10, 13b); (2) the correction
     refold (Task 14); (3) the `rules_version` check (Task 15); (4) the stage-points forfeit rule (Task 9). Every batch
     ends with one Opus `reviewer` pass over the batch diff. Plan §Execution.
     - **In execution:** Tasks 12 and 13 went to the Opus implementer in error, and the owner caught it (2026-10-14).
       The owner's "ok continue" kept Opus for Task 13's fix round 2; later dispatches followed the rule. Task 22 was
       finished on Opus when the Sonnet weekly cap ran out (controller ruling, 2026-10-23).
     - The `*-sonnet` agent files outlive W2c (ruling 158).
141. **The W2c plan is approved** (2026-10-13, owner "ok"; plan at `1640326a8`). Plan
     `docs/superpowers/plans/2026-10-13-format-matrix-w2c.md`, with P-1..P-5 applied (spec `1b757c6cb`) and three plan
     review rounds fixed. Its decisions D1–D14 are accepted with it, not ruled one by one ("Recommendations", "For
     W2c"). Plan finding 20 put P-1..P-4 and the execution ruling at the next free numbers in Task 0. They are numbered
     here instead, at the Task 23 fold, after 129–134.
142. **"Keep going and apply any rec and I will check in the morning"** (2026-10-13 night, owner). A standing
     instruction for the overnight run. The controller applied its own recommendations as rulings, tagged "(overnight)"
     in the SDD ledger, and owed the owner a morning summary. It did not cover a merge to main, a push, a PR or a remote
     delete. The open items went back to the owner and came back as rulings 132–134 and the S5 sign-off (ruling 153).
     Later fix rounds cite the same "apply any rec" for applying a reviewer's recommendation.
143. **The engine's golden format change (GF-2) lands first; W2c re-records on its rebase** (2026-10-15, owner "B, and
     rebase after batch 5"). W2c rebased onto main after batch 5, then onto GF-2 and onto the engine's lineup fix (owner
     "rebase" and "rebase again", 2026-10-16). It took main's corpora, re-recorded boardgame `knockoutTiebreak#100008`,
     re-appended its own streams with `EXTEND_GOLDEN=1`, and raises any fold-epoch bump in its own PR (`pnpm
     fold-epoch:check --against origin/main`).
144. **A table-only key save still bumps the rules version** (2026-10-15, owner "approved signed off" to open item O-1).
     A save of a key that neither the fold nor the format line shows (`pointsMap`, `awardScore`) bumps
     `rules_version`, so an open pad is refused once and reloads to an unchanged line. Kept as recommended: rare and
     safe. No code change.
145. **Manual MAJOR fold-epoch bumps for football, hockey, carrom and generic** (2026-10-15, owner "yes"). Their new
     opt-in cfg keys (football `shootoutAttempts`, hockey `abandonPolicy: "q4_stands"`, carrom and generic
     `abandonPolicy: "share"`) would be misfolded by an epoch-1 client, and the guard could not see it. After GF-2 and
     the engine's lineup fix took their own numbers, the epochs are: boardgame, carrom and generic 3; football and
     hockey 2; ice hockey 1. The owner added (2026-10-16): "mobile app yet to build for remote scoring". No native
     client exists, so the bumps cost no user today, and the release note reads "future native clients need epoch ≥
     N". Boardgame's own MAJOR (BG-KO-2 refuses a colourless Armageddon) is a controller ruling. Task 16c appended a
     golden stream per opt-in key so the guard sees the next change.
146. **The chess tie-break rungs read as a plain list** (2026-10-15, owner: no "then", keep as is). The public line
     lists a stage's rungs in their stored order, comma-joined, with no "then", because the engine does not enforce
     the order (ruling 132). No code change.
147. **Merge order: chess before W2c** (2026-10-16, owner "1"; 2026-10-19, owner "1"). Chess's migrations V451–V461
     (#948) merge before W2c's, because Flyway runs no out-of-order migration; if chess slips past W2c's readiness,
     the owner is asked again (the alternative: chess renumbers above W2c). Chess's follow-up PRs (#984 and #985, the
     login-next cap and the scrubber token; #986, the UX follow-up) also merge first, and W2c absorbs them at its
     pre-PR rebase. All of them merged by 2026-10-19. W2c's own migration number is a controller ruling.
148. **"Stop At Task 17 and wait for me"** (2026-10-15, owner), lifted by **"go Task 17"** (2026-10-19, owner).
     Tasks 17–23 waited; the 2026-10-16 rebases ran inside the hold with their own owner go (ruling 143).
149. **The division builder and the division settings are redesigned after the whole of W2** (2026-10-19, owner).
     Until then, W2 tasks keep the existing `division-settings` pattern and add no new layout chrome.
150. **"dont put lots of time in tweaking the ui, we will redesign anyway."** (2026-10-19, owner). Tasks 17–20 are
     correctness first, with a lean frontend-design pass and a lean set of shots. Cosmetic findings are parked, not
     fixed ("Findings routed (W2c)").
151. **"all scoring are free"** (2026-10-19, owner). The database already agreed: V393 gives Community
     `standings.custom_points`. The stage points editor (Task 18) drops its plan-gate state and copy, and a 402 from a
     per-org override shows the server's reason inline. Server enforcement is unchanged.
152. **"dont worry about mobile design as we are going to redesign but try to pass the e2e"** (2026-10-19, owner).
     From Task 18's fix round through Task 20, owner shots are at 1280 only, with no mobile design work.
     `stage-rules-w2c` and `mobile.spec.ts` (whole files, all seven widths) must still be green, and a mobile red is
     fixed in the product, never by weakening the test.
153. **Per-screen sign-offs** (owner's words; the shots stay in gitignored scratch, never committed): the S5 Armageddon
     sheet's design pass "signed off" (2026-10-14); Tasks 15 and 16 "signed off", the retaken deltas "1 signed off" and
     the decider banners "approved signed off" (2026-10-15); Task 16b "signed off" and the forfeit dialog's 0-0/5-0
     preview "sign off" (2026-10-15); Task 17 "approve" (2026-10-19); Task 18's editor and inexpressible states "Ok,
     make sure that works and singed off" (2026-10-19; the condition, an e2e of save, reload, a different save and
     reload paid by a real walkover, was met in its fix round); Tasks 19 and 20 "all signed off" (2026-10-20).
154. **The stryker-sizing re-measure goes to the mutation session** (2026-10-20, owner "ask @mutation to handle
     skyter"). The owner pushed the throwaway branch `chore/w2c-stryker-measure` and dispatched the cold legs. The
     mutation session transcribed the runs (no leg over 200 minutes, so no re-cut), and W2c cherry-picked its data
     commit. MD-1 classification stayed with W2c.
155. **BWF 3×15 goes to a GitHub issue** (2026-10-23, owner "create a github issue"). Issue #1004, "Badminton: BWF 3×15
     scoring variant (effective 2027-01-04): standalone PR or wait for W2e?", is open. W2c builds none of it.
     Closed by rulings 221 and 222 (W2e D1, D2, 2026-10-28): 3×15 ships inside W2e, as the badminton default.
156. **The pinned-key fail-open is a separate security fix** (2026-10-23, owner "Ok", then "merge"). Found in W2c's
     re-review of the batch 16b+16c fix: nothing pinned a key-scopes row's scope or pin, and a wrong pin kind failed
     open (a fixture id looked up as a division resolved to null, so one competition's key read another's rules).
     Fixed off main as PR #1006, merged `5c78df031a`: pinned keys fail closed, and every pinned route is pinned by a
     test. W2c absorbs it at its rebase.
157. **The five declared stage keys with no editor field are parked to W2e** (2026-10-23, owner "Ok", after "I dont
     know"). `carrom:pointsPerCoin`, `cricket:minOversForResult`, `cricket:superOverStillTied`,
     `football:concussionSubs`, `football:rollingSubs` (Task 17 review M-8). `superOverStillTied` feeds `canEndLevel`
     and cannot be set in the UI. The W2c PR body lists them under "Deferred to W2e".
     Closed by ruling 225 (W2e D5, 2026-10-28): all five are plain stage-rules editor fields, and the ratchet is at zero.
158. **The `*-sonnet` agent files stay after W2c** (2026-10-23, owner "Ok"). `.claude/agents/implementer-sonnet.md` and
     `.claude/agents/reviewer-sonnet.md` are kept (the engine split uses them too). Plan Task 23 Step 8's delete is
     cancelled.
159. **"rebase and pr when ready" and "merge if all green"** (2026-10-23, owner). A standing go for Task 23's rebase,
     PR and merge, on condition that every gate is green: the scoped vitest, a clean final review, the PR's CI checks,
     a dispatched e2e run and smoke. Earlier, "yes push" (2026-10-20) approved the branch's first push.
160. **Stage points ship; a rule the stage `PointsRule` cannot express is refused** (2026-10-12, owner "A", relayed
     verbatim by the W2b session; W2c-Q1). ST-G8's stage points screen ships. A rule `PointsRule` cannot express (for
     example ice hockey 3-2-1-0) is refused at the screen and at the API with a clear reason
     (`POINTS_RULE_INEXPRESSIBLE`). W2d widens `PointsRule` and lifts the refusal. Lifted by ruling 180 (W2d D4):
     `PointsRule` is outcome-keyed and `POINTS_RULE_INEXPRESSIBLE` is retired.
     `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §2.1 (10), §7.
161. **A fixture-level match-format override** (2026-10-12, owner "A", relayed; W2c-Q2). New `fixtures.rules_override`
     jsonb: a match-format fragment under a per-sport allowlist. Resolution runs division → stage → bracket deciders →
     fixture override and is frozen into `config_snapshot` at the first event. `resolveFixtureCfg` takes the fixture
     row, so the compiler forces every caller. An edit after the snapshot is refused by name. Amended by Q11 (ruling
     170) and P-1 (ruling 135). X-SR-2. `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §2.1 (2),
     §4.3, §4.4.
162. **A division's table rules lock per started stage** (2026-10-12, owner "A", relayed; W2c-Q3). A division save
     refuses the points and tie-break fields by name once a stage that uses them has a started fixture ("{stage} has
     started — table rules are locked.", `DIVISION_TABLE_RULES_LOCKED`). Other fields still save. No organiser
     override. The staff re-snapshot path stays. Built as P-2 (ruling 136). X-SR-4. Loosened by ruling 185 (W2d D9):
     a started stage keeps the rules pinned at its start, so the lock now covers only `scoring` and `awardScore`.
     `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §2.1 (4), §4.5, §7.
163. **A division's match format locks per started inheriting stage** (2026-10-12, owner "B" and "also C in future",
     relayed; W2c-Q4). A division match-format edit is refused by name once an inheriting stage has started ("{stage}
     has started; its match format is locked. Change individual unstarted matches instead.",
     `DIVISION_FORMAT_LOCKED`). Unstarted stages change through their own stage rules. One validated writer,
     `writeFixtureRulesOverride(fixtureIds[], fragment)`: per-sport allowlist, a started fixture refused by name,
     all-or-nothing. C, a bulk "apply to all unstarted matches in this stage" that reuses the writer unchanged, is
     owner-planned for the competition-desk programme ("Competition-desk, ok"); running late is the commonest reason
     for the edit Q4 refuses. Built as P-2 (ruling 136). X-SR-4.
     `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §2.1 (4), §2.2, §4.5, §7.
164. **Which keys a stage and a match may set** (2026-10-12, owner "Ok all 3 group", relayed; W2c-Q5). Group 1, per
     stage and per match: `bestOf`, `setTo`, `finalSetTo`, `finalSet`, `setType`, `gameTo`, `cap`, `winBy`,
     `tiebreakWinBy`, `noAd`, `halfMinutes`, `quarterMinutes`, `periodMinutes`, `overtimeMinutes`, `shootoutAttempts`,
     `overs`, `maxOversPerBowler`, `maxBoards`, and `extraTime` (per match only off or shorter). Group 2, per stage
     only: `allowDraws`, `shootout`, `superOver`, `overtime`, `dls`, `tieBoard`, `variant`, `resultMode`, `teamSize`,
     `playersPerSide`, `maxSubs`, `subWindows`, `sinBinMinutes`, `overtimeSkaters`, `queenFollowsBoard`, `queenCapAt`,
     `queenPoints` and the chess clock (over the board: per stage only). Group 3: `shootoutWin`/`shootoutLoss` through
     the stage points screen. The list is pinned against each engine schema and a key that moves goes to the owner
     (five keys parked to W2e, ruling 157). X-SR-1, X-SR-2. Group 3 is superseded by ruling 186 (W2d D10(e)): the
     keys are gone, and a shoot-out pays through the outcome-keyed rule (ruling 189).
     `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §4.1.
165. **Chess rungs per stage and Armageddon colours; games per match re-routed** (2026-10-12, owner "A", relayed;
     W2c-Q6). W2c builds a per-stage tie-break rung setting (which rungs, in what order; stage only) and records
     Armageddon colours (who had Black; the engine enforces BG-KO-2), replacing the hint. "Games per match" is
     re-routed by the owner from W2c (ruling 73) to the ruling-119 series wave. The rung list is an ordered menu
     (ruling 132). BG-KO-2, BG-KO-3. `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §2.1 (13), §2.2.
166. **A new knockout stage preselects its sport's deciders; all off is allowed** (2026-10-13, owner "Ok B"; W2c-Q7).
     Football extra time 2×15 and penalties, hockey a shoot-out (5), ice hockey 10' overtime and a shootout. All off is
     allowed, with the notice "Level matches in this stage will wait for your decision (lot, seed or your call)."
     Amends ruling 74's creation refusal; a level result is held `needs_decision` (ruling 79). X-SR-6, IH-KO-1.
     `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §2.1 (6), §3, §4.2.
167. **Cricket super over per stage** (2026-10-13, owner "A"; W2c-Q8). Stage only (group 2). A new knockout stage
     preselects `superOver` on; league and group stages off (the tie stands). Switched on in a league, it is played on
     every tie (the ICC model). The false help "Knockout fixtures only." is replaced. CK-SO-1.
     `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §2.1 (7), §4.2.
168. **Under a stage points rule only a walkover pays forfeit points** (2026-10-13, owner "A"; W2b Loop R M-1;
     W2c-Q9). `awardScore` replaces the credited score, never adds to it. A retirement, disqualification or withdrawal
     after play earns normal win/loss points and bonuses on the real score (ruling 124). This edits
     `competition/points.ts`, so W2c classifies that file's survivors (the MD-1 (f) consequence, stated to the owner).
     Reworded by P-3 (ruling 137): a forfeit is an award with nothing played, whatever its reason. X-PT-1.
     `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §2.1 (11), §10.
169. **One stage-only "If a match is abandoned" setting** (2026-10-13, owner "A"; W2c-Q10). Filtered by sport: Replay
     (the default everywhere); Result stands (football and ice hockey, today's award); Result stands from Q4, else
     replay (hockey, preset in `fih-shootout`; a level Q4 abandon in a no-draw cfg is no result, ruling 117); Share the
     points (carrom and generic, opt-in). Amended by P-5 (ruling 139) and ruling 133 (sharing is a table stage's).
     HK-AB-2, CA-AB-2, GN-AB-2. `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §2.1 (12), §5.1.
170. **The organiser may correct a started match's format** (2026-10-13, owner "A"; W2c-Q11; amends Q2). A live or
     held match (not finalized or cancelled) may have its group-1 format corrected. The server refolds the recorded
     events under the corrected cfg and refuses with the reason when the play does not fit (`FORMAT_DOES_NOT_FIT_PLAY`,
     e.g. "2 sets already played"). Audited (who, when, before, after). It reuses `writeFixtureRulesOverride` plus the
     refold check, then re-freezes the snapshot. The staff re-snapshot hatch stays, for finalized matches only (reopen
     first). Why: the only support channel is a mailto link, too slow mid-event, and the Q3/Q4 locks left the staff
     hatch useless as it was. Open pads follow a correction (P-1, ruling 135); a correction that would end the match is
     refused (P-4, ruling 138). X-SR-5, X-SR-7. `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §2.1
     (3), §4.5, §7.
171. **Stage rules inline on the stage card** (2026-10-13, owner "A"; W2c-S1). The stage card's Format row: a summary
     line, and "Edit rules" expands in place into Match format · Deciders · If abandoned · Points. Each field is
     labelled Division or This stage; "Use division rules" resets. One DOM; sections stack on a phone.
     `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §5.3.
172. **A match's rules on the fixture console** (2026-10-13, owner "A"; W2c-S2). A "Match rules" block: summary and a
     "Changed for this match" tag; match-scoped fields only, labelled Stage or This match; "Use stage rules". On a live
     or held match the action reads "Correct format" with a one-line warning (Q11). The division fixtures list shows a
     "Format changed" tag. `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §5.3.
173. **Stage points as sentences** (2026-10-13, owner "A"; W2c-S3). Inside the stage rules' Points section, table
     stages only: a live preview line; "A win earns [ ] · a draw [ ] · a loss [ ]"; a walkover (nothing played)
     sentence with an optional score; a note that retirement, DQ or withdrawal after play earns normal points; bonus
     rows filtered to the sport's metrics. A phone folds walkover and bonuses under "More". An inexpressible rule shows
     the refusal card and the stage keeps the division's points (Q1).
     `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §5.3.
174. **Locks say it before they try** (2026-10-13, owner "A"; W2c-S4). A locked section renders read-only with one
     lock line naming the started stage and what to do instead (a link to the fixtures); the other fields stay
     editable; the server refusal is the backstop with the same words. The same pattern on a started stage (S1) and a
     finalized match (S2). `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §5.3.
175. **The Armageddon pad records the facts and the engine decides** (2026-10-13, owner "A"; W2c-S5). The tie-break
     sheet's rung step offers the stage's rungs in order; for Armageddon, "Who had Black?" → "Result?" (White won /
     Black won / Drawn) → a confirm line ("Advances: X — Black, Armageddon drawn"). The engine applies BG-KO-2; a draw
     is kept as a fact; the colour is on the tie-break event only. Rapid and blitz are unchanged. BG-KO-2.
     `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §5.3.
176. **Rules extend per sport, stage kind and variant; the rule facts live in the engine** (2026-10-13, owner "yes"
     to the §1 architecture with this amendment, then "approve" to amendment 2; W2c-§1). Each rule key declares its
     scope (match, stage or points) and where it applies (stage kinds, engine variants), so rules for stages and
     matches extend per sport, format and variant. Amendment 2: those facts are the engine sport modules' `ruleKeys`,
     with derived `stageKeysFor`/`fixtureKeysFor`, because the engine moves to its own repo after W2; web keeps
     presentation only. With it, the owner's "Ok" to the plan structure: web `lib/match-rules` split per sport as a
     pure move, one contract test per side, and no engine restructure in W2c. X-SR-1.
     `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md` §4.1.
177. **All scoring is free; the W2d UI is correctness-first** (2026-10-20, owner, session f-w2d, W2d-Q1 → D1). The UI
     keeps the existing pattern, signed off at 1280 with e2e at all seven widths. W2c merges first. A migration takes
     main's maximum plus one at the rebase and whoever lands second renumbers (W2d's went V472 → V474 → V475).
     `docs/superpowers/specs/2026-10-20-format-matrix-w2d-design.md` §3 (D1).
178. **"All stages are free" is its own PR** (2026-10-20, owner, Q1+/Q2 → D2). Option 2, branch `feat/all-stages-free`
     (#1005, V471), not W2d. W2d spec §3 (D2).
179. **The tie-break order is per stage** (2026-10-20, owner, Q3 → D3). It inherits division → sport default. A plain
     editor in the settings pattern (ordered list, reorder or remove, reset to default, Inherited/Overridden badge);
     `validateCascade` refuses on save a criterion the sport or the stage cannot evaluate (goal difference in chess,
     head-to-head on a cross-group table). A stage's order locks once any of its fixtures has a score (the shape of
     ruling 162), and the stage order replaces the hard-coded cross-group order. X-TB-1, X-TB-5, X-TB-7.
     W2d spec §3 (D3), §5.
180. **A structured "decided in" on every result, and outcome-keyed points** (2026-10-20, owner, Q4 → D4). Regulation,
     overtime or shoot-out, DERIVED at standings time from the recorded events: one authority and no stored column, so
     finished matches need no backfill and B1 (ruling 188) keeps tables still. Each sport declares its reachable set;
     `PointsRule` widens to outcome-keyed payouts (W/D/L × decided-in, plus cricket tie and no result), and a sport
     shows only its reachable outcomes. `POINTS_RULE_INEXPRESSIBLE` is retired (SC-P10), lifting ruling 160's refusal as
     160 said W2d would. X-PT-2. W2d spec §3 (D4 and its note), §5.3.
181. **The per-sport points and default cascades** (2026-10-20, owner "SIGNED", Q5 → D5). The table of W2d spec §5.10.
     Every cascade ends in a STORED lots draw (Swiss exempt, ruling 193). The new defaults apply to every division with
     no per-division snapshot (overriding RB2A-2's "new divisions only") but reach only stages not yet active, because
     B1 pins every active or complete stage. Each departure from a federation rule has a `deviation` row (ruling 197).
     X-TB-3, X-TB-4 and the per-sport rows of Appendix A. W2d spec §3 (D5), §5.10, Appendix A.
182. **Ruling 108 amended: a sport may declare a loss-not-played value** (2026-10-20, owner, Q6 → D6). The amended text:
     "A credited result pays the table points of its credited score. The exception: a sport may declare a
     *loss-not-played* value, and then the side that loses an award (walkover, retirement, default, disqualification
     or withdrawal; never a bye, which has no loser) is paid that value instead. The winner is still paid its credited
     score's points. Table tennis declares 0 (ITTF 3.7.5.1). No other sport declares one." W2b's "one rule for every
     credited result, with no offender-gets-0 exception" stays true for every sport except table tennis. X-WO-1 (its
     row carries this ruling), TT-PT-1. W2d spec §3 (D6).
183. **ST-G4, ST-G12 and ST-G13 move from W5 to W2d** (2026-10-20, owner, Q7 → D7): the cross-group best-Nth
     comparison, the IIHF partial-schedule order, and the residual seed → UUID order, replaced by stored lots. Swiss
     cascades and pairing stay W3. W2d's stored lots draw is the base W3 builds on (ruling 70). The W5 prompt is
     amended (`W5-round-robin.md`, W2d Task 21); design §8's W5 row and this file's generated backlog rows are not, see
     "False premises found (W2d)" item 21. X-TB-7, X-TB-8, IH-TB-2, X-TB-4. W2d spec §3 (D7), §12.3.
184. **Fair play only in football** (2026-10-20, owner, Q8 → D8). The FIFA scale is already built (metric
     `fair_play`). W2d offers `fair_play` only in football; `validateCascade` refuses it for any other sport, and for
     football when the `fairPlay` cfg is off. No new scales. FB-TB-4. W2d spec §3 (D8).
185. **A stage pins its table rules at its start** (2026-10-20, owner, Q9 → D9). The stage freezes its effective points
     rule and tie-break order, inherited or its own; later division edits reach only unstarted stages; badge "Pinned at
     start". The stage's own settings lock at the first score (D3), other W2c settings keep W2c's lock. Under a fixture
     override (W2c, match format only, ruling 12) the stage's points rule must cover every outcome the stage format or
     any override can reach, and an override save that the rule does not cover is refused, naming the outcome. The
     shoot-out half of D9 ("an SO win pays like a win") is superseded by ruling 189. This loosens ruling 162:
     `DIVISION_TABLE_RULES_LOCKED` now covers `scoring` and `awardScore` only. X-TB-2, X-PT-3. W2d spec §3 (D9), §5.4.
186. **Six signed rule calls** (2026-10-20, owner "SIGNED all six", Q10 → D10). (a) Volleyball best of 3: 2-1 pays
     2:1 and 2-0 pays 3:0, and the `pointsMap` guard fires even with `"*"` (SC-S9, RB2A-10). (b) Chess points show as
     half-points, "1½" (ST-G2, RB2B-17). (c) Cricket's two-innings draw points exist only for a two-innings format;
     default 1. (d) `validateCascade` refuses a key the SPORT cannot emit (`nrr` outside cricket, `board_ratio` outside
     carrom) or the STAGE FORMAT has no data for (`buchholz` outside Swiss); Swiss keys are valid in any sport's Swiss
     stage. (e) W2c's `shootoutWin`/`shootoutLoss` are superseded by the outcome-keyed rule (ruling 164's group 3).
     (f) The SC-P4 oracle: FIH default 3/1/0 with draws; the shoot-out case tests the 3/2/1/0 preset, re-expressed by
     B2 as a draw worth 1 plus a shoot-out bonus of 1. VB-PT-2, VB-PT-3, BG-PT-1, CK-PT-2, X-TB-5, HK-PT-1, HK-PT-2.
     W2d spec §3 (D10).
187. **The stage order editor is option A** (2026-10-20, owner, Q11 → D11). An inline ordered list in the stage
     settings section: up, down and remove per step, "+ Add step", "Reset to sport default", badge Inherited /
     Overridden / Pinned at start, a `validateCascade` error inline beside its step, and once the stage has a score
     the arrows hide and a lock line shows. The first step is pinned to the sport's primary measure (points, or wins
     for volleyball, badminton and tennis) and lots are pinned last (the orchestrator's call inside D11, approved with
     the spec, ruling 196). X-TB-3. W2d spec §3 (D11).
188. **Production data does not move** (2026-10-20, owner "All ok" to the builder check, B1). The W2d migration pins
     every active or complete stage to the rules it used that day (its effective points and cascade), and converts
     old-shape `stages.config.points` to the new `PointsRule` shape. New defaults reach only unstarted stages. Owner
     fact: production had exactly one competition, a Swiss badminton one. W2d spec §3 (B1), §8.
189. **A shoot-out in football and FIH is a draw plus a bonus** (2026-10-20, owner "All ok", B2; signs the
     goals-and-boards rulebook's RB2B-7 with Q5). W/D/L shows D, and the shoot-out winner gets a bonus (default 1, so
     2/1 with a draw worth 1). FIH "matches won" counts regulation wins only. Ice hockey keeps OTW/OTL (IIHF has no
     draws). A knockout shoot-out decides who advances, nothing else. Supersedes D9's "an SO win pays like a win".
     X-PT-4, FB-PT-1, HK-PT-2, HK-TB-1. W2d spec §3 (B2).
190. **A hockey field goal is any goal not scored from a penalty corner or a penalty stroke** (2026-10-20, owner "All
     ok", B3). Own goals count. The pad records the goal type (W2d Task 18). HK-TB-2. W2d spec §3 (B3).
191. **A volleyball double round robin's head-to-head aggregates both legs** (2026-10-20, owner "All ok", B4). VB-TB-2.
     W2d spec §3 (B4).
192. **Chess Sonneborn-Berger under a 3/1/0 stage uses game points (1/½/0)** (2026-10-20, owner "All ok", B5). BG-TB-3.
     W2d spec §3 (B5).
193. **Swiss stages keep their per-sport orders** (2026-10-20; OC1, the f-w2d orchestrator's call, approved with the
     spec, ruling 196). W3 owns them, and they are exempt from the first/last pinned shape rule; `validateCascade`'s key
     and stage-format checks still apply. X-TB-3. W2d spec §3 (OC1).
194. **The pin is written when a stage becomes `active`** (2026-10-20; OC2, the orchestrator's call, approved with the
     spec, ruling 196). The stage's own settings still lock at its first score (D3). In execution the pin is written
     wherever a stage leaves `pending`, including before a complete write (controller ruling T9 I1). W2d spec §3 (OC2).
195. **`h2h_two` may repeat in an order** (2026-10-20; OC3, the orchestrator's call, approved with the spec, ruling
     196). The BWF and ATP orders need it after each step; no other key may repeat. X-TB-3. W2d spec §3 (OC3).
196. **The W2d spec and plan are approved; execution is subagent-driven** (2026-10-20, owner; spec at `8168a0b92a`,
     with D1–D11, B1–B5, OC1–OC3 and the author's calls in spec §17). Plan
     `docs/superpowers/plans/2026-10-20-format-matrix-w2d.md`; the owner chose subagent-driven execution the same day.
     Start: "yes" (2026-10-24, after W2c merged as #1007).
197. **W2d's rule rows are signed** (2026-10-24, owner "yes approve", W2d Task 0 Step 4, every row put word for word).
     Spec Appendix A's 43 new rows (31 `signed`, 12 `deviation`), written with the file prefixes CK- and CA- where
     Appendix A said CR- and CM- (a controller ruling, wording unchanged), and X-WO-1 amended in place (ruling 182).
     The rows carried ruling 75's number until this fold; every one is now proved (`AWAITING_PROOF` empty, W2d Task 21).
198. **Football's default order and the hockey goal kinds** (2026-10-24, owner "Apply rec", pre-flight PS-7c and
     PS-7d). PS-7c: `defaultTiebreakers(kind, cfg)`, and `fair_play` is left out when the division does not track it.
     PS-7d: a nameable `GOAL_KIND_REQUIRED` refusal, three goal-kind chips, and an own goal stays its existing control
     and counts as a field goal. FB-TB-4, HK-TB-2.
199. **Work that can run in parallel does** (2026-10-24, owner "start anything in parallel"; again 2026-10-25 to
     2026-10-28: "run anything in parallel", "parallel where possible", "why not start 19 now"). Applied as lane
     worktrees with disjoint file sets, merged back after review, never under a running implementer.
200. **Task 9's four pin rulings, and one script** (2026-10-25, owner "ok for all 4 and create one script only"). The
     controller's T9 I1–I4 (pin wherever a stage leaves pending; a post-deploy pin; a repin derives `crossGroup` as
     the engine resolver does; a saved `null` clears the stage's own layer) are approved. I2 is ONE script,
     `scripts/w2d/post-deploy-pin.ts` (pin, convert old-shape rules, and a `--check` count mode); no separate audit
     script.
201. **W2d ships as two PRs** (2026-10-25, owner "two"). PR A is Tasks 0–12, PR B Tasks 13–21 stacked on it and rebased
     after A merges. The migration is frozen once A merges. The owner accepts production showing the new orders and
     lots without Task 17's captions until PR B.
202. **PR A carries its own proof** (2026-10-25, owner "Ok"). PR A adds A14 (Task 14's DB-level seam tests for Tasks
     0–12, no API v1 parts), a small smoke check (pinned at generate; two reloads give the same lots order), A20 (MD-1
     over the engine files A changes) and A21 (its own ship gates and final review).
203. **A player's games in a match tie-break stay "none"** (2026-10-25, owner "agree"). The player-stat `nestedGamesOf`
     keeps "MTB = no games" in W2d, so the table and player stats may differ on games for an MTB match (a known
     difference); `STATS_FOLD_VERSION` stays 6. The stat rule is the rules backfill wave's question (ruling 121).
204. **PR A ships hockey's field-goals default before the pad types goals** (2026-10-26, owner "ok", G1). Until Task 18
     an untyped goal counts as a field goal; PR A's description states it as a known limitation.
205. **PR A keeps the stage points editor's "can't set per stage yet" state** (2026-10-26, owner "yes", T10 I2) for
     every sport whose rule the narrow editor cannot express (split OT/SO, set-score splits, no result, tie); PR B's
     widened editor (Tasks 15–16) removed it.
206. **The override-guards unhandled rejection gets a standalone test-only PR** (2026-10-26, owner "yes", then "yes
     merg"). Merged as #1024.
207. **No more time on scripts that are not customer or development work** (2026-10-26, owner: "Don't spend more time
     in writing scripts if the script of non customer or development work"). Applied: `post-deploy-pin.ts` and the DDL
     mutant driver got no further work; a finding on them is parked unless it leaks a secret or corrupts customer data.
208. **"nobody is using the prod now so we can run the script anytime"** (2026-10-26, owner). The deploy-window
     hazards of ruling 200's script were read as near zero. EXPIRED 2026-10-27 (ruling 213): a new team uses
     production, so the script's fix mode needs a fresh owner go.
209. **PR A: "merge if all green"** (2026-10-26, owner; then "merge if all green and start next pr b", 2026-10-27).
     Green meant every PR CI job, the e2e dispatch per spec file, a final whole-branch review with no open Critical or
     Important, and a rebase on current main. The stryker-sizing re-measure stays with the mutation session (ruling
     154), so its red was the known red.
210. **PR A merges with three known main-owned reds** (2026-10-27, owner "follow rec"; then "merge if all ok with
     1045"). R27's three chess americano cases are refused by main's #1027 (`CHESS_INDIVIDUAL_ONLY`), and the
     stryker-sizing legs await the re-measure. A small main fix hides americano and mexicano for chess (#1045, merged
     `1e0ffaaf1e`). PR A merged as #1038, `79ebb3187b` (2026-10-27).
211. **"If we can do stryker then do it"** (2026-10-27, owner). Applied by the controller as: Stryker MD-1 per ENGINE
     task right after its review, scoped to the files that task changed; UI tasks hand mutants only; Task 20 is the
     delta and the final re-measure.
212. **Tasks 15–16's screens and copy** (2026-10-27, owner "approved" to 15 screens × 3 widths; "Ok" to keep the
     reworded `rules.err.pointsRuleInexpressible` and `stagePoints.invalid.number`). The translator pass covers es, fr
     and nl.
213. **"hold w2": no production release until the whole of W2 is done** (2026-10-27, owner). A new team uses
     production at v1.0.7-beta and stays on it until W2 (through W2e) is done. Supersedes the "release after PR B"
     recommendation and expires ruling 208.
214. **"all 3 ok"** (2026-10-27, owner). (1) The pre-release gates before the W2 release: the staging check (Task 7),
     the data audit, the translator pass, and `post-deploy-pin.ts --check` after the deploy (its fix mode only on a
     fresh go). (2) The rule calls stand: a FIDE forfeit counts as a direct encounter exactly as the engine does today
     (a parity pin; there is no FIDE C.07 digest); a settled volleyball abandon pays by FIVB 6.4.3 (the opponent gets
     the sets it needs to win, the incomplete side keeps its sets); the FIH overtime cfg goes to the rules backfill
     wave. (3) The W3 spec waits until W2d merges.
215. **"rebase when possible"** (2026-10-27, owner). PR B rebased onto main after the Task 17 and 18 lanes joined, never
     under a running lane (`a719e11309` on main `4a9e180958`, 2026-10-28).
216. **Task 18's hockey pad screens** (2026-10-27, owner "approved screen").
217. **A visitor sees the level table before the first result** (2026-10-27, owner "approve", W2d Concern 2; the
     screens 2026-10-28, owner "yes"). The generate of a league, a single-pool group or a seated Swiss round writes the
     stage's level table: every rank "–", no leader, no band. Decision log 2026-10-28 has what it changed.
218. **The v1 strict points body stays a 422; a dated breaking-change entry** (2026-10-27, owner: "nobody using API now
     outside web, so no need backward comp now"; T18 m6 option 1). Recorded in `docs/api-v1-breaking-changes.md` and the
     developers changelog.
219. **The developers changelog promise is reworded** (2026-10-27, owner "Ok"): "Breaking changes are rare. Each one is
     listed here with its date, what changed and what to send instead."
220. **`scripts/smoke.ts` is split into a harness and per-suite files, as its own mechanical PR right after W2d merges**
     (2026-10-27, owner "approved"). The controller's reading of an "approved" that arrived after the split question
     and while Concern 2's screens were published; the screens got their own "yes" (ruling 217).
221. **BWF 3×15 ships inside W2e** (2026-10-28, owner "inside", Q1 → D1; W2e spec
     `docs/superpowers/specs/2026-10-28-format-matrix-w2e-design.md`, session f-w2e). Not a standalone PR: it closes issue
     #1004's question (ruling 155). A new explicit `bwf-3x15` variant is added (15 points, win by 2, cap 21, best of 3);
     the `bwf` variant stays 21/21/30 (false premise E14: changing the module defaults would have turned it into 3×15).
     Row BD-VR-1.
222. **3×15 is the badminton default from the day W2e ships, with no date check** (2026-10-28, owner "we don't want to
     check and just show by default now", Q2 → D2). Supersedes the 2027-01-04 gate in ruling 155's issue. No existing
     division or stage changes format (the spec's anti-goal 2): divisions store their fully parsed config and fixtures
     freeze theirs at the first event, so no migration was needed (E14).
223. **A disqualifying sanction ends the match; a penalty point stays a rally; a short team gets no automatic ending**
     (2026-10-28, owner, Q3 → D3, amended by D12, D13 and D15 below). (1) A badminton black card or disqualification and
     a tennis `default` END the match; the sanctioned side loses, credited through W2b's retirement path X-RT-1
     (rulings 113, 115, 118). (2) Penalty points and games stay entered as a rally or game, never auto-awarded. (3)
     Hockey and ice hockey below `strength.min`: no automatic ending, and (D15) no warning either; the organiser's
     existing abandon or award ends it, and M12b's 21 "team plays short" cases get a screen path
     (`core.lineup.retirement`) in football, volleyball, hockey and ice hockey. Rows X-SE-1..3, BD-SE-1, TN-SE-1.
224. **Repeat sudden-death overtime is not offered** (2026-10-28, owner, Q4 → D4). The dead `shootout.suddenDeath` key is
     deleted (strict schema: stripped by migration V481, E23/E29); rows HK-SO-2 and IH-SO-2 record that it is not
     offered (RB2B-38).
225. **The five ruling-157 keys become plain editor fields** (2026-10-28, owner, Q5 → D5). `carrom:pointsPerCoin`,
     `cricket:minOversForResult`, `cricket:superOverStillTied`, `football:concussionSubs`, `football:rollingSubs` in the
     existing stage-rules editor (W2c pattern), 1280 sign-off, four locales, and the ratchet at zero
     (`stage-row-model.test.ts`). `superOverStillTied`'s `boundary_count` option is hidden unless boundaries can be derived
     from ball-by-ball scoring (SC-C6). Closes ruling 157.
226. **Generic `progressScore` is deleted** (2026-10-28, owner, Q6 → D6): the key, the v1 import's write and the Advanced-box
     placeholder. Old saved configs read without error (the key is stripped; migration V481 strips stored copies).
227. **About 35 row-only items get a signed rule row and a proving test** (2026-10-28, owner, Q7 → D7): every rule that
     changes a result and every mechanic that changes the score or who is on the field. Record-only mechanics get a
     "record-only: no effect on the result, owned by the scoring-pad programme" disposition (a `deviation` row, one test
     per sport titled with all its ids). Batched one task per sport.
228. **Leftover rulebook items: what is in and what is out** (2026-10-28, owner, Q8 → D8). IN: RB2A-22, RB2A-20, RB2A-13,
     RB2A-12, RB2B-20, RB2B-10 (verify first), plus the two bugs (tennis SC-S1 and ruling 31's floor). OUT to a post-W2
     wave: RB2B-39, RB2B-26, RB2B-32. OUT, not built: RB2A-26, SC-C8. Rule row "refuse / by design": RB2A-32, SC-P13. The
     rule behind it: W2e takes fixes to things the product already offers that can record a wrong result; new entry
     paths and variants wait. Closes ruling 31: the set-target floor of 5 for volleyball and table tennis is applied
     (`SetBasedPreset.minSetTo` through `configWriteIssues`; V481 fails loud on any stored config below it).
229. **Generator breadth, then ONE W2 truth run gates the merge** (2026-10-28, owner, Q9 → D9). G1–G8, G12 and W2e's new
     paths, batched by stream; the run is judged against the committed baseline. Every red is fixed in W2e or gets an
     owner "not built, because…". Amended by D16 (ruling 236).
230. **MD-1 amended** (2026-10-28, owner, Q10 → D10). One CI Stryker sizing dispatch at W2e's start; W2e kills or
     classifies the survivors on every line it changes, plus the result-deciding paths of spec §11; the remainder,
     including MD-X1 and MD-X2, goes to the mutation session as its own wave and is NOT a prod gate. The MD-1 table
     below is amended accordingly; see "Controller rulings (execution, W2e)" for how the controller read §11(b).
231. **Hockey preset hidden where it changes nothing; `rank: null` on a level table** (2026-10-28, owner, Q11 → D11).
     (a) The "3 / 2 / 1 / 0 (shoot-out)" preset is hidden wherever it equals the stage's effective default and kept where
     it differs: already shipped by W2d's final-review m5 (`presetOffered`, false premise E12), so W2e added only a pin
     test. (b) The public level table serves `rank: null` while the table is level, at serialisation only (E24), and the
     OpenAPI spec says so. Closes the two W2d "Need an owner ruling" items.
232. **Volleyball amends ruling 223 (1): the team plays on while it can field six** (2026-10-28, owner, Q12 from the
     builder check → D12). A disqualification or expulsion never ends a volleyball match by itself (FIVB). Right after
     one the pad asks "Can <team> still field six players?"; "No" records the existing incomplete-team ending (VB-RT-1,
     FIVB 6.4.3), "yes" plays on. Badminton's black card and tennis's `default` still end the match automatically. No
     court-strength count is built.
233. **A narrow scorer exception to organiser-only endings** (2026-10-28, owner "a", Q13 → D13). A scorer (device link or
     official scorer, A0.9 item 5) may send `core.forfeit{reason:"disqualified"}` only as the event right after an
     ending-level sanction (badminton black card, tennis `default`) against the same side, and
     `core.forfeit{reason:"retired"}` only right after a volleyball disqualification or expulsion against the same side.
     Every other `core.forfeit` stays organiser-only (403).
234. **DLS NRR is frozen per match — SUPERSEDED by ruling 238** (2026-10-28, owner "a", Q14 → D14; reversed the same day on
     reading the plan). Kept for the record only: no method key and no freeze shipped.
235. **No "below strength minimum" warning** (2026-10-28, owner "a", Q15 → D15). `strength.min` is a penalty floor and
     nothing feeds injuries into strength (E18). Amends ruling 223 (3): the M12b retirement path stays; the organiser's
     abandon or award ends a match a team cannot continue. Not built: a player-tracking count for hockey and ice hockey.
236. **The truth run is the CI dispatch plus W2e's new scenario keys run locally** (2026-10-28, owner "apply rec", Q16 →
     D16). Amends ruling 229's wording: the CI full-scope dispatch plans only the base scenarios (E20), so W2e's new keys
     run locally with `--scenario` (the W2a/W2b precedent); both attach to the PR. The judge prints compared and skipped
     counts and fails on any skip not listed as expected (`--expected-skips`; `--sample` is regression-only).
237. **PR #1061's five export "Owed" rows are the #1061 export stream's** (2026-10-28, owner "apply rec", Q17 → D17), not
     W2e's. W2e's fold checks their state before W2 is called closed; when the export gains NRR it reads the same standings
     NRR as the public table (ruling 238). State at the fold: see "Owed: the organiser standings export".
238. **No cricket is in prod: ICC 16.10.7 NRR applies to every cricket match, and a data change is announced LOUDLY and
     migrated BEFORE deploy** (2026-10-28, owner: "no crickets are in prod data so no need to write some workaround, always
     louad when data changes and need migration before deploying"; D18). Reverses ruling 234: no method key, no freeze.
     **Standing rule:** a change that moves stored data is announced in the spec, the PR body's "Data changes" section and
     the release notes, and ships a migration that runs before the deploy, never a code workaround that keeps old rows on
     old behaviour. V481 (`V481__w2e_stored_config_cleanup.sql`; V480 is YouTube's) is the first to follow it.
239. **The Hundred is fixed in W2e** (2026-10-28, owner "a", after first choosing "b" and then a sizing of about one task;
     Q19, T0 review finding E31, D19). D8's "5-ball overs not built" rested on a false premise: the `hundred` preset ships
     selectable (100 balls, 5-ball overs). The overs editor and the NRR display used 6-ball overs; both now use the
     variant's `ballsPerOver`, and the NRR scale follows the ECB's stated convention. Other 5-ball variants stay not built
     (ruling 228, RB2A-26).
240. **"Take a decision as a product owner; no check-ins"** (2026-10-28, owner, standing for W2e): "go ahead and take a
     decision as a product owner and when I ask status then tell that decision made. No checkin and keep build and raise
     if and merge if all green and keep work in pr a and pr b if possible." The controller's calls under it are logged
     as "PO decision" in "Controller rulings (execution, W2e)"; they are NOT owner rulings (class 17) and are reported on
     the next status ask.
241. **Delivery calls, 2026-10-29** (owner). "Start PR B in parallel?" → yes: lane W proceeds on PR A's frozen tree
     (`6ccfa0767a`) instead of waiting for the merge. "Check status and merge PR A" → PR A merged as #1068, merge commit
     `18155d5ca0`, with the two `stryker-sizing` tests red (owned by the mutation session's `chore/w2e-stryker-measure`):
     the owner's explicit go over a known red. "Rebase when possible" → lane W is rebased onto main (linear), gated on an
     empty tree diff against its pre-rebase tip.
242. **Cricket dismissals on the scoring pad: obstructing and retired** (2026-10-30, owner "all yes", engine-split pad
     wave P2, its review fix round). (a) The house rulebook credits the named fielder for an obstruction (cricket
     `DOMAIN.md`, Dismissals), which departs from MCC Law 37: the Law credits no fielder (37.6: nor the bowler). Kept, and
     the pad's fielder step for an obstruction is optional; the fold takes an obstruction with no fielder named and
     credits nobody (rules row CK-WK-2, deviation). (b) Either batter can be out obstructing the field (Law 37.1.1) or
     retired (Law 25.4.1); the fold takes either batter for both (folded both ways, the retirement as a wicket kind and
     as `cricket.retire`), so the pad asks who is out for both, as it does for a run out (CK-WK-3, signed). (c) The fold
     accepts the non-striker out bowled, caught, hit the ball twice, hit wicket, lbw or stumped, which the Laws forbid
     (each dismisses the striker). Only an API write reaches it: the pad never asks who is out for those modes. Parked to
     owed work: a fold change with a cricket `FOLD_EPOCH` bump after the pad wave (CK-WK-4, open; engine-split owed-work
     O-8). No fold change in the pad wave.
243. **The set-based deuce/setting note follows the rulebook** (2026-10-30, owner "apply rec", pad wave P3.1, review I2;
     242 is the cricket batch's). The note is the engine's `deuceNote` (`packages/engine/src/pad/setbased.ts`, read off
     the kernel's own `setWinner`): badminton shows Setting at every tie from target−1 up to the cap, where Golden point
     shows (BWF 7.3, 7.4); volleyball shows Deuce at every tie from 24-all, or 14-all in the deciding set (FIVB 6.1.2);
     a `winBy: 1` cfg shows Golden point at target−1 all; table tennis is unchanged (Deuce at every tie from 10-all, the
     PR #678 fix); the note never shows outside live play (a forfeit or abandon at a tie leaves none, review I1). An
     accepted visible change against the pad-wave spec §3.5 ("no behaviour change"). The table-tennis expedite floor of 9
     stays advisory and as is: the fold enforces none, and whether the current ITTF text reads "both have reached 9" or
     "18 points scored" stays an open question (review m4). Rows signed: BD-SC-1, TT-SC-1, VB-SC-1, TT-EX-2.
244. **The tennis pad's ends-change cue follows ITF Rule 10 and Rule 5(b)** (2026-10-30, owner "yes accept tennis 244";
     pad wave P3.2, review I1). The cue shows after an odd number of games in a set, at the end of a set whose games total
     is odd (a 7-6 set counts its tie-break game, and a match tie-break after an odd set opens on it), and after every
     sixth point of a tie-break or match tie-break; never before the first point, once the match is decided, or once it
     is retired or abandoned. It replaces the old skin's reading (lit through tie-break points 7 to 11, off at 12, off at
     a set boundary, still lit after a mid-set retirement): an accepted visible change against the pad-wave spec's §3.5
     "no behaviour change", with the fold unchanged (no golden or epoch moves). Rule TN-EN-1 (`packages/engine/rules/tennis.md`).
245. **Cricket super-over reviews and retirements follow ICC Appendix F paragraph 12, fixed after the pad wave**
     (2026-10-30, owner "apply rec in open questions", engine-split pad wave close, rules row CK-SO-3). The owner accepts the
     ICC reading: each team gets one unsuccessful player review per innings per super over (ICC Men's T20 World Cup 2026
     Playing Conditions, Appendix F paragraph 12), and the match's playing conditions apply to the super over, retirement
     (25.4) included (the Appendix F preamble). The engine refuses both today (`cricket.review` and `cricket.retire` are
     WRONG_PHASE in a super over: `SUPER_OVER_EVENT_TYPES`), so CK-SO-3 is a known deviation, `deviation 245 2026-10-30`.
     The fix is owed work O-12 (`docs/superpowers/specs/engine-split/2026-10-26-owed-work.md`): a fold change with a
     cricket `FOLD_EPOCH` bump after the pad wave, which moves the two tests that pin the refusals. No fold change in the
     pad wave.
246. **Cricket: both ways of recording a retired-out batter stay for now** (2026-10-30, owner "apply rec in open
     questions", engine-split pad wave close, rules row CK-RH-2, new). The two ways are the wicket sheet's Retired, which
     writes a `cricket.ball` with `wicket.kind = "retired"` (a legal dot ball: `legalBalls` +1), and the Retire sheet's
     out, `cricket.retire` with `reason: "out"`, which records no delivery. Law 25.4.1 says a batter retires when the ball
     is dead, so the wicket-sheet path counting a legal ball is a known deviation, `deviation 246 2026-10-30`. Both stay.
     Owed work O-13 (engine fold + pad): after the wave, decide whether the wicket sheet drops Retired or records no
     delivery for it.
247. **Chess tie-break score: a level score beside a named winner stays, a loser-ahead score is to be refused**
     (2026-10-30, owner "apply rec in open questions", engine-split pad wave close, rules row BG-TS-1). A drawn mini-match
     score (½–½, 1–1) with a named winner stays allowed, because a further tie-break decided the match. A score that
     contradicts the named winner, the loser shown ahead (½–1½ beside the winner), should be refused, but the fold checks
     only the written shape and accepts it today, so BG-TS-1 is a known deviation, `deviation 247 2026-10-30`. The fix is
     owed work O-14: a fold change with a boardgame `FOLD_EPOCH` bump after the pad wave. The pad offers only no score,
     1½–½ or 2–0, so only an API write reaches it; the BG-TS-1 tests pin the fold's laxness and move with O-14.
248. **House limits: board number 200 (BG-PA-1), generic final score 500 (GN-SC-1), generic per-tap step 50 (GN-SC-2)**
     (2026-10-30, owner "apply rec in open questions", engine-split pad wave close). Signed as house limits: they are
     product limits, not rulebook rules (FIDE has no limit on board numbers, and no federation governs a generic sport),
     and the pad enforces them while the fold does not (the fold takes any positive board number, any non-negative final
     score and any non-zero press). The three rows are `signed 248 2026-10-30`, cite "house limit, ruling 248" and say the
     fold does not enforce the limit. No code change; the tests that pin the three values stay change-detectors.
249. **The pad wave's open rule rows are signed** (2026-10-30, owner "sign per rec", engine-split pad wave close). The
     product owner's recommendation, taken whole: every row the pad wave left `⬜ open` is closed. No code change.
     (A) 41 rulebook rows, `signed 249 2026-10-30`, citation kept: BD-CT-1, BD-IN-1, BD-RO-1, BD-SN-1, TT-EX-1, TT-FM-1,
     TT-RO-1, TT-SN-1, VB-FM-1, VB-RC-1, VB-RO-2, VB-SN-1, TN-CF-2, TN-PT-1, TN-SC-1, TN-SE-3, TN-SS-3, TN-SV-1, CK-BD-1,
     CK-EX-1, CK-EX-2, CK-PR-2, CK-TG-1, FB-CD-1, FB-CD-2, FB-ET-1, FB-PH-1, FB-PH-2, FB-PK-1, FB-PK-2, FB-SU-2, FB-TS-1,
     HK-AS-1, HK-PH-1, IH-AS-1, IH-GL-1, IH-PH-1, IH-SU-2, CA-CN-1, CA-FM-1, X-PH-1. Where a citation ended "no ruling"
     (or "no owner ruling yet") that tail now names this ruling, as 245 to 247 did.
     (B) 10 house limits and product picklists, `signed 249 2026-10-30`, citing "house limit, ruling 249": the set-score
     entry bounds BD-SC-2, TT-SC-2 and VB-SC-2 (`summaryScoreBound`), the tennis set-score ceilings TN-SS-4 and break
     ceiling TN-RO-2, the hockey and ice-hockey card-minutes bounds HK-SU-2 and IH-SU-3, and the picklists HK-SU-3 and
     IH-SU-4 (card and penalty reasons) and CA-AD-2 (carrom adjustment reasons). They are product limits and the pad's
     own vocabulary, not rules of any sport; the pad enforces them and the fold or engine does not.
     (C) 2 known deviations, `deviation 249 2026-10-30`: VB-LB-1 (the engine's libero exchange check is looser than FIVB
     19.3.2; fix owed work O-9, a fold change with an epoch) and CK-WK-4 (the fold accepts the non-striker out in the six
     striker-only modes; ruling 242 (c) parked it to O-8 and 249 records it as a deviation).
     (D) CK-WK-5, `deviation 249 2026-10-30`: the pad should ask who is out for a timed out dismissal, as it does for run
     out, obstructed and retired (CK-WK-3). Owed work O-16: a pad change alone, no fold change and no epoch.
250. **Swiss late entry after pairing: three cases, one action** (2026-10-31, owner "yes" and "all per rec", W3
     design `docs/superpowers/specs/2026-10-31-format-matrix-w3-swiss-design.md` §4). A Swiss stage accepts an entrant
     after Start, in every sport. Today `entrants.ts` refuses it (SW-L7). The organiser's **"Add late player"** handles
     the current round by the first case that applies:
     (a) if no board in it has started, the round is re-paired with the newcomer, and every slot keeps its time and
     court;
     (b) if a board has started and the round has a pairing-allocated bye, the newcomer plays the bye holder on a new
     board, and nothing else moves;
     (c) otherwise the newcomer joins from the next round.
     Case (a) changes a published pairing against FIDE C.04.2 4.4: a deviation, accepted knowingly.
     **Automatic arrivals** after Start (a payment confirmation, a waitlist promotion, an import) never re-pair: they
     always take case (c), and the desk says so.
     **With no round left**, a late entry is refused: while the Swiss still runs, the refusal offers "Add a round";
     once it is finished or the knockout has started, it says "This Swiss is over".
     Rule rows land in the engine repo `rules/cross-sport.md` with the code that implements them (owner: "make sure
     that rules are noted in engine rules").
251. **Swiss byes and missed rounds score win points / zero, with no score recorded** (2026-10-31, owner "yes and make
     sure that rules are noted in engine rules", W3 design §5).
     - A pairing-allocated bye pays the stage's win points, in every sport, and records no set, game, point, goal or
       run for or against (FIDE C.04.1 r.3; BWF has no Swiss rule). This replaces paying a custom rule's forfeit row
       (SW-M6).
     - A late entrant scores 0 for each round missed, with no score recorded. There is no half-point option.
     - Walkovers are unchanged (X-WO-1, BD-WO-1).
     - Rule rows land in the engine repo `rules/cross-sport.md` (+ sport files) with the code.
252. **The W3 Swiss rulebook is signed per recommendation** (2026-10-31, owner "all per rec").
     `rulebook-W3-swiss.md` §10 recommendations RB3-1 to RB3-25 are signed as written, with three exceptions:
     RB3-13 is superseded by ruling 250, RB3-7(a) by ruling 251, and RB3-7(b) (wire `byeScore`) is settled by the W3
     design §5 instead.
     The rulings that bite first:
     - RB3-15 option A: refuse "Add match" on a Swiss stage, with guidance (#846, SW-M3/M4/M5).
     - RB3-5 answers #838 / O7: rounds are per stage, editable until the first fixture **starts**, then only
       "Finish now" or "Add a round".
     - RB3-2: unplayed pairs may meet again.
     - RB3-10: chess colours are on by default for boardgame Swiss.
     - RB3-7(c): requested ½ / 0 byes are deferred (⛔ with guidance).
     - RB3-6: FIDE C.07 2026 art. 16 for unplayed rounds.
     - RB3-8: Swiss default tie-break chains, with Buchholz early.
     Rule rows are written with the implementing code, never ahead of it.
253. **Rebuild keeps every fixture's time and court, and deletes and regenerates in ONE transaction, in any format**
     (2026-10-31, owner "approve" of the W3 design, goal G3; #840, FX-G13, SW-L8). A throw must leave the stage as it was,
     never empty. The rule is format-agnostic: W5 consumes it for league rows and #879 part 3. Rule row X-RB-1 (engine
     `rules/cross-sport.md`, the W3 rules close-out).
254. **A chess forfeit after play started (a retirement) takes no colour: the engine's BG-WO-1 stands over FIDE**
     (2026-11-01, owner "apply rec" on R14). The W3 rulebook (§4 M3, §9 R14) followed FIDE: a game that began and
     ended in a retirement counts in colour history. The engine (BG-WO-1, signed 86) excludes every chess forfeit,
     post-start included, from colour history, and app-A T7 matches it (no forfeit takes a colour). Kept as a recorded
     deviation. The pair still counts as **met** (`isUnplayedForfeit` is false once played), so only colour differs.
     Cost: in a rare mid-game retirement the next round's colour may repeat. Other sports carry no colour.
255. **Unpaired Swiss round slots are scheduled by the solver as anonymous slots** (2026-11-01, owner "A").
     Auto-schedule of a Swiss stage sends each unpaired round shell to the placement service flagged as an unpaired
     round slot: no person constraints, but courts, windows, day caps and the round end barrier (X-SW-31) apply. Chosen
     over synthetic player groups (B) and skipping unpaired rounds (C). Found by the Match Day session: today every
     Swiss auto-schedule with shells is refused by the service and falls back to greedy. Owners: a placement PR, then
     app-B Task 9b (addendum).

## Recommendations (mine — not rulings)

- A guard-only W0 before the real fixes — **declined** by ruling 3.
- #878 (browser Sentry) ships early from the W10 lane; it is a one-file ops fix.
- CI weekly + dispatch (O1) — **accepted**, now rulings 16/20.
- When the repo goes private: move the weekly matrix to a self-hosted runner
  (free today — GitHub postponed its self-hosted charge). The owner proposed a
  public shim repo pulling a private image; I recommended against it (Actions
  terms exclude hosted-runner work unrelated to the repo's own project; public
  logs). Not ruled.
- Mixed-driver lifecycle (O2) — **accepted**, now ruling 15.
- L1 at 1280 + 320 per cell; L2 rotates the seven widths (design §11 O3).
- The bench's repeated-`completeStage` finding is fixed in W5; the harness
  avoids repeat calls until then.
- A W1d re-size gate — **declined** by the owner (2026-09-28): waves keep
  their audit-derived scope. Recorded as a declined recommendation, not a
  ruling.
- **For W1c (from W1b Task 7):** slice a wave's L2 runs by filtering the
  committed `l2-pairs.json`. Never re-plan with `only`: a re-plan assigns
  different widths from the committed rotation.
- **For W1d (from W1b Task 10's review):** exit code 1 means different things
  per CLI — drift for `gen-catalogue.ts`, zero cases for `run.ts`. A CI
  wrapper must key on which CLI it ran.
- **For W1-driving:** run the model's Swiss cells at 40 runs or more, or bias
  the command generator toward Start → Generate → Score. At the default 20
  runs a Swiss cell can draw no Correct and read vacuous (W1b Task 15).

- **W1c plan decisions, as ruled at plan review** (plan `docs/superpowers/plans/2026-09-29-format-matrix-w1c.md`).
  Each was the controller's recommendation. The owner's answer is noted beside each one.
  - **D1 (O3, widths): accepted as amended, now ruling 39.** L1 runs at 1280 only. The phone path is proven by L2,
    the width sweep, and pad proof at 1280 and 320. This supersedes the older recommendation above ("L1 at 1280 +
    320 per cell").
  - **D2 (pad adapters replay the generated events, with fallbacks declared and judged): accepted, ruling 40.**
  - **D3 (the pad-proof set): accepted, ruling 40.**
    - The set is a 3-entrant league at the builder default, three fixtures, each finalized.
    - Rosters were to be seeded over HTTP. Execution proved the team pads on rosterless team entrants instead
      (controller ruling D-T9-2, below).
  - **D4 (no product changes; selectors are pinned text): accepted, ruling 40.**
  - **D5 (L2 on the slice is 68 runs, 3 executed): accepted, ruling 40.** Confirmed live: 3 ✅, 7 🚫, 58 ░.
  - **D6 (final ranks 2..n have no page; a finding, not a failing check): accepted, ruling 40.** The finding is
    routed below.
  - **D7 (API-only rows): accepted, ruling 40.**
    - *Executed differently:* the rows are planned 🚫 `{wave, reason}` with no browser. D7 said browser from
      Generate onward, with ❌ `organiser-ui-path`.
    - The change came from the controller's Task 12 dispatch. **Owner ruling 43(b) (2026-09-30) accepts it.**
  - **D8 (no-horizontal-scroll is a check at every captured state): accepted, ruling 40.** It passed at every
    width in every run.
  - **D9 (results schema v3: layer, driver, width): accepted, ruling 40.** Task 14 added `plan` to the same
    schema (carry 6, `3c36ea1b3`).
- **For W1c Task 14 (controller): run the width sweep on a knockout cell, and include 768/834.** Knockout was never
  driven below 1280: the L2 rotation drew only swiss\|badminton. The sweep ran on `knockout|badminton` at all seven
  widths. **Owner ruling 43(a) (2026-09-30) accepts it** in place of ruling 39's `league|badminton`.
- **For W1d (from W1c Task 14):** read `layers.ts:218-229` before running parity on the API-only set. Its 🚫 cases
  are recorded under LIFECYCLE, so parity exits 1 there by construction. The final review decides which of these
  to pick:
  - map them out of the plan;
  - never run parity on that set.

- **For W1-driving (the plan's decisions, `docs/superpowers/plans/2026-09-30-format-matrix-w1-driving.md`).**
  - **D1–D13: accepted, ruling 52.** D1: seed advance through two driver methods, not bench `advance.ts`. D2:
    full-size rosters, members inline over HTTP and as filler in the browser. D3: PADPROOF keeps `rosterlessTeams`.
    D4: the cricket `test` streams and the tie. D5: a future generator gap routes to W2. D6: model refusals get their
    own class, routed by family; **D6 amends ruling 49** by adding **W3** for `swiss_playoff` and `swiss_knockout`
    (design §8; false premise 9). D7: one routing construct. D8: the ladder schedule is one bottom-up sweep of
    adjacent upward challenges. D9: the americano and mexicano loops. D10: `--workers > 1` is HTTP-only in this
    wave. D11: template-only cells use the template's own field. D12: the M1 and R4 hooks fire on stage 1 only.
    D13: the L1 proof excludes the cricket `test` streams, and the pad routes for its events go to W1d.
  - **D14 (M1 and R4 on the ladder family): ruled in two parts.** Its M1/R4 meanings are ruling 51. Its ladder R4
    expectation (the policy derived from what is pending at withdrawal) is ruling 53.
  - **Not rulings:** the predicted-signature legs and the triage rule of Task 15 Step 3 (the coverage table, P1–P7)
    are the planner's method. The executing controller's decisions are listed in "Controller rulings (execution,
    W1-driving)" below. They are not owner rulings either.
- **For the owner (from W1-driving Task 15; not assumed):** `group_group_ko` F1 seats 7 entrants in 4 pools, which
  leaves seed 1 alone in pool A. This can be ruled unfit for F1 instead of a product red. Until the owner rules, it
  stays a product red → W5 (TRIAGE P3).
- **For W7 (from W1-driving Task 15):** seed and tie-break mexicano pairing deterministically before pinning its
  cells. Over four live runs of mexicano R4, no case kept one failing set. The hypothesis, not proven live: every
  mexicano point is 0 on a sport that folds no score, so the person-id tie-break (random UUIDs) decides the
  pairing.
- **For W1d (from W1-driving Task 16; the rate-limit carry):** do NOT add a `--workers` refusal keyed on Redis.
  Instead, give each shard one sign-in budget and document the threshold:
  - **The threshold.** With `REDIS_URL` set, `POST /api/auth/magic-link` is limited to 5 per 300 s per IP
    (`EMAIL_LIMIT`, `rate-limit.ts:81`; the route's call is at `magic-link/route.ts:27`). It refuses when
    `count > max` (`:64`), so the **sixth** sign-in inside 300 s answers 429. The harness signs in once per worker
    (`run.ts:832` first, `:925` each further worker). So 6 or more workers trip it, and so do back-to-back runs from
    one IP. T11's report said "5 or more", which is off by one.
  - **Why no refusal.** The harness cannot see whether the server has `REDIS_URL`. Without Redis the limiter is
    inert (`rate-limit.ts:55-62`). That covers every env this programme has run against: the local env recipe sets
    no `REDIS_URL`. Also, read-derived and not run: under Redis, `getUserOrgs` caches `orgs:<uid>`
    (`auth.ts:161-175`). A case org seeded in SQL would then be missing from the cached list at ANY worker count.
    So a Redis target would break the harness before the worker cap mattered.
  - What W1d should do: if a target ever runs Redis, give each shard its own source IP or synthetic owner, and
    invalidate the org cache after seeding. Do not cap the workers.

- **For the owner (W1d Task 16, PR-A close; recommendations, not rulings):**
  - **D11 (items 17 and 18): decline browser workers; keep one browser case at a time per shard and buy wall clock
    with the shard matrix.** Free parallelism, no unmeasured contention on pad holds. `MAX_WORKERS` stays 8. Built as
    recommended: `--driver browser --workers N` is a usage error that says so (`run.ts:633`). If the owner wants
    browser workers, they become a W1d follow-up task, and nothing else in the plan depends on the answer.
  - **D2's enable step is the owner's act, after PR-B merges (ruling T22-REORDER, 2026-10-06; it was "after PR-B proves
    three green dispatches", which Task 17 has already done, so that wording would read as "enable now"):** `gh variable set
    MATRIX_WEEKLY_ENABLED --body true`. Until then both schedules (matrix-truth Saturday 02:17 UTC, mutation Sunday
    03:23 UTC) fire as a visible run of skipped jobs, and the same command with `false` switches them off in seconds,
    with no PR. The controller records the time and the first scheduled run id here (R22). Do not set
    `vars.MATRIX_RUNNER` while the repo is public (D24): a self-hosted runner on a public repository runs fork
    `pull_request` jobs.
  - **The bench carry (D9).** `tools/bench/**` tests are excluded from `tsconfig.tools-tests.json`, and
    `tools-tests-typecheck.test.ts` pins the exclusion (57 tracked bench tests, none in the program). A test-inclusive
    TS7 program over them reported about 90 errors at planning (not re-measured since). No issue is filed. The bench
    programme owns them: fix and include them, or leave them excluded on purpose.
  - **Widen R27's declaring paths, or leave it as written (Task 7).** `ci.yml`'s `matrix-sample` runs on 5 path globs
    (`packages/engine/**`, `apps/web/src/server/**`, `apps/web/src/lib/format-templates.ts`, `tools/matrix/**`,
    `pnpm-lock.yaml`), but R27 makes only 2 of them DECLARE rows (`packages/engine/**` and
    `apps/web/src/server/usecases/stages.ts`). A PR touching `apps/web/src/server/**` elsewhere, or
    `format-templates.ts`, gets the fixed sample with no prompt for rows. Built as R27 is written; widening it is a
    one-line change to `pr-rows.ts` and its tests, and the cost is more PRs asked to name rows.
- **Observations for the owner from W1d PR-A that are not W1d defects** (seen, not diagnosed):
  - `ci.yml`'s other jobs run on `vars.CI_RUNNER` ungated for fork PRs, a pre-existing self-hosted exposure. The jobs
    W1d adds are fork-gated (T9-FORK).
  - **Product, from Task 14's browser runs:** the run sheet at 320 cuts names away; "Void last" is still offered after
    a forfeit (it then targets the start); and `void-320-after.png` shows the pad board stale (Games 1-0) while the
    header and Activity read 0-0 and the label reads ALL SYNCED. That last one is either a product defect (the pad
    ignores a console void at 320) or an ambiguous capture, and it is not diagnosed.
  - **For W2:** the cricket follow-on and `match.close` have no pad control and no More-sheet `data-testid`
    (`action-form.tsx` renders them as plain buttons), so no pad route can address them. A
    `data-testid="more-action-<event type>"` on those rows would open them, and the declare route with them.

- **For W2c (the plan's decisions, `docs/superpowers/plans/2026-10-13-format-matrix-w2c.md` §Decisions).** Accepted
  with the plan (ruling 141), not ruled one by one. Where execution changed one, the line names the ruling that did.
  - **D1 — the rule declaration is an engine fact.** `SportModule.ruleKeys` (scope match, stage or points;
    `appliesTo`; `matchBound`), dotted keys for a leaf whose scope differs from its object's, and the derived
    `stageKeysFor` / `fixtureKeysFor` / `pointsKeysFor` / `checkFixtureOverride` from `@seazn/engine/sport`. As built,
    `matchBound` is `"shorter" | "off_or_shorter"`, and a `decider: true` fact marks a whole decider (Task 4).
  - **D2 — web is presentation only.** One file per sport under `apps/web/src/lib/match-rules/`, each field naming the
    engine keys it `edits`; `apps/web/src/lib/rule-scope.ts` maps keys back to fields; web declares no scope.
  - **D3 — one storage place for deciders (greenfield).** Every stage-scoped key lives in `stages.config.rules`.
    Top-level `shootout` / `extraTime` leave API v1, the overlay in `stageScopedCfg` is deleted (Task 13b), and
    `createStages` / `replaceStages` accept `config.rules`. As built, a top-level decider is a named 400 (controller
    ruling R-13b-1).
  - **D4 — the resolver signature.** `resolveFixtureCfg` takes the fixture row (`config_snapshot`, `rules_override`,
    both required), so a caller that does not select the override fails `tsc`.
  - **D5 — the override fragment is replaced, never merged.** `PUT /api/v1/fixtures/{id}/rules`; `null` or `{}`
    clears it; `writeFixtureRulesOverride` is all-or-nothing and names the first fixture that blocked it.
  - **D6 — the correction (Q11).** Under the fixture lock, refold the recorded ledger with the corrected cfg; refuse
    `FORMAT_DOES_NOT_FIT_PLAY` if the fold throws, the outcome changes, or the correction would end the match (ruling
    138); otherwise write the override, re-freeze the snapshot through `refreezeFixture`, bump `rules_version` and
    audit `fixture.rules_override`.
  - **D7 — every Armageddon records its colours.** The event carries `{rung, black, result}`; the engine derives the
    advancer (a draw advances Black) and refuses an Armageddon with no `black` (`TIEBREAK_COLOUR_REQUIRED`). BG-KO-2.
  - **D8 — tie-break rungs.** `tiebreakRungs` (at most 3, no duplicates; absent means all); an empty list holds a
    drawn game for the organiser (ruling 79); a rung not in the list is refused. As built, the list is the decider and
    its order is a menu (controller ruling T8; ruling 132).
  - **D9 — abandon options (Q10).** `abandonPolicy` per sport, read from `abandonOptions`: hockey `replay`, `award`,
    `q4_stands`; ice hockey and football `replay`, `award`; carrom and generic `replay`, `share`. `q4_stands` stands
    from the last regulation period on. As built, `share` applies in table stages only (ruling 133).
  - **D10 — codes.** Server codes are declared once, with their status, in `apps/web/src/lib/rule-errors.ts`;
    `TIEBREAK_COLOUR_REQUIRED` is an engine code (422); OpenAPI lists codes in route summaries. As built, two codes
    joined (`FIXTURE_HAS_OWN_FORMAT`, `FIXTURE_OWN_FORMAT_NO_LONGER_FITS`), and the refusal sentences live in
    `rules.err.*` (batch-3 M1) while the division lock lines keep `ruleLock.*`.
  - **D11 — the division lock (ruling 136).** Table rules are the points-scoped keys, `pointsMap` and the
    `tiebreakers` column; a key locks when a stage that inherits it has started; refused keys are dropped and listed
    in `refused`, the rest saves, and the final config is parsed again.
  - **D12 — one points describer.** `pointsLine(rule)` in `apps/web/src/lib/points-line.ts`, read by the public label
    and the stage points preview.
  - **D13 — stage creation.** `withStageDefaults` at both stage insert sites; `replaceStages` merges defaults and
    carried rules per key. As built, the carry also keeps an organiser's removals and the slot's stage points
    (controller rulings R-T12-4, R-T13-1).
  - **D14 — the rules version (ruling 135).** Bumped by `refreezeFixture`, sent by the two scoring pads, checked in
    `appendEventInTx` only when sent; a source scan classifies every events POST site. As built, every write that
    changes a fixture's effective rules bumps it (controller ruling "Rules version"; ruling 144).

## Controller rulings (execution, W1c)

These are decisions the W1c controller made while executing an owner-approved plan. They are **not owner
rulings** (class 17). Each carried a "cost if wrong" line in the SDD ledger. Two ledger entries are left out
because they are owner rulings: the batching (ruling 41) and the enumerate-everything direction (ruling 42).

- **Global.** No cherry-pick. The branch was cut from the plan tip, so Task 1 Step 0 only verifies the log.
- **CLI flags (Task 6 against Task 12).**
  - `--layer L1` defaults the width to 1280 and refuses any other.
  - `--layer L2` refuses `--width`.
  - A plain `--driver browser` run still requires `--width`.
  - Task 12 fix round: a plain browser run at a phone width is labelled by `layerOfWidth`, never L1.
- **Parity scope (Task 13, superseding the earlier Task 13/14 ruling for a separate `w1c-http-l1` run, which was
  never made).**
  - Parity compares the BROWSER run's planned case set.
  - HTTP cases outside that plan are a count, not diffs.
  - Zero common checks still fails.
  - `notDriven` = unmapped AND 🚫/░ AND 0 checks.
- **Task 1.**
  - Fix the plan-mandated finding, even beyond the brief's identifier-only arm.
  - Fold in reviewer minors 2 and 3 and the computed-key escape.
- **Task 2.**
  - Q1: replay fences = `fencesOn && fence === null`.
  - Q2: widen to `model/commands.ts` and the model fake. The judge receives the caught refusal. A named fixture the
    model does not hold records a finding.
- **Task 3.** Move `L2_WIDTHS` to the leaf `lib/widths.ts`, so render and the browser path do not pull in the
  catalogue.
- **Task 4.**
  - `KNOWN_TRANSITIVE` pins `seed.ts ← plan.ts` rather than refusing it.
  - Fix C-1 and I-1 through `closure()`.
  - Fold in M-4 (`Ends on *`) and M-5 (the wait-failure label).
- **Task 5.** Fold m1–m5 into one fix round, because each would have surfaced as a misdiagnosed red in Task 8.
- **Task 6.**
  - Dynamic-import edges into `lib/browser` are pinned by an exact set.
  - Finalize parity compares ledger rows, never routes.
  - `UiTable` pool identity is read or pinned, never assumed.
  - The freshness window is read from product constants. After the window a difference is a FAIL check, never a
    thrown refusal.
  - Rule-override cases on the browser driver become a named-wave deferral.
  - Fold in six minors.
- **Task 7.**
  - Accept the `NoPadAdapter` named error. `PAD_ADAPTERS` must cover all 11 sports.
  - Task 7's truth-run artifacts stay untracked. Task 14 owns the committed evidence.
- **Task 8.**
  - The Step 7 review is dispatched by the controller.
  - The M-6 hold-value preflight and the hydration wait land in Task 8, test-first.
  - Step 4 verdicts: at 1280, split across read-only screen agents; at 320, read by the controller from contact
    sheets.
  - Commit only finding-evidence PNGs.
  - E-2: a reused run id is refused at start. The DB-side slug refusal goes to W1d.
  - O-1: the browser keeps `generate` until a browser generate creates fixtures.
  - Fold in the `?dpl=` chunk-URL refusal.
  - C-2: an after-shot identical to its own before-shot is a defect. A before-shot equal to the previous step's
    after-shot is expected.
  - Fix round 1 goes to a fresh implementer.
- **Tasks 9–11.**
  - I-1: a fallback is judged (`Fallback.judge`), never waved through.
  - D-T9-2: `rosterlessTeams` for PADPROOF only. LIFECYCLE and every other scenario keep deferring team rosters to
    W1-driving.
- **Task 12 dispatch.** The API-only set is planned 🚫 `{wave, reason}` ("API-only abstain"). This departed from D7
  as accepted; owner ruling 43(b) (2026-09-30) accepts it.
- **Task 12 carry.** `LayerCase.noPath` is `{wave, reason}`.
- **Task 14 carry.** Run the width sweep on a knockout cell. Owner ruling 43(a) (2026-09-30) accepts it.

## Controller rulings (execution, W1-driving)

These are decisions the W1-driving controller made while executing the owner-approved plan (ruling 54). They are
**not owner rulings** (class 17). Each carried a "cost if wrong" line in the SDD ledger
(`.superpowers/sdd/2026-09-30-format-matrix-w1-driving/progress.md`, gitignored). Only the ones that change what
a check means or where a finding goes are listed here. SHAs are post-rebase (the branch was rebased onto
`58e8103e3` on 2026-10-01, before Task 15).

- **T6-R1: the bracket draw stall is a product red, not a harness one.** The harness posts a draw wherever the
  engine's `supportsDraws` declares one legal (R9). The stall was first routed W4. **T15-R4 amended that to W2**,
  because design §8 puts SC-O1/SC-O2 there and the spec outranks a controller ruling.
- **T6-R2 (FP-5): every reached stage is asked to complete exactly once**, drained or not, as W1a's test pins. The
  plan said a non-drained stage is never asked. That line is superseded. The triage coverage table was re-derived
  for it.
- **T7-R1: F1 on a ladder.** `f1-round-size` abstains by name, because a ladder declares no rounds. Instead F1
  asserts that the 7-entrant bottom-up sweep completes with n−1 challenges and that every entrant is in
  `finalRanks`. The cell is given a meaning, not dropped (ruling 42).
- **T8-R1: the refused-form `mexicano-pair-entrants-counted-as-players` signature is stamped only on the product's
  own cause** (`entrant_members_pkey`). Any other 5xx stays unsigned and goes to harness-first triage.
- **T8-R4: mexicano R4 is judged from what each run shows.** The kept-playing signature is written if and only if
  seed 3 is seated after the withdrawal. The verdict can differ between runs, and the evidence says so beside it.
- **T9-R1, T9-R2, T9-R4.** I9 judges the order of ACTIVE entrants; the withdrawn entrant may be present or absent
  (ruling 53's note). I10 reds a completed stage with null `finalRanks`. Its rank-item skip on a stage that did
  not complete is allowed only as a NAMED note.
- **T12-R1: the americano entrants-only save.** The config probe saves the kinds actually in use. The product's
  refusal to narrow the kinds while minted pairs are active becomes a predicted W7 note
  (`americano-minted-pairs-block-kind-edit`).
- **T12-R3 and T12-R4: a timed-out shared turn aborts the run by name** (exit 3). Cases still mid-scenario then
  finish but are excluded from the evidence, so a late 401 cannot be credited to another case.
- **T13-R1: `livePlan` reads `--set w1-driving-l1` and `--set w1-driving`**, so committed W1-driving runs are judged
  against frozen plans.
- **T14-R1: a vacuous swiss model cell stays exit 1**, and is re-run at 40 runs with a recorded seed. It is never
  counted as a pass.
- **T14-R2: `--regressions` without `--cell` replays every committed case.** A skipped case is a printed, counted
  verdict.
- **T14-R3: one shared lineup planner** feeds both the harness and the model, with a differential test as the
  witness.
- **T15-R1: the whole-branch review is the controller's**, not the Task 15 implementer's.
- **T15-R3: the parity pair is replaced.** The plan's pair (HTTP slice against L1) shares 0 cells. The accepted
  substitute is `w1drv-l3` against L1: 6 shared cases, 0 state or verdict differences
  (`truth-runs/w1drv-l1/parity-l3-vs-l1.md`).
- **T15-R4: P1 (the bracket draw stall, 62 cases) routes to W2.** Task 16 applied it to TRIAGE's wave column.
- **T15-R5: the two new model reds are committed as MB-007 and MB-008**, matched on the product's own words.
- **T15-R6: the americano/mexicano `r4-policy-reported` expectation is DERIVED** from what was pending at the
  withdrawal, or it abstains by name. A fixed `policy !== "none"` could never go green.
- **T15-R7: P5 (the stepladder R4 422) routes to W4**, not W5: design §8 lists stepladder under W4, and the root is
  MB-002/003's.
- **T15-R8.** Every TRIAGE row names the run it is judged on. P1's ≥1-draw precondition is committed as data. G-4:
  the duplicate signature needs the repeated person to belong to an earlier pair entrant. G-1/G-2 went to Task 16.
  G-3 is carried to W4.
- **T15-R9: `r4-not-seated-later`.** After T15-R6, a withdrawn person seated again on mexicano would have redded no
  check: a confirmed defect would have gone silent (class 6). The check reds when any of the withdrawn entrant's
  persons is seated, through any entrant, in a round after the withdrawal. The kept-playing signature covers it.
- **T16-R1: Task 16's scope.** It is the brief's steps plus every open carry, T15-R4, T15-R5, G-1, G-2, the T15
  re-review minor, T14-R4 m-2, G-3 and T15-R9. Memory files are the controller's to write.
- **T16-R2: the rate-limit carry is a W1d recommendation, not a refusal** (the harness cannot see Redis, so a
  refusal would be a guess), and MB-009 is accepted.
- **T16-R3: a fence guards only the trigger branch its cases show.** The double-elim arm of
  `ko-generate-after-roster-change` was narrowed to the added-entrant branch (MB-007's). The G-1 test reads each case's
  branch from its finding commands and asserts branch × stage kind. The live re-run that followed found MB-010.
- **T16-R4: the review's seven minors are all fixed**, the findings-table generator is committed with a test, and
  the owner's 2026-10-01 decisions are numbered (rulings 55–59).

## Controller rulings (execution, W2c)

These are decisions the W2c controller made while executing the owner-approved plan (ruling 141). They are **not
owner rulings** (class 17). Each carried a "cost if wrong" line in the SDD ledger
(`.superpowers/sdd/2026-10-13-format-matrix-w2c/progress.md`, gitignored). "(overnight)" marks a ruling made under the
owner's "apply any rec" (ruling 142). Only the ones that change a product rule, what a check means, or where work
goes are listed. Commit SHAs are omitted: the branch was rebased four times.

- **MD-1 scope (Task 22, 2026-10-20, revised the same day).** W2c classifies every Survived and NoCoverage mutant on
  the LINES it adds or changes in every engine file it edits (the shape of W2b's ruling 109), plus
  `competition/points.ts` in FULL, because W2d's plan assumes it done and it is cheap. Older survivors stay with the
  owning wave in the "Mutation-debt exit gate" table: the sport modules and kernels, `core/*` and `sport/module.ts` go
  to W2e. W2c's own row (`competition/stage.ts`, `competition/progression.ts`) is unedited, so it holds 0. Why: the
  plan's "every survivor in every file W2c edits" (at least 3,800) contradicts the owner's table, and the table wins.
  This applies owner ruling MD-1; it was not put to the owner. Result: 69 classified (37 A-real, each killed; 5 A-msg;
  25 B-equivalent; 2 C-dead), 0 unclassified.
- **T2-I2: a withdrawal before play locks the division keys its stage inherits.** The stage counts as started, because
  the forfeit freezes that fixture's snapshot; the copy keeps "has started".
- **T2: `tiebreakers: []` is a real change, not "no tie-breaks".** `division.tiebreakers ?? defaultTiebreakers` makes
  `[]` an empty cascade, so it is refused once an inheriting stage has started. The first ruling (`[]` ≡ `null`) was
  retracted.
- **T4: Q5 decides what one match may change.** X-SR-2's bound covers every declared decider (read from
  `decider: true`). Cricket `superOver` and the period `overtime` / `shootout` objects are stage-only. Match-scoped are
  football `extraTime` (off or shorter) and the leaves football `shootoutAttempts`, period `overtime.minutes` and
  `shootout.attempts` (shorter only). The first X-SR-2 ruling, which let every decider shorten per match, overreached
  and was corrected.
- **T5-M1: `awardScore` stays points-scoped.** In a knockout it changes only the recorded forfeit score, never who
  advances.
- **W2c's migration number.** Written as V439; V443 so chess's V439–V442 could deploy to shared staging first; V462
  after the 2026-10-16 rebase (main at V450, chess reserving V451–V461); V463 on 2026-10-18 (r2 PR #981 took V462).
  From 2026-10-19 it is main's maximum plus one at the pre-PR rebase (V469, or V470 if #1005 merges first): the second
  to merge takes the higher number.
- **T7 (overnight): carrom `share` is refused unless the tie board is "draw".** The carrom mirror of P-5 (ruling 139);
  the refusal names the tie-board setting.
- **T7 (overnight): one stage-completion predicate.** A held abandon (`rowAwaitsSettle`) reads `in_play` at all three
  completion reads; an expunged abandon is closed (ruling 105). An explicit complete whose only blocker is a held
  abandon is refused `STAGE_NOT_READY` (`abandoned_matches`); held plus unplayed together is a soft not-ready, the
  unplayed match first.
- **T8 (overnight): chess `tiebreakRungs` is the decider.** An empty list holds a drawn game for the organiser, and
  `tiebreak` is no longer organiser-settable, because BG-KO-1 and BG-KO-3 make the list the authority. The first
  overnight ruling, that the fold enforces rung order, was withdrawn (ruling 132).
- **T9 (overnight): under a stage points rule, the rule's award reaches the table on goal sports.** The award assigns
  each module's score keys (`awardScoreKeys`); set sports export `pointsRuleAwardReachesTable = false`, and the stage
  points editor says so. Why: X-PT-1 says the award "replaces", and making that true beats hiding it.
- **X-WO-1 (overnight; built in Task 16b): one number everywhere.** Under a stage rule, the walkover's headline, the
  table and the public line all state the rule's award. A rule change after a recorded walkover is refused
  `STAGE_FORMAT_LOCKED` (16b's deviation, sanctioned).
- **T11 (overnight): a save never silently drops a match's own format.** A stage or division save that would leave an
  unstarted match's override unfit is refused by name (`FIXTURE_OWN_FORMAT_NO_LONGER_FITS`); a delete that would take
  it away (a rebuild, Undo of a generation, a pool clear, a Swiss reshape) is refused `FIXTURE_HAS_OWN_FORMAT`.
- **T14 (overnight): a fixture with an outcome or a locked status is started, snapshot or not.** An event-less award
  must fit a correction, and a bye answers `FIXTURE_FORMAT_LOCKED`.
- **Batch 3 I1: saves rewrite event-less walkover scores, never refuse.** A stage or division save rewrites them in the
  same transaction (a walkover has no play to misfit, and the winner never changes); an unfit one answers 409
  `FORMAT_DOES_NOT_FIT_PLAY`.
- **R-T12-1: a period sport's stage can turn a decider off.** A stage `false` for ice hockey or hockey `overtime` /
  `shootout` resolves to engine `null`; `null` or absent at the stage still inherits.
- **R-T12-2: a division variant change re-seeds presets on unstarted bracket stages,** in the same transaction. A
  stored key equal to the old variant's preset takes the new one's (or is dropped); new preset keys are written;
  organiser-changed keys are kept and re-checked.
- **R-T12-3 and R-T12-3a: the matrix harness layers `stageDefaults` exactly as the product does.** A held-knockout cell
  switches every decider off explicitly (X-SR-6's held arm), and each affected sport (football, hockey, ice hockey,
  cricket t20) gains a positive pair in which the presets send a level knockout to its decider, read from the engine.
- **R-T12-4 and R-T13-1: `replaceStages` keeps an organiser's choices on a matched slot.** It never re-seeds a key the
  organiser removed, and it carries the slot's `config.points` as it carries `rules`; a new slot gets the presets and
  no points. `config.points: null` means no points for that slot (batch 4 M6).
- **R-T13-2 and R-T13-3: `replaceStages` is one transaction, with its gates before the delete.** Any refusal (a 402,
  a duplicate-seq 409, `validateStageProgression`) rolls back instead of leaving the division with no stages. No
  production repair was owed (owner, 2026-10-14: "we don't have data in prod now").
- **R-13b-1: a top-level stage decider is a named 400,** its key set derived from the engine's deciders, at the create
  and PUT doors and in the zod layer.
- **Batch 4 N1: one lock order.** The division advisory lock first, then any row lock, in `patchDivision`,
  `putStageRules`, `replaceStages`, `createStages` and the preset reseed; `insertStageBatch` reads the division
  `FOR NO KEY UPDATE`. A deadlock (40P01) had been reachable through the public API.
- **Rules version (Task 15, batch 5).** Every write that changes the rules a fixture resolves bumps `rules_version`,
  before kickoff too: otherwise a pre-start correction let the first taps fold under the old rules. A write that
  changes no rule (a rename) does not bump. A table-key save on a played knockout bumps the event-less walkovers it
  rewrites; only a feederless bye is excluded. Ruling 144 keeps table-only key saves bumping.
- **Boardgame's MAJOR fold epoch is kept.** BG-KO-2 refuses a colourless Armageddon, so boardgame takes a MAJOR in
  W2c; no client sends `engine_epoch`, so no user pays for it (ruling 145).
- **Every fix round re-runs every mutant list whose finds name a touched file** (process, batch 3). Stranded lists
  recurred four times (T5's t2, T9's t5 and w2b/t13, T10's w2a/t6).
- **Batch 6: the DENIED scan follows the gates into `assertStageBatchGates` and asserts a count above zero.** A text
  pin cannot see a gate that moved. `points-w2c` keeps a single-sport pin, with its reason.
- **Task 23 order: rebase before the scoped gate and the final review** (2026-10-23), so both run once, on the tree
  that merges. e2e is dispatched on CI; smoke runs on the PR's CI.

## Controller rulings (execution, W2d)

These are decisions the W2d controller made while executing the owner-approved plan (ruling 196). They are **not
owner rulings** (class 17). Each carried a "cost if wrong" line in the SDD ledger
(`.superpowers/sdd/2026-10-20-format-matrix-w2d/progress.md`, gitignored). Only the ones that change a product rule,
what a check means, or where work goes are listed. SHAs before 2026-10-28 are pre-rebase.

- **Rule ids and their status (Task 0).** Cricket and carrom ids take the file prefixes CK- and CA- (Appendix A said
  CR- and CM-), the W2c convention; the wording is unchanged. The rows carried ruling 75's number until the fold, which
  gives them ruling 197.
- **Task 0 Step 5 is void.** W2c merged without the `soBonus`, wider `STAGE_POINTS_REPLACES` and `divisionRefusals`
  changes, and f-w2c is closed, so W2d made those edits itself (Tasks 3 and 10; plan finding PF-13).
- **Pre-flight scan PS-1..PS-10 (2026-10-24)** applied to the plan (`6a0da4192d`, PF-15). The one golden exception
  (PS-1): Task 3 re-records the football and period shoot-out corpora on the GOLDEN-POLICY honest path, an isolated
  `REBASELINE_GOLDEN=1` commit plus `FOLD_EPOCH` majors (football 2→3, hockey 2→3, ice hockey 1→2; Task 18 then hockey
  3→4). Recorded configs convert by spec §5.4's own mapping `soBonus = shootoutWin − draw`, so every delta stays byte
  for byte. PS-7a: `loss.unplayed` is reachable only where the sport declares it (table tennis).
- **An organiser's No-result abandon is not a payable outcome in W2d (Task 1).** `core.abandon {noResult: true}`
  folds to no outcome, owes no settle and stays out of the table, so `reachableResultKinds` keeps `noResult` for
  cricket only (cricket's NR is its own result kind); PS-5c is withdrawn. A test pins an online chess no-result board:
  no row credit, table unchanged.
- **Set-score maps (Task 2).** I1: a `bySetScore` map is refused on a sport that declares no reachable set scores. I2:
  a settled abandon of a set match pays by FIVB 6.4.3, the key is `setsToWin`–(winner's sets lost), always a
  reachable regulation key (the owner confirmed it, ruling 214).
- **One pre-release data audit (Task 4)**, owner-visible: unknown `outcome->>method` per sport (`decidedInFor`
  throws on one), invalid tie-break keys in `divisions.tiebreakers` and stage configs (`cascadeFor` throws
  `CONFIG_INVALID`), chess non-Swiss stages listing `sberger`, and later active or complete unpinned stages and old
  `{base}` stage rules (both 0 expected). Task 7's staging check is owner-run and joins it.
- **Sonneborn-Berger off Swiss uses fixture game points only (Task 4)**; carried-over points are table points, not
  games in this pool. A forfeit as a direct encounter is a parity pin (there is no FIDE C.07 forfeit digest), and the
  played case cites C.07 art. 6.
- **`countedFixtures` counts per POOL, carried openings included (Task 5).** A pool is the ranked table; plan :782
  ("the web passes countedFixtures") is withdrawn.
- **The qualification read (Task 7, I-1).** `public_stages_v.points_rule` stays the stage's OWN rule; Task 9 round 1
  dropped the interim `table_points_rule` column in place.
- **Where the pin is written (Task 9).** I1: wherever a stage leaves `pending`, including before a complete write
  (`completeStageIfReady`, `completeStage`, auto-advance), and the census counts every writer of an `active` or
  `complete` status; adding a fixture to a pending stage is not refused. I2: one idempotent post-deploy script,
  `scripts/w2d/post-deploy-pin.ts`, which never changes what a scored stage reads (round 3: such a stage is held,
  listed and exits 1). I4a: a repin derives `crossGroup` exactly as `resolveTableRules` does. I4b: a saved `null`
  clears the stage's own layer to what the division shows now. The owner approved I1–I4 (ruling 200).
- **A division save never moves a scored table (Task 10, I1).** Before a save that changes what an inheriting stage
  reads (order, cfg points, fair play), every locked unpinned inheriting table stage is pinned with its current rules
  and listed in `stagesKeptPinned`. I4: the `standings.custom_points` and `tiebreakers.custom` gates are deleted
  (all scoring is free, ruling 177); the proof is a Community behaviour test, not a gate-absence pin.
- **TN-TB-2 un-held (Task 11).** Tennis re-baselined on the GOLDEN-POLICY honest path in its own commit: a signed
  Appendix A row, exactly one stream, input unchanged.
- **The tie-break key labels move into PR A** (merge-fix), strings only: raw keys on a public page are a defect, not a
  caption gap. Task 17's columns, lots note and captions stay in PR B.
- **The engine boundary (PR A rebase).** `SET_SCORE_KEY` moves to the end of `sport/module.ts` and `points.ts`
  re-exports it: a sport file may not value-import `competition/` (the phone closure).
- **PR A's final review I1 is fixed in PR A, not listed as a limitation**: the card previews the pin's points for a
  pinned stage with no own rule, and `division-locks-w2c.spec.ts` is rewritten to W2d's loosened lock.
- **R27 on PR A.** 43 of 46 regressions were the harness's I3 summing the old `standingsDelta` points (fixed in
  `b09c5460a8`); the other 3 are main's #1027 (ruling 210).
- **Stryker per engine task** (from Task 14, the controller's application of ruling 211); Task 20 re-measures
  `tiebreakers.ts` and `points.ts` in full and sweeps only PR B's engine lines.
- **The table-rules single-resolver scan (Task 15).** The scan reported only its first pattern; a model ternary
  rewritten to dodge it was scan evasion, reverted, and replaced by a named exemption that fails when stale. Lesson:
  source scans import nothing, so a gate picked by imports misses them; every web task's gate includes the engine-db
  source-scan tests.
- **HK-TB-2's ranking half is Task 14's** (plan :1146/:1231, PS-2: the API producer exists); Task 18 keeps the pad
  chips and the strict refusal.
- **Task 17 I1**: the partial-schedule and lots note is written whenever spec §5.6 binds it; Task 12's pinned "no
  note" expectations froze a bug (class 4). I3: chess "1½" and the level table reach every surface (slideshow, OG,
  posts; RB2B-17).
- **The preset "Pro League" is relabelled "3 / 2 / 1 / 0 (shoot-out)"** in all four locales (`da7f67c300`), not
  exempted from the retired-plan-copy scan: "Pro" next to a qualifier reads as the paid Pro plan while every stage is
  free, and the neighbouring preset is the numeric "3 / 1 / 0". The translator pass covers the wording.
- **Concern 2's build (ruling 217).** One helper, `refoldStageTable`, over the existing `REAL_TABLE_KINDS` (no second
  predicate): a generate and a seed confirm refold with `emptyFold: "skip"`, a roster delete and Unpair with
  `"drop"`; setup-progression placeholders get no table; the generate refold is best-effort (a logged deviation). The
  organiser export skips a level or empty table (404 `STANDINGS_NOT_AVAILABLE`, `documents.standingsUnavailable` × 4).
- **Task 19.** The division order is set through `PATCH /divisions` (Settings has no division order editor, confirmed);
  I2: three editor-driven stage-points walkthroughs on rigs where the stage rule differs from the default (hockey,
  chess 3/1/0, cricket tie and NR), each asserting the PUT body, `source: "stage"` and the pin.
- **Task 20's scope**: PR B's engine source is only Tasks 17 and 18, already swept, so the delta sweep is empty; no
  Stryker re-run after an engine-neutral rebase.
- **The fold (Task 21).** `AWAITING_PROOF` is emptied. Seven signed rows whose cases carry the id only in a data title
  (`it(c.title)`, invisible to the checker) are proved by naming them in the group or test title that runs those cases
  (`tables-rulebook.test.ts`, `defaults-sweep.test.ts`); a mutant that drops one id from the title reds the checker.

## Controller rulings (execution, W2e)

These are decisions the W2e controller made while executing the owner-approved plan, most of them under the owner's
standing delegation (ruling 240: "take a decision as a product owner"). They are **not owner rulings** (class 17); those
marked "PO decision" are the controller's reading as product owner and are reported on the owner's next status ask. Each
carried a "cost if wrong" line in the SDD ledger (`.superpowers/sdd/2026-10-28-format-matrix-w2e/progress.md`,
gitignored). Only the ones that change a product rule, what a check means, or where work goes are listed. Rulings 221–239
are W2e's D1–D19 (ruling = 220 + D); the W2e rule rows were signed as `W2e-D<n>` (false premise E27) and are rewritten
to those ruling numbers at this fold.

**Plan, order and lanes**
- **Pre-flight scan F1–F17 and D-1–D-6 accepted** (`preflight.md`). The ones that moved work: the real-module sanction
  sweeps move from T1 to T3 (set kernel) and T4 (nested) so each asserts its own count above zero (F1); T2 runs after T3
  and T4 (F2); the catalogue is regenerated once, at T24, and PR B's at T36 (F6); recorded streams that the strict fold now
  refuses are re-recorded by the GOLDEN-POLICY per-stream floor-batch script, never `REBASELINE_GOLDEN=1` (F12); a
  `core.forfeit` is declared `noControl` for badminton, tennis and volleyball in PR A until the pad sends it in PR B (F9);
  the generator gets `pathWitness` instead of one invented witness per sport (F8); `sanctionEnd.at` is dropped (D-3).
- **Rule rows' red step** is "mutate the engine line the row's `enforced at` names, once, and see the test red", not a
  vacuous failing-first run (F14); a record-only row is one test per sport titled with all its ids (F15, ruling 227).
- **Parallel lanes** E-a, E-b, R, H in their own worktrees, integrated by merge at each batch end; model split per the
  owner's instruction (overrides the "W2c-only" label on the `*-sonnet` agents); the full-suite step of the implementer
  template is overridden by the scoped-tests rule. **Two PRs**, as the owner delegated: PR A (T0–T26) merged as #1068;
  PR B (T27–T36) is #1069, stacked on PR A until it merged, then retargeted to main.
- **Freeze order:** T25 done → merge main → whole-branch Opus review and engine-source fixes → FREEZE (`6ccfa0767a`) →
  raise PR A with CI and a dispatched e2e → merge. PR B then proceeds on the frozen tree (ruling 241).

**Engine and rows**
- **Sanction endings.** "Pending" has one definition, decided- and abandon-aware, and the fold calls the same predicate
  (`pendingEndingSanction`, `core/sanction-ending.ts`), so the route and the pad never prompt on a finished or abandoned
  match (I-1); the `ENDING_SANCTION_PENDING` refusal is skipped while an abandon is live (I-2); `error.data {by, level}`
  claims were false and are deleted from the docs (I-3). The D13 check reads the ledger up to the request's
  `expected_seq`, so a keyed retry gets its original answer. An official scorer may resolve a legacy
  `[sanction, suspend]` ledger by voiding the suspend and recording the ending; the device link cannot. The exception
  covers both device link and official scorer (A0.9 item 5).
- **Shoot-out order is two rules** (A0.4): FIH alternates the starter per series of five attempts; IIHF keeps the same
  starter for every tie-break duel. T9 fixes both; the football pad crash is fixed in-task by exporting
  `footballNextKicker`.
- **Cricket write refusals (D8).** A bowled (not allowed) dismissal on the no-ball delivery itself (CK-NB-1, ICC 21.18) and
  the six modes ICC 22.9 refuses on a wide (CK-WD-1) are refused on the write path only, with lenient replay. A non-striker
  "hit the ball twice" on any delivery is deferred (rare, owner 10-26). Revised overs without DLS are treated as ICC
  16.10.7 "applied at an earlier stage" (same credited operands when no par adjustment).
- **Deviations stated, not fixed:** hit the ball twice on a free hit is refused (CK-FH-1, deviation); the IIHF
  departures (a penalty-shot goal releases a minor; coincidental minors release; a double minor is not shortened;
  stacked clocks run together) and IFAB's sin-bin-from-restart are deviation rows with `limit` tests, because they move
  strength and power-play labels, not the score (D8's test is "can record a wrong result"); the tennis tie-break game
  penalty is entered as points (TN-SE-2); CA-DG-1 (a drawn game after `maxBoards`, against ICF 56(b)) is a deviation;
  CK-RR-1 and CK-CR-1 are deviation rows (D18, D7); X-DV-1 is reworded to the engine fact (a level result on a bracket kind
  is `LEVEL_RESULT_IN_BRACKET` for generic and `needs_decision` elsewhere); no new door refusal.
- **Row ids.** `CK-NRR-*` cannot exist (the area must be two letters), so the rows are CK-RR-1 and CK-RR-2 (E28); CK-BO-2 is
  used because CK-BO-1 was taken; a rule row's status is the ruling of its D (E27).
- **DLS and super-over fields are held, not hidden.** A new "switch host" notion lets `detailOf` name a switch, so the
  DLS-dependent `minOversForResult` is disabled while DLS is off (PO decision I1) and `superOverStillTied` while the super
  over is off (T7: `appliesTo` declared in the engine). `minOversForResult` applies to t20, odi and hundred only (a Test
  has no DLS) and a Test stage refuses it with 400 `RULE_NOT_SETTABLE`. A value equal to the overs is accepted but inert
  for abandonment (PO decision: no editor maximum; rare).
- **Migration V481 (T13b)** strips `shootout.suddenDeath`, `progressScore` and pins Fast4 `set.tiebreakWinBy` to the margin
  each layer plays today (`tiebreak.winBy`, 2 when absent), never a literal 2. Its fail-loud count covers a below-floor
  set target and a Bo1 with a match tie-break in divisions, stage rules, fixture overrides, fixture snapshots and
  `match_states` (PO decision: not divisions only, a legacy below-floor stage rule would deadlock the saves). The
  hockey/ice-hockey deploy-window 422 on a Settings save is accepted and listed LOUDLY (ruling 238); the 71 pinned rows
  are cleaned by T13b.
- **FOLD_EPOCH.** Table tennis MAJOR 1→2 (corpus only); tennis MAJOR 2 from T4 with no second bump at T5; PR B adds football
  3→4 (the lineup-retirement fix, below) and `STATS_FOLD_VERSION` 6→7. Replay stays lenient (anti-goal 1).
- **A match tie-break (MTB) deciding a "final set" is counted under `tiebreakSet`** unless the engine's own `decidedIn`
  vocabulary names it differently.
- **Football retirement (PO decision I-1).** A substitute who came on via `football.sub` and is then injured with no subs
  left MUST be retirable (M12b's core flow): the engine judges `core.lineup.retirement` against the squad the pad shows, so
  `football.sub` swaps count. Lands in PR B, so PR B's epoch and golden diff grew (cost accepted).

**Web (PO decisions)**
- All stage-rule field labels, help and options are localized in the four locales (standing rule); the 303 es/fr/nl strings
  ship with W2e and a native-speaker pass is a post-merge follow-up, not a merge gate.
- The carrom pad offers deductions only down to the side's current score (an offered control that always fails is
  anti-goal 3); CA-AD-1 says delta 0 and a deduction below zero are the schema's `INVALID_EVENT`, only |delta| above
  `gameTo` is `ADJUST_OUT_OF_RANGE`.
- Scorebug halves stay real buttons under the sanction prompt (aria-disabled, no hint, no hover) so a tap still shows
  `pad.ending.blocked`. "Record the ending" is also offered to organisers in the console. A device-link "Void the
  sanction" is lost after a pad remount (chrome's "Void my last entry" still voids it): accepted, rare.
- The stage editor shows the Bo1/floor refusal on save (localized) rather than inline; the 3×15 date hint shows only until
  2027-01-04 and is derived from one constant; retirement is one tap plus Take back, no confirm; a retired football player
  returning to the bench, and a failed second volleyball append that leaves a sanction un-ended, are rare and accepted.
- The volleyball field-six title wraps a 31-character team name at 320 (accepted); the hockey board's Home/Away offset by the
  one-cell "Advance period" tile and tennis's Take-back ribbon clamp at 320 are pre-existing (accepted). The cricket
  held-reason copy repeats the help sentence: one key × 4 locales, fixed after T36.

**Harness and gates**
- `--sample` (T18) counts but does not refuse skips; regression-only; excludes `--expected-skips`; the default stays strict
  so the truth run cannot skip silently. `RESCUE_BUDGET` 50k→500k so the catalogue can regenerate (T24). `resolveSportCfg`
  applies `writeConfigIssues` before the regen: 130 cases are now refused at the doors (61 VB, 44 TT, 25 TN).
- Matrix pad adapters get no `core.lineup.retirement` route (`TapStep` has no person pick; L2 fixtures are rosterless) and
  no pad DLS-revise route (no DLS-on variant; the More sheet has no testid): both stay NOT BUILT in the matrix and are
  covered by e2e (football/hockey) and unit (VB/IH); the README lists them. `W2E_DLS` on the builder default (DLS off)
  uses the API-only manual-target revise.
- **Truth run (T35):** CI 40874582041 15/15; judges against `w2b-final`: L1 209/0, L2 1625/0, L3 845 with EXIT 1 for two
  SW-H1 Swiss "round 5 paired nobody" lot flips (`swiss_knockout|carrom` R4, in ruling 70; `swiss_playoff|football` R4),
  accepted as the known Swiss flake (W2e touches no Swiss pairing; the Swiss shells programme owns it). Skips accepted
  and named in the README: chess americano and mexicano blitz (#1027, 10 ids), L2 M4b slot re-pick (20), one cricket
  re-index. No git tag is cut for `w2e-final`.
- **Known reds:** the `stryker-floor` stale rows (21, none touched by lane W) were PR A's T25 re-key; the R26 single-sport
  ratchet reds were W2e's own Hundred tests (fixed in PR A with `// single-sport: <reason>` lines).

**MD-1 (ruling 230)**
- **The source-reading test `outcome-methods-source.test.ts` (X-PT-2) read instrumented source** under Stryker, so every
  sports leg's dry run failed; fixed inside W2e (test-only, `outOfSandbox`, `c055bb5d7c`). The sizing run (`40741725312`)
  left core-2 OOM and ten legs cancelled at the job timeout; the mutation session (owner chose (a)) re-measured the drifted
  legs on PR A's tree on `chore/w2e-stryker-measure`, merged into PR A.
- **PO decision (spec §14, T25 step 2): W2e closes the survivors on the lines it changed; the 369 survivors (70
  NoCoverage) on §11(b) result-deciding paths that W2e did NOT change are pre-existing mutation debt, parked to the
  mutation session** (`size11b.json` and `ranges11b.txt` are its input), not a W2e merge gate. This reads ruling 230's
  "whether W2e changes them or not" more narrowly than its text; the owner has not been asked. T25's result: changed-line
  survivors 34 → 5 (the 5 are unrecordable, their key is shared with a killed mutant), 18 killed, 29 new equivalence rows
  and 27 re-keyed, 305 rows, 0 position faults.

## Decision log

- **2026-09-27** — five read-only audits (~150 gaps), offered-cell map (no door
  restricts sport × format; 37 cells unfit), bench reuse assessment. All saved
  under `audit-2026-09-27/`.
- **2026-09-27** — spot-checks by the orchestrating session (code read, not
  product-driven): SW-H1 (`swiss.ts:280` returns an empty round), SW-H2
  (`lib/swiss-rounds.ts` has no production caller), FX-G1 / #879 (Generate
  inserts by `extKey` position, `stages.ts:2509`; the button's comment calls it
  "routine, safe"), SC-X1 (`append-event.ts:334` refuses only `draw`), ST-G5
  (`stage.ts:178` pool membership = entrants with a result), SH-G1
  (`print-scorer-sheets.tsx:95` sends only `{date}`), americano console writes
  `generic.result` (`americano-panel.tsx:162`) and `americano-night.json` is
  tennis.
- **2026-09-27** — independent spec review (reviewer agent): Approve with
  fixes, 34 findings (5 High), none contradicting a ruling; all applied in the
  amended design (states ⏳/🚫/░, committed applicability, invariant
  preconditions, Swiss reference scope, single owner per gap, entitlement
  dimension, cost recount). Review kept at `audit-2026-09-27/spec-review.md`.
- **2026-09-27** — plan-facts scouts: the bench has **no run-time event
  simulation** (packs replay recorded streams; stream generators for all sports
  are new work); `run-suite.ts` is one ~4,100-line function (split dropped,
  ruling 17); no create-from-template-key endpoint; no quick-result endpoint;
  disqualify does not cascade; triple_rr from the builder may come out as one
  leg (hypothesis). Facts kept under `audit-2026-09-27/plan-facts-*.md`.
- **2026-09-27** — the repo is PUBLIC again (`gh repo view`), so standard
  runners are free; the earlier $85/run estimate assumed private.
- **2026-09-27** — design fixes from the session-prompt pass: #840 + FX-G13
  move to W3 (first wave needing Rebuild; W5 consumes); anti-vacuity counts
  move into W1a; division-level 🚫 (D1, D2, R13) owned by W9, D4 and Q4 by W4,
  C5 by W5; SC-P11 futsal is not a matrix row unless W2 builds it; "harness-
  green" defined for the three dispatches before the weekly schedule
  (recommendation). Collision to watch: ST-G22 (W10) and ST-G6 (W5) both edit
  `org-posts.ts` — W10 should ship ST-G22 before W5 starts.
- **2026-09-27** — W1a plan written (`54626389e`). Planning found 8 false
  premises (listed in the plan): an org-create route exists but is quota-capped
  (24/run) so SQL seeding stays; `double_elim` is free on community since V393
  (no public plan yields a denied state); the bench preflight only checks the
  data directory when `BENCH_EXPECTED_DATA_DIR` is set (made mandatory);
  `plan.ts` loads `pack-schema.ts` at runtime; ladder has no per-round
  generation (challenges only); `format-templates.ts` is importable from
  scripts; division config locks once any fixture exists; **triple_rr at
  builder defaults gets 1 leg, not 3** (product defect — routed to W5).
  Open questions put to the owner as recommendations: accept the read-only
  transitive PackSchema load (yes); W1b's double_elim denied state via an
  explicit entitlement-override deny; "default config" = the builder's default
  (which makes volleyball default to beach and chess to blitz — flagged for a
  product look).
- **2026-09-27** — stale memory corrected: per-stage match rules #804 merged
  2026-09-20 (D7 went option A, `7d5433faf`); bench B07a merged (#792).
- **2026-09-28** — W1a live truth run done (see "W1a session status"). These
  items are carried to later waves; they are recommendations, not rulings.
  - **W1b:** I1's `field` is division-wide, so second-stage groups need
    per-stage entrants. The double_elim denied state goes through an
    entitlement-override deny (ruling 24).
  - **W1b / W2:** I3 now judges an expunge cascade's struck fixtures as 0
    (`f013af525`). Any other abandon keeps its outcome and is left unjudged:
    generic's `no_result` shares draw points in `standingsDelta`, and what an
    abandon is worth is W2's rulebook (ST-G1).
  - **W10:** never build shadow-invariant runs for divisions with zero
    stages, because I4 and I5 fail on zero stages.
  - **Bench owner:** the bench preflight runs its catalog queries and
    `GET /api/health` concurrently with `show data_directory`
    (`tools/bench/lib/env.ts:244-252`). The matrix runs its own guard first,
    so the matrix makes no foreign write, but the bench on its own is exposed.
  - **The wave that adds the weekly schedule** must delete or invert
    `ci-wiring.test.ts`'s "no scheduled matrix workflow" test.
  - **From the final review fix batch (harness hygiene, W1b):**
    - The fake's event refusal answers 409 for every engine code
      (`fake-driver.ts` postStream). The product maps them via
      `ENGINE_HTTP` (`api-v1/http.ts`): 422 for INVALID_EVENT, WRONG_PHASE
      and ALREADY_DECIDED. No harness logic keys on that status today; it is
      the class of the STAGE_NOT_READY fix (Task 8 m-7).
    - `run-cli.test.ts`'s zero-cases test still empties the exported
      `SLICE_ROWS` in place. It already restores it in a `finally` and asserts
      the restore; a valid filter always plans cases, so avoiding the in-place
      edit needs a planner seam.
- **2026-09-28** — ruling 30 applied to design §4 (70 scenario IDs) and the
  W1b plan. How each part is routed:
  - **Catalogue.** W1b's catalogue carries M4a/M4b and M12a/b/c. M12b is
    marked UI-only 🚫 (`l2NoPath` = W2).
  - **Routed to W2.** M12b's missing play-short control and the absent
    minimum-players rule. Also the missing organiser control for football,
    hockey and icehockey `abandonPolicy`. That control is API-only config,
    so W1b drops their M4b (plan false premise 10; read, not run).
  - **Routed to W5 (standings) + W2, if confirmed.** The abandon→void chain
    (ST-G1): `append-event.ts:146` → `fixture-engine-status.ts:17-19` →
    `stage.ts:24`. W1b Task 15 Step 3b drives four legs (a badminton
    control, a cricket no-result, a cricket two-innings draw, a football
    award) and records CONFIRMED, REFUTED or UNRESOLVED. No check is loosened
    to pass.
- **2026-09-28** — W1b atomisation: of the needs-times parent D5 only D5b
  (re-draw after timing) is L3-excluded; D5a (re-draw after an untimed board
  is published) runs in L3 — `publishSchedule` accepts an untimed board
  (`schedule.ts:3650-3656`). Design §4 updated to say so (Task 4 review I-1).
- **2026-09-28** — W1a carry 3, the fake's engine statuses aligned
  (`fb3741634`, review fix `f0c851c32`). The fake answers an engine refusal
  with the product's status from `lib/driver/engine-http.ts`, a copy of
  `ENGINE_HTTP` pinned entry for entry to `api-v1/http.ts` (422 for
  INVALID_EVENT, WRONG_PHASE and ALREADY_DECIDED).
- **2026-09-28** — W1a carry 4, the planner seam (`fb3741634`). `run.ts` takes
  a planner, so the zero-cases test no longer empties `SLICE_ROWS` in place.
- **2026-09-28** — W1a carry 1, the I1 multi-stage guard (`d6a1252b9`; review
  fix `ba141019a` gives I2 the same guard). A later stage judged on a
  division-wide field reds by name instead of judging the wrong field.
- **2026-09-28** — ruling 24 applied: the denied state via an
  entitlement-override deny, one per gated row, with a mandated ⛔
  (`971bb79a4`; review fix `8003ce823` confines the deny in SQL to case orgs).
- **2026-09-28** — ruling 26 applied: E is its own scenarios (E1, E2, E3, E4a,
  E4b; only E2 in L3), in the atomic catalogue (`63673948d`, Task 4).
- **2026-09-28** — ruling 28 applied: the `W1-driving` status row
  (`f8a9d8955`), W1a's deferrals renamed to `W1-driving` (`24907c0f8`), and
  the Q-A guard in `scenario-catalogue.test.ts` (`63673948d`; widened to the
  catalogue's owing waves in `346719cf3`; fails closed on a parse error in
  `df7dcca1c`).
- **2026-09-28** — ruling 29 applied: variant cases run LIFECYCLE only. They
  are counted that way in `counts.json` (`6278a37fd`) and planned that way by
  `--set w1b-probe` (`881055b22`, 2026-09-29).
- **2026-09-28** — ruling 30 applied: M4a/M4b and M12a/b/c in the catalogue,
  with M12b's `l2NoPath` (`63673948d`, Task 4). Their applicability
  predicates and `ABANDON_RESULTS` are `e49c20a76` (Task 6).
- **2026-09-28** — ruling 31's cricket half applied: the cricket stream
  generator clamps wickets to the engine's all-out for the side's
  `playersPerSide` (`39134e112`), so 38 short-side cases became scorable.
- **2026-09-29** — ruling 27 applied: the statement-form `import type`
  boundary gate on `packages/reference` (`d539edf04`, Task 12). The review fix
  `ddcf36095` moved its judge onto the TypeScript syntax tree and lints the
  inline `{ type X }` form.
- **2026-09-29** — R26: `forEachSport` in the engine testkit and a CI ratchet
  over unreasoned single-sport tests (`6b689c227`; review fixes `f17ba485d`,
  `f420977d9`, `421997d13`).
- **2026-09-29** — the fast-check model (design §7.5): core `30e6c36d0`,
  runner `2f9bd556f`. Fixes from the live run: a step invariant with nothing
  to judge yet abstains for that step (`15b811792`); the model moves to a fresh
  competition before the plan's per-competition division cap (`125573b93`); a
  regression case names its failure by cell, check and `match` (`d860d74f2`),
  and `match` is tested against the product's answer only (`0c07b9abf`).

- **2026-09-29** — ruling 37 applied: `BrowserDriver` runs inside the matrix runner. It is built over the
  organiser page objects (`496837114`). The browser run uses one chromium with a context per case (`c29fe9567`),
  behind `run.ts --driver browser --width` (`7d435605f`).
- **2026-09-29** — ruling 38 applied. The bench's ledger reader, tap vocabulary and consent helpers are imported. The
  pad executor is copied (`0e4d33830`), and pad replay runs on the bench's tap vocabulary (`9dc2d5d27`). The
  refused helpers (`playMatchByTaps`, `createTapPlayer`, `browserTapPlayer`) are refused by name in `boundary.test.ts`.
- **2026-09-30** — ruling 39 applied: the `--layer L1|L2` planners (`cdb044c74`). `--layer L1` runs at 1280 only.
  L2 is read from the committed `l2-pairs.json` and never re-planned.
- **2026-09-30** — ruling 40 applied (D2–D9):
  - pad adapters for all 11 sports (`0e1d3806a`, `7222adc80`, `19e9e23a6`, `b2f7a538c`);
  - the pad-proof set (`49d27f068`);
  - the parity CLI (`c158ac377`);
  - Task 14's live evidence. See "W1c session status".

- **2026-09-30 to 2026-10-01** — rulings 44–54 applied in W1-driving. Commits are post-rebase SHAs on
  `feat/format-matrix-w1-driving`.
  - **Routing and the guard (D7):** one routing construct, and a Q-A guard that reads every route and floors its own
    module scan (`f40bb7700`, `40a30c107`, `cfe9d11d4`).
  - **Field size per format, cricket tie and two innings (ruling 44, D4, D5):** `cccc35d06` and `fe41d525a`. The
    `l2-pairs.json` reshuffle is accepted once (ruling 50), and the regen changed only `l3Gap`.
  - **Rosters, lineups and linked persons (D2, D3):** `a0f6814ad`, `6bece2570`, `336af8a8b`, `d338b0214`.
  - **Multi-stage advance (D1, D12):** `247b186eb`, `9b0f92d3d`, `d6a8debed`.
  - **Ladder (D8, D14, rulings 51 and 53):** `f3689feb7`, `c1982bd6f`.
  - **Americano and mexicano loops (D9):** `8dfddb0e5`, `af6877f6d`, `832c4289e`.
  - **Structural I2, plus I9 and I10 (ruling 45):** `4fc9fddb8` through `53b9c0902`.
  - **In-process workers (ruling 46, D10):** `4c4d7723c` through `31f28e048`.
  - **The `w1-driving` set and `--only` (Task 12):** `3a556ee77`.
  - **Browser filler, the L1 proof and the template cells (ruling 47, D11):** `eca0f0307`, `669bbd259`, `064839963`.
  - **Model team rosters, Swiss bias and family routes (ruling 49 as amended by D6):** `1b861f2ac`, `cde29a754`,
    `749e08462`, `49754e44a`.
  - **Live evidence and triage (ruling 48):** `15ed62365` through `e2db86c96`. See the Status row.
  - **Task 16:** `ca3fcd081`, `95eb5203c`, `8198452ae`, `e5abe105e`, `2f79c5f07`; fix round 1 `22c8aa141`, `5950801a3`,
    `8bad7555e`, `548f3825d`, `215fd7ed5`, `31792a06d`, `163078054`, `5d3264a80`, and the docs commit that writes this line.
- **2026-10-01** — **R1 gains W1-driving** (ruling 28): `_RULES.md` R1 now reads W1a → W1b → W1c → W1-driving → W1d
  → W2 … W7. `../2026-09-27-format-matrix-design.md` §8's "Order." line (line 462) gained the same one word in
  Task 16's fix round 1 (T16-R2, T16-R4).
- **2026-10-01** — **The W1b swiss model seeds reproduce only at their recorded `harnessCommit`** (T14-R4 m-2). Task 14
  biased the swiss command generator (`SWISS_BIAS`, ruling 49). So a swiss model seed committed by W1b (for example
  `-1180181307` in `w1b-model-0929b` and `w1b-model-0929g`, and `-2002771143` in `w1b-model-final-sb40`) draws a
  different command list today. Re-running one needs that run's `harnessCommit`. The five committed regression
  cases of the time (MB-001..005) are league and knockout cells. They draw exactly what they drew, which a test
  pins by sampling.
- **2026-10-01** — **T15-R9's check is named:** `r4-not-seated-later` (`notSeatedLater`,
  `tools/matrix/lib/scenarios/r4-withdrawal.ts`). It is the americano-kinds sibling of the swiss
  `r4-not-paired-later` and the ladder `r4-not-challenged-later`. The coverage table's kept-playing signature
  covers it on americano and mexicano R4. It reds americano 11/11 and mexicano 3/11 on `w1drv-l3-fr2`.
- **2026-10-01** — **DRIVING_WAVE (PF-10): nothing left to decide at close.** The Task 13 dispatch deleted
  `DRIVING_ROUTE` and `DRIVING_WAVE` together with their ruling-28 pin (`eca0f0307`). The guard test changed in the
  same commit: an identifier wave argument is read as unread. Only comments name it now.
- **2026-10-01** — **The bracket fences cover the stage kinds their committed cases witness** (T15-R5, G-1;
  `ca3fcd081`, `95eb5203c`, `8198452ae`). MB-007 (double elim, generate after a roster change, 500 "would strand
  home_slot_label") and MB-008 (stepladder, withdraw while waiting on a TBD opponent, 422 "fixture has an
  unassigned entrant (bye/TBD)") are committed from `w1drv-model-m6`.
  - Task 16's run of the two widened cells (`w1drv-t16-model-g1`) found the withdraw 422 on double elim as well,
    committed as MB-009.
  - `ko-withdraw-waiting-on-tbd` now covers knockout, stepladder and double elim: all of `stages.ts`
    `BRACKET_WALKOVER_KINDS`. `ko-generate-after-roster-change` covers knockout and double elim.
  - Re-run at `95eb5203c`: both cells ok (`w1drv-t16-model-g1c`), and `--regressions` 8/8 known
    (`w1drv-t16-model-reg2`).
  - **Fix round 1 (T16-R3).** The generate fence keeps one kind list per trigger branch. The double-elim
    withdrawn branch was lifted, and the live cell found **MB-010**: Start → Withdraw → Generate 500s, "would strand
    home_slot_label" (`w1drv-t16fr1-model-de`, harness `22c8aa141`). It is committed with fence
    `ko-generate-after-roster-change`, and that fence's withdrawn branch now covers knockout (MB-004) and double elim
    (MB-010).
  - MB-007 and MB-010 share cell, check and words, so a replay first offered its own case to the matcher
    (`5950801a3`); otherwise MB-007 would claim MB-010's replay and it would read NOT REPRODUCED. **Superseded in
    W1d Task 13 (`7ecabf2ea`, item 26):** each case now carries a `trigger` (withdrawn, added) and the matcher
    tells cases apart by it, so a replay no longer ranks its own case first.
  - Then double elim ran ok 20/20 with both branches fenced (`w1drv-t16fr1-model-de2`), and `--regressions` 9/9
    known, each case under its own id (`w1drv-t16fr1-model-reg`, harness `8bad7555e`).
  - There is no MB-006, because `model-cli.test.ts` uses that id for a synthetic case.
- **2026-10-01** — **The owner's 2026-10-01 decisions are numbered as rulings 55–59** (controller ruling T16-R4;
  the full text is under "Owner rulings"):
  - 55: format templates stay in code, and the cleanup follows W1-driving;
  - 56: the matrix harness gets its own workspace package, not a separate repo;
  - 57: the W9 stage delete stays with W9, with no separate PR;
  - 58: no CI live-matrix proposal;
  - 59: the W1-driving PR is raised after the reviews approve, and the merge is the owner's.
  - **"Rebase when possible"** (the owner's words, SDD ledger) is not among the five T16-R4 numbers. The branch was
    rebased onto `origin/main` `58e8103e3` with no conflicts, before Task 15 (pre-rebase HEAD `4aa2e0db2` became
    `1b861f2ac`).

- **2026-10-08** — W2 brainstorm (session "f-w2"). Rulings 71–79 signed in chat; W2a spec written to
  `docs/superpowers/specs/2026-10-08-format-matrix-w2a-design.md` on `feat/format-matrix-w2a`. Two read-only scouts
  at `7dd45eeab` verified the brief (see "Found during W2 brainstorm") and mapped the W2a seams (spec §5).

- **2026-10-08/09** — W2b brainstorm (session "f-w2b", in parallel with W2a's build, docs only until W2a merged). Rulings 83–99 signed in chat; spec `docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` approved (ruling 100). f-w2 checked the double-walkover design (no clash) and handed over D-G2, D-G3, D-P2, D-R1 and D-F4. Build branch `feat/format-matrix-w2b` cut from main after W2a merged (`a99147bd0`).

- **2026-10-12 → 2026-10-23** — W2c (session "f-w2c"). Spec approved 2026-10-13 and amended twice the same day (rule
  facts in the engine, web split per sport; open pads follow a correction; no live users). The owner's spec answers
  are rulings 160–176 (Q1–Q11, S1–S5, the §1 amendment). Plan approved (ruling 141) with
  P-1..P-5 (rulings 135–139) and the execution ruling (140); rule rows signed (rulings 129, 130). Built
  subagent-driven in six batches, plus Tasks 16b (X-WO-1's headline) and 16c (golden streams for the opt-in keys);
  lanes merged into the branch before each batch-end Opus review, and proof commits moved each proved row out of
  `AWAITING_PROOF` (empty since Task 15). Rebased onto main 2026-10-14 (engine split 1a), 2026-10-15, and twice on 2026-10-16
  (GF-2, then the engine lineup fix). SHAs recorded before 2026-10-16 are pre-rebase; local refs
  `backup/w2c-pre-rebase-*` keep them. Owner hold before Task 17 from 2026-10-15 to 2026-10-19 (ruling 148). Task 22
  (MD-1) closed at `0bd3d3e1cf`; Task 23 is next. Owner rulings 135–176; the plan's decisions under
  "Recommendations" ("For W2c"); "Controller rulings (execution, W2c)"; "False premises found (W2c)"; "Findings routed
  (W2c)".

- **2026-10-20 → 2026-10-28** — W2d, tables and tie-breaks (session f-w2d, then the W2d controller). Spec
  `docs/superpowers/specs/2026-10-20-format-matrix-w2d-design.md` and plan `docs/superpowers/plans/2026-10-20-format-matrix-w2d.md`
  approved 2026-10-20 (rulings 177–196); started 2026-10-24 once W2c merged (#1007), at `W2D_BASE=e97823e4d8`; rule
  rows signed the same day (ruling 197). Built subagent-driven, with lanes in their own worktrees (ruling 199).
  Shipped as two PRs (ruling 201): **PR A** (Tasks 0–12, plus A14, A20, A21) MERGED as #1038, `79ebb3187b`, on
  2026-10-27, with R27's three chess americano cases and the stryker-sizing legs as known main-owned reds (ruling
  210); **PR B** (Tasks 13–21, draft #1053) rebased onto main `4a9e180958` at `a719e11309` on 2026-10-28. The migration
  is V475 (`V475__w2d_table_rules.sql`, renumbered V472 → V474 → V475 at the rebases). Owner rulings 177–220; the
  controller's under "Controller rulings (execution, W2d)"; "False premises found (W2d)"; "Findings routed (W2d)".
  - **The level table exists from the generate (Concern 2, ruling 217; W2d spec §6 row W10 amended).** The recompute
    triggers gain the generate and a seed confirm (`REAL_TABLE_KINDS`, `emptyFold: "skip"`), and a roster delete and
    Unpair (`"drop"`); the export skips level tables, and empty ones too (404 `STANDINGS_NOT_AVAILABLE`). Spec §6's
    W10 row said the triggers were "unchanged"; that was true until this ruling.
  - **MD-1 (owner table above: `competition/tiebreakers.ts`, `competition/points.ts`).** `tiebreakers.ts`: 72.4% at
    the W1d baseline → 94.66% / 99.33% (score / covered) after PR A → 94.69% / 99.33% after PR B (943 mutants: 888
    killed, 4 timed out, 6 live, 44 equivalent, 1 runtime error). `points.ts`: 95.54% / 97.97% at `W2D_BASE` → 98.39% /
    99.19% → 98.88% / 99.66% (891: 881 killed, 3 survived, 7 equivalent). Every survivor is classified in the PR
    bodies (A-real killed; equivalent recorded, or not recordable where the key also names a killed mutant; dead code
    with its caller search; two rare cases parked under ruling 207's cut).
  - **Screens.** Tasks 15–16 (ruling 212), Task 18 (ruling 216) and Concern 2 (ruling 217) were signed off by the owner;
    PR A's I1 card screens were published and are not a merge gate. The crops stay in gitignored scratch.
  - **What the release still owes** is listed under "Findings routed (W2d)": no production release until the whole of
    W2 is done (ruling 213).

- **2026-10-28 → 2026-10-29** — W2e, sport fidelity and the W2 close (session f-w2e, then the W2e controller). Spec
  `docs/superpowers/specs/2026-10-28-format-matrix-w2e-design.md` approved 2026-10-28 (Q1–Q12 → rulings 221–232; amended
  at plan phase by Q13–Q17 → 233–237, then D18 and D19 → 238–239); plan
  `docs/superpowers/plans/2026-10-28-format-matrix-w2e.md` follows D18. Built subagent-driven in lanes (ruling 240's
  delegation), from `d74ef5364e`. Shipped as two PRs: **PR A** (Tasks 0–26; engine, rules, harness; migration V481,
  `V481__w2e_stored_config_cleanup.sql`) MERGED as #1068, `18155d5ca0`, on 2026-10-29 with the two `stryker-sizing` tests
  red (ruling 241); **PR B** (Tasks 27–36; web, then the truth run; #1069) follows on that main, rebased rather than merged
  (ruling 241).
  Owner rulings 221–241; the controller's under "Controller rulings (execution, W2e)"; "False premises found (W2e)";
  "Findings routed (W2e)".
  - **What W2e changed that a reader will not find in a ruling.** Sanction endings are a recorded event
    (`core.forfeit` right after the ending-level sanction), never a new reading of an old sanction, and replay stays
    lenient (anti-goal 1); every new refusal is a write-path refusal (`ENDING_SANCTION_PENDING`, `SET_SCORE_UNREACHABLE`,
    `CHASE_OVERSHOOT`, `RESULT_METHOD_CONTRADICTS_WINNER`, `ADJUST_OUT_OF_RANGE`, `RULE_NOT_SETTABLE` for
    `minOversForResult`). The rule rows were signed `W2e-D<n>` while the work ran (E27) and carry ruling numbers from this
    fold. The data a deploy moves is listed in each PR's "Data changes" and in the release notes the owner publishes with
    the prod tag (ruling 238).
  - **The W2 truth run (T35).** CI `40874582041` 15/15; judged against `w2b-final`: L1 209/0, L2 1625/0, L3 845 with two
    SW-H1 Swiss flips accepted as the known flake; W2e's local `W2E_*` scenario keys 10/10 works (152/152). Detail under "Controller rulings
    (execution, W2e)".
  - **MD-1 (owner table above: the sport modules, kernels, `core/*`, `stats/stats.ts`, `sport/module.ts`).** The sizing
    dispatch (`40741725312`) was re-measured by the mutation session on PR A's tree. W2e closed the survivors on its
    changed lines (T25: 34 → 5 unrecordable, 18 killed, 29 equivalence rows added, 27 re-keyed, 305 rows, 0 position
    faults); 369 survivors (70 NoCoverage) on result-deciding paths W2e did not change are parked with the mutation
    session (PO decision, narrower than ruling 230's text).
  - **Staging read, 2026-10-29 (Flyway v481).** `data-audit.sql`'s W2e statements count 0 flagged: set targets below 5 (1
    table-tennis division examined, 0 volleyball), tennis Bo1 + match tie-break (4 divisions and 2 match states examined),
    and ledgers with an unended match-ending sanction (staging has no `*.sanction` events at all, so that zero is thin).
    The W2d statements, run on staging for the first time, found 3 football divisions in the archived competition "FIFA
    World Cup 2027" whose `divisions.tiebreakers` is `["fifa2026"]`, which is not an engine key, and 14 chess non-Swiss
    stages listing `sberger` (all on the sport default), whose tables may reorder on first read after the release.

## False premises found

Record each audit gap that fails to hold, with who found it.

- **SW-H1 (partial)** — "rounds ≥ field size always dead-ends" holds only for
  even fields; an odd field of n can play n rounds. The core defect (an empty
  pairing reported as success) stands. Found by the W3 rulebook draft
  (`8a74c538e`), code read.
- **SW-M1 / SW-L1 (expected value)** — cite the pre-2023 FIDE "virtual
  opponent" rule as current; C.07 (2026) art. 16 replaced it, so SW-M1's
  expected 2.5 is wrong. The defect (bye valued wrongly in Buchholz) stands.
  Same source; the rulebook's FIDE edition claims need a primary-text check at
  sign-off.
- **SW-M8 / SC-O7 (severity)** — the unused `byeScore` leaves the FIDE-correct
  full-point bye in place; only a house-rule half-point bye is missing. Lower
  severity than filed.
- **ST-G21** — found by grep only; still needs a read (R5).
- **SC-S3 (premise)** — assumed a walkover should credit 21–0 / 6–0 6–0; BWF
  GCR 16.2.5 deletes the withdrawn player's group results instead, and ATP
  counts straight sets with games excluded. The gap (no credit today) stands;
  the fix differs per sport. Found by the W2 sets/cricket rulebook draft
  (`843128e27`).
- **SC-C2 (premise)** — assumed super overs are knockout-only; ICC T20I
  16.3.1.1 plays them on group ties too. The gap (flag division-wide only)
  stands.
- **SC-S5 (source)** — the rule is ATP Rulebook 4.02, not an ITF convention.
- **SC-P4 (framing)** — "FIH 2/1 shoot-out split" is the FIH Pro League rule
  only; FIH tournament regulations use 3/1/0 with draws standing and no pool
  shoot-outs, which the product already does by default. The gap narrows to
  "no points fields when shoot-outs are switched on". Found by the W2
  goals/boards rulebook draft (`4da1804e1`).
- **ST-G1 (scope)** — wider than filed: football/hockey abandonments and
  carrom/generic abandonment points are also dropped from the table.

### Found during W1a (tasks 1–11)

- **"A level full-time knockout fixture becomes a bracket draw" — FALSE.**
  For football, hockey and ice hockey, the engine folds a level full-time
  knockout fixture to `draw`, and `supportsDraws` keys on the stage kind only.
  But the product blocks that fixture ("cannot end in a draw — decide by extra
  time and shootout"). The W1a controller reports this as owner-verified by
  driving the product. What remains is engine hygiene, routed to W2 at low
  priority.
- **`public_quota_degraded === true` (plan Task 6) — FALSE shape.** The field
  is an object (`schemas.ts:223-253`), so the check was inert. The driver now
  reads the applied `visibility`.
- **"Generic draw refusal is not strict-gated" (Task 2 candidate) — not a
  finding.** Config is frozen on a fixture's first event
  (`append-event.ts:280`, `fixture-cfg.ts:44`).
- **Carrom `tieBoard:"draw"` generator gap (plan deviation text) — FALSE.** No
  carrom variant enables draws (`carrom.ts:69`). `KNOWN_UNSUPPORTED` covers
  only cricket two-innings.
- **RF4 via the org listing — tautological.** A successful switch already
  implies the listing, so the proof is the `seazn_org` cookie instead. It held
  live for all 104 case orgs.
- **"An expunged fixture has no outcome" (I3, Task 5) — FALSE for generic.**
  Found by the live run (Task 11). Generic folds `core.abandon` to
  `{kind:"no_result"}`; badminton folds it to null. I3 skipped every entrant
  of `league|generic|score|R4` and read vacuous. This was a harness defect,
  fixed in `f013af525`.
- **Plan premises re-checked live in Task 11:**
  - CONFIRMED: builder variant order (generic `score`, badminton `bwf`).
  - CONFIRMED: division config locks once fixtures exist (`409
    FORMAT_LOCKED`), and the entrants-only save passes (`200`).
  - CONFIRMED: fixture `outcome` is an object on the fixtures list.
  - CONFIRMED: the builder variant query returns rows under a
    `rolbypassrls` role.
  - REFUTED: the worry that knockout standings come back `[]`. They return
    all 8 rows, equal to the public table.

### Found during W1b planning and execution

**The plan's eleven** (`docs/superpowers/plans/2026-09-28-format-matrix-w1b.md`,
"False premises found in planning"). Each was found by reading, and 8 and 11
were hypotheses that Task 15 then drove live. Line numbers are at the branch
base `64e009f2d`, the tree the plan was written against. Outside
`scripts/matrix/` no cited line has moved since (the only other cited file the
branch changed is the root `package.json`, cited without a line). The
`scripts/matrix/` cites have moved: for example, I1's `late_entry` is at
`invariants.ts:40` at `7c42d0ec2`.

1. **"fast-check is already a dependency — no setup is owed"**
   (`docs/superpowers/TEST-STRATEGY.md:93-97`). True for `apps/web`
   (`package.json:75`) and `packages/engine` (`package.json:56`), false for
   `scripts/`. The root `package.json` has no fast-check, and pnpm links a
   package only into the importer that declares it. It resolved locally only
   because the main checkout's root `node_modules/fast-check` is a real
   directory, which no CI job has. Closed by a root devDependency
   (`30e6c36d0`, with `fast-check-resolution.test.ts`).
2. **Design §5: boundary classes come from the module's declared settings.**
   The engine's `configSchema` declares no finite bounds (`badminton.schema.json`
   `setTo` is `{exclusiveMinimum:0, maximum:9007199254740991}`). The
   organiser-facing bounds live only in `apps/web/src/lib/match-rules.ts`
   `SPORT_RULES` (badminton `setTo` 11–30, `:227-233`). Task 5 takes its
   classes from `SPORT_RULES` and validates each through the engine.
3. **Design §7.5: checking every invariant after every step would catch
   #879.** I1 abstains on `late_entry` (`scripts/matrix/lib/invariants.ts:32`;
   the plan said `:31`), I4 fails by construction mid-sequence, and I2 needs a
   completed stage. Task 2 added I7 (no pair over `legs`) and the `stepSafe`
   subset.
4. **W1b prompt: "Routed gaps: none".** W1a routed four deferrals to "W1b":
   `scripts/matrix/lib/scenarios/common.ts:90`, `:92` and `:94`, and
   `scripts/matrix/lib/catalogue.ts:101`. Task 3 closed the last (API-only row
   bodies), and ruling 28 re-routed the other three to W1-driving.
5. **A "⛔ refused" state exists in the harness.** `CASE_STATES` listed it
   (`scripts/matrix/lib/results.ts:16`), but `decideState` could never return
   it (`:117-128`; `:121-133` at `7c42d0ec2`). Task 9 gave it a producer, a
   mandated refusal.
6. **"Order is not significant"** (`packages/engine/src/sports/index.ts:22`).
   The registry order is the grid's column order and the wave order (AGENTS.md
   class 18). `forEachSport`'s tests pin it (Task 11). The engine comment
   still stands; see "Findings routed (W1b)".
7. **"The double_elim denied state" is one case** (ruling 24's wording). The
   product gates `formats.double_elim` on double_elim AND page_playoff
   (`format-gates.ts:39`), and `formats.advanced` on americano and ladder
   (`:46-47`). Seven offered rows are therefore gated, and Task 9 builds all
   seven.
8. **Hypothesis: "a refused format change leaves the format as it was."**
   `replaceStages` deletes every stage in its own committed transaction
   (`apps/web/src/server/usecases/stages.ts:543`) and only then calls
   `createStages` (`:546`), which gates (`:373-382`). **CONFIRMED live: the
   premise is false.** The refused PUT leaves the division with no stage, on
   all 7 DENIED rows. See "Findings routed (W1b)".
9. **Design §4 names "chess tiebreak" as an M6 decider.** boardgame declares
   no decider (`boardgame.schema.json`), and `supportsDraws` is true for every
   kind (`boardgame.ts:767-771`). Task 6 drops M6 on boardgame with this
   reason, routed to W4.
10. **Ruling 30 cites "a football award-policy abandon" as an M4b example.**
    The engine has `abandonPolicy` `replay|award` (`football.ts:173`,
    `period/kernel.ts:219`), but `SPORT_RULES` has no field for it, so no
    organiser screen can choose it. W1b drops football, hockey and icehockey
    M4b with this reason. Live side reading (Task 15 Step 3b): the API
    ACCEPTED `config.abandonPolicy: "award"` on a football division, so only
    the editor lacks it.
11. **Hypothesis (ST-G1): "an abandon that the engine scores reaches the
    table."** A `core.abandon` sets the fixture `abandoned`
    (`append-event.ts:146`), which maps to the engine's `void`
    (`fixture-engine-status.ts:17-19`), which `COUNTS_FOR_STANDINGS` excludes
    (`packages/engine/src/competition/stage.ts:24`). **CONFIRMED live: the
    premise is false.** The product stores the scored outcome and the table
    counts none of it. See "Findings routed (W1b)".

**Found while executing:**

- **The Redis check `ps eww -p $PID | grep -c REDIS_URL` is vacuous against
  next-server** (Task 15 Step 1, a run). next-server rewrites its process
  title, which erases `ps`'s view of its environment. The positive control
  `grep -c DATABASE_URL` on the same process also read 0, while the same check
  on a plain `node` child with a planted variable read 1. The witnesses used
  instead, in every Task 15 environment:
  1. **A replica launch:** the environment script's own composition and shell
     preamble, with `node -e` printing each of `REDIS_URL`, the PostHog keys,
     the Sentry keys and `RESEND_API_KEY` as absent, empty or SET. It read
     `REDIS_URL` absent and the rest empty. The positive control, without the
     blanks, read `NEXT_PUBLIC_POSTHOG_KEY` SET.
  2. **The key lists:** `cut -d= -f1 apps/web/.env.local | grep -c
     '^REDIS_URL$'` → 0, and `env | grep -c "REDIS\|POSTHOG_KEY=.\|SENTRY_DSN=."`
     → 0 in the launching shell.
  3. **The runtime:** `lsof -nP -a -p $SERVER_PID -iTCP` after the runs showed
     the LISTEN socket and Postgres connections only. `lib/cache.ts` connects
     eagerly (`lazyConnect: false`) whenever `REDIS_URL` is set.

  `denied-refused-named` passing on all 7 DENIED cases is a further witness,
  because a Redis entitlement cache would have hidden the SQL deny.
- **#879's trigger is before Start, not after it** (Task 13 review C-1, a
  read; later reproduced live). The roster locks at Start
  (`apps/web/src/server/usecases/entrants.ts:307-318`, a 422 with no code), so
  the plan's Start-first shape could never add the late entrant. The real
  sequence is Generate → AddEntrant → Generate before Start. Generate has no
  division-status gate and flips only the stage, and the league reconcile
  inserts every missing positional `ext_key` (`stages.ts:2509`,
  `packages/engine/src/scheduling/roundrobin.ts:140`). The model found it live
  with no Start in the shrunk path (MB-001).
- **Task 15 Step 3d's briefed shape reached only the expunge path.** With 3
  fixtures each, withdrawing an entrant with 2 or more unplayed always means
  one who played under half, and `withdrawTableEntrant` expunges below half (a
  `core.abandon` on each pending fixture). The walkover path CD-T13 is about
  was unreachable. A walkover shape was added (6 entrants, the target has
  played 3 of 5): the briefed shape is REFUTED, the walkover shape CONFIRMED.
- **`strip-types-loadable.test.ts` needs no edit per new module.** It walks
  `tools/matrix/` for every shipped `.ts` and has no module list. Task 1
  found it; the briefs of Tasks 4, 6 and 14 repeated the premise, and each task
  ran the test unedited.
- **`single-sport.test.ts` was red from Task 14 (`2f9bd556f`) until Task 15
  fix round 2 (`d860d74f2`).** Three column-0 `// single-sport:` comments (two
  Task 14 test-file headers and one fix-round-1 comment) failed its grammar
  test, and no scoped gate ran it. **Scoped-gate rule:** whenever a change
  touches a `// single-sport:` header, its scoped gate includes
  `single-sport.test.ts`.
- **"A pair invalid with every other factor at its default can never be
  covered"** (Task 5 brief): FALSE. Pass 1 listed 252 such pairs, and 214 of
  them are covered once one or two more factors change level. Only 38 have no
  valid completion, proven by brute force.
- **The 38 cricket "unscorable" cases at 3–5 a side were a harness generator
  bug** (Task 8 re-review RR-1), not a product item. Ruling 31 records it.
- **Refusal evidence carried no product text** (Task 15 fix round 2), so a
  `match` on the product's message could never hit. `RefusedCall.message`
  became an evidence line (`d860d74f2`), and `match` is now tested against that
  answer alone (`0c07b9abf`).
- **"A replayed regression prints its finding run's command list"** — false
  while the finding run's shrink was cut short (Task 15 Step 6). The case
  org's plan caps a competition at 20 divisions
  (`divisions.per_competition.max`), so shrink candidates past the 20th
  division failed in setup with a 402. They were masked, read as passing, and
  ended the shrink early. The model now moves to a fresh competition before
  the cap (`125573b93`), and MB-001 was re-pointed to its full shrink
  (`3d20959f8`).
- **"A step invariant has something to judge at every step"** — false for
  Swiss (Task 15 Step 4, a run). A Swiss Start mints unpaired shells, so R25
  turned I6's zero-item pass into a failure at step 1 of every Swiss run, and
  both Swiss cells were in effect vacuous. A step invariant with nothing to
  judge yet now abstains for that step (`15b811792`); R25 stays per cell.
- **TypeScript 7 refuses an `include` of `src/**`** (Task 12, TS5010), so the
  reference package uses `src/**/*.ts`, as the engine does.

### Found during W1c planning and execution

**Planning (plan `2026-09-29-format-matrix-w1c.md`, "False premises found in planning"; what execution saw):**

1. **"The bench ships only a generic tap adapter."**
   - It also ships a hardened ledger reader, a sport-blind tap vocabulary and the consent/start helpers (ruling 38).
   - Its match loop is not reusable: it forces the organiser to 1280 and the scorer to 390, and always finalizes.
2. **"Every organiser action has a UI."**
   - No page lists final ranks past the champion, and rank override has no UI.
   - Seen live: the knockout standings tab reads "No table stages in this division", and the public page shows the
     champion banner only (`w1c-l1`, `w1c-sweep-ko`). See D6 and "Findings routed (W1c)".
3. **"The builder saves stages with PUT."** Create POSTs the division, POSTs its stages, then PUTs schedule settings.
4. **"A pad adapter can score any generated fixture; team sports need rosters seeded over HTTP."** Wrong in both
   directions (FP-T9-1 below). The pads score rosterless team entrants.
5. **"L2 on the slice proves the L2 framework."** Filtering to the slice cells leaves 68 runs, and only 3 have a
   harness script. Confirmed live (`w1c-l2`): 65 swiss\|badminton, 2 swiss\|generic, 1 knockout\|badminton; the
   league cells get 0.
6. **No test had pressed `score-finalize` or played a builder-default match to finalized.** The same gap covered
   volleyball `beach`, carrom `club-29` and boardgame `blitz`. All three are now proven by pad proof: six runs, 11
   sports, every fixture finalized.
7. **`HOLD_MS` default vs the CI comment.** `queue.ts:150` sets 10 000; `e2e.yml` says 5 s. CI bakes 3 000. The
   harness never waits a hold out.
8. **"`generic.result` is held 6 s"** (`journey-pro.spec.ts:246`). A null dock sends immediately.
9. **Stale bench comment cites** (`tap-play.ts:86`, `:89`, `scorer.ts:764`). Recorded for the bench's index, not
   edited.

**Step 0 and execution (each task's report, `.superpowers/sdd/2026-09-29-format-matrix-w1c/`, gitignored):**

- **Task 1.**
  - The gate's reason table is not exported; the test spells each reason literally.
  - An existing loader case gained findings under the new alias rule.
  - Step 3's `handled.add` wording, taken literally, broke two positive pairs.
- **Task 2.**
  - Brief pins had drifted: `RegressionCase`, the file shape, `NEXT_MATCH_STARTED` not `FIXTURE_LOCKED`, line numbers.
  - "Replay matches `fencesOn`" would have stopped four of five cases reproducing (ruling Q1).
  - `fedCandidates` could not take the refusal without widening `commands.ts` (ruling Q2).
- **Task 3.**
  - `no_path` / `not_run` already existed as states; only their producers were missing.
  - There were three committed v2 `results.json` files, not one.
- **Task 4.**
  - `seed.ts` has been reachable from `run.ts` since W1a (`plan.ts:80`).
  - `run.ts` already loads the playwright library, through bench `env.ts:25`.
  - "Add entrant" has no dictionary key: it is hardcoded English.
  - Several selector pins live in other files than the brief said.
- **Task 5.**
  - The stage rail has no `[data-stage-id]`: it is addressed by `stage-rail-sheet-<id>` and `aria-controls`.
  - Finalize POSTs `core.finalize` to the events route.
  - The add-entrant form has a Seed field.
  - Run-sheet rows also offer `assign_scorer`, `set_time` and `view`.
  - The console never posts `core.start` by itself.
  - The route is `/o/<org>/c/new`.
  - The brief's wire type names do not exist.
- **Task 6.**
  - `buildTemplateStages` overwrites league/group legs with the knob, so `builder-posted-as-harness` cannot see a
    triple_rr legs difference. The triple_rr question is W5's.
  - The v1 standings carry no pool name, so pools are paired by their members.
  - `POST …/finalize` needs `{expected_seq}`.
  - A slugged case id can collide, so evidence ids are `case-<n>`.
- **Task 7.**
  - `data-tile-disabled` is always present, as `"false"` when a tile is enabled.
  - Finalize needs no reload.
  - There is no `decided` outcome kind.
  - `ScenarioUnsupported("W1c")` is refused by the Q-A guard while this wave is Executing.
- **Task 8.**
  - `--only` takes a cell, not a row.
  - LIFECYCLE never forfeits or withdraws (9 action types).
- **Tasks 9–11.**
  - **FP-T9-1:** five sports are team-kind, not four: volleyball `beach` is one. `setUpDivision` also refused every
    team sport before any driver call.
  - **FP-T10-1:** the football goal tile writes `{by}` with no `minute`, so the goal is a fallback.
  - **FP-T10-2:** the hockey and ice hockey advance tile stamps `at`, so advance is a fallback.
  - **FP-T11-1:** the carrom board sheet does not hold.
  - **FP-T11-2:** the boardgame draw tile writes no `method`; the chip is required.
  - **D-T11-1:** every generated cricket innings closes itself, so no close tap is ever needed.
- **Task 12.**
  - There was no L2 parser.
  - `planL2` already names the generator in `pairs.ts`.
  - `planL1` needs `variantFor`.
  - `LayerCase` has to be a union.
  - A `LayeredPlanner` seam carries the width.
  - The D7 wave map moved to a leaf.
- **Task 13.**
  - `parity` was already in `CLIS` under an exemption.
  - `finalize-ledger-row` is browser-only.
  - The brief's `Results` type is `AnyRunResults`.
- **Task 14.**
  - **Step 6 is stale.** The API-only set opens no browser (planned 🚫).
  - **Step 7** as written (24 HTTP cases against 6 L1 cases) would have exited 1 by construction. The Task 13 parity
    scope ruling replaced it.
  - **`pairs.ts:12`** says L2 "marks the run `l3Gap` for W1c to record". No W1c plan contains the catalogue's only
    `l3Gap` run (514, `groups_ko|cricket|t20|M5@375`).
  - **P-4 is not 320-only.** At 320–390 the entrants STATUS/ACTIONS columns reach the card edge (`w1c-sweep-ko`).
  - **O-1 is not league-only.** A knockout's Generate after Start is also "Nothing new to generate", because it builds
    every round at Start.
  - **The run sheet does not default to "Today" off a match day** (plan Appendix A said it does). The product
    defaults to "Today" only when the phase is `match_day`, else "All" (`stages-panel.tsx:555`). No matrix run
    reaches a match day, so carry 2's press branch never ran live (0 `run-sheet-all-before` shots in 91 live cases).

### Found during W1-driving planning and execution

**Planning** (plan `docs/superpowers/plans/2026-09-30-format-matrix-w1-driving.md`, "False premises found in
planning", with file:line evidence there; numbers kept, including plan review 1's 12–15, plan review 2's 16–17 and
false premise 10's correction). After each, what execution saw:

1. **"GET the seed proposal to read the latest."** The route has no GET. `POST …/seed-proposal` computes (201) and
   `POST …/confirm` fills. The harness confirms the id `/complete` returned (D1). The live multi-stage cells
   advanced this way (`w1drv-l3`).
2. **"`Scenario.entrantCount` sets the field."** Nothing reads it; each scenario passes its own constant. Task 2
   changed the calls (`field-size.ts`).
3. **"Only mexicano risks a duplicate round on re-generate."** `americanoGen` plans on every generate. The americano
   loop never generates after Start (D9).
4. **"The M5 tie gap covers cricket."** It covers limited-overs cricket only: `LEVEL_PROBES.cricket` returns null
   without a numeric `ballsPerInnings`, and the `test` preset has none. Task 10 built the tie stream for both
   shapes. Whether M5 should probe a 4-innings level tie is routed to **W2** ("Findings routed (W1-driving)").
5. **"924 cases" (ruling 48).** F1 on `page_playoff_only` is unfit, which leaves 913 cases, plus 24 cricket `test`
   cases = **937**. Seen: `w1drv-l3/results.json` holds 937.
6. **`RowBuildDeferred` is a deferral class the guard reads.** It is never constructed. The guard reads every route
   instead (Task 1).
7. **"A structural champion rule needs a new product field."** The fixture list already serves `ext_key`,
   `is_final` and `lane`. The harness stopped dropping them (Task 9).
8. **"The Q-A guard's anti-vacuity is sound."** Its only shipped sites were the three deferrals this wave deletes,
   so at close it would have redded for a harness reason. Task 1 moved the floor to every route read. At close it
   reads 0 routes naming W1-driving and stays green.
9. **"Multi-stage in the model goes to W4/W5/W7" (ruling 49).** Design §8 puts `swiss_playoff` and `swiss_knockout`
   in **W3**. D6 routes them there, and ruling 52 accepted it. The same holds for the seeding ties on those rows
   (Findings).
10. **"Americano × team sport refuses."** Corrected at plan review 1: the first draft's `STAGE_NOT_READY`
    prediction was itself false. `americanoGen` keeps one person per entrant over every member row, with no kind
    filter and no order, so team divisions generate silently with one arbitrary member each. **Confirmed**: the note is on all
    42 cases of the 10 team cells, each on its latest committed run (`w1drv-l3` 16, `w1drv-l3-rerun` 16,
    `w1drv-l3-fr2` 10) → W7.
11. **The W1c status row said "PR and merge: pending".** It merged as #905 (`ebf7ec040`) on 2026-09-30. Corrected
    by Task 16.
12. **"M1 and R4 mean the same on every family"** (plan review 1, C-1). On americano and mexicano, fixtures seat
    ephemeral pair entrants, so M1 found no fixture. On a ladder, R4's seed 3 had no fixture yet. Ruling 51 defines
    each meaning (D14).
13. **"Ruling 51's ladder timing gives R4 a policy to report."** After seed 3's decided first challenge, nothing is
    pending, and the product's correct answer is policy `none`. Ruling 53 derives the expectation instead. Seen:
    every ladder R4 case is ✅ (11/11, `w1drv-l3`), each with the W7 rung note.
14. **"Mexicano waits only on a finalized round."** It waits on any fixture not `decided`, so an M1 walkover
    (`forfeited`) stalls it. **Confirmed** 11/11 mexicano M1, failing set `[life-loop-bounded]`
    (`w1drv-l3-rerun`) → W7.
15. **"Dropping one L2 run removes only that run"** (plan review 1, I-4). The drop renumbers 931 of 1,731 runs and
    re-widths 949. Ruling 50 accepted the reshuffle once.
16. **"The open-format withdrawal cascade forfeits to the opponent"** (plan review 2, I-1). On the ladder,
    `page_playoff` and americano kinds the product abandons every pending fixture instead. `cascadeItems` became
    kind-aware (Task 7). Seen: TRIAGE P4 (`page_playoff_only` R4) records `pp-q2 abandoned` on all 11 cases, read from the triage DB.
17. **"Mexicano's players are the division's individuals"** (plan review 2, I-3). The active-entrant read has no
    kind filter, so from round 2 every earlier pair entrant also counts as a player. **Confirmed**: a later-round
    self-pair 500 on 32 cases (`w1drv-l3-rerun` 23, `w1drv-l3-fr2` 9), a repeated person on 32 (`w1drv-l3-rerun` 21,
    `w1drv-l3-fr2` 11), and the 500 once per L1 run on `mexicano|generic` → W7.

**Execution (each task's Step 0 or in-task premise that proved false; what was seen):**

- **Task 1.**
  - Step 3's expected-unread list was short by 5 sites.
  - The brief's `api-only-ui.ts:45-47` was `:43-45`.
  - "The drop reason reads `gap.route.why`" would have broken byte identity, so it was composed instead.
  - `OVERRIDE_ROUTE` was module-private.
  - The Status-row regex also matched the header row.
  - The widened arm found 10 live cases, not 3.
  - Provenance text naming a closed wave could not be "fixed by routing", because the judge refuses a closed wave.
    It was rephrased.
- **Task 2.** "Read `driver.calls` for the addEntrants count": the fake logs one bare name per call.
- **Task 10.**
  - `legalBalls: TEST_BALLS` on every innings is false for 23 of 24 `test` cases, because they override
    `ballsPerInnings`.
  - The draw's `Math.min(3, allOut)` closes a 3-a-side match early.
  - `tied` must guard `superOver` first.
  - `GENERATES_TIE` became unused.
  - The brief's file list missed `pad-adapters.test.ts`, a real consumer.
  - Follow-on "off" still needs `lead`.
  - PF-11: `readVariantsFile` and `readDropIndex` do not exist.
- **Task 3.**
  - `sportModule` is not exported from `@seazn/engine/sport`.
  - `LineupSlot.orderNo` is required.
  - The product orders a roster nulls last.
  - Lineup refusals carry no code: the wire code is `ERROR`.
  - No sport declares `team.maxMembers`.
  - The MCC Law 1 page returns 404, so ICC/ECB conditions are cited.
- **Task 4.**
  - A "posted seed → answered entrant" lookup guard pre-empts `life-built-as-posted`'s own canary.
  - The n−1 guard must reject before the trace logs.
- **Task 5.**
  - `setUpDivision` could not reach an americano row until Task 8; the test drives `buildDivision`.
  - The fake needed no change.
  - A pair kind on an americano row is refused by name.
- **Task 6.**
  - FP-1: the 409 is `/complete`'s `STAGE_COMPLETED_SEEDING_FAILED`; a later generate never refuses.
  - FP-2: a withdrawn qualifier's seat is left empty and walked over, not closed up.
  - FP-3: that 409 is a commit, not a retryable 4xx.
  - FP-4: `DriverMisuse` is the driver's guard.
  - FP-5: every reached stage is asked to complete once (T6-R2).
  - FP-6: draws were already per stage; only the LIFECYCLE check was stage-1-only.
- **Task 7.**
  - Draws are declared on a ladder for `generic` and `boardgame`.
  - An award (walkover) or a draw swaps nobody; only a decided win swaps.
  - A product text pin cannot see a harness copy, so a structural scan was added.
  - `runCanary` and `variantFor` did not exist.
- **Task 8.**
  - No `selfPairAnswers500` option is needed: the self-pair comes from the product's own points.
  - The brief's round-2 `[]` set is unreachable.
  - Whether `seatedLater` holds depends on person-id (UUID) order, so it is swept over both orders.
- **Task 9.**
  - `terminalFinalKeys` cannot live in `invariants.ts` (a boundary rule), so the snapshot computes it.
  - The snapshot's `ladder_order` was the setup-time copy; it is re-read once.
- **Task 11.** The own-session premise held: the active org is per cookie jar. But two pieces of per-USER state are
  shared across workers, and both were found live:
  - the owner's staff flag, flipped for entitlement busts (`240ed64ac`);
  - unused sign-in links, deleted by each new request (`login-link.ts:13`; `eff68a737`).
- **Task 12.** PF-11 again: the loaders did not exist, so they were added.
- **Task 13.**
  - The guard test "no route names W1-driving" could not pass at Task 13, because Task 14 owned the last route
    (`MODEL_ROSTERS`).
  - The gallery sends no visibility, so template competitions are created public.
- **Task 14.**
  - FP-T14-1: `ModelFakeDriver` could not run a swiss stage.
  - FP-T14-2: the fake's log shape is `calls` plus `trace`, and the method is `postStream`.
  - FP-T14-3: W1b's live seed does not transfer to the fake.
  - FP-T14-4: `run-cell.ts` has no model state when it picks the bias, so the bias derives from the row.
  - FP-T14-5: no committed case pins a command list, so the bias applies to replays too.
  - FP-T14-6: the cascade writes through `postStream` as well.
- **Task 15.**
  - Step 6's parity pair shared 0 cells (T15-R3).
  - The budget of "~1 min per case" was 0.5–7.8 s measured.
  - A fixed `policy !== "none"` expectation on americano could never go green (T15-R6).
  - The `gf-reset` prediction is not confirmed: no row sets `bracketReset`, so 0 cases.
  - The review's "18 P1 cases with a committed draw trace" was 5.
- **Task 16.**
  - The T1-R1 guard test (`scenario-catalogue.test.ts`) read the REAL W1-driving row and needed it open, so closing
    the row would have redded it. It now uses synthetic open rows, like its sibling.
  - The replay-rule test was hard-wired to `w1b-model-final`'s 5 cases; it now reads every committed
    `--regressions` report.
  - Run 514's `l3Gap` is gone since Task 10's regen, so W1d first task 4's premise changed.
  - The brief's seeding-tie routing "W4/W5" predates false premise 9: the swiss-source rows go to W3.

### Found during W1d planning

**Planning** (plan `docs/superpowers/plans/2026-10-04-format-matrix-w1d.md`, "False premises found in planning", with
file:line evidence there; numbers kept, including review 1's 21–22 and review 3's 23). After each, what execution saw:

1. **Item 4: "every case the layers build carries `run: null`."** Partly false. The four cited lines are the non-L2
   planners; `planL2` has set `run` on every L2 case since W1c `64ae38f4d` (`layers.ts:149`). The inert half held:
   `run.ts` never read `c.run`, and the strict schema would refuse `n` and `covers`. Task 2 records both.
2. **Item 7: "5 pre-existing errors in `scenarios.test.ts` is the whole of it."** The scope moved and widened: a
   test-inclusive TS7 program reported 124 errors (5 in the matrix's tests, about 90 in `tools/bench/**/__tests__`, 3
   in `scripts/__tests__`, 18 in apps/web, 4 environment artefacts), and `vitest` was not a root devDependency.
   Execution measured 8 errors after bench was left out, and **0 in apps/web** (see "Found while executing", 5).
3. **`counts.json` L1 = 462, "cells × 2 widths".** It contradicts ruling 39 and `widths.ts` (L1 is 1280 only);
   `committed-catalogue.test.ts:271` had frozen the stale value. Task 3 corrected both to 231 (ruling 64), and the
   docs were corrected in Task 16.
4. **"The wave that adds the weekly schedule must invert `ci-wiring.test.ts`."** The test reds on ANY workflow that
   names `matrix:l3` or `tools/matrix/run`, so a dispatch-only workflow reds it too (`ci-wiring.test.ts:244-252`).
   Task 9 reworked it.
5. **"Following `bench.yml`'s precedent (R84): three consecutive green manual dispatches."** `bench.yml` has never been
   dispatched: 0 `workflow_dispatch` runs, all 15 runs `pull_request` self-path runs (9 green, 6 red; `gh run list`,
   2026-10-04). The R84 bar was never met, and there is no worked example of the three-dispatch gate. PR-B's Task 17
   is the first.
6. **W1d prompt: "the design does not say what 'green' means."** It does: design §6.5 (D:326-331), including "case
   states are identical across the three runs". Ruling 61 adopts it.
7. **W1d prompt and item 27: "the trigger must NOT be GitHub `schedule:`."** Superseded by ruling 60 (`schedule:` +
   `workflow_dispatch` + a staleness signal, D1).
8. **W1d prompt: every ❌ "carries its gap ID", as if the reds already did.** W1-driving's 164 product reds are keyed
   by triage rule P1–P7 and coverage-table signatures, not audit IDs (`truth-runs/w1drv-l3/TRIAGE.md`). Ruling 63;
   PR-B's Task 19.
9. **`plan-facts-repo.md` §5's paths** (`scripts/bench/…`, `scripts/matrix`) predate the `tools/` move (#913, #914).
   The facts hold at the new paths.
10. **"Evidence moves out of `docs/` with the harness."** It stays: ruling 56 was amended on 2026-10-04 (12 MB, read
    by 12 CI test files). New evidence goes under `truth-runs/`, and new directories must not use the `w1drv-`
    prefix (`rebase-map.test.ts:81` requires every `w1drv-*` harness commit in the rebase map).
11. **"Exit 1 means the same thing in every CLI."** It does not: `findings-table.ts` and `draw-counts.ts` used 1 for
    "refused", `run.ts` for "zero cases", `model.ts` for "a NEW failure", `gen-catalogue.ts` for "drift"; unreadable
    input was 3 in `parity.ts` and 2 in `render.ts`. Task 6 declared one table (`lib/exit-codes.ts`, D8).
12. **RULING CONFLICT: ruling 64 × ruling 61 ("L2 = all 1,731 pair-runs" and "no ░").** Only 62 of the 1,731 runs have
    a harness script; 164 plan 🚫 and **1,505 plan ░ "no scenario script yet"** by construction (`layers.ts:139-160`).
    Resolved by **ruling 65**: "no ░" applies to driven cases only. Seen live: `L2 grid: 62 driven, 164 no_path, 1505
    not_run of 1731`.
13. **"The full L1 grid is 231 driven runs."** 53 of the 231 cells are API-only with no builder control, so they plan
    🚫 naming W4 or W5 (`api-only-ui.ts`). L1 = **178 driven + 53 🚫**, still 231 cases.
14. **Item 15: "forfeit and withdraw on league and knockout in the browser are unbuilt."** Half false. The full-grid L2
    already drives M1 and R4a on `league|football` (M1@430, R4a@390) and `knockout|icehockey` (M1@834, R4a@768): runs
    408, 64, 417 and 73. Task 3 pinned the four; the 1280 half was Task 14's (`carry8-1280`, 4 cases works).
15. **"Void is a product path the harness never reached."** No `OrganiserDriver` method voided anything; the product's
    void (`core.void {event_id}`, the console's per-row Void and "Void last", `fixture-console.tsx:1253,1278-1286`) is
    reachable in the browser. Task 14 added `voidLast`.
16. **The cited lines for item 15 drifted** (`run.ts:468-469` → `:561`, `lib/pad-proof-set.ts:16` → `:15`). The
    meaning held.
17. **"A scheduled run's payload carries the repository."** Unverified; design §6.5 assumed it. The guard does not
    depend on it (`gh api repos/$GITHUB_REPOSITORY --jq .visibility`). PR-B's Task 17 records what the first scheduled
    run's `github.event` held.
18. **"The Cloudflare cron worker can fire the weekly run."** It can only `POST ${BASE_URL}${path}` with
    `x-cron-secret` (`apps/cron-worker/src/call.ts:92-94`) and has no GitHub API target. Moot after ruling 60;
    recorded so the option is not re-offered.
19. **Design §7.5's "scheduling, competition and tiebreaker modules" are three directories.** They are two:
    `tiebreakers.ts` lives in `packages/engine/src/competition/`. The Stryker scope (rulings 66 and 67) is the whole
    engine except the placement files under `src/scheduling/`.
20. **W2 prompt trap 2** ("declared 3/0 loses to the FIH 2/1 the rulebook adopts", SC-P4) contradicts the SC-P4 false
    premise (`_INDEX.md`, "Found during W1b") and design §8 ("FIH 2/1 is Pro League only"). Not W1d's to fix; PR-B's
    Task 22 records it beside the W2 backlog.
21. **(Review fix round 1.) "The 11 `RefusedCall` reds in `w1drv-l3` are a harness-seeding shape."** They are not: all
    11 are `POST /api/v1/entrants/<id>/withdraw → 422`, the R4 scenario's withdraw action (P5 → W4). They stay data.
    The setup-call guard the review proposed was adopted anyway (`SetupRefused`, tagged by phase; D6), because a
    refused SETUP call would be a harness fault, and none exists today to witness it.
22. **(Review fix round 1.) "`bench.yml` builds the placement image with a `type=gha` cache."** No workflow at HEAD sets
    `cache-from:` or `cache-to:`; the comments only say so. What is load-bearing is `docker/setup-buildx-action@v3`.
    Moot under ruling 66 (no placement image in W1d).
23. **(Review 3.) "The greedy-fallback guard proves the solver is reachable and used."** It proved nothing: it counted
    log lines, never solver attempts, so with zero solver calls it printed `placement fallbacks: 0` and passed. The
    matrix drives no solver route (D23). A disclosure ("the report says plainly whether today's run exercised it")
    stood in for a check, which TEST-STRATEGY rule 1 does not accept.

**Found while executing PR-A** (Tasks 1–16; from the SDD ledger and the task reports, each a premise the plan or a
brief stated and the tree did not hold):

1. **The plan quoted a command its own guard refuses (Task 1).** The plan doc, line ~2706, quoted a matrix CLI
   command with no crash-exit preload; `cli-invocation.test.ts` refuses that spelling in any tracked doc, so
   PR-A's CI would have reddened on the plan itself. The plan's lines were reworded to the preload form (ruling
   T1-a).
2. **`expectedPlanFor` does not exist (Task 3).** The recorded-plan → planner map is `livePlan` (since Task 7
   `lib/expected-plan.ts`). Also: `pnpm matrix:catalogue` is check-only, and a test that reads `counts.json` cannot
   kill a `counts.ts` mutant.
3. **Item 5 has no user-reachable symptom (Task 5).** `NoLayerForWidth` is unreachable through the CLI today
   (`BROWSER_WIDTHS` = 1280 + `L2_WIDTHS`, and `layerOfWidth` covers exactly those). It is a defensive
   classification, pinned by a counted guard that every accepted width has a layer.
4. **"The judge's zero-compared guard is unreachable by construction" (Task 6, a sweep-round claim).** False:
   `matchPlanIds` drops the variant (and, on a plain plan, the width), so three same-plan runs at `@375/@1280/@375`
   share no case id: compared 0, and an uncaught ZodError at exit 3 under `--json-out`. Reinstated as `NoneCompared`
   (exit 2) with `CaseIdsDiffer` (ruling T6-I1). Same task: the plan named a consumer (`summary --judge`) for a
   `JudgeOut` that no task produced (PF-1).
5. **The "known data point" of Task 7's apps/web `queue.ts` errors was a nodenext artefact (Tasks 7 and 10).** The 7
   `TS2835`/`TS7006` errors exist only in a scratch nodenext config. Under `module: preserve` +
   `moduleResolution: bundler` the 34 apps/web files the tests reach have **0 errors** (Task 10 measured it, as D9
   predicted). Also drifted: the brief's `scenarios.test.ts` line numbers (734/745/1567/1776/1785 → 740/751/1573/1782/1791),
   and the plan's "67 matrix tests / 15 scripts tests" (86 / 15 at the time).
6. **A page of 100 workflow runs is a small answer (Task 8).** It is 1,235,638 bytes against `spawnSync`'s 1 MiB
   default `maxBuffer`: after about 85 runs the staleness signal and the weekly diff would have gone permanently dark
   (ENOBUFS, `status: null`). Fixed by a server-side query per event, a `--jq` projection and a 64 MiB backstop
   (ruling T8-I1), with a real-runner test over a fake `gh` on PATH.
7. **Ruling 61's "identical across three runs" spans THREE WORKFLOW RUNS, not one (Task 9, ruling T9-HG).** Ruling 62
   makes PR-B's three dispatches those runs, so ONE workflow run can never print "Harness-green: yes" or "no". The
   summary prints `Run complete: yes|no` per run and `Harness-green: needs 3 runs` (`matrix:judge across`), and the
   workflow's colour follows the per-run verdict.
8. **Assumptions about GitHub and `gh` that the tree or the tool did not hold (Task 9 and its reviews).** A two-dot
   `git diff $BASE_SHA $HEAD_SHA` against the base TIP lists main's commits as the PR's (a spurious R27 red on any PR
   behind main; three-dot fixed it, proved by a real-step scratch-repo test). `upload-artifact@v4` names are immutable
   per run, so a re-run 409s without `overwrite: true`. `vars.*` reach fork PRs (secrets do not), so a self-hosted
   `vars.MATRIX_RUNNER` needs an explicit fork gate (T9-FORK). `gh api … --jq` on a 404/5xx exits 1 AND prints the raw
   JSON error body to stdout, so a retry that tested "non-empty output" accepted the error as an answer.
9. **"The repo is public until after W1d" was stale at execution time (environment, 2026-10-05).** `gh api
   repos/onryde/seazn.club` said private (unauthenticated 404), so with `MATRIX_RUNNER` unset the visibility guard
   refuses and PR-A's own smoke would have gone red by design. The owner chose to flip it public again until W1d is
   done, then private; `MATRIX_RUNNER` stays unset meanwhile.
10. **The premise that Tasks 7–9 added code spawning `tools/` paths was false (Task 11).** None existed at HEAD (the
    matrix CLI tables live in `tools/matrix/__tests__`, outside the guarded trees). **Both brief-mandated spawn
    exemptions were dead at HEAD**: `boundary-gate.test.ts`'s spawn calls take variables, and the guard test's own
    `tools/` strings are fixture data. They are kept and their hits pinned to `[]`. The brief's "31 real
    child_process spawns" was 22 (`execFileSync` 17, `spawnSync` 3, `spawn` 1, `execSync` 1): of the 387 calls the
    scan inspects, 341 are `exec` (almost all `RegExp#exec`), 15 are the protobuf writer's `.fork()`, and 9 are the
    2048 game's own `spawn()`.
11. **A pad-proof or two-innings route did not exist where the brief put it (Task 12).** `--set pad-proof` plans each
    sport's builder default (cricket: `t20`), and all 24 committed cricket `test` cases carry rule overrides, so they
    are `no_path`: no committed plan reached the two-innings route (an inert seam). Pad proof on `test` is **red by
    construction**: follow-on and `match.close` are barred in two of three fixtures. Built `--set pad-innings`
    (ruling T12-I1) and proved it live on a plain `test` case. Also: follow-on and `match.close` have no pad control
    at all (More-sheet rows with no testid), so they are 🚫 W2, not routes; `league|chess` "not in PAD_SPORTS" cannot
    be built (chess is no catalogue sport, and `PAD_SPORTS === SPORT_KEYS`); item 15b's plan reader is
    `lib/expected-plan.ts`, not `committed-plans.ts`.
12. **The harness-minors premises (Task 13).** Item 10's premise was false at HEAD: `quiet` already lists the check
    rows, so both conjuncts are pinned and no production code changed. Item 17's literal `(W1d D11)` collided with the
    stray-wave guard (taught one parenthesised-citation shape, pinned by count, place and Status row). Item 20's
    cricket `test` cases sit on template cells and carry `overrides`, so they needed an exemption. Item 22 needed
    more than a label: the mixed ledger spends a type's browser turn on its first completion, so naming alone would
    have left the LAST stage's completion over HTTP, an inert seam. D16's trace (bullet 3) was not "one small
    commit": five production files across three layers, provable only against a fake. Dropped, with its reason.
13. **"Task 15 also appends to `plans.lock.json`" was false (Task 14).** Task 15 never touched it; the "lock" Task 15
    edited is `pnpm-lock.yaml` (only Task 14's `86af851a1` changed `plans.lock.json`, confirmed by `git log`). Also,
    the brief's "+5 lock entries" assumed one run per width; one results.json holds both widths, so there are 3
    (PF-3).
14. **D14's cost formula was 2.6× optimistic, from the first measurement (Task 15).** The probe measured 26.04
    runner-seconds per mutant (134 mutants, 740 s at concurrency 5, 42 s dry run), which is 8.67 s of wall at CI's
    concurrency of 3, against the formula's 3.33 s. At the measured rate 8 of the 12 groups were over the
    200-minute split line and `cricket.ts` alone (4,248 mutants) was over it three times, so the groups became **27
    legs plus the probe**, cut at top-level statement boundaries (a line range loses a mutant when one blank line moves; ruling T15-CUT). One
    sample on a loaded machine: Task 20 re-measures on CI. And adding Stryker (which brings `@babel/core@8`) made pnpm
    re-resolve the peers of `next` and `@sentry/nextjs` for apps/web: "a devDependency of one workspace moves no other
    importer" was false until two overrides pinned it (ruling T15-LOCK; a lockfile-reading test guards it).
15. **"Each task's scoped run covers the guards its change can trip" was false for four tests (Task 16's gate).** A
    union run over every test file the branch touched, with the repo-wide scan tests beside it, found four reds that
    no per-task run had reached, all in files a task did not name: `parity.test.ts`'s emitter scan (Task 14's browser
    check ids `fold-branch` and `runsheet-today-default` were not in `BROWSER_ONLY_PREFIXES`, so a browser run's match-day
    checks would have read as HTTP differences), `test-email-domain.test.ts` (Task 9's `summary.test.ts` fixture used an
    `@example.com` address Resend refuses), `z3-retirement-drift.test.ts` (a case id `z3` in `summary.test.ts` and the
    word in two comments of `tools-import-guard.test.ts` joined the ledger's scan), and `cli-invocation.test.ts` (this
    section's own first entry quoted a bare CLI command). All four fixed in Task 16 (the first with a production
    one-liner in `lib/parity.ts`); the repo-wide scans (`scripts/__tests__/*-drift`, `test-email-domain`, `dockerignore`,
    `cli-invocation`, `parity`'s scan) are the tests to run when a task adds a harness file or a check id.
16. **"A new workflow file is covered by its own tests" was false (whole-branch review, C1).** `matrix-truth.yml` booted a
    production `server.js` without `RELAY_DRIVERS: fake`, `ENV_NAME: ci` and `CAPTURE_QR_V2_ALWAYS: "1"`, and
    `apps/web/src/lib/__tests__/relay-drivers-ci-wiring.test.ts` sweeps EVERY file under `.github/workflows` (so `smoke-db`
    would have reddened on the PR's first run, past 26 green harness tests). Adding a workflow changes the answer of every
    sweep of that directory: find them with `grep -arl "\.github/workflows" apps/web/src tools scripts packages --include='*.test.ts'`
    (30 files at the final-fix round) and run them all, because the relay test stops at the first bad file. Same review: the
    probe's 39-minute timeout and the "calibrated on the 4-vCPU hosted runner" comment came from a LOCAL per-mutant rate that no
    hosted run had measured (I2); the probe now carries a stated x2 allowance and its own pin, and PR-B Task 20 re-derives
    every leg's timeout from a measured hosted run.

### Found during W2 brainstorm (2026-10-08, scouts at `7dd45eeab`)

1. **"Draws never reach a bracket" (`engine-db/competition.ts:144-150`) is false** — and the guard at
   `append-event.ts:335-346` checks only `draw`, so `tie` and `no_result` commit and seat nobody.
2. **Generic's deny-list misses `americano` too**, not only `page_playoff` and `ladder` (`generic.ts:650-654`).
3. **`SPORT_RULES` is at `apps/web/src/lib/match-rules.ts:323`**, not `server/usecases/match-rules.ts` (which does not
   exist). Volleyball and table tennis `setTo`/`finalSetTo` minimums are still 1 (`:184`, `:193`, `:270`, `:279`);
   ruling 31's floor of 5 is still owed (W2e).
4. **Forfeit and abandon are organiser-only in the pad's interface only** (`pad-host.tsx:727`); the server refuses
   only `core.finalize` and `core.void` (`usecases/scoring.ts:501-562`). Ruling 77.
5. **Refusing a level result at write time strands the scorer**: cfg freezes at the first event (V347), so a football
   knockout level at full time with no shoot-out can never record full time. Ruling 79.

### False premises found (W2a)

1. **"The default slice scope contains the L1 and L2 SC-O cells" (Task 1 Step 4) is false.** The L1 slice is 6 cases
   (league, knockout, swiss × generic, badminton; all six `works`) and the L2 slice is 68 (knockout, swiss × badminton,
   generic; 3 works, 7 no_path, 58 not_run). None of the 15 L1/L2 SC-O cells is in either: the Step 5 judge found 62
   of the 77 after Step 4. `--only` with `--layer L1|L2` is refused outside the slice (`UnknownFilter`, exit 2, nothing
   written) and `--scope grid` takes no filter, so the **Global Constraints local-selection recipe is refused on every
   L1 and L2 line** (12 + 1 refusals seen). The cells are reached by stripe, `--scope grid --shard k/64` (stripe k holds
   plan items i with i mod 64 = k-1): L1 stripes 7, 16, 18, 25, 27, 36, 38, 47, 49, 58, 60 and L2 stripes 2, 16, 26,
   recorded in `truth-runs/w2a-local-selection.json` under `browserShards`. Each stripe also drives 0-2 other cases.
   Tasks 14, 16 and 17 re-run L1/L2 cells by stripe, not by `--only`. (Found by the Task 1 executor, by running it.)
2. **"Append the lock entries exactly as the missing-entry failure prints them" cannot hold for a stripe run.** The
   printed entry is the whole grid plan, so a 4-case stripe fails `judgeRun` with "planned by …, missing from the run"
   for every other plan item. The 14 stripe entries in `plans.lock.json` are the printed entry restricted to the
   stripe, the stripe computed from the committed W1d baseline's plan order and checked both ways against each run's own
   case ids; the 19 unsharded runs' entries are exactly as printed. `pnpm matrix:lock-check --against HEAD`: 141
   compared, 33 added. A later stripe run adds its entry the same way.
3. **"No existing golden moves in W2a" (Task 4 Step 5, Task 5 Step 6) is false from Task 3 on.** `testkit/golden.ts` `recomputeStream` derives each stream's `deltas` for `league` and `knockout`, and writes `null` when the outcome is a draw the stage's `supportsDraws` refuses. Boardgame answered `true` everywhere, so its 18 committed streams with a drawn outcome (configs default, rapid and blitz × seeds 8, 9, 12, 15, 18, 24) recorded a knockout delta (`drawn: 1`). X-DR-1 makes that `null`. States, outcomes and summaries do not move. Re-baselined with `REBASELINE_GOLDEN=1` in its own commit (controller ruling D-G1); Tasks 4 and 5 keep "no existing golden modified" against the re-baselined corpus. (Found by the loop D executor, by running `golden.test.ts`.)
4. **The harness pinned the stall W2a removes.** `tools/matrix/__tests__/ladder-loop.test.ts` ("…a draw is posted on the first non-climbing step exactly where the engine declares draws on a ladder", which needs some sport to draw on a ladder; and the FakeLadderDriver swap test, which asserts generic draws on a ladder) and `multi-stage.test.ts` (two tests that expect generic/score's page_playoff draw to stick `group_playoffs`) go red under X-DR-1: 889/893 over the 8 harness files that read `supportsDraws`. Routed to lane P1, to be rewritten from X-DR-1 after D merges into it (ruling D-H1).
5. **"Task 4's file set is the kernel, the error maps and six readers" is false.** Registering `core.settle` in `CORE_EVENT_SCHEMAS` reds four `apps/web` suites that enumerate the registry: `event-copy.test.ts` (an unkeyed badge), `scoring-vocab.test.ts` (no `CORE_RIBBON_KEY` entry), `timeline.test.ts` (a literal 14 kernel types, now derived) and `clock.test.ts` (the stamp partition). The four codes red `tools/matrix/lib/driver/engine-http.ts`, a typed restatement of `ENGINE_HTTP` (tools-tests tsc plus 2 tests). Controller rulings D-C1 and D-C2 put both in Task 4. (Found by the loop D executor, by running the suites that enumerate `CORE_EVENT_SCHEMAS`.)
6. **"`outcomeOf`'s readers are exactly six" is false.** carrom's and generic's player-stat folds ran `foldMatch` and read `state.outcome` as a property, which the bare-call scan cannot see, so a settled level fixture credited a draw. Ruling D-C3 moved both and added the property-read guard. Boardgame's player stats read `boardgame.result` events directly (no fold) and still credit a settled drawn game as a draw; that is a different shape, left unchanged and reported to the controller.
7. **"Task 5's app surface is two pad label keys" is false.** Registering `boardgame.tiebreak` reds eight `apps/web` tests in three files: `scoring-vocab.test.ts` (no `EVENT_KEY`, no ribbon key in `PAD_LABEL_KEYS` or the four locales, no `ENUM_VOCAB` for the new enum field `rung`, and a literal enum-field pin), `event-copy.test.ts` (an unkeyed badge) and `skins/__tests__/boardgame.test.ts` (`EVENT_BAND` restates the module's fidelity map). Silently, the two new padSpec labels were absent from `PAD_LABEL_KEYS`: the cfg-space walk never reached them, because `tiebreak` is optional with no default and only the bracket overlay sets it. The walk now includes each module's `bracketDeciders` overlay. Controller ruling D-C4. (Found by the loop D executor, by running the 57 app suites that touch boardgame or a padSpec.)
8. **"`.default(false)` on `tiebreak` reds the golden suite" (Task 5 Step 8) is false.** `stateMismatch` tolerates the cfg embedded in a recorded state (`testkit/golden.ts:1869`), so a defaulted cfg field replays green — measured through `pnpm mutate`. The mutant is killed by the `"tiebreak" in league` assertion alone. Likewise "EXTEND writes new golden files": a corpus is one file per module, and the pass appended one stream to `boardgame.golden.json` (75 of 75 existing streams byte-identical). (Found by the loop D executor.)
9. **"Once settled, a chess tie-break is over everywhere" is false at the module.** A `core.settle` in phase `tiebreak` is kernel-owned, so the module state stays `tiebreak` and `awaitingDecider` stays true; only the effective outcome (`outcomeOf`) says it is decided. A pad gating on the module phase alone would keep offering the tie-break, and a `settleApplies` fed `module.outcome(state)` would answer true forever. Controller ruling D-C5: `settleApplies` short-circuits on any decided outcome, and `deciderPending(module, folded)` is the signal a surface gates a decider on. (Found by the loop D executor.)
10. **"Create `V431__fixture_status_needs_decision.sql`" (Task 7) is false.** V431 is `V431__auto_stream.sql` on main (#928); the migration is V432.
11. **"`toBracketFixture` has two callers" (Task 6) is false.** One: `apps/web/src/server/engine-db/competition.ts:637`.
12. **The Task 6 call-site ledger regex counts a comment** in `server/usecases/admin-fixture-config.ts`; the ledger strips comments first.
13. **"The run sheet's OPEN bucket is needs-attention" (Task 7) is false.** OPEN is Unscheduled-pile routing, unreachable for a held bracket row (which keeps its slot).
14. **The status-line test is `competition-hub.test.ts`**, not `competition-hub-schema.test.ts` (Task 7).
15. **"An abandon with no outcome" cannot be rigged on generic (Task 8).** Generic, football and cricket fold an abandon to `no_result`; boardgame's abandon leaves the outcome null and is the P2-7 rig.
16. **Task 8's finalize guard placed after the fold is unreachable** for an abandon with no outcome and a pending chess tie-break: every module refuses `core.finalize` of an undecided fixture with `WRONG_PHASE` inside the fold (`sports/setbased/kernel.ts:2368`, `football/football.ts:2147`, `cricket/cricket.ts:3789`, …). The guard folds the ledger before the candidate.
17. **There is no `member` org role (Task 9 brief `:81`).** `ORG_ROLES = ["owner", "admin", "viewer"]` (`apps/web/src/lib/types.ts:20`); an official scorer is a session with role `null` plus an accepted `fixture_officials` row.
18. **Task 9's `device-allowed` mutant is equivalent against the real producer.** A device-link ctx has `role: null` (`api-v1/auth.ts:271-278`), which `subjectToScorerCapabilityGates` already selects (`usecases/scorers.ts:46-50`); its witness is a hand-built device-link ctx carrying an organiser role (defence in depth).
19. **"An abandoned bracket fixture with no outcome is held `needs_decision` by loop F's rules" (Task 10 dispatch) is false.** `fixtureStatusFromFold` (`engine-db/append-event.ts`) checks an active abandon BEFORE the level-outcome hold, and the hold needs `outcome !== null`; the fixture is `abandoned`, and `settleApplies` is true for it, so the console offers the settle. Both held and abandoned feeders are now not-dead (D4), each tested.
20. **"Only the generator and the cascade write voids" (Task 10 brief, D4) is incomplete.** `withdrawEntrantCascade`'s void branch (`usecases/withdrawal.ts`, `applyUpdate`) writes a recorded `core.abandon` "entrant withdrew". On a seated open-format line (page_playoff, ladder) it lands, and D4 changes the opponent's fate from "eliminated by an invented walkover" to "held for the organiser's settle" (ruling C17; generic, cricket and carrom already behaved so, folding to `no_result`). On a TBD line of a walkover kind it is refused `WRONG_PHASE` "fixture has an unassigned entrant" — the known MB-002/MB-003 defect (→ W9 + W4), not new. Residual, driven: an abandoned line whose BOTH entrants then withdraw refuses both settles (`SETTLE_NOT_APPLICABLE`, C17), so its fed seat waits; the organiser's escape exists (void the abandon, forfeit, then forfeit the withdrawn winner forward; `completeStage` true) but is clunky → W2b's X-WD-1 / double-walkover clause, which belongs in its OWN `feederIsDead` clause.
21. **"NEW-H1 is the set sports and tennis" is too narrow.** Measured `core.start` + `core.abandon` over every module's first declared variant: football, boardgame, volleyball, badminton, table tennis, tennis, ice hockey and hockey fold to `outcome: null` (8 of 11); cricket, carrom and generic fold to `no_result`. The sweep requires both shapes. Football's shape is a cfg choice, which reconciles this with premise 15: `abandonPolicy` (`sports/football/football.ts:174`, applied at `:1658-1668`) defaults to `replay`, which folds to `null` (the first declared variant, measured here); `award` folds to the leader's award, or to `no_result` at a level score (the shape premise 15 recorded).

22. **"TIEBREAK_RUNGS is already re-exported from the boardgame entry" (loop-H addendum item 5) is true only on the harness lane** (`f4691d83b`, `feat/format-matrix-w2a-harness`); W2a's `packages/engine/src/sports/boardgame/index.ts` did not export it. The commit is cherry-picked onto W2a unchanged (`e2898a7db`), so the lane merge is clean.
23. **Task 11's e2e football stream `football.period.end` does not exist.** The held X-BR-2 stream is `football.period {phase: "HT"}` then `{phase: "FT"}` (`settle-seating.test.ts:140-142`); and a football division's entrants must be teams — individual entrants are refused by `assertRosterFits` and the start then fails `STAGE_NOT_READY` "need at least 2 active entrants".
24. **There is no official-scorer storage state (`e2e/.auth/official.json`, Task 11 brief `:398`).** The spec mints one: an org viewer whose person is the fixture's accepted official — the rows `acceptedOfficialCovers` reads — and asserts the courtside "My matches" link and the void control first, so the negatives cannot pass for a bare viewer.
25. **The brief's console shape left two gates for one fact.** Wrapping Forfeit/Abandon in `canOrganise` inside a band that is also gated made the inner gate an equivalent mutant (and Finalize's likewise): both survived the first sweep. The band's halves are now each decided once (`offerFinalize`, `offerOrganiserActions`) and read by both the band and its control.
26. **"The generic `score` variant declares allowDraws: true", so its pad shows a Draw tile in a league (Task 12 brief, Step 1 and the e2e) is half true.** The variant does declare it, but the generic Draw tile is a `win_loss`-mode tile (`skins/generic.tsx` `buildTiles`, the `else if (allowsDraws…)` branch of the result-only path) and the `win_loss` variant declares `allowDraws: false` — no declared generic variant ever shows Draw. A score-mode pad's level finish is the `settle` tile ("Finish from tally", `settleable`). Unit tests use `win_loss` + `allowDraws: true` for the Draw tile and a score-mode LEVEL tally for `settle`; the e2e uses the latter.
27. **The brief's tie-break winner names (`view.personNames[entrantOf(state, side)]`) can never resolve.** `personNames` is keyed by PERSON id (`registry.tsx` `personNamesFrom`), not entrant id, and the options were handed already-`t()`-resolved labels by a chassis that calls `t(opt.label)` again. Built: names from the on-field lineup (as the halves do) on a new `SheetChoiceOption.labelText` that wins over the key (`guided-sheet.tsx`). Where the lineup names nobody, the options read Home/Away — the same as the halves above them.
28. **The brief's Step 4 "the Draw tile's condition gains `!forbidsLevelResult(view.stageKind)`" and its `bg-draw-kind` mutant contradict ruling D-P1 (binding addendum).** Chess keeps Draw in every kind while live — the drawn game is how a bracket reaches its tie-break. Not built; the opposite is tested (`bracket-no-draw.test.ts`, "boardgame (D-P1)").
29. **The brief gates the tie-break on the module phase (`inTiebreak`); addendum 1 / D-C5 need `deciderPending`.** A settle leaves module phase "tiebreak", so a phase gate kept offering a decider the kernel refuses. The pad's view has no settlement (pad-host folds with `foldClient`, state only), so the skin reads the active `core.settle` off `view.events` via the engine's own `resolveVoids`, and `resolvePhase` reads "post" once it is settled.
30. **Helper path and shape (`__tests__/helpers/views.ts`, `statePatch`).** The house convention is `__tests__/_*.ts`, and a patched state proves the patch: `_views.ts` folds a real ledger for any sport.
31. **The dock filter is the chassis's, not the skin's (addendum 2 names `buildDock` :516).** `dockFor` (pad-host.tsx) filters on `isOrganiserOnlyEvent` of each chip's mutated payload, read by the render and by the dispatch's soft-commit decision — sport-agnostic on `filterTilesByBand`'s precedent, so the next sport with a payload-scoped authority write is covered without touching its skin. Also: the tie-break tile reuses padSpec's own `pad.boardgame.action.tiebreak` rather than minting `pad.boardgame.tiebreak.tile`, and the two score options carry keys (`score.clean` "2–0", `score.narrow` "1½–½") because the chassis resolves a key.
32. **Public result keys are method tokens, not the brief's `settled.*` / `tiebreakScored.*`.** `RESULT_KINDS` derives `matchCentre.result.${kind}` from the method itself and `match-centre-parity.test.ts` requires exactly that key, so the public keys are `matchCentre.result.settled_lot` … `tiebreak_armageddon`, plus `matchCentre.result.tiebreak_rapid.scored` / `.tiebreak_blitz.scored`. The ui keys keep the brief's names (`fixture.decidedBy.settled.lot`, `fixture.decidedBy.tiebreakScored.rapid`).
33. **Addendum 8's `officiating-lane.tsx:140` is stale.** A `needs_decision` fixture never reaches `CompletedCard` (ruling D-F3 keeps it among the assignments, whose card had no status badge), so the held badge is new on the assignment card and the completed badge was localised as well. Three private copies of "status word or raw token" (lane, console, device pad) are now `scoreStatusLabel`. Seen live: `.badge`'s `capitalize` turned the localised word into title case ("Needs A Decision") at 1280, 768 and 320, so the lane's badges opt out with `normal-case` (the console's status badge still capitalises — pre-existing, routed).
34. **The brief's `loadDict` helper does not exist.** The tests build their message function from the `ui.json` / `public.json` imports.
35. **A held fixture has no folded-document status.** The match-centre document's `header.status` never says `needs_decision`, so the subheading (`fixture-subheading.ts`) and the OG poster loader read the raw fixture status for the held case only.
36. **Addendum 9's fix is not in `TERMINAL`.** A recorded abandon is stored `abandoned` and stays terminal there; the guard is `isLiveFixture` (`LIVE` or `awaitsSettle`), which every "finished" arm already requires. A second `!awaitsSettle` in `allPlayed` was shadowed by it (no test could see it) and was removed. The division page builds its own phase input from `listDivisionFixtures`, which carries no ledger fact, so it reads `listFixturesAwaitingSettle` (the desk's own predicate) or the two pages would disagree about one division. A held-only bracket (a two-entrant final ending level, nothing else played) reads phase `setting_up` under the red pill — `hasPlayedFixture` counts decided and finalized only — routed, not changed.
37. **A decider method needs no branch in `resultMsg`.** The fallthrough already gives the bare `matchCentre.result.${kind}` sentence, and the only branch that could word a count — cricket's margin — cannot fire: a settle or tie-break follows a level result, and every level cricket fold sets `margin: null` (`cricket.ts` tie/draw/no_result returns). The `DECIDER_METHOD_SET` guard was equivalent in every reachable state and was removed.
38. **The desk's e2e sweep owed a row.** `competition-desk-actions.spec.ts` derives its required set from `ATTENTION_SEVERITY`, so the new kind needed a row. It is built on the RECORDED-ABANDON shape, the one that drives the desk's server-side ledger read; a `needs_decision` status needs no ledger. Generic refuses a level knockout result (`LEVEL_RESULT_IN_BRACKET`, Task 8), so the database test's `needs_decision` rig is a football 0–0.
39. **Premise 37 is reversed (fix round 1, ruling D-H1 M13).** The `DECIDER_METHOD_SET` guard is restored ahead of cricket's margin branch. The engine's level cricket folds never carry a margin, but a stored summary is data, and the crafted case (a decider method beside a real cricket margin, `match-centre.test.ts`) is the one the guard exists for.
40. **The engine takes an abandon during a chess tie-break.** Review I1 read both organiser actions as refused there; only `core.forfeit` is (`WRONG_PHASE`, `boardgame.ts:711`) — `core.abandon` in phase `tiebreak` is accepted (`tiebreak.test.ts:183`). The console hides both on any held fixture regardless (I1), so the organiser's way out of an owed tie-break is the settle.
41. **The division page has no phase pill (M3).** Its derived phase gates only the start-locks tip and the run sheet's default filter, and for an abandoned final "finished" and "scheduled" render the same page — no e2e on that page can kill `page.tsx:228` (`awaitsSettle: awaitingSettle.has(f.id)`). It is killed by a page unit on StagesPanel's `phase` prop with its positive pair (`d/[divSlug]/__tests__/held-final-phase.test.tsx`); the addendum-9 e2e asserts what the page does show, the run sheet's held row.
42. **"Assert `score-pad` attached" after a settle cannot hold (M8).** A decided chess game unmounts the pad (`shouldMountPad`: boardgame declares no post-match panel). The test's teeth are the same page's mounted pad with the tie-break tile before the settle, and no pad after it.
43. **A card's played count cannot see a recorded abandon awaiting its settle.** `card-stats.ts` counts by status in SQL; D-H2 adds `needs_decision` there, but a recorded abandon is stored `abandoned` with its hold in the ledger, so the card counts it unplayed while the desk phase (which reads `awaitsSettle`) counts it played. Recorded, not changed: the card count is outside D-H2's "desk phase".
44. **Stale mutant anchors.** `t2.json`'s `awaiting-entry-deleted`, `awaiting-entry-stale` and `awaiting-row-claims-proof` match nothing in the tree already at `c6fb5e55e` (loop G) — not loop H's, listed for the wave gate. `t5.json`'s `d-c4-event-band-dropped` WAS loop H's: Task 12 rewrote the line it anchors on (`"boardgame.tiebreak": 0` → `[TIEBREAK_TYPE]: 0`), so the mutant silently stopped applying; re-anchored and re-run in fix round 1.
45. **A test rename silently unhooks its mutants.** A killer names its test by title (`-t`); renaming two tests in this round left `t7.json`'s held status-line mutant and `t12.json`'s `winner-names` mutant pointing at titles that no longer exist. Both killers renamed with the tests.
46. **The status-set sweep was red on the branch before this round.** `status-set-sweep.test.ts` scans source TEXT, so no scoped run that selects tests by import ever picks it up: loop G's `bracketEngineStatus(f)` (`cea1a52c8`) moved the `engine-db/competition.ts` anchor, and Task 13 (`c5b75d100`) added `needs_decision` to the public subheading's and JSON-LD's played sets, refactored the lane's link set and split the OG poster's variant chain, all without ledger rows. Fix round 1 brings the ledger current, with the D-H2 and M5 sets classed `took-place`; the lane's set now names `"needs_decision"` as a literal so the sweep can pin it IN.
47. **`tools/bench` `scorer-driver.test.ts` has been red since Task 9 (`bf49cd67e`, loop F).** Its "ORGANISER_ONLY_EVENT_TYPES restates pad-host.tsx's AUTHORITY_ONLY_EVENT_TYPES exactly" reads a `new Set([…])` literal that T9 replaced with `= ORGANISER_ONLY` (`lib/organiser-only-events.ts`). Worse than a stale scan: the bench's own mirror (`drivers/scorer.ts:309`, `new Set(["core.forfeit", "core.abandon"])`) had lost `core.settle` and chess's forfeit results, so the tap driver would have routed both to the SCORER's adapter. Fixed on the controller's dispatch: the driver now routes by the product's `isOrganiserOnlyEvent(type, payload)`, imported (the module imports nothing, the `import.ts`/`IMPORT_CAPS` precedent); the source scan is replaced by two sweeps over the product's own lists (every core type → console route; every sport arm's forfeit values → console, any other value → adapter), plus a pin that the imported module imports nothing. Mutant `t9.json` `bench-routes-by-type-only` KILLED. Also found: `t2.json`'s three `awaiting-*` anchors occurred 0× after T9 retired the X-ST-2 awaiting row (`bf49cd67e`). The runner's own `validateMutants` refuses a whole list when one anchor is wrong, so none of t2's 90 mutants could run. Re-anchored on the controller's dispatch. The dispatch's premise, a "surviving `["BG-KO-2", …]` AWAITING_PROOF entry", was false: T12 (`95981b879`) emptied the map (`rules-reference.test.ts:12`, `new Map([])`), as Task 16 Step 5 requires. Each mutant keeps its intent against the empty map:
    - *deleted*: BG-KO-2's row loses its proof (`boardgame.md:6`, proof cell becomes `—`), and no entry exempts it.
    - *stale*: the map gains `X-ZZ-9`.
    - *claims-proof*: the map gains `BG-KO-2` while its row names `boardgame-tiebreak.test.ts`.

    `pnpm mutate` on t2 then killed all 90. The runner's validator accepts all 15 w2a lists, 580 mutants, and every anchor matches exactly once.
48. **"`w2a-local-selection.json` lists the five new scenarios" (Task 16 Step 1) was false at `a36c1dcf2`.** It held
   `"newScenarios": []`, so the brief's own assertion (`newScenarios` 5) failed before any run. The five keys
   (BRACKET_SETTLE_LEVEL, BRACKET_SETTLE_ABANDON, BRACKET_TIEBREAK, BRACKET_EXTRA_BOARD, BRACKET_NO_DRAW_GENERIC) were
   written in `e45d74203`, the commit the CI truth run dispatched.
49. **"Every new-scenario case carries `life-bracket-decider-exercised` = pass" (Task 16 Step 1) cannot hold for
   BRACKET_EXTRA_BOARD.** By M-6's design that scenario does not carry the check (`assertions.ts`: its extra board is the
   pad's and it posts no settle). Its 8 cases are judged by `reference-bracket-finish` (pass 8) instead; the other four
   scenarios pass the decider check on all 128 of their cases.
50. **"M1's walkover takes the first bracket fixture, so the policy's next hard-path slot is the fourth"
   (`m1-walkover.ts:110-113`, phase 3 fix round 1 M-6, `b7b1ff74d`) is false on a page playoff.** The walkover's loser
   is not seated in `pp-q2` (the product records a bye award), so only three bracket fixtures pass `decideRound`, and the
   walkover itself holds ordinal 0, the only hard-path slot. No decider is ever posted, so `page_playoff_only|*|M1` turns
   red on `life-bracket-decider-exercised` for every sport but boardgame (whose forfeit rides the pad, so `pp-q2` is
   played). The CI truth run (37916609028) shows it as 9 L3 regressions against W1d plus one D-P2 unexpected red
   (`page_playoff_only|generic|score|M1`). M-6 shipped without a run of that cell. It is a harness defect (the product's
   I2, I4 and stage-complete checks all pass), routed to the controller; Task 16 did not fix it (not its lane).
51. **"`pnpm matrix:render` (no arguments) writes MATRIX.md" (Task 16 Step 5) is false.** With no arguments it is a
   usage error (exit 2), and there is no top-level MATRIX.md. A MATRIX.md belongs to each run directory:
   `pnpm matrix:render <results.json> --out <dir>/MATRIX.md`. The CI artifact already carries one per layer, and the
   local re-render is byte-identical.
52. **"The evidence commit can carry the judges' text output" is false.** `committed-matrix.test.ts` (R14a) refuses a
   committed file it cannot read, and it reads JSON and Markdown only. A `.txt` file (the artifact's `faults.txt` files,
   the judges' stdout) reds the secret sweep, so the evidence keeps the `--json-out` files and quotes the verdict lines
   in `truth-runs/w2a-final/README.md`.
53. **"Run `pnpm smoke`" (Task 17 Step 1) names no script.** The root script is `pnpm test:smoke`. A scoped run of
   one suite has no filter flag; it needs the temp-copy recipe (a copy of `scripts/smoke.ts` with the suite list cut
   down), whose last check (the cleanup) always reports FAIL because the copy skips the suites that seed what it deletes.
54. **"The new smoke suite is the only smoke change W2a owes" is false.** `v13Suite` still expected a generic level
   knockout result to be refused `422 DRAW_NOT_ALLOWED`. GN-KO-1 (Task 8) made it `409 LEVEL_RESULT_IN_BRACKET`, and
   only a FULL smoke run reaches v13, so the branch's full run went red at 1194/1 until `06b0f428b` moved the check.
55. **"The match page says how the bracket was decided" is not proved by a body-wide search for the sentence.** The
   decided sentence is on three surfaces of that page: the court card (`mc-status-line`, match-centre `resultMsg`),
   the meta and og description, and the share text, which come from two builders. A prod-build mutant that dropped
   the court card's sentence ("<winner> won") survived the body-wide check, so the smoke check now reads
   `mc-status-line` and compares it exactly (`9ae6b64a5`).
56. **"Back-to-back full smoke runs against one label server are each a fair verdict" is false.** On one long-lived
   production server, run 2 failed 4 public-cache checks (sponsor strip, entrant rename ×2, sitemap) and run 3 failed 7.
   Nothing in the product changed between them. A freshly started server passed 1195/0, so restart (rebuild) the label
   between full runs.
57. **"The brief's e2e selector grep finds every spec W2a's copy reaches" is false.** A spec that measures every
   `score.status.*` key from the dictionary is reached by a NEW KEY, not by a selector:
   `e2e/walkthrough/scorer-sheets-scan-screens.spec.ts:940` pins the widest Spanish status as `forfeited`.
   W2a's `needs_decision` ("Requiere una decisión", 157 px, against "por incomparecencia" at 150 px) is wider, so CI
   walkthrough 2/3 (run 37923877314) reds. The spec's own comment says the case moves to the wider status, not past
   it. Routed to the controller (not test wiring this run owns).
58. **"The brief's PR body template satisfies R27" is false.** W2a touches `packages/engine/**` (47 declaring paths),
   and a body with no `Matrix rows:` line reds the `matrix-rows` job. Declared `Matrix rows: all`, because W2a splits
   every stage kind into `BRACKET_KINDS` and `DRAW_KINDS`, checked locally by `tools/matrix/ci/pr-rows.ts`
   (`rows=all`, exit 0).

### W2a per-screen verdicts (Task 17 Step 3, 2026-10-09)

Element crops from `apps/web/e2e/bracket-finish.spec.ts`, run with `W2A_SHOTS_DIR` against label `w2ae2`'s production
build at `9ae6b64a5`: 21 screens × 1280, 768 and 320. Per the owner's ruling of 2026-10-09, evidence images are NOT
committed. The crops stay in the gitignored SDD scratch dir (`.superpowers/sdd/2026-10-08-format-matrix-w2a/screenshots/`),
and the verdicts live here as text.
- **Horizontal scroll** is not eyeballed: the spec runs `expectNoHorizontalScroll` before every crop, and that file passed
  (parallel 235/235).
- **Tap targets**: the spec's own ≥44px asserts cover the console Settle, the dialog's controls and the pad's tie-break
  options; the desk button's height was measured from its crop.
- **PASS** means clean on alignment, text size, tap size (44px at a touch width), truncation and scroll.
- **FAIL** names the one thing that is off, and says "pre-existing" when it predates W2a.

**Verdict: the controller's, under the owner's delegation ("apply rec", 2026-10-08). Every W2a-introduced FAIL was returned to loop H and re-shot PASS (loop R, 2026-10-09); the four remaining FAIL cells are pre-existing and out of W2a's scope. Crops are in gitignored scratch, not the repo (owner ruling 2026-10-09). The D-R8 withdrawn-refusal copy (organiser settle, scorer pad) is PASS at all three widths.**

| screen | 1280 | 768 | 320 |
|---|---|---|---|
| console-held-block | PASS: sentence left, Settle right, 44px | PASS: same | PASS: sentence wraps, Settle full width 44px |
| console-settle-dialog | PASS: long name wraps whole; Confirm disabled until winner and reason | PASS: same dialog | PASS: bottom sheet, Confirm above Cancel |
| console-official-held | PASS (loop R M7a): no empty Scoring card; header → held note → Activity → lineups | PASS: same | PASS: no empty card; recorder meta truncated (pre-existing) |
| console-official-tiebreak | PASS: only Tie-break offered; pending note under the pad | PASS: same | PASS: phone order, note wraps |
| pad-chess-live-draw | PASS: "Draw / no result" full width | PASS: same | FAIL: board hint truncated "Tap to record the wi…" (pre-existing) |
| pad-tiebreak-tile | PASS: ½–½ board, only Tie-break | PASS: same | PASS: same |
| pad-tiebreak-rung | PASS: Rapid, Blitz, Armageddon and the lot hint | PASS: same | PASS: title and options wrap cleanly |
| pad-tiebreak-winner | PASS: the entrants' names | PASS: same | PASS (loop R M7c): "WHO WON THE / TIE-BREAK?" in order, Back on the same row |
| pad-tiebreak-score | PASS: No score, 2–0, 1½–½ | PASS: same | PASS (loop R M7c): "TIE-BREAK / SCORE / (OPTIONAL)", Back beside it |
| pad-tiebreak-armageddon | PASS: "a draw means Black advances" above the names | PASS: same | PASS: wraps (owner question: the sheet never says who had Black) |
| pad-generic-bracket | PASS: no-draws context, Level strip, no Draw tile | PASS: same | FAIL: action tiles two-thirds width, flush left (pre-existing span-2 grid rule) |
| device-pad-generic-bracket | PASS: as the console pad, on the device link | PASS: same | FAIL: the same two-thirds-width tiles (pre-existing) |
| pad-chess-dock-scorer | PASS: no forfeit chips for a scorer | PASS: same | PASS: chips stacked |
| public-match-held | PASS: "Level — winner to be decided", score 0–0 | PASS: same | PASS: long name ends in an ellipsis (the card's designed truncation) |
| public-match-settled | PASS: ENDED, "W2a Di advanced as higher seed" | PASS: same | PASS: the same designed name truncation |
| public-match-tiebreak | PASS: "won on rapid tie-break (1½–½)" | PASS: same | PASS: the score wraps whole to line 2 |
| public-bracket-held | PASS (loop R M7b): "Level — winner to be decided" as a rounded block beside "0 – 0", score on one line | PASS: same | PASS: same |
| run-sheet-held-abandon | PASS: red "Needs a decision" chip and Settle | PASS: same | PASS (loop R M7d): "Round 1 · abandoned" on its own line above the chip and Settle |
| me-lane-held | PASS: "Needs a decision" badge, "View match →" | PASS: same | PASS: badges on their own row |
| desk-needs-decision | PASS: "Settle the match" compact, a mouse width | PASS (loop R M7e): ≥44px at a touch width (asserted in e2e) | PASS: full width, 44px |
| desk-pill-needs-decision | PASS: red dot and "Needs a decision" (a pill, not a tap target) | PASS: same | PASS: same |

### W2a final truth run: the swiss_playoff R4 cells (Task 16, 2026-10-09)

Kept here, not in "W1d truth-run backlog" below: that section is `pnpm matrix:backlog`'s output byte for byte (`w1d-backlog-index.test.ts`), so a hand-written line there reds CI.

- **W2a final truth run (CI 37916609028, 2026-10-09): the swiss_playoff R4 cells, classified (11 checked)** — SC-O1 (`swiss_playoff|boardgame|blitz|R4`) went from red (stall) to **works**, on CI and locally: the **predicted fix**. SC-O2 (`swiss_playoff|generic|score|R4`) went from red (stall) to red on **SW-H1** ("round 5 paired nobody (SW-H1)", so the knockout stage is never reached). It works locally at `e45d74203`, so W2a closed the stall and the CI red is the **reason flip to SW-H1, owned by P6 (W3)**, not a W2a regression. Ruling D-P2's judge still counts it as an unexpected red, since the pins do not hold it and Task 16 did not edit them. `swiss_playoff|hockey|fih-outdoor|R4` is unchanged (SW-H1, P6/W3). The other 8 sports stay works. Evidence: `truth-runs/w2a-final/README.md`.

### W2b final truth run: the cells that moved (Task 16, 2026-10-13)

- **W2b final truth run (CI 38362040946, `headSha` `191f2692e`, 2026-10-13): every moved cell, classified (6 moved at
  L3 against W2a's final run 37951331449; L1 0 of 231 and L2 0 of 1729 moved).**
  - The five boardgame R4 cells (`knockout`, `knockout_third_place`, `ko_plate`, `double_elim`, `qualifying_main`) went
    red → works. This is W2b's predicted green (CD-T13).
  - `swiss_knockout|football|11-a-side|R4` went works → red: "round 5 paired nobody (SW-H1)".
    - It is owner ruling 70's lots-flip cell (P6, W3), not a W2b regression.
    - **Controller ruling (a):** it is accepted, named, as the one newly red; no re-dispatch. With ruling 70 applied
      (judged against `w1d-baseline`), L3 has 0 newly red.
  - `swiss_playoff|generic|score|R4`, the W3 SW-H1 pin, is works on this run, and D-P2 reports it greened.
    - **Controller ruling (b):** that is the same lots flip, not a W2b green. The pin stays.
  - **Controller ruling (c):** the baseline is 37951331449; the committed `w2a-final/ci` (37916609028) is cited too.
  - Evidence: `truth-runs/w2b-final/README.md`, "Steps 4–7".

### False premises found (W2b)

1. The W2b brief listed C17 as an owner constraint; it was a W2a controller ruling. Ruling 90 is the owner's answer.
2. RB2B-14 (ruling 72) said settle gives a double no-show "an honest record instead of a fake walkover"; settle
   advances one absent side. Ruling 84 replaces that path.
3. RBB contradicts itself on double-walkover goals (football "0-3 each", hockey "0-5 each", RB2B-15 "no goals").
   Ruling 85: no score.
4. No source assigned ST-G1 (high, live) to W2b; ruling 83 does.
5. RBB §8's new gap ids were never registered here — registered now: **F-16 / H-14 / I-16** (pitch score overwritten
   by the award), **H-13** (hockey walkover 3-0, federation 5-0), **H-15** (hockey Q4 abandon, → W2c), **B-7** (chess
   forfeit refused before start), **B-9** (chess double forfeit is not a loss for both), **C-6** (carrom walkover keeps
   only boards played), **C-8 / G-7** (no double walkover in carrom/generic).
6. "Replay" for an abandoned match is not a feature: `replayFlagged` is read nowhere in apps/web; voiding the abandon
   resumes the old stream. A replay-from-0-0 reset is unowned.
7. W2a's planned X-ST-2 list missed chess `boardgame.result{forfeit | double_forfeit}` (fixed in W2a, D-O1).
8. Seating and ranks disagreed on an `award` loser in double elimination (`fed-seats.ts` vs `competition.ts`).
9. Auto-advance treats `finalized` as open (`scoring.ts`) — to reproduce in W2b.
10. Line pins are branch-relative: a session reading another revision cited `boardgame.ts:617` and
    `withdrawal.ts:108-112` for what W2a `a36c1dcf2` has at `:711` and `:129`.
11. **Item 8 is false for the `award` (W2b Task 1, DE-RK).** Today a badminton walkover loser in double elimination
    is seated in no losers'-bracket line and `bracketRanks` ranks it 4th of 4, so seating and ranks agree. The X-DE-1
    red is chess: boardgame folds `core.forfeit` to `win{method: "forfeit"}`, which seats the forfeit loser on the loser
    edge (two losers'-bracket lines in the probe) and, winning out, ranks it 1st. Evidence `truth-runs/w2b-repro/`.
12. The plan's C17 probe rig ("badminton … reaches `needs_decision` through an abandon with a level outcome") is
    unreachable: an active abandon answers `abandoned` before a level result is read, and badminton has no level
    result. The probe holds the semi with football 0-0 at full time, as W2a's suite does.
13. The plan's truth-run selection `only: "<caseId minus |R4>"` is refused by `matrix:l3` (`UnknownFilter`, EXIT=2):
    `--only` takes `<row>|<sport>`. `w2b-local-selection.json` holds `row|sport` and the judged `caseId`.
14. The plan's cell judge reads `.verdict` from one `$OUT/L3/results.json`; each run writes
    `$OUT/L3/<run-id>/results.json`, and a case's verdict is `.state`.
15. `pnpm matrix:lock --append` does not exist: lock entries come from `committed-matrix.test.ts`'s missing-entry
    failure (W2a Task 1's procedure), proven append-only by `pnpm matrix:lock-check --against HEAD`.
16. The plan's red judge "`failedSuites == 0`" cannot hold for a red under vitest 4.1.11: `numFailedTestSuites` counts
    the file and each `describe`, both failed when a test inside fails. A red is judged collected by an empty
    `.testResults[].message` and the expected `numTotalTests`.
17. Task 16 Step 5's "rerun Step 2's judge with the CI L3 results added: EXIT=0, `greened: []`" judges nothing about
    the CI run. `w2a-expect.ts` lets the first `--now` holding a case decide it. W2a's committed CI L3 already holds
    all 937 L3 cases, so the CI L3 appended last is never read: exit 1, the same verdict as Step 2's
    `w2a-expect-after.json`. The tool's own order, CI first, gives exit 0, `greened: [swiss_playoff|generic|score|R4]`
    (a lots flip, controller ruling (b)) and 0 unexpected red. Evidence: `truth-runs/w2b-final/w2a-expect-ci.json`,
    `w2a-expect-ci-literal.json`.
18. Task 16 Step 6's `pnpm matrix:render … --out "$R/w2b-final/MATRIX.md"` reds `committed-matrix.test.ts`. Its sweep
    reads the `results.json` beside every tracked `MATRIX.md` (`ENOENT: … w2b-final/results.json`, proven with the
    file staged). The render stays per layer in `w2b-final/ci/<L>/MATRIX.md`, as W2a's does.
19. Task 16 Step 5's baseline "W2a's last committed CI results (`TR/w2a-final/ci`)" is run 37916609028 (harness
    `e45d742`), which is not W2a's final run. W2a's final run is 37951331449 (harness `4162e79`, the run the W2a
    review gated the merge on), and it differs at L3 by 11 cells, all red → works. The step's own fallback ("if
    `gh run download 37951331449 --name merged` still serves") applies, and the artifact still served on 2026-10-13
    (controller ruling (c)).

### False premises found (W2c)

Items 1–6 are the design's §14; item 7 points at the plan's own; the rest were found in execution (SDD ledger).

1. **"11 production caller files" for `resolveFixtureCfg`.** 9 files and 11 sites on main, 10 and 12 after W2b;
   `overlay/recent.ts` holds a comment only, and the design's "~11 callers" omitted `admin-fixture-config.ts`. Task 3
   re-pinned 12 real sites; the caller ledger (`bracket-overlay-callers.test.ts`) reached 17 by Task 19.
2. **RB2B-1's harm** (an unfinishable level knockout result) was already closed by W2a's ruling 79, and the LEDGER cite
   is :169, not §150. No code-level creation refusal existed (plan finding 30); the owner's Q7 "B" settled it.
3. **M11 ("rules change silently after the start").** Stage-level rules already locked after the start
   (`STAGE_FORMAT_LOCKED`). The division save was not silent but too strict: `FORMAT_LOCKED` on any config change once
   fixtures existed, while the `tiebreakers` column had no lock at all (plan findings 1–2; ruling 136).
4. **ST-G10 "→ W5" is stale.** The design lists it under W2; it is W2d's.
5. **Cricket's "Super over on a tie — Knockout fixtures only." is false.** The engine plays a super over on any tie
   when it is on (code read). CK-SO-1 now says so.
6. **The staff re-snapshot hatch** would have been useless under W2c's locks (it re-froze from locked live config).
   Resolved by Q11: the hatch goes through `refreezeFixture`.
7. **The plan's own refuted premises** are plan findings 2, 11, 20, 28, 30, 32, 33, 38 and 39 (plan §"Plan findings —
   detail").
8. **"`lib/match-rules.ts` has only `@/` importers" (Task 1) is false.** `tools/matrix` imports it by relative `.ts`
   path under plain Node (5 files, plus `boundary.test.ts`'s `ALLOWED_WEB`), so the per-sport split needed `.ts`
   sibling suffixes and a plain-Node load check. `ci.yml`'s matrix paths-filter still named the old file until the
   Task 3 rebase.
9. **"`tiebreakers: []` means no tie-breaks" (the controller's Task 2 ruling) is false.** `division.tiebreakers ??
   defaultTiebreakers` makes `[]` an empty cascade. Retracted.
10. **"The next migration number is main's maximum plus one" (Task 3 re-pin, V439) was false in Task 10.** Chess's
    unmerged V439–V442 were already deployed to the shared staging database, and Flyway runs no out-of-order
    migration. See the controller's migration-number ruling.
11. **"Every decider may be shortened per match" (the controller's first X-SR-2 ruling) overreached owner Q5.**
    Cricket `superOver` and the period `overtime` / `shootout` objects are stage-only.
12. **"The fold can enforce BG-KO-1's 'in order'" is false.** Rapid and blitz events always carry a winner and an
    Armageddon always decides, so the engine never learns that a rung ended level; enforcing would accept only the
    first rung (ruling 132).
13. **"One completion predicate reverses ruling 105" (Task 7 re-review) is false.** Ruling 105 already says a plain
    abandon holds auto-advance; only an explicit complete bypassed it.
14. **Task 13's briefed premises.** Community already has `standings.custom_points` (V393), so plan Review Focus 3 and
    Task 18's "a Community org sees the gate" were wrong (ruling 151 then removed the gate state). Badminton refuses
    `loss_margin_lte`. Badminton already pays a walkover 2-0. Managing stages with an API key needs Enterprise.
15. **"The X-SR-6 notice is shown before saving" (plan Review Focus 4) had no product behind it** (Task 13b). No
    product code computed "every decider off"; the predicate lived only in a test sweep, and the product stored `[]` as
    a value. Built in Task 17 (`deciders-off-notice.tsx`, `decidersAllOff`).
16. **"The public stage line should name a stage's decider override" (batch 4 M4) had no case yet.** The describer's
    four sports had no deciders; Task 16 built the line for every sport.
17. **"A task's scoped run covers the scans its change can trip" was false again and again.** A source scan or census
    is selected by no import, so the task's own run never saw: `tools/matrix` `scenarios.test.ts` (Task 2's lock
    rename); `ci.yml`'s paths-filter (Task 1); `w2a-streams.test.ts` (Task 7's abandon options, found at the chess-lane
    merge); `bracket-overlay-callers.test.ts` (the Task 15 + Task 16 merge, a 16th site; Task 19, a 17th);
    `forfeit-vocabulary-scan.test.ts` (16b's unread forfeit writes, missed by both 16b reviews, found by 16c);
    `outcome-readers.test.ts` (the S5 sheet's `step.summary(`); `status-set-sweep.test.ts` (Task 19's lock key);
    `history-panel-contrast.test.tsx` (Task 17 moved a field-help span); the `tools/matrix` catalogue and scenario scans
    (Task 13's comment inside `http.ts`'s ZodError branch, and the spread StageConfig refusals); and four `tools/matrix`
    files from Tasks 9 and 13 (`ci-wiring`, `single-sport`, `denied`, `format-gates-copy`). Each was fixed when found;
    batch-end reviews and the batch-6 triage caught most.
18. **"Red on the base, so pre-existing" was false three times.** `outcome-readers.test.ts` (the S5 sheet, a W2c
    commit not on main), `public-division-loaders-identity.test.ts` (the X-AB-5 commit, W2c's) and the pad-cfg
    resolution test (a Task 12 regression). A red is pre-existing only if main is red too.
19. **"A rule change after a recorded walkover is re-stated" (Task 16b brief) is false.** Every door already locks it
    (`STAGE_FORMAT_LOCKED`), and no table stage holds a score-bearing event-less walkover.
20. **"A rule award reaches the player profile" (batch 16b+16c M-4) is half false.** The profile loader drops an
    unplayed walkover (X-PS-1), so a rule award never reaches a profile line. The release note was dropped.
21. **GOLDEN-POLICY's "16b raised the epoch for it" and "recommended to GF-2" were false.** 16b bumped only for the
    opt-in keys, and the engine owner put per-stream `foldOptions` in GF-3, after W2c.
22. **"Carrom's `sharedAbandon#200125` stream covers `share`" (Task 16c) is false.** That stream has no
    `core.abandon`; a share stream was appended.
23. **"Run `REFORMAT_GOLDEN=1`, then `EXTEND_GOLDEN=1`" was false for W2c's corpora.** Football, hockey and ice hockey
    refuse to reformat on W2c's `abandonAward` streams (the recorded draw replays as null), and the reformat is
    all-or-nothing. The route (engine GF-2 review, 2026-10-16): take main's corpora, re-record
    `knockoutTiebreak#100008`, then `EXTEND_GOLDEN=1`.
24. **"Every declared stage key has an editor field" (Task 17 brief) is false.** Five have none (ruling 157).
25. **Task 18's briefed premises.** There was no entitlement hook (a page-level `hasFeature` prop now); the "part of
    Pro" copy had been false since V393; the standings test ids it named do not exist (asserted through the API).
26. **"V465 is on main" (the r2 session, 2026-10-19) was false.** `origin/main` `190d9fbc50` topped at V464, and chess
    #992 (V465) was still open. A migration number is read from main, never from a peer.
27. **Task 22's brief command and file list were wrong.** `pnpm exec stryker run --mutate "…"` is not how the engine
    scopes a run: it is `STRYKER_MUTATE="file:a-b" pnpm mutation` (`stryker.config.mjs`). The list missed 10 engine
    files W2c edits and named `sports/period/shootout.ts`, which W2c does not edit.
28. **The plan's MD-1 scope ("every survivor in every file W2c edits") contradicted owner ruling MD-1's table.**
    Measured: 17,590 mutants over 24 edited files, at least 3,800 whole-file survivors. See the controller's MD-1
    ruling.
29. **"The r3 Stryker re-runs that wrote no report failed in Stryker" was false.** The Mac slept (`pmset`) during the
    1–3-hour runs (12 tries); under `caffeinate` they completed.
30. **"A take-back needs an event, so a played stage refuses every writer and needs no version bump" (batch-5 fix,
    Q5) was false.** The reviewer drove a division table-key save on a played knockout that rewrote an event-less
    walkover with no bump, and a tap at the old version was accepted. Fixed: only a feederless bye is excluded.
31. **The DENIED scenario scan saw 0 gates (batch 6).** Task 13 moved the stage gates into `assertStageBatchGates`, so
    the scan stayed green while blind. It now follows the gates and asserts a count above zero.

### W2d and ruling 70: the swiss_knockout L3 cells (Task 21, 2026-10-28)

W2d's stored lots draw (rulings 181, 183) is the base W3 builds on, but Swiss stages keep their own orders (ruling 193),
so a Swiss stage's `lots` still reorders tied entrants per run and ruling 70's three cells can still flip. The
regression check is `judge regression` over the L3 cells against `truth-runs/w1d-baseline/L3/results.json`, which
applies ruling 70's held-red list (`RULING_70_IDS` in `tools/matrix/lib/pr-sample.ts`). It needs a live server, so it
runs on CI only (the per-PR sample, R27, or `matrix-truth.yml`), never locally.

- **PR A, CI run 40488213516** (head `92da8b4b37`, attempt 2), job "Matrix per-PR sample (R27) / L3 shard 1/1", all
  937 L3 cases in two passes. The judge: "compared 937 cases; 3 regressions" (the three chess americano cases of main's
  #1027, ruling 210) and "baseline overrides: 3 case(s) held red (cause P6, SW-H1, W3) — owner ruling 70". The 45
  swiss_knockout cases: pass 1 had 2 red (`swiss_knockout|football|11-a-side|R4`, one of ruling 70's cells, and
  `swiss_knockout|hockey|fih-outdoor|R4`, red in the committed baseline), both on SW-H1; pass 2 had 1 red (the hockey
  cell). The football cell's flip between passes is ruling 70's own lots flip. **0 new P6 cells**, so nothing is
  recorded against ruling 70 beyond its three. The four boardgame blitz swiss_knockout cells red in the baseline
  (LIFECYCLE, M1, R4, F1) are works: an improvement, not a regression.
- **PR B** (`a719e11309`) is owed the same run. PR B's engine source is Task 17's lines in `display.ts`, `points.ts`,
  `standings.ts` and `tiebreakers.ts` and Task 18's hockey goal kinds; whether any of it moves a Swiss cell is what the
  run answers. The controller's step: add a `Matrix rows: all`
  line to the body of #1053 (R27 refuses a PR that touches `packages/engine/**` with no declaration, and the job reads
  the body when it runs), so CI run 40613962144's "Matrix rows (R27) + truth-run staleness" job passes (re-run it if
  it already ran), then read the "Matrix per-PR sample (R27)" job's judge line and its swiss_knockout states. A new swiss_knockout P6 cell is recorded here against ruling 70, not
  parked.

### False premises found (W2d)

Item 1 is the design's §4; item 2 points at the plan's own; the rest were found in execution (SDD ledger) and at the
fold.

1. **The W2d spec's §4, P1–P29**: the brief's premises that the scouts and the build refuted, each with its pin and
   the decision that answers it. P27–P29 were added in PR B (Task 14b).
2. **The plan's own**: Plan findings PF-1..PF-16 (plan §"Plan findings"). The two with the widest reach: PF-15, the
   pre-flight scan (PS-1..PS-10) found false premises, stale pins, an unrunnable B1 seed and wave-order hazards in the
   plan as approved; PF-16, a `pnpm --filter @seazn/engine` command matches no project and exits 0 having run nothing
   (the package is `@onryde/seazn-engine`).
3. **"48 ids" (Task 0's brief).** Appendix A holds 44: 43 new rows and the X-WO-1 amendment.
4. **"Hand f-w2c a note" (Task 0 Step 5).** W2c had merged without the changes the note asked for and f-w2c was closed;
   the step was void (PF-13).
5. **"The corpus `configs` stay byte-identical" (Task 3, plan Step 7).** A removed cfg key cannot land that way: the
   configs move, and the deltas are what stays byte for byte.
6. **"The shoot-out delta move is an artefact" (the controller's first Task 3 ruling).** Retracted: a shoot-out's 2/1
   booking moved from `standingsDelta` into `tablePointsRule` (spec §5.1), so golden deltas move exactly as PS-1
   briefed.
7. **"`buildOnBlank` is dead after Task 3."** The web still reads it (`match-rules/index.ts`, `run-contract.ts`); kept.
8. **"The web passes `countedFixtures`" (plan :782).** Withdrawn: the engine counts per pool, carried openings included.
9. **"An organiser's No-result abandon pays a `no_result` outcome" (PS-5c).** It folds to no outcome and stays out of
   the table (Task 1; controller ruling).
10. **"A forfeit as a direct encounter is FIDE C.07's" (Task 4 N2).** No rulebook source covers it
    (`rulebook-W3-swiss.md` summarises art. 16 forfeits and is silent on direct encounter); the test is a parity pin,
    and the owner let the engine's behaviour stand (ruling 214).
11. **"The qualification plumbing broke" (merge-fix).** It never broke; `slideshow-labels` and the stryker floor were
    already red at Task 9's tip. Separately, two page-qualification-plumbing test files had not been collected since
    `889b6ecb09` (a registry read at import), found and fixed in Task 9 round 1.
12. **"The `engine:boundary` red is main's new guard" (PR A rebase).** Its pin was in the merge base; the red was W2d's
    own (`setbased/kernel.ts` value-imported `SET_SCORE_KEY` from `competition/points.ts`, about 104 KB onto the phone),
    and no W2d gate had run `engine:boundary`.
13. **"An ITTF-equal flat rule over a split sport is refused needlessly" (Task 10 N2, parked to Task 13).** False: no
    flat rule equals a split sport (an after-play retirement or DQ pays `loss.regulation`, an unplayed loss 0, D6), so
    flat-over-split is always 422 and the owner question on table tennis 3/1 + 3/0 is moot.
14. **Task 13's brief:** `GET /stages/{id}` did not exist (added); `stagesKeptPinned` was already in PR A; there is no
    `pnpm smoke` script.
15. **Task 14b's brief:** the shoot-out kick event is `football.shootout.kick`, not `football.penalty` (spec §5.2,
    §13.5); public standings carry no `source` or `pinnedAt`; HK-TB-2's ranking half is Task 14's (spec §4 P27–P29).
16. **Task 12's pinned "no note" expectations** froze a defect: the partial-schedule and lots note was written only when
    lots or the seed decided (found in Task 17, class 4).
17. **"Settings has a division order editor" (Task 19).** It has none; the division order is saved through
    `PATCH /divisions` (D11's editor is the stage's).
18. **"The hockey 3 / 2 / 1 / 0 (shoot-out) preset changes what hockey pays" (Task 19).** On hockey's default variant
    it pays 2/1, the FIH default already (`hockey.ts`, `period/kernel.ts`, `points.ts`), so the preset is a no-op
    there.
19. **"Task 13's and 14's engine lines remain to sweep" (Task 20).** PR B's engine source is only Tasks 17 and 18, both
    already swept; the delta sweep is empty.
20. **"The generated i18n-keys and OpenAPI files are merge-borne" (the PR B rebase brief).** They are not; only
    `scripts/smoke.ts` and `apps/web/e2e/mobile.spec.ts` carry evil-merge content.
21. **"Spec §12.3's W5 amendments are prose edits" (Task 21).** Two of the three targets are machine-held. Design §8's
    W5 row (`2026-09-27-format-matrix-design.md:455`) is the routing oracle of `tools/matrix/catalogue/gap-routing.json`
    (ST-G4 and ST-G13 → W5 by name, basis `D:455`; ST-G12 → W5 by scope, `scope:D:455:group`), held by
    `gap-routing.test.ts`. The `_INDEX.md` rows it names (ST-G4, ST-G12 and ST-G13 under "### W5") sit in the W1d
    backlog section that `pnpm matrix:backlog` writes from the committed W1d triage. Dropping ST-G4 and ST-G13 from
    W5's row alone would leave them routed to W5 by scope (a group-stage gap, as ST-G12 already is); moving them means naming all three on the W2 row, re-routing
    them to W2 (basis `D:452`), re-writing the W1d baseline's committed `TRIAGE.md`, `REKEY.md` and `AUDIT-LEDGER.md`,
    regenerating the section and re-pinning `gap-routing.test.ts`'s counts: a rewrite of committed W1d evidence, which
    is the controller's or the owner's call, not a fold's. Done instead: the W5 prompt (`W5-round-robin.md`) and a
    dated note under design §8's table record the move (ruling 183).
22. **"No owner ruling signs RB2B-7" (the W1d backlog carry on SC-P4).** True at W1d, outlived by ruling 189 (B2) and
    ruling 186 (D10(f), the SC-P4 oracle). The carry now says so, the section is regenerated, and its pin checks the
    signing ruling instead of the absence.
23. **"Every signed W2d row names its proving test" (Task 21).** Seven rows (FB-TB-3, BG-TB-2, CK-TB-1, VB-TB-1,
    TN-TB-2, CA-TB-1, GN-TB-1) were proved only by data-driven cases whose titles the rules checker cannot read
    (`it(c.title)`); their group and test titles now name them (controller rulings, the fold).

### False premises found (W2e)

Items 1–31 are the W2e spec's §4 (E1–E31), in its numbering (E11–E13 sit out of order there); items 32 onward were found
in execution (A0 and the task reports in the SDD ledger) and at the fold. The spec is
`docs/superpowers/specs/2026-10-28-format-matrix-w2e-design.md`, with the plan beside it in `docs/superpowers/plans/`.

1. **E1 — IDX line pins from the 10-25 handover** (the W2e bullet at ~:3856, the MD-1 table at ~:1966). They were
   :4222 and :4427–4470.
2. **E2 — "`w2-start-prompt.md` exists only on the owner's machine".** It is in the main checkout, under
   `.superpowers/handoff/2026-10-08-w1d-close/`.
3. **E3 — `lib/match-rules.ts` holds the editor rules.** It is the directory `lib/match-rules/` (one file per sport); every
   `match-rules.ts:NNN` pin in IDX, RBS BD-3, the AUDIT-LEDGER and `wave-fix-location.md` is stale.
4. **E4 — the 14 "absent" checklist rules need engine builds.** For 8 the engine already implements the rule; all 19
   in-match mechanics exist. Only the sanction endings, `strength.min`, timeless NRR (partly) and `progressScore` needed
   engine behaviour.
5. **E5 — `tennis.game.award` is absent** (AUD row 20). It ships, with its pad action (S5 #431).
6. **E6 — ice hockey has `releaseOnGoal`.** The behaviour is `releaseForGoal`.
7. **E7 — football shoot-out attempts are fixed at 5** (SC-P7). Configurable since W2c (FB-SO-1); only the dead
   `suddenDeath` half stood.
8. **E8 — `competition/display.ts:72` hard-codes 6 balls** (SC-C7). Still true, at `:98`; it became ruling 239's fix.
9. **E9 — cricket `points.draw` is absent.** Closed by W2d (CK-PT-2, ruling 197).
10. **E10 — the older `competition/stage.ts` and `progression.ts` survivors are W2c's.** W2c held 0 on that row, so nobody
    owned them; ruling 230 routes them to the mutation session.
11. **E11 — 3×15 needs new engine fields.** The set kernel already has `setTo`, `finalSetTo`, `winBy` and `cap`; only a
    variant, the default and a migration check were owed.
12. **E12 — the hockey "3 / 2 / 1 / 0 (shoot-out)" preset is still offered where it changes nothing.** Resolved by W2d
    final-review m5 (`presetOffered`); the IDX line "Need an owner ruling" was stale.
13. **E13 — a level table's API rows say nothing about being level.** Every row already carries `level: true`; only
    `rank: 1..n` misleads.
14. **E14 — 3×15 as the default may need a migration; the `bwf` variant can take the new defaults.** No migration (divisions
    store the parsed config, fixtures freeze theirs), but the `bwf` variant is `{}`, so changing `defaults` would have turned
    the variant labelled 3×21 into 3×15: 3×15 is a new explicit variant made the preferred pick.
15. **E15 — config refusals (ruling 31, SC-S2) are `configSchema` refines.** A refine makes every read of a stored config
    that breaks it throw; they are write-door issues (`configWriteIssues`) instead.
16. **E16 — generic's 500 cap is a rule the engine should enforce** (SC-O11). It is a test sentinel; dropped.
17. **E17 — W2d's table-rules pin protects finished tables from an NRR change.** NRR is computed at standings time from match
    states, and `table_rules_pinned` holds only points, tie-breakers and cross-group. (Moot after ruling 238.)
18. **E18 — hockey and ice hockey can tell when a team is below its minimum.** `strength.min` is a penalty floor in
    `strengthOf`; injuries never reach strength (ruling 235).
19. **E19 — the pad can send X-RT-1's ending after a sanction.** The ending is `core.forfeit{reason:"disqualified"}`
    (volleyball's is `"retired"`) and it is organiser-only; a scorer's append got 403 (ruling 233).
20. **E20 — "one truth run by CI dispatch" covers W2e's new scenarios.** The full scope plans only the base scenarios, and
    `judge regression` silently skipped a baseline case missing from `--expect` (ruling 236).
21. **E21 — the rulebook is silent on RB2A-12's short-set tie-break targets.** RBS gives both forms (RBS:76, :82–84, :347).
22. **E22 — a new tennis variant gets a golden stream automatically.** `MAX_CONFIGS = 4` and tennis was at 4: a fifth was
    silently unrecorded.
23. **E23 — an old config carrying `shootout.suddenDeath` reads without error once the key is deleted.** `shootout` is a
    `z.strictObject`: an unknown key throws unless explicitly stripped.
24. **E24 — `rank: null` belongs in `getStandings`.** It also feeds the division page and the slideshow; the null belongs in
    the two route handlers, and the public route is SWR-cached for 300 s.
25. **E25 — the scoring route is the only strict write path.** Event import is a second; the pad's local fold is non-strict,
    so the pad must block scoring itself after an ending sanction.
26. **E26 — new API error codes are documented in the OpenAPI spec.** They are documented in
    `docs/api-v1-breaking-changes.md` and the developers changelog.
27. **E27 — rule rows are signed `signed W2e-D<n> 2026-10-28`.** The status check wanted a numeric ruling; A0 widened the
    token (`b3b1c8b6eb`), and this fold rewrites every status to its ruling number (220 + D) and drops the alternation.
28. **E28 — the net-run-rate rows are `CK-NRR-1` and `CK-NRR-2`.** A rule id's area is exactly two letters; the rows are
    `CK-RR-1` and `CK-RR-2`.
29. **E29 — the old app, serving between the Flyway migrate and the deploy, reads a migrated config without error.** True for
    `progressScore` and tennis `set`; false for `shootout.suddenDeath` (a required key in a strict object): until cutover a
    hockey or ice-hockey `PATCH /divisions/{id}` with a shoot-out answers 422. Accepted and listed loudly (ruling 238).
30. **E30 — the ITF Rules of Tennis 2026 PDF can be fetched.** `itftennis.com` answers non-browser fetches with a bot
    challenge; Appendix VI is quoted from Tennis Canada's reproduction.
31. **E31 — D8's "5-ball overs not built".** The `hundred` preset ships selectable; its editor and NRR assumed 6-ball overs
    (ruling 239).
32. **"Hit the ball twice on a free hit is a dismissal" (CK-FH-1).** The engine refuses it; ICC 21.18 lets it stand. A
    deviation row (A0.9 item 14).
33. **"A bowled dismissal on a no-ball is refused"; "a wide refuses six modes".** The engine accepted both (ICC 21.18, 22.9);
    refused on the write path now (CK-NB-1, CK-WD-1).
34. **"BG-RS-1: forfeit methods are decisive."** The engine retired those on write in W2b; its decisive list is `checkmate`,
    `resign`, `time`, `illegal_move`, and the pad imports it.
35. **"X-DV-1: a level result on a bracket kind is refused `DRAW_NOT_ALLOWED`."** A held bracket result is stored as
    `{kind:"draw"}` with status `needs_decision`; a generic draw is `LEVEL_RESULT_IN_BRACKET`. Reworded twice.
36. **"CA-DG-1: a carrom board is drawn."** A GAME is drawn after `maxBoards` under `tieBoard: "draw"`; ICF 56(b) plays extra
    boards, so it is a deviation.
37. **"TN-RO-1: an interruption is never refused."** It is flagged `overCount` / `overran` and recorded, but a malformed
    record (a player without a side, a stamp in a set not yet reached) is refused.
38. **"TN-SE-2: a game penalty during a tie-break is a game award."** `GAME_AWARD_DURING_TIEBREAK` refuses it; the chair
    enters the tie-break as points (the result is right, the tie-break score shown is not one that was played).
39. **"FB-YT-1: the 11-a-side variant keeps a substitution cap."** The variant is `{}`; the cap is the competition's `maxSubs`.
40. **"IIHF 84.3 is a regulation penalty rule."** It is the overtime rule; the regulation floor is 26.1.
41. **"The existing generic entrant test drives `ENTRANT_KIND_NOT_ALLOWED`."** It proves chess's `CHESS_INDIVIDUAL_ONLY`; no
    vitest drove the generic gate until Task 16's fix round.
42. **"The plan's golden re-record is `REBASELINE_GOLDEN=1`."** That keeps recorded events, so it cannot fix streams whose
    events are now refused (pre-flight F12); two cricket streams (#24, #29) needed the one-off per-stream probe.
43. **"Set sports declare a decider key"** (Task 22): they declare none; the generator derives paths from
    `reachableSetScores`, the rally fold and the cfg cap and win-by.
44. **Task 21 M1: a route to `mergeRulesOverride`.** It is server-only, so the brief's route was false; the test stubs it
    with `vi.mock`.
45. **"Eight faults red at base."** They were measured against a base that already held W2e's cricket and points edits; PR A's
    T25 re-keyed every floor fault W2e moved.

## Findings routed (W1b)

Every live ❌ and every confirmed hypothesis from W1b, with its case or leg,
its evidence and its owning wave. Evidence paths are under `truth-runs/`.
"Read, not run" marks a finding no run has driven yet. Runs checked:
`w1b-slice-0928a`, `w1b-probe-0928a`, `w1b-abandon-0928a`,
`w1b-tie-ko-0928b` (`0928a` was a probe bug; its evidence is not committed),
`w1b-withdraw-0928a`/`0928b`, `w1b-cricket001-0929a`, the model runs
`w1b-model-0928a`/`0928b` and `w1b-model-0929b` to `0929i`, the knockout
probes `w1b-fr1-ko-0929a`/`0929b`, and `w1b-model-final` (with `-sb40` and
`-regressions`).

**Product findings, confirmed live:**

- **Data loss on a refused format change (false premise 8).**
  `PUT /api/v1/divisions/:id/stages` with a gated format answers 402 with the
  gate's `feature_key`, but `replaceStages` has already deleted the division's
  stage (`stages.ts:543`, before the gate at `:373-382`). Red on all 7 DENIED
  cases (`group_playoffs`, `swiss_playoff`, `double_elim`, `americano`,
  `mexicano`, `ladder` and `page_playoff_only`, each `…|generic|score|DENIED`)
  on check `denied-put-keeps-stages`. Evidence `w1b-probe/results.json` (run
  `w1b-probe-0928a`). → **W9** (ruling 35).
- **ST-G1 (false premise 11).** Legs `cricket-no-result`, `cricket-test-draw`
  and `football-award` are `voided`: the product stores the engine's scored
  outcome (`no_result`, `draw`, an `award` 1–0) on a fixture it marks
  `abandoned`, and the table counts neither the game nor its declared points.
  The control `badminton-control` is `void-correct`; judged 4/4. cricket#001's
  M4b leg reads the same. Evidence `w1b-abandon/abandon-probe.json` (run
  `w1b-abandon-0928a`) and `w1b-cricket-001/cricket-001-probe.json`. →
  **W5 (standings) + W2 (what an abandon is worth)**.
- **CD-T6 (ruling 32).** At cricket's builder default (t20, super over off), a
  tied knockout semi posts with no refusal, completes `decided` with
  `{kind:"tie"}`, and never feeds the final. The final keeps an empty seat and
  the stage stays `active`: the bracket stalls. The control (a win) seats its
  winner at once. Evidence `w1b-tie-ko/tie-ko-probe.json` (run
  `w1b-tie-ko-0928b`). → **W4 + W2 (what a tie is worth in a knockout)**.
- **CD-T13.** On the walkover path, `POST /entrants/:id/withdraw` for a
  boardgame entrant after Start answers 422 WRONG_PHASE ("forfeit not allowed
  in phase \"pre\""). The product posts a bare `core.forfeit`, which boardgame
  refuses before `core.start`. Nothing is written, and the organiser cannot
  withdraw the entrant at all. The generic control is clean. It also
  half-applies: when one of the two unplayed fixtures had already started, its
  walkover landed and the next forfeit was refused, so an opponent holds a
  walkover win against an entrant who is still registered. Evidence
  `w1b-withdraw-boardgame/withdraw-probe.json` (run `w1b-withdraw-0928a`) and
  `withdraw-live-probe.json` (run `w1b-withdraw-0928b`). → **W2 (does a
  boardgame forfeit before start count, and what is it worth) + W9 (a withdraw
  must be all-or-nothing)**.
- **CD-T13b.** The roster lock after Start answers a bare 422 with no code
  (`entrants.ts:307-318`; the wire reads `ERROR`). The model counts it per
  cell and goes on. In the final run it was counted on all six cells:
  league\|generic 8, league\|badminton 11, knockout\|generic 18,
  knockout\|badminton 1, swiss\|generic 19 and swiss\|badminton 26 (at 40
  runs), 83 in all. Evidence `w1b-model-final/model-report.json` and
  `model-report-swiss-badminton-40.json` (`findings.CD-T13b`). → **W9**.
- **MB-002 / MB-003: a knockout entrant waiting for a TBD opponent cannot be
  withdrawn.** The withdraw turns the missing walkover into a `core.abandon`
  on the next-round fixture, and the append guard refuses any event on a
  fixture with an unassigned seat: 422 WRONG_PHASE "fixture has an unassigned
  entrant (bye/TBD)" (`engine-db/append-event.ts:189`). The entrant stays
  registered; a round-1 entrant in a two-sided match withdraws cleanly.
  Evidence `w1b-model-fr1/ko-findings-probe.json` (run `w1b-fr1-ko-0929a`) and
  the regression replays. → **W9 + W4**.
- **MB-004 / MB-005: knockout Generate answers 500 after the roster changes.**
  Two routes: Generate → AddEntrant → Generate before Start, and Start →
  Withdraw seed 2 or 3 → Generate. The server's own assertion fires:
  "generateStageFixtures: bye-award bulk UPDATE would strand home_slot_label"
  (`stages.ts:2656`), and the transaction rolls back. It is the knockout
  counterpart of #879, on both sports. The `away_slot_label` twin
  (`stages.ts:2672`) has not been seen live. Evidence
  `w1b-model-fr1/ko-findings-probe.json` and `ko-500-after-start-probe.json`
  (runs `w1b-fr1-ko-0929a`, `0929b`). → **W4 + W9**.
- **MB-001 (#879)** reproduced live by the model before Start (see the
  regression table under "W1b session status"). → **W5**.

**Recorded from W1b runs, not product defects:**

- **cricket#001, what the product did** (run `w1b-cricket001-0929a`,
  `w1b-cricket-001/cricket-001-probe.json`). `createDivision` ACCEPTED a
  3-a-side config with a 600-ball innings, 5-ball overs, a 1-over bowler quota,
  super over on and DLS on, and stores it as posted, although at most 3 overs
  (15 balls) can ever be bowled against that innings. M4b voided, as ST-G1. M6
  (level runs) folds to null in the engine (super over on), and the fixture
  stays `in_play`: consistent, and not the CD-T6 stall. The first
  ball-by-ball `cricket.ball` was refused 422 INVALID_EVENT ("batting order …
  needs at least 2 players"), because the harness sends no team roster. →
  **W2** (should the editor accept this config) and **W1-driving** (team
  rosters).
- **`page_playoff_only` LIFECYCLE red is a HARNESS defect, not a product ❌.**
  LIFECYCLE seeds a fixed 8 entrants
  (`tools/matrix/lib/scenarios/lifecycle.ts:9`); a page playoff needs
  exactly 4, and the product refuses Start with a named 422 CONFIG_INVALID
  ("page playoffs need exactly 4 entrants, got 8"). A first-stage page
  playoff's allowed path is therefore still undriven live. → **W1-driving** (a
  per-format field size).

  The committed `w1b-probe/MATRIX.md` shows the page_playoff_only × generic
  cell as ❌ (`MATRIX.md:28`). That cell holds TWO cases, and both are red:
  - `page_playoff_only|generic|score|DENIED` (`MATRIX.md:57`): the product's
    data loss on `denied-put-keeps-stages` → **W9**;
  - `page_playoff_only|generic|score|LIFECYCLE` (`MATRIX.md:58`): the harness
    red above → **W1-driving**.

  Only the LIFECYCLE part is a harness defect. After the harness fix the cell
  stays ❌ until W9 fixes the data loss.
- **Variant cases the harness cannot run** (`counts.json` `variants`): 40
  engine-unscorable (volleyball and table tennis sets to 1 at win-by-2) →
  **W2** (ruling 31); 24 generator-unsupported (cricket's two-innings `test`
  preset) → **W1-driving**.

**Found by reading, not run:**

- **Chess tiebreak (false premise 9).** boardgame has no M6 decider, so M6 is
  dropped on boardgame with that reason. → **W4**.
- **M12b's missing play-short control, and no minimum-players rule.**
  `core.lineup.retirement` has an API route, but no pad or console control
  sends it (design "Known UI-only 🚫"; the catalogue's M12b `l2NoPath` = W2).
  → **W2**.
- **No organiser control for `abandonPolicy` (false premise 10).** Football,
  hockey and icehockey M4b are dropped for it. Task 15 Step 3b's
  `football-award` leg was NOT refused: the API accepted
  `config.abandonPolicy: "award"`, so only the editor lacks the control. →
  **W2**.
- **CD-T8: the boardgame time control is inert** (ruling 33). → **W2**
  (editor and display); no pad clock.
- **P7: the rank-override route has no stage-kind guard.** `overrideStandings`
  (`usecases/stages.ts:4644`) accepts an override on any stage. The standings
  apply `rank_overrides` only through `toTableStage`
  (`engine-db/competition.ts:395-417`), so on a ladder or bracket stage the
  override does not move the standings. Other readers exist:
  `usecases/scoring.ts:762-771` reads and merges it when a placement game
  finishes, and the public `has_rank_overrides` flag (from the view in
  `db/migration/deltas/V414__public_stages_qualification.sql:169-170`), true
  for any stage kind, is read by `public-site/data.ts:409,941`,
  `embed-data.ts:99` and `public-site/qualification-view.ts:61,69`. So W5
  should also check what the public page says about an override that does
  nothing. → **W5**.
- **The engine comment "Order is not significant"**
  (`packages/engine/src/sports/index.ts:22`, false premise 6). → the next
  engine-touching wave, as a one-line comment fix.
- **`requireFamily` takes the first match silently**
  (`packages/reference/src/index.ts:33`, Task 12 review M-6). → the first wave
  that adds a reference family (W3): a named refusal on an ambiguous match, or
  a documented precedence, plus a keep witness per `familiesFor` arm.
- **I7's orientation residual at legs ≥ 3** (Task 13). A duplicate of the
  minority orientation paired with a missing majority meeting passes both I7
  and the orientation check. The builder offers legs 1 and 2 only, so it is
  unreachable today. → whichever wave first offers legs ≥ 3.
- **`TEST-STRATEGY.md` still says `forEachSport` does not exist** (`:77`,
  `:118`). It shipped in `6b689c227`
  (`packages/engine/src/testkit/for-each-sport.ts`). A one-line docs fix, not
  made in W1b: Task 16 edits this index only.

## Findings routed (W1c)

Every product finding from W1c's live runs (Tasks 5, 7, 8, 9–11 and 14), each with its evidence and the wave it is
recommended to. Evidence paths are under `truth-runs/`. **Tell owner** marks the items the owner is to hear about
directly. "Read, not run" marks a finding no run has driven. None of these is fixed in W1c, because W1c makes no
product changes (D4).

**New in Task 14 (seen live):**

- **N-1: the organiser's bracket draws a badminton result over the top entrant's name.** Tell owner.
  - `bracket-panel.tsx:334` places the node's result `absolute right-2 top-1.5`; the same placement recurs at `:465` and `:639`, which were not traced to a screen.
  - A generic "3 — 1" fits. "2 — 0 · 21–16, 21–16" runs across the first name at every width from 320 to 1280.
  - The public bracket is fine.
  - Evidence: `w1c-l1/evidence/N-1-bracket-score-over-name-1280.png`, `w1c-sweep-ko/evidence/N-1-bracket-score-over-name-768.png`.
  - → **W4** (the knockout family owns the bracket).
- **N-4: a table's scroll fade is left mid-table after a sideways swipe.** Tell owner.
  - `.scroll-x-fade::after` (`globals.css:415-419`, absolute `right-0`) sits inside the element that scrolls
    (`entrants-panel.tsx:533`), so the fade scrolls with the content.
  - Seen at 375 on the entrants table: the fade covers the STATUS column.
  - About eighteen other files use the class. They were not driven, so the reach is unmeasured.
  - Evidence: `w1c-l2/evidence/N-4-scroll-fade-stranded-375.png`.
  - → **W10** (sweep lane; shared CSS).
- **N-2 (soft): "Generated 4 fixture(s) (0 already existed)."** The "(s)" pluralisation is in
  `dictionaries/en/ui.json:1897` (`schedule.notice.generated`). Seen on swiss Generate (`w1c-l1` case-5). The key is
  format-agnostic, so → **W10**, as for N-4.
- **N-3 (soft; an owner question): the same scorerless goal reads two ways.** Hockey and ice hockey show "Goal ·
  PARTIAL"; football shows "Goal recorded" with no chip (`w1c-padproof` 1280 r1). → **W2**.
- **N-5 (soft; an owner question): the Stage tools sheet stays open after Generate at phone widths.** It covers the
  result notice (`w1c-l2`, `w1c-sweep-ko`). Task 8 noticed it without giving it an id. → **W10**.
- **PF-1 also appears inside an activity row at 320.** Tennis reads "Set score recorded — 6–" / "3"
  (`w1c-padproof` 320 r1). Folded into PF-1 below.
- **P-4 is wider than recorded.** It shows at 320–390, not 320 only (`w1c-sweep-ko`).

**From Tasks 5, 7, 8 and 9–11 (seen live; sources `w1c-walkthrough-a/README.md` and the gitignored task reports):**

- **Hardcoded English on the add-entrant form.** Tell owner. This breaks the four-locale rule.
  - "Add entrant" / "Saving…" (`entrants-panel.tsx:1140`), "Import CSV" (`:1233`), "Existing team" / "New entrant"
    (`:736`).
  - AddStageForm's kind labels (`stages-panel.tsx:1458-1462`) are English on purpose, per the product's own comment
    ("kept canonical/English, like the format gallery"). The owner decides whether that exemption stands.
  - → the entrants surface's owner (W1c does not fix it, D4).
- **Boardgame refuses a forfeit before start, while the console offers Forfeit on a scheduled fixture.** Tell owner.
  - `boardgame.ts:616-617` answers WRONG_PHASE (Task 5, read and driven). Evidence: the code line only; no
    committed picture or run.
  - The harness starts the match first.
  - → **W2**.
- **PF-1: at 320 the set/game score wraps mid-score.** Tell owner.
  - Headline "2 – 0 · 21-16, 21-" / "16" on badminton and volleyball: `w1c-walkthrough-a/evidence/320-badminton-08-pad-scored.png`
    and `w1c-padproof` 320.
  - Also tennis's activity row, and the knockout sweep at 320.
  - → the pad's phone composition (the ScoringPad programme).
- **P-1 … P-9 (Task 8, `w1c-walkthrough-a/README.md`):**
  - P-1: the builder tab strip wraps at 320.
  - P-2: the badminton variant reads "Bwf".
  - P-3: at 320 the standings scroll inside their card, and the organiser's generic view shows only P/W.
  - P-4: entrant names wrap and STATUS falls off at 320–390.
  - P-5: the away entrant is truncated to "Matrix …" at 320.
  - P-6: the breadcrumb drops the pipes.
  - P-7: the pad says HOME/AWAY on a named singles match.
  - P-8: public ranks 4–8 are small.
  - P-9: "What fits your day?" shows no over-budget marker. It recurs at every width and in every run in Task 14.
  - → routed at triage by surface: builder P-1/P-2/P-9; standings P-3/P-8; entrants P-4; desk P-5/P-6; pad P-7.
- **T9-O1:** tennis's scorebug hint is truncated at 320. **T10-O1:** a decided draw shows no result sentence
  (football, hockey, boardgame). **T11-O1:** a rosterless cricket pad shows "No bowler is eligible to open the next
  over." while scoring works. → **W2** (pad copy). Evidence for all three: screen-read, no committed picture (the
  Task 9–11 shots were never committed and go with the worktree).
- **Softer items, from the Task 8 screens:**
  - "Complete stage" is the primary control at 0/28 played.
  - "Void last entry" is greyed.
  - "+ Add stage" appears on a finished division.
  - Local vs UTC times.
  - A completed stage reads "Locked".
  - TEAM / set-ratio labels.
  - O-2: the pad's side tiles sit in a half-width column at 320.
  - → triage by surface.

**Structural findings (plan and Task 5 Step 0; read, then confirmed where driven):**

- **Ranks 2..n have no page, and rank override has no UI (D6).** Seen live: the knockout standings tab is empty,
  and the public page shows the champion only. → **W4** (brackets), **W7** (ladder, americano, mexicano).
- **Builder controls missing.**
  - There is no knob for third place, bracket reset or Swiss pairing: `TemplateKnobs` is `{qualified, swissRounds,
    poolCount, legs}` (`format-templates.ts:57-62`); the knockout and double-elim drafts post `config: {}`; swiss is
    fixed `pairing: "rank_adjacent"` (`:205`). Read, not run.
  - `group_only`, `group_group_ko`, `knockout_third_place`, `page_playoff_only` and `stepladder_only` have no
    organiser control (`w1c-api-only`, 5 🚫).
  - → **W4** (third place, bracket reset, page playoff, stepladder), **W5** (group-only, group-group-KO), **W3**
    (Swiss pairing).
- **`triple_rr` legs.** The predicted `builder-posted-as-harness` red cannot appear: `buildTemplateStages` stamps
  `knobs.legs` over every league/group draft, and the harness posts the same (Task 6 FP-1). Whether a triple round
  robin should post `legs: 3` is → **W5**.
- **Abandon has no pad route, and the console's Abandon has no testid.** The bench's `organiserStepsFor` throws on
  anything but `core.forfeit` (`scorer.ts:322-328`). The console's Abandon button (`fixture-console.tsx:1295-1302`)
  carries no `data-testid`. → **W2** (the abandon path), and the bench's index for the mapping.
- **Stale bench comment cites** (planning false premise 9). → the bench's index, for B07b onward.

**Harness minors deferred (from the ledger):**

- T1 `globalThis` computed-key residual → **W3**. Recommendation: refuse any computed read of a `GLOBAL_OBJECTS`
  owner.
- T1 M-2 and M-3 scan gaps → **W3**. T4 M-2 and M-3 (the playwright scan spellings) → **W1d** (final review m-17).
- C-1: DB-side refusal of a reused run-id slug → **W1d**.
- Test-file tsc is invisible to CI (`tsconfig.scripts` excludes `*.test.ts`) → **W1d**. The three W1c errors are
  fixed (`80f370e9f`).
- `crash-exit.test.ts` lists neither `matrix:parity` nor `matrix:browser`. Fixed (`80f370e9f`, final review m-11).
- T12: the vacuous L2 side of `run-cli.test.ts:1601` is fixed (`80f370e9f`, m-12). The `NoLayerForWidth` exit
  class (it exited 3, where a refusal exits 2) → **W1d** (m-3). Fixed in W1d Task 5 (`fd096b86d`): it exits 2.
- Parity on the API-only set exits 1 by construction (`layers.ts:218-229`) → **W1d**, as a per-case planned marker
  (final review m-6).
- `l3Gap` is never recorded (carry 4) → **W1d**: record it, do not drop it (final review m-7).
- **F-PP-1, an UNEXPLAINED flake.** Pad proof 1280 r3, cricket: `pad-ledger-as-generated` ❌, tap 15 of 141 on
  fixture `dabf515d-99da-4a03-8e52-c3e052c611e3` timed out at the 15 s `FLOOR_MS`. Clean in the other six runs.
  Machine load is a hypothesis only. → **W1d**: capture tap timestamps or a trace on a tap-wait timeout before
  judging. **W1d D16:** the timestamps shipped in Task 12 (every pad tap records `{tap, clickedAtMs,
  ledgerSeenAtMs, waitedMs, budgetMs}`, and a tap-wait timeout's message carries the last 5, redacted), so the next
  red explains itself in a public log. The local-only trace (`MATRIX_TRACE_ON_TIMEOUT=1`) was **dropped by Task 13**,
  with its reason: `replayEvents` catches a tap-wait timeout and folds it into a finding string, so the signal never
  reaches the layer that owns the browser context; a trace needs a new `ReplayResult` field, a driver flag, a
  stop-and-save path on `CaseBrowser` and a start in `newCaseBrowser` (five production files across three layers, not
  one small commit), and the unit suite can only fake `context.tracing`, so the seam would ship unproven live. The
  variable stays absent from every workflow (`matrix-workflow.test.ts`). Reopen it only if a timed-out tap's timings
  fail to explain a recurrence.
- **Pad proof has no single-sport scope** (`run.ts:468-469`, `lib/pad-proof-set.ts:16`), so F-PP-1's recurrence was
  not measured → **W1d**.
- **The match-day run sheet is never driven** (carry 2; "Today" hides the other fixtures) → **W1d**.
- **The sweep's fold claims are picture-only** (review m-13). results.json does not record which `openFoldIfFolded`
  branch ran. Record it as a check or note → **W1d**.
- **Void is never driven in any browser run.** "Void last entry" is only noted as greyed → **W1d**.
- **`committed-matrix` was missing from the wave's earlier review gates** (`c609f9cd4`..`0f3deface`), so its CI red
  went unseen until Task 14. The final review ran it: 2692/2692 over `scripts/matrix/__tests__`. Its two Important findings, I-1 and I-2,
  are fixed in `0532d0cb6`.

## Findings routed (W1-driving)

Every product red W1-driving's live runs found, and every product finding its tasks carried here. None is fixed in
W1-driving: product reds are recorded and routed (rulings 19, 48). Evidence paths are under `truth-runs/`.

**How each claim is labelled:**
- **Confirmed** cites a committed run id.
- **Read-derived** means read in the code and not driven.
- **Predicted** means the fake or the plan says so and no committed run has shown it.

**Source of the counts.** The per-case table at the end of this section is generated by
`tools/matrix/findings-table.ts` (T16-R4 m-6) from `truth-runs/w1drv-l3/TRIAGE.md`'s "Every ❌" table: every
row whose final class is product. Each row's failing checks are read from the committed `results.json` of the run
TRIAGE judges it on. The script refuses any row that is not red on its judged run, or whose run's `harnessCommit`
differs from TRIAGE's. It read 61 results files and 164 rows, and refused none. `findings-table.test.ts` pins this
table as its output, byte for byte. To re-run it:
`node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/findings-table.ts
<TRIAGE.md> <truth-runs dir> --out <file.md>`.

**Per wave** (re-derived by script; ruling T15-R4 moved P1 from W4 to W2, and Task 16 applied it to TRIAGE):

| wave | before T15-R4 | recorded (after T15-R4) | what |
|---|---|---|---|
| W2 | 0 | **62** | P1 bracket draw stall |
| W3 | 3 | **3** | P6 swiss R4 |
| W4 | 94 | **32** | P2 ko_plate F1 (10), P4 page-playoff R4 (11), P5 stepladder R4 (11); P1 (62) before T15-R4 |
| W5 | 11 | **11** | P3 group_group_ko F1 |
| W7 | 56 | **56** | the coverage table (44), P7 mexicano outside it (12) |
| total | 164 | **164** | + 30 harness reds now ✅, 0 unfit, 0 unclassified |

**The product rules** (TRIAGE states each rule's exact accepted failing set):

- **P1 — bracket draw stall (62) → W2** (T15-R4; design §8 SC-O1/SC-O2).
  - The engine's `supportsDraws` lets boardgame draw on every bracket kind, and generic draw on a page playoff
    (`generic.ts:650-653`). A drawn bracket fixture never advances.
  - **Two shapes** (re-derived by script, final review m-1): a stall (55), where the stage never completes; and
    completed over a drawn final (7), where the stage completes and only I2 fails ("bracket fixture ended draw" on
    5; no decided fixture with the terminal final key on 2). TRIAGE names the seven.
  - **Confirmed** on all 62: each case has ≥ 1 drawn bracket fixture, read from its env's DB
    (`truth-runs/w1drv-l3-fr1/draw-counts.json`, runs `w1drv-p1-*`).
  - boardgame 52 on 14 rows; generic 10 (page_playoff_only 2, group_playoffs 4, swiss_playoff 4). This confirms
    Task 2's carry: a generic page-playoff draw leaves `pp-final` never seated.
- **P2 — ko_plate F1 (10) → W4.** Stage 1 commits, then `/complete` answers 409 `STAGE_COMPLETED_SEEDING_FAILED`, and
  the plate is never seeded. **Confirmed** 10 of 11 (`w1drv-l3`); boardgame is masked by P1.
- **P3 — group_group_ko F1 (11) → W5.** 7 entrants snaked into 4 pools leave seed 1 alone in pool A, and stage 2's
  seeding then fails with a 409. **Confirmed** 11/11 (`w1drv-l3` 10; boardgame on its `w1drv-l3-fr1` P1 run). An owner question is recorded under
  "Recommendations": it may be ruled unfit instead.
- **P4 — `page_playoff_only` R4 (11) → W4** (plan review 1 m-5, plan review 2 I-1). **Confirmed** 11/11 (`w1drv-l3`
  9; boardgame and generic on their `w1drv-l3-fr1` P1 runs): `/complete` answers 200 with no code and the stage does
  not complete, the play loop exits `refused_generate`, and one fixture is left `scheduled`. **DB-derived, not in a
  committed run:** the mechanism (the open-format branch abandons `pp-q2`, so `pp-final` is never seated) was read
  from the T15 triage database. None of the 11 committed cases names `pp-q2` or `pp-final`.
- **P5 — stepladder R4 (11) → W4** (T15-R7).
  - Withdrawing seed 3 is refused: 422 `WRONG_PHASE` "fixture has an unassigned entrant (bye/TBD)". The walkover
    cascade reaches a TBD line (`withdrawal.ts:217-220` → `append-event.ts:188-191`). **Confirmed** 11/11
    (`w1drv-l3-rerun` 10; boardgame on its `w1drv-l3-fr1` P1 run).
  - The model shows the same refusal on three bracket kinds: MB-002/003 (knockout), MB-008 (stepladder) and MB-009
    (double elim). All are committed and replay known (`w1drv-t16-model-reg2`, and again on
    `w1drv-t16fr1-model-reg`). MB-009 is a double-elim row: it routes W4 with P5, cross-referenced to W6 as the row's
    owner, as G-2 does for MB-007.
  - **G-3 → W4:** because of this, the stepladder R4 policy and cascade checks have never been judged live. A
    half-applied cascade is possible (`withdrawal.ts:216-225`; read-derived).
- **P6 — swiss R4, `rank_adjacent` (3) → W3.** Round 5's Generate pairs nobody and answers success (SW-H1).
  **Confirmed** on `swiss_knockout` generic and hockey and on `swiss_playoff` hockey (`w1drv-l3`). It is
  intermittent: `swiss_playoff` boardgame hit SW-H1 in `w1drv-l3` and a P1 draw stall on its fr1 run.
- **The coverage table (44) → W7**, and **P7, mexicano outside the table (12) → W7.** The signatures are below.

**Named findings** (the brief's list and the open carries):

- **Americano × team sport plays one arbitrary roster member per team → W7** (false premise 10). **Confirmed**: the
  note is on all 42 cases of the 10 team cells, each on its latest committed run (`w1drv-l3`, `w1drv-l3-rerun`,
  `w1drv-l3-fr2`). The americano team cells are ✅ on every check but R4, so the note IS the finding.
- **Mexicano counts round-1 pair entrants as players → W7** (false premise 17; `stages.ts:2290-2293` has no kind
  filter).
  - **Confirmed**: a later-round generate refused 500 on a self-pair (`entrant_members_pkey`) on 32 cases
    (`w1drv-l3-rerun` 23, `w1drv-l3-fr2` 9).
  - **Confirmed**: a person seated twice in one round on 32 cases. The 11 judged on `w1drv-l3-fr2` name the earlier
    pair entrant the person belongs to. The 21 judged on `w1drv-l3-rerun` predate G-4. They name the person and the
    two entrants seating them, but lack G-4's "is a member of earlier pair entrant" clause.
  - **Confirmed** at 1280: the L1 `mexicano|generic` case reds on the same 500 in every run (`w1drv-l1-t15-r1..r3`).
- **Mexicano stalls on any fixture that is not `decided` → W7** (false premise 14). **Confirmed** on all 11
  mexicano M1 cases, failing set `[life-loop-bounded]` (`w1drv-l3-rerun`).
- **Mexicano predictions (D9; carry from Task 8):**
  - **A mexicano stage completes after any decided round: confirmed.** The product's `/complete` answers
    `completed: true` after round 1, which is why M1's failing set holds only `life-loop-bounded` (11/11,
    `w1drv-l3-rerun`).
  - **Personal points read 0 on every sport but generic: read-derived for mexicano.** `stages.ts:774-783` reads
    `state->'score'`, and only `generic.ts:81` folds one. The americano screen shows it live: "Personal points"
    PTS 0 for all 8 players after 7 scored rounds (`w1drv-l1-t15-r1`, `truth-runs/w1drv-l1/README.md` (c)). The
    Task 15 API read over 22 stages agreed, but its output is not committed, so it is not cited as confirmation.
  - **Sit-outs never rotate (the same 3 of 7 never play): predicted, not observable live.** The "3 of 7" figure is
    from the fake, and the mechanism is read from `americano.ts:61, :93-95`. The self-pair 500 stops every live
    mexicano F1 by round 3, before a rotation could show.
- **R4 on americano/mexicano: the withdrawn player keeps playing → W7** (ruling 51). **Confirmed** on
  `w1drv-l3-fr2`. Americano 11/11: 6 of the 12 later fixtures seat seed 3's person, through `r4-not-seated-later`
  (T15-R9). Mexicano 3/11, only where the second leg holds (generic, icehockey, volleyball).
- **The organiser cannot narrow entrant kinds on a running americano: minted pairs block it → W7** (T12-R1;
  `divisions.ts:857-871`).
  - **Predicted** in the committed runs: the note marks the precondition (minted pair entrants active) on 24
    cases.
  - Task 12's live cells saw the 422 `ENTRANT_KIND_IN_USE` before the probe was changed. That evidence is not
    committed.
- **The ladder keeps a withdrawn player's rung in `finalRanks` → W7** (ruling 53's note, never asserted). The raw
  `ladder_order` is used (`competition.ts:606`). **Confirmed** as a note on all 11 ladder R4 cases, each ✅: "ladder
  finalRanks rung 3 for withdrawn <id> (raw held 3) — W7 rulebook question" (`w1drv-l3`).
- **Ladder, read-derived → W7:**
  - no guard stops an entrant holding two open challenges (Task 7);
  - no code path un-swaps a voided challenge (Task 7 G-1, grep only);
  - the swap rule has no live replay: I9 compares two reads of `competition.ts:606` (Task 9 m-2).
- **The 4-innings level-tie applicability question → W2** (false premise 4). M5 does not probe a two-innings tie
  (`applicability.ts:101-122`; read-derived). Also (Task 10 m10-2): no scenario requests a tie, so M5 is
  unscripted. Design §4 builds M5 in W2, so it is routed there as a missing producer.
- **Side size differs from the catalog's `lineup.size` → W2** (Task 3, m-2; `rosters.ts` `SIDE_SIZE_ROUTE`).
  `volleyball/beach` plays 2 a side against a lineup of 6. `hockey/youth` plays 7 against 11. Rulebook-derived from
  the committed `RULEBOOK_SIDE_SIZE` table; the setbased kernel has no `positionsFor`.
- **Seeding ties the harness had to pick → by row** (the brief said W4/W5; false premise 9 puts the swiss-source
  rows in W3).
  - 38 cases carry "stage N: 1 seeding tie(s) picked in the product's listed order", each on its latest committed
    run.
  - **W5 (21):** `group_group_ko` 9, `groups_ko` 3, `league_ko` 3, `group_playoffs` 3, `group_stepladder` 3.
  - **W3 (17):** `swiss_playoff` 9, `swiss_knockout` 8.
  - None is on a W4 row. Each is a note, not a red. The family wave decides whether the product's listed order is
    a rule.
- **An unplayed `gf-reset` → W6: read-derived and latent, with 0 cases.** No catalogue row sets `bracketReset`, so
  no run can reach it. That is read-derived: neither `tools/matrix/lib/catalogue.ts` nor `format-templates.ts`
  names it. The "0 of 74 double-elim stages" count is DB-derived, from the T15 triage database, and was never
  committed. The product never voids `gf-reset`, so a double elim with `bracketReset` would never complete (Task 9's
  read).
- **The double-elim model red (G-2): MB-007 → W4** (FX-G2), cross-referenced to W6 as the row's owner. A Generate
  after the roster changes 500s: "generateStageFixtures: bye-award bulk UPDATE would strand home_slot_label"
  (`stages.ts:2658`). This is the shared generate path of MB-004/005 (knockout). **Confirmed** on
  `w1drv-model-m6` and replayed known on `w1drv-t16-model-reg2` and `w1drv-t16fr1-model-reg`.
- **MB-010, the same 500 after a WITHDRAWAL on double elim → W4**, cross-referenced to W6 as the row's owner, like
  MB-007. The sequence is Start → Withdraw → Generate. It was found once T16-R3 lifted the fence's double-elim
  withdrawn branch. **Confirmed** on `w1drv-t16fr1-model-de`, and replayed known as itself on
  `w1drv-t16fr1-model-reg`. One root (`stages.ts:2658`) and two triggers: MB-004 is knockout's withdrawal instance.
- **Screen observations at 1280** (`truth-runs/w1drv-l1/README.md`; each reproduced on `w1drv-l1-t15-r1`):
  - (a) a box league's public page crowns ONE champion over four parallel boxes → **W5**, a rulebook question for
    the owner;
  - (b) the ladder's public standings read P/W/L/PTS 0 on every rung after 7 decided challenges → **W7**;
  - (c) americano personal points read 0, and the champion is a pair entrant → **W7**.
  - (d), (e) and the missing filler counts are harness items → "W1d first tasks".
- **Mexicano R4 is not reproducible run to run → W7** (TRIAGE "Reproducibility"). Over four runs, no mexicano R4 case
  kept one failing set. See the W7 recommendation.
- **Latent, if an americano stage ever gets a successor → W7:** I10 must then skip a seeding-failed 409 by name, as
  I2 does (Task 9, T9-R5).
- **A refused format change deletes the division's stages first → W9** (ruling 57; the owner, 2026-10-01: "W9 is
  fine"). `replaceStages` deletes at `stages.ts:543`, before `createStages`' `requireFeature` gates.
  **Read-derived:** the controller read the delete on `main` `58e8103e3`, and no committed run drives it.

**Every product red** (generated; P1 rows read W2 per T15-R4; "table:" rows are the coverage table's signatures):

| wave | TRIAGE # | case | failing checks (on the run it is judged on) | judged on | rule |
|---|---|---|---|---|---|
| W2 | 1 | `league_ko\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-league-ko-boardgame` | P1 bracket draw stall |
| W2 | 2 | `league_ko\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-league-ko-boardgame` | P1 bracket draw stall |
| W2 | 3 | `league_ko\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-league-ko-boardgame` | P1 bracket draw stall |
| W2 | 4 | `league_ko\|boardgame\|blitz\|F1` | I2-bracket-one-champion-ranks-permutation | `w1drv-l3-fr1/w1drv-p1-league-ko-boardgame` | P1 bracket draw stall |
| W2 | 5 | `groups_ko\|boardgame\|blitz\|LIFECYCLE` | I2-bracket-one-champion-ranks-permutation | `w1drv-l3-fr1/w1drv-p1-groups-ko-boardgame` | P1 bracket draw stall |
| W2 | 6 | `groups_ko\|boardgame\|blitz\|M1` | I2-bracket-one-champion-ranks-permutation | `w1drv-l3-fr1/w1drv-p1-groups-ko-boardgame` | P1 bracket draw stall |
| W2 | 7 | `groups_ko\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-groups-ko-boardgame` | P1 bracket draw stall |
| W2 | 8 | `groups_ko\|boardgame\|blitz\|F1` | I2-bracket-one-champion-ranks-permutation | `w1drv-l3-fr1/w1drv-p1-groups-ko-boardgame` | P1 bracket draw stall |
| W2 | 9 | `group_stepladder\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-stepladder-boardgame` | P1 bracket draw stall |
| W2 | 10 | `group_stepladder\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-stepladder-boardgame` | P1 bracket draw stall |
| W2 | 11 | `group_stepladder\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-stepladder-boardgame` | P1 bracket draw stall |
| W2 | 12 | `group_stepladder\|boardgame\|blitz\|F1` | I2-bracket-one-champion-ranks-permutation | `w1drv-l3-fr1/w1drv-p1-group-stepladder-boardgame` | P1 bracket draw stall |
| W2 | 13 | `group_playoffs\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-playoffs-boardgame` | P1 bracket draw stall |
| W2 | 14 | `group_playoffs\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-playoffs-boardgame` | P1 bracket draw stall |
| W2 | 15 | `group_playoffs\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-playoffs-boardgame` | P1 bracket draw stall |
| W2 | 16 | `group_playoffs\|boardgame\|blitz\|F1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-playoffs-boardgame` | P1 bracket draw stall |
| W2 | 17 | `group_playoffs\|generic\|score\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-playoffs-generic` | P1 bracket draw stall |
| W2 | 18 | `group_playoffs\|generic\|score\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-playoffs-generic` | P1 bracket draw stall |
| W2 | 19 | `group_playoffs\|generic\|score\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-playoffs-generic` | P1 bracket draw stall |
| W2 | 20 | `group_playoffs\|generic\|score\|F1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-playoffs-generic` | P1 bracket draw stall |
| W2 | 21 | `swiss_playoff\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-swiss-playoff-boardgame` | P1 bracket draw stall |
| W2 | 22 | `swiss_playoff\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-swiss-playoff-boardgame` | P1 bracket draw stall |
| W2 | 23 | `swiss_playoff\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-swiss-playoff-boardgame` | P1 bracket draw stall |
| W2 | 24 | `swiss_playoff\|boardgame\|blitz\|F1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-swiss-playoff-boardgame` | P1 bracket draw stall |
| W2 | 25 | `swiss_playoff\|generic\|score\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-swiss-playoff-generic` | P1 bracket draw stall |
| W2 | 26 | `swiss_playoff\|generic\|score\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-swiss-playoff-generic` | P1 bracket draw stall |
| W2 | 27 | `swiss_playoff\|generic\|score\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-swiss-playoff-generic` | P1 bracket draw stall |
| W2 | 28 | `swiss_playoff\|generic\|score\|F1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-swiss-playoff-generic` | P1 bracket draw stall |
| W2 | 30 | `swiss_knockout\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-swiss-knockout-boardgame` | P1 bracket draw stall |
| W2 | 31 | `swiss_knockout\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-swiss-knockout-boardgame` | P1 bracket draw stall |
| W2 | 32 | `swiss_knockout\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-swiss-knockout-boardgame` | P1 bracket draw stall |
| W2 | 33 | `swiss_knockout\|boardgame\|blitz\|F1` | I2-bracket-one-champion-ranks-permutation | `w1drv-l3-fr1/w1drv-p1-swiss-knockout-boardgame` | P1 bracket draw stall |
| W2 | 36 | `knockout\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-knockout-boardgame` | P1 bracket draw stall |
| W2 | 37 | `knockout\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-knockout-boardgame` | P1 bracket draw stall |
| W2 | 38 | `knockout\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-knockout-boardgame` | P1 bracket draw stall |
| W2 | 39 | `knockout\|boardgame\|blitz\|F1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-knockout-boardgame` | P1 bracket draw stall |
| W2 | 42 | `ko_plate\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-ko-plate-boardgame` | P1 bracket draw stall |
| W2 | 43 | `ko_plate\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-ko-plate-boardgame` | P1 bracket draw stall |
| W2 | 44 | `ko_plate\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-ko-plate-boardgame` | P1 bracket draw stall |
| W2 | 45 | `ko_plate\|boardgame\|blitz\|F1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-ko-plate-boardgame` | P1 bracket draw stall |
| W2 | 54 | `qualifying_main\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-qualifying-main-boardgame` | P1 bracket draw stall |
| W2 | 55 | `qualifying_main\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-qualifying-main-boardgame` | P1 bracket draw stall |
| W2 | 56 | `qualifying_main\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-qualifying-main-boardgame` | P1 bracket draw stall |
| W2 | 57 | `qualifying_main\|boardgame\|blitz\|F1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-qualifying-main-boardgame` | P1 bracket draw stall |
| W2 | 60 | `double_elim\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-double-elim-boardgame` | P1 bracket draw stall |
| W2 | 61 | `double_elim\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-double-elim-boardgame` | P1 bracket draw stall |
| W2 | 62 | `double_elim\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-double-elim-boardgame` | P1 bracket draw stall |
| W2 | 63 | `double_elim\|boardgame\|blitz\|F1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-double-elim-boardgame` | P1 bracket draw stall |
| W2 | 129 | `group_group_ko\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-group-ko-boardgame` | P1 bracket draw stall |
| W2 | 130 | `group_group_ko\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-group-ko-boardgame` | P1 bracket draw stall |
| W2 | 131 | `group_group_ko\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-group-group-ko-boardgame` | P1 bracket draw stall |
| W2 | 141 | `knockout_third_place\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-knockout-third-place-boardgame` | P1 bracket draw stall |
| W2 | 142 | `knockout_third_place\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-knockout-third-place-boardgame` | P1 bracket draw stall |
| W2 | 143 | `knockout_third_place\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-knockout-third-place-boardgame` | P1 bracket draw stall |
| W2 | 144 | `knockout_third_place\|boardgame\|blitz\|F1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-knockout-third-place-boardgame` | P1 bracket draw stall |
| W2 | 147 | `page_playoff_only\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-page-playoff-only-boardgame` | P1 bracket draw stall |
| W2 | 148 | `page_playoff_only\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-page-playoff-only-boardgame` | P1 bracket draw stall |
| W2 | 151 | `page_playoff_only\|generic\|score\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-page-playoff-only-generic` | P1 bracket draw stall |
| W2 | 152 | `page_playoff_only\|generic\|score\|M1` | I2-bracket-one-champion-ranks-permutation | `w1drv-l3-fr1/w1drv-p1-page-playoff-only-generic` | P1 bracket draw stall |
| W2 | 166 | `stepladder_only\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-stepladder-only-boardgame` | P1 bracket draw stall |
| W2 | 167 | `stepladder_only\|boardgame\|blitz\|M1` | I4-nothing-ends-stuck, m1-walkover-recorded, m1-winner-progresses, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-stepladder-only-boardgame` | P1 bracket draw stall |
| W2 | 169 | `stepladder_only\|boardgame\|blitz\|F1` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-stepladder-only-boardgame` | P1 bracket draw stall |
| W3 | 29 | `swiss_playoff\|hockey\|fih-outdoor\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P6 swiss R4 |
| W3 | 34 | `swiss_knockout\|generic\|score\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P6 swiss R4 |
| W3 | 35 | `swiss_knockout\|hockey\|fih-outdoor\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P6 swiss R4 |
| W4 | 40 | `ko_plate\|football\|11-a-side\|F1` | I4-nothing-ends-stuck, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P2 ko_plate F1 |
| W4 | 41 | `ko_plate\|cricket\|t20\|F1` | I4-nothing-ends-stuck, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P2 ko_plate F1 |
| W4 | 46 | `ko_plate\|carrom\|club-29\|F1` | I4-nothing-ends-stuck, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P2 ko_plate F1 |
| W4 | 47 | `ko_plate\|generic\|score\|F1` | I4-nothing-ends-stuck, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P2 ko_plate F1 |
| W4 | 48 | `ko_plate\|volleyball\|beach\|F1` | I4-nothing-ends-stuck, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P2 ko_plate F1 |
| W4 | 49 | `ko_plate\|badminton\|bwf\|F1` | I4-nothing-ends-stuck, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P2 ko_plate F1 |
| W4 | 50 | `ko_plate\|tabletennis\|bo5\|F1` | I4-nothing-ends-stuck, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P2 ko_plate F1 |
| W4 | 51 | `ko_plate\|tennis\|tour\|F1` | I4-nothing-ends-stuck, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P2 ko_plate F1 |
| W4 | 52 | `ko_plate\|icehockey\|iihf\|F1` | I4-nothing-ends-stuck, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P2 ko_plate F1 |
| W4 | 53 | `ko_plate\|hockey\|fih-outdoor\|F1` | I4-nothing-ends-stuck, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P2 ko_plate F1 |
| W4 | 145 | `page_playoff_only\|football\|11-a-side\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P4 page_playoff_only R4 |
| W4 | 146 | `page_playoff_only\|cricket\|t20\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P4 page_playoff_only R4 |
| W4 | 149 | `page_playoff_only\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-page-playoff-only-boardgame` | P4 page_playoff_only R4 |
| W4 | 150 | `page_playoff_only\|carrom\|club-29\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P4 page_playoff_only R4 |
| W4 | 153 | `page_playoff_only\|generic\|score\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3-fr1/w1drv-p1-page-playoff-only-generic` | P4 page_playoff_only R4 |
| W4 | 154 | `page_playoff_only\|volleyball\|beach\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P4 page_playoff_only R4 |
| W4 | 155 | `page_playoff_only\|badminton\|bwf\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P4 page_playoff_only R4 |
| W4 | 156 | `page_playoff_only\|tabletennis\|bo5\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P4 page_playoff_only R4 |
| W4 | 157 | `page_playoff_only\|tennis\|tour\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P4 page_playoff_only R4 |
| W4 | 158 | `page_playoff_only\|icehockey\|iihf\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P4 page_playoff_only R4 |
| W4 | 159 | `page_playoff_only\|hockey\|fih-outdoor\|R4` | I4-nothing-ends-stuck, life-loop-bounded | `w1drv-l3` | P4 page_playoff_only R4 |
| W4 | 161 | `stepladder_only\|football\|11-a-side\|R4` | error red — RefusedCall: POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant (bye/TBD) | `w1drv-l3-rerun/w1drv-rr-stepladder-only-football` | P5 stepladder R4 |
| W4 | 164 | `stepladder_only\|cricket\|t20\|R4` | error red — RefusedCall: POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant (bye/TBD) | `w1drv-l3-rerun/w1drv-rr-stepladder-only-cricket` | P5 stepladder R4 |
| W4 | 168 | `stepladder_only\|boardgame\|blitz\|R4` | error red — RefusedCall: POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant (bye/TBD) | `w1drv-l3-fr1/w1drv-p1-stepladder-only-boardgame` | P5 stepladder R4 |
| W4 | 171 | `stepladder_only\|carrom\|club-29\|R4` | error red — RefusedCall: POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant (bye/TBD) | `w1drv-l3-rerun/w1drv-rr-stepladder-only-carrom` | P5 stepladder R4 |
| W4 | 174 | `stepladder_only\|generic\|score\|R4` | error red — RefusedCall: POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant (bye/TBD) | `w1drv-l3-rerun/w1drv-rr-stepladder-only-generic` | P5 stepladder R4 |
| W4 | 177 | `stepladder_only\|volleyball\|beach\|R4` | error red — RefusedCall: POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant (bye/TBD) | `w1drv-l3-rerun/w1drv-rr-stepladder-only-volleyball` | P5 stepladder R4 |
| W4 | 180 | `stepladder_only\|badminton\|bwf\|R4` | error red — RefusedCall: POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant (bye/TBD) | `w1drv-l3-rerun/w1drv-rr-stepladder-only-badminton` | P5 stepladder R4 |
| W4 | 183 | `stepladder_only\|tabletennis\|bo5\|R4` | error red — RefusedCall: POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant (bye/TBD) | `w1drv-l3-rerun/w1drv-rr-stepladder-only-tabletennis` | P5 stepladder R4 |
| W4 | 186 | `stepladder_only\|tennis\|tour\|R4` | error red — RefusedCall: POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant (bye/TBD) | `w1drv-l3-rerun/w1drv-rr-stepladder-only-tennis` | P5 stepladder R4 |
| W4 | 189 | `stepladder_only\|icehockey\|iihf\|R4` | error red — RefusedCall: POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant (bye/TBD) | `w1drv-l3-rerun/w1drv-rr-stepladder-only-icehockey` | P5 stepladder R4 |
| W4 | 192 | `stepladder_only\|hockey\|fih-outdoor\|R4` | error red — RefusedCall: POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: fixture has an unassigned entrant (bye/TBD) | `w1drv-l3-rerun/w1drv-rr-stepladder-only-hockey` | P5 stepladder R4 |
| W5 | 127 | `group_group_ko\|football\|11-a-side\|F1` | I1-rr-pair-once-per-leg, I4-nothing-ends-stuck, life-built-as-posted, f1-everyone-drawn, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P3 group_group_ko F1 |
| W5 | 128 | `group_group_ko\|cricket\|t20\|F1` | I1-rr-pair-once-per-leg, I4-nothing-ends-stuck, life-built-as-posted, f1-everyone-drawn, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P3 group_group_ko F1 |
| W5 | 132 | `group_group_ko\|boardgame\|blitz\|F1` | I1-rr-pair-once-per-leg, I4-nothing-ends-stuck, life-built-as-posted, f1-everyone-drawn, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3-fr1/w1drv-p1-group-group-ko-boardgame` | P3 group_group_ko F1 |
| W5 | 133 | `group_group_ko\|carrom\|club-29\|F1` | I1-rr-pair-once-per-leg, I4-nothing-ends-stuck, life-built-as-posted, f1-everyone-drawn, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P3 group_group_ko F1 |
| W5 | 134 | `group_group_ko\|generic\|score\|F1` | I1-rr-pair-once-per-leg, I4-nothing-ends-stuck, life-built-as-posted, f1-everyone-drawn, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P3 group_group_ko F1 |
| W5 | 135 | `group_group_ko\|volleyball\|beach\|F1` | I1-rr-pair-once-per-leg, I4-nothing-ends-stuck, life-built-as-posted, f1-everyone-drawn, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P3 group_group_ko F1 |
| W5 | 136 | `group_group_ko\|badminton\|bwf\|F1` | I1-rr-pair-once-per-leg, I4-nothing-ends-stuck, life-built-as-posted, f1-everyone-drawn, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P3 group_group_ko F1 |
| W5 | 137 | `group_group_ko\|tabletennis\|bo5\|F1` | I1-rr-pair-once-per-leg, I4-nothing-ends-stuck, life-built-as-posted, f1-everyone-drawn, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P3 group_group_ko F1 |
| W5 | 138 | `group_group_ko\|tennis\|tour\|F1` | I1-rr-pair-once-per-leg, I4-nothing-ends-stuck, life-built-as-posted, f1-everyone-drawn, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P3 group_group_ko F1 |
| W5 | 139 | `group_group_ko\|icehockey\|iihf\|F1` | I1-rr-pair-once-per-leg, I4-nothing-ends-stuck, life-built-as-posted, f1-everyone-drawn, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P3 group_group_ko F1 |
| W5 | 140 | `group_group_ko\|hockey\|fih-outdoor\|F1` | I1-rr-pair-once-per-leg, I4-nothing-ends-stuck, life-built-as-posted, f1-everyone-drawn, life-loop-bounded, advance-seeded-as-declared | `w1drv-l3` | P3 group_group_ko F1 |
| W7 | 72 | `americano\|football\|11-a-side\|R4` | r4-policy-reported, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-americano-football` | table: kept-playing |
| W7 | 73 | `americano\|cricket\|t20\|R4` | r4-policy-reported, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-americano-cricket` | table: kept-playing |
| W7 | 74 | `americano\|boardgame\|blitz\|R4` | r4-policy-reported, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-americano-boardgame` | table: kept-playing |
| W7 | 75 | `americano\|carrom\|club-29\|R4` | r4-policy-reported, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-americano-carrom` | table: kept-playing |
| W7 | 76 | `americano\|generic\|score\|R4` | r4-policy-reported, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-americano-generic` | table: kept-playing |
| W7 | 77 | `americano\|volleyball\|beach\|R4` | r4-policy-reported, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-americano-volleyball` | table: kept-playing |
| W7 | 78 | `americano\|badminton\|bwf\|R4` | r4-policy-reported, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-americano-badminton` | table: kept-playing |
| W7 | 79 | `americano\|tabletennis\|bo5\|R4` | r4-policy-reported, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-americano-tabletennis` | table: kept-playing |
| W7 | 80 | `americano\|tennis\|tour\|R4` | r4-policy-reported, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-americano-tennis` | table: kept-playing |
| W7 | 81 | `americano\|icehockey\|iihf\|R4` | r4-policy-reported, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-americano-icehockey` | table: kept-playing |
| W7 | 82 | `americano\|hockey\|fih-outdoor\|R4` | r4-policy-reported, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-americano-hockey` | table: kept-playing |
| W7 | 83 | `mexicano\|football\|11-a-side\|LIFECYCLE` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-football` | table: self-pair + duplicate |
| W7 | 84 | `mexicano\|football\|11-a-side\|M1` | life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-football` | table: mexicano stall |
| W7 | 85 | `mexicano\|football\|11-a-side\|R4` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-fr2/w1drv-fr2-r4-mexicano-football` | table: self-pair + duplicate |
| W7 | 86 | `mexicano\|football\|11-a-side\|F1` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-built-as-posted, f1-everyone-drawn, f1-round-size, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-football` | P7 mexicano, outside the coverage table |
| W7 | 87 | `mexicano\|cricket\|t20\|LIFECYCLE` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-cricket` | table: self-pair + duplicate |
| W7 | 88 | `mexicano\|cricket\|t20\|M1` | life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-cricket` | table: mexicano stall |
| W7 | 89 | `mexicano\|cricket\|t20\|R4` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-fr2/w1drv-fr2-r4-mexicano-cricket` | table: self-pair + duplicate |
| W7 | 90 | `mexicano\|cricket\|t20\|F1` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-built-as-posted, f1-everyone-drawn, f1-round-size, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-cricket` | P7 mexicano, outside the coverage table |
| W7 | 91 | `mexicano\|boardgame\|blitz\|LIFECYCLE` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-boardgame` | table: self-pair + duplicate |
| W7 | 92 | `mexicano\|boardgame\|blitz\|M1` | life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-boardgame` | table: mexicano stall |
| W7 | 93 | `mexicano\|boardgame\|blitz\|R4` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-fr2/w1drv-fr2-r4-mexicano-boardgame` | table: self-pair + duplicate |
| W7 | 94 | `mexicano\|boardgame\|blitz\|F1` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-built-as-posted, f1-everyone-drawn, f1-round-size, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-boardgame` | P7 mexicano, outside the coverage table |
| W7 | 95 | `mexicano\|carrom\|club-29\|LIFECYCLE` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-carrom` | table: self-pair + duplicate |
| W7 | 96 | `mexicano\|carrom\|club-29\|M1` | life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-carrom` | table: mexicano stall |
| W7 | 97 | `mexicano\|carrom\|club-29\|R4` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-fr2/w1drv-fr2-r4-mexicano-carrom` | table: self-pair + duplicate |
| W7 | 98 | `mexicano\|carrom\|club-29\|F1` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-built-as-posted, f1-everyone-drawn, f1-round-size, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-carrom` | P7 mexicano, outside the coverage table |
| W7 | 99 | `mexicano\|generic\|score\|LIFECYCLE` | I4-nothing-ends-stuck, I8-generate-named, life-draw-path-exercised, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-generic` | table: self-pair |
| W7 | 100 | `mexicano\|generic\|score\|M1` | life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-generic` | table: mexicano stall |
| W7 | 101 | `mexicano\|generic\|score\|R4` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, r4-not-seated-later, life-loop-bounded | `w1drv-l3-fr2/w1drv-fr2-r4-mexicano-generic` | table: self-pair + duplicate + kept-playing |
| W7 | 102 | `mexicano\|generic\|score\|F1` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-built-as-posted, f1-everyone-drawn, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-generic` | P7 mexicano, outside the coverage table |
| W7 | 103 | `mexicano\|volleyball\|beach\|LIFECYCLE` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-volleyball` | table: self-pair + duplicate |
| W7 | 104 | `mexicano\|volleyball\|beach\|M1` | life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-volleyball` | table: mexicano stall |
| W7 | 105 | `mexicano\|volleyball\|beach\|R4` | I10-americano-seats-each-person-once, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-mexicano-volleyball` | P7 mexicano, outside the coverage table |
| W7 | 106 | `mexicano\|volleyball\|beach\|F1` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-built-as-posted, f1-everyone-drawn, f1-round-size, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-volleyball` | P7 mexicano, outside the coverage table |
| W7 | 107 | `mexicano\|badminton\|bwf\|LIFECYCLE` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-badminton` | table: self-pair + duplicate |
| W7 | 108 | `mexicano\|badminton\|bwf\|M1` | life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-badminton` | table: mexicano stall |
| W7 | 109 | `mexicano\|badminton\|bwf\|R4` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-fr2/w1drv-fr2-r4-mexicano-badminton` | table: self-pair + duplicate |
| W7 | 110 | `mexicano\|badminton\|bwf\|F1` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-built-as-posted, f1-everyone-drawn, f1-round-size, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-badminton` | P7 mexicano, outside the coverage table |
| W7 | 111 | `mexicano\|tabletennis\|bo5\|LIFECYCLE` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-tabletennis` | table: self-pair + duplicate |
| W7 | 112 | `mexicano\|tabletennis\|bo5\|M1` | life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-tabletennis` | table: mexicano stall |
| W7 | 113 | `mexicano\|tabletennis\|bo5\|R4` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-fr2/w1drv-fr2-r4-mexicano-tabletennis` | table: self-pair + duplicate |
| W7 | 114 | `mexicano\|tabletennis\|bo5\|F1` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-built-as-posted, f1-everyone-drawn, f1-round-size, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-tabletennis` | P7 mexicano, outside the coverage table |
| W7 | 115 | `mexicano\|tennis\|tour\|LIFECYCLE` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-tennis` | table: self-pair + duplicate |
| W7 | 116 | `mexicano\|tennis\|tour\|M1` | life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-tennis` | table: mexicano stall |
| W7 | 117 | `mexicano\|tennis\|tour\|R4` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-fr2/w1drv-fr2-r4-mexicano-tennis` | table: self-pair + duplicate |
| W7 | 118 | `mexicano\|tennis\|tour\|F1` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-built-as-posted, f1-everyone-drawn, f1-round-size, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-tennis` | P7 mexicano, outside the coverage table |
| W7 | 119 | `mexicano\|icehockey\|iihf\|LIFECYCLE` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-icehockey` | table: self-pair + duplicate |
| W7 | 120 | `mexicano\|icehockey\|iihf\|M1` | life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-icehockey` | table: mexicano stall |
| W7 | 121 | `mexicano\|icehockey\|iihf\|R4` | I10-americano-seats-each-person-once, r4-not-seated-later | `w1drv-l3-fr2/w1drv-fr2-r4-mexicano-icehockey` | table: duplicate + kept-playing |
| W7 | 122 | `mexicano\|icehockey\|iihf\|F1` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-built-as-posted, f1-everyone-drawn, f1-round-size, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-icehockey` | P7 mexicano, outside the coverage table |
| W7 | 123 | `mexicano\|hockey\|fih-outdoor\|LIFECYCLE` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-hockey` | table: self-pair + duplicate |
| W7 | 124 | `mexicano\|hockey\|fih-outdoor\|M1` | life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-hockey` | table: mexicano stall |
| W7 | 125 | `mexicano\|hockey\|fih-outdoor\|R4` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-fr2/w1drv-fr2-r4-mexicano-hockey` | table: self-pair + duplicate |
| W7 | 126 | `mexicano\|hockey\|fih-outdoor\|F1` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-built-as-posted, f1-everyone-drawn, f1-round-size, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-hockey` | P7 mexicano, outside the coverage table |
| W7 | 194 | `mexicano\|cricket\|test\|LIFECYCLE\|cricket#060` | I4-nothing-ends-stuck, I8-generate-named, I10-americano-seats-each-person-once, life-loop-bounded | `w1drv-l3-rerun/w1drv-rr-mexicano-cricket` | table: self-pair + duplicate |

## Findings routed (W2c)

Open findings that need an owner ruling, work deferred to a named owner, what Task 23 still owes, and the minors
parked under the owner's UI scope cut (rulings 150 and 152). Read from the SDD ledger at `0bd3d3e1cf`, before Task 23's
rebase.

**Need an owner ruling**
- **BWF 3×15 scoring** (ruling 155): issue #1004 asks whether it ships as a standalone PR or waits for W2e.
- **The 27 v1 handlers that validate the body before they authenticate** (the #376 ordering). PR #1006 pins them as an
  exact list (`VALIDATES_BEFORE_AUTH`, `apps/web/src/server/usecases/__tests__/api-key-pin-sweep.test.ts` on main) and
  routes the ordering without fixing it: such a handler answers a bad body 400 before any 401 or 403. Fixing the order
  has no owner. W2c's rebase classifies its own `PUT /fixtures/:id/rules` against the list.

**Deferred, each with its owner**
- **W2d** (spec and plan approved 2026-10-20, unmerged; W2c merges first; done: PR A #1038 merged 2026-10-27, PR B
  #1053 open, see "Findings routed (W2d)"): ST-G10, the per-stage tie-break cascade
  and `validateCascade`; per-sport point systems (chess 1/½/0 or 3/1/0, cricket tie and no-result, ice hockey OT/SO,
  hockey SO 2/1, volleyball, football presets, table tennis 2/1/0) and widening `PointsRule`, which removes
  `POINTS_RULE_INEXPRESSIBLE` (cricket's stage points are inexpressible until then, plan finding 29); loosening the Q3
  division lock into per-stage pinning; the fair-play cascade; MD-1 on `competition/tiebreakers.ts` (W2c classified
  `points.ts` in full).
- **W2e:** the five stage keys with no editor field (ruling 157); continuous sudden-death overtime (SC-P3) and the
  dead `shootout.suddenDeath`; every older mutant survivor in the sport modules and kernels, `core/*` and
  `sport/module.ts` (MD-1 table). Done in W2e: rulings 224, 225 and 230.
- **Competition desk:** a bulk "apply to all unstarted matches in this stage" over `writeFixtureRulesOverride` (design
  §2.2); run-sheet filters that hide untimed held rows (ruling 134).
- **Chess:** games per match, zero-point byes and playoff sequences go to the ruling-119 playoff wave; a per-fixture
  online time control goes to the chess in-page programme (design §2.2).
- **Engine GF-3** (after W2c merges): per-stream `foldOptions` joins the golden stream identity. Until then
  GOLDEN-POLICY keeps the "server-only fold input, MAJOR owed" line. Done: GF-3 merged as #1012 (`46b8c5739b`)
  before W2d's PR A.
- **Post-W2b mutation re-measure:** survivors already alive at W2c's base (for example `w2b/f-r1`'s
  `r1-m2-stages-loser`), confirmed at the base and not W2c's.
- **Future native clients:** the Capture S2 handoff's "every epoch is 1" is false after W2c (ruling 145); the notice
  is owed to the native-app work.
- **Unowned:** a "replay from 0-0" reset for an abandoned match (design §2.2; W2b false premise 6).

**Owed in Task 23, before the merge**
- The migration number: main's maximum plus one at the rebase (V469, or V470 if #1005 merges first).
- Absorb PR #1006 (pinned keys fail closed); W2c's two `/fixtures/:id/rules` key-scope rows pin the fixture.
- If `feat/all-stages-free` (#1005) lands first, reconcile `product-gates-source.ts` and the denied and
  format-gates-copy scans (the gate set is the exports, the count above zero).
- Engine #978: check W2c's tests, smoke and e2e for lineup PUTs with bench rows on boardgame, carrom or generic
  (`LINEUP_BENCH_NOT_SUPPORTED`).
- P8 (plan Task 23 Step 7): chess in-page is merged (#948), so its external-play suites run against W2c's Armageddon
  colours on the merged tree.
- `mutants/w2c/t7-post-merge.json`'s `pm-16-v1-leak` anchor matches nothing (stale on its base too).
- PR body release notes: the strict stage-rules PUT body (breaking for external clients); `GET /fixtures/{id}/rules`
  in the public v1 OpenAPI with `read` scope; no "player profile" note (false premise 20 of W2c); the five keys under
  "Deferred to W2e".

**Parked minors (owner scope cut, or accepted)**
- **UI, for the redesign (ruling 149):** ice hockey `overtimeSkaters` stays editable while overtime is off; the
  division's empty-rungs hint copy; Task 18's M5 copy and the generic win/loss draw box; Task 18's same-mount second
  save and decoration asserts; Task 19's other copy items and its refused-set ratchet; Task 20's M-2, M-3 and cosmetic
  items; the S5 sheet's `px-4` / `shrink-0` class-scan survivors; a batch-5 counter-title nit.
- **Accepted as safe:** one match cannot clear badminton `cap` to "no cap" on its own (`null` inherits; set it on the
  stage); the volleyball `pointsMap` multi-pair over-refusal; hockey `quarterMinutes` has no engine maximum, so the
  web maximum is not pinned.
- **Engine and tests:** 16b's Minor 8 (an engine helper, later); 16c's Minors 2–3 (no lineups stream; equivalent
  mutants); Task 10's ledger-reads-comments mutant leans on a production comment; in Task 2, no mutant guards against
  normalising `tiebreakers: []` to `null`, and one test inserts a global `sport_variants` row (cleaned in `finally`); a stale
  `lib/match-rules.ts` pointer in a comment in `e2e/walkthrough/stage-rules-start-promotion.spec.ts`; `createStages`'
  pooled division read is not org-scoped (pre-existing, noted in Task 13, not routed).

## Findings routed (W2d)

Open findings that need an owner ruling, work deferred to a named owner, and what the release still owes. Read from
the SDD ledger at `a719e11309` (PR B after its rebase); PR B's final whole-branch review adds its own parked table
(`final-review.md` in the SDD directory), which the controller folds here.

**Owed before the W2 release** (ruling 214 (1); no release until all of W2 is done, ruling 213)
- The Task 7 staging check, run by the owner (the build never connects to staging).
- The data audit (`data-audit.sql` in the SDD directory): unknown outcome methods per sport, invalid tie-break keys in
  divisions and stage configs, chess non-Swiss stages listing `sberger`, active or complete unpinned stages, and old
  `{base}` stage rules; every count 0 expected.
- The translator pass for es, fr and nl: the reworded `rules.err.pointsRuleInexpressible` and
  `stagePoints.invalid.number` (ruling 212), "3 / 2 / 1 / 0 (shoot-out)", badminton's "set difference" against BWF's
  "games", and the merge-fix's fr/nl wording.
- `post-deploy-pin.ts --check` right after the deploy; its fix mode only on a fresh owner go (ruling 208 expired).

**Need an owner ruling**
- **The hockey "3 / 2 / 1 / 0 (shoot-out)" preset** pays what hockey's default variant already pays (false premise 18):
  keep offering it, hide it on that variant, or drop it.
- **The level table's JSON** (Concern 2 m6, with Task 17 m9): the public API serves `rank: 1..n` for a level table.

**Deferred, each with its owner**
- **W3:** P6 / SW-H1 (ruling 70's three cells stand, see "W2d and ruling 70"); Swiss default content and the Swiss
  tie-break families on W2d's validator and editor (SW-H4); the W3 spec waits until W2d merges (ruling 214 (3)).
- **Rules backfill wave (ruling 121):** the FIH overtime cfg (ruling 214 (2)); the player-stat games of a match
  tie-break (ruling 203).
- **W5:** ST-G3, ST-G5, ST-G6, ST-G14, ST-G15, ST-G20, ST-G23, ST-G24 (the prompt as amended), and the re-route of design
  §8 and the backlog section if it is ruled for (false premise 21).
- **Division builder and settings redesign (ruling 149):** W2d's UI minors parked under the correctness-first cut
  (rulings 177, 150, 152); the editor keeps "Use the division's points" ticked beside the "keeps the points it started
  with" line (PR A I1).
- **A separate mechanical PR right after W2d merges:** the `scripts/smoke.ts` split (ruling 220).
- **The e2e visual lane:** `apps/web/e2e/visual/seeds.ts:30` says the embed widget is empty before a decided fixture;
  after Concern 2 a generated league's widget may show the level table, which needs re-measuring (Concern 2 m8b).
- **The mutation session:** the stryker-sizing legs that drift on W2d's engine files (ruling 154; CI legs dispatched
  for PR B).

**Owed: the organiser standings export against the public table** (export every pool, branch
`fix/export-every-pool-shown-metrics`, 2026-10-28; its review m4). The export now prints every pool, the public table's
metric columns and, per table, its result columns (D exactly when a row of that table holds a draw; the kiosk the same).
It still differs from the public table here:
- **Derived cascade columns.** The public table prints the cascade's derived columns (cricket's NRR, Swiss Buchholz,
  the points ratio: `tableColumns` kind `derived`). The export prints none, so a cricket sheet carries T and NR but no
  NRR.
- **Absent metric "—" against 0.** The export prints a metric a row does not carry as `0` (`r.metrics[m] ?? 0`); the
  public table prints "—" (`formatMetric(undefined)`).
- **`formatMetric` spelling.** The export prints raw metric numbers; the public table prints them through
  `formatMetric` (a metric's declared decimals).
- **No e2e downloads the standings export.** The DB suites (`export-every-pool.test.ts`,
  `generate-level-table.test.ts`) and the real-pdfkit render tests are its only witnesses.
- **doc-render: a short-name table spreads its spare width over the numeric columns.** Every column's share is
  `min(max(len, 3), 40)` of the page (`tableGrid` in `doc-render.ts`). A table of short names ("E3") therefore spreads
  its counts across the page and pushes `#` and Team right. On a mixed-shape sheet (one pool with D, one without: their
  own grids), the pools do not share a #/Team left edge. This is pre-existing on main (`drawTable`'s weights). A fix,
  where numeric columns take their floor and the text column the slack, moves EVERY PDF table: timetables, rosters, the
  officials rota and scoresheets. It needs its own visual pass across the document kinds (export re-review item 4, n2).

**State at the W2e fold (2026-10-29, lane W `c92e8df971`; ruling 237): all five rows are OPEN.** None is closed here and no
owner verdict is on file; the #1061 export stream (session f-w2d) owns them, and the Status table says so. Each checked
against the tree, not the row's text:
1. Derived columns: `usecases/exports.ts` (~:521–560) filters `shown` to `kind === "metric"` and passes the raw
   `r.metrics`; the word "derived" appears nowhere in `exports.ts` or `packages/engine/src/exports`.
2. Absent metric: `packages/engine/src/exports/build.ts:151` still reads `r.metrics[m] ?? 0`.
3. `formatMetric`: not used by `exports.ts` or the engine's exports.
4. No e2e: no `apps/web/e2e` spec downloads `exports/standings` (the e2e export downloads are timetable, roster, officials
   rota and scorer sheets). `scripts/smoke/main.ts:1451` fetches `exports/standings?format=pdf` once to check the PDF has
   content for the entitlement matrix: a smoke step, not an e2e, and not its columns.
5. `doc-render.ts`: `tableGrid` still weights every column by character count (`min(max(len, 3), 40)`). `fitColumns`
   (review m2) now floors a header and a count at its widest cell, and `sharedGrids` shares one grid across same-column
   pools, but the spare width still spreads over the numeric columns and a mixed-shape sheet's pools still print on
   different grids.
Ruling 238 settles one thing for row 1: when the export gains NRR it reads the same standings NRR as the public table.

**Parked (accepted, or under the owner's scope cuts)**
- **Concern 2:** an undo of a generate leaves its level table (a later delete drops it); pooled groups still read "No
  standings yet" before a result.
- **Guards:** `fold-epoch:check` compares corpora only, so a deliberate `standingsDelta` change on an unchanged corpus is
  invisible to it (the golden tests are the only witness); the outcome-methods source scan's blind spots are uncounted
  (unresolved names, arrow functions, a quoted `method` key); `stryker-changed.mjs --expect` ignores
  `stryker-equivalent.json`.
- **Scripts (ruling 207):** no further work on `post-deploy-pin.ts` or the DDL mutant driver unless a secret leaks or
  customer data is at risk.
- **Engine:** the MTB winner is derived twice in `nested/kernel.ts`, and its opposite-side level-set fallbacks are
  unreachable; a tennis 1-game set cannot witness a set/game swap in the walkthrough.

## Findings routed (W2e)

Open findings that need an owner ruling, work deferred to a named owner, and what the release still owes. Read from the SDD
ledger at lane W `c92e8df971`; PR B's final whole-branch review adds its own parked table (`review-pr-b.md` in the SDD
directory), which the controller folds here.

**Owed before the W2 release** (ruling 214 (1); no production release until all of W2 is done, ruling 213)
- **One tag for PR A and PR B.** PR A's ending-sanction refusals need PR B's pad prompt: with PR A alone a badminton or
  tennis pad cannot record the ending after a black card or default. Drafted release notes (the "Data changes" of both PRs,
  the `rank: null` entry, ruling 238's loud list) are in the SDD directory, `release-notes-w2e.md`, for the owner to publish.
- **The data audit** (`data-audit.sql`, SDD directory): W2d's three statements (the tie-break key list is now the engine's
  29, not 19; the displayed chess default is the non-Swiss cascade) plus W2e's three: set targets below 5, tennis Bo1 with a
  match tie-break, and ledgers with an unended match-ending sanction (reported, never repaired). Read each census's
  `checked` before its flagged count. **Staging, read 2026-10-29: W2e's three 0 flagged; W2d's (b) found 3 football
  divisions whose `tiebreakers` is `["fifa2026"]` (not an engine key), W2d's (c) 14 chess non-Swiss stages that list
  `sberger`.** Run it on prod too; V481 fails the deploy loudly on any stored set target below 5 or Bo1 + match tie-break
  (the audit's (d) and (e) are its read-only pre-check).
- **The translator pass for es, fr and nl** now also covers W2e's 303 strings (ruling 240's PO decision: ships, native pass
  after).
- `post-deploy-pin.ts --check` right after the deploy (its fix mode only on a fresh owner go).
- **The five #1061 export rows are OPEN** (ruling 237; "Owed: the organiser standings export" below carries the state).

**Need an owner ruling**
- **W2 stays "awaiting" in the Status table until PR B merges, and the harness still routes 11 sites to it.** Nine
  `routeTo("W2", …)` sites in `tools/matrix/lib` and two `routedTo: "W2"` entries in `tools/matrix/catalogue/counts.json`
  name W2 (engine-refused configs, generator breadth, the rules editor and forfeit dialog not driven in the browser, pad
  controls without a testid, M12b's cricket/generic disposition, side size). `scenario-catalogue.test.ts` requires a
  routed wave's Status row to be open, so the row cannot read "Closed" until each site is retired, re-routed to a later
  wave, or given an owner "not built, because…" (ruling 229).
- **MD-1's narrowing** (controller rulings above): the owner approved §11(b) as "W2e owns the result-deciding paths
  whether W2e changes them or not"; the controller parked the 369 unchanged-path survivors with the mutation session.

**Deferred, each with its owner**
- **A post-W2 wave (ruling 228):** result-only final-score entry for football, hockey and ice hockey (RB2B-39, SC-P12);
  carrom game-level result entry (RB2B-26, SC-O6); a futsal variant (RB2B-32, SC-P11).
- **Not built (ruling 228):** 5-ball overs beyond The Hundred (RB2A-26); coarse super-over entry (SC-C8); badminton team ties
  (RB2A-32) and draws on a ladder (SC-P13) as "refuse / by design" rows; repeat sudden-death overtime (ruling 224).
- **W5:** points deduction (RB2A-28, RB2B-35). **W4:** two-leg aggregate and away goals (X6b).
- **The rules backfill wave (rulings 203, 214 (2)):** the FIH overtime cfg; the player-stat games tie-break.
- **The mutation session:** MD-X1 and MD-X2, `competition/stage.ts` and `progression.ts` (E10), every older survivor outside
  W2e's changed lines, and the 369 parked §11(b) survivors (`size11b.json`, `ranges11b.txt`); not a prod gate.
- **W3 / the Swiss shells programme:** the SW-H1 "round 5 paired nobody" flake (two cells flipped in the W2e truth run).
- **Not built in the matrix, covered by e2e and unit:** the M12b retirement route and the pad DLS-revise route
  (`tools/matrix` README lists them). A cricket or generic retirement control: not built (cricket's all-out count stays;
  generic refuses lineup events), disposition rows say so.
- **The hockey/ice-hockey IIHF departures** (penalty-shot release, coincidental minors, a double minor, stacked clocks) and
  IFAB's sin-bin-from-restart: deviation rows with `limit` tests, no engine change (rules backfill).
- **Cricket copy:** the held-reason sentence repeats the help sentence (one key × 4 locales, after T36). `ICC Appendix D
  3.6.1` allows two unsuccessful player reviews an innings and the presets do not carry that: a product question.
- **Parked UI minors:** the PR B pad items listed under "Controller rulings (execution, W2e)" (320px wraps, the one-cell
  "Advance period" tile) and the division builder and settings redesign (ruling 149).

## W2 checklist (binding; from the W1c coverage audit)

The owner's direction (ruling 42, 2026-09-30) is "don't miss any possibilities": every sport's rule-level
possibilities must be enumerated, and each must be owned by a wave. The rows below are the controller's audit, not
owner rulings (class 17). The authority for each row is `w2-coverage-audit.md` (this directory, 2026-09-30,
read-only, with file:line for every engine claim). The W2 prompt (`W2-scoring-fidelity.md`) carries the same
checklist.

The audit covers 11 sports and 183 result-level possibilities (all 11 sports have a rulebook section). It found 14
ABSENT from W2, 9 stated only in prose, and 19 in-match mechanics with no row.

**1. ABSENT from both W2 rulebooks.** Each gets a verdict row, or a named gap with its owning wave, before rulebook
sign-off:

- **Badminton.** The sanction ladder is record-only: a penalty awards no rally, and a DQ does not end the match.
- **Table tennis.** A sanction's penalty point is not awarded (record-only).
- **Volleyball.** Sanction penalty, expulsion and DQ are record-only: no point is awarded, and there is no
  incomplete-team ending.
- **Tennis.**
  - `sanction{level:"default"}` does not end the match, and point/game penalties are record-only.
  - The `tennis.game.award` (penalty game) seam.
- **Cricket.**
  - `points.draw` for two-innings draws.
  - Innings victory (`innings_and_runs`).
  - Follow-on.
  - Innings forfeiture.
  - Timeless innings (NRR quota, all-out charge).
  - Penalty runs.
- **Football.** An own goal credits the opponent.
- **Hockey.** A team reduced below `strength.min` has no ending rule (it shows only a display chip).
- **Generic.** `progressScore` is declared and stored, with no effect (an inert seam).

**2. Stated in prose only (PARTIAL): each needs a verdict row.**

- **Cricket.**
  - The ODI 20-over minimum.
  - Abandon during a super over → tie.
  - A manual (non-DLS) revised target.
  - A two-innings abandon → draw.
- **Football.** The `youth` variant.
- **Hockey.** The `youth` variant.
- **Boardgame.** Abandon → `replayFlagged`.
- **Carrom.**
  - The `club-29` variant.
  - Drawn games inside a won match.

**3. In-match mechanics with no row (19).** Each is either a W2 row or an explicit "not W2, owned by …":

- **Badminton.** Serve rules.
- **Table tennis.** Time-outs.
- **Volleyball.** Technical time-outs, substitutions and libero.
- **Tennis.** Interruptions.
- **Cricket.**
  - Batter retire (hurt / out).
  - The DRS allowance.
  - `maxOversPerBowler`.
  - Powerplay, free hit, new ball and toss.
  - The wicket modes.
  - Lineup changes and concussion replacements.
- **Football.**
  - Sin bin.
  - The in-play penalty-kick record.
  - Substitutions (rolling, max, concussion, windows).
  - `periodSeconds` / `addedMinutes`.
- **Hockey.**
  - Suspension classes (green / yellow / red).
  - Goalkeeper required or optional, and the PC / stroke set pieces.
- **Ice hockey.**
  - Suspensions (minor / major / misconduct), and `releaseOnGoal` for power plays.
  - Strength 5/3.
- **Carrom.** Toss and first break. This one is covered by text §5.1.

**4. Generator reach: W2's plan must include a generator-breadth task BEFORE its truth run.** Today, no generator in
`tools/matrix/lib/streams/` emits any of these:

- any decider: extra time, shoot-out, overtime, GWS, super over, DLS;
- ~~a cricket tie;~~ struck by ruling 44 (W1-driving builds it: `streams/cricket.ts` `tied`);
- a deciding set, except at `bestOf: 1`;
- a set cap;
- a tie-break set;
- a partial-score retirement;
- a double walkover;
- an abandon under `abandonPolicy: "award"`;
- any sanction;
- ~~a two-innings cricket win or draw.~~ struck by ruling 44 (W1-driving builds it: `streams/cricket.ts` two innings a side).

Forfeit and abandon are only ever sent straight after `core.start`, at 0–0. A W2 truth run without that task proves
only what the generators already reach, and every row above would read as untested, not as passing.

**5. The same audit before W3–W7.** Ruling 42 applies to every family wave. Before each of W3–W7 writes its plan,
the same engine → rulebook → generator audit runs for its rows. Its ABSENT list becomes that wave's binding
checklist.

**6. Audit items outside the 14/9/19 count.** Ruling 42 still owes each one an owning wave:

- **Goals boards (football, hockey, ice hockey).** `core.suspend` / `core.resume` has no row (`core/events.ts:76-98`;
  the audit's cross-sport table). → **W2**: a verdict row, or a named gap with its wave.
- **Football two-leg aggregate / away goals.** Format-level, not a match rule (audit, the football section).
  → **W4** (recommended; the controller's audit, not an owner ruling).

**7. From the W1c final review (2026-09-30).** Each is routed to W2 by name:

- **`outcomesFor` omits `abandon`** (`pad-adapters.test.ts`, T7 minor 4; final review m-14). W2's generator-breadth
  task adds a non-0–0 abandon, and the pad must then treat `core.abandon` as organiser-only, as it does forfeit.
- **Two value-constant mutants survive the pad unit suite** (T9–11 M-1; final review m-15): `pads/carrom.ts`
  `value: coins` → `9`, and `pads/boardgame.ts`'s method chip → a constant. The generators emit only 9 coins and
  only checkmate/agreement, so add one route case per adapter with a value the generator does not emit.
- **The tennis tie-break guard reads the cfg only** (`pads/tennis.ts:23-25`, T9–11 M-7; final review m-15). The
  product's `isTbShape` also refuses under `mtbTo !== null` and reads per-set rules, so the adapter would over-refuse
  a 7-6 set in an mtb or final-set-rule variant, by name.


### Mutation-debt exit gate (owner ruling MD-1, 2026-10-11) — binds W2b, W2c, W2d, W2e, W3, W4 and every later wave

Unnumbered on purpose: W2b numbers its rulings after 82 on its own branch, and a number here would collide.

**Why.** The first complete post-merge Stryker run (group=all, run 37957068135, main `a99147bd0`) listed about
5,750 survivors (Survived + NoCoverage) in pre-existing engine code. It is a floor: 9 of 81 legs hit their timeout
and wrote no report. A uniform 60-mutant sample (seed 20261010) classified read-only gave 19 real gaps, 18
equivalent, 15 unreachable (13 of them the `arbitraryEvent` test-data generators inside each sport module), 6
message-only and 2 counting artefacts. No live bug. Real gaps cluster in the non-sport modules (about 53% of their
survivors) against about 24% in `sports/*`. The per-family floors in `packages/engine/stryker-floor.json` already
stop the number growing; this gate is what makes it fall.

**The gate.** Before a wave merges, every Survived or NoCoverage mutant on an engine file the wave CHANGES gets one
class, and the wave's PR body carries the per-file counts and the file's score before and after:

- **A-real**: a user- or organiser-visible change no test catches. A killing test is owed, and its expected value
  comes from the rulebook or the engine's own declarations, never from the code under test.
- **A-msg**: only an error message or diagnostic changes; the code and behaviour do not. No test owed; one line in
  the PR body.
- **B-equivalent**: no observable change. Recorded in `packages/engine/stryker-equivalent.json` with a one-line proof.
- **C-dead**: unreachable from every production caller. The caller search is named.

Measure it with Stryker scoped to the changed files (`--mutate`), never a local group=all. CI's group=all after the
merge is the cross-check.

**Who owns which files.** A file goes to the wave that changes it. The one that merges first does the work, and a
later wave re-checks only lines it moves. W2b is the exception: it covers only its own lines (ruling 109 on W2b's
branch), and the older survivors in its files fall to the wave that owns the file below.

| wave | engine files with survivors |
|---|---|
| W2b (building) | only the LINES W2b adds or changes, measured with `--mutate` line ranges (W2b's own ruling 109, its owner, 2026-10-11). W2b also excludes the `arbitraryEvent` generators from mutation |
| W2c stage-level rules | `competition/stage.ts`, `competition/progression.ts` — W2c held 0 on this row and nobody owned it; routed to the mutation session (ruling 230, false premise E10) |
| W2d tables and tie-breaks | `competition/tiebreakers.ts`, `competition/points.ts` — done (W2d A20 and Task 20; the counts are in the decision log, 2026-10-20 → 2026-10-28) |
| W2e sport fidelity | the survivors on the LINES W2e changes in the sport modules and kernels, `stats/stats.ts`, `core/*` and `sport/module.ts` — done (W2e Task 25: the counts are in the decision log, 2026-10-28 → 2026-10-29). Amended by ruling 230 (W2e D10, 2026-10-28): W2e does not own the older survivors it did not touch |
| the mutation session (its own wave; not a prod gate, ruling 230) | every older survivor in those files that W2e did not change — including the 369 survivors (70 NoCoverage) on result-deciding paths (`size11b.json`, `ranges11b.txt` in the SDD directory) — plus MD-X1, MD-X2 and the `competition/stage.ts` and `progression.ts` row above |
| W3 Swiss | Swiss pairing under `scheduling/` |
| W4 knockout family | `scheduling/bracket.ts`, `scheduling/bracket-layout.ts` |
| no wave | `exports/*`, `import/*`, `officials/*`, `history/*`, `sport/registry.ts` (about 650 survivors): a standalone mutation-debt programme after the P0 pilot |

**In flight.**
- P0, branch `test/engine-mutation-debt-p0`: makes a test file that fails to LOAD under a mutant count as Killed.
  Today Stryker reports it Survived (sample row `cricket.ts:3417`). 2,897 of the survivors are static mutants, so
  until P0 lands, treat a static survivor as suspect. P0 also runs a timed pilot on `exports/build.ts` that measures
  cost per killed mutant.
- The "mutation" session owns the re-run of the 9 timed-out legs (`stryker-measured.json`, `stryker-timeouts.json`).
- W2b excludes the `arbitraryEvent` generators from what Stryker mutates (they live inside its files), so P0 does
  not touch `mutate`, the ignore lists or the disable comments.

## W1d first tasks (routed by the W1c final review, 2026-09-30)

The final whole-branch review (`fce1ccdbf..93eb5af0d`) routed each item below to W1d by name. The fix-now items
landed in `0532d0cb6`, `e431cbbce`, `80f370e9f`, `d5ce3e871`, `6e857491d` and `975f53b23`. The re-review's
I-2 fix is `f33c1b312`, and its docs minors are the commit after it.

1. **A new committed run adds its frozen plan.** `truth-runs/plans.lock.json` holds each committed run's plan,
   frozen when it was committed. committed-matrix judges every run against its entry, never against today's
   planners, and refuses a run that has none. The failure prints the entry to add. W1d's first planner change (the
   full-grid L1, 231 runs) therefore cannot re-judge W1c evidence (final review I-1).
   - **Review must read every `plans.lock.json` diff** (re-review m-b). An edit to an EXISTING entry that matches
     tampered evidence stays green: the re-review moved w1c-l2's `M1@390` from driven to planned in both the
     results and the lock, and all 29 tests passed. Such a tamper shows only as a lock diff. Treat a diff that
     edits an existing entry as a stop; a new run only ever adds one.
   — done in W1d T1 (`d77dd340f`, `5bbf22e70`): `matrix:lock-check --against HEAD^1` runs in `ci.yml`'s gates job; a removed or edited entry exits 1 and names the run.
2. **Record the scope in `plan`.** `--layer L1` meant "the slice at 1280" in W1c and will mean the grid after W1d.
   Record the scope explicitly, for example `--layer L1 (slice)` (final review §4).
   — done in W1d T3 (`c8c16717b`; the `scope` field is T2's `4495e9f2d`): `--scope grid`, and `results.json` records `scope`.
3. **A per-case planned marker** (m-6). `recordPlanned` writes an explicit marker, as an optional v3 field. Parity's
   `notDriven` keys on it, not on the LIFECYCLE mapping (`lib/parity.ts:184-188`), so parity on the API-only set
   stops reading its planned 🚫 rows as "missing". The same marker lets committed-matrix drop I-2's
   `durationMs === 0` heuristic. What it closes: a hand-flip of a driven case to ⏳/🚫 that keeps its duration and
   calls, with its fixtures and events zeroed, cannot be told from a real runtime ⏳/🚫 today. A flip that keeps
   fixtures or events already reds (`f33c1b312`), because the runner never writes that shape.
   — done in W1d T2 (`4495e9f2d`): `planned: true`. Parity and committed-matrix read one shared predicate (`isPlannedShape`, T4 `0bd5eb408`).
4. **`LayerCase.run` is an inert seam: record it** (m-7). Every case the layers build carries `run: null`
   (`layers.ts:105`, `:220`, `:255`, `:278`), and `run.ts` writes no `n` or `covers` into a result, so an L2 result
   cannot be mapped back to its committed `l2-pairs.json` run. Record `n` and `covers`.
   - **The premise changed in W1-driving** (Task 10's regen, `fe41d525a`). `l2-pairs.json` now holds 1,731 runs, and
     every `l3Gap` is null (`counts.json` `l2.l3GapRuns` 0). Run 514 is still `groups_ko|cricket|t20|M5@375`, but
     it carries no `l3Gap` now: ruling 44's cricket tie stream removed the M5 harness gap that marked it. If a later
     regen marks a run `l3Gap` again, its result must say that this run is the pair's only coverage.
   — done in W1d T2 (`4495e9f2d`): `l2 {n, covers, l3Gap}` on every L2 result, written through the real `runSlice`.
5. **`NoLayerForWidth` must exit 2 (a refusal), not 3** (m-3; T12). It was thrown inside `execute` and was not in
   `refused`, so it exited 3. It cannot be reached today (`BROWSER_WIDTHS = [1280, ...L2_WIDTHS]`). It is now in
   `refused` and exits 2; a counted guard test pins that every accepted width has a layer, so the first width
   added without one reds by name.
   — done in W1d T5 (`fd096b86d`): a refusal, exit 2. It is unreachable through today's CLI, so this is a defensive classification, not a user-visible symptom.
6. **One exit convention for unreadable input** (m-2). parity maps a missing file, bad JSON or a schema refusal to
   3; render maps the same class to 2. By the controller's ruling this is not changed in W1c: the W1d CI wrapper
   settles one convention.
   — done in W1d T6 (`04d552158`, `68952362e`, `3e837e134`): one declared table (`lib/exit-codes.ts`) pinned against every CLI header. parity, findings-table and draw-counts moved to 2 for unreadable input.
7. **Typecheck `scripts/**/__tests__` in CI, with `vitest` resolvable** (m-4; T6/T8). `tsconfig.scripts.json`
   excludes `*.test.ts`. The three W1c test-file errors are fixed (`80f370e9f`). What remains is 5 errors in
   `scenarios.test.ts` that predate W1c. Test files that import apps/web also drag apps/web's `queue.ts` nodenext
   errors into a test-inclusive program (the "noisy scoped tsc").
   — done in W1d T10 (`02f67dbbc`): `tsconfig.tools-tests.json` (bundler resolution), `vitest` as a root devDependency, a `typecheck:tools-tests` script, and the 3 + 5 test-file errors fixed. The 18 apps/web errors were nodenext-only artefacts (0 under bundler). Bench's tests stay out: see "Recommendations", the bench carry.
8. **The pad replay's unwitnessed guards** (T7 minors 5, 6, 7 and 9; m-14):
   - `pad-replay.test.ts` asserts only budget constants for the replay's wait;
   - the fake ledger holds no rows at or below the server tip;
   - no test reaches the unseated-fixture guard in `browser-driver.ts`;
   - `padCheck` caps evidence at 12 lines with no "+N more". Hockey pad proof sits at exactly 12 fallback notes,
     and `_INDEX`'s per-adapter split was read from those lines.
   — done in W1d T12 (`88c5755a4`): witnesses for the ledger-tip guard and the unseated-fixture guard (both behaviours existed, so they are proved by mutation, not by a red), the replay's wait now exercised through a clock-owned fake page (item 15a's tap timings), and `padCheck` keeps 12 lines and appends `+N more` (the one code change).
9. **Pad adapter minors** (T9–11; m-15):
   - M-4: cricket's module-level `tapped` state. Document `MatrixPadAdapter.stepsFor` as one-shot per event.
   - M-8: pin the carrom coin bound (`max: 9`).
   - Mn-1: the `period.ts` `Number.isInteger` mutant.
   - Mn-2: `replay.ts:103`.
   — done in W1d T12 (`88c5755a4`): cricket's `tapped` state is per adapter, the carrom coin bound is pinned, `period.ts` and the judge's no-note refusal have their witnesses.
10. **Parity's `quiet` rule** (m-16; T13). It misses a browser error red that kept its checks (noise rows only; the
    verdict is unaffected), and its `h.state !== b.state` conjunct is unkilled.
   — done in W1d T13 (`2302843c0`). The premise was false at HEAD (`quiet` already lists the check rows), so both conjuncts are now pinned, with no production change.
11. **The playwright scan spellings** (m-17; T4 M-2/M-3). The scans match `spec === "playwright"` only, and the
    `FLAT` scan misses `setDefaultTimeout(<literal>)` and sleeps. No violation exists at HEAD.
   — done in W1d T13 (`2302843c0`): the playwright scans see every spelling, and the flat-wait scan sees `setDefaultTimeout(<literal>)` and sleeps.
12. **A run id reused with another `--report-dir` on the same DB** (m-18; C-1). Every case reds on an unnamed
    duplicate-slug error, because `RunIdReused` checks only the report directory.
   — done in W1d T5 (`fd096b86d`): a run id the DB already holds is refused up front by name (`RunIdUsedInDb`, exit 2).
13. **Page objects' first-control choice** (T8 m-2). Accepted; revisit only if W1d's full-grid L1 shows a hydration
    red.
   — accepted (item 13). No code. Revisit only if the full L1 shows a hydration red or a first-control red (PR-B triage rule T-H).
14. **Per-case `layer`** is written but read by no production code. Pad proof at 320 records `L2` (the width band),
    so do not shard or count "L2" by this field without knowing it includes pad-proof runs (final review §4).
   — done in W1d T2 (`4495e9f2d`, the field's contract) and T4 (`0bd5eb408`, the merge reads `case.layer` and refuses a shard of another layer).
15. **Also routed to W1d above:**
    - F-PP-1 and pad proof's missing single-sport scope: **done in W1d T12 (`88c5755a4`)**. Tap timings ride every wait timeout (15a), and `--set pad-proof --only league|<sport>` is the single-sport scope (15b). The local trace was dropped, with its reason (D16, T13 `7ecabf2ea`: it needed five production files across three layers and could be proved only against a fake);
    - the match-day run sheet, never driven: **done in W1d T14 (`c2f7cf699`, evidence `86af851a1`)**, the `match-day` set at 1280 and 320 (15c);
    - the sweep's fold branch, not recorded: **done in W1d T14 (`c2f7cf699`, `86af851a1`)**, the `fold-branch` check at 1280 and 320 (15d);
    - void, never driven in any browser run: **done in W1d T14 (`c2f7cf699`, `86af851a1`)**, `voidLast` and the `void-proof` set (15e). HTTP `voidLast` and the browser's later-void branch have no production caller yet (PR-B carry);
    - forfeit and withdraw on league and knockout cells in the browser (carry 8): **done in W1d T14 (`c2f7cf699`, `86af851a1`)** at 1280, the `carry8-1280` set (15f). The phone half was already in the full-grid L2 (runs 408, 64, 417 and 73).

**Added by W1-driving (Task 16, 2026-10-01).** Each item below is routed to W1d by name:

16. **Cricket pad adapter routes for the two-innings events** (D13, ruling 52). These are `cricket.followon`,
    `cricket.match.close` and a declared innings. `pads/cricket.ts:66` refuses `inningsPerSide` 2 by name, and
    `pad-adapters.test.ts` sweeps single-innings requests only (Task 10). Until the routes exist, the 24 cricket
    `test` cases are proven over HTTP only.
   — done in W1d T12 (`88c5755a4`, `f3f1c405e`): the cricket pad takes one or two innings a side, and `--set pad-innings` is the plan that reaches it (proved live on a plain `test` case, and on a model pad). **Not routes:** follow-on and `match.close` are rows of the generic More sheet with no testid, so they are declared `noControl` and routed to W2. The 24 committed `test` cases stay `no_path` in the browser (their rule overrides).
17. **Browser workers inside a shard** (D10, ruling 46). `--driver browser --workers 2` was a usage error that
    named W1d (`BROWSER_WORKERS`). W1d declined them for good (D11): it is still a usage error (`run.ts:633`), and
    now says "one browser case at a time per shard; parallelism is the shard matrix". No route names W1d any more.
   — done in W1d T13 (`003a0c6c2`): declined, with the reason in the message (D11). The recommendation to the owner is under "Recommendations".
18. **`MAX_WORKERS` inside a shard** (Task 11). It is 8, the local-env bound (`lib/workers.ts`; the prod DB
    budget note is 60 connections), and it STAYS 8 (D11): browser shards run one case at a time and parallelism
    is the shard matrix. Provisions take one run-wide turn each, because the staff flag and the sign-in links are
    per user. A cheaper entitlement bust, or a dedicated synthetic owner per shard, would be what lifts that cap;
    raising it is a decision, not a drift (`workers.test.ts` pins the comment's words).
   — done in W1d T13 (`003a0c6c2`, `f9fab930a`): `MAX_WORKERS` stays 8 (D11).
19. **One sign-in budget per shard under Redis.** No `--workers` refusal. See "Recommendations": with `REDIS_URL`
    set, the sixth magic-link sign-in from one IP inside 300 s answers 429.
   — done in W1d T9 (`ce85ff9cb`, D12): `matrix-truth.yml` declares no `redis` service and sets no `REDIS_URL`, and a test pins both. Each shard is its own runner with its own source IP.
20. **Templates in the grid.**
    - The W1d grid must pass the template for an ad-hoc `--driver browser --only <template cell>`, which fails by
      name today (Task 13).
    - Template competitions are created **public**: the gallery sends no visibility, and the schema defaults to
      `public`. A shard that reuses an org must allow for its public quota.
   — done in W1d T13 (`3582cbef6`): a plain browser plan reaches the template cells through their gallery cards (the cricket `test` cases keep their overrides and stay out), one org per case.
21. **Record the filler counts in `results.json`.** `filler` appears 0 times today, so the live filler proof is
    indirect, and the counts are proven only in unit tests (Task 13; `truth-runs/w1drv-l1/README.md`).
   — done in W1d T2 (`4495e9f2d`): `fillers` per case, non-zero names only, read before the browser closes so an error-red case keeps what it ran.
22. **A knockout-completion shot on multi-stage L1** (`truth-runs/w1drv-l1/README.md` (d)). The `groups_ko` case's
    `08-completed` is the group stage's completion, taken with the knockout's proposal pending. No check misreads
    it.
   — done in W1d T13 (`e2a4bb153`): a completion shot is named for its stage's place, and the LAST stage's completion is taken in the browser (naming alone would have left it over HTTP). The live behaviour is for the PR-B L1 run to show.
23. **Name team entrants "Matrix Team N", not "Matrix Player N"** (`truth-runs/w1drv-l1/README.md` (e)). This is the
    house constraint, and no check depends on it.
   — done in W1d T13 (`c4e57479c`): entrants follow the entrant kind from the engine module's declaration.
24. **Cosmetic: the americano policy note prints a team entrant's whole roster** ("of <id>+<id>+…", Task 15).
   — done in W1d T13 (`c4e57479c`): the americano policy note counts persons and prints no roster.
25. **Item 12 again, on the model CLI** (Task 16). A model run id reused against the same DB, after its report
    directory was removed, aborted on `organizations_slug_key` instead of refusing up front by name.
   — done in W1d T5 (`fd096b86d`): the model CLI refuses a reused run id up front, by name.
26. **Two committed cases that share cell, check and match make an exploring run's fence rule blind** (Task 16
    re-review 1). MB-007 and MB-010 share all three, so the narrowed-fence run (`w1drv-t16fr1-model-de`) labelled
    the new withdrawn-trigger failure `known: MB-007` and exited 0; MB-010 was found only by reading its commands.
    "A fence guards only what a committed case shows, else the bug reports NEW" does not hold for such pairs: make
    the matcher (or the exploring run's report) distinguish cases by their shown trigger, not only cell/check/match.
   — done in W1d T13 (`7ecabf2ea`): MB-007 and MB-010 each carry a `trigger` (withdrawn, added), and the matcher and the replay tell them apart by it (the loader refuses an ambiguous pair that lacks one).
27. **CI truth runs: artifacts weekly, a triaged baseline committed** (ruling 58, clarified 2026-10-04). The matrix
    runs itself, weekly and on dispatch, sharded on fresh databases. A weekly run keeps its results as CI artifacts;
    only a triaged baseline is committed to `truth-runs/`. The trigger must NOT be GitHub `schedule:`, which drops
    and delays runs.
   — done in part in W1d T8 and T9 (`b1b0d0dca`, `3cd5dfb11`, `ce85ff9cb`, `e5afff3e6`, `998b385bb`, `38c8b55b5`): `matrix-truth.yml` (weekly, dispatch, self-proof), shards, merge, judge, summary and the staleness signal. Weekly runs keep artifacts only. **The triaged baseline is PR-B's** (Tasks 17–22), and the schedule ships disabled (D2).
28. **Close the `tools/` import guard's spawn-by-path blind spot** (bench-move review M2, PR `chore/bench-to-tools`;
    owner 2026-10-04, asked in the controller's session whether to add it to W1d's list: "ok"). The guard reads imports,
    manifests, tsconfigs and root-script names, but not a `tools/` path passed as a string to `child_process`. Flag
    string literals passed to `exec`/`execFile`/`spawn`/`fork` and their `Sync` forms under `apps/`, `packages/` and
    `scripts/` whose path-like tokens resolve into `tools/`. Exempt the reference trap fixture and the guard's own
    tests by name, never by pattern. Needs a positive control and a non-zero scanned count. W1d builds it because W1d
    adds scripts that spawn the matrix.
   — done in W1d T11 (`b6de52dba`, `b8700d19e`): the guard reads `child_process` call arguments, with a positive control, a non-zero scanned count (387 calls in 170 files), per-name floors and an importers oracle. Zero hits on the real tree. Stated gaps (package-name spawn, a variable-held path, `execa`, aliased and promisified spawners) are pinned as known gaps: see the "Limit" note under ruling 56.

## W1d dispatches (Task 17, 2026-10-05)

Tag `matrix-truth/w1d-baseline` = `47f210e3f2094405e4ed4c8b5c9ea6bd2a6085d9` (PR-A's merge). The tag push started no
workflow. `vars.MATRIX_RUNNER` is unset at repo level; org-level variables are not readable with this token, so the
guard run's log is the authority (it shows no self-hosted line). Dispatched one at a time, each after the previous
run's `status` was `completed`. Every judge call used `--planned-not-run allow` (ruling 65).

| # | run | scope | conclusion | jobs | wall (UTC) | L1 | L2 | L3 | `judge faults` |
|---|---|---|---|---|---|---|---|---|---|
| guard | 37341071590 | full, `inject_visibility=private` | failure at "Visibility guard" (expected) | plan failed; build, shards, merge skipped | 16:28–16:28 | — | — | — | — |
| 1 | 37341165564 | full | success | 15 (0 cancelled) | 16:29–16:48 | 155 ✅ 23 ❌ 53 🚫 | 40 ✅ 22 ❌ 164 🚫 1505 ░ | 772 ✅ 165 ❌ | 0 / 0 / 0 |
| 2 | 37343825825 | full | success | 15 (0 cancelled) | 16:49–17:07 | same as 1 | same as 1 | 773 ✅ 164 ❌ | 0 / 0 / 0 |
| 3 | 37346206686 | full | success | 15 (0 cancelled) | 17:08–17:28 | same as 1 | same as 1 | 773 ✅ 164 ❌ | 0 / 0 / 0 |

Case counts equal ruling 64's plan sizes (231, 1731, 937). Shards: L1 8, L2 2, L3 2.

**Verdict (ruling 61, `judge across`):** L1 exit 0 (231 compared, 0 differing, 0 faults); L2 exit 0 (1731, 0, 0);
L3 exit 1 (937 compared, 3 differing, 0 faults). The three differing cases, by run: football red/works/red, carrom
red/works/works, generic works/red/works. Across all three runs `swiss_knockout` R4 is red in boardgame and hockey
every time and works in the other six sports every time. Owner ruling 70 accepts harness-green with those three
named exceptions.

**Step 6 (false premise 17).** Nothing fires on a schedule yet: `vars.MATRIX_WEEKLY_ENABLED` is unset. Task 22 Step 3
reads the first scheduled run's event payload.

**W2a final truth run (W2a Task 16, 2026-10-09) counts as a weekly run.** `MATRIX_WEEKLY_ENABLED=true` has been set
since 2026-10-08, and the W2a dispatch is a full matrix truth run on the branch: run 37916609028, `workflow_dispatch`,
`headSha` `e45d74203`, 10:16–10:35 UTC, conclusion success, 15 jobs (L1 8, L2 2, L3 2 shards). It found
L1 167 ✅ 11 ❌ 53 🚫, L2 43 ✅ 19 ❌ 164 🚫 1503 ░, and L3 819 ✅ 118 ❌, with harness faults none. Evidence:
`truth-runs/w2a-final/`.

## W1d truth-run backlog (baseline `47f210e`)

Generated by `pnpm matrix:backlog` from the committed baseline and the triage catalogue, and held to them by `tools/matrix/__tests__/w1d-backlog-index.test.ts`: the tables below are data and are never edited by hand. Each wave starts from the ❌ cases of its table and from the audit ids the baseline never drove. The ❌ list is a floor, not the whole backlog (design §8): an audit id in a not-exercised table is owed a scenario by its wave before the wave can call it closed.

`(+N also)` in a cases cell: N further cases, keyed to another gap and counted once there, that also fail one of this gap's checks. The example cases are the first case of each layer the gap has, then the rest in plan order, up to five. `TRIAGE.md` lists every case and `AUDIT-LEDGER.md` the evidence of every id (both in `truth-runs/w1d-baseline/`).

The baseline is the merged run of each layer (L1 `ci-37346206686-1-l1`: 231 cases, 23 ❌; L2 `ci-37346206686-1-l2`: 1,731 cases, 22 ❌; L3 `ci-37346206686-1-l3`: 937 cases, 164 ❌). The triage read 2,899 cases and keyed 209 ❌ to 12 gaps; the ledger holds 150 audit ids, 106 of them `not-exercised`.

What the ❌ count leaves out, counted from the same three runs. ░ (planned, never driven): L2 1,505; ruling 65 keeps these as backlog, not as reds, and the count shrinks as the waves add scenario scripts. 🚫 (no organiser path): L1 53 and L2 164, 217 in all; each is routed to a wave by its own reason and counted in that wave's section. Held red by ruling 70 only inside `judge regression`: `swiss_knockout|carrom|club-29|R4` and `swiss_knockout|generic|score|R4` (2 cells, `works` in the committed L3); `judge regression` reads the L3 baseline only, so with them it holds 166 red cases, not the 164 of the committed L3.

Regenerate (`$OUT` is any empty directory): run the triage command of `truth-runs/w1d-baseline/README.md`, "Reproduce", into `$OUT`, then

    pnpm matrix:backlog --triage $OUT/triage.json --sha 47f210e --out $OUT/backlog.md

A test runs both commands as printed and requires the result to equal this section.

| wave | name | gaps | ❌ cases | audit ids | reproduced | exercised-not-reproduced | not-exercised | verified-by-read | verified-by-failing-test |
|---|---|---|---|---|---|---|---|---|---|
| W2 | sport scoring fidelity | 2 | 77 | 54 | 2 | 0 | 42 | 10 | 0 |
| W3 | Swiss | 1 | 3 | 32 | 1 | 0 | 20 | 11 | 0 |
| W4 | knockout family | 4 | 41 | 9 | 2 | 0 | 6 | 1 | 0 |
| W5 | round-robin family | 2 | 17 | 19 | 1 | 0 | 13 | 5 | 0 |
| W6 | double elimination | 0 | 0 | 4 | 0 | 0 | 1 | 3 | 0 |
| W7 | americano, mexicano, ladder | 3 | 71 | 8 | 1 | 0 | 2 | 5 | 0 |
| W8 | scorer sheets | 0 | 0 | 20 | 0 | 0 | 19 | 1 | 0 |
| W9 | operational [O] | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| W10 | sweep | 0 | 0 | 4 | 0 | 0 | 3 | 1 | 0 |

### W2 — sport scoring fidelity

The ledger holds 54 audit ids for W2: 2 reproduced, 0 exercised-not-reproduced, 42 not-exercised, 10 verified-by-read, 0 verified-by-failing-test.

🚫 21 planned cases have no organiser path and route to W2 by their own reason (L2 21); the baseline never drove them, so they are in no table below.

| gap | title | cases | layers | examples |
|---|---|---|---|---|
| SC-O1 | A drawn knockout game is accepted as final. No tiebreak mechanism exists (no armageddon, rapid tiebreak or mini-match), the bracket seats… | 65 | L1, L2, L3 | `league_ko\|boardgame\|blitz\|LIFECYCLE@1280`, `league_ko\|boardgame\|blitz\|R4a@768`, `league_ko\|boardgame\|blitz\|LIFECYCLE`, `groups_ko\|boardgame\|blitz\|LIFECYCLE@1280`, `group_stepladder\|boardgame\|blitz\|LIFECYCLE@1280` |
| SC-O2 | `supportsDraws` is a deny-list that misses `page_playoff` (a bracket kind) and `ladder`. A draw there passes the KO guard and stalls | 12 | L1, L3 | `group_playoffs\|generic\|score\|LIFECYCLE@1280`, `group_playoffs\|generic\|score\|LIFECYCLE`, `swiss_playoff\|generic\|score\|LIFECYCLE@1280`, `group_playoffs\|generic\|score\|M1`, `group_playoffs\|generic\|score\|R4` |

Audit ids no baseline case drives (`not-exercised`, 42): each is owed a scenario before W2 can close it.

| id | severity | title |
|---|---|---|
| FX-G23 | L | Overrides are limited to 4 sets sports (owner D2a). Squash/pickleball/padel-style and non-sets sports can't vary Bo per stage. |
| SC-X3 | M | An abandoned knockout match is left stuck by owner ruling, with no first-class event to settle it by lot, higher seed or bowl-out. The only… |
| SC-S1 | M | Set-summary validator accepts impossible games scores in a tie-break set: 8–6, 9–7 (TB at 6–6) and 5–3 in Fast4 (TB at 3–3). `wasLive`… |
| SC-S2 | M | Bo1 with deciding set "Match tie-break to 10/7" (or "tie-break to 10") turns the whole single-set match into a match tie-break (the only set… |
| SC-S4 | M | Retirement mid-match is recorded as `core.forfeit` with a free-text reason defaulting to "walkover"; the ledger keeps only the partial… |
| SC-S5 | L | A match tie-break (App VI decider) contributes 0 games to games_won/games_lost; ITF convention counts it as one game (and one set) to the… |
| SC-S6 | L | No double-forfeit / double-walkover: `CoreForfeit` takes one `by`; set-based and nested kernels throw on `no_result`/`draw`. A both-no-show… |
| SC-S7 | L | Tennis emits no `points_lost` metric; a division whose custom cascade includes `point_ratio` (keys are validated globally, not per sport —… |
| SC-S8 | L | Award metrics are untested: the only forfeit standings test asserts match points `[3,0]` and nothing about sets/points credited, so S3/S4… |
| SC-S9 | L | A group stage overridden to best of 3 on a FIVB-points division (`{"3-2":[2,1],"*":[3,0]}`) pays 3–0 for a 2–1 win via `"*"`; the pointsMap… |
| SC-P3 | M | No "repeat sudden-death OT periods until a goal" playoff mode. `overtime` is one sudden-death period or a fixed count, and a level OT with… |
| SC-P4 | M | The shoot-out points split (`points.shootoutWin/Loss`) is editable for football only. Turning "Shoot-out on a draw" on for FIH hockey in the… |
| SC-P5 | M | A shoot-out-decided match is always recorded won 1 / lost 1 in the table, and a draw-with-bonus is not configurable. The FIH test is titled… |
| SC-P6 | L | The test "keeps regulation points in knockout but honours the group SO split" folds the knockout case with a cfg that has no split, so it… |
| SC-P8 | L | Stage decider overlay keys from API v1 are `z.unknown()` and never validated against the sport schema at stage create. `extraTime` does… |
| SC-P9 | L | Abandon under `abandonPolicy: "award"` with a level score gives `no_result`. The knockout guard checks only `kind === "draw"`, and… |
| SC-P10 | L | A stage `PointsRule` (API only) re-derives points from won/drawn/lost only. It has no OT-loss or SO bonus kind, so ice hockey's 3-2-1-0… |
| SC-P11 | L | No futsal preset: no accumulated fouls, 5-a-side default, or second-mark kicks. The closest is `small-sided` (7-a-side, 2×20). |
| SC-P12 | L | "Result only" (band 0) still needs start, every goal, the HT/period markers and FT. There is no one-shot final-score entry. The period… |
| SC-P13 | L | `supportsDraws` is false in `ladder`, `double_elim`, `stepladder` and `page_playoff`, so a level ladder challenge is refused unless a… |
| SC-C3 | M | NRR for a DLS or revised-overs result does not follow ICC: Team 1 is not credited with (target − 1) runs off Team 2's revised overs, or with… |
| SC-C4 | M | Coarse innings summary: no upper bound on runs and no chase-overshoot check. A chase summary can pass the target by any amount, and the… |
| SC-C5 | M | No test covers NRR operands for DLS or revised-overs matches, or refusal of a knockout tie or no_result |
| SC-C6 | L | Coarse `boundaries` is accepted by the schema, but no pad path produces it: neither the over sheet nor the "Innings total" action has the… |
| SC-C7 | L | The "Overs per innings" editor writes `ballsPerInnings = overs × 6` whatever `ballsPerOver` is, and the NRR display hardcodes 6 balls per… |
| SC-C8 | L | A super over is band 3 only. A result-only (band 0) scorer whose knockout ties must switch the recording band before a super-over tile… |
| SC-O3 | M | In a KO stage with `allowDraws` on, the pad offers Draw / a level settle (cfg-only), and the server refuses with shootout/extra-time advice… |
| SC-O4 | M | Under `tieBoard:"draw"` (division-wide), a level KO match cannot be finished. The last board's append is refused, there is no stage-level… |
| SC-O6 | M | There is no result-only (band 0) entry at game or match level: band 0 is the per-board summary. Paper results must be re-keyed board by… |
| SC-O8 | L | No per-stage format override ("final is best of 5"). Per-stage rules are sets-sports only |
| SC-O9 | L | `carrom.game.adjust` has no upper bound on `delta`, so an adjustment can put a game score far past `gameTo` |
| SC-O10 | L | Result method and winner are not cross-checked (a decisive "stalemate", or a drawn "checkmate"). Only the pad's two action lists keep them… |
| SC-O11 | L | The 500 score cap is pad-only; the engine accepts any non-negative int |
| SC-O12 | L | Team chess (board points such as 2½–1½, match points) is unsupported: entrant kinds are individual only |
| ST-G8 | M | A stage PointsRule (bonus points, forfeit points, awarded walkover score, no-result bonus) has no UI. It is reachable only via API/templates… |
| ST-G9 | M | `applyPointsRule` forces `no_result` to 0 (bonus aside). A cricket tie has `drawn:0` (`ties` metric only), so under any rule it scores 0 and… |
| ST-G10 | M | The cascade is division-level only (no per-stage). It has no editor UI (console shows it read-only, `o/.../page.tsx:899`). `validateCascade`… |
| ST-G11 | L | UEFA recursive h2h is unreachable: web never sets `h2hRecursive` (`toTableStage` omits it). `h2h_scope:"overall"` is API-only and its wiring… |
| ST-G16 | M | OT/SO wins and losses fold into W/L with different points. There is no OTW/OTL (or SOW/SOL) column. |
| ST-G29 | L | `game_ratio` decides ties but has no derived column (`DERIVED_METRICS` omits it). The set-ratio header is the bare word "Ratio". |
| ST-G31 | M | Default cascades diverge from federation rules: BWF uses matches won, then h2h for 2-way ties and game/point difference for 3+; ITTF uses… |
| ST-G32 | M | No table-ORDER test for tennis `game_ratio`, table tennis, or cricket NRR folded from real deltas. Cricket NR points and football abandon… |

- **SC-P4 and the prompt's trap 2 contradict each other (false premise 20)** — `W2-scoring-fidelity.md` trap 2 names SC-P4 as the model of a collectable field that loses to the engine: "the declared 3/0 loses to the FIH 2/1 the rulebook adopts (§7.1), so the case is ❌ until fixed". Two other sources say otherwise. The SC-P4 entry of "False premises found" in this file: "FIH 2/1 shoot-out split" is the FIH Pro League rule only; FIH tournament regulations use 3/1/0 with draws standing and no pool shoot-outs, which the product already does by default, and the gap narrows to "no points fields when shoot-outs are switched on". And design §8's row for this wave: "FIH 2/1 is Pro League only". The goals-and-boards rulebook's RB2B-7 recommends seeding 2/1 when shoot-outs are on for a table stage, but that rulebook says "None is a ruling", and at W1d no entry of this file's "Owner rulings" signed it. The baseline cannot settle it: the ledger reads SC-P4 `not-exercised`: Shoot-out points split editable for football only: a match-rules editor limit; no scenario edits a division's match rules through the editor (D6/D7 change a stage's shape or rules). The planner of this wave resolves which oracle the SC-P4 case takes, with the rulebook's sign-off, before the case is written; a case written from the trap alone asserts a split the other two sources call a Pro League rule. This is false premise 20 of the W1d plan, and not W1d's to fix. W2d settled both at its fold (2026-10-28): owner ruling 186 (W2d D10(f), 2026-10-20) makes the FIH default 3/1/0 with draws the SC-P4 oracle and tests the shoot-out case on the 3/2/1/0 preset, and ruling 189 (W2d B2) signs RB2B-7: a shoot-out is a draw plus a bonus to its winner.
- **swiss_playoff R4 cells the committed run keys to this wave** — The committed run keys these swiss_playoff R4 cells to this wave: SC-O1 (`swiss_playoff|boardgame|blitz|R4`) and SC-O2 (`swiss_playoff|generic|score|R4`). Their reason is not stable: it flips between the stall and SW-H1 across the dispatches (the W3 carry "The swiss_playoff R4 reason flip: red in all three dispatches, two reasons" lists the reason per dispatch). Read them there before counting a move in SC-O1 and SC-O2 as progress or as a regression: a drop here that comes with a matching rise under SW-H1 is the reason flipping, not a fix.

### W3 — Swiss

The ledger holds 32 audit ids for W3: 1 reproduced, 0 exercised-not-reproduced, 20 not-exercised, 11 verified-by-read, 0 verified-by-failing-test.

No 🚫 case routes to W3 by its own reason.

| gap | title | cases | layers | examples |
|---|---|---|---|---|
| SW-H1 | Pairing can dead-end, and Pair next then reports success. | 3 | L3 | `swiss_playoff\|hockey\|fih-outdoor\|R4`, `swiss_knockout\|football\|11-a-side\|R4`, `swiss_knockout\|hockey\|fih-outdoor\|R4` |

Audit ids no baseline case drives (`not-exercised`, 20): each is owed a scenario before W3 can close it.

| id | severity | title |
|---|---|---|
| FX-G13 | M | Rebuild deletes in one committed transaction, then regenerates in another. If regeneration throws (custom `byes` count now wrong,… |
| ST-G21 | M | Columns are hand-picked: no sport metrics, NRR, set ratio or Buchholz (only Pts ratio since #884). D is always shown. Rows cut at 10 with no… |
| SW-M2 | Med | Undo of "Pair next round" does nothing |
| SW-M3 | Med | An ad-hoc match gives everyone else a phantom bye |
| SW-M4 | Med | Ad-hoc fixtures break the shell model in other ways. |
| SW-M5 | Med | Unpair can clear an ad-hoc fixture |
| SW-M7 | Med | A bye never freezes `config_snapshot` |
| SW-M9 | Med | No double walkover. |
| SW-M11 | Med | Pairing groups ignore the table's points. |
| SW-M12 | Med | The roster-drift panel's Rebuild wipes the Swiss schedule |
| SW-M13 | Med | A bye shell can be scheduled onto a court. |
| SW-L1 | Low | A two-sided walkover or forfeit enters Buchholz and SB as a played game against the real opponent. FIDE C.07 (2023) treats it as unplayed,… |
| SW-L2 | Low | The virtual-opponent formula assumes half-point scoring (`+1 per remaining round`). It is mis-scaled for any non-boardgame points rule that… |
| SW-L6 | Low | An unseeded round 1 folds by registration order (`order by seed nulls last, created_at`). There is no random-draw option. |
| SW-L7 | Low | No late entry after Start: enrolment is locked on `active`. |
| SW-L8 | Low | Surplus boards are deleted from the highest `seq_in_round` down, so a board with a pinned time can be removed while an unscheduled one… |
| SW-L9 | Low (test) | The engine property test "no rematch ever" passes on an empty round. No test asserts every round is fully paired, and none covers a greedy… |
| SW-L10 | Low (test) | No browser e2e drives a Swiss to completion and into its knockout cut. Swiss specs cover shells, legend, round-1 pick and pre-Start field… |
| SW-L11 | Low | Public surfaces have no Swiss-specific state (no "Round X of N", no "pairings announced after round N-1"). Nothing in `server/public-site`… |
| SW-L12 | Low | No pairing preview or manual board swap for rounds 2+. Only round 1 has a hint (`roundOnePairs`). |

- **Owner ruling 70: three cells held red, and the re-baseline that retires the hold** — Across the three dispatches the cells `swiss_knockout|football|11-a-side|R4`, `swiss_knockout|carrom|club-29|R4` and `swiss_knockout|generic|score|R4` flipped between works and red. Every red reads "round 5 paired nobody (SW-H1)", and the cause is the product's `lots` tiebreak (a UUID-hashed draw, by design) exposing P6 (SW-H1: an empty Swiss round reported as success). Ruling 70 (2026-10-05) records the three RED, cause P6, whatever the baseline run showed: the `ruling70` block of `catalogue/baseline.json`, applied by `judge regression`. **The SW-H1 fix must remove that block and `RULING_70_IDS` (`lib/pr-sample.ts`) and re-baseline L3 in the same change** (`W3-swiss.md`, "Output and handoff"). The guards that notice a stale block fire at the re-baseline, not when the fix merges, so a fix merged alone leaves the override live, where it can hide a regression on those three cells only. In this baseline SW-H1 is keyed on 3 cases of the committed run (`swiss_playoff|hockey|fih-outdoor|R4`, `swiss_knockout|football|11-a-side|R4` and `swiss_knockout|hockey|fih-outdoor|R4`), of which `swiss_knockout|football|11-a-side|R4` is one of the ruling's cells. The ruling's other 2 cells (`swiss_knockout|carrom|club-29|R4` and `swiss_knockout|generic|score|R4`) are `works` in the committed run: the triage counts none of them, and only `judge regression` holds them red until the re-baseline.
- **Recommendation (the controller's, not an owner ruling): move P6 up** — Within this wave, take SW-H1 (P6) early: a real Swiss-into-knockout after a withdrawal can strand on an empty round 5 that says it succeeded. This is the controller's recommendation, as owner ruling 70's entry words it; the owner has not ruled on it.
- **The swiss_playoff R4 reason flip: red in all three dispatches, two reasons** — `swiss_playoff|boardgame|blitz|R4` and `swiss_playoff|generic|score|R4` are red in all three dispatches with the same failing checks, but the reason flips: dispatch 1 SW-H1, dispatch 2 stall, dispatch 3 stall. SW-H1 is `round 5 paired nobody (SW-H1)`; stall is `stage 2: did not complete`, the drawn-game stall. The triage separates the two by reason, so the committed run (dispatch 3) keys them to SC-O1 (`swiss_playoff|boardgame|blitz|R4`) and SC-O2 (`swiss_playoff|generic|score|R4`). The SW-H1 fix does not turn these cells green: the stall reason stays with the gap that owns it, and a re-baseline that reads the SW-H1 reason on them again moves them back to SW-H1.

### W4 — knockout family

The ledger holds 9 audit ids for W4: 2 reproduced, 0 exercised-not-reproduced, 6 not-exercised, 1 verified-by-read, 0 verified-by-failing-test.

🚫 100 planned cases have no organiser path and route to W4 by their own reason (L1 33 and L2 67, 100 in all); the baseline never drove them, so they are in no table below.

| gap | title | cases | layers | examples |
|---|---|---|---|---|
| FX-G14 | The plate draws `roundLosers(round 1, count q)`, but a seed proposal requires the source stage COMPLETE, so the plate cannot start until the… | 11 | L2, L3 | `ko_plate\|hockey\|fih-outdoor\|F1@320`, `ko_plate\|football\|11-a-side\|F1`, `ko_plate\|cricket\|t20\|F1`, `ko_plate\|carrom\|club-29\|F1`, `ko_plate\|generic\|score\|F1` |
| FX-G7 | Withdrawal puts page_playoff in the "open formats: remaining games void" branch, not walkover (`BRACKET_WALKOVER_KINDS` excludes it). The… | 12 | L2, L3 | `page_playoff_only\|football\|11-a-side\|R4a@360`, `page_playoff_only\|football\|11-a-side\|R4`, `page_playoff_only\|cricket\|t20\|R4`, `page_playoff_only\|boardgame\|blitz\|R4`, `page_playoff_only\|carrom\|club-29\|R4` |
| NEW-W1d-3 | stepladder: withdrawing an entrant is refused 422 WRONG_PHASE (every game after the first has a TBD side) | 12 | L2, L3 | `stepladder_only\|football\|11-a-side\|R4a@375`, `stepladder_only\|football\|11-a-side\|R4`, `stepladder_only\|cricket\|t20\|R4`, `stepladder_only\|boardgame\|blitz\|R4`, `stepladder_only\|carrom\|club-29\|R4` |
| NEW-W1d-4 | no division-builder control builds knockout_third_place, page_playoff_only or stepladder_only | 6 (+2 also) | L2 | `knockout_third_place\|football\|11-a-side\|R4a@320`, `knockout_third_place\|football\|11-a-side\|M1@360`, `page_playoff_only\|football\|11-a-side\|M1@375`, `stepladder_only\|football\|11-a-side\|M1@390`, `knockout_third_place\|football\|11-a-side\|F1@360` |

Audit ids no baseline case drives (`not-exercised`, 6): each is owed a scenario before W4 can close it.

| id | severity | title |
|---|---|---|
| FX-G16 | L | Correcting a result in a completed source stage stales only `draft` seed proposals. A CONFIRMED proposal, or an `on_complete`… |
| FX-G17 | L | Unseeded entrants are ordered by `created_at`, so the first registrants get seed 1, byes and pool heads. There is no random-draw option… |
| FX-G18 | L | A void un-fill (#856) and the dead-feeder cascade are both same-stage only, so cross-stage (`cross_feeds`) seats keep the old name. |
| ST-G7 | M | A completed bracket writes an all-zero `placementTable` snapshot. The division page and hub skip bracket kinds; the embed does not.… |
| ST-G18 | L | `bracketRanks` gives losers of the same round distinct ranks by seed, then UUID. Without a 3rd-place match, the SF losers become "3" and "4"… |
| ST-G26 | L | Picks `standings[0]` from an unordered query (any pool, or a KO placement). P/Pts stay English (asserted intentional). `revalidate=300`. |

- **NEW-W1d-3 (W4): a design row backs the wave.** Section 8's row for W4 (knockout family) names `stepladder` for `stepladder_only`.
- **NEW-W1d-4 (W4): a design row backs the wave.** Section 8's row for W4 (knockout family) names `third place` for `knockout_third_place`; names `page_playoff` for `page_playoff_only`; names `stepladder` for `stepladder_only`.

### W5 — round-robin family

The ledger holds 19 audit ids for W5: 1 reproduced, 0 exercised-not-reproduced, 13 not-exercised, 5 verified-by-read, 0 verified-by-failing-test.

🚫 33 planned cases have no organiser path and route to W5 by their own reason (L1 20 and L2 13, 33 in all); the baseline never drove them, so they are in no table below.

| gap | title | cases | layers | examples |
|---|---|---|---|---|
| NEW-W1d-5 | no division-builder control builds group_only or group_group_ko | 5 (+1 also) | L2 | `group_only\|football\|11-a-side\|R4a@768`, `group_group_ko\|football\|11-a-side\|R4a@834`, `group_only\|football\|11-a-side\|M1@834`, `group_group_ko\|football\|11-a-side\|M1@320`, `group_only\|football\|11-a-side\|F1@834` |
| ST-G5 | A pool's membership is "entrants with a result or award in this pool". A seated member who has not played yet is missing from its pool… | 12 | L2, L3 | `group_group_ko\|football\|11-a-side\|F1@320`, `group_group_ko\|football\|11-a-side\|F1`, `group_group_ko\|cricket\|t20\|F1`, `group_group_ko\|boardgame\|blitz\|F1`, `group_group_ko\|carrom\|club-29\|F1` |

Audit ids no baseline case drives (`not-exercised`, 13): each is owed a scenario before W5 can close it.

| id | severity | title |
|---|---|---|
| FX-G5 | M | With the wave-major `rank_order` fold, 3 pools top-2 (q=6 or 8) pairs C1 v C2 in round 1, and 5 pools top-3 pairs A2 v A3. Tests cover only… |
| FX-G15 | M | Add match (the documented safe workaround for G1) puts each ad-hoc match in round `max+1` unless a round is passed. |
| FX-G19 | L | Board cards for group fixtures read `R{n}` with no pool, because `BoardFixture` carries no `pool_id`. |
| ST-G4 | M | The cross-pool (bestNth) comparison always uses `points,diff,for,wins`. Cricket NRR, set/point ratio, h2h and lots are ignored. Sports… |
| ST-G6 | M | Standings are read with `pool_id is null` only. A pooled division gets no standings section. |
| ST-G12 | M | The h2h mini-table is built from whatever matches the tied group has played so far, with no "all h2h matches played" guard. It is untested… |
| ST-G13 | M | When the cascade ends without `lots`, residual ties are ordered by seed, then entrant UUID, and the popover explains it as "seeding".… |
| ST-G14 | M | `overrideStandings` rejects a duplicate rank across the WHOLE body, so rank 1 cannot be pinned in two pools. Each call replaces all prior… |
| ST-G15 | M | An expunge (<50% played) skips `finalized` fixtures, so the withdrawn entrant's finalized results still count while its other results are… |
| ST-G20 | M | Hub tables have no withdrawn/disqualified chip. `buildTableView` takes no statuses. The wiring test scans only `<StandingsTable` call sites. |
| ST-G23 | M | Neither standings endpoint declares a response. `StandingsRowOut` (`schemas.ts:1524`) is unused and wrong (rank required; W/D/L, metrics,… |
| ST-G24 | M | Only one snapshot is exported (`limit 1`), so a pooled stage exports one pool and a later knockout replaces the league table. Headers are… |
| ST-G28 | L | The private GET without `pool_id` on a pooled stage returns `rows: []`, and there is no pool listing endpoint. Public rows reference… |

- **NEW-W1d-5 (W5): a design row backs the wave.** Section 8's row for W5 (round-robin family) names `group` for `group_only`; does not name `group_group_ko`, which reaches W5 by section 8's clause that a gap not listed goes to the wave owning its format (the row lists `group`).
- **ST-G5 pool of one: a product decision, owned here** — ST-G5's 12 cases are the same F1 field on 11 sports: 7 entrants snaked into 4 pools leave pool A holding seed 1 alone, with no fixture and so no member. Its table is empty, seed 1 stands in no pool, and stage 1's `/complete` answers 409 `STAGE_COMPLETED_SEEDING_FAILED` (the triage rule's note). Whether to refuse such a field with a named reason, or to change what makes an entrant a member of a pool, is a product decision: not W1d's and not a harness question, so it belongs to this gap's wave. This file records no owner ruling on it.

### W6 — double elimination

The ledger holds 4 audit ids for W6: 0 reproduced, 0 exercised-not-reproduced, 1 not-exercised, 3 verified-by-read, 0 verified-by-failing-test.

No 🚫 case routes to W6 by its own reason.

No ❌ case of the baseline is keyed to W6.

Audit ids no baseline case drives (`not-exercised`, 1): each is owed a scenario before W6 can close it.

| id | severity | title |
|---|---|---|
| ST-G33 | L | Double-elim ranks are tested with 2 entrants only (`placement-snapshots.test.ts:322`). Pooled rank locks are untested. No test feeds a void… |

### W7 — americano, mexicano, ladder

The ledger holds 8 audit ids for W7: 1 reproduced, 0 exercised-not-reproduced, 2 not-exercised, 5 verified-by-read, 0 verified-by-failing-test.

No 🚫 case routes to W7 by its own reason.

| gap | title | cases | layers | examples |
|---|---|---|---|---|
| FX-G11 | The next round is generated only when EVERY stage fixture is `decided`. A `finalized` (core.finalize), `forfeited` or `abandoned` fixture… | 12 | L2, L3 | `mexicano\|football\|11-a-side\|M1@430`, `mexicano\|football\|11-a-side\|M1`, `mexicano\|cricket\|t20\|M1`, `mexicano\|boardgame\|blitz\|M1`, `mexicano\|carrom\|club-29\|M1` |
| NEW-W1d-1 | mexicano counts the pair entrants it made as players: round 2+ pairs a pair entrant with itself (500) or seats one person twice | 47 | L1, L2, L3 | `mexicano\|football\|11-a-side\|LIFECYCLE@1280`, `mexicano\|football\|11-a-side\|R4a@390`, `mexicano\|football\|11-a-side\|LIFECYCLE`, `mexicano\|cricket\|t20\|LIFECYCLE@1280`, `mexicano\|boardgame\|blitz\|LIFECYCLE@1280` |
| NEW-W1d-2 | americano: R4 withdraws a player and the product does nothing with the pending games, the person is seated again | 12 | L2, L3 | `americano\|football\|11-a-side\|R4a@375`, `americano\|football\|11-a-side\|R4`, `americano\|cricket\|t20\|R4`, `americano\|boardgame\|blitz\|R4`, `americano\|carrom\|club-29\|R4` |

Audit ids no baseline case drives (`not-exercised`, 2): each is owed a scenario before W7 can close it.

| id | severity | title |
|---|---|---|
| FX-G12 | M | Keys are positional `am-r{r}-c{c}`. A roster change regenerates a different rotation, but no key is new, so nothing is inserted. The stage… |
| ST-G19 | L | There is no public ladder view while it runs (no snapshot until completion). On completion, the `placementTable` zero rows render as a… |

- **NEW-W1d-1 (W7): a design row backs the wave.** Section 8's row for W7 (americano, mexicano, ladder) names `mexicano` for `mexicano`.
- **NEW-W1d-2 (W7): a design row backs the wave.** Section 8's row for W7 (americano, mexicano, ladder) names `americano` for `americano`.
- **Mexicano R4: an intermittent 500 in generation** — In 9 of the 11 `mexicano|<sport>|R4` cells the failing-check set flips across the three dispatches while the state stays red in all three (`dispatch-cuts.json` holds the 9 cells as each dispatch recorded them). A cell's failing set shows the re-seat (`I10-americano-seats-each-person-once`, a person seated twice in a round, with `r4-not-seated-later`), the 500 (`generate` answering 500 INTERNAL: `I4-nothing-ends-stuck`, `I8-generate-named`, `life-loop-bounded`), or both together, and which it shows moves between dispatches. The 500 shows in 5, 5 and 6 of those 9 cells, in dispatches 1, 2 and 3 respectively. The other 2 cells (cricket and generic) keep one shape. So the product's mexicano `generate` answers 500 INTERNAL on some runs of the same plan and a different failure on others: an intermittent 500. The triage keys every shape to NEW-W1d-1, so no red is lost, but the state alone cannot tell the shapes apart, and a fix is proven by all of them going quiet over several dispatches, not by one green run.

### W8 — scorer sheets

The ledger holds 20 audit ids for W8: 0 reproduced, 0 exercised-not-reproduced, 19 not-exercised, 1 verified-by-read, 0 verified-by-failing-test.

No 🚫 case routes to W8 by its own reason.

No ❌ case of the baseline is keyed to W8.

Audit ids no baseline case drives (`not-exercised`, 19): each is owed a scenario before W8 can close it.

| id | severity | title |
|---|---|---|
| SH-G2 | M | Printed links never re-check the entitlement. |
| SH-G3 | M | No bulk revoke. |
| SH-G4 | M | Unscheduled fixtures cannot print. |
| SH-G5 | M | Non-Latin names have no glyphs |
| SH-G6 | M | No paper fallback and no format on the card: |
| SH-G7 | M | No real sport is exercised from a sheet. |
| SH-G8 | M | Groups, double-elim and playoff sheets are untested |
| SH-G9 | M | A whole-competition print is one long transaction. |
| SH-G10 | L | A cut-out card carries no court |
| SH-G11 | L | The scan screen names the court differently from the sheet. |
| SH-G12 | L | No reprint prompt after a reschedule. |
| SH-G13 | L | Analytics and filename are wrong for range/division prints. |
| SH-G14 | L | `dateFrom > dateTo` is not validated. |
| SH-G15 | L | Division sheet order is by division name, not the board's division order. |
| SH-G16 | L | An unpaired Swiss bye shell is not excluded. |
| SH-G17 | L | A double-elim grand-final reset (`conditional`) prints like any match |
| SH-G18 | L | Cards for future Swiss rounds can die. |
| SH-G19 | L | A withdrawn entrant's match still prints |
| SH-G20 | L | The scan-side lineup catalog reads the division config, not the stage overlay |

### W9 — operational [O]

No audit id routes to W9.

🚫 63 planned cases have no organiser path and route to W9 by their own reason (L2 63); the baseline never drove them, so they are in no table below.

No ❌ case of the baseline is keyed to W9.

None of W9's audit ids is `not-exercised`.

### W10 — sweep

The ledger holds 4 audit ids for W10: 0 reproduced, 0 exercised-not-reproduced, 3 not-exercised, 1 verified-by-read, 0 verified-by-failing-test.

No 🚫 case routes to W10 by its own reason.

No ❌ case of the baseline is keyed to W10.

Audit ids no baseline case drives (`not-exercised`, 3): each is owed a scenario before W10 can close it.

| id | severity | title |
|---|---|---|
| ST-G22 | M | Names come from raw `entrants.display_name`, bypassing the consent/youth masking public surfaces apply. |
| ST-G25 | L | The read-standings guide uses `r.entrant_name`, which does not exist (rows carry `entrantId`), and never mentions pools. |
| ST-G27 | L | The standings email block has no production caller and hardcodes English P/W/L/Pts with no D. |
