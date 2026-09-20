# PR #803 (Swiss shells / Pair next / Unpair) — review findings

**Status:** owner closed #803 and merged `feat/swiss-shell-fixtures` into
`feat/stage-match-rules` (merge `d965035a6`). These findings are therefore
**owed by this branch**, not by a PR someone else will fix.

**Provenance.** Three read-only reviewers, disjoint dimensions (destructive
paths; standings/engine; test honesty). No tests run — the machine was loaded
and a second run reds suites for unrelated reasons. Every CRITICAL below was
re-verified by the orchestrator directly, by reading the named lines.

**#803's CI told us nothing.** All 11 jobs failed in 2-3s with **0 steps** —
the GitHub Actions billing-block signature, not a code failure. Nothing ever
ran. Do not cite that run as evidence either way.

---

## OWNER RULINGS (2026-09-20)

1. **No boardgame knockout data exists in prod**, so C2 is LATENT, not an
   incident. Still owed — it regresses an existing feature the moment such a
   division is created.
2. **The Actions billing block is fixed**, so CI runs again. #803's all-red
   run remains meaningless (0 steps); re-run rather than cite it.
3. **"Unpair only if no matches started or scored for that round."**

Ruling 3 replaces the PR's per-row bye classification in the GUARD with a
whole-round rule, and it is stricter than what shipped. One refinement, flagged
to the owner: taken literally it would make every odd-field round
un-unpairable, because a bye IS a result row. So the guard refuses when ANY row
in the round shows evidence of play, exempting only a genuine system-generated
bye — exactly one seat null, `outcome.kind === "award"`, and the seated side is
the winner. A TWO-SIDED award (forfeit / retirement) is a played match and
blocks Unpair. That is the distinction `competition.ts:89` already makes
correctly and `swiss-shell.ts:55` gets wrong.

Consequences for the fix:
- The evidence check runs over ALL rows in the round, never `nonByeIds`.
- Evidence is monotonic — `config_snapshot is not null OR exists(score_events)`
  — because `fixtures.status` moves BACKWARDS when a `core.start` is voided
  (`append-event.ts:119-129`). Status may be used only to ADD refusals
  (`in_play`, `abandoned`, `decided`, `forfeited`), never as the sole test.
- Align with the repo's canonical destructive guard at `stages.ts:2092-2104`,
  which also consults `match_states`, `match_reports`, `official_marks` and
  `suspensions`. A subset guard on a destructive path is how C1 happened.

## C1 — Unpair silently destroys a real result (VERIFIED)

`apps/web/src/lib/swiss-shell.ts:55-56`

```ts
export function isSwissByeRow(f) {
  return f.ext_key?.endsWith("-bye") === true || isAwardOutcome(f.outcome);
}
```

`isAwardOutcome` is true for ANY `outcome.kind === "award"`. Every sport kernel
emits exactly that shape for a real **two-sided forfeit or retirement**
(`generic.ts:563`, `setbased/kernel.ts:812`, `football.ts:1649`,
`nested/kernel.ts:1383`, `cricket.ts:3781`, `carrom.ts:459`).

So a played board with a retirement is (a) skipped by
`swissRoundHasPlayedResult` (`swiss-shell.ts:134` returns false) and (b) filtered
out of `nonByeIds`, so the `score_events` check at `stages.ts:1327-1331` never
sees it. Both Unpair guards are disabled at once.

**Repro:** 4 entrants / 3 rounds → Generate → Pair next (R1 = b1, b2) → on b1,
A retires or is forfeited (status `forfeited`, outcome award, BOTH seats set);
leave b2 alone. `latestSeatedSwissRound` → 1; the guard reports "no played
result"; `stages.ts:1342-1350` nulls b1's entrants, status and outcome. The
result, the winner and the reason are gone. One click — `stages-panel.tsx:782-785`
gates the button on the same predicate.

`score_events` / `match_states` / `config_snapshot` survive **orphaned** on the
cleared shell (the UPDATE list omits `config_snapshot`) and will be replayed
under whatever pair is seated there next.

**This repo already fixed this exact bug elsewhere** — `stages.ts:2043-2051`
documents it verbatim ("A walkover has two real entrants… destroying it would
erase the reason the opponent advanced") — and **the same PR gets it right
1000 lines away**: `competition.ts:89` `isOneSidedAwardBye` requires an award
AND exactly one seat null.

**Fix:** make `isSwissByeRow` require exactly one seat null and
`seated === outcome.winner`; run the `score_events` check over ALL rows in the
round, not `nonByeIds`. Note `swiss-shell.test.ts:121-124` asserts the DEFECT
(a board `ext_key` with an award outcome declared a bye) — that assertion is
wrong and must be corrected, not preserved.

## C2 — the new bye path throws for chess / draughts / go (VERIFIED)

`competition.ts:347` → `awardByeDelta:118`. `boardgame` is the ONLY one of the
eight modules with no `case "award"` in `standingsDelta`
(`boardgame.ts:685-724`); it falls through to `default: invalid(...)` →
`EngineError("INVALID_EVENT", 'board-game module cannot rank outcome "award"')`.

- **New:** chess Swiss, odd field → Pair next COMMITS the bye write, then the
  unguarded `recomputeStandings` (`stages.ts:1828`) throws → 500 returned while
  the round is in fact paired.
- **Regression on an existing feature:** `tableFixtures` is built for EVERY
  stage kind, so a boardgame KNOCKOUT with seeded byes (`stages.ts:1540` on
  `main`, one seat null) now throws inside `loadStageInputs` —
  `recomputeStandings`, `rankedStageStandings` and `completeStageIfReady` all
  break for that division.

Not covered: the new engine test hand-builds `awardDelta`, and
`swiss-shell-fixtures.test.ts` uses badminton (setbased, which handles award).

**Open question, needs a DB query:** whether a live boardgame knockout exists in
prod data — that decides latent vs incident.

## C3 — the merged tree does not typecheck (VERIFIED by running tsc)

Both errors are in code #803 added; neither is merge-induced:

- `competition.ts:128` TS4104 — readonly `FixtureResult` assigned to a mutable
  tuple (`let pair = standingsDelta(...)` then `pair = applyPointsRule(...)`).
- `swiss-shell-fixtures.test.ts:265` TS2358 — `instanceof` on `string | undefined`.

---

## Important

- **Buchholz is wrong for any bye not in the last round.** Awards are pushed in
  a second loop after all results (`tiebreakers.ts:735-746`,
  `stage.ts:217-219,234`), so a bye always lands at the END of the card, and
  `StandingsDelta` carries no round. `virtualOpponentScore` is
  `scoreBefore + (rounds − gameIndex)`. 5-round Swiss, bye in R1 then four
  losses → card `[L,L,L,L,bye]`, index 4 → virtual opponent 1 half-point; FIDE
  C.07 says index 0 → 5. Understated by 2 points; the reverse case overstates.
  The new `stage.test.ts` case is single-round, so index 0 is right by accident
  and cannot witness it.
- **`forfeit.awardScore` leaks into a bye's metrics.** `applyPointsRule` adds it
  to `metrics.for/against/diff` (`points.ts:137-143`) and only the winner's half
  survives the fold, so a bye recipient gains GF+3/GD+3 nobody conceded and
  outranks a level rival on `diff`. Strip metrics from the synthesised delta.
- **A bye never freezes `config_snapshot`** (written only by `append-event.ts`),
  so `resolveFixtureCfg` falls through to LIVE cfg forever: a bye awarded under
  `points.w=3` silently becomes 2 when the organiser later edits the division.
  Exactly the drift `fixture-cfg.ts`'s header says the snapshot exists to close.
- **Roster drift after minting bricks Pair next permanently**
  (`stages.ts:853-855`, `:868-870`). Field 6→5 → `EngineError CONFIG_INVALID
  "swiss bye shell missing"`; 5→6 → `"swiss shell count mismatch"`. Every
  subsequent Generate throws, with no recovery short of `rebuild`. Untested.
- **A round-count change after minting is a silent no-op** (`stages.ts:738`
  gates on `existing.length === 0`). 3→5 never mints rounds 4-5 and Generate
  reports "up to date"; 5→3 leaves shells Pair next will happily seat past the
  budget. The `if (already) return` swallow, again.
- **Unpair can eat an ad-hoc fixture.** `ADHOC_STAGE_KINDS` includes `swiss`
  (`stages.ts:4022`) and `addFixture` defaults `round_no = maxRound + 1`, which
  Unpair then treats as the latest seated round.
- **Guard read before the advisory lock** (`stages.ts:1302-1306`), inverting
  this file's own stated convention (`:4066`).
- **Every server refusal collapses to one string** (`stages-panel.tsx:499-501`),
  so "round has results" and "division frozen" are indistinguishable.

## Tests that do not constrain the code

- `stages.ts:1316` played-result refusal: mutate to `false` and NOTHING reds —
  every test that "decides" a round goes through `appendEvent`, so the
  `score_events` guard refuses first. Needs a row set `decided` by direct SQL
  with no events.
- `swiss-shell.ts:134-136`: the two bye guards cover for each other; every test
  bye row is BOTH `-bye`-keyed AND award-outcomed. `:136` has no test at all and
  is in fact dead code.
- `competition.ts` `if (pointsRule) pair = applyPointsRule(...)` in the bye path
  is never exercised — both bye tests use `config: {}`.
- `swiss-shell-fixtures.test.ts:179-186` "Pair R1 requires an explicit second
  Generate" never calls `generateStageFixtures` — title and body disagree; it
  passes if Pair is entirely broken.
- `swiss-shell-fixtures.test.ts:311` `toBeGreaterThan(0)` where the real value
  is 2 — passes if only the bye were cleared.
- `swiss-knockout-shape.test.ts`: the cross-template parity assertion
  (confirmSeedProposal → exact semis → swiss_playoff/swiss_knockout parity) was
  DELETED and replaced with a mint-only assertion.
- `stages-panel.tsx:780-786` `swissHasUnseated` / `canUnpairSwiss` have no unit
  test; only e2e covers them — and e2e does not run pre-merge.
- `division-settings-derived-rounds.test.tsx`: the 4-locale render loop was
  deleted; three new `ui.json` keys ship with English-only render coverage.
- `scripts/smoke.ts` — the ONLY pre-merge signal, since `e2e.yml` triggers on
  push to `main` and not on PRs — contains **no Unpair at all**.
