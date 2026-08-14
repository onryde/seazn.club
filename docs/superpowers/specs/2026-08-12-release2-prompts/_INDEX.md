# Release 2 (scheduling) — session index

**One session per row.** Read `_RULES.md`, then this file, then the session's
prompt file. This file is the compaction anchor: every ruling, false premise,
and status change gets written here **as it happens**.

> **Naming collision warning:** `C#` here numbers *release-2* sessions. It is
> NOT the #21 contract programme's C-task numbering (C1/C4/C6) that
> `services/placement/src/placement/model.py` docstrings and
> `proto/scheduler.proto` comments cite. When a code comment says "task C2/C4/C6",
> it means the #21 programme, never this index.

Specs of record (all in `docs/superpowers/specs/`):

| Spec | File |
|---|---|
| division_rules retirement | `2026-08-12-division-rules-retirement-design.md` |
| round ordering (lexicographic) | `2026-08-12-round-order-hard-lexicographic-design.md` |
| T1 `day_start` rung | `2026-08-12-t1-day-start-rung-design.md` |
| z3 retirement (stages A–E) | `2026-08-12-z3-retirement-design.md` |
| conflict details (names, not UUIDs) | `2026-08-12-conflict-detail-names-design.md` |

## Order

Main chain sequential (shared files: `proto/scheduler.proto`, `build.ts`,
`model.py`, `schedule.ts`). C3 is a near-disjoint lane but overlaps
`schedule.ts` with C1 — run it strictly before or after C1, never alongside.
C6 (prose) is safe whenever.

| Session | Prompt file | Spec | Depends on | Status |
|---|---|---|---|---|
| C0 | `C0-division-rules-retirement.md` | division_rules | — | **MERGED** #537 → `f0f83939` |
| C1 | `C1-round-ordering.md` | round ordering | C0 (same proto/build.ts region) | **MERGED** #546 → `78db2f1f` |
| C2 | `C2-day-start-rung.md` | day_start | C1 (model.py overlap; rebase either way) | **MERGED** #555 → `40331cc2`, follow-up #557 → `4dc38a0e`. Shipped #512's two rungs too. **Leaves 3 open defects — see the C2 entries below before starting C3.** |
| C3 | `C3-conflict-detail-names.md` | conflict details | not concurrent with C1 (schedule.ts) | **DONE, PR open** — see the C3 entry below. Family was 25 kinds, not 4; `conflictKey` and the AI repair round were both in the blast radius |
| C4 | `C4-z3-reflow-cpsat.md` | z3 stage A | C1 (reflow inherits round rule) | TODO |
| C5 | `C5-z3-ai-repair-cpsat.md` | z3 stage B | C4 | TODO |
| C6 | `C6-z3-prose-identifiers.md` | z3 stage C | ~~anytime~~ → **after C4+C5** | **NO-OP today** (see below) |
| C7 | `C7-z3-public-contract.md` | z3 stage D | C4+C5 **deployed** (nothing writes z3) | TODO |
| C8 | `C8-z3-delete-solver.md` | z3 stage E | C7 | TODO |

### C1 — round ordering (2026-08-12/13, DONE)

Branch `feat/c1-round-ordering`, 30 commits, rebased onto `03c3c2d0`.

**Prompt/spec drift found by scout re-pin (7 of 11 citations exact, 4 wrong):**
the prompt's "C0 already reserved field 10" reads as if on `Fixture`, but the
`reserved 10` is on `SolveBuildRequest`; `build.ts`'s emission is 1627-1633,
not 1649-1653; `model.py`'s `on_day` is 863-871 and its day derivation
824-837, not 875/842-870; `roundrobin.ts`'s `roundNo` is computed at :103,
not :41. The spec never named the TS verifier — it is `validateAssignments`
(`calendar.ts`), with `Assignment` at :79-88.

**Ruling — the spec's "same-division pair" was UNDERSTATED.** The comparable
unit is one round SEQUENCE, keyed `(division, stage, pool)`. A `group` stage
calls `generateRoundRobin` once per POOL, and entitlements permit several
league/group STAGES per division; each restarts at round 1. Both cases were
hit by real boards, not hypothesised. Spec amended in this PR.

**Six enforcement seams, five of them found only because someone swept.** The
prompt named one. Round order is now enforced at: `autoSchedule` preview,
`applySchedule` write gate, `validateScheduleIn` (publish / `startDivision` /
live conflict report), `moveFixture` + `applySchedule`'s partial path (the
delta gate compared ONE fixture against `existing`, so a one-element set could
never contain a pair — structural, not a missing parameter), the AI planning
path (`SchedulePack`/`CompetitionPack` now carry stage identity), and joint
multi-division apply.

**Ruling — joint apply gets `tz` WITHOUT the `rules` bundle.** `verifyConfigFor`
withholds typed-rule inputs from the apply path deliberately (#399: apply-time
blocking is W4). `tz` is merely bundled with them. It now takes an independent
`tz?: string` 4th param, mirroring `window`. `AI_VERIFY_POLICY.hard = false`
structurally keeps `effectiveHard` at `[]` for any caller omitting `rules`, so
#399 cannot leak through the new seam.

**Accepted, unchanged:** z3 REFLOW/AI-repair can still emit round-violating
boards — the verifier catches them and REFLOW degrades gracefully instead of
500ing (`RepairVerificationError` is caught). Closing it is C4/C5's job.
Owner ruled 2026-08-13 that C1 ships without waiting (greenfield, no prod
users). z3 benchmarks ruled out of scope entirely.

**Lesson for C2–C8:** two of the six seams were missed by trusting an
inherited call-site list (a doc comment, then a report). Sweep with
`git grep -n "toAssignment("` — never inherit an enumeration.

### C6 — z3 prose (2026-08-13): NO-OP today, ordering was wrong

Classified every z3 reference (~1554 hits, ~140 files): ~70 are C7's
persisted/public values, ~835 are C8's solver/tests/WASM/env, ~649 are
history. **Zero are C6's.** Stage C renames prose that says z3 "where the code
no longer means z3", but REFLOW and AI repair still genuinely call z3, so every
surviving identifier is accurate; `build.ts:300-306` already carries an earlier
session's comment pre-empting this rename. C6 must run AFTER C4+C5.
`content/help/**` has zero z3 hits and never owed an edit. Finding recorded on
branch `feat/c6-z3-prose` (`b5ade286`), parked.

## Decisions already made (do not re-open)

- Round order: **lexicographic** (day ≤, then same-day start ≤); pin–pin
  exempt; pin–movable enforced (honest INFEASIBLE accepted vs C4 clamp
  precedent); **round-robin fixtures only** carry rounds — brackets rely on
  dependency edges.
- `day_start` = Σ(day_lo − day_open) over used days, chain position after
  `day_span`; TIER_COUNT → 6.
- z3: all four jobs approved; stored rows **rewrite** `z3|z3+lns → optimized`
  (UI copy already identical); repair enum end state `none|optimized|llm`.
- Conflict details: **structured** (`{kind, ids…}`), localized client-side in
  all 4 dicts; legacy `detail` string derived at API layer, deprecated.
- division_rules: one PR, full kill; both deploy orders proven safe; prod
  placement already on the rule_groups contract (owner-confirmed 2026-08-12).

## Status log

(append here as sessions run)

### C0 — division_rules retirement (started 2026-08-12)

Branch `feat/c0-division-rules-retirement`, worktree
`.claude/worktrees/c0-division-rules`. Re-pinned every `file:line` in the C0
prompt against `989e0ba8` before dispatch; two of them had drifted and one
premise was wrong:

- **False premise (prompt + spec):** "`build.ts` — remove emission". `build.ts`
  never names field 10. The emission is
  `placement-client.ts:254 toDivisionRules()`, fed from
  `SolveBuildInput.constraints.restByDivision` / `dayCapByDivision`. `build.ts`
  only *populates those two constraint fields* (1707-1714) and carries stale
  doc prose.
- **Drift:** `build.ts` doc-comment block is **1134-1150** (prompt said
  1131-1144) and the emission-site comment is **1703-1705** (prompt said 1700).
  A third stale note lives at **1625**. Proto `DivisionRule` is **165-176**
  with its lead comment from **159** (prompt said 159-174), and stale
  `division_rules` prose also sits at **127-129** and **162**, which neither
  the prompt nor the spec listed.

**Ruling (orchestrator, in scope):** `restByDivision` / `dayCapByDivision` on
`SolveBuildInput["constraints"]` exist *only* to feed field 10, so they die
with it — along with their division-index registration
(`placement-client.ts:547-553`) and the `dayCapByDivision > 0` validation
(`637-641`). The prompt's "do not touch `BuildConstraints`" reads as the
**proto** message (`match_minutes` / `gap_minutes`), not this TS shape; the
prompt separately authorises "the wire type/encoding in `placement-client.ts`
if it names the field", and it does. `restByDivisionForWire` and
`dayCapsByDivision()` stay as *internal* values — `restByDivisionForWire` still
feeds `buildRuleGroups`.

Open question carried into review: dropping the index registration can shrink
`division_count` on a board where a division is named by a rest/cap rule but by
no fixture. `division_count` is a declared bound only, so that is a wire change
without a behavior change — but it must be stated, not hidden.

**Implementation complete (2026-08-12).** Resolution of the open question above:
`division_count` CAN shrink for a board where a division was named only by a
rest/cap rule and by no fixture — that source is gone (division_rules is the
only field that ever fed it). No real caller hits this: `build.ts` always
derives `SolveBuildInput.constraints` from the same fixtures it also sends, so
every division a rest/cap rule ever named was already named by a fixture too.
Wire change, not a behavior change, as anticipated.

Additional blast radius beyond the file set the prompt named, all necessary
fallout from the change it authorized (detailed in the implementer's own
report): `services/placement/tests/test_proto_compiles.py` (drift gate — the
generated stubs would not even compile without updating the field contract;
added the required reserved-field test here too), `_board_positional.py`
(`to_proto_request` constructed `scheduler_pb2.DivisionRule`, which no longer
exists — converted its rest/cap translation to `rule_groups`, added a new
`rule_groups_for` helper), `test_schema.py`/`test_server.py` (same — DivisionRule
no longer exists; deleted 10 division_rules-exclusive test IDs, confirmed
equivalent rule_groups-path coverage already existed for each), and
`test_model.py` (deleted 6 more test IDs whose premise was the retired dict
keys; converted 4 tests in the "SEVENTH fold" section from a division-baseline
framing to a pure rule_groups one; **found and fixed two real regressions** —
`test_the_day_cap_groups_by_the_callers_day_index_not_by_utc` and
`test_two_day_indices_over_one_utc_day_give_two_buckets` were still sourcing
their day cap from the now-dead `constraints.day_cap_by_division`, and
`test_production_board_meets_the_stated_acceptance_criterion` silently became
an uncapped, harder-to-optimize board once `_production_board()` stopped
carrying rule_groups — fixed by making `_production_board()` derive and
propagate `rule_groups` via a new `rule_groups_for` helper in
`_board_positional.py`, threaded through every solve-invoking caller). Also
added, per an owner requirement folded in mid-task: structured logging
(`schema.py`'s `_log_legacy_wire_fields`) for a deploy-window request still
carrying field 10, plus its own test pair.

Verified: engine vitest 3516/3538 passed, 0 failed, 22 pre-existing pending
(z3/WASM-gated, unrelated); `test:coverage` green, `src/core/**` at 100%
lines; engine lint and tsc both clean.

**False premise, caught by review, not by the implementer:** the first pass
reported placement pytest as 213/220 with 7 failures in `test_objective.py`
dismissed as "pre-existing load-sensitivity flakes." Wrong — the coordinator
re-ran it twice (once on a quiet box, byte-identical results, ~43s each) and
showed the numbers were a real, deterministic defect: `T1_PROVED_MAKESPAN_MS`
expected `1_557_600_000` (~18 days, the 1/day cap binding), got `26_400_000`
(~7.3 hours) — a 59x compression no slow machine produces, a missing day cap
does exactly. `test_objective.py`'s `_production_board()`/`_model_for()`/
`_model_without_pins()` were the SAME class of bug already found and fixed in
`test_model.py` (see above) but never applied to this sibling file — `grep -c
rule_groups tests/test_objective.py` was 0. The `load1=…` hint those tests
print fires whenever `tiers_completed < 4` for ANY reason, which is what made
a structural defect read as environmental noise. Fixed the same way:
`rule_groups=rule_groups_for(<raw board>)` threaded through all three
helpers and both local `imbalance_probe_board()` construction sites (7-tuple
vs the now-8-tuple `_production_board()` shape had to match). Placement
pytest is 220/220 now, 0 failed (`test_objective.py` alone: 21/21) — and
notably ~3x faster (18.9s vs ~55s), consistent with a correctly-capped board
being an EASIER packing problem, exactly as the coordinator's diagnosis said.
None of the three proved-optimum constants (`T1_PROVED_MAKESPAN_MS` etc.)
needed to move — confirmed by diff, only context lines touch their names.

Golden
corpus: 474/474 `testkit/golden*.test.ts` passed, and `git status --porcelain`
on all 11 `*.golden.json` fixtures is empty — byte-identical (scheduling code
is outside the corpus's scope entirely). `openapi:gen` produced zero diff.

### C2 — T1 `day_start` rung (2026-08-13)

Branch `feat/c2-day-start-rung`, worktree `.claude/worktrees/c2-day-start`,
off `3d64222a`. **PR #555 MERGED** as `40331cc2`; follow-up **#557 MERGED** as
`4dc38a0e` (the safe half only — the gate defect below is still open).

**False premise, and it changed the scope: #512 WAS NEVER IMPLEMENTED.** The
C2 prompt reads as if the two day rungs already exist ("reusing #512's
`day_lo`", "TIER_COUNT → 6"). They do not. `f687c7d5 docs: design for the
day-aware T1 objective (#512) (#531)` is a **docs** commit — the design doc
merged, the code never landed. Ground truth on `main` before this session:
`objective.py:166` had `TIER_ORDER = (placed, makespan, idle_gap, imbalance)`,
`build.ts:194` had `TIER_COUNT = 4`, and `model.py` had no `day_used`/`day_lo`/
`day_hi`/`span` at all. `day_start` is therefore not buildable alone: its input
`day_lo` is `day_span`'s variable and its chain slot is directly below it. The
day_start design anticipated exactly this — "#512's 4→5 becomes 4→6 **if this
lands with it**".

**Owner ruling (asked before exceeding the file set, per §1):** one PR, both
specs, `TIER_COUNT` 4 → 6, `makespan` retired. And on the wall: ship, report
the numbers, the production wall is a separate decision.

**Prompt/spec drift found by re-pin (before writing any code):** `model.py`'s
day derivation is 833-871 and `on_day` 876-889 (prompt said ~842-870); the
proto `Tier` name list is `scheduler.proto:199` inside 197-208 (prompt said
192-198). The prompt's "the TS caller's tier list" does not exist — **TS never
keys on tier names at all**, only on the tier COUNT (`build.ts:194`,
`schedule.ts`'s `TIERS_TOTAL`, and a mirrored comment in
`generated/scheduler.ts`). So the "same string both sides" requirement is
satisfied by the proto comment plus the count, and there is no TS name table to
edit.

**Ruling — the redundant per-day floor is the whole reason T1 proves.**
`model.Add(span >= dur_ms).OnlyEnforceIf(day_used[d])` is redundant about any
real board (`day_hi >= s + dur` and `day_lo <= s` already imply it) and is
load-bearing for the DUAL bound: `day_used[d]` is implied BY `on_day`
one-directionally and never implies an occupant back, so the relaxation may
hold a day "used" with a span of nothing and `sum(span)`'s lower bound starts
at 0. Measured on the production board: **without it `day_span` was still
FEASIBLE at 180 s and never proved; with it, OPTIMAL in 1.0 s at the same
value (69 600 000)** — the incumbent had been optimal all along and could not
be proved. Same lever as T3's max/min equality: fix the dual bound, not the
search. Narrowing each day's variable domains to that day's own window was
tried first and did nothing measurable on its own (kept anyway — exact, and
cheap).

**Ruling — #512 §6b resolved as option (1), accept and document.** An
off-lattice pin belongs to no day, so under a per-day objective it is invisible
to T1 entirely. Consistent with C4, which already exempts it from day caps.
Pinned by `test_day_objective.py::test_an_off_lattice_pin_belongs_to_no_day_at_all`
so a future reader finds a decision rather than an accident.

**Wall: a real regression, reported not hidden.** Production board, N=6 per
side, same box, same board, 30 s wall:

| | before (4 rungs) | after (6 rungs) |
|---|---|---|
| total, min/median/max | 1131 / 1730 / 2073 ms | 7739 / 17657 / 19485 ms |
| `days` | — | 215 / 367 / 469 ms |
| `day_span` | — | 631 / 1237 / 1813 ms |
| `day_start` | — | 208 / 396 / 458 ms |
| `idle_gap` | 741 / **1348** / 1672 ms | 6337 / **14931** / 17665 ms |
| tiers proved | 4/4, 6 runs | 6/6, 6 runs |

**The new rungs are not the cost — they are ~2 s of it.** `idle_gap` is, and
the control run says why: `placed` + `idle_gap` alone, **no day rungs in the
chain at all**, costs 12 439 ms. The retired whole-board `makespan` freeze had
been doing `idle_gap`'s pruning as a side effect, so what the wall pays for is
removing that term, not adding these. Arm B (day rungs but no `day_start`) is
the SLOWEST of all at 30 704 ms, so `day_start` is not the culprit either.

Consequence at the 8 s production wall: the chain returns FEASIBLE with **four
of six** rungs proved — `placed` + all three day rungs, ~2.3 s median, never
above 3.5 s measured — and cuts `idle_gap` short. The day-aware objective
itself fits the wall comfortably; `tiersCompleted === TIER_COUNT` (TS's
`already_optimal` gate) will now rarely fire at 8 s on a board this size.
Follow-up candidate, NOT done here: give `idle_gap` a dual bound the way
`day_span` just got one.

**Re-baselines, all stated:** `T1_PROVED_MAKESPAN_MS` / `_PIN_FREE_MS` retired
with their term; `T2_PROVED_IDLE_GAP_MS` 132 600 000 → 170 400 000 (a
day-anchored board spreads one entrant's matches further apart — the
`day_start`-over-`idle_gap` trade, asserted directly);
`T3_PROVED_IMBALANCE_MS` unchanged. New: `days` 19, `day_span` 69 600 000,
`day_start` 0. `test_bench_contract.py` untouched and green — the BOARD did
not move. `PROBE_OPTIMAL_MAKESPAN_MS` renamed `PROBE_OPTIMAL_DAY_SPAN_MS`,
value unchanged (that board is one day, so the two quantities coincide).

**Unplanned fixes (in scope, recorded per §1):**
- `schedule.ts`'s `TIERS_TOTAL` was still a hand-written `4` whose own comment
  claimed it "MIRRORS `TIER_COUNT` ... which is module-private there" —
  already false when written (`build.ts` exports it precisely so this layer
  needs no copy, ruling R17). It now imports the constant. This is the exact
  drift the export existed to prevent, and it had already happened.
- Nine engine test stubs hardcoded `tiersCompleted: 4` meaning "a fully proved
  ladder", plus ten assertions on the literal `4`. All now `TIER_COUNT`. The
  one exception is `build-teardown.test.ts`, which `vi.doMock`s that very
  module graph — a static import there would load the module before the mock
  registers and silently make it inert — so it keeps a literal with the reason
  written next to it.

**Lesson for C3-C8, and it is the same one C1 recorded.** C1's was "never
inherit an enumeration". C2's is **never inherit a status**: this prompt, the
index row, and the spec header all read as though #512 had shipped, because a
DESIGN doc had merged under a PR number. `git log --oneline --grep` on the
issue number, and one `git grep` for a symbol the work would have created, is
the whole check.

**Bench script untouched, deliberately.** `bench/placement_bench.py` carries a
divergent copy of the model (its own `build_model`, its own tier vocabulary —
`idlegap`, not `idle_gap`) and #512 §9 puts de-duplicating it out of scope. The
C2 prompt's "`bench/` copy of the model **if** the #512 work duplicated the
chain there" is conditional and the condition is false: this change duplicated
nothing into it. The bench numbers above were measured against the SERVICE's
model and chain, which is what ships.

#### C2 follow-up — the acceptance gate ranks on the OLD ladder (OPEN)

`40331cc2` shipped a real defect. PR #557 ships only the part that can be
verified as behaviour-neutral; **the gate itself is still wrong on main** and
needs its own task. Read this before attempting it — four variants were tried
and measured, and all four failed.

**The defect.** `isStrictlyBetter` (`build-objectives.ts`) ranks
`placed → makespanMinutes → idleGap → imbalance` while the solver optimises
`placed → days → day_span → day_start → idle_gap → imbalance`. That comparator
is not advisory: `solveBuild` compares the placement reply against the
legalised greedy seed and returns the SEED when the candidate does not win. So
a PROVED-optimal board can be discarded, and — before #557 — the discarded-board
reply was reported `already_optimal`.

**#557 MERGED as `4dc38a0e`** — behaviour-neutral, verified: `TIER_NAMES` as the shared
vocabulary with `objective.py` and the proto comment, `TIER_COUNT` derived from
it, `already_optimal` gated on the NAMES rather than a bare count, the three day
metrics on `BoardMetrics` as REPORTED fields, and three test-quality fixes. The
DB-backed CI command (`src/server src/lib`, real Postgres, real placement
service) returns **4518 passed / 0 failed on both `origin/main` and the branch**
— identical, which is the evidence that nothing about which board ships moved.

**WHY MIRRORING THE LADDER INTO THE GATE DOES NOT WORK, and this is the part
worth reading.** The two boards being compared are not both products of that
ladder. The seed is GREEDY's, and greedy is **rule-blind**: it packs from the
first admissible tick, which scores beautifully on `days`, `day_span` and
`day_start` precisely BECAUSE it ignores the typed rules that push a lawful
board later. Ranking the day terms therefore makes the gate prefer the board
that breaks the rule. Measured on a division carrying a durable
`not_before noon` rule: six cards proposed before noon on a board whose rule
says none may be.

**The four variants, all measured on the full DB-backed run:**

| variant | result |
|---|---|
| mirror the ladder in `isStrictlyBetter` | 5 failed — `not_before` breach + 3 × `assertNoNewBlocking` in locks + `solver.moved` |
| + conflicts dominate (blocking, then total) | 5 failed, a DIFFERENT five — fixed 2, broke 3 more in `build-honours-locks` |
| + `moved` zero without a caller board (R21 shape) | broke two POLISH specs that measure `moved` from the caller's board |
| narrow: legality → placed → the solver's own PROOF | **7** failed, on a brand-new database |

Each fix traded one failure class for another. **That is the signal: this is a
design problem, not a tuning problem.** The acceptance gate, the delta conflict
gate, `moved`'s baseline and locks are more coupled than any single ranking rule
captures.

**What the next attempt should start from, not re-derive:**

- The gate is a DELTA against the greedy seed, not an absolute legality test
  (standing repo finding). `rejectedBlockingConflicts` closes only the direction
  where the CANDIDATE is worse; nothing refuses a SEED that is worse. Any fix
  has to close the other direction, and blocking-conflict count alone does not
  do it because typed-rule breaches (`warn.instruction`) are not blocking.
- `moved`'s seed fallback is justified as "a self-comparison, so zero" — true
  ONLY while every no-`current` exit returns the seed. Any change that lets
  BUILD return the solver's board breaks that justification, and the R21-shaped
  fix (zero without a caller board) breaks POLISH, which legitimately measures
  against a caller board that is sometimes absent from `greedySeed`'s binding.
- The four `schedule-build-honours-locks` failures survived every variant and
  were never diagnosed individually. Start there, not with the comparator.
- Baseline discipline: run
  `npm test --workspace apps/web -- src/server src/lib` with
  `PLACEMENT_SERVICE_HOST` set and a **brand-new** database, on `origin/main`
  first. Main is 4518/0. Anything else is your change.

**Found by two independent reviewers**, separately, within minutes — neither CI
nor the implementer. All 12 checks were green on #555 and could only ever have
been green: **no test drove a board where the two ladders disagree.** Green is
evidence about the paths that are driven, nothing more. The same shape turned up
three more times the same day in other lanes (a joint report still rendering
uuids because smoke typed the payload and never read `offenders`; a template
gallery with no width coverage because every width project is
`testMatch:/mobile\.spec\.ts/`; a bye seed stranded forever because every test
used power-of-two counts).

**Deploy order for the 4 → 6 change remains web first, then the placement
service.** The name guard cannot help a caller already deployed with the old
list; new web against an old service simply never reaches `TIER_COUNT`, which is
degraded but honest.

#### OPEN, separately: main can throw `assertNoNewBlocking` on apply (intermittent)

Distinct from the gate defect above, and it reproduces WITHOUT any gate change.

`schedule-solver-telemetry.test.ts` → "reflow leaves an already-legal board
untouched, including a card parked late" fails on `origin/main` with a real
placement service and a brand-new database. **Measured 1 red in 3 runs**; a
second session hit the identical failure on a PR touching only
`.github/workflows/e2e.yml`, i.e. with zero source changes.

```
EngineError: schedule change hits a blocking conflict
  assertNoNewBlocking  schedule.ts:930
  applySchedule        schedule.ts:2003   <- the manual park, not the build
```

So main today can propose a board that throws when applied — not merely the
`already_optimal` misreport. Nondeterministic, so a single green run does not
clear it and one red does not prove a regression: **always run it several
times before attributing it to a diff.** That property is what let it sit
unnoticed, and it is why the C2 gate work spent a cycle chasing it as its own.

Likely related to C2 shipping the day-aware ladder into the solver while the TS
side still reasons about boards the old way, but that is a hypothesis — the
failing call is the manual park, so start by asking which conflict
`deltaConflicts` actually returns there rather than assuming round order.

#### CLOSED (2026-08-13): a fixed park instant, in TWO suites — not the product

**Scope correction.** This section was first closed against the LOCKS suite
alone (`schedule-build-honours-locks.test.ts`). That was an overclaim: the suite
named in the report above is `schedule-solver-telemetry.test.ts`, a different
file, and it went red on CI for PR #563 while the locks fix was green. Same
defect CLASS, two separate sites. Both are fixed below; the locks one is
described first because it is where the mechanism was traced.

The question above — "which conflict does `deltaConflicts` actually return at
the manual park" — has an answer, and it is not round order. Instrumenting
`assertNoNewBlocking` to dump `refused`/`before`/`after` plus the proposed and
untouched boards, on a run made to fail deterministically:

```
site: applySchedule   source: manual
refused: court          | C2 double-booked with 3bb183c1
         person_overlap | entrant 2af01252 overlap with 5a2afb35
         person_overlap | entrant 2ef216b8 overlap with 3bb183c1
before:  (none)
proposed:  96e0a3b5  C2  01:00
untouched: 3bb183c1  C2  01:00     <- already there
```

One fixture proposed, onto an occupied slot. The park is a genuine court
double-booking and the gate refused it correctly.

**Why the slot was occupied.** `config.startAt` is NOT the solver's floor. The
apply gate's window comes from `applyWindow`, which floors at START-OF-DAY of
`config.startAt` in the org zone — `2026-08-01T00:00Z`, not the configured
09:00 — and `boundSolverWindow` returns a two-finite-bound window untouched. So
the solver's grid opens at midnight while GREEDY's cursor opens at 09:00
(`calendar.ts:759`, `ready = max(config.startAt, window.notBefore)`). Under C2's
day-aware rungs the solver compacts to that midnight, on the seed day or the
next, run to run — both boards verify clean, so nothing downstream picks a side.
The suite's park slot was the fixed instant `at(-480)` = `01:00Z`, which is free
under greedy's 09:00 board and IS the board under the solver's midnight one.

Traced over 5 auto applies: **3 next-day (pass), 2 seed-day (fail)**. That is
the whole of the "1 in 3". The suite only ever looked stable because
`isStrictlyBetter` kept discarding the solver's midnight board for greedy's.

**A TEST premise broke, not the product.** Every board involved verifies clean.
Fixed by reading the park slot off the board that is actually there, and parking
FORWARD (`parkSlot` + `lastRoundFixtureId`) — backward cannot be made robust,
because on the seed day the earliest card sits exactly ON the window floor, so
no legal slot exists before it and the park fails with `window` instead of
`court`. Result: **10 of 10 green** with the acceptance gate REMOVED, against
2-3 failures in 10 before.

#### The gate: both directions now measured, both fail

With the premise fixed, the fix-vs-remove question was re-opened — including
the option this index had recorded as rejected, since **that rejection's
evidence was contaminated by the premise above**.

Baseline (premise fix only, gate untouched): **61/61** across the six
scheduling suites. Gate reworked to trust `provedOurLadder` instead of ranking:
**58/61**, two reproducing deterministically over two runs.

1. **The proof is not authority over the durable rules.** On a division whose
   durable rule forbids anything before noon, the reworked gate shipped six
   cards at `2026-08-02T00:00:00.000Z`. `provedOurLadder` proves the OBJECTIVE
   LADDER and says nothing about typed rules; instruction conflicts are not in
   `isBlockingConflict` (`court`/`person_overlap`/`window`/`order`+`direct`), so
   step 7's verifier gate will not refuse them either. The greedy seed IS
   legalised, so it respects the rule. Net: `isStrictlyBetter` is currently the
   only thing keeping a rule-breaking proved board off the organiser's screen —
   incidentally, not by design.
2. **Metric equality is not board equality.** A `ladderTied` predicate over the
   six rungs shipped greedy's board where the baseline shipped the solver's
   (`does not anchor a BUILD to the board it was asked to replace`, 6 unchanged
   where 0 is required). Fixable by comparing assignments, but moot given 1.

**Why the solver breaks the rule: it is never told.** `not_before` does not
appear in `build-encode-rules.ts`, and `placement-client.ts` records twice that
`division_rules` — proto field 10 — was RETIRED from the wire. The placement
service receives no typed division rules and structurally cannot honour them.

**So the gate is not fixable at the gate**, and the prerequisite is to make a
durable-rule violation REFUSABLE. `build.ts` step 7 already has the path —
`rejectedBlockingConflicts` -> "verifier rejected the placement solver's board —
falling back to the greedy seed". Add durable-rule conflicts to the set THERE,
at the build gate only, not by widening `isBlockingConflict` globally (which
would also change the apply gate's delta check and every surface sharing the
predicate). With that guard in place the proved board never reaches the
comparator, and trusting the proof becomes safe.

#### The second site: `schedule-solver-telemetry.test.ts`

"reflow leaves an already-legal board untouched, including a card parked late"
parked at `at(600)` — a fixed instant ten hours after `T0` — under a comment
asserting "still legal, nothing else is near it". Same false premise, different
failure mode: the parked card is the LAST round, so when the solver compacts to
the NEXT day the whole board sits AFTER the park, and a last-round card placed
before every round that must precede it is a direct `order` breach, which is
blocking.

**Local runs cannot discriminate here, in either direction.** Measured against
the boards produced locally: every August board starts at `08-01 00:00` and ends
between 01:00 and 10:00 — always BEFORE `at(600)` — so the park is safely after
the board and the test passes. 6 of 6 green with the fix; a subagent measured
0 red in 6 WITHOUT it on the same branch. CI is the only arbiter that exercises
the other day choice. The fix is therefore justified by removing the dependency
on which day the solver picks, NOT by a green local run — do not treat a local
pass here as evidence either way.

That same measurement independently re-confirms `config.startAt` is not the
solver's floor: every board starts at midnight, never the configured 09:00.

The pinned-anchor spec lower in that file also uses `at(600)`, and is
deliberately NOT changed: it parks onto an EMPTY board, so there is no board to
read a slot from, and it is not failing.
#### C2 follow-up — `idle_gap`'s dual bound (2026-08-13): PARTLY CLOSED

The wall follow-up C2 deferred ("give `idle_gap` a dual bound the way
`day_span` just got one"). **The premise was wrong and the measurement says
so** — but the rung got materially cheaper anyway, by a different lever.

**`day_span`'s lever does NOT transfer, and the reason is the board.** A
redundant floor of that kind needs a counting relation between the metric and
how many fixtures must fit it. On `production_board()` every entrant plays
exactly TWO fixtures, so the chain argument degenerates to a single rest
period: 4 800 000 ms against a 170 400 000 optimum — 2.8% of the gap. Do not
re-derive this; it was computed off the board, not guessed.

**Root cause, from CP-SAT's own search log rather than inference.** The
optimum is FOUND at 4.2 s and everything after is PROOF, at `conflicts: 0`,
`branches: 265`, `lp_iterations: 0` — there is no tree search to speed up.
Reduced-cost fixing ratchets the lower bound up one unit per LP round from
1 200 000 toward 170 400 000.

**What shipped instead: T2 counts in tick-lattice units.** Two real defects,
both in `model.py`'s T2 block:
- the gap vars were `NewIntVar(0, max_end, ...)` where `max_end` is an
  absolute EPOCH (1.77e12). They hold DURATIONS, reachable max 2.2e9 — 805x
  oversized. `day_hi` shares that bound correctly; a gap does not.
- they counted in 1-ms units when every reachable gap is a multiple of
  600 000 ms (gcd of grid-tick offsets folded with `dur_ms`, derived from the
  data by `_gap_lattice_ms`, never assumed — an unaligned grid collapses the
  gcd to 1, which is byte-for-byte the old encoding).

Same instrument T3 already uses ("counted in matches and scaled to ms once").

**Measured, 6 runs per arm, back to back on one box:**

| | before | after |
|---|---|---|
| 8 s PRODUCTION wall | 4/6 rungs on **all 6** runs | **6/6 rungs on 3 of 6** |
| `idle_gap` wall (load 3-6) | 10 692-16 159 ms | 4 282-6 381 ms |
| whole chain | 12 135 ms | 5 997-8 083 ms |
| `deterministic_time` | 13.1 | 11.1 |
| objective values | `170 400 000` | `170 400 000`, identical |

So the wall now sometimes proves the whole ladder and previously never did.
It is NOT a guarantee at 8 s and nothing asserts one.

**Measure det_time, not wall-clock.** This box ran `load1` between 3 and 213
inside a single 6-run bench, and at load ~50 the BASELINE proved only 2/6 at
the 8 s wall. Every wall number above is paired with its load.

**Dead ends, measured so nobody repeats them.** `optimize_with_core` is 6x
WORSE (det 65.3 vs 10.9) and ships unproved, worse boards (`idle_gap`
256 800 000); `core + use_lb_relax_lns` worse still (83.7); `use_lb_relax_lns`
alone is neutral (10.7). Solver knobs are not the lever.

**What is left, and it is not cheap.** The true bound is graph-shaped: cap
1/day forces a group's 19 fixtures onto 19 distinct days, every entrant plays
2, so the binding argument is that a 2-regular graph is a union of cycles and
laying a cycle's edges on distinct days forces some vertex's two edges >= 2
days apart (170 400 000 ms = 2 days minus 40 min). The LP cannot see that, and
a floor derived only from "different days" reaches one inter-day separation
and stops short.

**Fallout worth knowing about, because it caught a latent defect.** Two
cut-short tests in `test_objective.py` raced a FIXED 8 s wall against
`idle_gap`'s proof time. With the rung 5x faster that wall stopped cutting
anything, and only ONE of the two went red for it — green by lottery. They now
time the four rungs above `idle_gap` and derive the wall as `2 x elapsed +
slice`; doubling widens the four-rung side without narrowing the other,
because `idle_gap`'s cost scales with the same load (it needs ~4x their time).
Verified 6/6 green at loads 9.8-22.4, the exact band that had been failing.

### C3 — structured conflict details (2026-08-13/14, DONE)

Branch `feat/c3-conflict-detail-names`, worktree `.claude/worktrees/c3-conflict-details`,
off `d0cd9a25`. Three implementation phases (engine / server+wire / client),
sequential because the file sets overlap.

**Every `file:line` in the prompt had drifted — 0 of 11 exact.** C0 found two
wrong, C1 four of eleven, C2 three. C3 found all of them. Treat the citation
block in any remaining prompt as a hint, never as an address.

**False premise, and it doubled the task: the family is 25 kinds, not 4.**
The design names four (`below_rest` entrant+person, `entrant_overlap`,
`person_overlap`, `person_double_booking`) and they cover five of the 23
templates `calendar.ts` builds; `build.ts` carries two more. NINE templates
leak a raw id, not four — the ones the design never named are
`no_slot_person_bound`, `court_double_booking`, `order_before_feeder`,
`order_inside_feeder_rest`. Owner ruled: convert all 25, because the badge
`title` joins every detail with `"; "`, so a partial conversion renders a
localized fragment beside an English one inside a single string. The design's
own field shape was also insufficient — several templates interpolate scalars
(court label, day key, weekday, minute counts, round numbers) that
`{entrantIds, personIds, fixtureIds, otherFixtureId}` cannot carry. Full
25-row table in the design doc's "AMENDED 2026-08-13" section.

**The prose was in `conflictKey` DELIBERATELY, and that is the apply gate.**
Three separate comments (`calendar.ts:829`, `:1364-1376`, `:1479-1495`) record
that the counterparty id inside the string is what distinguishes a swapped
court, an added collision, and a rest breach hiding behind an ordering
violation. It feeds `deltaConflicts`, `repair-minimality.ts` and the joint
apply gate (`competition-schedule-apply.ts`). So a task framed as "render names
in a tooltip" reaches directly into which edits an organiser's apply REFUSES.
Owner ruled: key on a canonical serialization, and PROVE the partition rather
than assume it.

**The prose also reached the MODEL.** `schedule-ai.ts:2189` and
`competition-schedule-ai.ts:2130` put the raw engine `Conflict[]` on the
repair-round conversation as `verifier_conflicts` — no mapper, no stripping.
Deleting `detail` would have silently changed what a paid model reads. Ruling:
the model's input stays byte-identical via the server-side legacy deriver, and
it carries `detail` but NOT `details` (token weight feeds AI-credit
accounting). Pinned by a field-set assertion on the captured request body.
Sending structured kinds instead is a real follow-up — with a repair-quality
measurement attached, which nothing in C3 had.

**A vacuous falsifier, caught in review of our own work.** The first
partition-parity test guarded non-vacuity with
`groups.length < conflicts.length + 1` — which no partition can ever violate.
Its own comment noticed the impossibility and shipped it anyway. Parity between
two keyings proves nothing unless the corpus exercises what `details`
discriminates: had every conflict owned a unique `(fixtureId, reason)`, both
parity assertions would still pass against a `conflictKey` that had dropped the
detail entirely. Replaced with the real falsifier — the degenerate
`fixtureId|reason` key must be strictly COARSER. Same class as the repo's
standing "union assertion closes nothing" finding: an assertion that cannot
fail reads as protection while providing none.

**Unplanned fix (customer-visible).** `use-board-actions.ts:303` regex-scraped
a UUID out of the prose to title a card, taking the FIRST id — which for
`entrant_overlap`/`person_overlap` is the entrant or person, not the
counterparty fixture. So `board.find` missed and the "clashes with <match>"
enrichment silently degraded to "another match". It now reads
`details.other_fixture_id`; regression test ships with it, verified by
hand-reverting the fix (3 of 4 tests went red).

**The 8-char fallback is WRONG for person ids.** `schedule-ai.ts:202` mints
synthetic collapsed-person keys shaped `name:${normalizedName}`, so the
design's "shorten to 8 chars" prints `name:ali`. The formatter branches on the
prefix — a synthetic id already carries its name.

**Two of the four "surfaces" never rendered the detail at all.**
`conflicts-panel.tsx:125` and `schedule-gate-dialog.tsx` resolve
`board.conflictHelp.<code>` first and fall back to the prose only when that key
is missing — and every live code has one. Five OTHER surfaces the design never
named do render it. Enumerating consumers from a design doc, rather than from
`git grep`, would have missed five and fixed two dead ones.

**Baselines, measured both arms, same box, same solver, fresh DB each:**

| | base `d0cd9a25` | branch |
|---|---|---|
| apps/web `src/server src/lib` | 4594 / 0 / 4643 / 49 pending | 4642 / 0 / 4691 / 49 |
| engine | 3921 / 3 / 3946 / 22 | 3977 / 0 / 3999 / 22 |
| `src/components` | — | 2037 / 0 / 2039 / 2 |

`UNAUTHENTICATED` count 0 in both arms' logs — the solver was genuinely
exercised, not silently falling back to greedy. The engine baseline's 3
failures were 1 stable (`repair-scale`, a wall-clock budget that fails under
full-suite parallelism on the UNCHANGED tree too) and 2 load-induced
(`z3-load` WASM init; `z3-solver` IS installed here).

**§2 is not decoration, and this session proved it the hard way.** A full run
against a database already used for two prior runs produced ONE failure —
`billing-pass-duplicate.test.ts`, `expected 503 to be 200`, a pass-checkout
route with no connection to conflict details. Isolated it was 3/3 green, and
7/7 on the base arm. Rebuilt from `initdb` per §2 and the same full run was
4642/0. A brand-new DB per RUN, not per session.

**Officials conflicts are a different producer and were left alone.**
`packages/engine/src/officials/assign.ts:157` embeds a fixture id in
`OfficialConflict.detail` exactly as the scheduling family did. Out of C3's
scope by the design's own framing; recorded so the next reader finds a decision
rather than a miss. It wants its own task.
