# W2a: whole-branch review (loop R)

- **Reviewed:** `feat/format-matrix-w2a` at HEAD **806ac17eb**, diff `8afdd8b42...HEAD`, 50 commits. The review started at 6d95c5e8a, and 806ac17eb only re-measures `stryker-measured.json` core-2.
- **origin/main** (5a02cc4a5, #932) is not yet merged. It merges cleanly (`git merge-tree`), and #932 reads no fixture status.
- **Method:** read-only. No suite was run locally. CI logs were read with `gh`, and the evidence crops were viewed.
- **Lenses:** customer, owner, test design.
- **Authorities:** spec `2026-10-08-format-matrix-w2a-design.md`; plan §Loop R (:6032); the ledger `.superpowers/sdd/2026-10-08-format-matrix-w2a/progress.md`; AGENTS.md; TEST-STRATEGY.md.

**Verdict: Needs fixes.** The product core is sound and wired end to end. Three things stand in the way:
- Loop R's own precondition is unmet (plan :6034: "waits on Task 17's CI dispatches being green").
- The D-P2 truth gate is negative.
- No green e2e run exists for this branch, and the one that ran is red on a W2a key.
- One new refused path: a withdrawal during a pending chess tie-break.

---

## 1. Spec compliance

| Done-when (spec §1) | State at HEAD | Judgement |
|---|---|---|
| 77 cases green | 71 green and 6 re-keyed (D-P2, pinned in `tools/matrix/w2a-expect.ts`) | Sanctioned by ruling D-P2 |
| Judge regression: no new red | **NEGATIVE.** CI truth 37916609028: 9 L3 regressions (`page_playoff_only\|*\|M1`). The per-PR sample 37929197201 reproduces the same 9 on re-run, and the D-P2 judge exits 1 with 2 unexpected reds. | Defect, see I-3 |
| NEW-H1 reproduced and fixed | Probe `e2e/bracket-new-h1.spec.ts`; D4 plus fix rounds 1–2 | Met |
| Rules rows proved | 10 rows; `AWAITING_PROOF` empty (`rules-reference.test.ts:12`) | Met |
| e2e / smoke / visual | Smoke 1195/0 locally. **e2e: no green run exists for W2a.** 37923877314 failed (walkthrough 2/3). 37929849834 checked out `refs/pull/932/head` (8ab230e), not #931. Visual: 63 crops, owner verdict pending. | Defect, see I-2. Visual is an owner gate (M7). |

**Deviations seen and judged:**
- D-M1 (needs_decision arms the stream auto-stop): sanctioned.
- D-P2 re-keys: sanctioned.
- D-G2/D-G3 characterisations to W2b: sanctioned.
- Evidence PNGs uncommitted (owner 2026-10-09): sanctioned.
- Stryker group=all is not a gate (owner 2026-10-09): sanctioned.

## 2. Strengths (load-bearing only)

- **One predicate per question.**
  - `settleApplies` and `deciderPending` (engine core) are read by append-event, the console (`needs-decision.tsx`) and the pad (`skins/boardgame.tsx`).
  - `isOrganiserOnlyEvent` (`lib/organiser-only-events.ts`) is read by the server gate (`usecases/scoring.ts:511`), the pad (`pad-host.tsx:734/:768-771/:1257`) and the bench driver.
  - `abandonAwaitsSettle` / `hasActiveAbandonSql` (`engine-db/recorded-abandon.ts`) are read by the cascade, the completion branches and the desk.
- **The status vocabulary has one list.** `FIXTURE_STATUSES` (8) is the one list, and `status-set-sweep.test.ts` counts it in both directions against a classified ledger.
- **Proof is derived, not typed.**
  - Sport sweeps read `declaredCfgs`, `supportsDraws` rule rows and module declarations, never a typed table.
  - The oracle is `import type` only.

## 3. Issues

### Critical

None.

### Important

**I-1. A chess knockout withdrawal during a pending tie-break is refused with 422 WRONG_PHASE.** Introduced by W2a. Owning loop: F (`withdrawal.ts`), or W2b by a recorded ruling. Traced by reading; not run.
- **Trace:**
  1. A drawn knockout chess game is `in_play` in phase `tiebreak` with no outcome (`boardgame.ts:297`).
  2. `bracketWithdrawalStatus` (`usecases/withdrawal.ts:45-47`) maps `in_play` through `PENDING` (`:41`) to `"scheduled"`, so the planner walks the opponent over.
  3. The step posts `core.forfeit` (`:129`).
  4. Boardgame refuses a forfeit outside `live` (`boardgame.ts:711`).
- **Effect:** the withdrawal 422s and `patchEntrant` (`:246`) never runs. Plan steps already applied inside the loop (`:237`) may have committed.
- **Escape:** the organiser settles first, then withdraws.
- **Why this is W2a's:** the tie-break phase is W2a-new. Before W2a the game was decided level and the planner read it as `decided`.
- **Not covered anywhere I found:**
  - `settle-seating.test.ts` covers C17 only for `needs_decision`.
  - Ledger line 178 routes chess forfeit "in phase pre" to W2b as BG-WO-2.
  - The W2b spec's kernel guard (branch `docs/format-matrix-w2b-spec`, design §"Phase guard") keeps "the module's own phase guards … for done/final" and never names `tiebreak`.
- **Fix, one of:**
  - (a) In `bracketWithdrawalStatus`, read an `in_play` fixture whose decider is pending (`deciderPending`) as a hold (`"void"`, the C17 shape), so the organiser settles it for the remaining entrant.
  - (b) Rule it W2b. Add a characterisation test that pins today's 422 (cell: knockout, boardgame, draw, then withdraw), plus an IDX row and a W2b spec input naming the `tiebreak` phase.

**I-2. The W2a e2e is red at HEAD and no green e2e run exists for the branch.** Owning loop: E2 (test wiring), with H's key.
- `apps/web/e2e/walkthrough/scorer-sheets-scan-screens.spec.ts:940` still pins the widest Spanish status as `score.status.forfeited`.
- W2a's `needs_decision` ("Requiere una decisión", 157 px) is wider than it (150 px), so dispatch 37923877314 failed walkthrough 2/3 (false premise 57, "routed to the controller").
- The only later green dispatch, 37929849834, ran `refs/pull/932/head`. Its log shows "HEAD is now at 8ab230e".
- e2e runs on push to main, so this merge would turn main red.
- The ledger's "Remaining gates" (`progress.md:182`) omits it.
- **Fix:** move the case to the widest status the spec's own comment names. Mint a held fixture for the measured page, or derive the expected key from a width measurement of every `score.status.*` rather than pinning a key. Then dispatch e2e with `pr=931` and confirm the PR ref in the checkout log.

**I-3. The truth gate is negative: a harness defect plus one unpinned reason flip.** Owning loop: P1 (`tools/matrix`).
- `tools/matrix/lib/scenarios/m1-walkover.ts:111-113` (M-6, `b7b1ff74d`) puts `bracketDeciderExercised` on M1.
  - On a page playoff the walkover's loser is not seated, so the walkover holds the only hard-path slot and no decider is ever posted (false premise 50).
  - Result: 9 L3 regressions against W1d, plus the D-P2 unexpected red `page_playoff_only|generic|score|M1`.
  - The per-PR sample (37929197201, "L3 shard 1/1") shows the same 9 cells, "re-run: red", and exits 1.
- SC-O2 `swiss_playoff|generic|score|R4` flips its reason to SW-H1 (P6/W3) on CI. The pins do not hold it, so the judge still counts it as unexpected.
- **Fix:**
  - (a) Exempt M1 from the decider check when the walkover consumed the only hard-path slot. Better: assert "a decider is owed iff `decideRound` has a level-capable fixture left", from the run's own record.
  - Or (b) move the decider check off M1 to the five new scenarios, which already carry it (128/128 pass).
  - Then pin SC-O2 with reason `SW-H1` (owner P6/W3), or record the owner's acceptance.
  - Re-dispatch the CI truth run and the per-PR sample. Both judges must exit 0.

**Gate status, not a finding:**
- PR CI at 806ac17eb is pending (37939883742).
- The last completed PR CI had red jobs: engine coverage (fixed by 6d95c5e8a/806ac17eb), the check-vitest-collection list (fixed, `check-vitest-collection.test.ts:160`), and R27 (fixed).
- origin/main is not merged.

### Minor (9)

- **M1. The broadcast overlay says "Live" on a held fixture.** `lib/overlay-model.ts:330` `ENDED_STATUSES` excludes `needs_decision`, so `headerContext` (`:361-365`) returns `overlay.header.live`. The ledger classes the set as "played" (`status-set-ledger.ts:84`). The clock is already dropped (`use-overlay-clock.ts` `NO_CLOCK_STATUSES`). D-M1 stops an auto stream about a minute later, but a manual stream keeps saying Live. Routed by E2 as owner copy. **Fix:** a held header word (`overlay.status.held`) in `statusLabel`.
- **M2. The stream panel's chip is silent on a held fixture.** `usecases/stream-sessions.ts:2033` `fixtureDecided` is decided or finalized only, so "Match decided — still streaming" never shows while D-M1's auto-stop is armed. The organiser gets no warning before the stop. **Fix:** include `needs_decision`, or add a held variant of the chip.
- **M3. A chess double forfeit reads publicly as "Level — winner to be decided".** It is held as `no_result`, and nobody played. This is transient: W2b's `double_walkover` reclassifies it. **Fix:** record it as a W2b input. No W2a change.
- **M4. The status-set sweep cannot see single-literal comparisons or braced `switch` blocks.** Examples: `public-site/match-centre.ts:823` `statusOf`, `court-card.tsx:63`. Both send `needs_decision` to "other", which is correct today. **Fix:** add these two shapes to the scanner, or state the blind spots in the sweep's header so its title does not generalise past them.
- **M5. A sweep's sport list is typed in.** `tools/matrix/__tests__/scorable-overlay.test.ts:23` hard-codes `["boardgame", "carrom"]` under the title "every sport the overlay touches". **Fix:** derive the list from the modules whose `bracketDeciders(cfg)` is non-empty, and assert that count is greater than 0.
- **M6. D round 2 (`0c6263296`, the `events.ts` invariant throw) has hand mutants but no changed-lines Stryker report in the ledger** (`progress.md:107`). Plan Q4 asks for one per engine task. **Fix:** run `stryker-changed` on that range and record `survived: 0`.
- **M7. W2a-introduced per-screen FAILs await the owner** (IDX "W2a per-screen verdicts").
  - The official's held console shows an empty "Scoring" card at 1280 and 768 (crop viewed).
  - The public bracket's held chip wraps inside its fixed-width pill at all widths (crop viewed).
  - The tie-break heading splits "TIE-/BREAK?" at 320, with Back above the options (crop viewed).
  - The run-sheet meta hides "abandoned" at 320.
  - The desk "Settle the match" button is 28 px at 768.
  - Spec §5.5: a rejected screen returns to loop H before merge.
- **M8. The Armageddon step never says which entrant had Black** (owner question, open).
- **M9. The ledger's "Remaining gates" (`progress.md:182`) lists engine coverage and ci/smoke only.** It drops the e2e red (I-2) and the negative truth gate (I-3), so a reader of the ledger would think the branch is one CI run from merge.

## 4. Gap hunt

**Verified clean:**
- **Callers of `resolveFixtureCfg`.** All 11 carry `stageKind`: fold, append-event, competition ×2, match-centre-load, fixtures, player-stats, event-import, admin-fixture-config ×2, org-posts. The overlay and timeline replay loops use `loadFoldInputs`, and both skip `kernelOwnsEvent`.
- **Authority.** `event-import` requires division write (EDITOR_ROLES), so no scorer can bypass the gate. `history.ts` writes `division_events`, not the score ledger.
- **Device links.** `carried-forward.ts:39` `SETTLED_OPEN_STATUSES` correctly excludes `needs_decision`, because nothing has been carried forward from a held row. A device link may still void its own taps, which re-opens the row and is a legitimate correction. Settle stays organiser-only, because the `:511` gate runs first.
- **V432.**
  - `division_has_results` counts a held row unless it is `no_result` (D-F4).
  - `fixtures_track_finished` includes `needs_decision` (D-M1).
  - `stream-link.ts` `REPLAYABLE_STATUSES` includes it.
  - `capture-phone.ts:187` reads `finished_at` only.
  - `use-live-fixture.ts` keeps a held fixture live (realtime and poll).
- **Withdrawals.** `withdrawal.ts:52-53` holds a `needs_decision` row as void (C17).

**Found:** I-1, M1, M2 and M4 above. Also:
- `tools/matrix/__tests__/scorable-overlay.test.ts` (M5).
- 4 new test files carry no count and are not sweeps (fine): `held-behaviours`, `match-poster-held-loader`, `event-import-held`, `scorable-overlay`.

## 5. The four questions

1. **Second call.**
   - A second `core.settle` is refused, because `settleApplies` short-circuits on a decided outcome (D-C5).
   - `boardgame.tiebreak` after a settle or a decision is refused `TIEBREAK_NOT_APPLICABLE` (P2-6).
   - A keyed retry replays. The console blocks Confirm while sending.
   - A second withdrawal of the same entrant is not a new path.
   - `firstResult` fires again on leaving `needs_decision`, which is intended.
2. **Empty input.**
   - Settle with no winner or method fails the schema.
   - The dialog's Confirm is blocked until both are chosen.
   - Nine sports declare `bracketDeciders` = `{}`, which is a no-op overlay pinned in `bracket-deciders.test.ts`.
   - The ladder has no feed edge, and is the stated empty case of the 6-shape sweep.
   - The `AWAITING_PROOF` map is empty and pinned.
   - The status sweep fails at zero found.
3. **After a withdrawal or a void.**
   - Voiding a settle re-holds the row (D-F1, `held-behaviours.test.ts:124/:137`).
   - A voided abandon cascades the walkover again.
   - A held row on withdrawal becomes void, and a settle naming the withdrawn entrant is refused.
   - **A withdrawal during a pending tie-break 422s (I-1).**
   - D-G2 and D-G3 (a withdrawn loser on page_playoff, the stepladder departed seed) are pinned characterisations owed to W2b.
4. **Another sport.**
   - The 11-sport sweeps are: supports-draws (11 × 9 kinds), bracket-deciders, the dead-feeder cascade (both abandon shapes), organiser-only (11 modules, 26 enum fields) and outcome readers.
   - A cricket tie is held, then settled (CK-KO-1). Carrom plays an extra board. Chess plays a tie-break.
   - The M1 harness defect hits every sport but boardgame (I-3).
   - I-1 is boardgame-only, because only boardgame refuses a forfeit outside `live`.

## 6. Plan Loop R questions

1. **Inert seams: wired.**
   - `stageKind` reaches both ScorePad mounts as a required prop (`registry.tsx:206/:242`): the console page and `device-score-pad.tsx:717`, which is `canOrganise={false}`.
   - `bracketDeciders` reaches all 11 `resolveFixtureCfg` callers.
   - `ORGANISER_ONLY` is shared by `scoring.ts:511` and `pad-host.tsx:734/:768-771/:1257`.
   - The six method keys exist in 4 locales in `public.json` and `ui.json`.
2. **Precedence: no trap.**
   - The overlay forces only boardgame `tiebreak` and carrom `tieBoard`, both by ruling (BG-KO-1, CA-KO-1).
   - A frozen snapshot is returned untouched (`fixture-cfg.ts:77`).
   - The admin re-snapshot applies the overlay deliberately.
3. **Over-refusal: one case, I-1.** The settle after a void, the settle during a tie-break (P2-5) and the finalize guard (P2-7) are correct.
4. **Mutants.**
   - Every task report has a runner table, all KILLED: t2 90, t7 26, t8 18, t9 14, t10 15, t11 11, t12 34, t13 38, and 580 mutants validated across 15 lists.
   - Engine changed-lines Stryker: T3 has 0 survivors after one equivalent was removed, T4 96/96, T5 137/137, D r1 60/60, `4bd96a22a` 24/24. D r2 has no report (M6).
   - The probe group exits 0 at 74.81%.
5. **Oracle independence: yes.**
   - `packages/reference/src/families/bracket-finish.ts:17` is the family's only engine import, and it is `import type`.
   - The P2 brief forbade reading engine source (`task-15-brief.md:6/:127`).
   - The P2 rulings (P2-1…8) cite the spec, not the engine.
6. **Counts: yes, with two Minors.**
   - The status sweep asserts that both found and checked are greater than 0.
   - The sport sweeps assert their judged counts.
   - Gaps: M5 (a typed list with a constant count) and M4 (the scanner's blind shapes).
7. **Visual: complete, but owner verdict pending.**
   - 21 screens × 3 widths = 63 crops, with no two identical (md5).
   - Every row has a verdict at all three widths.
   - The crops I viewed show the post-state: the held badge, the tie-break winner step and the held chip.
   - 12 FAIL cells. 3 are pre-existing. The other 9, on 6 screens, are W2a-introduced (M7).

## 7. Routing

| Fix | Loop | Re-run |
|---|---|---|
| I-1 | F, or W2b by ruling with a characterisation pin and an IDX row | `withdrawal-*`, `settle-seating` scoped vitest, and a hand mutant of the new branch |
| I-2 | E2 | the walkthrough spec file whole, then a `workflow_dispatch` e2e with `pr=931`, checking the ref in the log |
| I-3 | P1 | `tools/matrix` scoped tests on m1-walkover and w2a-expect, then the CI truth run and the per-PR sample, with both judges exiting 0 |
| M1, M2 | H (owner copy first) | overlay-model and stream-sessions scoped tests |
| M4, M5 | F / P1 | the sweep's own tests, with a mutant per new shape |
| M6 | D | `stryker-changed` on `0c6263296` |
| M7, M8 | owner, then H | per-screen crops |
| M9 | controller | ledger edit |
