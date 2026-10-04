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
| W1d | CI (weekly + dispatch, visibility guard) + first full truth run | **Plan `cff1e7176` (review-1, review-2 and review-3 fixes on `ed9801b60`), awaiting plan re-review** (2026-10-04): `docs/superpowers/plans/2026-10-04-format-matrix-w1d.md` on `docs/format-matrix-w1d-plan` off `main` `dfe8132da`. Owner rulings 60–67: GitHub weekly + dispatch, harness-green per §6.5, one plan and two PRs (PR-A Tasks 1–16 infra, PR-B Tasks 17–22 evidence), every ❌ keyed by gap ID, full scope L1 231 + L2 1,731 + L3 937. **D7 resolved by ruling 65** (no ░ applies to driven cases only; the merge judges with `--planned-not-run allow`). **Ruling 66:** the matrix proves formats and rules, not scheduling, so the placement container and greedy guard are removed. **Ruling 67:** Stryker covers the whole engine except placement scheduling, in ten groups sized from measured mutant counts and wall time. Sonnet for implementers and task reviewers, Opus for the two whole-branch reviews (owner). No owner question blocks a task. |
| W1-driving | L3 driving breadth W1a deferred: multi-stage seeding, team rosters, ladder/americano/mexicano, parallel workers, I2 champion rules for DE/stepladder/page-playoff | **Tasks 1–16 done 2026-10-01. Tasks 1–15 each closed on a clean review (Task 15 on re-review 1, Approved, after two fix rounds). Task 16's review: Needs fixes (0 Critical, 1 Important, 7 Minor); fix round 1 landed (T16-R3, T16-R4). Its re-review passed, and the final whole-branch review (the controller's, T15-R1) and its scoped re-review both Approved. MERGED as PR #912, merge commit `c347fedf9` (2026-10-01), and the worktree and branches were removed afterwards. The post-wave cleanup (rulings 55, 56, 58) is PR #913 (`67d6b1a8a`, 2026-10-04): the harness now lives at `tools/matrix`.** Plan `docs/superpowers/plans/2026-09-30-format-matrix-w1-driving.md` (rulings 44–54; the owner's 2026-10-01 decisions are rulings 55–59); prompt `W1-driving.md`. Worktree `format-matrix-w1-driving-exec` and branch `feat/format-matrix-w1-driving` were removed after the merge. **Done-when (ruling 48), on `truth-runs/w1drv-l3/results.json`** (`--set w1-driving --workers 4`, harness `15ed62365`, clean): 937 cases = 743 ✅ + 194 ❌; ⏳ naming W1-driving **0** (⏳ of any wave 0); harness ❌ **0** after triage — the 60 harness reds were three defects, each fixed test first (`9a64ec4cd`, `b1325f721`, `e51bf3699`), and 30 of those cases are ✅ on their re-run. **164 product reds**, each judged on its latest committed run (`truth-runs/w1drv-l3-rerun/`, `truth-runs/w1drv-l3-fr1/`, `truth-runs/w1drv-l3-fr2/`), 0 unfit, 0 unclassified, per wave **W2 62, W4 32, W7 56, W5 11, W3 3** (`truth-runs/w1drv-l3/TRIAGE.md`; before ruling T15-R4 moved the bracket-draw stall to W2: W4 94, W7 56, W5 11, W3 3). HTTP slice on 4 workers: 24/24 ✅, the 378 checks it shares with W1c identical in verdict and count (`truth-runs/w1drv-http-slice/results.json`). **L1 proof at 1280, ×3** (`truth-runs/w1drv-l1/w1drv-l1-t15-r1/results.json`, `-r2`, `-r3`, harness `63bda33e4`): 7 cases each, 6 ✅ and `mexicano\|generic` ❌ (the predicted W7 round-2 self-pair 500); r2 and r3 identical to r1 on every check, and r1 identical to T13's `w1drv-l1-r1` on all 206 checks; per-screen verdicts in `truth-runs/w1drv-l1/README.md`. Model (`truth-runs/w1drv-model/`): swiss\|badminton and swiss\|generic ok at 40 runs, league\|football ok at 20; of the six single-stage rows without model evidence, four ok, and double elim and stepladder each found a NEW product red, committed as MB-007 and MB-008; Task 16's widened-fence run found MB-009 (`w1drv-t16-model-g1`), then both cells ran ok (`w1drv-t16-model-g1c`), and `--regressions` replayed all 8 committed cases as known (`w1drv-t16-model-reg2`). **MB-010 (fix round 1, T16-R3):** with the double-elim generate fence narrowed to the added-entrant branch, the live double-elim cell found Start → Withdraw → Generate 500ing in MB-007's words (`w1drv-t16fr1-model-de`). It is committed as MB-010, and the fence's withdrawn branch now covers double elim on its evidence. Double elim then ran ok 20/20 (`w1drv-t16fr1-model-de2`), and `--regressions` replays all 9 committed cases as known, each under its own id (`w1drv-t16fr1-model-reg`). See "Findings routed (W1-driving)" and "W1d first tasks". The branch was rebased onto `main` twice (2026-10-01): every recorded harness SHA is pre-rebase and stays as recorded; `truth-runs/W1-DRIVING-REBASES.md` maps each to its rebased commit and shows the harness unchanged across both. |
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
    - **The package.** The harness lives at `tools/matrix` as `@seazn/matrix`; `tools/` is the home for dev-only
      harnesses (bench to follow; it did on 2026-10-04 as `tools/bench`, `@seazn/bench`, recorded in the bench
      programme's `_INDEX.md`). Choosing `tools/` over `packages/` was the controller's ruling (CL-R3, revised),
      not the owner's: the owner asked "tools or package?" and said the bench would follow later, and the
      controller ruled on that. `tools/*` is a pnpm workspace glob; the harness's manifest declares what it
      really imports. Nothing in `apps/`, `packages/` or `scripts/` may import `tools/**` or `@seazn/matrix`:
      the eslint rule from `scripts/lib/tools-import-guard.mjs` is the coarse layer, and
      `scripts/__tests__/tools-import-guard.test.ts` resolves every import exactly. Nor may they reach it at
      runtime: the same test refuses a root `package.json` dependency on a harness, and any string in those trees
      that names a root script whose command points into `tools/`. **Limit:** the guard reads imports, manifests,
      tsconfigs and root-script names. It does NOT see a `tools/` path passed as a string to `child_process`.
      Today only a grep holds that line: `git grep -E 'tools/(bench|matrix)' -- apps packages scripts` finds
      comments, the reference trap fixture and tests. The design fix is W1d first task 28 (owner, 2026-10-04). Code the gates share with the harness lives in
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
  - MB-007 and MB-010 share cell, check and words, so a replay now offers its own case to the matcher first
    (`5950801a3`). Otherwise MB-007 would claim MB-010's replay and the replay would read NOT REPRODUCED.
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
  class → **W1d** (m-3).
- Parity on the API-only set exits 1 by construction (`layers.ts:218-229`) → **W1d**, as a per-case planned marker
  (final review m-6).
- `l3Gap` is never recorded (carry 4) → **W1d**: record it, do not drop it (final review m-7).
- **F-PP-1, an UNEXPLAINED flake.** Pad proof 1280 r3, cricket: `pad-ledger-as-generated` ❌, tap 15 of 141 on
  fixture `dabf515d-99da-4a03-8e52-c3e052c611e3` timed out at the 15 s `FLOOR_MS`. Clean in the other six runs.
  Machine load is a hypothesis only. → **W1d**: capture tap timestamps or a trace on a tap-wait timeout before
  judging.
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
2. **Record the scope in `plan`.** `--layer L1` meant "the slice at 1280" in W1c and will mean the grid after W1d.
   Record the scope explicitly, for example `--layer L1 (slice)` (final review §4).
3. **A per-case planned marker** (m-6). `recordPlanned` writes an explicit marker, as an optional v3 field. Parity's
   `notDriven` keys on it, not on the LIFECYCLE mapping (`lib/parity.ts:184-188`), so parity on the API-only set
   stops reading its planned 🚫 rows as "missing". The same marker lets committed-matrix drop I-2's
   `durationMs === 0` heuristic. What it closes: a hand-flip of a driven case to ⏳/🚫 that keeps its duration and
   calls, with its fixtures and events zeroed, cannot be told from a real runtime ⏳/🚫 today. A flip that keeps
   fixtures or events already reds (`f33c1b312`), because the runner never writes that shape.
4. **`LayerCase.run` is an inert seam: record it** (m-7). Every case the layers build carries `run: null`
   (`layers.ts:105`, `:220`, `:255`, `:278`), and `run.ts` writes no `n` or `covers` into a result, so an L2 result
   cannot be mapped back to its committed `l2-pairs.json` run. Record `n` and `covers`.
   - **The premise changed in W1-driving** (Task 10's regen, `fe41d525a`). `l2-pairs.json` now holds 1,731 runs, and
     every `l3Gap` is null (`counts.json` `l2.l3GapRuns` 0). Run 514 is still `groups_ko|cricket|t20|M5@375`, but
     it carries no `l3Gap` now: ruling 44's cricket tie stream removed the M5 harness gap that marked it. If a later
     regen marks a run `l3Gap` again, its result must say that this run is the pair's only coverage.
5. **`NoLayerForWidth` exits 3, not 2** (m-3; T12). It is thrown inside `execute` and is not in `refused`. It cannot
   be reached today (`BROWSER_WIDTHS = [1280, ...L2_WIDTHS]`). Add it to `refused`, or resolve `layerOfWidth` in
   `runSlice`, the first time a width is added.
6. **One exit convention for unreadable input** (m-2). parity maps a missing file, bad JSON or a schema refusal to
   3; render maps the same class to 2. By the controller's ruling this is not changed in W1c: the W1d CI wrapper
   settles one convention.
7. **Typecheck `scripts/**/__tests__` in CI, with `vitest` resolvable** (m-4; T6/T8). `tsconfig.scripts.json`
   excludes `*.test.ts`. The three W1c test-file errors are fixed (`80f370e9f`). What remains is 5 errors in
   `scenarios.test.ts` that predate W1c. Test files that import apps/web also drag apps/web's `queue.ts` nodenext
   errors into a test-inclusive program (the "noisy scoped tsc").
8. **The pad replay's unwitnessed guards** (T7 minors 5, 6, 7 and 9; m-14):
   - `pad-replay.test.ts` asserts only budget constants for the replay's wait;
   - the fake ledger holds no rows at or below the server tip;
   - no test reaches the unseated-fixture guard in `browser-driver.ts`;
   - `padCheck` caps evidence at 12 lines with no "+N more". Hockey pad proof sits at exactly 12 fallback notes,
     and `_INDEX`'s per-adapter split was read from those lines.
9. **Pad adapter minors** (T9–11; m-15):
   - M-4: cricket's module-level `tapped` state. Document `MatrixPadAdapter.stepsFor` as one-shot per event.
   - M-8: pin the carrom coin bound (`max: 9`).
   - Mn-1: the `period.ts` `Number.isInteger` mutant.
   - Mn-2: `replay.ts:103`.
10. **Parity's `quiet` rule** (m-16; T13). It misses a browser error red that kept its checks (noise rows only; the
    verdict is unaffected), and its `h.state !== b.state` conjunct is unkilled.
11. **The playwright scan spellings** (m-17; T4 M-2/M-3). The scans match `spec === "playwright"` only, and the
    `FLAT` scan misses `setDefaultTimeout(<literal>)` and sleeps. No violation exists at HEAD.
12. **A run id reused with another `--report-dir` on the same DB** (m-18; C-1). Every case reds on an unnamed
    duplicate-slug error, because `RunIdReused` checks only the report directory.
13. **Page objects' first-control choice** (T8 m-2). Accepted; revisit only if W1d's full-grid L1 shows a hydration
    red.
14. **Per-case `layer`** is written but read by no production code. Pad proof at 320 records `L2` (the width band),
    so do not shard or count "L2" by this field without knowing it includes pad-proof runs (final review §4).
15. **Also routed to W1d above:**
    - F-PP-1 and pad proof's missing single-sport scope;
    - the match-day run sheet, never driven;
    - the sweep's fold branch, not recorded;
    - void, never driven in any browser run;
    - forfeit and withdraw on league and knockout cells in the browser (carry 8).

**Added by W1-driving (Task 16, 2026-10-01).** Each item below is routed to W1d by name:

16. **Cricket pad adapter routes for the two-innings events** (D13, ruling 52). These are `cricket.followon`,
    `cricket.match.close` and a declared innings. `pads/cricket.ts:66` refuses `inningsPerSide` 2 by name, and
    `pad-adapters.test.ts` sweeps single-innings requests only (Task 10). Until the routes exist, the 24 cricket
    `test` cases are proven over HTTP only.
17. **Browser workers inside a shard** (D10, ruling 46). `--driver browser --workers 2` is a usage error that names
    W1d (`run.ts:454`, `BROWSER_WORKERS`).
18. **`MAX_WORKERS` may rise inside a shard** (Task 11). It is 8, the local-env bound (`lib/workers.ts:25-28`; the
    prod DB budget note is 60 connections). Provisions take one run-wide turn each, because the staff flag and the
    sign-in links are per user. A cheaper entitlement bust, or a dedicated synthetic owner per shard, would lift
    that cap.
19. **One sign-in budget per shard under Redis.** No `--workers` refusal. See "Recommendations": with `REDIS_URL`
    set, the sixth magic-link sign-in from one IP inside 300 s answers 429.
20. **Templates in the grid.**
    - The W1d grid must pass the template for an ad-hoc `--driver browser --only <template cell>`, which fails by
      name today (Task 13).
    - Template competitions are created **public**: the gallery sends no visibility, and the schema defaults to
      `public`. A shard that reuses an org must allow for its public quota.
21. **Record the filler counts in `results.json`.** `filler` appears 0 times today, so the live filler proof is
    indirect, and the counts are proven only in unit tests (Task 13; `truth-runs/w1drv-l1/README.md`).
22. **A knockout-completion shot on multi-stage L1** (`truth-runs/w1drv-l1/README.md` (d)). The `groups_ko` case's
    `08-completed` is the group stage's completion, taken with the knockout's proposal pending. No check misreads
    it.
23. **Name team entrants "Matrix Team N", not "Matrix Player N"** (`truth-runs/w1drv-l1/README.md` (e)). This is the
    house constraint, and no check depends on it.
24. **Cosmetic: the americano policy note prints a team entrant's whole roster** ("of <id>+<id>+…", Task 15).
25. **Item 12 again, on the model CLI** (Task 16). A model run id reused against the same DB, after its report
    directory was removed, aborted on `organizations_slug_key` instead of refusing up front by name.
26. **Two committed cases that share cell, check and match make an exploring run's fence rule blind** (Task 16
    re-review 1). MB-007 and MB-010 share all three, so the narrowed-fence run (`w1drv-t16fr1-model-de`) labelled
    the new withdrawn-trigger failure `known: MB-007` and exited 0; MB-010 was found only by reading its commands.
    "A fence guards only what a committed case shows, else the bug reports NEW" does not hold for such pairs: make
    the matcher (or the exploring run's report) distinguish cases by their shown trigger, not only cell/check/match.
27. **CI truth runs: artifacts weekly, a triaged baseline committed** (ruling 58, clarified 2026-10-04). The matrix
    runs itself, weekly and on dispatch, sharded on fresh databases. A weekly run keeps its results as CI artifacts;
    only a triaged baseline is committed to `truth-runs/`. The trigger must NOT be GitHub `schedule:`, which drops
    and delays runs.
28. **Close the `tools/` import guard's spawn-by-path blind spot** (bench-move review M2, PR `chore/bench-to-tools`;
    owner 2026-10-04, asked in the controller's session whether to add it to W1d's list: "ok"). The guard reads imports,
    manifests, tsconfigs and root-script names, but not a `tools/` path passed as a string to `child_process`. Flag
    string literals passed to `exec`/`execFile`/`spawn`/`fork` and their `Sync` forms under `apps/`, `packages/` and
    `scripts/` whose path-like tokens resolve into `tools/`. Exempt the reference trap fixture and the guard's own
    tests by name, never by pattern. Needs a positive control and a non-zero scanned count. W1d builds it because W1d
    adds scripts that spawn the matrix.
