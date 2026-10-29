# W2 truth run (W2e Task 35, lane W, PR B)

The last proof that every matrix row W2e touched works through the real product, and the first full CI run since W2b.
Branch `feat/format-matrix-w2e-b` (PR #1069). Brief: `.superpowers/sdd/2026-10-28-format-matrix-w2e/task-35-brief.md`.

**Verdict.** L1 and L2 judge clean (EXIT 0, 0 regressions). **L3 judges EXIT 1 with 2 regressions, both the SW-H1
lots flip** (below): one is owner ruling 70's cell, the other is the same mechanism on a cell the ruling does not name.
No W2e cell is red: all 10 `W2E_*` scenarios are 152/152 `works`, every `w2e-*` check passes with `checked > 0`.
The run found and fixed **one real harness defect** (below, F1), which had reddened 174 of the 176 browser-driven L1 cells.

## The runs

| run | what | harness commit | result |
|---|---|---|---|
| CI **40869943107** (not committed; the false-red run) | `matrix-truth.yml` `scope=full` on `763fff74f6` | `763fff74f6` | L1 174/229 red, L2 62 red, L3 98 red. 149 + 40 L1/L2 regressions, **every one** `builder-posted-as-harness: ... rngSeed` (F1). 1 L3 regression: `swiss_playoff\|generic\|score\|R4` (F2) |
| CI **40874582041** (`ci/`, the committed one) | `scope=full` on the F1 fix | `080186e92c` (`080186e92c2b80116d2d1b173dff6f75662a05a8`) | 15/15 jobs success. L1 229 cases (176 driven: 166 works, 10 red), L2 1729 (62 driven: 43 works, 19 red; 1522 planned), L3 930 (831 works, 99 red). "Run complete: yes", harness faults none |
| `local/L3/w2e-final-new-<key>` | the 10 `W2E_*` scenarios, one HTTP run each (`pnpm matrix:l3 --set w1-driving --scenario KEY --workers 4`) | `763fff74f6` (HTTP only: the F1 fix is browser-only) | table below |
| `local/L3/w2e-final-slice` | the plain slice (`pnpm matrix:l3`, 24 cases), the evidence `parity.test.ts` now reads | `b6639bcc55` | 24/24 works; badminton is `bwf-3x15` |
| `local/B1/w2e-final-pad-so-football-2` | the football shoot-out through the real pad, browser at 1280 (`pnpm matrix:browser --width 1280 --set w1-driving --only 'knockout\|football' --scenario W2E_SO`) | `080186e92c` | works: 30 checks, 20 pass, 10 abstain, 0 fail; 543 calls over 7 fixtures, 119 events (its `shots/` are gitignored) |

Local environment: a fresh Postgres from `seazn-env up --label w2e-eb-t35`, `show data_directory` = `/tmp/seazn-env/w2e-eb-t35/pg`
(the label's own, exported as `BENCH_EXPECTED_DATA_DIR`); a fresh production standalone build (`seazn-env rebuild`, turbo cache
miss, 0 files with `phc_`, `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` baked); the label's own shared placement service.

### The 10 W2E scenarios (HTTP, L3)

| key | cases | works | red | `w2e-every-match-*` checked (sum) |
|---|---|---|---|---|
| W2E_ET | 8 | 8 | 0 | 67 |
| W2E_SO | 24 | 24 | 0 | 201 |
| W2E_OT | 8 | 8 | 0 | 67 |
| W2E_SUPER_OVER | 8 | 8 | 0 | 67 |
| W2E_DLS | 8 | 8 | 0 | 67 |
| W2E_DECIDER | 24 | 24 | 0 | 201 |
| W2E_CAP | 8 | 8 | 0 | 67 |
| W2E_TB_SET | 24 | 24 | 0 | 201 |
| W2E_SHORT_SETS | 16 | 16 | 0 | 134 |
| W2E_SANCTION_END (`w2e-every-match-ended-by-sanction`) | 24 | 24 | 0 | 174 |

Each run printed `error reds: none` and `vacuous: none`. 152 cases, 152 `works`; every case's `w2e-*` check is `pass`
(none `abstain`, none `fail`).

## Findings

### F1: the browser driver's `builder-posted-as-harness` was red on every bracket cell (fixed, `080186e92c`)

`builderVsHarness` diffed the builder's stage config against the harness's bodies key for key. The create door has added two keys
the harness never posts: an `rngSeed` on every stage (W2d Task 10, a random 31-bit integer) and, on a stage whose kind and variant
declare one, the sport's preset `rules` (W2c Task 12). Its unit tests built the "product's" stages *from the harness's own bodies*, so
both ends said the same thing and the check never met a real door. CI 40869943107's L1 showed it: 174 of 176 driven cells red on
`stage[1].config.rngSeed: built N, harness (absent)`.

The check now compares against what the door **stores** for the body (the product's own `storedStageRules`, imported, never a table
typed here); `rngSeed` must be an integer in [0, 2^31) unless the body posted one (then it is a posted key and must be equal). Anything
else extra, or a rule the door would not store, still fails, each named. Tests: a counted sweep over every sport and template row
(the door's stages equal the bodies in all of them, with presets among them), three negative rows per door-owned key, and the
posted-seed pair. Mutants: no preset rules, seed always valid, posted seed dropped: each killed. Driven through the real product too:
`knockout|football`, `groups_ko|football`, `knockout|cricket` and `double_elim|hockey` at 1280 were red before and `works` after.
CI 40874582041 then showed L1 166 works / 10 red (the 10 are baseline reds: the Mexicano generate-500 cells) and L2 43 works / 19 red
(the baseline's 43 and 19).

### F2: SW-H1 lots flips (judge L3, EXIT 1, 2 regressions): not a W2e defect, W3's

Both regressions read `I4-nothing-ends-stuck: stage 1: round 5 paired nobody (SW-H1)`, the dead end owner ruling 70 records
(P6, SW-H1, W3: the product's lots tiebreak hashes per-run entrant ids, so which cells dead-end differs run to run).

| regression | in owner ruling 70's list? |
|---|---|
| `swiss_knockout\|carrom\|club-29\|R4` | **yes** (carrom) |
| `swiss_playoff\|football\|11-a-side\|R4` | no (the ruling names exactly three cells), same mechanism and the same triage rule family |

The cells flip across every run we hold (`ci-` run ids, L3 state):

| run | `swiss_knockout` football | carrom | generic | `swiss_playoff` football | generic |
|---|---|---|---|---|---|
| 37346206686 (W1d dispatch 3) | red | works | works | works | red |
| 37916609028 (W2a) | works | works | works | works | red |
| 38362040946 (W2b) | red | works | works | works | works |
| 40869943107 (this run, CI 1) | works | works | works | works | red |
| 40874582041 (this run, CI 2) | works | **red** | works | **red** | works |

Local repeats of `swiss_playoff|generic|score|R4` on the same tree: works, works, works, **red**, works, **red** (2 of 6). Nothing
in W2e touched Swiss pairing. There is no way to judge this layer to EXIT 0 against the W2b baseline without hiding the flip
(the judge refuses a `--now` with cases the expect list omits), so the verdict is recorded as it fell; the controller can accept it as
W2b's was accepted (`../w2b-final/README.md`, ruling (a)), or re-dispatch. `judge-L3-vs-w1d-r70` (W2b's second judge, which applied
the ruling) cannot be reproduced: the ruling-70 block now qualifies this run, not the W1d one (see "The re-baseline").

### F3: the SW-H1 triage rules were stale since W2a (fixed in this task)

Since W2a the SW-H1 reds also fail `life-bracket-decider-exercised` (the Swiss stage never completes, so the bracket after it posts no
decider). The two `swiss-round-paired-nobody-*` rules in `catalogue/triage-rules.json` close their `failing` set at two checks, so every
SW-H1 red in W2a/W2b/W2e evidence was **untriaged**. The retirement guard in `baseline-ruling70.test.ts` triages the baseline and needs
its red ruling cell keyed, so the rules now carry the third check. **24 other reds in this run remain untriaged**, as they were in
W2b-final (the F1 group_group_ko `life-built-as-posted` family, 12; the `stepladder_only` R4 `life-built-as-posted` family, 12): not this
task's, listed for the owner.

## The judges (`pnpm matrix:judge regression`, baseline = `../w2b-final/ci/<L>/results.json`)

| file | layer | EXIT | compared | skipped (expected / unexpected) | regressions |
|---|---|---|---|---|---|
| `judge-L1.json` | L1 | **0** | 209 | 22 / 0 | 0 |
| `judge-L2.json` | L2 | **0** | 1625 | 104 / 0 | 0 |
| `judge-L3.json` | L3 | **1** | 845 | 92 / 0 | **2** (F2) |
| `judge-L1-badminton-twins.json` | L1, the renamed `bwf` cells | 0 | 20 | n/a (`--sample`) | 0 |
| `judge-L2-badminton-twins.json` | L2 | 0 | 84 | n/a | 0 |
| `judge-L3-badminton-twins.json` | L3 | 0 | 83 | n/a | 0 |

`expect-<L>.json` is each run's own case ids; `skips-<L>.json` is the baseline ids the run no longer holds, 22 / 104 / 92, by class:

| class | L1 | L2 | L3 |
|---|---|---|---|
| badminton `bwf` renamed by the 3x15 default to `bwf-3x15` (BD-VR-1) | 20 | 84 | 83 |
| chess americano / mexicano blitz, refused since #1027 (chess is individual-only) | 2 | 0 | 8 |
| L2 M4b variant slots re-picked (20 out, 20 in, all planned `not_run`) | 0 | 20 | 0 |
| cricket `test` case ids re-numbered by the 25th case (`league\|cricket\|test\|LIFECYCLE\|cricket#107` out; `league_ko…#107` and `league…#113` in, both `works`) | 0 | 0 | 1 |

The brief asked for `skips-<L>.json` to list only the badminton renames and for `bwf` to be "judged explicitly so its cells stay
compared". The other three classes are real id changes from earlier waves and are listed rather than hidden (the judge refuses any
unlisted skip). The renamed badminton cells **are** compared: each baseline `bwf` case is paired with its `bwf-3x15` twin (187 of 187
have one), and the real judge is run over the pairs (`--sample`, derived inputs in the scratch directory only). All 187 hold the same
state as their baseline twin (L3: 74 works and 9 red in both). The runner has no flag to run an L3 case on the explicit old `bwf`
variant (variants are the builder default or a catalogue case), so a literal `bwf` L3 run is **not built**; L2's grid still runs `bwf`
cells (3 compared `works`, in `judge-L2.json`).

`judge-L*.json` carry `"sample": false` (T18 M1: the verdict file says which mode judged it; `true` under `--sample`, absent in
`faults` and `across`). The faults verdicts of the CI run are `ci/L*/judge.json`: EXIT 0, 0 faults, 229 / 1729 / 930 compared.

## The 12 red tests (and the 13th)

All were red for the same reason: evidence recorded before the badminton 3x15 default and the 25th cricket `test` case. None was
repaired by hand-editing evidence or lowering a floor.

| file | before | after | what moved |
|---|---|---|---|
| `baseline-ruling70.test.ts` | 23/27 | 27/27 | the baseline (below) |
| `pr-sample.test.ts` | 66/68 | 68/68 | the baseline; one path pin moved to `w2e-final/ci/L3` |
| `run-sample.test.ts` | 35/39 | 39/39 | the baseline |
| `parity.test.ts` | 27/28 | 28/28 | `ranVariant` now reads `w2e-final/local/L3/w2e-final-slice` (regenerated through `pnpm matrix:l3`); the v2-shape test still reads `w1b-slice` as the v2 evidence it is |
| `pad-cricket-innings.test.ts` | 10/11 | 11/11 | reads `w2e-final/ci/L3` (25 cricket `test` cases, asserted against the catalogue's 25) instead of `w1drv-l3` (24) |
| `judge.test.ts` (the 13th, not in the brief) | 1 red | 87/87 | the plan-ids match reads `w2e-final/ci/L3` (930 = the planner's); the older chess-refused set-aside is now its own test on `w1drv-l3`, with the teeth kept |

(The final scoped run, with every file that reads what this task changed, is in the report.)

### The re-baseline

The PR sample plans `bwf-3x15` ids; the W1d baseline holds no twin for them (it holds the old `bwf` ids), so the sample, in CI on every PR, would refuse.
`catalogue/baseline.json`'s `L3` now names `w2e-final/ci/L3/results.json` (run 40874582041), and the ruling-70 block was **carried
forward by hand with the new run's provenance**, as `lib/pr-sample.ts` instructs: `workflowRun` 40874582041, `tag`
`feat/format-matrix-w2e-b` (no git tag was cut: the field is a label and `tagCommit` pins it), `tagCommit`
`080186e92c2b80116d2d1b173dff6f75662a05a8`. The ruling and its three ids are unchanged. Consequences, each handled:

- The retirement guard needs a red *and* a works among the ruling's three cells in the new baseline: football works, carrom **red**,
  generic works. (Had CI 2 shown all three works the guard would have said to re-run L3, as its message does.)
- `baseline-ruling70.test.ts`: the W1d three-dispatch record (`HARNESS-GREEN.md`, `dispatch-cuts.json`) that *justifies* the ruling is still
  asserted, now against `w1d-baseline` as history; the baseline the judge reads is the new one. The over-reach controls are derived from
  the baseline (7 held `swiss_knockout` R4 cells outside the ruling in this baseline; the W1d prose names six), with a floor of six.
- `lib/backlog.ts` (the W1d backlog, byte-for-byte in `_INDEX.md`) refuses a ruling-70 block that does not qualify the L3 it counts, so
  re-baselining broke `backlog.test.ts` and `w1d-backlog-index.test.ts` (107 tests, collect failures). The backlog now reads the
  `baseline.json` its own baseline directory carries when there is one, and `w1d-baseline/baseline.json` is that file: **a byte copy of the
  previous `catalogue/baseline.json`** (`git show 763fff74f6:tools/matrix/catalogue/baseline.json`), added, not an edit of evidence. A test
  pins the decoupling with teeth (a stale record is refused by name); the mutant that ignores the record fails to collect.

## The carries owed to this run

| carry | verdict |
|---|---|
| **T19 kick tap route** | **Driven live.** `local/B1/w2e-final-pad-so-football-2`: the first fixture's 17 events (core.start, 4 `football.period`, **12 `football.shootout.kick`**) went through the real pad; `pad-ledger-as-generated` pass, 17 items, `w2e-every-match-took-the-path` pass (7), `mixed-driver-coverage` pass (9 actions in the browser), `visual-evidence` and `no-horizontal-scroll` pass (25). The DB holds 84 kicks over the 7 fixtures. |
| **T18 M1** (the judge output shows the sample mode) | **Done** (`b6639bcc55`): `sample` in `JudgeOutSchema`, set by the regression mode; read in `judge-L*.json` above (`false`) and in the twins files (`true`). |
| **M12b retirement** (football, volleyball, hockey, ice hockey) | **Not built, because** the matrix's `TapStep` has no person-pick and the L2 fixtures are rosterless, so the pad's "Injured, no sub" tile cannot be driven by the harness. The control is covered by unit tests in all four sports and by `apps/web/e2e/scorepad-v3-retirement.spec.ts` for **football and hockey only** (volleyball and ice hockey have no e2e). **No e2e run exists on this branch yet**: it needs a `workflow_dispatch` on PR B's HEAD. |
| **W2E_DLS, the pad's revise with DLS on** | **Not built, because** no cricket variant has DLS on and the pad's interruption/revise control is the chassis's generic More sheet, which has no testid (`CRICKET_NO_CONTROL`), so the matrix has no pad route to it. What is proven: L3 `W2E_DLS` (8/8, the umpires' manual target through the API) and the e2e `scoring.spec.ts` "cricket DLS scales a five-ball-over format" (revise with DLS on through the API, then the pad scorebug reads "DLS par 84"). Not proven by anything: a scorer tapping the More sheet's revise with DLS on. |

## For the owner

1. L3 EXIT 1 (F2): accept as W2b's was, or re-dispatch. SW-H1 is W3's.
2. Whether swiss_playoff R4 belongs in ruling 70 (it flips the same way; the ruling names exactly three cells).
3. M12b on volleyball and ice hockey has no e2e; the pad's DLS-on revise has no driver at all.
4. 24 reds remain untriaged (F3).
5. The `tag` in the ruling-70 block is a branch name; cut `matrix-truth/w2e-final` at `080186e92c` if the label should be a tag.

## Reproduce

```
pnpm matrix:judge regression --baseline truth-runs/w2b-final/ci/<L>/results.json --now truth-runs/w2e-final/ci/<L>/results.json \
  --expect truth-runs/w2e-final/expect-<L>.json --expected-skips truth-runs/w2e-final/skips-<L>.json --json-out judge-<L>.json
pnpm matrix:lock-check --against 763fff74f6      # 286 compared, 15 added, EXIT 0
```
