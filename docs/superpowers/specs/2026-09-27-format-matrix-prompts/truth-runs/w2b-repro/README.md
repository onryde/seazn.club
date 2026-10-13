# W2b reproduction: every W2b red, before any fix

The first evidence run of W2b (plan `docs/superpowers/plans/2026-10-09-format-matrix-w2b.md`, Task 1; spec
`docs/superpowers/specs/2026-10-08-format-matrix-w2b-design.md` §8.2) records each W2b gap red on today's code, with its
gap id, before any product change on the branch. Every expected value comes from the spec's Appendix A or the rulebook;
none is read from today's code.

## The run

| | |
|---|---|
| branch | `feat/format-matrix-w2b` at `46251836c` (docs-only commits over main `a99147bd0`); no product change |
| database | a fresh Postgres from `seazn-env up --label w2b --all` (Flyway to v432, then `sync:sports`); `show data_directory` printed `/tmp/seazn-env/w2b/pg`, the label's own datadir, exported as `BENCH_EXPECTED_DATA_DIR` |
| server | the label's production standalone build of this worktree, `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000` |
| placement | the label's own native service |
| env label | `w2b` |

## Result

| layer | file | total | red | green | collection |
|---|---|---|---|---|---|
| engine probes | `packages/engine/src/core/w2b-repro.probe.test.ts` → `probes-engine.json` | 10 | **10** | 0 | clean |
| server probes | `apps/web/src/server/__tests__/w2b-repro.probe.test.ts` → `probes-web.json` | 12 | **12** | 0 | clean |
| L3 cells (CD-T13) | `L3/w2b-repro-1` … `-5` | 5 | **5** | 0 | — |

`numFailedTestSuites` is 2 in each probe report and that is not a collection failure: vitest 4.1.11's JSON reporter
counts the file and its `describe` as suites and marks both failed when a test inside fails. Collection is judged by
`.testResults[].message` (empty in both) and `numTotalTests` (10 and 12, the expected counts).

With the gate closed (no `W2B_REPRO`), both files collect with every test skipped: engine `total 10, failed 0, pending
10`, server `total 12, failed 0, pending 12`, exit 0 each.

## The reds, one row per probe and cell

The first line of each red, verbatim from the reports (server probes compare all their facts as one object and print
today's facts first, because the JSON reporter elides a nested diff).

| gap | file · probe | red, first line | owner |
|---|---|---|---|
| H-13 | engine · `H-13: a hockey walkover credits 5-0 …` | `AssertionError: expected { gf: 3, ga: +0, gd: 3, pim: +0, …(5) } to match object { gf: 5, ga: +0 }` | Task 4 |
| F-16 / H-14 / I-16 / SC-S4 | engine · `F-16 / H-14 / I-16 / SC-S4: … keeps the real score …` | `AssertionError: football: expected { gf: 3, ga: +0, gd: 3, …(3) } to match object { gf: 5, ga: +0 }` | Task 4 |
| SC-S3 | engine · `SC-S3: a 3-set volleyball walkover credits the winner 2-0 sets, each 25-0 …` | `AssertionError: expected { sets_won: +0, sets_lost: +0, …(2) } to match object { sets_won: 2, sets_lost: +0, …(2) }` | Task 4 |
| SC-S6 | engine · `SC-S6: a double walkover is its own outcome in every sport …` | `EngineError: unknown entrant "both"` | Task 3 |
| B-7 | engine · `B-7: a chess walkover is recordable before the game starts …` | `EngineError: forfeit not allowed in phase "pre"` | Task 3 |
| B-9 | engine · `B-9: a chess double forfeit is a double walkover in a league …` | `AssertionError: expected { kind: 'no_result' } to deeply equal { kind: 'double_walkover' }` | Task 4 |
| B-10 | engine · `B-10: … in a knockout, never held …` | `AssertionError: expected { kind: 'no_result' } to deeply equal { kind: 'double_walkover' }` | Task 4 |
| C-6 | engine · `C-6: a carrom abandon is a replay — no outcome, no shared points …` | `AssertionError: expected { kind: 'no_result' } to be null` | Task 4 |
| CR-10 | engine · `CR-10: a cricket walkover charges the defaulter its full quota …` | `AssertionError: expected { runs_for: +0, …(6) } to match object { runs_for: +0, balls_faced_eff: 120 }` | Task 4 |
| SC-S3-TN | engine · `SC-S3-TN: a tennis walkover credits straight sets …` | `AssertionError: expected false to be true // Object.is equality` | Task 4 |
| ST-G1 | server · `ST-G1: a cricket DLS abandon in a league scores in the table …` | `today: {"status":"abandoned","won":[0,0]}` | Task 7 |
| CR-2 | server · `CR-2: a cricket rain no-result in a league is 1 point each and an NR …` | `today: {"status":"abandoned","points":[0,0]}` | Task 7 |
| ST-G1b | server · `ST-G1b: a football award-policy abandon with a leader is a win …` | `today: {"status":"abandoned","homeWon":0,"awayLost":0}` | Task 7 |
| C17 | server · `C17: withdrawing from a held knockout fixture walks it over …` | `today: {"status":"needs_decision","winner":null,"inFinal":null}` | Task 8 |
| PP-WD | server · `PP-WD: a page_playoff withdrawal walks over, never holds …` | `today: {"status":"abandoned","abandons":1,"winner":null}` | Task 8 |
| LD-WD | server · `LD-WD: a ladder withdrawal walks the pending challenge over …` | `today: {"status":"abandoned","abandons":1,"winner":null}` | Task 8 |
| X-WD-3 | server · `X-WD-3: withdrawing from a fixture whose opponent is TBD does not throw …` | `EngineError: fixture has an unassigned entrant (bye/TBD)` (`WRONG_PHASE`, `append-event.ts`) | Task 8 (D17) |
| CD-T13 | server · `CD-T13: a chess knockout withdrawal on an unstarted board walks over …` | `EngineError: forfeit not allowed in phase "pre"` | Task 8 |
| CD-T13-SW | server · `CD-T13-SW: a Swiss chess withdrawal on an unstarted board walks over …` | `EngineError: forfeit not allowed in phase "pre"` | Task 8 |
| DE-RK | server · `DE-RK: a double-elimination forfeit loser is out; seating and ranks agree …` | `today: [{"sport":"badminton","seatedInLosers":0,"completed":true,"rankOfOut":4,"ranked":4},{"sport":"boardgame","seatedInLosers":2,"completed":true,"rankOfOut":1,"ranked":4}]` | Task 7 |
| AA-FIN | server · `AA-FIN: auto-advance treats a finalized fixture as finished …` | `today: {"group":["finalized"],"koFixtures":0,"koSeated":0}` | Task 7 |
| X-WD-5 | server · `X-WD-5: a settle never seats a withdrawn loser on a loser edge` | `today: {"seat":"B4","status":"scheduled","winner":null,"withdrawn":"B4"}` | Task 7 lists it red; Task 8 owns X-WD-5 |
| CD-T13 | L3 · `knockout\|boardgame\|blitz\|R4` | `red`: `POST /api/v1/entrants/<id>/withdraw → HTTP 422 WRONG_PHASE: forfeit not allowed in phase "pre"` | Task 8 (unpinned in Task 16) |
| CD-T13 | L3 · `knockout_third_place\|boardgame\|blitz\|R4` | same | same |
| CD-T13 | L3 · `double_elim\|boardgame\|blitz\|R4` | same | same |
| CD-T13 | L3 · `ko_plate\|boardgame\|blitz\|R4` | same | same |
| CD-T13 | L3 · `qualifying_main\|boardgame\|blitz\|R4` | same | same |

What the first line does not show:

- **F-16 / H-14 / I-16:** the loop stops at football. A scratch fold of the same stream (not committed) gives the other two
  red as well: hockey, 7 goals then a retirement, credits 0-3; ice hockey credits 0-5.
- **SC-S6:** 10 sports refuse `by: "both"` `INVALID_EVENT` ("unknown entrant"); boardgame refuses it `WRONG_PHASE`
  ("forfeit not allowed in phase pre"), the B-7 refusal.
- **CR-10:** the winner's half (all four NRR operands 0) already holds; the defaulter's `balls_faced_eff` is 0, not 120.
- **SC-S3-TN:** games 0-0 already holds; `sets_won` is 0.
- **X-WD-3:** the withdrawal throws before the entrant is withdrawn, so seed 1 stays `registered`. The rig is six entrants
  in an eight-line draw: seeds 1 and 2 have byes, and the round-2 line `se-r1-i0` is `B1 v TBD`.
- **DE-RK:** the badminton half is already right (see the false premise below); the red is the chess half, where the
  forfeit loser sits in two losers'-bracket lines and, winning out, is ranked first.
- **The five L3 cells** fail no check (`failing []`): each ends in the case-level error above.

W2a's judge, given only the five W2b re-keys (a scratch filter of `../w2a-repro/expect-77-rekeys.json`) and these five
runs, exits 0: `expected 5, found 5: 0 works, 5 red as pinned, 0 greened; 0 unexpected red, 0 wrong reason`.

## False premises found (also in `_INDEX.md`, "False premises found (W2b)")

1. **DE-RK, spec §13 premise 8.** "Seating and ranks disagree on an `award` loser in double elimination" is false for the
   `award`. A badminton walkover loser is seated in no losers'-bracket line (`advancingSides` takes no loser from an
   award), and `bracketRanks` ranks it 4th of 4 (its one loss is the earliest), so the two agree today. The real X-DE-1
   red is chess: boardgame folds `core.forfeit` to `win{method: "forfeit"}`, which seats the forfeit loser on the loser
   edge like any loser. The probe keeps both shapes; the badminton half is a regression.
2. **C17 rig.** The brief's "badminton … reaches `needs_decision` through an abandon with a level outcome" is
   unreachable: `fixtureStatusFromFold` answers `abandoned` for any active abandon before it reads a level result, and
   badminton has no level result. The probe holds the semi the way W2a's suite does: football 0-0 at full time.
3. **The truth-run selection.** `only: "<caseId minus |R4>"` (`row|sport|variant`) is refused by `matrix:l3`
   (`UnknownFilter`, `EXIT=2`): `--only` takes `<row>|<sport>`. The selection holds `row|sport` plus the judged `caseId`
   (the w1-driving set drives boardgame at blitz).
4. **The judge line.** It reads `.verdict` from one `$OUT/L3/results.json`; each run writes `$OUT/L3/<run-id>/results.json`,
   and a case's verdict is `.state`.
5. **`pnpm matrix:lock --append` does not exist.** The lock entries come from `committed-matrix.test.ts`'s missing-entry
   failure, appended as printed (W2a Task 1's procedure); `pnpm matrix:lock-check --against HEAD`: 258 compared, 5 added.
6. **"failedSuites 0" for a red.** It cannot hold under vitest 4.1.11 (see Result).

Smaller deviations, not premises: `listStandings` is `getStandings(auth, stageId)` (`stages.ts`); X-WD-3 uses six
entrants because a draw of eight has no bye; AA-FIN uses a league first stage (the auto-progress rig of
`format-ext.test.ts`), since the open count reads the stage's fixtures whatever its kind; the Global Constraints loop
`".browserShards.$L[]"` is "invalid subscript" in zsh (`${L}` runs it); the X-WD-5 probe settles only while the semi is
still held, so it reads the same once W2b walks the hold over.

## Commands

Environment (`S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`, `WT` the worktree):

    cd $WT && $S up --label w2b --all
    cd $WT && eval "$($S env --label w2b)" && psql "$DATABASE_URL" -Atc "show data_directory"     # /tmp/seazn-env/w2b/pg

The probes, gate open, then closed:

    cd $WT/packages/engine && W2B_REPRO=1 pnpm vitest run src/core/w2b-repro.probe.test.ts --reporter=json --outputFile=$TMPDIR/w2b-t1e.json
    cd $WT/apps/web && eval "$($S env --label w2b)" && W2B_REPRO=1 pnpm vitest run src/server/__tests__/w2b-repro.probe.test.ts --reporter=json --outputFile=$TMPDIR/w2b-t1.json
    cd $WT/packages/engine && pnpm vitest run src/core/w2b-repro.probe.test.ts --reporter=json --outputFile=$TMPDIR/w2b-t1g.json

The five cells (the Global Constraints truth-run command, `<tag>` = `repro`, selection `../w2b-local-selection.json`;
every line printed `EXIT=0`):

    pnpm matrix:l3 --set w1-driving --only "<row>|boardgame" --scenario R4 --workers 4 --run-id w2b-repro-<i> --report-dir $TMPDIR/w2b-local-repro/L3

and the judge:

    for f in $TMPDIR/w2b-local-repro/L3/*/results.json; do jq -r '.cases[] | select(.caseId|test("\\|boardgame\\|blitz\\|R4$")) | [.caseId,.state,(.reason // "")] | @tsv' "$f"; done
    node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/w2a-expect.ts --expect <the 5 ids> --rekeys <the 5 W2b re-keys> --now <each results.json>

Evidence integrity: `tools/matrix/__tests__/committed-matrix.test.ts`, 28 of 28 green with the five lock entries.
