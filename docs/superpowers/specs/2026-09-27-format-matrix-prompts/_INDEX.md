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
| W1c | Browser layers: page objects, 11 pad adapters, L1/L2 | not started |
| W1d | CI (weekly + dispatch, visibility guard) + first full truth run | not started |
| W1-driving | L3 driving breadth W1a deferred: multi-stage seeding, team rosters, ladder/americano/mexicano, parallel workers, I2 champion rules for DE/stepladder/page-playoff | not started (ruling 28) |
| W2 | Sport scoring fidelity | not started |
| W3 | Swiss | not started |
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
  `scripts/matrix/__tests__/committed-matrix.test.ts` keeps the two equal (R10).
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
| L1 | cells × 2 widths (1280, 320) | **462** |
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

**Regressions committed** (`scripts/matrix/catalogue/regressions.json`, all
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

## Session prompts

One per wave, beside this file. Each carries its read-first list, prerequisites,
routed gaps (copied from design §8), lifecycle, decisions owed, done-when and
traps.

- [W1a — L3 core](W1a-l3-core.md)
- [W1b — catalogues + reference skeleton](W1b-catalogues-reference.md)
- [W1c — browser layers](W1c-browser-layers.md)
- [W1d — CI + first truth run](W1d-ci-truth-run.md)
- [W2 — sport scoring fidelity](W2-scoring-fidelity.md)
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
    importing `scripts/bench/lib/plan.ts` transitively loads the pack schema
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
    (`scripts/bench/lib/env.ts:244-252`). The matrix runs its own guard first,
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
  `scripts/matrix/` for every shipped `.ts` and has no module list. Task 1
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
  (`scripts/matrix/lib/scenarios/lifecycle.ts:9`); a page playoff needs
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
