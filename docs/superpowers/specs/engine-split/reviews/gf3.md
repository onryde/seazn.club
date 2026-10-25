# Engine split: GF-3 batch review (Opus, whole batch)

- **Range:** `2e0deaa6c1..f706628493`, 21 commits (T1, the T1 review fixes, T2, the T2 review fixes).
- **Worktree:** `seazn.club-worktrees/gf3`.
- **Reviewed:** 2026-10-25.
- **Saved by:** the orchestrator, because the reviewer cannot write repo files.

## Verdict: READY. 0 CRITICAL, 0 IMPORTANT, 2 MINOR, 6 NIT

Both rules hold, and both hard constraints for W2d hold.

- **T1.** The guard requires STATS_FOLD_VERSION to rise whenever a matched stream's playerStats move, and also when stats are newly recorded under touched fold source.
  - A major or minor bump does not settle it.
  - A fall is red.
  - The number is read fail-closed.
- **T2.** `foldOptions` is part of a stream's input identity and is validated. The recorder passes it to every fold, and the 16 award streams are wired through EXTEND.
- **Mutants.** The 4 weakest guards across both tasks were each mutated once, and each was killed by an assertion.
- **The two Minors.** Both come from the T1×T2 interaction, and neither blocks.

## Findings

| # | sev | file:line | problem | fix |
|---|---|---|---|---|
| m1 | MINOR | `scripts/fold-epoch-guard.ts:194` (`inputOf`), `:296-298`; `GOLDEN-POLICY.md:284-285`, `:511-515` | An award edit makes the stream re-recorded (removed and added), so its `playerStats` are never compared and no STATS_FOLD_VERSION rise is demanded. The policy's reason is that an input change makes the old and new stats "not comparable". That is false for this trigger, because the stats fold takes no fold options (`golden.ts:374-376`, `stats.ts:655-660`). Measured in B1/B2 below. 12 of the 16 award streams are the only stream of their ledger shape in their corpus. | When identity, config, events and lineups all match and only `foldOptions` differs, still count `statsDiffer` toward `statsMoved`. The sport still owes its major for the re-record. This has zero false positives, because an award never moves stats. Narrow the policy's reason, and add a pure test row and a CLI row for B1. |
| m2 | MINOR | `GOLDEN-POLICY.md:545-551`; `golden-fold-options.ts:295-300`; `golden-fold-options.test.ts:818-834` | The policy gives no route for the day the rebuild test goes red because `forfeitAwardOffer` changed. `foldOptionHoles` counts the old stream as reaching its story, so EXTEND appends nothing and the rebuild test forces a re-record. Each re-record owes its sport's major: up to four majors for a change that moved no fold. W2d Task 2 rewrites `forfeitAwardOffer`. | State the route. A value-preserving rewrite stays green and owes nothing. A value-changing one re-records the award streams of every sport it reaches, and each of those sports owes its major. |
| n1 | NIT | `scripts/fold-epoch-guard.ts:700` | The docstring cites `checkedFoldOptions`, which does not exist. The real names are `foldOptionsProblem` and `strictFold`. | Fix the name. |
| n2 | NIT | `GOLDEN-POLICY.md:286-289` | The declaration rule leaves out the trailing `//` comment the guard accepts. | Add "at most a trailing `//` comment". |
| n3 | NIT | `capture-s2-handoff.md:185-186` | The sentence about enforcement leaves out the re-record exception. | Add it. |
| n4 | NIT | `golden-fold-options.test.ts:512` | The title claims the offer equals `forfeitAwardOffer` for a real PointsRule, but the body checks only which sports record award streams. | Retitle it. |
| n5 | NIT | `test/fold-epoch-guard.test.ts:1756` | The test asserts at least 3 award streams per sport, but there are 4 now. | Derive the bound from `FORFEIT_AWARD_CASES.length`. |
| n6 | NIT | `GOLDEN-POLICY.md:326`; guard `:188-189`, `:297` | The table's major row does not say that STATS_FOLD_VERSION must also rise when playerStats moved. Two comments still describe the input as "events and lineups" or "events, lineups or config". | Update the row and the two comments. |

Carried, not in this branch: the T2 review's m5 (stale GF-3 lines in the format-matrix `_INDEX.md`) is owed to f-w2d.

## Hard constraints

1. **No corpus format 4, and FOLD_EPOCH major handling is unchanged.**
   - `CURRENT_FORMAT = 3` (`golden.ts:204`), and `parseCorpus` refuses anything other than 1, 2 or 3 (`:732`). All 11 corpora are format 3.
   - Against 2e0deaa6c1, `compareSport` differs only by two added counters (`:310`, `:314`). The `owes`, `majorRose` and reason block (`:331-379`) is byte-identical.
   - `epochViolations`, `loadTable` and `foldSourceTouched` are identical.
   - `inputOf`'s fourth element is `null` on both sides for every pre-GF-3 stream.
2. **Scope.** Outside `src/testkit/`, only the 4 sports' `*.golden.json` and `*.schema.json` files changed. `sport/fold-epoch.ts`, `competition/points.ts` and `stats/stats.ts` are untouched.
3. **Guard run.** It printed `fold-epoch: 11 sports checked, 421 streams compared against origin/main: 0 violation(s), STATS_FOLD_VERSION 6 -> 6` and exited 0, with `added 4` in each of the four sports. origin/main at 7dcb3c42e2 is 4 commits past the base. All 4 are apps/web only, and no engine path moved.

## T1 × T2 run

Scratch mirror of f706628493, guard run `--against HEAD`.

| run | change | result |
|---|---|---|
| A1 | football `default#80001` award [5,1] → [6,1], re-recorded | exit 1: removed 1, added 1, major owed. STATS moved in 0. playerStats byte-identical. |
| A2 | A1 + FOLD_EPOCH.football 2 → 3 | exit 0 |
| B1 | A2 + that stream's playerStats hand-moved | **exit 0**: the stats move is hidden (m1) |
| B2 | control: the same stats move, award kept, epoch 3 | exit 1: STATS_FOLD_VERSION must rise |

## Over-owing

- **What the rule is.** Any award edit is a re-record and owes a major. The major is per sport, limited to the reading sports the edit reaches; it is not product-wide.
- **What a major costs.** FOLD_EPOCH's only server consumer is the 426 ENGINE_OUTDATED gate (`apps/web/src/server/usecases/scoring.ts:689`). It applies only to clients that send `engine_epoch`, which means native apps and not the web pad. No stored state is refolded.
- **What does refold.** STATS_FOLD_VERSION is the one that refolds `player_stat_snapshots`, lazily, on first read (`usecases/player-stats.ts:135`).
- **Recommendation.** Keep the rule and document the route (m2). If an intentional value change ever lands, decouple the rebuild test (append fresh stories and keep the old pins) rather than paying the majors.

## Inert seam (class 1)

Nothing is inert.

- STATS_FOLD_VERSION is consumed by apps/web (`usecases/player-stats.ts:135`).
- The `ci.yml:132` guard step is still wired; the ci-wiring test passes 54/54.
- The EXTEND path runs floor, then branches, then fold options (`golden.test.ts:97-99`).
- Every replay path passes `stream.foldOptions`. The exception, `payloadParseFailures`, is documented and harmless.
- The pad's client fold does not pass the award (`competition.ts:357-358`). That is pre-existing W2c behaviour.
- The release-epoch report reads only the FOLD_EPOCH and FOLD_MINOR table. It does not announce a STATS_FOLD_VERSION rise (info only).

## Mutations

Each run once in a scratch mirror; only assertion failures count. The unmutated controls were green.

| id | mutant | result |
|---|---|---|
| MUT1 | `main` exits on sport rows only (guard `:861`) | KILLED, 8 CLI assertions (e.g. CLI `:1942`) |
| MUT2 | `holdsStruckPlay` accepts a voided core event (`golden-fold-options.ts:100`) | KILLED, `golden-fold-options.test.ts:596` |
| MUT3 | the withheld verdict compares only the outcome (`golden-fold-options.ts:197`) | KILLED, `golden-fold-options.test.ts:708` |
| MUT4 | `statsGainedUnfrozen` skips a stream that gained the kernel fields too (guard `:314`) | KILLED, `fold-epoch-guard.test.ts:1267` |

## Tests lie in names (class 4)

Of the 8 titles read against their bodies, 7 match. `golden-fold-options.test.ts:512` overclaims (n4).

## Gap hunt

- **New obligation for W2d.** Any recorded playerStats move owes STATS 6→7 even when a major is raised.
- **Corpora are single-line JSON.** On a rebase, re-record them; never hand-merge.
- **`foldOptions` on a non-reading sport.** It over-owes a major (fail-closed) and is refused in the committed corpora.

## Re-run (scoped, serial)

- **Brief files: 521/521.**

  | file | passed |
  |---|---|
  | guard | 174 |
  | CLI | 113 |
  | fold-options | 53 |
  | policy | 38 |
  | format | 55 |
  | floor-overlay | 34 |
  | ci-wiring | 54 |

- **Other golden tests: 328/328.** golden 133, stats 63, branches 34, overlay 43, slim 55.
- **Readers: 294 passed, 43 skipped (Postgres-gated).**
- **Total:** 1143 passed, 0 failed, 43 skipped over 20 files.
- **Static checks:** tsc 0. eslint 0 with each package's own config. `matrix:single-sport --check` passed.

## Draft PR line

`Matrix rows: none — GF-3 changes only the engine's golden harness (src/testkit), 16 appended golden streams in 4 sports and their schema snapshots, the fold-epoch guard script and docs; no engine source outside src/testkit, no FOLD_EPOCH/FOLD_MINOR/STATS_FOLD_VERSION value and no apps/web product code, so no format or stage rule a matrix row exercises moves.`
