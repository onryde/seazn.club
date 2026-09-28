# Format × sport matrix — programme index

Decision log and session status. Read `_RULES.md` beside this file first.

- **Design of record:** `../2026-09-27-format-matrix-design.md`
- **Audit inputs (hypotheses, not facts):** `audit-2026-09-27/`
- **Cross-programme sequencing:** `../bench-product-value/_MASTER.md`

## Status

| Wave | Scope | State |
| --- | --- | --- |
| W1a | L3 core: lean runner, HttpDriver, 11 stream generators, invariants, MATRIX generator | **Tasks 1–11 done; final review (R21) fix batch landed and re-reviewed 2026-09-28: ready to merge (27/27 findings fixed, 0 new Critical/Important); CI green at `12029f214` (matrix step 1251/1251).** Live re-run after the batch: 24/24 ✅ at harness `e96a51ff1` — a pre-rebase SHA; its `scripts/matrix` is byte-identical to `61f8e19b7` on the rebased branch (run `fm-w1a-fix-b`, evidence `truth-runs/w1a-slice/`, schema v2), all three canaries red on their own check only — see "W1a session status" below. Worktree `format-matrix-w1a`, branch `feat/format-matrix-w1a`, PR #896 |
| W1b | Catalogues (atomic cases, applicability, variants, pairs) + reference skeleton | **in progress** — plan `docs/superpowers/plans/2026-09-28-format-matrix-w1b.md` (rulings 25–30), executing subagent-driven on `feat/format-matrix-w1b` |
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
